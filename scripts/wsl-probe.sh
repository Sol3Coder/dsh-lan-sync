#!/usr/bin/env bash
# Probe WSL -> Windows connectivity and the state of the E2E skill.
GW=$(ip route | awk '/^default/{print $3; exit}')
echo "GW=$GW"
echo -n 'gw:56702 -> '
curl -s --max-time 4 "http://$GW:56702/v1/info" || echo fail
echo
echo -n 'gw:56701 -> '
curl -s --max-time 4 "http://$GW:56701/v1/info" || echo fail
echo
echo '--- skill ---'
cat "$HOME/.dsh/skills/lan-sync-e2e/SKILL.md" 2>/dev/null || echo 'NOT SYNCED'
echo '--- peers ---'
cat "$HOME/.dsh/lan-sync/web/peers.json" 2>/dev/null
echo '--- log ---'
tail -20 /tmp/dsh-web.log
