import os from 'node:os'

/**
 * Join path parts using the separator style of the base path, so a POSIX base
 * stays POSIX even when the code runs on Windows (and vice versa).
 * @param {string} base
 * @param {...string} parts
 */
function joinFor(base, ...parts) {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const trimmed = base.replace(/[\\/]+$/, '')
  return [trimmed, ...parts].join(separator)
}

/** @param {Record<string,string|undefined>} env @param {string} homeDir */
export function resolveDshHome(env = process.env, homeDir = os.homedir()) {
  const configured = env.DSH_HOME?.trim()
  return configured ? configured.replace(/[\\/]+$/, '') : joinFor(homeDir, '.dsh')
}

/** @param {Record<string,string|undefined>} env @param {string} homeDir */
export function resolveAgentsHome(env = process.env, homeDir = os.homedir()) {
  const configured = env.DSH_AGENTS_HOME?.trim()
  return configured ? configured.replace(/[\\/]+$/, '') : joinFor(homeDir, '.agents')
}

/** @param {{ home: string, profile: string }} options */
export function stateDir({ home, profile }) {
  return joinFor(home, 'lan-sync', profile)
}

/** @param {string} value */
export function toPosix(value) {
  return value.replace(/\\/g, '/')
}

/**
 * Translate an absolute path between a Windows drive layout and the WSL
 * `/mnt/<drive>` layout. Anything that does not fit either shape is returned
 * unchanged with `ok: false`.
 * @param {string} value
 * @param {{ to: 'win32'|'linux' }} options
 * @returns {{ value: string, ok: boolean }}
 */
export function translatePath(value, { to }) {
  const text = String(value ?? '')
  if (text.startsWith('~/')) return { value: text, ok: true }

  if (to === 'linux') {
    const drive = /^([A-Za-z]):[\\/](.*)$/.exec(text)
    if (drive) {
      const rest = drive[2].replace(/\\/g, '/')
      return { value: `/mnt/${drive[1].toLowerCase()}/${rest}`, ok: true }
    }
    return { value: text, ok: false }
  }

  const mount = /^\/mnt\/([a-z])\/(.*)$/i.exec(text)
  if (mount) {
    const rest = mount[2].replace(/\//g, '\\')
    return { value: `${mount[1].toUpperCase()}:\\${rest}`, ok: true }
  }
  return { value: text, ok: false }
}

const WINDOWS_RE = /[A-Za-z]:[\\/]|\\\\|\.(?:exe|dll|cmd|bat)\b/i
const MOUNT_RE = /\/mnt\/[a-z]\//i
const POSIX_ROOT_RE = /(?:^|["'\s:=,[])\/(?:home|usr|opt|etc|var|srv|root)\//i
const SHELL_RE = /\.sh\b/i

/**
 * Classify a blob by the platform-specific paths it contains.
 * @param {unknown} value
 * @returns {'any'|'win32'|'linux'|'mixed'}
 */
export function detectScope(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  const windows = WINDOWS_RE.test(text)
  const linux = MOUNT_RE.test(text) || POSIX_ROOT_RE.test(text) || SHELL_RE.test(text)
  if (windows && linux) return 'mixed'
  if (windows) return 'win32'
  if (linux) return 'linux'
  return 'any'
}

/**
 * Expand `{{VAR}}` placeholders, leaving unknown names untouched.
 * @param {string} text
 * @param {Record<string,string>} vars
 */
export function expandVars(text, vars) {
  return String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name) => vars[name] ?? match)
}
