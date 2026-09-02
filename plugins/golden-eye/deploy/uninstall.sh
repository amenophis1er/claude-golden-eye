#!/bin/sh
# golden-eye teardown: stop the server, remove the launchd service, and
# (with --purge) delete the data dir. Deliberately conservative: it never
# touches tailscale config or shell aliases — it prints what to check.
# The plugin/marketplace removal itself is a `claude` CLI operation and is
# printed at the end (run by /golden-eye:uninstall or by hand).
set -u
DATA="${GOLDEN_EYE_DATA_DIR:-$HOME/.golden-eye}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

# 1. Stop the singleton server (server.json first, stray processes second).
PID="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid)}catch(_){}" "$DATA/server.json" 2>/dev/null)"
if [ -n "$PID" ] && kill "$PID" 2>/dev/null; then
  echo "stopped server (pid $PID)"
fi
pkill -f "golden-eye/server/index.js" 2>/dev/null && echo "stopped stray server process(es)"
rm -f "$DATA/server.json" "$DATA/server.lock"

# 2. launchd service (only exists if install-launchd.sh was used).
if launchctl bootout "gui/$(id -u)/com.golden-eye.server" 2>/dev/null; then
  echo "removed launchd service"
fi
rm -f "$HOME/Library/LaunchAgents/com.golden-eye.server.plist"

# 3. Data dir: history, logs, composer token, config.
if [ "$PURGE" = "1" ]; then
  rm -rf "$DATA"
  echo "purged $DATA"
else
  echo "kept data dir $DATA (run again with --purge to delete history/config)"
fi

# 4. What this script deliberately does not do.
cat <<'EOF'

Not handled here — check manually:
  - tailscale proxy:  tailscale serve status   # then: tailscale serve --https=<port> off
  - shell alias:      remove any golden-eye `claude`/`claudege` alias from ~/.zshrc
Finish with:
  claude plugin uninstall golden-eye@claude-golden-eye
  claude plugin uninstall golden-eye-pm@claude-golden-eye   # if installed
  claude plugin marketplace remove claude-golden-eye
Then restart open Claude Code sessions (hooks load at SessionStart).
EOF
