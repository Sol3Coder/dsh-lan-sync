import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../../lib/engine/store.js'

async function withStore(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lan-sync-store-'))
  try {
    const store = new Store({ dir })
    await store.init()
    await fn(store, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('json blobs round-trip and are content addressed', async () => {
  await withStore(async (store) => {
    const hash = await store.putBlob({ a: 1, b: [2] })
    assert.match(hash, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(await store.getBlob(hash), { a: 1, b: [2] })
    assert.equal(await store.putBlob({ b: [2], a: 1 }), hash)
    assert.equal(await store.getBlob('sha256:deadbeef'), null)
  })
})

test('raw blobs keep bytes intact', async () => {
  await withStore(async (store) => {
    const bytes = Buffer.from([0, 1, 2, 255])
    const hash = await store.putRawBlob(bytes)
    assert.deepEqual(await store.getRawBlob(hash), bytes)
  })
})

test('items persist across instances', async () => {
  await withStore(async (store, dir) => {
    await store.putItem('config:a@win32', {
      kind: 'config',
      scope: 'win32',
      hash: 'sha256:1',
      clock: { n1: 2 },
      baseHash: null,
      deleted: false,
      pinned: false,
      updatedAt: '2026-11-06T00:00:00.000Z',
      origin: 'n1',
    })
    const reopened = new Store({ dir })
    await reopened.init()
    const item = reopened.getItem('config:a@win32')
    assert.equal(item.kind, 'config')
    assert.deepEqual(item.clock, { n1: 2 })
    assert.equal(reopened.listItems().length, 1)
  })
})

test('conflicts are recorded, listed and resolved', async () => {
  await withStore(async (store) => {
    const conflict = await store.addConflict({
      key: 'config:a',
      kind: 'config',
      base: 'sha256:0',
      ours: 'sha256:1',
      theirs: 'sha256:2',
      oursBy: 'n1',
      theirsBy: 'n2',
      paths: ['config.env.A'],
    })
    assert.match(conflict.id, /^c_/)
    assert.equal(store.listConflicts().length, 1)
    await store.resolveConflict(conflict.id, { state: 'resolved', resolution: 'ours' })
    assert.equal(store.listConflicts({ state: 'open' }).length, 0)
    assert.equal(store.listConflicts({ state: 'resolved' }).length, 1)
  })
})

test('group and peers persist with the store', async () => {
  await withStore(async (store, dir) => {
    await store.setGroup({ id: 'lab-2026', createdAt: '2026-11-06T00:00:00.000Z' })
    await store.upsertPeer({
      nodeId: 'n2',
      name: 'wsl/web',
      platform: 'linux',
      secret: 'c2VjcmV0',
      direction: 'both',
    })
    const reopened = new Store({ dir })
    await reopened.init()
    assert.equal(reopened.getGroup().id, 'lab-2026')
    assert.equal(reopened.listPeers().length, 1)
    assert.equal(reopened.getPeer('n2').platform, 'linux')
  })
})
