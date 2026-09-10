#!/usr/bin/env bash
# Every test/test-*.js and test/*.test.js must be placed exactly once by the
# conventions and exception lists in tools/test-tiers.js.
#
# Without this gate a naming or exception bug could make a test invisible. The
# old handwritten arrays once omitted 145 files; automatic discovery removes
# that churn while this gate keeps stale exceptions and reasonless quarantine
# entries from accumulating.

set -u
cd "$(dirname "$0")/.."

rc=0
if ! node tools/test-tiers.js --check; then
  rc=1
fi
if ! node tools/check-test-timeouts.js; then
  rc=1
fi

[ $rc -eq 0 ] && echo "check-test-manifest: OK (all discovered tests accounted for)"
exit $rc
