import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson, hashBlob, sha256 } from '../../lib/engine/hash.js'
import { applyEol, detectEol, isBinary, normalizeEol } from '../../lib/engine/eol.js'
import { isPortablePath, isPortableSegment } from '../../lib/engine/safe-name.js'

test('canonical json ignores object key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(hashBlob({ x: 1, y: [1, 2] }), hashBlob({ y: [1, 2], x: 1 }))
})

test('different values hash differently', () => {
  assert.notEqual(hashBlob({ x: 1 }), hashBlob({ x: 2 }))
  assert.equal(sha256('abc').length, 64)
})

test('eol normalisation and restoration', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n')
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n')
  assert.equal(detectEol('a\nb\n'), '\n')
  assert.equal(applyEol('a\nb\n', '\r\n'), 'a\r\nb\r\n')
})

test('binary detection uses NUL bytes', () => {
  assert.equal(isBinary(Buffer.from([0x61, 0x00, 0x62])), true)
  assert.equal(isBinary(Buffer.from('plain text', 'utf8')), false)
})

test('portable file names reject windows-hostile input', () => {
  assert.equal(isPortableSegment('SKILL.md'), true)
  assert.equal(isPortableSegment('a<b.md'), false)
  assert.equal(isPortableSegment('CON'), false)
  assert.equal(isPortableSegment('aux.md'), false)
  assert.equal(isPortableSegment('trailing.'), false)
  assert.equal(isPortableSegment('trailing '), false)
})

test('portable paths validate every segment', () => {
  assert.equal(isPortablePath('skills/run.sh'), true)
  assert.equal(isPortablePath('skills/../escape'), false)
  assert.equal(isPortablePath('skills/CON.md'), false)
})
