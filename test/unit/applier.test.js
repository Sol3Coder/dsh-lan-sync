import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Applier } from '../../lib/engine/applier.js'
import { Store } from '../../lib/engine/store.js'

async function fixture(platform = 'win32') {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-sync-apply-'))
  const home = path.join(root, '.dsh')
  const agentsHome = path.join(root, '.agents')
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await mkdir(path.join(home, 'skills'), { recursive: true })
  await writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    `# header
- id: plain
  name: pkg
  config:
    value: 1
`,
  )
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['base'] } } }, null, 2),
  )
  const store = new Store({ dir: path.join(root, 'state') })
  await store.init()
  const calls = []
  const applier = new Applier({
    profileDir,
    home,
    agentsHome,
    store,
    platform,
    applyDependency: async (payload) => calls.push({ type: 'dep', ...payload }),
    applyBundles: async (list) => calls.push({ type: 'bundles', list }),
  })
  return { root, home, agentsHome, profileDir, store, applier, calls, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('config items are written into the patch and snapshotted', async () => {
  const f = await fixture()
  try {
    await f.applier.applyItem({ key: 'config:plain', kind: 'config', scope: 'any', blob: { id: 'plain', name: 'pkg', config: { value: 2 } } })
    const patch = await readFile(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /# header/)
    assert.match(patch, /value: 2/)
    const snapshots = await f.applier.listSnapshots()
    assert.equal(snapshots.length, 1)
    assert.ok(snapshots[0].entries.some((entry) => entry.key === 'config:plain'))
  } finally {
    await f.cleanup()
  }
})

test('skill items are written with modes and can be removed', async () => {
  const f = await fixture('linux')
  try {
    const skillMd = await f.store.putRawBlob(Buffer.from('---\nname: foo\n---\n'))
    const runSh = await f.store.putRawBlob(Buffer.from('#!/bin/sh\necho hi\n'))
    const blob = { name: 'foo', root: 'dsh-home', flat: false, files: { 'SKILL.md': skillMd, 'run.sh': runSh }, modes: { 'SKILL.md': '0644', 'run.sh': '0755' } }
    await f.applier.applyItem({ key: 'skill:dsh-home:foo', kind: 'skill', scope: 'any', blob })

    const dir = path.join(f.home, 'skills', 'foo')
    assert.match(await readFile(path.join(dir, 'SKILL.md'), 'utf8'), /name: foo/)
    if (process.platform !== 'win32') {
      const mode = (await stat(path.join(dir, 'run.sh'))).mode & 0o777
      assert.equal(mode, 0o755)
    }

    await f.applier.removeItem({ key: 'skill:dsh-home:foo', kind: 'skill', blob })
    await assert.rejects(stat(dir))
  } finally {
    await f.cleanup()
  }
})

test('dependency and bundle changes go through the injected hooks', async () => {
  const f = await fixture()
  try {
    await f.applier.applyItem({ key: 'dep:new-pkg', kind: 'dep', scope: 'any', blob: { name: 'new-pkg', spec: '^1.0.0', kind: 'prod' } })
    await f.applier.applyItem({ key: 'bundles', kind: 'bundles', scope: 'any', blob: { list: ['base', 'new-pkg'] } })
    assert.deepEqual(f.calls[0], { type: 'dep', name: 'new-pkg', spec: '^1.0.0', kind: 'prod' })
    const manifest = JSON.parse(await readFile(path.join(f.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['base', 'new-pkg'])
  } finally {
    await f.cleanup()
  }
})

test('rolling back a snapshot restores the previous patch', async () => {
  const f = await fixture()
  try {
    const before = await readFile(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8')
    await f.applier.applyItem({ key: 'config:plain', kind: 'config', scope: 'any', blob: { id: 'plain', name: 'pkg', config: { value: 9 } } })
    const [snapshot] = await f.applier.listSnapshots()
    await f.applier.rollback(snapshot.id)
    assert.equal(await readFile(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8'), before)
  } finally {
    await f.cleanup()
  }
})
