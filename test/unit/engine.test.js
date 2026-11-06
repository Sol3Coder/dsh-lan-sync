import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Collector } from '../../lib/engine/collector.js'
import { SyncEngine } from '../../lib/engine/sync-engine.js'
import { Store } from '../../lib/engine/store.js'

async function makeNode({ nodeId, patch, deps = {} }) {
  const root = await mkdtemp(path.join(tmpdir(), `lan-sync-${nodeId}-`))
  const home = path.join(root, '.dsh')
  const agentsHome = path.join(root, '.agents')
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await mkdir(path.join(home, 'skills'), { recursive: true })
  await mkdir(path.join(agentsHome, 'skills'), { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), patch)
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: deps, dsh: { profile: { bundles: ['base'] } } }, null, 2),
  )

  const store = new Store({ dir: path.join(root, 'state') })
  await store.init()
  const collector = new Collector({ home, agentsHome, profileDir, store, platform: 'win32' })
  const applied = []
  const applier = {
    applyItem: async (item) => {
      applied.push({ action: 'apply', ...item })
    },
    removeItem: async (item) => {
      applied.push({ action: 'remove', ...item })
    },
  }
  /** @type {Map<string, any>} */
  const blobs = new Map()
  const transport = {
    async fetchManifest(peer) {
      return { items: peer.manifest }
    },
    async fetchBlob(peer, hash) {
      return store.getBlob(hash)
    },
    async notify() {},
  }
  const engine = new SyncEngine({
    store,
    collector,
    applier,
    transport,
    identity: { nodeId, name: nodeId, platform: 'win32', profile: 'web', dshVersion: '0.2.1' },
  })
  await engine.init()
  return { root, engine, store, applied, blobs, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const PATCH = `- id: plain
  name: pkg
  config:
    value: 1
`

test('scan records every local item with a first clock tick', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const item = node.store.getItem('config:plain')
    assert.ok(item)
    assert.deepEqual(item.clock, { n_a: 1 })
    assert.equal(item.deleted, false)
    assert.ok(node.store.getItem('bundles'))
  } finally {
    await node.cleanup()
  }
})

test('a newer remote item is applied and becomes the new base', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const local = node.store.getItem('config:plain')
    await node.store.putItem('config:plain', { ...local, bases: { n_b: local.hash } })
    const blob = { id: 'plain', name: 'pkg', config: { value: 2 } }
    const hash = await node.store.putBlob(blob)

    await node.engine.syncPeer({
      nodeId: 'n_b',
      secret: 's',
      direction: 'both',
      manifest: [{ key: 'config:plain', kind: 'config', scope: 'any', clock: { n_b: 5 }, hash, deleted: false, origin: 'n_b' }],
    })

    assert.equal(node.applied.length, 1)
    assert.equal(node.applied[0].blob.config.value, 2)
    const item = node.store.getItem('config:plain')
    assert.equal(item.hash, hash)
    assert.equal(item.baseHash, hash)
    assert.equal(item.clock.n_b, 5)
    assert.ok(item.clock.n_a >= 1)
    assert.ok(local)
  } finally {
    await node.cleanup()
  }
})

test('concurrent edits on disjoint fields merge without a conflict', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const base = { id: 'plain', name: 'pkg', config: { value: 1 } }
    const ours = { id: 'plain', name: 'pkg', config: { value: 1, extra: 'a' } }
    const theirs = { id: 'plain', name: 'pkg', config: { value: 2 } }
    const baseHash = await node.store.putBlob(base)
    const oursHash = await node.store.putBlob(ours)
    const theirsHash = await node.store.putBlob(theirs)
    await node.store.putItem('config:plain', {
      kind: 'config',
      scope: 'any',
      hash: oursHash,
      baseHash,
      clock: { n_a: 2 },
      bases: { n_b: baseHash },
      deleted: false,
      origin: 'n_a',
    })

    await node.engine.syncPeer({
      nodeId: 'n_b',
      secret: 's',
      direction: 'both',
      manifest: [{ key: 'config:plain', kind: 'config', scope: 'any', clock: { n_b: 3 }, hash: theirsHash, deleted: false, origin: 'n_b' }],
    })

    assert.equal(node.store.listConflicts({ state: 'open' }).length, 0)
    assert.equal(node.applied.length, 1)
    assert.deepEqual(node.applied[0].blob.config, { value: 2, extra: 'a' })
  } finally {
    await node.cleanup()
  }
})

test('concurrent edits on the same field become a conflict and are not applied', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const base = { id: 'plain', name: 'pkg', config: { value: 1 } }
    const ours = { id: 'plain', name: 'pkg', config: { value: 2 } }
    const theirs = { id: 'plain', name: 'pkg', config: { value: 3 } }
    const baseHash = await node.store.putBlob(base)
    const oursHash = await node.store.putBlob(ours)
    const theirsHash = await node.store.putBlob(theirs)
    await node.store.putItem('config:plain', {
      kind: 'config',
      scope: 'any',
      hash: oursHash,
      baseHash,
      clock: { n_a: 2 },
      bases: { n_b: baseHash },
      deleted: false,
      origin: 'n_a',
    })

    await node.engine.syncPeer({
      nodeId: 'n_b',
      secret: 's',
      direction: 'both',
      manifest: [{ key: 'config:plain', kind: 'config', scope: 'any', clock: { n_b: 2 }, hash: theirsHash, deleted: false, origin: 'n_b' }],
    })

    const conflicts = node.store.listConflicts({ state: 'open' })
    assert.equal(conflicts.length, 1)
    assert.equal(conflicts[0].key, 'config:plain')
    assert.deepEqual(conflicts[0].paths, ['config.value'])
    assert.equal(node.applied.length, 0)
    assert.equal(node.store.getItem('config:plain').hash, oursHash)
  } finally {
    await node.cleanup()
  }
})

test('a remote deletion removes the local item', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const current = node.store.getItem('config:plain')
    await node.store.putItem('config:plain', { ...current, bases: { n_b: current.hash } })
    await node.engine.syncPeer({
      nodeId: 'n_b',
      secret: 's',
      direction: 'both',
      manifest: [{ key: 'config:plain', kind: 'config', scope: 'any', clock: { n_b: 9 }, hash: null, deleted: true, origin: 'n_b' }],
    })
    assert.equal(node.applied[0].action, 'remove')
    const item = node.store.getItem('config:plain')
    assert.equal(item.deleted, true)
    assert.equal(item.hash, null)
  } finally {
    await node.cleanup()
  }
})

test('a tombstone naming the local hash deletes even after a local edit', async () => {
  const node = await makeNode({ nodeId: 'n_a', patch: PATCH })
  try {
    await node.engine.scan()
    const base = { id: 'plain', name: 'pkg', config: { value: 1 } }
    const edited = { id: 'plain', name: 'pkg', config: { value: 2 } }
    const baseHash = await node.store.putBlob(base)
    const editedHash = await node.store.putBlob(edited)
    await node.store.putItem('config:plain', {
      kind: 'config',
      scope: 'any',
      hash: editedHash,
      baseHash,
      bases: { n_b: baseHash },
      clock: { n_a: 2 },
      deleted: false,
      origin: 'n_a',
    })

    await node.engine.syncPeer({
      nodeId: 'n_b',
      secret: 's',
      direction: 'both',
      manifest: [{
        key: 'config:plain',
        kind: 'config',
        scope: 'any',
        clock: { n_b: 3 },
        hash: null,
        deleted: true,
        removedHash: editedHash,
        origin: 'n_b',
      }],
    })

    assert.equal(node.store.listConflicts({ state: 'open' }).length, 0)
    assert.equal(node.applied[0].action, 'remove')
    assert.equal(node.store.getItem('config:plain').deleted, true)
  } finally {
    await node.cleanup()
  }
})
