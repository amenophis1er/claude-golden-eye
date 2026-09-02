#!/bin/sh
# Dev loop: push working-tree plugin code into every installed copy, then
# restart the dashboard server.
#
# Why this exists: `claude plugin install` snapshots the repo into
# <config dir>/plugins/cache/claude-golden-eye/<plugin>/<version>/ and hooks,
# MCP, and server boot all run from that snapshot. `claude plugin update`
# compares versions — while the version stays put, edits in the repo never
# reach the snapshot. This script syncs them in place without touching
# install registration.
#
# Which installs: $CLAUDE_CONFIG_DIR (if set) and ~/.claude by default;
# pass extra config dirs as arguments to cover additional instances.
#
# What still needs a session restart afterwards: hooks.json registration and
# each session's long-lived MCP process load at session start. Hook *scripts*
# and the dashboard server pick the new code up immediately.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
synced=0

# Candidate config dirs: env override, the default, plus any given as args.
# Duplicates are harmless (rsync is idempotent) but skipped for clean output.
dirs="${CLAUDE_CONFIG_DIR:-} $HOME/.claude $*"
seen=" "
for cfg in $dirs; do
  case "$seen" in *" $cfg "*) continue ;; esac
  seen="$seen$cfg "
  for plug in golden-eye golden-eye-pm; do
    for dest in "$cfg/plugins/cache/claude-golden-eye/$plug"/*/; do
      [ -d "$dest" ] || continue
      # --exclude web/node_modules: only needed for building the UI, never at
      # runtime (the server serves web/dist). Excluded paths are also
      # protected from --delete, so a copy that already has it keeps working.
      rsync -a --delete --exclude web/node_modules "$REPO/plugins/$plug/" "$dest"
      echo "synced plugins/$plug -> $dest"
      synced=$((synced + 1))
    done
  done
done

[ "$synced" -gt 0 ] || echo "warning: no installed copies found — nothing synced"

# Restart the dashboard server so server/ changes go live. Safe: state is
# replayed from events.jsonl on boot. Only kill a process that /healthz
# self-identifies as golden-eye — a recycled pid must not take a stray hit.
SERVER_JSON="$HOME/.golden-eye/server.json"
if [ -f "$SERVER_JSON" ]; then
  pid=$(sed -n 's/.*"pid"[^0-9]*\([0-9]*\).*/\1/p' "$SERVER_JSON")
  port=$(sed -n 's/.*"port"[^0-9]*\([0-9]*\).*/\1/p' "$SERVER_JSON")
  if [ -n "$pid" ] && curl -sf -m 2 "http://127.0.0.1:${port:-7717}/healthz" | grep -q '"name":"golden-eye"'; then
    kill "$pid" 2>/dev/null && echo "stopped server (pid $pid)"
    sleep 1
  fi
fi
node "$REPO/plugins/golden-eye/server/boot.js"
