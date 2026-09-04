#!/bin/sh
# Control the golden-eye dashboard server.
#
#   server.sh status | start | stop | restart
#
# Sessions bootstrap the server automatically, so this exists for the moments
# when that is not enough: picking up changed config.json opt-ins (read once at
# start), replacing a process still serving pre-update code, or simply stopping
# a dashboard you do not want running.
#
# Two things it is careful about:
#  - It only ever kills a process whose /healthz self-identifies as golden-eye,
#    so a recycled pid from server.json cannot take an unrelated process down.
#  - If the launchd service is installed it drives launchctl instead of kill,
#    because KeepAlive would otherwise resurrect the server behind your back
#    and make "stop" look broken.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="${GOLDEN_EYE_DATA_DIR:-$HOME/.golden-eye}"
SERVER_JSON="$DATA/server.json"
LABEL="com.golden-eye.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

read_field() { sed -n "s/.*\"$1\"[^0-9]*\([0-9]*\).*/\1/p" "$SERVER_JSON" 2>/dev/null | head -1; }

alive() { # $1 = port; true when a golden-eye server answers there
  [ -n "${1:-}" ] || return 1
  curl -sf -m 2 "http://127.0.0.1:$1/healthz" 2>/dev/null | grep -q '"name":"golden-eye"'
}

launchd_loaded() { [ -f "$PLIST" ] && launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

status() {
  PORT=$(read_field port); PID=$(read_field pid)
  if alive "$PORT"; then
    VERSION=$(curl -sf -m 2 "http://127.0.0.1:$PORT/healthz" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
    echo "running   pid $PID · port $PORT · v${VERSION:-?}"
    echo "          http://127.0.0.1:$PORT"
    launchd_loaded && echo "          launchd service is loaded (restarts on login/crash)"
    return 0
  fi
  echo "not running${PORT:+ (stale server.json for port $PORT)}"
  return 1
}

stop() {
  if launchd_loaded; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    echo "stopped the launchd service (re-enable with deploy/install-launchd.sh)"
    return 0
  fi
  PORT=$(read_field port); PID=$(read_field pid)
  if [ -n "$PID" ] && alive "$PORT" && kill "$PID" 2>/dev/null; then
    echo "stopped pid $PID"
  else
    echo "nothing to stop"
  fi
  rm -f "$SERVER_JSON" "$DATA/server.lock"
}

start() {
  if launchd_loaded; then
    launchctl kickstart "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  else
    node "$HERE/../server/boot.js"
  fi
  sleep 1
  status
}

case "${1:-status}" in
  status) status ;;
  stop) stop ;;
  start) start ;;
  restart)
    if launchd_loaded; then
      # One call, no window where the service is down.
      launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
      sleep 1
      status
    else
      stop
      sleep 1
      start
    fi
    ;;
  *) echo "usage: server.sh status|start|stop|restart" >&2; exit 1 ;;
esac
