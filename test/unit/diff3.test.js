import test from 'node:test'
import assert from 'node:assert/strict'
import { diffLines, mergeText } from '../../lib/engine/diff3.js'

test('one-sided change wins outright', () => {
  const base = 'a\nb\nc\n'
  assert.equal(mergeText(base, 'a\nB\nc\n', base).text, 'a\nB\nc\n')
  assert.equal(mergeText(base, base, 'a\nb\nC\n').text, 'a\nb\nC\n')
  assert.equal(mergeText(base, 'a\nB\nc\n', base).clean, true)
})

test('disjoint edits on both sides merge cleanly', () => {
  const result = mergeText('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')
  assert.equal(result.clean, true)
  assert.equal(result.text, 'A\nb\nc\nD\n')
})

test('the same edit on both sides is not a conflict', () => {
  const result = mergeText('a\nb\n', 'a\nX\n', 'a\nX\n')
  assert.equal(result.clean, true)
  assert.equal(result.text, 'a\nX\n')
})

test('competing edits on the same line conflict', () => {
  const result = mergeText('a\nb\n', 'a\nOURS\n', 'a\nTHEIRS\n')
  assert.equal(result.clean, false)
  assert.match(result.text, /<<<<<<< ours\nOURS\n=======\nTHEIRS\n>>>>>>> theirs/)
})

test('insertions at the same position with different content conflict', () => {
  const result = mergeText('a\nb\n', 'a\nINS-OURS\nb\n', 'a\nINS-THEIRS\nb\n')
  assert.equal(result.clean, false)
})

test('deletion on one side and untouched on the other applies the deletion', () => {
  const result = mergeText('a\nb\nc\n', 'a\nc\n', 'a\nb\nc\n')
  assert.equal(result.clean, true)
  assert.equal(result.text, 'a\nc\n')
})

test('deletion against modification conflicts', () => {
  const result = mergeText('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')
  assert.equal(result.clean, false)
})

test('absent base treats any two-sided difference as a conflict', () => {
  const result = mergeText(null, 'ours\n', 'theirs\n')
  assert.equal(result.clean, false)
})

test('identical files never produce conflict markers', () => {
  const result = mergeText('x\n', 'x\n', 'x\n')
  assert.equal(result.clean, true)
  assert.equal(result.text, 'x\n')
})

test('diffLines reports changed base ranges', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'B', 'c']), [{ start: 1, end: 2, lines: ['B'] }])
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']), [])
  assert.deepEqual(diffLines([], ['x']), [{ start: 0, end: 0, lines: ['x'] }])
})
