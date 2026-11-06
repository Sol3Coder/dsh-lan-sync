#!/usr/bin/env bash
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
printf '\nmarker: edited-on-wsl\n' >> "$HOME/.dsh/skills/lan-sync-e2e/SKILL.md"
sleep 22
echo '--- wsl skill tail ---'
tail -5 "$HOME/.dsh/skills/lan-sync-e2e/SKILL.md"
