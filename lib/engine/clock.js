/**
 * Vector clocks for per-item versioning.
 *
 * A clock is a plain object `{ [nodeId]: counter }`. Counters are positive
 * integers; a missing key reads as 0.
 */

/** @typedef {Record<string, number>} Clock */

function keysOf(a, b) {
  return new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
}

/**
 * Compare two clocks.
 * @param {Clock} a
 * @param {Clock} b
 * @returns {'equal'|'ahead'|'behind'|'concurrent'} `ahead` means `a` dominates `b`.
 */
export function compare(a, b) {
  let aAhead = false
  let bAhead = false
  for (const key of keysOf(a, b)) {
    const av = a?.[key] ?? 0
    const bv = b?.[key] ?? 0
    if (av > bv) aAhead = true
    else if (bv > av) bAhead = true
  }
  if (!aAhead && !bAhead) return 'equal'
  if (aAhead && !bAhead) return 'ahead'
  if (!aAhead && bAhead) return 'behind'
  return 'concurrent'
}

/**
 * Pointwise maximum of two clocks.
 * @param {Clock} a
 * @param {Clock} b
 * @returns {Clock}
 */
export function merge(a = {}, b = {}) {
  /** @type {Clock} */
  const out = {}
  for (const key of keysOf(a, b)) {
    const value = Math.max(a?.[key] ?? 0, b?.[key] ?? 0)
    if (value > 0) out[key] = value
  }
  return out
}

/**
 * Increment the local node counter.
 * @param {Clock} clock
 * @param {string} nodeId
 * @returns {Clock}
 */
export function bump(clock = {}, nodeId) {
  return { ...clock, [nodeId]: (clock?.[nodeId] ?? 0) + 1 }
}
