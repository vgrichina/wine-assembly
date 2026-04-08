# Test Binary Sources

All test binaries sourced from publicly archived Microsoft software on archive.org.

## Entertainment Pack

Source: `https://archive.org/details/BestOfWindowsEntertainmentPack64Bit`
32-bit PE rebuilds of the Best of Windows Entertainment Pack.

| Binary | Game |
|--------|------|
| cruel.exe | Cruel (solitaire variant) |
| freecell.exe | FreeCell |
| golf.exe | Golf (solitaire variant) |
| pegged.exe | Pegged |
| reversi.exe | Reversi |
| ski32.exe | SkiFree |
| snake.exe | Rattler Race |
| sol.exe | Solitaire |
| taipei.exe | Taipei (Mahjong solitaire) |
| tictac.exe | TicTactics |
| winmine.exe | Minesweeper |
| cards.dll | Card drawing library |
| aboutwep.dll | About dialog |

## Win98 Apps

Source: `https://archive.org/details/windows-1999-programs`
File: `Windows 1999 Programs.zip` — PE32 executables from Windows 98/99.

Extracted apps: wordpad.exe, cdplayer.exe, fontview.exe, hypertrm.exe, kodakimg.exe, kodakprv.exe, mplayer.exe, sndvol32.exe, sndrec32.exe, welcome.exe, tour98.exe, explorer.exe, regedit.exe, taskman.exe, sysmon.exe, rsrcmtr.exe, winipcfg.exe, cleanmgr.exe, notepad98.exe, vol98.exe, telnet.exe, write.exe, mplay32.exe

## XP Apps

Source: `https://archive.org/details/classic-windows-apps.-7z`
File: `Classic Windows Apps.7z`

| Binary | App |
|--------|-----|
| claass.exe | Calculator (XP) |
| sndrec32.exe | Sound Recorder (XP) |
| xp_eos.exe | XP End of Life warning |
| winmine.exe | Minesweeper (XP) |

## Pinball

Two versions are staged locally (gitignored) for cross-comparison:

**`pinball/`** — Windows XP version
Source: `https://archive.org/details/pinball_202110`
File: `Pinball.zip` — 3D Space Cadet Pinball from Windows XP.
Note: data files dated 2004-08-10, but `pinball.exe` dated 2008-04-13 (later hotfix) — not a pristine matched set.

**`pinball-plus95/`** — Microsoft Plus! 95 version (1996, original release)
Source: `https://archive.org/details/SpaceCadet_Plus95`
File: `Space_Cadet.rar` — extracted with `unar` (rar5 compression filter, p7zip/bsdtar can't handle it).
Matched 1996 exe + DAT pair. `PINBALL.DAT` is the same size (928,700 B) as the XP version but bytewise different. `pinball.exe` is 351,744 B (vs XP's 281,088 B).

## Installers

| Binary | Source |
|--------|--------|
| winamp291.exe | `https://archive.org/details/winamp-291` — WinAmp 2.91 (NSIS installer) |
| mirc59.exe | `https://archive.org/details/mirc59` — mIRC 5.9 |

## Top-level binaries

| Binary | Notes |
|--------|-------|
| notepad.exe | Windows Notepad |
| calc.exe | Windows Calculator |
| mspaint.exe | MS Paint (Win98) |
| nt/mspaint.exe | MS Paint (NT) |
