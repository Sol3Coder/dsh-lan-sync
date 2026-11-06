#!/usr/bin/env bash
# Remove E2E leftovers on the WSL side while keeping the plugin installed.
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

rm -rf "$HOME/.dsh/lan-sync"
rm -rf "$HOME/.dsh/skills/lan-sync-e2e"

echo '--- residual state ---'
ls "$HOME/.dsh/lan-sync" 2>/dev/null || echo 'no lan-sync state'
ls "$HOME/.dsh/skills" 2>/dev/null
echo '--- profile bundle ---'
node -e "const m=require(process.env.HOME+'/.dsh/profiles/web/package.json');console.log(JSON.stringify(m.dsh.profile.bundles))"
