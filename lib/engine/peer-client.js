import { randomBytes } from 'node:crypto'
import { groupTag, hmacHex, signHeader } from './crypto.js'

const trim = (url) => String(url).replace(/\/+$/, '')

/** @param {string} baseUrl */
export async function fetchInfo(baseUrl) {
  const response = await fetch(`${trim(baseUrl)}/v1/info`)
  if (!response.ok) throw new Error(`info failed: ${response.status}`)
  return response.json()
}

/**
 * Complete the 2-round group handshake and return the per-peer secret.
 * @param {{ baseUrl: string, groupKey: string, self: { nodeId: string, name: string, platform: string, dshVersion?: string } }} options
 */
export async function joinPeer({ baseUrl, groupKey, self }) {
  const base = trim(baseUrl)
  const nonceA = randomBytes(16).toString('hex')
  let response
  try {
    response = await fetch(`${base}/v1/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, groupTag: groupTag(groupKey), ...self, nonceA }),
    })
  } catch (error) {
    return { ok: false, error: 'unreachable', detail: String(error?.message ?? error) }
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.ok) return { ok: false, error: body.error ?? `http-${response.status}` }

  const expected = hmacHex(groupKey, `join|${nonceA}|${body.nonceB}|${body.node.nodeId}|${self.nodeId}`)
  if (expected !== body.proof) return { ok: false, error: 'bad-server-proof' }

  const proof = hmacHex(groupKey, `confirm|${body.nonceB}|${nonceA}|${self.nodeId}|${body.node.nodeId}`)
  const confirmResponse = await fetch(`${base}/v1/join/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId: self.nodeId, nonceA, nonceB: body.nonceB, proof }),
  })
  const confirm = await confirmResponse.json().catch(() => ({}))
  if (!confirmResponse.ok || !confirm.ok) return { ok: false, error: confirm.error ?? `http-${confirmResponse.status}` }

  return { ok: true, secret: confirm.secret, peer: body.node, baseUrl: base }
}

async function signedFetch({ baseUrl, secret, nodeId, method = 'GET', path, body }) {
  const buffer = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const header = signHeader({ secret, nodeId, method, path, body: buffer })
  const headers = { 'x-lan-sync': header }
  if (body !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${trim(baseUrl)}${path}`, { method, headers, body: body === undefined ? undefined : buffer })
}

/** @param {{ baseUrl: string, secret: string, nodeId: string }} options */
export async function fetchManifest({ baseUrl, secret, nodeId }) {
  const response = await signedFetch({ baseUrl, secret, nodeId, path: '/v1/manifest' })
  if (!response.ok) throw new Error(`manifest failed: ${response.status}`)
  return response.json()
}

/** @param {{ baseUrl: string, secret: string, nodeId: string, hash: string }} options */
export async function fetchBlob({ baseUrl, secret, nodeId, hash }) {
  const response = await signedFetch({ baseUrl, secret, nodeId, path: `/v1/blob/${encodeURIComponent(hash)}` })
  if (!response.ok) throw new Error(`blob failed: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** @param {{ baseUrl: string, secret: string, nodeId: string, items: string[] }} options */
export async function notifyPeer({ baseUrl, secret, nodeId, items }) {
  const response = await signedFetch({ baseUrl, secret, nodeId, method: 'POST', path: '/v1/notify', body: { items } })
  if (!response.ok) throw new Error(`notify failed: ${response.status}`)
  return response.json()
}
