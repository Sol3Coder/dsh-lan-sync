import test from 'node:test'
import assert from 'node:assert/strict'
import { joinPeer } from '../../lib/engine/peer-client.js'
import { PeerServer } from '../../lib/engine/peer-server.js'
import { deriveGroupKey } from '../../lib/engine/crypto.js'

function makeServer(overrides = {}) {
  const groupKey = deriveGroupKey('lab-2026')
  const server = new PeerServer({
    nodeId: 'n_server',
    name: 'test/server',
    platform: 'linux',
    profile: 'web',
    dshVersion: '0.2.1',
    groupKey,
    getManifest: async () => ({ v: 1, items: [{ key: 'config:a', kind: 'config', scope: 'any', clock: { n_server: 1 }, hash: 'sha256:x', deleted: false }] }),
    getBlob: async () => Buffer.from('{}'),
    onJoin: async () => {},
    ...overrides,
  })
  return { server, groupKey }
}

test('a peer joins a group and receives a shared secret', async () => {
  const { server, groupKey } = makeServer()
  const { port } = await server.listen({ port: 0, host: '127.0.0.1' })
  try {
    const joined = await joinPeer({
      baseUrl: `http://127.0.0.1:${port}`,
      groupKey,
      self: { nodeId: 'n_client', name: 'test/client', platform: 'win32', dshVersion: '0.2.1' },
    })
    assert.equal(joined.ok, true)
    assert.equal(joined.peer.nodeId, 'n_server')
    assert.equal(joined.peer.name, 'test/server')
    assert.ok(joined.secret.length > 20)
  } finally {
    await server.close()
  }
})

test('a peer with the wrong group id cannot join', async () => {
  const { server } = makeServer()
  const { port } = await server.listen({ port: 0, host: '127.0.0.1' })
  try {
    const joined = await joinPeer({
      baseUrl: `http://127.0.0.1:${port}`,
      groupKey: deriveGroupKey('other-group'),
      self: { nodeId: 'n_bad', name: 'bad', platform: 'linux', dshVersion: '0.2.1' },
    })
    assert.equal(joined.ok, false)
    assert.equal(joined.error, 'group-mismatch')
  } finally {
    await server.close()
  }
})

test('manifest requires the per-peer secret', async () => {
  const { server, groupKey } = makeServer()
  const { port } = await server.listen({ port: 0, host: '127.0.0.1' })
  try {
    const joined = await joinPeer({
      baseUrl: `http://127.0.0.1:${port}`,
      groupKey,
      self: { nodeId: 'n_client2', name: 'test/client2', platform: 'win32', dshVersion: '0.2.1' },
    })
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/manifest`)
    assert.equal(unauthorized.status, 401)
    const authorized = await fetch(`http://127.0.0.1:${port}/v1/manifest`, {
      headers: { 'x-lan-sync': joined.secret ? 'bad' : 'bad' },
    })
    assert.equal(authorized.status, 401)
  } finally {
    await server.close()
  }
})
