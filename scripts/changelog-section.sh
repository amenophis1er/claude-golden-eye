#!/bin/sh
# Print CHANGELOG.md's section for one version — the body of the GitHub release.
#
#   scripts/changelog-section.sh 0.1.4
#
# Exits non-zero when the version has no section, which is deliberate: the
# release workflow runs this before publishing, so tagging a version nobody
# wrote notes for fails loudly instead of shipping auto-generated commit spam.
set -eu

VERSION="${1:?usage: changelog-section.sh <version>}"
VERSION="${VERSION#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILE="$ROOT/CHANGELOG.md"

# From the matching "## [x.y.z]" heading to the next "## " heading, excluding
# both headings and the reference-link block at the end of the file.
SECTION=$(awk -v v="$VERSION" '
  /^## / {
    if (inside) exit
    inside = index($0, "[" v "]") > 0
    next
  }
  inside && /^\[.*\]: http/ { exit }
  inside { print }
' "$FILE")

# Strip leading/trailing blank lines.
SECTION=$(printf '%s\n' "$SECTION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba')

if [ -z "$SECTION" ]; then
  echo "no CHANGELOG.md section for version $VERSION" >&2
  echo "add one under '## [$VERSION] — <date>' before tagging" >&2
  exit 1
fi

printf '%s\n' "$SECTION"
