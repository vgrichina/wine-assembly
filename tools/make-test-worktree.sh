#!/usr/bin/env bash
# Create a git worktree that can actually run the test suite.
#
# WHY THIS EXISTS: test/binaries is only PARTIALLY tracked. Most DLLs and
# every large app (dx-sdk/, pinball/, screensavers/, candidates/, ...) are
# gitignored, so `git worktree add` gives you the directory structure with
# holes in it. Tests then fail for reasons that have nothing to do with the
# commit under test, and the difference is invisible to `ls test/binaries` --
# it is one level down. This has produced at least three bogus measurements
# (a meaningless wt5 sweep, a "Blobby scores 5/9" that was really a missing
# comctl32.dll, and one more before that).
#
# Usage: tools/make-test-worktree.sh <path> [<commit-ish>]
#
# Symlinks every gitignored asset from the main tree into the new worktree, so
# the worktree tests the committed SOURCE against the real BINARIES.

set -euo pipefail

DEST=${1:?usage: make-test-worktree.sh <path> [<commit-ish>]}
REF=${2:-HEAD}

MAIN=$(git rev-parse --show-toplevel)
cd "$MAIN"

if [ -e "$DEST" ]; then
  echo "make-test-worktree: $DEST already exists" >&2
  exit 1
fi

git worktree add --detach "$DEST" "$REF"
DEST=$(cd "$DEST" && pwd)

# Assets the suite reads but git does not carry. Anything ignored under these
# roots gets symlinked back to the main tree.
ASSET_ROOTS="test/binaries test/fixtures binaries node_modules fonts"

linked=0
for root in $ASSET_ROOTS; do
  [ -e "$MAIN/$root" ] || continue

  # A wholly-ignored root (node_modules, binaries) links as one entry.
  if git check-ignore -q "$root" 2>/dev/null; then
    if [ ! -e "$DEST/$root" ]; then
      ln -s "$MAIN/$root" "$DEST/$root"
      linked=$((linked + 1))
    fi
    continue
  fi

  # A partially-tracked root: link each ignored entry inside it.
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    p=${p%/}
    [ -e "$DEST/$p" ] && continue
    mkdir -p "$(dirname "$DEST/$p")"
    ln -s "$MAIN/$p" "$DEST/$p"
    linked=$((linked + 1))
  done < <(git ls-files --others --ignored --exclude-standard --directory "$root")
done

echo "make-test-worktree: $DEST at $(git -C "$DEST" rev-parse --short HEAD), $linked asset links"

# Fail loudly rather than let a holed worktree produce a bogus measurement.
missing=0
for probe in test/binaries/dlls/comctl32.dll test/binaries/calc.exe node_modules; do
  if [ -e "$MAIN/$probe" ] && [ ! -e "$DEST/$probe" ]; then
    echo "make-test-worktree: MISSING $probe -- results from this tree are not trustworthy" >&2
    missing=1
  fi
done
exit $missing
