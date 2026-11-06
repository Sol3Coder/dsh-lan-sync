/**
 * Headless smoke test for lib/client.js: evaluates the bundle with a stub
 * module loader and checks that apply() registers the settings entry without
 * throwing. Not a browser test — it only proves the registration path.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let factory
const loadedIds = []
const window = { __ModuleLoader__: { load: (registration) => { loadedIds.push(registration.id); factory = registration.factory } } }
const element = () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {}, classList: { add() {}, remove() {} }, addEventListener() {} })
const document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: element,
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}

const React = {
  createElement: (...args) => ({ args }),
  Fragment: 'fragment',
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: () => ({}),
}
const primitives = new Proxy({}, { get: () => () => null })

const sandbox = {
  window,
  document,
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' }),
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  URL,
  Promise,
  Date,
  JSON,
  Map,
  Set,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  Error,
  RegExp,
  parseInt,
  parseFloat,
  isNaN,
  encodeURIComponent,
  decodeURIComponent,
  AbortController,
}
sandbox.globalThis = sandbox

vm.runInNewContext(code, sandbox, { filename: 'client.js' })
if (!factory) throw new Error('bundle did not register a factory')
console.log('loaded ids:', loadedIds)

const requireStub = (id) => {
  if (id === 'react') return React
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require: ${id}`)
}

const exportsObject = factory(requireStub)
if (!exportsObject || typeof exportsObject.apply !== 'function') throw new Error('missing apply')

const registrations = []
const injected = []
const ctx = {
  effect: (fn) => fn(),
  get: () => undefined,
  layout: { selectPanel() {} },
  locale: { register() {} },
  slots: {
    register: (definition) => {
      registrations.push(definition)
      return () => {}
    },
    inject: (name, callback) => {
      injected.push(name)
      callback()
    },
  },
}
exportsObject.apply(ctx)

console.log('inject:', exportsObject.inject)
console.log('slots.inject calls:', injected)
console.log('registrations:', registrations.map((definition) => definition.name))
if (!registrations.some((definition) => definition.name === 'settings.section' || definition.name === 'plugins.item')) {
  throw new Error('no settings entry registered')
}
console.log('client bundle smoke test OK')
