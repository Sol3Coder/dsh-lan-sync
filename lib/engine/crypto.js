import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const WINDOW_MS = 300_000

/** @param {string} groupId @returns {string} 32-byte key as hex */
export function deriveGroupKey(groupId) {
  return scryptSync(String(groupId), 'dsh-lan-sync/v1', 32).toString('hex')
}

/** @param {string} groupKey @returns {string} 16 hex chars, safe to broadcast */
export function groupTag(groupKey) {
  return createHash('sha256').update(groupKey).digest('hex').slice(0, 16)
}

/** @param {string} secret @param {string} text @returns {string} */
export function hmacHex(secret, text) {
  return createHmac('sha256', secret).update(text).digest('hex')
}

/** @param {string} value @returns {string} */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(method, path, timestamp, nonce, body) {
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`
}

/**
 * @param {{ secret: string, nodeId: string, method: string, path: string,
 *           body?: Buffer|string, timestamp?: number, nonce?: string }} options
 */
export function signHeader({ secret, nodeId, method, path, body = '', timestamp = Date.now(), nonce = randomBytes(8).toString('hex') }) {
  const signature = hmacHex(secret, canonical(method, path, timestamp, nonce, body))
  return `LanSync ${nodeId}:${timestamp}:${nonce}:${signature}`
}

/** @param {string} header */
export function parseHeader(header) {
  const match = /^LanSync ([^:\s]+):(\d+):([^:\s]+):([0-9a-f]{64})$/.exec(String(header ?? ''))
  if (!match) return null
  return { nodeId: match[1], timestamp: Number(match[2]), nonce: match[3], signature: match[4] }
}

/**
 * Verify a request signature. Adds the nonce to `nonceCache` only on success.
 * @param {{ secret: string, method: string, path: string, body?: Buffer|string,
 *           header?: string, now?: number, nonceCache: Set<string> }} options
 */
export function verifyHeader({ secret, method, path, body = '', header, now = Date.now(), nonceCache, windowMs = WINDOW_MS }) {
  const parsed = parseHeader(header)
  if (!parsed) return false
  if (Math.abs(now - parsed.timestamp) > windowMs) return false
  if (nonceCache.has(parsed.nonce)) return false
  const expected = hmacHex(secret, canonical(method, path, parsed.timestamp, parsed.nonce, body))
  const given = Buffer.from(parsed.signature, 'hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  if (given.length !== expectedBuffer.length) return false
  if (!timingSafeEqual(given, expectedBuffer)) return false
  nonceCache.add(parsed.nonce)
  if (nonceCache.size > 16_384) {
    const oldest = nonceCache.values().next().value
    nonceCache.delete(oldest)
  }
  return true
}

/** @returns {string} 32 random bytes, base64 */
export function newSecret() {
  return randomBytes(32).toString('base64')
}
