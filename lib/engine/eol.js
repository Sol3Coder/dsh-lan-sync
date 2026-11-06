/** Line-ending helpers: hash and merge on LF, restore the file's own style. */

/** @param {string} text */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n')
}

/** @param {string} text @returns {'\r\n'|'\n'} */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** @param {string} text @param {'\r\n'|'\n'} eol */
export function applyEol(text, eol) {
  const normalized = normalizeEol(text)
  return eol === '\n' ? normalized : normalized.replace(/\n/g, eol)
}

/** @param {Buffer} buffer */
export function isBinary(buffer) {
  return buffer.includes(0)
}
