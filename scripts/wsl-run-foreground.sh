#!/usr/bin/env bash
# Capture the full startup output to a file, then print it.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
cd "$HOME"
timeout 30 dsh web --port 3081 --no-open > /tmp/dsh-run.log 2>&1
echo "exit=$?"
echo "--- lines: $(wc -l < /tmp/dsh-run.log) ---"
cat /tmp/dsh-run.log
