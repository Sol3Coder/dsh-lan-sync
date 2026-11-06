/**
 * File names that must survive a round trip through Windows and Linux skills.
 * Linux allows names Windows cannot represent; we refuse to sync them rather
 * than fail halfway through applying a skill.
 */

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/

/** @param {string} segment @returns {boolean} */
export function isPortableSegment(segment) {
  if (!segment || segment === '.' || segment === '..') return false
  if (ILLEGAL.test(segment)) return false
  if (/[. ]$/.test(segment)) return false
  if (RESERVED.test(segment)) return false
  return true
}

/** @param {string} relativePath @returns {boolean} */
export function isPortablePath(relativePath) {
  const segments = String(relativePath).split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return false
  return segments.every(isPortableSegment)
}
