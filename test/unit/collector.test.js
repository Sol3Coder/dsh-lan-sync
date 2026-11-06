import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Collector } from '../../lib/engine/collector.js'
import { Store } from '../../lib/engine/store.js'

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-sync-collect-'))
  const home = path.join(root, '.dsh')
  const agentsHome = path.join(root, '.agents')
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await mkdir(path.join(home, 'skills', 'foo', 'scripts'), { recursive: true })
  await mkdir(path.join(agentsHome, 'skills'), { recursive: true })

  await writeFile(
    path.join(profileDir, 'cordis.patch.yml'),
    `- id: mcp-win
  name: pkg
  config:
    command: 'C:\\bin\\x.exe'
- id: plain
  name: pkg
  config:
    value: 1
`,
  )
  await writeFile(
    path.join(profileDir, 'package.json'),
    JSON.stringify(
      {
        dependencies: { 'dsh-palimpsest': '^0.2.1' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-palimpsest'] } },
      },
      null,
      2,
    ),
  )
  await writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
  await writeFile(path.join(home, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\n')
  await writeFile(path.join(home, 'skills', 'foo', 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n')
  await writeFile(path.join(agentsHome, 'skills', 'bar.md'), '# bar\n')

  const store = new Store({ dir: path.join(root, 'state') })
  await store.init()
  return { root, home, agentsHome, profileDir, store }
}

test('collects config rows, dependencies, bundle order and profile files', async () => {
  const { root, home, agentsHome, profileDir, store } = await fixture()
  try {
    const collector = new Collector({ home, agentsHome, profileDir, store, platform: 'win32' })
    const items = await collector.collect()
    const byKey = new Map(items.map((item) => [item.key, item]))

    assert.equal(byKey.get('config:mcp-win@win32').scope, 'win32')
    assert.equal(byKey.get('config:mcp-win@win32').blob.config.command, 'C:\\bin\\x.exe')
    assert.equal(byKey.get('config:plain').scope, 'any')

    assert.equal(byKey.get('dep:dsh-palimpsest').blob.spec, '^0.2.1')
    assert.deepEqual(byKey.get('bundles').blob.list, ['@deepseek-ai/dsh-base', 'dsh-palimpsest'])
    assert.equal(byKey.get('profile-file:pnpm-workspace.yaml').blob.path, 'pnpm-workspace.yaml')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collects directory and flat skills with content hashes', async () => {
  const { root, home, agentsHome, profileDir, store } = await fixture()
  try {
    const collector = new Collector({ home, agentsHome, profileDir, store, platform: 'linux' })
    const items = await collector.collect()
    const byKey = new Map(items.map((item) => [item.key, item]))

    const foo = byKey.get('skill:dsh-home:foo')
    assert.ok(foo)
    assert.equal(foo.kind, 'skill')
    assert.equal(foo.scope, 'any')
    assert.match(foo.blob.files['SKILL.md'], /^sha256:[a-f0-9]{64}$/)
    assert.ok(foo.blob.files['scripts/run.sh'])
    assert.ok((await store.getRawBlob(foo.blob.files['scripts/run.sh'])).includes('echo hi'))

    const bar = byKey.get('skill:agents-home:bar')
    assert.ok(bar)
    assert.equal(bar.blob.flat, true)
    assert.ok(bar.blob.files['bar.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
