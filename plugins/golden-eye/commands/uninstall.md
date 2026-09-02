---
description: Tear down golden-eye — stop the server, remove launchd + data, uninstall the plugins
---

Walk the user through removing golden-eye completely. Follow this order:

1. Ask whether they also want their golden-eye data deleted (`~/.golden-eye`:
   event history, hook logs, composer token, config). Do not assume.
2. Run the teardown script:
   - keep data: `sh "${CLAUDE_PLUGIN_ROOT}/deploy/uninstall.sh"`
   - purge data: `sh "${CLAUDE_PLUGIN_ROOT}/deploy/uninstall.sh" --purge`
   It stops the server, removes any launchd service, and prints what it
   deliberately leaves alone.
3. Check `tailscale serve status` (if tailscale is installed): if a mapping
   proxies to the golden-eye port, offer to run
   `tailscale serve --https=<port> off` for that mapping only.
4. Check the user's shell rc (`~/.zshrc` / `~/.bashrc`) for a golden-eye
   `claude` or `claudege` alias (the channels flag) and offer to remove those
   lines.
5. Uninstall the plugins and marketplace:
   - `claude plugin uninstall golden-eye@claude-golden-eye`
   - `claude plugin uninstall golden-eye-pm@claude-golden-eye` (if installed)
   - `claude plugin marketplace remove claude-golden-eye`
6. Tell the user to restart any open Claude Code sessions — hooks and the MCP
   channel load at SessionStart, so live sessions keep observing until then.
