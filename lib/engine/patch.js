import { isMap, isSeq, parseDocument } from 'yaml'

/**
 * Read/modify the profile's `cordis.patch.yml` while keeping comments, key
 * order and custom tags (`!!js`) intact. Only the fields being synced are
 * touched; everything else in the document is left as it was.
 */

function ensureSequence(doc) {
  if (!doc.contents) doc.contents = doc.createNode([])
  if (!isSeq(doc.contents)) {
    throw new Error('cordis.patch.yml 必须是顶层 YAML 数组')
  }
  return doc.contents
}

function idOf(node) {
  if (!isMap(node)) return undefined
  const id = node.get('id')
  return id === undefined || id === null ? undefined : String(id?.value ?? id)
}

function* rows(sequence) {
  for (const node of sequence.items) {
    if (!isMap(node)) continue
    const id = idOf(node)
    if (id !== undefined) {
      yield { id, node, parent: sequence }
      continue
    }
    const insert = node.get('insert')
    if (isSeq(insert)) {
      for (const child of insert.items) {
        const childId = idOf(child)
        if (childId !== undefined) yield { id: childId, node: child, parent: insert }
      }
    }
  }
}

function findRow(sequence, id) {
  for (const row of rows(sequence)) {
    if (row.id === id) return row
  }
  return undefined
}

/** @param {string} text @returns {string[]} */
export function listEntryIds(text) {
  const doc = parseDocument(text)
  const sequence = ensureSequence(doc)
  return [...rows(sequence)].map((row) => row.id)
}

/**
 * Read one row as a plain blob.
 * @param {string} text
 * @param {string} id
 * @returns {{ id: string, name?: string, config?: unknown, disabled?: unknown } | null}
 */
export function getEntryBlob(text, id) {
  const doc = parseDocument(text)
  const sequence = ensureSequence(doc)
  const row = findRow(sequence, id)
  if (!row) return null
  const blob = row.node.toJS(doc)
  return {
    id,
    ...(blob.name !== undefined ? { name: blob.name } : {}),
    ...(blob.config !== undefined ? { config: blob.config } : {}),
    ...(blob.disabled !== undefined ? { disabled: blob.disabled } : {}),
  }
}

/**
 * Insert or update one row. Fields left `undefined` are not touched, so a
 * `!!js` disabled expression survives a config-only sync.
 * @param {string} text
 * @param {{ id: string, name?: string, config?: unknown, disabled?: unknown }} blob
 * @returns {string}
 */
export function applyEntry(text, blob) {
  const doc = parseDocument(text)
  const sequence = ensureSequence(doc)
  const existing = findRow(sequence, blob.id)

  if (existing) {
    if (blob.name !== undefined) existing.node.set('name', blob.name)
    if (blob.config !== undefined) existing.node.set('config', doc.createNode(blob.config))
    if (blob.disabled !== undefined) existing.node.set('disabled', blob.disabled)
    return doc.toString()
  }

  /** @type {Record<string, unknown>} */
  const row = { id: blob.id }
  if (blob.name !== undefined) row.name = blob.name
  if (blob.config !== undefined) row.config = blob.config
  if (blob.disabled !== undefined) row.disabled = blob.disabled
  sequence.add(doc.createNode(row))
  return doc.toString()
}

/**
 * Remove one row wherever it lives.
 * @param {string} text
 * @param {string} id
 * @returns {string}
 */
export function removeEntry(text, id) {
  const doc = parseDocument(text)
  const sequence = ensureSequence(doc)
  const row = findRow(sequence, id)
  if (!row) return doc.toString()
  const index = row.parent.items.indexOf(row.node)
  if (index >= 0) row.parent.items.splice(index, 1)
  return doc.toString()
}

/**
 * Compare two patch documents by their rows, ignoring comments and ordering.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function snapshotEntries(text) {
  const doc = parseDocument(text)
  const sequence = ensureSequence(doc)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const row of rows(sequence)) {
    out[row.id] = row.node.toJS(doc)
  }
  return out
}
