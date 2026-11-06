import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeBlob, mergeValue } from '../../lib/engine/merge.js'

const config = (extra = {}) => ({ id: 'mcp-x', name: 'pkg', config: { command: 'node', env: { A: '1' } }, ...extra })

test('disjoint field edits merge cleanly and keep both', () => {
  const base = config()
  const ours = config({ config: { command: 'node', env: { A: '1' }, cwd: 'C:/w' } })
  const theirs = config({ config: { command: 'node', env: { A: '2' } } })
  const result = mergeValue(base, ours, theirs)
  assert.equal(result.clean, true)
  assert.equal(result.value.config.cwd, 'C:/w')
  assert.equal(result.value.config.env.A, '2')
})

test('the same field changed differently conflicts at its path', () => {
  const base = config()
  const ours = config({ config: { command: 'node', env: { A: '1' }, cwd: 'C:/ours' } })
  const theirs = config({ config: { command: 'node', env: { A: '1' }, cwd: 'C:/theirs' } })
  const result = mergeValue(base, ours, theirs)
  assert.equal(result.clean, false)
  assert.deepEqual(result.conflicts.map((c) => c.path), ['config.cwd'])
})

test('deleting a key while the other side edits it conflicts', () => {
  const base = config()
  const ours = config({ config: { command: 'node' } })
  const theirs = config({ config: { command: 'node', env: { A: '9' } } })
  const result = mergeValue(base, ours, theirs)
  assert.equal(result.clean, false)
  assert.equal(result.conflicts[0].path, 'config.env')
})

test('deleting the same key on both sides stays deleted', () => {
  const base = config()
  const ours = config({ config: { command: 'node' } })
  const theirs = config({ config: { command: 'node' } })
  const result = mergeValue(base, ours, theirs)
  assert.equal(result.clean, true)
  assert.equal('env' in result.value.config, false)
})

test('arrays are atomic: both sides edited means conflict', () => {
  const base = { id: 'm', config: { args: ['a'] } }
  const ours = { id: 'm', config: { args: ['a', 'b'] } }
  const theirs = { id: 'm', config: { args: ['a', 'c'] } }
  const result = mergeValue(base, ours, theirs)
  assert.equal(result.clean, false)
  assert.deepEqual(result.conflicts.map((c) => c.path), ['config.args'])
})

test('one-sided edit wins without touching the other side', () => {
  const base = { id: 'm', config: { args: ['a'] } }
  const result = mergeValue(base, { id: 'm', config: { args: ['a', 'b'] } }, base)
  assert.equal(result.clean, true)
  assert.deepEqual(result.value.config.args, ['a', 'b'])
})

test('dependency specs merge when only one side moved', () => {
  const base = { name: 'p', spec: '^1.0.0', kind: 'prod' }
  const theirs = { name: 'p', spec: '^1.2.0', kind: 'prod' }
  const result = mergeBlob('dep', base, base, theirs)
  assert.equal(result.clean, true)
  assert.equal(result.value.spec, '^1.2.0')
})

test('dependency specs conflict when both moved differently', () => {
  const base = { name: 'p', spec: '^1.0.0', kind: 'prod' }
  const ours = { name: 'p', spec: '^1.1.0', kind: 'prod' }
  const theirs = { name: 'p', spec: '^1.2.0', kind: 'prod' }
  const result = mergeBlob('dep', base, ours, theirs)
  assert.equal(result.clean, false)
  assert.deepEqual(result.conflicts.map((c) => c.path), ['spec'])
})

test('bundle order merge keeps base order and appends both additions', () => {
  const base = { list: ['a', 'b'] }
  const ours = { list: ['a', 'b', 'c'] }
  const theirs = { list: ['a', 'b', 'd'] }
  const result = mergeBlob('bundles', base, ours, theirs)
  assert.equal(result.clean, true)
  assert.deepEqual(result.value.list, ['a', 'b', 'c', 'd'])
})

test('bundle order merge keeps insertions in the middle', () => {
  const base = { list: ['a', 'c'] }
  const ours = { list: ['a', 'b', 'c'] }
  const theirs = { list: ['a', 'c', 'd'] }
  const result = mergeBlob('bundles', base, ours, theirs)
  assert.equal(result.clean, true)
  assert.deepEqual(result.value.list, ['a', 'b', 'c', 'd'])
})

test('conflicting bundle orders are reported, not silently dropped', () => {
  const base = { list: ['a', 'b', 'c'] }
  const ours = { list: ['b', 'a', 'c'] }
  const theirs = { list: ['a', 'c', 'b'] }
  const result = mergeBlob('bundles', base, ours, theirs)
  assert.equal(result.clean, false)
})
