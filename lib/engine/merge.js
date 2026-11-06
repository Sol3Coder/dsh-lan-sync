/**
 * Per-kind three-way merge. `base` is the last version both sides agreed on;
 * a missing base means the item was never reconciled and any two-sided
 * difference is a conflict.
 *
 * Conflict paths use dot notation (`config.env.ENGRAM_BIN`) so the UI can point
 * at the exact field.
 */
import { mergeText } from './diff3.js'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Structural equality independent of object key order. */
export function deepEqual(a, b) {
  return stable(a) === stable(b)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/**
 * @typedef {{ path: string, base?: unknown, ours?: unknown, theirs?: unknown }} MergeConflict
 */

/**
 * Merge two sides against a base.
 * @param {unknown} base
 * @param {unknown} ours
 * @param {unknown} theirs
 * @returns {{ clean: boolean, value: unknown, conflicts: MergeConflict[] }}
 */
export function mergeValue(base, ours, theirs) {
  /** @type {MergeConflict[]} */
  const conflicts = []
  const value = walk(base, ours, theirs, '', conflicts)
  return { clean: conflicts.length === 0, value, conflicts }
}

function walk(base, ours, theirs, path, conflicts) {
  if (deepEqual(ours, theirs)) return clone(ours)
  if (deepEqual(base, ours)) return clone(theirs)
  if (deepEqual(base, theirs)) return clone(ours)

  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const baseObject = isPlainObject(base) ? base : {}
    /** @type {Record<string, unknown>} */
    const out = {}
    const keys = new Set([...Object.keys(baseObject), ...Object.keys(ours), ...Object.keys(theirs)])
    for (const key of keys) {
      const keyPath = path ? `${path}.${key}` : key
      const hasOurs = Object.prototype.hasOwnProperty.call(ours, key)
      const hasTheirs = Object.prototype.hasOwnProperty.call(theirs, key)
      const hasBase = Object.prototype.hasOwnProperty.call(baseObject, key)

      if (!hasOurs && !hasTheirs) continue

      if (hasOurs && hasTheirs) {
        out[key] = walk(baseObject[key], ours[key], theirs[key], keyPath, conflicts)
        continue
      }

      if (hasOurs && !hasTheirs) {
        if (hasBase) {
          if (deepEqual(baseObject[key], ours[key])) continue // theirs deleted, ours untouched
          conflicts.push({ path: keyPath, base: baseObject[key], ours: ours[key], theirs: undefined })
          out[key] = clone(ours[key])
          continue
        }
        out[key] = clone(ours[key]) // ours added it
        continue
      }

      if (hasBase && deepEqual(baseObject[key], theirs[key])) continue // ours deleted, theirs untouched
      conflicts.push({ path: keyPath, base: baseObject[key], ours: undefined, theirs: theirs[key] })
      out[key] = clone(theirs[key])
    }
    return out
  }

  conflicts.push({ path: path || '.', base, ours, theirs })
  return clone(ours)
}

function bundleAdditions(base, list) {
  const baseSet = new Set(base)
  /** @type {Map<number, string[]>} */
  const byAnchor = new Map()
  let anchor = 0
  for (const name of list) {
    if (baseSet.has(name)) {
      anchor = base.indexOf(name) + 1
      continue
    }
    if (!byAnchor.has(anchor)) byAnchor.set(anchor, [])
    const bucket = byAnchor.get(anchor)
    if (!bucket.includes(name)) bucket.push(name)
  }
  return byAnchor
}

function bundleDeletions(base, list) {
  const present = new Set(list)
  return new Set(base.filter((name) => !present.has(name)))
}

/**
 * Ordered-list merge for bundle selection: additions from both sides are kept
 * (ours first at the same anchor), deletions apply, reordering is refused
 * before this point.
 */
function mergeBundleList(base, ours, theirs) {
  const deletions = new Set([...bundleDeletions(base, ours), ...bundleDeletions(base, theirs)])
  const additions = bundleAdditions(base, ours)
  for (const [anchor, names] of bundleAdditions(base, theirs)) {
    if (!additions.has(anchor)) additions.set(anchor, [])
    for (const name of names) {
      if (!additions.get(anchor).includes(name)) additions.get(anchor).push(name)
    }
  }

  /** @type {string[]} */
  const out = []
  for (let index = 0; index <= base.length; index += 1) {
    out.push(...(additions.get(index) ?? []))
    if (index < base.length && !deletions.has(base[index])) out.push(base[index])
  }
  return out
}

function isOrderPreserving(base, list) {
  const baseSet = new Set(base)
  const listSet = new Set(list)
  const commonInList = list.filter((name) => baseSet.has(name))
  const commonInBase = base.filter((name) => listSet.has(name))
  return deepEqual(commonInList, commonInBase)
}

/**
 * Merge one item blob according to its kind.
 * @param {'config'|'dep'|'bundles'|'profile-file'|'skill'} kind
 * @param {any} base
 * @param {any} ours
 * @param {any} theirs
 * @returns {{ clean: boolean, value: any, conflicts: MergeConflict[] }}
 */
export function mergeBlob(kind, base, ours, theirs) {
  if (kind === 'bundles') {
    const baseList = Array.isArray(base?.list) ? base.list : []
    const oursList = Array.isArray(ours?.list) ? ours.list : []
    const theirsList = Array.isArray(theirs?.list) ? theirs.list : []
    if (deepEqual(oursList, theirsList)) return { clean: true, value: { list: oursList }, conflicts: [] }
    if (deepEqual(baseList, oursList)) return { clean: true, value: { list: theirsList }, conflicts: [] }
    if (deepEqual(baseList, theirsList)) return { clean: true, value: { list: oursList }, conflicts: [] }
    const reordered = !isOrderPreserving(baseList, oursList) || !isOrderPreserving(baseList, theirsList)
    if (reordered) {
      return {
        clean: false,
        value: { list: oursList },
        conflicts: [{ path: 'list', base: baseList, ours: oursList, theirs: theirsList }],
      }
    }
    return { clean: true, value: { list: mergeBundleList(baseList, oursList, theirsList) }, conflicts: [] }
  }
  return mergeValue(base, ours, theirs)
}
