import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { applyEntry, removeEntry } from './patch.js'

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_')
}

async function writeAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, contents)
  await rename(temporary, file)
}

/**
 * Applies synced items to the local profile and skills roots. Every mutation is
 * snapshotted first so it can be rolled back from the UI.
 */
export class Applier {
  /**
   * @param {{ profileDir: string, home: string, agentsHome: string,
   *           store: import('./store.js').Store, platform?: string,
   *           applyDependency?: Function, applyBundles?: Function,
   *           logger?: { info: Function, warn: Function, error: Function } }} options
   */
  constructor({ profileDir, home, agentsHome, store, platform = process.platform, applyDependency, applyBundles, logger }) {
    this.profileDir = profileDir
    this.home = home
    this.agentsHome = agentsHome
    this.store = store
    this.platform = platform
    this.applyDependency = applyDependency
    this.applyBundles = applyBundles
    this.logger = logger ?? { info() {}, warn() {}, error() {} }
  }

  get patchFile() {
    return path.join(this.profileDir, 'cordis.patch.yml')
  }

  get manifestFile() {
    return path.join(this.profileDir, 'package.json')
  }

  skillPathFor(blob) {
    const root = blob.root === 'agents-home' ? path.join(this.agentsHome, 'skills') : path.join(this.home, 'skills')
    return blob.flat ? path.join(root, `${blob.name}.md`) : path.join(root, blob.name)
  }

  pathsFor(item) {
    switch (item.kind) {
      case 'config':
        return [this.patchFile]
      case 'profile-file':
        return [path.join(this.profileDir, item.blob?.path ?? 'pnpm-workspace.yaml')]
      case 'dep':
      case 'bundles':
        return [this.manifestFile]
      case 'skill':
        return item.blob ? [this.skillPathFor(item.blob)] : []
      default:
        return []
    }
  }

  async applyItem(item) {
    await this.createSnapshot([item])
    switch (item.kind) {
      case 'config':
        return this.applyConfig(item.blob)
      case 'profile-file':
        return this.applyProfileFile(item.blob)
      case 'dep':
        return this.applyDep(item.blob)
      case 'bundles':
        return this.applyBundleList(item.blob)
      case 'skill':
        return this.applySkill(item.blob)
      default:
        throw new Error(`未知条目类型 ${item.kind}`)
    }
  }

  async applyConfig(blob) {
    const text = existsSync(this.patchFile) ? await readFile(this.patchFile, 'utf8') : '[]\n'
    const next = applyEntry(text, blob)
    await writeAtomic(this.patchFile, next)
    return { file: this.patchFile }
  }

  async applyProfileFile(blob) {
    const file = path.join(this.profileDir, blob.path)
    await writeAtomic(file, stringifyYaml(blob.data ?? {}))
    return { file }
  }

  async applyDep(blob) {
    if (this.applyDependency) {
      await this.applyDependency({ name: blob.name, spec: blob.spec, kind: blob.kind ?? 'prod' })
      return { delegated: true }
    }
    const manifest = await this.readManifest()
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [blob.name]: blob.spec }
    await writeAtomic(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    this.logger.warn?.('dep', `已写入 package.json（${blob.name}@${blob.spec}），需要手动运行 pnpm install`)
    return { delegated: false }
  }

  async applyBundleList(blob) {
    const manifest = await this.readManifest()
    manifest.dsh = manifest.dsh ?? {}
    manifest.dsh.profile = manifest.dsh.profile ?? {}
    manifest.dsh.profile.bundles = blob.list
    await writeAtomic(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    if (this.applyBundles) await this.applyBundles(blob.list)
    return { list: blob.list }
  }

  async applySkill(blob) {
    const target = this.skillPathFor(blob)
    await rm(target, { recursive: true, force: true })
    if (blob.flat) {
      await mkdir(path.dirname(target), { recursive: true })
      const file = Object.keys(blob.files ?? {})[0]
      const bytes = await this.store.getRawBlob(blob.files[file])
      if (!bytes) throw new Error(`缺少技能文件 ${file}`)
      await writeFile(target, bytes)
      return { target }
    }
    await mkdir(target, { recursive: true })
    for (const [relative, hash] of Object.entries(blob.files ?? {})) {
      const file = path.join(target, relative)
      const bytes = await this.store.getRawBlob(hash)
      if (!bytes) throw new Error(`缺少技能文件 ${relative}`)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, bytes)
      const mode = blob.modes?.[relative]
      if (this.platform !== 'win32' && mode) await chmod(file, Number.parseInt(mode, 8))
    }
    return { target }
  }

  async removeItem(item) {
    await this.createSnapshot([item])
    switch (item.kind) {
      case 'config': {
        const text = existsSync(this.patchFile) ? await readFile(this.patchFile, 'utf8') : '[]\n'
        await writeAtomic(this.patchFile, removeEntry(text, item.key.replace(/^config:/, '').replace(/@(win32|linux)$/, '')))
        return { removed: true }
      }
      case 'skill': {
        const blob = item.blob ?? { name: item.key.split(':').pop(), root: item.key.includes(':agents-home:') ? 'agents-home' : 'dsh-home', flat: false }
        await rm(this.skillPathFor(blob), { recursive: true, force: true })
        return { removed: true }
      }
      case 'dep': {
        const manifest = await this.readManifest()
        const name = item.blob?.name ?? item.key.replace(/^dep:/, '')
        delete manifest.dependencies?.[name]
        await writeAtomic(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
        return { removed: true }
      }
      case 'bundles': {
        const manifest = await this.readManifest()
        if (manifest.dsh?.profile?.bundles) {
          manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => !item.blob?.list || name !== item.blob.name)
        }
        await writeAtomic(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
        return { removed: true }
      }
      default:
        return { removed: false }
    }
  }

  async readManifest() {
    try {
      return JSON.parse(await readFile(this.manifestFile, 'utf8'))
    } catch {
      return { dependencies: {}, dsh: { profile: { bundles: [] } } }
    }
  }

  // ── snapshots ────────────────────────────────────────────────────────────

  async createSnapshot(items) {
    const id = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = path.join(this.store.dir, 'snapshots', id)
    const manifestPath = path.join(dir, 'manifest.json')
    /** @type {{ id: string, at: string, entries: any[] }} */
    let manifest = { id, at: new Date().toISOString(), entries: [] }
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    }

    for (const item of items) {
      const sources = this.pathsFor(item)
      const entry = { key: item.key, kind: item.kind, files: [] }
      for (const source of sources) {
        const saved = path.join('files', sanitize(item.key), path.basename(source))
        if (existsSync(source)) {
          await cp(source, path.join(dir, saved), { recursive: true })
          entry.files.push({ source, saved })
        } else {
          entry.files.push({ source, saved: null })
        }
      }
      manifest.entries.push(entry)
    }
    await mkdir(dir, { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  }

  async listSnapshots() {
    const dir = path.join(this.store.dir, 'snapshots')
    let ids = []
    try {
      ids = (await readdir(dir)).filter((name) => !name.endsWith('.json'))
    } catch {
      return []
    }
    const snapshots = []
    for (const id of ids.sort().reverse()) {
      try {
        snapshots.push(JSON.parse(await readFile(path.join(dir, id, 'manifest.json'), 'utf8')))
      } catch {
        /* ignore broken snapshot */
      }
    }
    return snapshots
  }

  async rollback(id) {
    const dir = path.join(this.store.dir, 'snapshots', id)
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))
    for (const entry of manifest.entries) {
      for (const file of entry.files) {
        if (file.saved) {
          await rm(file.source, { recursive: true, force: true })
          await mkdir(path.dirname(file.source), { recursive: true })
          await cp(path.join(dir, file.saved), file.source, { recursive: true })
        } else {
          await rm(file.source, { recursive: true, force: true })
        }
      }
    }
    return manifest
  }
}
