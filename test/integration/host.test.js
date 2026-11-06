import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LanSyncHost } from '../../lib/host.js'

const GROUP = 'lan-sync-test-group'

async function makeHost(nodeId, port) {
  const root = await mkdtemp(path.join(tmpdir(), `lan-sync-host-${nodeId}-`))
  const home = path.join(root, '.dsh')
  const agentsHome = path.join(root, '.agents')
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await mkdir(path.join(home, 'skills'), { recursive: true })
  await writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    `- id: plain\n  name: pkg\n  config:\n    value: 1\n`,
  )
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))
  const host = new LanSyncHost({
    home,
    agentsHome,
    profileDir,
    profile: 'web',
    identity: { nodeId, name: nodeId, platform: 'win32', dshVersion: '0.2.1' },
  })
  await host.start({ tcpPort: port, host: '127.0.0.1', discovery: false })
  await host.store.setGroup({ id: GROUP })
  await host.enableGroup()
  return { host, root, profileDir, cleanup: async () => { await host.stop(); await rm(root, { recursive: true, force: true }) } }
}

test('two hosts join a group and a config change propagates', async () => {
  const a = await makeHost('n_a', 0)
  const b = await makeHost('n_b', 0)
  try {
    const joined = await a.host.join(`http://127.0.0.1:${b.host.port}`)
    assert.equal(joined.ok, true, joined.error)
    assert.ok(a.host.store.getPeer('n_b')?.secret)
    assert.ok(b.host.store.getPeer('n_a')?.secret)

    await a.host.scan()
    await b.host.scan()
    // first contact establishes the shared base for identical items
    await a.host.syncAll()
    await b.host.syncAll()

    await writeFile(path.join(a.profileDir, 'cordis.patch.yml'), `- id: plain\n  name: pkg\n  config:\n    value: 2\n`)
    await a.host.scan()

    await b.host.syncAll()
    const patch = await readFile(path.join(b.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /value: 2/)
  } finally {
    await a.cleanup()
    await b.cleanup()
  }
})

test('concurrent edits on the same field surface a conflict', async () => {
  const a = await makeHost('n_a', 0)
  const b = await makeHost('n_b', 0)
  try {
    await a.host.join(`http://127.0.0.1:${b.host.port}`)
    await a.host.scan()
    await b.host.scan()
    // establish a common base while both sides are identical
    await a.host.syncAll()
    await b.host.syncAll()

    await writeFile(path.join(a.profileDir, 'cordis.patch.yml'), `- id: plain\n  name: pkg\n  config:\n    value: 4\n`)
    await writeFile(path.join(b.profileDir, 'cordis.patch.yml'), `- id: plain\n  name: pkg\n  config:\n    value: 5\n`)
    await a.host.scan()
    await b.host.scan()
    await a.host.syncAll()
    await b.host.syncAll()
    assert.ok(b.host.store.listConflicts({ state: 'open' }).length >= 1 || a.host.store.listConflicts({ state: 'open' }).length >= 1)
  } finally {
    await a.cleanup()
    await b.cleanup()
  }
})
