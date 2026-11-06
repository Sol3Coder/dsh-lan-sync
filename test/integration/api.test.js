import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../../lib/index.js'

function fakeCtx() {
  const routes = []
  const disposers = []
  return {
    routes,
    disposers,
    webServer: {
      register: (definition) => {
        routes.push(definition)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    get: () => undefined,
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }
}

async function withApi(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'lan-sync-api-'))
  const home = path.join(root, '.dsh')
  const profileDir = path.join(home, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: plain\n  name: pkg\n')
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }))

  const ctx = fakeCtx()
  apply(ctx, {
    profile: 'web',
    profileDir,
    home,
    agentsHome: path.join(root, '.agents'),
    tcpPort: 0,
    udpPort: 0,
    discovery: false,
    dshVersion: '0.2.1',
  })
  await new Promise((resolve) => setTimeout(resolve, 150))

  const server = createServer((req, res) => ctx.routes[0].handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn({ base, ctx })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    for (const dispose of ctx.disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    await rm(root, { recursive: true, force: true })
  }
}

test('the status route reports an unconfigured instance', async () => {
  await withApi(async ({ base }) => {
    const response = await fetch(`${base}/api/lan-sync/status`)
    assert.equal(response.status, 200)
    const status = await response.json()
    assert.equal(status.group, null)
    assert.equal(status.identity.nodeId.startsWith('n_'), true)
  })
})

test('setting a group returns its tag and appears in status', async () => {
  await withApi(async ({ base }) => {
    const created = await fetch(`${base}/api/lan-sync/group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'api-test-group' }),
    })
    assert.equal(created.status, 200)
    const body = await created.json()
    assert.equal(body.ok, true)
    assert.match(body.group.tag, /^[0-9a-f]{16}$/)

    const status = await (await fetch(`${base}/api/lan-sync/status`)).json()
    assert.equal(status.group.id, 'api-test-group')
  })
})

test('short group ids are rejected', async () => {
  await withApi(async ({ base }) => {
    const response = await fetch(`${base}/api/lan-sync/group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'short' }),
    })
    assert.equal(response.status, 400)
  })
})

test('settings and conflicts routes answer with JSON', async () => {
  await withApi(async ({ base }) => {
    const settings = await (
      await fetch(`${base}/api/lan-sync/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoApply: false }),
      })
    ).json()
    assert.equal(settings.ok, true)
    assert.equal(settings.settings.autoApply, false)

    const conflicts = await (await fetch(`${base}/api/lan-sync/conflicts`)).json()
    assert.deepEqual(conflicts.conflicts, [])
  })
})
