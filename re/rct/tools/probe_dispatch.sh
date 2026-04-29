#!/usr/bin/env bash
# Count tile-renderer hit paths to verify whether ANY pixel-write dispatch
# fires during a Phase B run. Output:
#   0x444437 = N   <- the only pixel-writing site (call [0x5a7980+ebp*4])
#   0x4443bd = N   <- sprite-list-entry (tile_id != -1)
#   0x44444e = N   <- bail / ret
#   0x444374 = N   <- tile_renderer entry
#   0x436833 = N   <- rotation 1 entry
#
# Expected at 300K batches in current state: dispatch=0, bail=18M, entry=19M.
# A non-zero dispatch hit means the visibility wall is broken — something to
# celebrate.
set -e
cd /home/user/wine-assembly
BATCHES="${1:-300000}"
echo "=== probe_dispatch batches=$BATCHES ==="
timeout 120 node test/run.js \
  --exe=test/binaries/shareware/rct/English/RCT.exe \
  --max-batches="$BATCHES" \
  --count=0x444437,0x4443bd,0x44444e,0x444374,0x436833 \
  --no-close 2>&1 | tail -12
