#!/bin/sh
# One program of a shot sweep, bounded, for xargs.
#
#   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --list > /tmp/list
#   xargs -P 6 -L 1 tools/toyvm/capture-one.sh < /tmp/list
#   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots \
#     --merge=/tmp/shots/rows --json=/tmp/shots.json
#
# The three arguments are the three fields --list prints: the program, the tile
# it owns, and the row file it writes. A program whose row file already exists
# is skipped, so re-running the same xargs line captures exactly the programs
# that are missing -- delete a row file to force that one to be re-taken.
#
# The timeout is per PROGRAM and lives here rather than in the sweep, which is
# the point of driving it this way: one wedged program costs one row instead of
# the tail of a 199-program run. 900 seconds because a program can cost up to
# nine sequential child runs (the run, the auto-key retry, the re-take, the
# named-switch pair, the no-sound-card pair and the GUS-environment pair).
#
# The child cap is DERIVED from SECS rather than set beside it. A program can
# cost nine sequential child runs, so two independent numbers have to multiply
# out to less than the wall cap or the outer kill lands in the middle of the
# last child and the row is never written -- which is not a slow program, it is
# a program with no result at all. At the old pair of defaults (900 outer, 180
# per child) they multiplied out to exactly 900, and TRIPLEX!.COM, DENTROCF.EXE
# and READTHIS.COM photographed as nothing for that reason and no other.
# Tenths, so the nine runs fit with one in hand for startup and PNG writes.
# The count moves with the retry chain: it went to nine when the GUS rung was
# added, and leaving the divisor behind is not a slow sweep, it is a sweep whose
# last retry is killed mid-run and whose row is never written.
#
# SIGKILL, not the default SIGTERM: a guest inside one long wasm slice does not
# give the node event loop a turn, so a TERM is queued and never delivered.
set -u
# 1500, and the number that is actually being held constant is CHILD=150s. The
# child cap is a FRACTION of this, so every time the retry chain grows a pair
# the divisor grows and this has to grow with it. It has now cost the same
# program twice: at 900/eighths the budget silently fell to 112s, and at
# 1200/tenths to 120s, and both times CONDENZ.EXE -- still filling its screen at
# 277M dispatches -- photographed as 0 pixels where 150s gets it 57965. The
# programs that notice a shorter child are the ones with the most to draw. A
# retry that costs the run its slowest programs is not a better sweep.
: "${SECS:=1500}"
# 165 GUEST SECONDS, and the unit is the point. This was 300M dispatches, and
# 300M was itself ten times the 30M at which five programs had not reached
# their first frame (BRIAN.EXE draws at 140M, DEFECT!.COM and CEN!FB.EXE fill
# the screen, DIZZY_FI.EXE reaches a third of one). A dispatch count is only a
# fixed amount of the guest's own time while the clock derived from it stays
# put, and aadf7ec4 moved it: the VGA frame period went from 26,009 dispatches
# to 143,051 on the default clock, so the same 300M buys 5.5x less of a paced
# show than the pictures in docs/dos-corpus were taken with. 165 is the guest
# time that old 300M used to buy -- 300e6 / 26009 frames, at 70 a second.
# Nothing is spent on a program that finishes early; the wall bound above is
# what actually caps the sweep.
: "${GUEST_SECONDS:=165}"
: "${EXTRA:=--auto-key}"
CHILD=$((SECS / 10))
# DISPATCHES= still overrides, for a run that wants fixed WORK rather than
# fixed guest time -- an A/B of the interpreter against itself, say.
if [ -n "${DISPATCHES:-}" ]; then
  BUDGET="--dispatches=$DISPATCHES"
else
  BUDGET="--guest-seconds=$GUEST_SECONDS"
fi
exec timeout -s KILL "$SECS" node "$(dirname "$0")/shot-sweep.js" \
  --capture="$1" --png="$2" --row="$3" "$BUDGET" \
  --timeout="$CHILD" $EXTRA
