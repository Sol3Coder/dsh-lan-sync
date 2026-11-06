import { readFileSync } from 'node:fs'
import { fetchManifest } from '/home/administrator/.dsh/plugins/dsh-lan-sync/lib/engine/peer-client.js'

const dir = `${process.env.HOME}/.dsh/lan-sync/web`
const { peers } = JSON.parse(readFileSync(`${dir}/peers.json`, 'utf8'))
for (const peer of Object.values(peers)) {
  console.log('peer', peer.nodeId, peer.baseUrl, 'secret', peer.secret.slice(0, 6))
  try {
    const manifest = await fetchManifest({ baseUrl: peer.baseUrl, secret: peer.secret, nodeId: 'n_a5072bd880cc' })
    console.log('manifest items:', manifest.items.length)
    console.log('keys:', manifest.items.map((item) => item.key).join(', '))
  } catch (error) {
    console.log('fetch failed:', String(error?.message ?? error))
  }
}
