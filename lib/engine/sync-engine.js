import { bump, compare, merge as mergeClock } from './clock.js'
import { hashBlob } from './hash.js'
import { mergeBlob } from './merge.js'

/**
 * Anti-entropy orchestrator. Versioning and conflict detection live here;
 * writing to disk is delegated to an applier and peer I/O to a transport.
 *
 * Agreement is tracked per peer (`item.bases[peerId]`): an item without a base
 * for a peer has never been reconciled with that peer, so a differing remote
 * value becomes a conflict instead of silently overwriting local work.
 */
export class SyncEngine {
  /**
   * @param {{ store: import('./store.js').Store, collector: import('./collector.js').Collector,
   *           applier: { applyItem: Function, removeItem: Function },
   *           transport: { fetchManifest: Function, fetchBlob: Function, notify?: Function },
   *           identity: { nodeId: string, name: string, platform: string, profile: string, dshVersion: string },
   *           logger?: { info: Function, warn: Function, error: Function } }} options
   */
  constructor({ store, collector, applier, transport, identity, logger }) {
    this.store = store
    this.collector = collector
    this.applier = applier
    this.transport = transport
    this.identity = identity
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
  }

  get nodeId() {
    return this.identity.nodeId
  }

  async init() {
    if (!this.store.state.nodeId) {
      this.store.state.nodeId = this.nodeId
      await this.store.saveState()
    }
    return this
  }

  /** Re-read local files and record any change as a new item version. */
  async scan() {
    const collected = await this.collector.collect()
    const seen = new Set()
    /** @type {string[]} */
    const changed = []

    for (const item of collected) {
      seen.add(item.key)
      const hash = await this.store.putBlob(item.blob)
      const existing = this.store.getItem(item.key)
      if (!existing) {
        await this.store.putItem(item.key, {
          kind: item.kind,
          scope: item.scope,
          mixed: Boolean(item.mixed),
          hash,
          baseHash: hash,
          bases: {},
          clock: { [this.nodeId]: 1 },
          deleted: false,
          origin: this.nodeId,
        })
        changed.push(item.key)
        continue
      }
      if (existing.hash !== hash || existing.deleted) {
        await this.store.putItem(item.key, {
          ...existing,
          kind: item.kind,
          scope: item.scope,
          mixed: Boolean(item.mixed),
          hash,
          baseHash: existing.baseHash ?? null,
          deleted: false,
          deletedAt: null,
          clock: bump(existing.clock, this.nodeId),
          origin: this.nodeId,
        })
        changed.push(item.key)
      }
    }

    for (const item of this.store.listItems()) {
      if (seen.has(item.key) || item.deleted) continue
      await this.store.putItem(item.key, {
        ...item,
        deleted: true,
        deletedAt: new Date().toISOString(),
        hash: null,
        removedHash: item.hash,
        clock: bump(item.clock, this.nodeId),
        origin: this.nodeId,
      })
      changed.push(item.key)
    }

    return changed
  }

  /**
   * One anti-entropy round against one peer.
   * @param {{ nodeId: string, manifest?: any[], direction?: string }} peer
   */
  async syncPeer(peer) {
    const direction = peer.direction ?? 'both'
    if (direction === 'push' || direction === 'paused') return []
    const items = peer.manifest ?? (await this.transport.fetchManifest(peer)).items ?? []
    /** @type {Array<{key: string, result: string}>} */
    const results = []

    for (const remote of items) {
      const local = this.store.getItem(remote.key)
      if (local?.pinned) {
        results.push({ key: remote.key, result: 'pinned' })
        continue
      }
      if (!local) {
        results.push({ key: remote.key, result: await this.adopt(peer, remote) })
        continue
      }

      const base = local.bases?.[peer.nodeId] ?? null
      if (remote.deleted && remote.removedHash && local.hash === remote.removedHash) {
        // The peer deleted exactly the version we hold; a local edit made after
        // that version must not turn a clean delete into a conflict.
        results.push({ key: remote.key, result: await this.adopt(peer, remote) })
        continue
      }
      if (base && local.hash === remote.hash && Boolean(local.deleted) === Boolean(remote.deleted)) {
        results.push({ key: remote.key, result: 'in-sync' })
        continue
      }

      const relation = compare(local.clock, remote.clock)
      if (relation === 'equal' || relation === 'ahead') {
        results.push({ key: remote.key, result: relation })
        continue
      }

      if (base && !local.deleted && local.hash === base) {
        results.push({ key: remote.key, result: await this.adopt(peer, remote) })
        continue
      }

      if (!base) {
        if (local.deleted) {
          results.push({ key: remote.key, result: await this.adopt(peer, remote) })
          continue
        }
        if (remote.deleted) {
          results.push({ key: remote.key, result: await this.conflict(peer, local, remote, 'delete-vs-modify', []) })
          continue
        }
        const theirs = await this.hydrate(peer, remote)
        if (theirs && hashBlob(theirs) === local.hash) {
          await this.setBase(local.key, peer.nodeId, local.hash)
          results.push({ key: remote.key, result: 'in-sync' })
          continue
        }
        results.push({ key: remote.key, result: await this.conflict(peer, local, remote, 'no-common-base', []) })
        continue
      }

      results.push({ key: remote.key, result: await this.mergeWith(peer, local, remote, base) })
    }
    return results
  }

  async setBase(key, peerNodeId, hash) {
    const item = this.store.getItem(key)
    if (!item) return
    await this.store.putItem(key, { ...item, bases: { ...(item.bases ?? {}), [peerNodeId]: hash } })
  }

  async conflict(peer, local, remote, reason, paths) {
    await this.store.addConflict({
      key: remote.key,
      kind: local.kind,
      reason,
      base: null,
      ours: local.hash,
      theirs: remote.deleted ? null : remote.hash,
      oursBy: local.origin,
      theirsBy: remote.origin,
      paths,
      oursClock: local.clock,
      theirsClock: remote.clock,
    })
    this.logger.warn?.('conflict', remote.key)
    return 'conflict'
  }

  async adopt(peer, remote) {
    const local = this.store.getItem(remote.key)

    if (remote.deleted) {
      if (!local) return 'deleted'
      await this.applier.removeItem({ key: remote.key, kind: remote.kind, blob: null })
      await this.store.putItem(remote.key, {
        ...local,
        deleted: true,
        deletedAt: new Date().toISOString(),
        hash: null,
        baseHash: null,
        bases: { ...(local.bases ?? {}), [peer.nodeId]: null },
        clock: bump(mergeClock(local.clock, remote.clock), this.nodeId),
        origin: remote.origin ?? peer.nodeId,
      })
      return 'deleted'
    }

    const blob = await this.hydrate(peer, remote)
    if (!blob) return 'missing-blob'
    const hash = await this.store.putBlob(blob)
    await this.applier.applyItem({
      key: remote.key,
      kind: remote.kind,
      scope: remote.scope,
      blob,
      meta: { origin: remote.origin, remote: peer.nodeId },
    })
    await this.store.putItem(remote.key, {
      kind: remote.kind,
      scope: remote.scope,
      hash,
      baseHash: hash,
      bases: { ...(local?.bases ?? {}), [peer.nodeId]: hash },
      clock: bump(mergeClock(local?.clock ?? {}, remote.clock), this.nodeId),
      deleted: false,
      origin: this.nodeId,
    })
    return 'applied'
  }

  async mergeWith(peer, local, remote, baseHash) {
    if (remote.deleted) {
      return this.conflict(peer, local, remote, 'delete-vs-modify', [])
    }

    const theirs = await this.hydrate(peer, remote)
    if (!theirs) return 'missing-blob'
    const base = baseHash ? await this.store.getBlob(baseHash) : null
    const ours = local.hash ? await this.store.getBlob(local.hash) : null
    const merged = mergeBlob(local.kind, base, ours, theirs)

    if (!merged.clean) {
      await this.store.addConflict({
        key: remote.key,
        kind: local.kind,
        base: baseHash,
        ours: local.hash,
        theirs: remote.hash,
        oursBy: local.origin,
        theirsBy: remote.origin,
        paths: merged.conflicts.map((conflict) => conflict.path),
        oursClock: local.clock,
        theirsClock: remote.clock,
      })
      this.logger.warn?.('conflict', `${remote.key}: ${merged.conflicts.length} field(s)`)
      return 'conflict'
    }

    await this.applier.applyItem({
      key: remote.key,
      kind: local.kind,
      scope: local.scope,
      blob: merged.value,
      meta: { merged: true, origin: remote.origin, remote: peer.nodeId },
    })
    const hash = await this.store.putBlob(merged.value)
    await this.store.putItem(remote.key, {
      ...local,
      hash,
      baseHash: hash,
      bases: { ...(local.bases ?? {}), [peer.nodeId]: hash },
      deleted: false,
      clock: bump(mergeClock(local.clock, remote.clock), this.nodeId),
      origin: this.nodeId,
    })
    return 'merged'
  }

  async hydrate(peer, remote) {
    const raw = await this.transport.fetchBlob(peer, remote.hash)
    if (!raw) return null
    const blob = Buffer.isBuffer(raw) ? JSON.parse(raw.toString('utf8')) : raw
    if (remote.kind !== 'skill') return blob

    const tree = { ...blob, files: { ...(blob.files ?? {}) } }
    for (const [relative, hash] of Object.entries(tree.files)) {
      if (await this.store.getRawBlob(hash)) continue
      const bytes = await this.transport.fetchBlob(peer, hash)
      if (!bytes) return null
      await this.store.putRawBlob(bytes)
      tree.files[relative] = hash
    }
    return tree
  }

  async notifyPeers(peers, items) {
    if (!items.length || !this.transport.notify) return
    await Promise.allSettled(
      peers
        .filter((peer) => (peer.direction ?? 'both') !== 'pull' && (peer.direction ?? 'both') !== 'paused')
        .map((peer) => this.transport.notify(peer, items)),
    )
  }
}
