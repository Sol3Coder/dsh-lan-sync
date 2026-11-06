#!/usr/bin/env bash
# Link the copied plugin into the profile without pnpm (works offline).
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

pkill -f 'pnpm install' || true
cd "$HOME/.dsh/profiles/web"
rm -rf node_modules/dsh-lan-sync
ln -s "$HOME/.dsh/plugins/dsh-lan-sync" node_modules/dsh-lan-sync
ls -l node_modules/dsh-lan-sync
node --input-type=module -e "const m = await import('dsh-lan-sync'); console.log('loads:', typeof m.apply)"
