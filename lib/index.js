import { resolveAgentsHome, resolveDshHome } from './engine/paths.js'
import { LanSyncHost } from './host.js'
import { registerRoutes } from './host-api.js'

export const name = 'dsh-lan-sync'

/** The GUI routes live on the web server; connection is probed lazily so a
 * missing service degrades to a local CSRF/Host check instead of blocking load. */
export const inject = ['webServer']

function makeLogger(ctx) {
  const write = (level) => (...args) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('lan-sync') : ctx.logger
      if (logger?.[level]) logger[level](...args)
      else if (level === 'error') console.error('[dsh-lan-sync]', ...args)
    } catch {
      /* logging must never break sync */
    }
  }
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') }
}

/**
 * @param {any} ctx cordis context
 * @param {{ profile?: string, tcpPort?: number, udpPort?: number, deviceName?: string,
 *           profileDir?: string, dshVersion?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx)
  const profileContext = ctx.get?.('profileContext')
  const profileDir = profileContext?.dir ?? config.profileDir
  if (!profileDir) {
    logger.warn('找不到 profile 目录，局域网同步未启动')
    return
  }

  const pluginManager = ctx.get?.('pluginManager')
  const host = new LanSyncHost({
    home: config.home ?? resolveDshHome(),
    agentsHome: config.agentsHome ?? resolveAgentsHome(),
    profileDir,
    profile: profileContext?.name ?? config.profile ?? 'web',
    identity: {
      dshVersion: config.dshVersion ?? '0.0.0',
      ...(config.deviceName ? { name: config.deviceName } : {}),
    },
    hooks: {
      applyDependency: pluginManager
        ? async ({ name: packageName, spec }) => {
            const specifier = `${packageName}@${spec}`
            try {
              await pluginManager.installBundle(specifier)
            } catch (error) {
              logger.warn(`插件安装失败（${specifier}）：${String(error?.message ?? error)}`)
              throw error
            }
          }
        : undefined,
    },
    logger,
  })

  ctx.effect(() => {
    host
      .start({
        tcpPort: config.tcpPort ?? 56701,
        udpPort: config.udpPort ?? 56700,
        discovery: config.discovery !== false,
      })
      .then(() => {
        logger.info(`已启动，节点 ${host.identity.nodeId}，端口 ${host.port}`)
      })
      .catch((error) => {
        // stderr is captured by DSH's own log even when ctx.logger is silent
        console.error('[dsh-lan-sync] 启动失败', error)
        logger.error('启动失败', String(error?.message ?? error))
      })
    return () => {
      host.stop().catch(() => {})
    }
  })

  ctx.effect(() => {
    const disposer = registerRoutes(ctx, host)
    return () => {
      try {
        disposer?.()
      } catch {
        /* already withdrawn */
      }
    }
  })
}
