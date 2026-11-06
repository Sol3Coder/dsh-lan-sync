#!/usr/bin/env bash
# Start the WSL DSH web instance detached (setsid, so it survives this shell).
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

pkill -f 'dsh web --port 3081' 2>/dev/null || true
sleep 1
cd "$HOME"
setsid dsh web --port 3081 --no-open > /tmp/dsh-web.log 2>&1 < /dev/null &
sleep 12

echo "--- processes ---"
pgrep -af 'dsh web' || echo 'not running'
echo "--- log ---"
cat /tmp/dsh-web.log
echo "--- listeners ---"
(ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E '3081|56702' || echo 'no listeners'
echo "--- ui ---"
curl -s -o /dev/null -w 'ui=%{http_code}\n' --max-time 5 http://127.0.0.1:3081/ || true
echo "--- peer ---"
curl -s --max-time 5 http://127.0.0.1:56702/v1/info || echo 'peer not answering'
echo
