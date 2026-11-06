#!/usr/bin/env bash
# Install dsh-lan-sync into the current WSL user's DSH profile.
# Idempotent: copies the source tree, links it into the profile, sets the shared
# test group and gives this side a distinct peer port (56702) so Windows and WSL
# can both listen without a port clash.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"

SRC="/mnt/f/desktop/ds零碎任务/dsh-lan-sync"
DEST="$HOME/.dsh/plugins/dsh-lan-sync"
PROFILE="$HOME/.dsh/profiles/web"

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -r "$SRC" "$DEST"
rm -rf "$DEST/test" "$DEST"/*.tgz "$DEST/.git"

node - "$PROFILE/package.json" "$DEST" <<'NODE'
const fs = require('fs')
const [file, dest] = process.argv.slice(2)
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies['dsh-lan-sync'] = `file:${dest}`
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []
if (!manifest.dsh.profile.bundles.includes('dsh-lan-sync')) manifest.dsh.profile.bundles.push('dsh-lan-sync')
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
NODE

mkdir -p "$HOME/.dsh/lan-sync/web"
printf '{"id":"dsh-lan-sync-e2e","createdAt":"2026-11-06T04:00:00.000Z"}\n' > "$HOME/.dsh/lan-sync/web/group.json"

if ! grep -q 'id: lan-sync' "$PROFILE/cordis.patch.yml"; then
  cat >> "$PROFILE/cordis.patch.yml" <<'EOF'

- id: lan-sync
  name: dsh-lan-sync
  config:
    tcpPort: 56702
    udpPort: 56702
    discovery: false
EOF
fi

cd "$PROFILE"
pnpm install --reporter=append-only
echo "wsl setup done: $(node -p "require('./package.json').dependencies['dsh-lan-sync']")"
