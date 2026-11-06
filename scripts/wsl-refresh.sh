#!/usr/bin/env bash
# Refresh the WSL copy from the Windows source tree, reset peer state and restart.
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

pkill -f 'dsh web --port 3081' 2>/dev/null || true
sleep 1

rm -rf "$HOME/.dsh/plugins/dsh-lan-sync"
cp -r "/mnt/f/desktop/ds零碎任务/dsh-lan-sync" "$HOME/.dsh/plugins/dsh-lan-sync"
rm -rf "$HOME/.dsh/plugins/dsh-lan-sync/test" "$HOME/.dsh/plugins/dsh-lan-sync"/*.tgz "$HOME/.dsh/plugins/dsh-lan-sync/.git"

rm -rf "$HOME/.dsh/profiles/web/node_modules/dsh-lan-sync"
ln -s "$HOME/.dsh/plugins/dsh-lan-sync" "$HOME/.dsh/profiles/web/node_modules/dsh-lan-sync"

rm -f "$HOME/.dsh/lan-sync/web/peers.json"

cd "$HOME"
setsid dsh web --port 3081 --no-open > /tmp/dsh-web.log 2>&1 < /dev/null &
sleep 20

echo "--- peers ---"
cat "$HOME/.dsh/lan-sync/web/peers.json" 2>/dev/null || echo 'no peers yet'
echo "--- peer port ---"
curl -s --max-time 5 http://127.0.0.1:56702/v1/info || echo 'peer not answering'
echo
