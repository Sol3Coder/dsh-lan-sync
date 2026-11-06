import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Applier } from './engine/applier.js'
import { bump, merge as mergeClock } from './engine/clock.js'
import { Collector } from './engine/collector.js'
import { deriveGroupKey, groupTag } from './engine/crypto.js'
import { Discovery } from './engine/discovery.js'
import { fetchBlob as fetchPeerBlob, fetchInfo, fetchManifest, joinPeer, notifyPeer } from './engine/peer-client.js'
import { PeerServer } from './engine/peer-server.js'
import { resolveAgentsHome, resolveDshHome, stateDir } from './engine/paths.js'
import { Store } from './engine/store.js'
import { SyncEngine } from './engine/sync-engine.js'

const KEY_CACHE = new Map()

/** @param {string} groupId */
export function groupKeyFor(groupId) {
  if (!KEY_CACHE.has(groupId)) KEY_CACHE.set(groupId, deriveGroupKey(groupId))
  return KEY_CACHE.get(groupId)
}

/** @param {{ hostname?: string, home: string, profile: string }} options */
export function nodeIdFor({ hostname = os.hostname(), home, profile }) {
  const digest = createHash('sha256').update(`${hostname}|${home}|${profile}`).digest('hex')
  return `n_${digest.slice(0, 12)}`
}

function baseUrlFor(address, port) {
  const host = String(address ?? '').replace(/^::ffff:/, '')
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

/** IPv4 addresses this machine is reachable on (loopback excluded). */
export function localAddresses() {
  /** @type {string[]} */
  const addresses = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * Candidate base URLs for a peer, best first: its advertised addresses, then
 * the address we observed, loopback last. WSL can only reach Windows through
 * the host address, so a single observed address is not enough.
 */
export function peerBaseUrls({ addresses = [], address, port }) {
  /** @type {string[]} */
  const urls = []
  const push = (ip) => {
    if (!ip || !port) return
    const url = baseUrlFor(ip, port)
    if (!urls.includes(url)) urls.push(url)
  }
  for (const ip of addresses ?? []) {
    const text = String(ip).replace(/^::ffff:/, '')
    if (!text || text.startsWith('127.') || text === '::1') continue
    push(text)
  }
  if (address && !String(address).startsWith('127.')) push(address)
  if (address) push(address)
  return urls
}

/** Read the default gateway on Linux without shelling out. */
async function linuxGateway() {
  if (process.platform !== 'linux') return null
  try {
    const lines = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1)
    for (const line of lines) {
      const columns = line.split(/\s+/)
      if (columns[1] !== '00000000') continue
      const hex = columns[2]
      const octets = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)].map((part) => Number.parseInt(part, 16))
      return octets.join('.')
    }
  } catch {
    return null
  }
  return null
}

/**
 * Wires store, collector, applier, engine, peer server and discovery together
 * for one DSH profile.
 */
export class LanSyncHost {
  /**
   * @param {{ home?: string, agentsHome?: string, profileDir: string, profile?: string,
   *           identity?: Partial<{ nodeId: string, name: string, platform: string, dshVersion: string }>,
   *           settings?: Record<string, unknown>,
   *           hooks?: { applyDependency?: Function, applyBundles?: Function },
   *           logger?: any }} options
   */
  constructor(options) {
    this.home = options.home ?? resolveDshHome()
    this.agentsHome = options.agentsHome ?? resolveAgentsHome()
    this.profileDir = options.profileDir
    this.profile = options.profile ?? 'web'
    this.settings = { autoApply: true, autoInstallPlugins: false, ...(options.settings ?? {}) }
    this.hooks = options.hooks ?? {}
    this.logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} }
    this.identity = {
      nodeId: options.identity?.nodeId ?? nodeIdFor({ home: this.home, profile: this.profile }),
      name: options.identity?.name ?? `${os.hostname()}-${process.platform}-${this.profile}`,
      platform: options.identity?.platform ?? process.platform,
      dshVersion: options.identity?.dshVersion ?? '0.0.0',
      profile: this.profile,
    }
    this.timers = []
    this.port = null
  }

  async start({ tcpPort = 56701, udpPort = 56700, host = '0.0.0.0', discovery = true } = {}) {
    this.bindHost = host
    this.requestedPort = tcpPort
    this.udpPort = udpPort
    this.useDiscovery = discovery

    this.store = await new Store({ dir: stateDir({ home: this.home, profile: this.profile }) }).init()
    this.collector = new Collector({
      home: this.home,
      agentsHome: this.agentsHome,
      profileDir: this.profileDir,
      store: this.store,
      platform: this.identity.platform,
    })
    this.applier = new Applier({
      profileDir: this.profileDir,
      home: this.home,
      agentsHome: this.agentsHome,
      store: this.store,
      platform: this.identity.platform,
      applyDependency: this.hooks.applyDependency,
      applyBundles: this.hooks.applyBundles,
      logger: this.logger,
    })
    this.transport = {
      fetchManifest: (peer) => fetchManifest({ baseUrl: peer.baseUrl, secret: peer.secret, nodeId: this.identity.nodeId }),
      fetchBlob: (peer, hash) => fetchPeerBlob({ baseUrl: peer.baseUrl, secret: peer.secret, nodeId: this.identity.nodeId, hash }),
      notify: (peer, items) => notifyPeer({ baseUrl: peer.baseUrl, secret: peer.secret, nodeId: this.identity.nodeId, items }),
    }
    this.engine = new SyncEngine({
      store: this.store,
      collector: this.collector,
      applier: this.applier,
      transport: this.transport,
      identity: this.identity,
      logger: this.logger,
    })
    await this.engine.init()

    if (this.store.getGroup()) await this.enableGroup()

    this.every(4_000, () => this.tickScan())
    this.every(12_000, () => this.tickSync())
    return this
  }

  every(ms, fn) {
    const timer = setInterval(() => {
      Promise.resolve(fn()).catch((error) => this.logger.warn?.('timer', String(error?.message ?? error)))
    }, ms)
    timer.unref?.()
    this.timers.push(timer)
  }

  async enableGroup() {
    const group = this.store.getGroup()
    if (!group || this.server) return
    const key = groupKeyFor(group.id)
    this.groupTag = groupTag(key)
    this.server = new PeerServer({
      nodeId: this.identity.nodeId,
      name: this.identity.name,
      platform: this.identity.platform,
      profile: this.profile,
      dshVersion: this.identity.dshVersion,
      joinedAt: group.createdAt ? Date.parse(group.createdAt) : null,
      groupKey: key,
      getManifest: async () => this.manifest(),
      getBlob: async (hash) => this.store.getRawBlob(hash),
      resolvePeer: async (nodeId) => this.store.getPeer(nodeId),
      onJoin: async (peer) => this.acceptPeer(peer),
      onNotify: async (payload) => {
        if (Array.isArray(payload?.items) && payload.items.length) await this.syncAll()
      },
      log: (level, message, extra) => this.logger[level]?.(message, extra),
    })
    const address = await this.server.listen({ port: this.requestedPort, host: this.bindHost })
    this.port = address.port

    if (this.useDiscovery) {
      this.discovery = new Discovery({
        nodeId: this.identity.nodeId,
        name: this.identity.name,
        platform: this.identity.platform,
        profile: this.profile,
        dshVersion: this.identity.dshVersion,
        port: this.port,
        udpPort: this.udpPort,
        groupTag: this.groupTag,
        onAnnounce: (peer) => this.onAnnounce(peer),
        log: this.logger,
      })
      await this.discovery.start()
    }

    // Same-host probing is independent of broadcast: WSL cannot receive the
    // host's UDP, but it can always reach the gateway address.
    await this.probeSameHost()
    this.every(30_000, () => this.probeSameHost())
  }

  async acceptPeer(peer) {
    const baseUrls = peerBaseUrls(peer)
    await this.store.upsertPeer({ ...peer, baseUrl: baseUrls[0] ?? null, baseUrls, direction: peer.direction ?? 'both' })
    this.logger.info?.('peer', `加入组：${peer.name ?? peer.nodeId} (${baseUrls[0] ?? '未知地址'})`)
  }

  async onAnnounce(peer) {
    if (peer.nodeId === this.identity.nodeId) return
    const known = this.store.getPeer(peer.nodeId)
    if (known?.secret) return
    this.joining ??= new Set()
    if (this.joining.has(peer.nodeId)) return
    this.joining.add(peer.nodeId)
    try {
      await this.join(baseUrlFor(peer.address, peer.port))
    } finally {
      this.joining.delete(peer.nodeId)
    }
  }

  async probeSameHost() {
    if (!this.store.getGroup()) return
    const ports = Array.from({ length: 11 }, (_, index) => 56701 + index)
    const candidates = new Set(['127.0.0.1'])
    const gateway = await linuxGateway()
    if (gateway) candidates.add(gateway)
    for (const host of candidates) {
      for (const port of ports) {
        if (host === '127.0.0.1' && port === this.port) continue
        try {
          const info = await fetchInfo(`http://${host}:${port}`)
          if (info.groupTag !== this.groupTag || info.nodeId === this.identity.nodeId) continue
          if (this.store.getPeer(info.nodeId)?.secret) continue
          await this.join(`http://${host}:${port}`)
        } catch {
          /* nothing listening */
        }
      }
    }
  }

  async join(address) {
    const group = this.store.getGroup()
    if (!group) return { ok: false, error: 'no-group' }
    const result = await joinPeer({
      baseUrl: address,
      groupKey: groupKeyFor(group.id),
      self: { ...this.identity, port: this.port, addresses: localAddresses() },
    })
    if (!result.ok) {
      this.logger.warn?.('join', `${address} 加入失败：${result.error}`)
      return result
    }
    await this.store.upsertPeer({
      nodeId: result.peer.nodeId,
      name: result.peer.name,
      platform: result.peer.platform,
      baseUrl: result.baseUrl,
      baseUrls: [result.baseUrl],
      secret: result.secret,
      direction: 'both',
      joinedAt: Date.now(),
    })
    this.logger.info?.('join', `已加入 ${result.peer.name} (${result.baseUrl})`)
    return result
  }

  manifest() {
    return this.store.listItems().map((item) => ({
      key: item.key,
      kind: item.kind,
      scope: item.scope,
      clock: item.clock,
      hash: item.hash ?? null,
      removedHash: item.removedHash ?? null,
      baseHash: item.baseHash ?? null,
      deleted: Boolean(item.deleted),
      pinned: Boolean(item.pinned),
      origin: item.origin ?? null,
      updatedAt: item.updatedAt,
    }))
  }

  async scan() {
    return this.engine.scan()
  }

  /**
   * Resolve one open conflict.
   * @param {string} id
   * @param {'ours'|'theirs'|'pin'|'edit'} action
   * @param {string} [content] JSON text for the `edit` action
   */
  async resolveConflict(id, action, content) {
    const conflict = this.store.getConflict(id)
    if (!conflict || conflict.state !== 'open') return { ok: false, error: 'not-found' }
    const item = this.store.getItem(conflict.key)
    if (!item) return { ok: false, error: 'missing-item' }

    if (action === 'pin') {
      await this.store.putItem(conflict.key, { ...item, pinned: true })
      await this.store.resolveConflict(id, { state: 'resolved', resolution: 'pin' })
      return { ok: true }
    }

    let blob = null
    if (action === 'ours') blob = item.hash ? await this.store.getBlob(item.hash) : null
    else if (action === 'theirs') blob = conflict.theirs ? await this.store.getBlob(conflict.theirs) : null
    else if (action === 'edit') {
      try {
        blob = JSON.parse(String(content ?? ''))
      } catch {
        return { ok: false, error: 'invalid-json' }
      }
    } else {
      return { ok: false, error: 'unsupported-action' }
    }
    if (!blob) return { ok: false, error: 'missing-blob' }

    const hash = await this.store.putBlob(blob)
    await this.applier.applyItem({ key: conflict.key, kind: item.kind, scope: item.scope, blob })
    await this.store.putItem(conflict.key, {
      ...item,
      hash,
      baseHash: hash,
      bases: Object.fromEntries(this.store.listPeers().map((peer) => [peer.nodeId, hash])),
      deleted: false,
      pinned: false,
      clock: bump(mergeClock(item.clock, conflict.theirsClock ?? {}), this.identity.nodeId),
      origin: this.identity.nodeId,
    })
    await this.store.resolveConflict(id, { state: 'resolved', resolution: action })
    const peers = this.store.listPeers().filter((peer) => peer.secret && peer.baseUrl)
    await this.engine.notifyPeers(peers, [conflict.key])
    return { ok: true }
  }

  /**
   * Try every known address for a peer until one answers; the winner is
   * remembered so later rounds skip the dead candidates.
   */
  async syncPeerWithFallback(peer) {
    const urls = [...new Set([peer.baseUrl, ...(peer.baseUrls ?? [])].filter(Boolean))]
    if (!urls.length) throw new Error('no-address')
    let lastError = null
    for (const url of urls) {
      try {
        const outcome = await this.engine.syncPeer({ ...peer, baseUrl: url })
        if (peer.baseUrl !== url) await this.store.upsertPeer({ ...peer, baseUrl: url, baseUrls: urls })
        return outcome
      } catch (error) {
        lastError = error
      }
    }
    throw lastError ?? new Error('unreachable')
  }

  async syncAll() {
    const peers = this.store.listPeers().filter((peer) => peer.secret && (peer.baseUrl || peer.baseUrls?.length))
    const results = []
    for (const peer of peers) {
      if (peer.direction === 'paused') continue
      try {
        const outcome = await this.syncPeerWithFallback(peer)
        results.push({ peer: peer.nodeId, outcome })
        await this.store.upsertPeer({ ...peer, lastSyncAt: new Date().toISOString(), lastError: null })
      } catch (error) {
        results.push({ peer: peer.nodeId, error: String(error?.message ?? error) })
        await this.store.upsertPeer({ ...peer, lastError: String(error?.message ?? error) })
      }
    }
    return results
  }

  async tickScan() {
    const changed = await this.scan()
    if (!changed.length) return
    const peers = this.store.listPeers().filter((peer) => peer.secret && peer.baseUrl)
    await this.engine.notifyPeers(peers, changed)
  }

  async tickSync() {
    await this.syncAll()
  }

  status() {
    const group = this.store.getGroup()
    return {
      identity: { ...this.identity, port: this.port },
      group: group ? { id: group.id, tag: this.groupTag ?? groupTag(groupKeyFor(group.id)), createdAt: group.createdAt } : null,
      peers: this.store.listPeers().map((peer) => ({
        nodeId: peer.nodeId,
        name: peer.name,
        platform: peer.platform,
        baseUrl: peer.baseUrl,
        direction: peer.direction,
        lastSyncAt: peer.lastSyncAt,
        lastError: peer.lastError,
        sameHost: peer.baseUrl?.startsWith('http://127.0.0.1'),
      })),
      conflicts: this.store.listConflicts({ state: 'open' }).length,
      items: this.store.listItems().length,
      settings: this.settings,
    }
  }

  async stop() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.discovery) await this.discovery.stop()
    if (this.server) await this.server.close()
    this.server = null
  }
}
