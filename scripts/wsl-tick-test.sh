#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
SKILL="$HOME/.dsh/skills/i-have-adhd/SKILL.md"
cp "$SKILL" /tmp/skill.bak
echo "" >> "$SKILL"
sleep 8
cp /tmp/skill.bak "$SKILL"
node - "$HOME/.dsh/lan-sync/web/state.json" <<'NODE'
const fs = require('fs')
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const [key, item] of Object.entries(state.items)) {
  if (key.includes('skill')) console.log(key, JSON.stringify(item.clock), item.bases)
}
NODE
stat -c '%y %n' "$HOME/.dsh/lan-sync/web/state.json" "$HOME/.dsh/lan-sync/web/peers.json"
