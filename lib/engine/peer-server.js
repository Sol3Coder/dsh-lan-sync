import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { groupTag, hmacHex, newSecret, parseHeader, verifyHeader } from './crypto.js'

const MAX_BODY = 8 * 1024 * 1024

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
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * Peer-facing HTTP endpoint: discovery info, group join handshake, and
 * HMAC-signed manifest/blob/notify routes. Runs on its own port, never on the
 * GUI server.
 */
export class PeerServer {
  /**
   * @param {{ nodeId: string, name: string, platform: string, profile: string,
   *           dshVersion: string, groupKey: string, joinedAt?: number,
   *           getManifest: (relay?: boolean) => Promise<any>, getBlob: (hash: string) => Promise<Buffer|null>,
   *           resolvePeer: (nodeId: string) => Promise<{ secret: string }|null>,
   *           onJoin: (peer: any) => Promise<void>, onNotify?: (payload: any, peer: any) => Promise<void>,
   *           log?: (level: string, message: string, extra?: unknown) => void }} options
   */
  constructor(options) {
    this.options = options
    this.tag = groupTag(options.groupKey)
    this.pending = new Map()
    this.nonces = new Set()
    this.server = null
  }

  async listen({ port = 56701, host = '0.0.0.0' } = {}) {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.options.log?.('error', 'request failed', error)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => resolve())
    })
    return { port: this.server.address().port, host }
  }

  async close() {
    if (!this.server) return
    // Drop keep-alive sockets first: a sync client may still hold one open and
    // server.close() alone would wait for it, blocking HMR unload.
    this.server.closeAllConnections?.()
    await new Promise((resolve) => this.server.close(resolve))
    this.server = null
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://lan-sync.local')
    const path = url.pathname

    if (req.method === 'GET' && path === '/v1/info') {
      return sendJson(res, 200, {
        v: 1,
        nodeId: this.options.nodeId,
        name: this.options.name,
        platform: this.options.platform,
        profile: this.options.profile,
        dshVersion: this.options.dshVersion,
        groupTag: this.tag,
        joinedAt: this.options.joinedAt ?? null,
      })
    }

    if (req.method === 'POST' && path === '/v1/join') {
      return this.handleJoin(req, res)
    }

    if (req.method === 'POST' && path === '/v1/join/confirm') {
      return this.handleConfirm(req, res)
    }

    // ── signed routes ──
    const header = req.headers['x-lan-sync']
    const parsed = parseHeader(Array.isArray(header) ? header[0] : header)
    if (!parsed) return sendJson(res, 401, { error: 'unauthorized' })
    const peer = await this.options.resolvePeer(parsed.nodeId)
    if (!peer) return sendJson(res, 401, { error: 'unknown-peer' })

    const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req)
    const ok = verifyHeader({
      secret: peer.secret,
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body,
      header: Array.isArray(header) ? header[0] : header,
      nonceCache: this.nonces,
    })
    if (!ok) return sendJson(res, 401, { error: 'bad-signature' })

    if (req.method === 'GET' && path === '/v1/manifest') {
      const items = await this.options.getManifest()
      return sendJson(res, 200, { v: 1, nodeId: this.options.nodeId, items })
    }

    if (req.method === 'GET' && path.startsWith('/v1/blob/')) {
      const hash = decodeURIComponent(path.slice('/v1/blob/'.length))
      const buffer = await this.options.getBlob(hash)
      if (!buffer) return sendJson(res, 404, { error: 'not-found' })
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': buffer.length,
        'cache-control': 'no-store',
      })
      return res.end(buffer)
    }

    if (req.method === 'POST' && path === '/v1/notify') {
      let payload = {}
      try {
        payload = JSON.parse(body.toString('utf8') || '{}')
      } catch {
        return sendJson(res, 400, { error: 'bad-json' })
      }
      await this.options.onNotify?.(payload, { nodeId: parsed.nodeId })
      return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'not-found' })
  }

  async handleJoin(req, res) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    if (body.groupTag !== this.tag) {
      return sendJson(res, 403, { error: 'group-mismatch' })
    }
    if (!body.nonceA || !body.nodeId) return sendJson(res, 400, { error: 'bad-request' })

    const nonceB = randomBytes(16).toString('hex')
    const proof = hmacHex(this.options.groupKey, `join|${body.nonceA}|${nonceB}|${this.options.nodeId}|${body.nodeId}`)
    this.pending.set(body.nodeId, { nonceA: body.nonceA, nonceB, at: Date.now(), info: body, proof })
    return sendJson(res, 200, {
      ok: true,
      nonceB,
      proof,
      node: {
        nodeId: this.options.nodeId,
        name: this.options.name,
        platform: this.options.platform,
        profile: this.options.profile,
        dshVersion: this.options.dshVersion,
      },
    })
  }

  async handleConfirm(req, res) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
    const pending = this.pending.get(body.nodeId)
    if (!pending || pending.nonceB !== body.nonceB || pending.nonceA !== body.nonceA) {
      return sendJson(res, 400, { error: 'no-pending-join' })
    }
    const expected = hmacHex(
      this.options.groupKey,
      `confirm|${pending.nonceB}|${pending.nonceA}|${body.nodeId}|${this.options.nodeId}`,
    )
    if (body.proof !== expected) return sendJson(res, 403, { error: 'bad-proof' })

    this.pending.delete(body.nodeId)
    const secret = newSecret()
    const address = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const peer = {
      nodeId: body.nodeId,
      name: pending.info.name,
      platform: pending.info.platform,
      dshVersion: pending.info.dshVersion,
      port: pending.info.port,
      addresses: Array.isArray(pending.info.addresses) ? pending.info.addresses : [],
      address,
      secret,
      direction: 'both',
      joinedAt: Date.now(),
    }
    await this.options.onJoin(peer)
    return sendJson(res, 200, {
      ok: true,
      secret,
      node: { nodeId: this.options.nodeId, name: this.options.name, platform: this.options.platform },
    })
  }
}
