#!/usr/bin/env bash
# The corpus: every test binary a sweep should try to launch.
#
# Shared by tools/menu-sweep-all.sh and tools/screenshot-all.sh. It lived in
# the menu sweep alone until a second sweep needed the same list, and two
# copies of a corpus list drift the moment someone adds a binary to one of
# them -- at which point the two sweeps quietly stop covering the same apps and
# nobody can diff their results.
#
# Sourced, not executed: it defines APPS and returns.

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

# Anything else that lives one directory deeper.
for d in test/binaries/entertainment-pack test/binaries/pinball \
         test/binaries/pinball-plus95 test/binaries/shareware \
         test/binaries/wep32-community; do
  [ -d "$d" ] && for f in "$d"/*.exe "$d"/*/*.exe; do
    [ -f "$f" ] && APPS+=("$f")
  done
done
