import test from 'node:test'
import assert from 'node:assert/strict'
import { localAddresses, peerBaseUrls } from '../../lib/host.js'

test('advertised addresses come first and loopback stays last', () => {
  const urls = peerBaseUrls({ addresses: ['192.168.1.5', '172.20.0.1'], address: '127.0.0.1', port: 56701 })
  assert.equal(urls[0], 'http://192.168.1.5:56701')
  assert.ok(urls.includes('http://172.20.0.1:56701'))
  assert.equal(urls.at(-1), 'http://127.0.0.1:56701')
})

test('loopback advertisements are skipped and duplicates removed', () => {
  const urls = peerBaseUrls({ addresses: ['127.0.0.1', '10.0.0.7', '10.0.0.7'], address: '10.0.0.7', port: 56702 })
  assert.deepEqual(urls, ['http://10.0.0.7:56702'])
})

test('a peer without a port yields no urls', () => {
  assert.deepEqual(peerBaseUrls({ addresses: ['10.0.0.7'], address: '10.0.0.8' }), [])
})

test('local addresses are ipv4 and never loopback', () => {
  for (const address of localAddresses()) {
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/)
    assert.equal(address.startsWith('127.'), false)
  }
})
