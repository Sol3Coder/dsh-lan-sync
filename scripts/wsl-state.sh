#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
node - "$HOME/.dsh/lan-sync/web" <<'NODE'
const fs = require('fs')
const dir = process.argv[2]
const state = JSON.parse(fs.readFileSync(`${dir}/state.json`, 'utf8'))
const keys = Object.keys(state.items)
console.log('items:', keys.length)
console.log('lan/skill keys:')
for (const key of keys.filter((k) => k.includes('skill') || k.includes('lan-sync'))) {
  const item = state.items[key]
  console.log(`  ${key} hash=${item.hash?.slice(0, 18)} clock=${JSON.stringify(item.clock)} bases=${JSON.stringify(item.bases)} deleted=${item.deleted}`)
}
const conflicts = JSON.parse(fs.readFileSync(`${dir}/conflicts.json`, 'utf8'))
console.log('conflicts:', conflicts.conflicts.length, conflicts.conflicts.map((c) => c.key).join(', '))
NODE
