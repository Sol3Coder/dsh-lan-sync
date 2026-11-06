import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { canonicalJson, hashBlob, sha256 } from './hash.js'

const DEFAULT_STATE = () => ({ version: 1, nodeId: null, joinedAt: null, items: {}, scopeOverrides: {} })
const DEFAULT_PEERS = () => ({ version: 1, peers: {}, manual: [] })
const DEFAULT_CONFLICTS = () => ({ version: 1, conflicts: [] })

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback()
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

function blobPath(dir, hash) {
  const hex = String(hash).replace(/^sha256:/, '')
  return path.join(dir, 'blobs', hex.slice(0, 2), hex)
}

/**
 * On-disk state for one profile: items, content-addressed blobs, peers, group
 * and conflicts. All writes are atomic (tmp + rename).
 */
export class Store {
  /** @param {{ dir: string }} options */
  constructor({ dir }) {
    this.dir = dir
    this.state = DEFAULT_STATE()
    this.peers = DEFAULT_PEERS()
    this.conflicts = DEFAULT_CONFLICTS()
    this.group = null
  }

  async init() {
    await mkdir(path.join(this.dir, 'blobs'), { recursive: true })
    await mkdir(path.join(this.dir, 'snapshots'), { recursive: true })
    this.state = await readJson(path.join(this.dir, 'state.json'), DEFAULT_STATE)
    this.peers = await readJson(path.join(this.dir, 'peers.json'), DEFAULT_PEERS)
    this.conflicts = await readJson(path.join(this.dir, 'conflicts.json'), DEFAULT_CONFLICTS)
    const groupFile = path.join(this.dir, 'group.json')
    this.group = existsSync(groupFile) ? await readJson(groupFile, () => null) : null
    return this
  }

  async saveState() {
    await writeJsonAtomic(path.join(this.dir, 'state.json'), this.state)
  }

  async savePeers() {
    await writeJsonAtomic(path.join(this.dir, 'peers.json'), this.peers)
  }

  async saveConflicts() {
    await writeJsonAtomic(path.join(this.dir, 'conflicts.json'), this.conflicts)
  }

  // ── blobs ────────────────────────────────────────────────────────────────

  /** @param {unknown} value @returns {Promise<string>} */
  async putBlob(value) {
    const hash = hashBlob(value)
    const file = blobPath(this.dir, hash)
    if (!existsSync(file)) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, canonicalJson(value), 'utf8')
    }
    return hash
  }

  /** @param {string} hash @returns {Promise<unknown|null>} */
  async getBlob(hash) {
    try {
      return JSON.parse(await readFile(blobPath(this.dir, hash), 'utf8'))
    } catch {
      return null
    }
  }

  /** @param {Buffer|string} bytes @returns {Promise<string>} */
  async putRawBlob(bytes) {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    const hash = `sha256:${sha256(buffer)}`
    const file = blobPath(this.dir, hash)
    if (!existsSync(file)) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, buffer)
    }
    return hash
  }

  /** @param {string} hash @returns {Promise<Buffer|null>} */
  async getRawBlob(hash) {
    try {
      return await readFile(blobPath(this.dir, hash))
    } catch {
      return null
    }
  }

  // ── items ────────────────────────────────────────────────────────────────

  /** @param {string} key @param {Record<string, unknown>} item */
  async putItem(key, item) {
    this.state.items[key] = { ...item, key, updatedAt: item.updatedAt ?? new Date().toISOString() }
    await this.saveState()
    return this.state.items[key]
  }

  /** @param {string} key */
  getItem(key) {
    return this.state.items[key] ?? null
  }

  listItems() {
    return Object.values(this.state.items)
  }

  /** @param {string} key */
  async removeItem(key) {
    delete this.state.items[key]
    await this.saveState()
  }

  /** @param {string} key */
  markDeleted(key) {
    const item = this.state.items[key]
    if (!item) return null
    item.deleted = true
    item.deletedAt = new Date().toISOString()
    return item
  }

  // ── peers / group ────────────────────────────────────────────────────────

  getGroup() {
    return this.group
  }

  /** @param {{ id: string, createdAt?: string }} group */
  async setGroup(group) {
    this.group = { createdAt: new Date().toISOString(), ...group }
    await writeJsonAtomic(path.join(this.dir, 'group.json'), this.group)
    return this.group
  }

  /** @param {Record<string, unknown> & { nodeId: string }} peer */
  async upsertPeer(peer) {
    const previous = this.peers.peers[peer.nodeId] ?? {}
    this.peers.peers[peer.nodeId] = { ...previous, ...peer, updatedAt: new Date().toISOString() }
    await this.savePeers()
    return this.peers.peers[peer.nodeId]
  }

  /** @param {string} nodeId */
  getPeer(nodeId) {
    return this.peers.peers[nodeId] ?? null
  }

  listPeers() {
    return Object.values(this.peers.peers)
  }

  /** @param {string} nodeId */
  async removePeer(nodeId) {
    delete this.peers.peers[nodeId]
    await this.savePeers()
  }

  listManualPeers() {
    return [...(this.peers.manual ?? [])]
  }

  /** @param {string} address */
  async addManualPeer(address) {
    if (!this.peers.manual.includes(address)) this.peers.manual.push(address)
    await this.savePeers()
  }

  // ── conflicts ────────────────────────────────────────────────────────────

  /** @param {Record<string, unknown>} conflict */
  async addConflict(conflict) {
    const existing = this.conflicts.conflicts.find(
      (item) => item.key === conflict.key && item.state === 'open',
    )
    if (existing) return existing
    const record = {
      id: `c_${randomBytes(4).toString('hex')}`,
      createdAt: new Date().toISOString(),
      state: 'open',
      ...conflict,
    }
    this.conflicts.conflicts.push(record)
    await this.saveConflicts()
    return record
  }

  /** @param {{ state?: string }} [filter] */
  listConflicts(filter = {}) {
    return this.conflicts.conflicts.filter((item) => !filter.state || item.state === filter.state)
  }

  /** @param {string} id */
  getConflict(id) {
    return this.conflicts.conflicts.find((item) => item.id === id) ?? null
  }

  /** @param {string} id @param {Record<string, unknown>} patch */
  async resolveConflict(id, patch) {
    const record = this.getConflict(id)
    if (!record) return null
    Object.assign(record, patch, { resolvedAt: new Date().toISOString() })
    if (patch.state === 'resolved') record.state = 'resolved'
    await this.saveConflicts()
    return record
  }
}
