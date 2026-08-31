#!/usr/bin/env bash
# M0 probe: wire the plugin's logger hooks into a throwaway project, run one
# headless session that forces a main-agent write + a subagent spawn, then
# summarize the captured hook payloads.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJ="$ROOT/probe/test-project"
LOG_DIR="$ROOT/.probe"

mkdir -p "$PROJ/.claude" "$LOG_DIR"

# Clear any stale events from earlier runs so analysis sees this run only.
rm -f "$LOG_DIR/hook-events.jsonl"

node "$ROOT/probe/gen-settings.js" "$PROJ/.claude/settings.json" "$ROOT/hooks"
echo "Wired probe hooks -> $PROJ/.claude/settings.json"

PROMPT='Probe task: 1) Use TodoWrite to record a 4-item plan for this probe and mark the first item in_progress. 2) Create a file named main-agent-file.txt containing "written by the main agent". 3) Use the Agent tool (formerly Task) to spawn a general-purpose subagent that creates sub-agent-file-a.txt and sub-agent-file-b.txt, each containing "written by a subagent", then reports back. 4) When its work is done, mark all todos completed and reply with one short sentence summarizing what happened.'

cd "$PROJ"
echo "Running probe session (claude -p, may take a minute)..."
claude -p "$PROMPT" \
  --dangerously-skip-permissions \
  --output-format json \
  > "$LOG_DIR/session-result.json" \
  2> "$LOG_DIR/session-stderr.txt" || true

echo "--- session stderr (tail) ---"
tail -5 "$LOG_DIR/session-stderr.txt" || true
echo "--- result type ---"
node -e "try{const r=require('$LOG_DIR/session-result.json');console.log(r.type||JSON.stringify(r).slice(0,200))}catch(e){console.log('no/invalid result json')}" || true

echo "--- analyzing captured events ---"
node "$ROOT/probe/analyze.js"