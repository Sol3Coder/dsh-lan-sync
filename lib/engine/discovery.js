import dgram from 'node:dgram'
import os from 'node:os'

function broadcastAddresses() {
  /** @type {Set<string>} */
  const addresses = new Set(['255.255.255.255'])
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      const ip = entry.address.split('.').map(Number)
      const mask = entry.netmask.split('.').map(Number)
      const broadcast = ip.map((part, index) => (part & mask[index]) | (~mask[index] & 255))
      if (broadcast.some((part) => Number.isNaN(part))) continue
      addresses.add(broadcast.join('.'))
    }
  }
  return [...addresses]
}

/**
 * UDP announcement service. The payload carries a group tag, never the group id
 * itself, so only same-group instances recognise each other.
 */
export class Discovery {
  /**
   * @param {{ nodeId: string, name: string, platform: string, profile: string,
   *           dshVersion: string, port: number, udpPort: number, groupTag: string,
   *           onAnnounce: (peer: any) => void, log?: any }} options
   */
  constructor(options) {
    this.options = options
    this.socket = null
    this.timer = null
  }

  message() {
    return {
      v: 1,
      nodeId: this.options.nodeId,
      name: this.options.name,
      platform: this.options.platform,
      profile: this.options.profile,
      dshVersion: this.options.dshVersion,
      port: this.options.port,
      groupTag: this.options.groupTag,
      ts: Date.now(),
    }
  }

  async start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket.on('message', (buffer, rinfo) => this.handle(buffer, rinfo))
    this.socket.on('error', (error) => this.options.log?.warn?.('discovery', String(error?.message ?? error)))
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject)
      this.socket.bind(this.options.udpPort, () => resolve())
    })
    this.broadcast()
    this.timer = setInterval(() => this.broadcast(), 10_000)
    this.timer.unref?.()
  }

  broadcast() {
    if (!this.socket) return
    const payload = Buffer.from(JSON.stringify(this.message()))
    for (const address of broadcastAddresses()) {
      this.socket.send(payload, 0, payload.length, this.options.udpPort, address, () => {})
    }
  }

  /** Unicast helper (also used by tests and the same-host probe). */
  announceTo(address) {
    if (!this.socket) return
    const payload = Buffer.from(JSON.stringify(this.message()))
    this.socket.send(payload, 0, payload.length, this.options.udpPort, address, () => {})
  }

  handle(buffer, rinfo) {
    let message
    try {
      message = JSON.parse(buffer.toString('utf8'))
    } catch {
      return
    }
    if (!message || message.v !== 1) return
    if (message.nodeId === this.options.nodeId) return
    if (message.groupTag !== this.options.groupTag) return
    if (message.profile !== this.options.profile) return
    this.options.onAnnounce?.({ ...message, address: rinfo.address })
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.socket) {
      await new Promise((resolve) => this.socket.close(resolve))
      this.socket = null
    }
  }
}

export { broadcastAddresses }
