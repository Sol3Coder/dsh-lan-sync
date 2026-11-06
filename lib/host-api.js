const PREFIX = '/api/lan-sync'
const MAX_BODY = 1024 * 1024

function sendJson(res, status, value) {
  if (res.headersSent) return
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function asLines(value) {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.split('\n')
}

/**
 * Browser-facing routes on the GUI server. `webServer` has no global auth, so
 * every request is rejected unless `connection.requestRejection` approves it.
 * @param {any} ctx cordis context
 * @param {import('./host.js').LanSyncHost} host
 */
export function registerRoutes(ctx, host) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      handle(req, res, ctx, host).catch((error) => {
        host.logger?.error?.('api', String(error?.message ?? error))
        sendJson(res, 500, { ok: false, error: 'internal' })
      })
    },
  })
}

async function handle(req, res, ctx, host) {
  const connection = ctx.get?.('connection')
  const rejection = connection?.requestRejection?.(req)
  if (rejection) {
    res.writeHead(rejection).end()
    return
  }

  const url = new URL(req.url, 'http://lan-sync.local')
  const route = url.pathname.slice(PREFIX.length) || '/'
  const method = req.method ?? 'GET'

  if (method === 'GET' && route === '/status') {
    return sendJson(res, 200, host.status())
  }

  if (method === 'GET' && route === '/items') {
    return sendJson(res, 200, {
      items: host.store.listItems().map((item) => ({
        key: item.key,
        kind: item.kind,
        scope: item.scope,
        hash: item.hash,
        deleted: Boolean(item.deleted),
        pinned: Boolean(item.pinned),
        clock: item.clock,
        updatedAt: item.updatedAt,
      })),
    })
  }

  if (method === 'POST' && route === '/group') {
    const body = await readBody(req)
    const id = String(body.id ?? '').trim()
    if (id.length < 8) return sendJson(res, 400, { ok: false, error: 'group-id-too-short' })
    const group = await host.store.setGroup({ id })
    await host.enableGroup()
    return sendJson(res, 200, { ok: true, group: { id: group.id, tag: host.groupTag } })
  }

  if (method === 'POST' && route === '/join') {
    const body = await readBody(req)
    const address = String(body.address ?? '').trim()
    if (!/^https?:\/\//.test(address)) return sendJson(res, 400, { ok: false, error: 'address-must-be-url' })
    const result = await host.join(address)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  if (method === 'POST' && route === '/sync') {
    const results = await host.syncAll()
    return sendJson(res, 200, { ok: true, results })
  }

  if (method === 'GET' && route === '/conflicts') {
    const conflicts = host.store.listConflicts({ state: 'open' })
    const detailed = []
    for (const conflict of conflicts) {
      const base = conflict.base ? await host.store.getBlob(conflict.base) : null
      const ours = conflict.ours ? await host.store.getBlob(conflict.ours) : null
      const theirs = conflict.theirs ? await host.store.getBlob(conflict.theirs) : null
      detailed.push({
        id: conflict.id,
        key: conflict.key,
        kind: conflict.kind,
        paths: conflict.paths ?? [],
        reason: conflict.reason ?? 'diverged',
        oursBy: conflict.oursBy,
        theirsBy: conflict.theirsBy,
        createdAt: conflict.createdAt,
        diff: { base: asLines(base), ours: asLines(ours), theirs: asLines(theirs) },
      })
    }
    return sendJson(res, 200, { conflicts: detailed })
  }

  const resolveMatch = /^\/conflicts\/([^/]+)\/resolve$/.exec(route)
  if (method === 'POST' && resolveMatch) {
    const body = await readBody(req)
    const result = await host.resolveConflict(decodeURIComponent(resolveMatch[1]), String(body.action ?? ''), body.content)
    return sendJson(res, result.ok ? 200 : 400, result)
  }

  if (method === 'GET' && route === '/snapshots') {
    const snapshots = await host.applier.listSnapshots()
    return sendJson(res, 200, {
      snapshots: snapshots.map((snapshot) => ({
        id: snapshot.id,
        at: snapshot.at,
        entries: snapshot.entries.map((entry) => ({ key: entry.key, kind: entry.kind })),
      })),
    })
  }

  const rollbackMatch = /^\/snapshots\/([^/]+)\/rollback$/.exec(route)
  if (method === 'POST' && rollbackMatch) {
    await host.applier.rollback(decodeURIComponent(rollbackMatch[1]))
    return sendJson(res, 200, { ok: true })
  }

  const directionMatch = /^\/peers\/([^/]+)\/direction$/.exec(route)
  if (method === 'POST' && directionMatch) {
    const body = await readBody(req)
    const nodeId = decodeURIComponent(directionMatch[1])
    const peer = host.store.getPeer(nodeId)
    if (!peer) return sendJson(res, 404, { ok: false, error: 'unknown-peer' })
    const direction = String(body.direction ?? 'both')
    if (!['both', 'push', 'pull', 'paused'].includes(direction)) {
      return sendJson(res, 400, { ok: false, error: 'bad-direction' })
    }
    await host.store.upsertPeer({ ...peer, direction })
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && route === '/settings') {
    const body = await readBody(req)
    if (typeof body.autoApply === 'boolean') host.settings.autoApply = body.autoApply
    if (typeof body.autoInstallPlugins === 'boolean') host.settings.autoInstallPlugins = body.autoInstallPlugins
    return sendJson(res, 200, { ok: true, settings: host.settings })
  }

  return sendJson(res, 404, { ok: false, error: 'not-found' })
}
