---
description: Check, start, stop or restart the golden-eye dashboard server
---

Control the local dashboard server. The user's argument (if any) is one of
`status`, `start`, `stop`, `restart` — default to `status` when they gave none
or said something ambiguous.

Run the script and report what it printed:

```
sh "${CLAUDE_PLUGIN_ROOT}/deploy/server.sh" <status|start|stop|restart>
```

It handles the details itself: it only kills a process whose `/healthz`
identifies as golden-eye, and it drives `launchctl` instead of `kill` when the
always-on service is installed (otherwise KeepAlive would restart the server
and make `stop` look broken).

Worth knowing when reporting back:

- **restart** is what picks up changed opt-ins in `~/.golden-eye/config.json`
  (`composer`, `history`, `files`, `updateCheck`, `allowedHosts`) — they are
  read once at start — and what clears a server still running pre-update code.
- **stop** is not permanent: any new Claude Code session bootstraps the server
  again on `SessionStart`. Say so, so the user is not surprised. To keep it
  down, they would also disable the plugin or remove the launchd service.
- Session data is untouched by any of these; history lives in
  `~/.golden-eye/events.jsonl` and is replayed on the next start.

If the server will not start, the likely causes are a port already taken by
something else (the server tries 7717–7721) and a stale
`~/.golden-eye/server.lock`; `status` reports what it found.
