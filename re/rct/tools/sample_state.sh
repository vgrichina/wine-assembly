#!/usr/bin/env bash
# Sample EIP + key state at given batch checkpoint.
# Usage: ./sample_state.sh <batches>
set -e
cd /home/user/wine-assembly
BATCHES="${1:-50000}"
echo "=== batch=$BATCHES ==="
node test/run.js --exe=test/binaries/shareware/rct/English/RCT.exe \
  --max-batches="$BATCHES" --no-close 2>&1 \
  | tail -20 \
  | grep -E '(^EIP=|^Stats|^wndproc|^heap)' \
  || echo "(no state lines found in last 20)"
