#!/bin/sh
# Bump the version everywhere it is written, then prove they agree.
#
#   scripts/bump-version.sh 0.1.5
#
# The version lives in five places, and the plugin manifests are the ones that
# matter most: Claude Code compares versions to decide whether to refresh an
# install cache, so a manifest left behind means users keep running old code
# while everything reports success. Doing this by hand is exactly the kind of
# step that half-works silently.
#
# Refuses to bump a version CHANGELOG.md has no section for — notes are written
# before the tag, not after.
set -eu

NEW="${1:?usage: bump-version.sh <x.y.z>}"
NEW="${NEW#v}"
case "$NEW" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a version: $NEW" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CURRENT=$(sed -n 's/.*"version": *"\([0-9][^"]*\)".*/\1/p' package.json | head -1)
[ -n "$CURRENT" ] || { echo "could not read the current version from package.json" >&2; exit 1; }
if [ "$CURRENT" = "$NEW" ]; then
  echo "already at $NEW" >&2
  exit 1
fi

# Notes first: the release workflow reads this section, so a missing one would
# only surface after tagging and pushing.
"$ROOT/scripts/changelog-section.sh" "$NEW" >/dev/null || {
  echo "" >&2
  echo "Rename CHANGELOG.md's '## [Unreleased]' to '## [$NEW] — $(date +%Y-%m-%d)'" >&2
  echo "and open a fresh Unreleased section above it, then re-run." >&2
  exit 1
}

FILES="package.json .claude-plugin/marketplace.json
plugins/golden-eye/.claude-plugin/plugin.json
plugins/golden-eye-pm/.claude-plugin/plugin.json"

for f in $FILES; do
  # Only the manifest's own "version" key — never a dependency's.
  sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/g" "$f"
done
# The MCP handshake reports its own version in JS, not JSON.
sed -i '' "s/version: '$CURRENT'/version: '$NEW'/" plugins/golden-eye/server/mcp-server.js

# Verify: every place that mentioned the old version now says the new one, and
# nothing still carries the old. Cheaper than discovering it after a release.
STALE=$(grep -rl "\"version\": \"$CURRENT\"\|version: '$CURRENT'" \
  package.json .claude-plugin plugins/golden-eye/.claude-plugin \
  plugins/golden-eye-pm/.claude-plugin plugins/golden-eye/server/mcp-server.js 2>/dev/null || true)
if [ -n "$STALE" ]; then
  echo "still on $CURRENT after the bump:" >&2
  printf '  %s\n' $STALE >&2
  exit 1
fi

echo "$CURRENT -> $NEW"
grep -rn "\"version\": \"$NEW\"\|version: '$NEW'" \
  package.json .claude-plugin/marketplace.json \
  plugins/golden-eye/.claude-plugin/plugin.json \
  plugins/golden-eye-pm/.claude-plugin/plugin.json \
  plugins/golden-eye/server/mcp-server.js | sed 's/^/  /'

cat <<EOF

Next:
  (cd plugins/golden-eye/web && npm run build)   # dist carries the version too
  npm test
  git commit -am "release: v$NEW"
  git tag "v$NEW" && git push origin main --tags
EOF
