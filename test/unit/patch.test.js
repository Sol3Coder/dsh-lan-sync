import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEntry, getEntryBlob, listEntryIds, removeEntry } from '../../lib/engine/patch.js'

const SAMPLE = `# profile patch header
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      deepseek:
        baseURL: https://example/v1

# keep this comment about engram
- id: mcp-engram
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    command: node
    env:
      A: '1'
  disabled: !!js "!ctx.get('profileContext')"

- insert:
    - id: extra-row
      name: some-package
`

test('lists every addressable row including insert children', () => {
  assert.deepEqual(listEntryIds(SAMPLE), ['llm-pi-ai', 'mcp-engram', 'extra-row'])
})

test('reads one row as a plain blob', () => {
  const blob = getEntryBlob(SAMPLE, 'mcp-engram')
  assert.equal(blob.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(blob.config.command, 'node')
  assert.equal(blob.config.env.A, '1')
})

test('writing a row keeps comments, js tags and unrelated rows intact', () => {
  const next = applyEntry(SAMPLE, {
    id: 'mcp-engram',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { command: 'node', env: { A: '2' } },
    disabled: undefined,
  })
  assert.match(next, /# keep this comment about engram/)
  assert.match(next, /disabled: !!js "!ctx.get\('profileContext'\)"/)
  assert.match(next, /baseURL: https:\/\/example\/v1/)
  assert.match(next, /A: ['"]?2['"]?/)
  assert.doesNotMatch(next, /A: '1'/)
})

test('a row that does not exist yet is appended', () => {
  const next = applyEntry(SAMPLE, { id: 'brand-new', name: 'new-pkg', config: { x: 1 } })
  assert.deepEqual(listEntryIds(next).sort(), ['brand-new', 'extra-row', 'llm-pi-ai', 'mcp-engram'])
  assert.equal(getEntryBlob(next, 'brand-new').config.x, 1)
  assert.match(next, /# profile patch header/)
})

test('removing a row leaves the rest parseable', () => {
  const next = removeEntry(SAMPLE, 'extra-row')
  assert.deepEqual(listEntryIds(next), ['llm-pi-ai', 'mcp-engram'])
})

test('an empty document accepts a first row', () => {
  const next = applyEntry('[]\n', { id: 'first', name: 'pkg', config: { a: true } })
  assert.deepEqual(listEntryIds(next), ['first'])
})
