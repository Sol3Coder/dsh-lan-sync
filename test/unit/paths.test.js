import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectScope,
  expandVars,
  resolveAgentsHome,
  resolveDshHome,
  stateDir,
  toPosix,
  translatePath,
} from '../../lib/engine/paths.js'

test('windows drive paths translate to wsl mounts and back', () => {
  assert.deepEqual(translatePath('F:\\desktop\\x', { to: 'linux' }), { value: '/mnt/f/desktop/x', ok: true })
  assert.deepEqual(translatePath('C:\\Users\\Administrator\\.dsh', { to: 'linux' }), {
    value: '/mnt/c/Users/Administrator/.dsh',
    ok: true,
  })
  assert.deepEqual(translatePath('/mnt/f/desktop/x', { to: 'win32' }), { value: 'F:\\desktop\\x', ok: true })
})

test('untranslatable paths are reported, not mangled', () => {
  assert.deepEqual(translatePath('D:\\Program Files\\x', { to: 'linux' }), {
    value: '/mnt/d/Program Files/x',
    ok: true,
  })
  assert.deepEqual(translatePath('/opt/tool/bin', { to: 'win32' }), { value: '/opt/tool/bin', ok: false })
  assert.deepEqual(translatePath('relative/path', { to: 'linux' }), { value: 'relative/path', ok: false })
})

test('path scope detection separates platform-specific values', () => {
  assert.equal(detectScope({ command: 'node' }), 'any')
  assert.equal(detectScope({ command: 'C:\\Program Files\\nodejs\\node.exe' }), 'win32')
  assert.equal(detectScope({ command: '/usr/bin/node' }), 'linux')
  assert.equal(detectScope({ a: 'C:\\x', b: '/home/u/y' }), 'mixed')
  assert.equal(detectScope({ script: 'run.sh' }), 'linux')
})

test('path variables expand and stay intact when unknown', () => {
  const vars = { DSH_HOME: 'C:\\Users\\u\\.dsh', USER_HOME: 'C:\\Users\\u', AGENTS_HOME: 'C:\\Users\\u\\.agents' }
  assert.equal(expandVars('{{DSH_HOME}}\\skills', vars), 'C:\\Users\\u\\.dsh\\skills')
  assert.equal(expandVars('{{USER_HOME}}/work', vars), 'C:\\Users\\u/work')
  assert.equal(expandVars('{{UNKNOWN}}/x', vars), '{{UNKNOWN}}/x')
})

test('homes resolve from environment with dsh defaults', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'D:\\dsh' }, 'C:\\Users\\u'), 'D:\\dsh')
  assert.equal(resolveDshHome({}, 'C:\\Users\\u'), 'C:\\Users\\u\\.dsh')
  assert.equal(resolveAgentsHome({ DSH_AGENTS_HOME: 'D:\\agents' }, 'C:\\Users\\u'), 'D:\\agents')
  assert.equal(resolveAgentsHome({}, '/home/u'), '/home/u/.agents')
})

test('state directory is profile scoped', () => {
  assert.equal(toPosix(stateDir({ home: 'C:\\Users\\u\\.dsh', profile: 'web' })), 'C:/Users/u/.dsh/lan-sync/web')
})
