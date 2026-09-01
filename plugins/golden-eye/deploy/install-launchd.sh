#!/bin/sh
# Install (or reinstall) the LaunchAgent that keeps the golden-eye server
# always-on: starts at login, KeepAlive restarts it, idle-exit disabled.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found in PATH" >&2; exit 1; }

# Paths are interpolated into plist XML — escape the XML-special characters
# so an '&' (or worse) in a directory name can't produce an invalid plist.
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
NODE="$(xml_escape "$NODE")"
REPO="$(xml_escape "$REPO")"
ESC_HOME="$(xml_escape "$HOME")"
PLIST="$HOME/Library/LaunchAgents/com.golden-eye.server.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.golden-eye"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.golden-eye.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${REPO}/server/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GOLDEN_EYE_IDLE_EXIT_MS</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${ESC_HOME}/.golden-eye/launchd.log</string>
  <key>StandardErrorPath</key><string>${ESC_HOME}/.golden-eye/launchd.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/com.golden-eye.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed: $PLIST"
echo "server:    $(sleep 1; curl -s http://127.0.0.1:7717/healthz || echo 'starting…')"
