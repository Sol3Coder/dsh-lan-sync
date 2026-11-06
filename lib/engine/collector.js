import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { detectScope } from './paths.js'
import { getEntryBlob, listEntryIds } from './patch.js'

const SKIP_NAMES = new Set(['node_modules', '.git', '.DS_Store', '.system'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Reads everything the plugin owns into addressable items. The collector never
 * writes to the profile; applying a remote item is the applier's job.
 */
export class Collector {
  /**
   * @param {{ home: string, agentsHome: string, profileDir: string,
   *           store: import('./store.js').Store, platform?: string }} options
   */
  constructor({ home, agentsHome, profileDir, store, platform = process.platform }) {
    this.home = home
    this.agentsHome = agentsHome
    this.profileDir = profileDir
    this.store = store
    this.platform = platform
  }

  /** @returns {Promise<Array<{ key: string, kind: string, scope: string, blob: unknown, mixed?: boolean }>>} */
  async collect() {
    /** @type {Array<any>} */
    const items = []
    items.push(...(await this.collectConfig()))
    items.push(...(await this.collectManifest()))
    items.push(...(await this.collectSkills()))
    return items
  }

  async readPatchText() {
    try {
      return await readFile(path.join(this.profileDir, 'cordis.patch.yml'), 'utf8')
    } catch {
      return '[]\n'
    }
  }

  async collectConfig() {
    const text = await this.readPatchText()
    /** @type {Array<any>} */
    const items = []
    for (const id of listEntryIds(text)) {
      const blob = getEntryBlob(text, id)
      if (!blob) continue
      const detected = detectScope(blob)
      const mixed = detected === 'mixed'
      const scope = mixed ? 'win32' : detected
      const suffix = scope === 'any' ? '' : `@${scope}`
      items.push({ key: `config:${id}${suffix}`, kind: 'config', scope, mixed, blob })
    }
    return items
  }

  async collectManifest() {
    /** @type {Array<any>} */
    const items = []
    let manifest = null
    try {
      manifest = JSON.parse(await readFile(path.join(this.profileDir, 'package.json'), 'utf8'))
    } catch {
      manifest = null
    }
    if (manifest) {
      for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
        items.push({ key: `dep:${name}`, kind: 'dep', scope: 'any', blob: { name, spec, kind: 'prod' } })
      }
      const bundles = manifest?.dsh?.profile?.bundles
      if (Array.isArray(bundles)) {
        items.push({ key: 'bundles', kind: 'bundles', scope: 'any', blob: { list: bundles } })
      }
    }

    const workspaceFile = path.join(this.profileDir, 'pnpm-workspace.yaml')
    try {
      const raw = await readFile(workspaceFile, 'utf8')
      const data = parseYaml(raw) ?? {}
      items.push({
        key: 'profile-file:pnpm-workspace.yaml',
        kind: 'profile-file',
        scope: 'any',
        blob: { path: 'pnpm-workspace.yaml', data },
      })
    } catch {
      /* no workspace file */
    }
    return items
  }

  async collectSkills() {
    /** @type {Array<any>} */
    const items = []
    const roots = /** @type {const} */ ([
      ['dsh-home', path.join(this.home, 'skills')],
      ['agents-home', path.join(this.agentsHome, 'skills')],
    ])
    for (const [rootName, rootDir] of roots) {
      let entries
      try {
        entries = await readdir(rootDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
        const full = path.join(rootDir, entry.name)
        if (entry.isDirectory()) {
          const files = await this.walkFiles(full)
          if (!Object.keys(files.files).includes('SKILL.md')) continue
          const name = entry.name
          items.push({
            key: `skill:${rootName}:${name}`,
            kind: 'skill',
            scope: 'any',
            blob: { name, root: rootName, flat: false, ...files },
          })
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (entry.name.toLowerCase() === 'readme.md') continue
          const name = entry.name.replace(/\.md$/i, '')
          const buffer = await readFile(full)
          if (buffer.length > MAX_FILE_BYTES) continue
          const hash = await this.store.putRawBlob(buffer)
          items.push({
            key: `skill:${rootName}:${name}`,
            kind: 'skill',
            scope: 'any',
            blob: { name, root: rootName, flat: true, files: { [entry.name]: hash }, modes: {} },
          })
        }
      }
    }
    return items
  }

  async walkFiles(dir, prefix = '') {
    /** @type {Record<string,string>} */
    const files = {}
    /** @type {Record<string,string>} */
    const modes = {}
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_NAMES.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        const nested = await this.walkFiles(full, relative)
        Object.assign(files, nested.files)
        Object.assign(modes, nested.modes)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      if (info.size > MAX_FILE_BYTES) continue
      const buffer = await readFile(full)
      files[relative] = await this.store.putRawBlob(buffer)
      modes[relative] = this.platform === 'win32' ? '0644' : `0${(info.mode & 0o777).toString(8)}`
    }
    return { files, modes }
  }
}
