import { createHash } from 'node:crypto'

/**
 * Deterministic JSON: object keys sorted recursively so equal values always
 * produce the same bytes regardless of insertion order.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = []
  for (const key of keys) {
    const item = value[key]
    if (item === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * @param {string|Buffer|Uint8Array} data
 * @returns {string} lowercase hex digest
 */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Content hash for a JSON blob.
 * @param {unknown} value
 * @returns {string} `sha256:<hex>`
 */
export function hashBlob(value) {
  return `sha256:${sha256(canonicalJson(value))}`
}
