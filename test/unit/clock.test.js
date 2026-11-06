import test from 'node:test'
import assert from 'node:assert/strict'
import { bump, compare, merge } from '../../lib/engine/clock.js'

test('identical clocks compare equal', () => {
  assert.equal(compare({ a: 2, b: 1 }, { a: 2, b: 1 }), 'equal')
  assert.equal(compare({}, {}), 'equal')
})

test('a strictly larger counter makes the clock ahead', () => {
  assert.equal(compare({ a: 3 }, { a: 2 }), 'ahead')
  assert.equal(compare({ a: 3, b: 2 }, { a: 3, b: 1 }), 'ahead')
})

test('a strictly smaller counter makes the clock behind', () => {
  assert.equal(compare({ a: 1 }, { a: 2 }), 'behind')
  assert.equal(compare({}, { n: 1 }), 'behind')
})

test('disjoint or crossing counters are concurrent', () => {
  assert.equal(compare({ a: 2 }, { b: 2 }), 'concurrent')
  assert.equal(compare({ a: 3, b: 1 }, { a: 1, b: 3 }), 'concurrent')
})

test('merge keeps the maximum counter of every node', () => {
  assert.deepEqual(merge({ a: 2, b: 5 }, { a: 4, c: 1 }), { a: 4, b: 5, c: 1 })
  assert.deepEqual(merge({}, { a: 1 }), { a: 1 })
})

test('bump increments only the local node and copies the rest', () => {
  assert.deepEqual(bump({ a: 2, b: 1 }, 'b'), { a: 2, b: 2 })
  assert.deepEqual(bump({}, 'n1'), { n1: 1 })
})
