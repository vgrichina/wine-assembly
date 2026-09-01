#!/usr/bin/env bash
# Every test/test-*.js and test/*.test.js must be named in one of run-all.sh's tiers (UNIT, E2E,
# SMOKE) or parked in QUARANTINE with a reason.
#
# Without this gate a test file that nobody adds to an array is not "pending" --
# it is invisible. On 2026-08-18 that was 145 of 352 files, and sweeping them by
# hand turned up a combobox that paints no text, two modules that fail to
# compile, and a pile of tests whose spawn budgets had rotted below the
# emulator's own CPU cost. The tests had been written; only the wiring was
# missing. This is the same shape as tools/check-wat-manifest.js, which exists
# because a src/*.wat missing from WAT_FILES also fails silently.

set -u
cd "$(dirname "$0")/.."

RUNNER=test/run-all.sh

# Two naming conventions are in use: the original test/test-NAME.js and the
# test/NAME.test.js the WATX compiler suites adopted. Only the first was swept
# until 2026-08-31, so all 19 test/watx-compiler-*.test.js files were run by
# nothing at all -- the same invisibility this gate exists to prevent, reached
# through a filename pattern instead of a missing array entry. Both patterns are
# swept now, so either naming fails the build when it lands unwired.
listed=$(grep -oE '^[[:space:]]*test/(test-[a-zA-Z0-9._-]+|[a-zA-Z0-9._-]+\.test)\.js' "$RUNNER" | tr -d ' ' | sort -u)
actual=$(ls test/test-*.js test/*.test.js 2>/dev/null | sort -u)

missing=$(comm -13 <(echo "$listed") <(echo "$actual"))
stale=$(comm -23 <(echo "$listed") <(echo "$actual"))

rc=0
if [ -n "$missing" ]; then
  echo "check-test-manifest: these test files are in no tier and no quarantine:" >&2
  echo "$missing" | while read -r f; do echo "  $f" >&2; done
  echo >&2
  echo "  Add each to UNIT (in-process) or E2E (spawns test/run.js) in $RUNNER." >&2
  echo "  If it is red, put it in QUARANTINE with what it reports." >&2
  echo "  tools/run-tests.sh LISTFILE runs an ad-hoc set to find out which." >&2
  rc=1
fi

if [ -n "$stale" ]; then
  echo "check-test-manifest: $RUNNER names test files that do not exist:" >&2
  echo "$stale" | while read -r f; do echo "  $f" >&2; done
  rc=1
fi

if ! node tools/check-test-timeouts.js; then
  rc=1
fi

[ $rc -eq 0 ] && echo "check-test-manifest: OK ($(echo "$actual" | wc -l | tr -d ' ') files, all accounted for)"
exit $rc
