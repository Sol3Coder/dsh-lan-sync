#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
echo '--- procs ---'
pgrep -af 'dsh web' || echo none
echo '--- log size ---'
wc -l /tmp/dsh-web.log
echo '--- relevant lines ---'
grep -aiE 'lan-sync|join|conflict|listen|patched|reload' /tmp/dsh-web.log | tail -40
echo '--- tail ---'
tail -15 /tmp/dsh-web.log
