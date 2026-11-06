import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveGroupKey, groupTag, signHeader, verifyHeader } from '../../lib/engine/crypto.js'

const body = Buffer.from(JSON.stringify({ hello: 'world' }))

test('group keys are deterministic and tags are short hashes', () => {
  const a = deriveGroupKey('lab-2026')
  assert.equal(a, deriveGroupKey('lab-2026'))
  assert.notEqual(a, deriveGroupKey('lab-2027'))
  assert.equal(groupTag(a).length, 16)
  assert.match(groupTag(a), /^[0-9a-f]{16}$/)
})

test('signed requests verify and tampering is rejected', () => {
  const secret = deriveGroupKey('secret')
  const header = signHeader({ secret, nodeId: 'n1', method: 'POST', path: '/v1/x', body, timestamp: 1000, nonce: 'abc' })
  const cache = new Set()
  assert.equal(
    verifyHeader({ secret, method: 'POST', path: '/v1/x', body, header, now: 1000, nonceCache: cache }),
    true,
  )
  assert.equal(
    verifyHeader({ secret, method: 'POST', path: '/v1/x', body: Buffer.from('{}'), header, now: 1000, nonceCache: new Set() }),
    false,
  )
  assert.equal(
    verifyHeader({ secret, method: 'GET', path: '/v1/x', body, header, now: 1000, nonceCache: new Set() }),
    false,
  )
})

test('expired timestamps and replayed nonces fail', () => {
  const secret = deriveGroupKey('secret')
  const header = signHeader({ secret, nodeId: 'n1', method: 'GET', path: '/v1/x', body: Buffer.alloc(0), timestamp: 1000, nonce: 'n1' })
  assert.equal(
    verifyHeader({ secret, method: 'GET', path: '/v1/x', body: Buffer.alloc(0), header, now: 400_000, nonceCache: new Set() }),
    false,
  )
  const cache = new Set()
  assert.equal(verifyHeader({ secret, method: 'GET', path: '/v1/x', body: Buffer.alloc(0), header, now: 1000, nonceCache: cache }), true)
  assert.equal(verifyHeader({ secret, method: 'GET', path: '/v1/x', body: Buffer.alloc(0), header, now: 1000, nonceCache: cache }), false)
})
