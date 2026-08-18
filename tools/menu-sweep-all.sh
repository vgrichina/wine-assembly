#!/usr/bin/env bash
# Run tools/menu-sweep.js over a corpus of apps and collect one log each.
#
# The sweep is per-app by design -- each run launches its app many times -- so
# doing a corpus means a loop somewhere. Putting it here rather than in a shell
# history means the app list, the log layout and the summary are the same on
# every run, and a later session can diff two sweeps instead of re-deriving
# which apps were covered.
#
# Usage: bash tools/menu-sweep-all.sh [out_dir] [-- extra menu-sweep args]
# Logs:  <out_dir>/<name>.log, plus <out_dir>/SUMMARY.txt
set -u

OUT="${1:-test/output/menu-sweep}"
shift || true
[ "${1:-}" = "--" ] && shift
mkdir -p "$OUT"

APPS=(
  test/binaries/notepad.exe
  test/binaries/calc.exe
  test/binaries/mspaint.exe
  test/binaries/win98-apps/notepad98.exe
  test/binaries/win98-apps/wordpad.exe
  test/binaries/win98-apps/regedit.exe
  test/binaries/win98-apps/taskman.exe
  test/binaries/win98-apps/sndrec32.exe
  test/binaries/win98-apps/sndvol32.exe
  test/binaries/win98-apps/cdplayer.exe
  test/binaries/win98-apps/mplay32.exe
  test/binaries/win98-apps/mplayer.exe
  test/binaries/win98-apps/sysmon.exe
  test/binaries/win98-apps/kodakimg.exe
  test/binaries/win98-apps/kodakprv.exe
  test/binaries/win98-apps/rsrcmtr.exe
  test/binaries/win98-apps/fontview.exe
  test/binaries/win98-apps/cleanmgr.exe
  test/binaries/win98-apps/telnet.exe
  test/binaries/win98-apps/tour98.exe
  test/binaries/win98-apps/vol98.exe
  test/binaries/win98-apps/hypertrm.exe
  test/binaries/win98-apps/write.exe
  test/binaries/win98-apps/welcome.exe
  test/binaries/win98-apps/winipcfg.exe
  test/binaries/nt/mspaint.exe
  test/binaries/xp/winmine.exe
  test/binaries/xp/sndrec32.exe
  test/binaries/xp/claass.exe
  test/binaries/explorer98/explorer.exe
  test/binaries/help/winhlp32.exe
  test/binaries/winamp.exe
)

# Anything else with a menu that lives one directory deeper.
for d in test/binaries/entertainment-pack test/binaries/pinball \
         test/binaries/pinball-plus95 test/binaries/shareware \
         test/binaries/wep32-community; do
  [ -d "$d" ] && for f in "$d"/*.exe "$d"/*/*.exe; do
    [ -f "$f" ] && APPS+=("$f")
  done
done

# One app at a time takes about ten minutes on a loaded box, which is most of
# a day for the corpus. The runs are independent, so fan them out; JOBS=3 keeps
# enough cores free that the emulator inside each run still gets scheduled
# (the numbers stop meaning anything if the runs starve each other).
JOBS="${MENU_SWEEP_JOBS:-3}"
# MENU_SWEEP_RESUME=1 skips any app that already has a non-empty log in OUT.
# A corpus run is most of an hour, so an interrupted one used to mean either
# starting over or hand-assembling the remainder; both waste the part that
# already succeeded, and the second is how a sweep ends up reported over two
# different builds. The summary is regenerated over the whole directory either
# way, so a resumed run still reports the complete corpus.
RESUME="${MENU_SWEEP_RESUME:-0}"
list=$(mktemp)
for exe in "${APPS[@]}"; do
  [ -f "$exe" ] || continue
  if [ "$RESUME" = "1" ]; then
    done_log="$OUT/$(basename "$(dirname "$exe")")-$(basename "$exe" .exe).log"
    [ -s "$done_log" ] && continue
  fi
  echo "$exe" >> "$list"
done
echo "sweeping $(wc -l < "$list" | tr -d ' ') app(s) into $OUT (resume=$RESUME, jobs=$JOBS)"

export OUT
sweep_one() {
  exe="$1"; shift
  name=$(basename "$exe" .exe)
  # Two apps can share a basename (mspaint ships in three places); keep the
  # parent directory in the log name so neither result overwrites the other.
  parent=$(basename "$(dirname "$exe")")
  log="$OUT/${parent}-${name}.log"
  node tools/menu-sweep.js "$exe" "$@" > "$log" 2>&1
  head -1 "$log"
}
export -f sweep_one 2>/dev/null || true

xargs -P "$JOBS" -I{} bash -c 'sweep_one "$@"' _ {} "$@" < "$list"
rm -f "$list"

{
  echo "menu sweep: $(date -Iseconds)"
  echo
  echo "--- apps with findings"
  grep -l -E '^  (CRASH|NODLG)' "$OUT"/*.log 2>/dev/null | while read -r f; do
    head -1 "$f"
    grep -E '^  (CRASH|NODLG)' "$f"
  done
  echo
  echo "--- skipped"
  grep -h '^SKIP' "$OUT"/*.log 2>/dev/null
  echo
  echo "--- clean"
  grep -L -E '^  (CRASH|NODLG)|^SKIP' "$OUT"/*.log 2>/dev/null | while read -r f; do head -1 "$f"; done
} > "$OUT/SUMMARY.txt"

echo
cat "$OUT/SUMMARY.txt"
