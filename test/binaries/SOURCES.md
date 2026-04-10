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

### Missing WEP games (no 32-bit originals)

The full WEP (Volumes 1-4) contained 29 games. The Best of WEP 32-bit port above only covers 11. The remaining 18 were never ported to 32-bit by Microsoft — the originals are 16-bit Windows 3.x (NE format, not PE):

Chess, Chip's Challenge, Dr. Black Jack, Fuji Golf, Go Figure!, IdleWild, JezzBall, JigSawed, Klotski, LifeGenesis, Maxwell's Maniac, Pipe Dream, Rodent's Revenge, Stones, TetraVex, Tetris, Tic Tac Drop, TicTacToe, TriPeaks, Tut's Tomb, WordZap

**Original 16-bit sources** (not usable, for reference):
- WEP 1-4 floppies: `https://archive.org/details/microsoft-windows-entertainment-pack-1-3.5-720-k.-7z_202501`
- Individual volumes: `https://archive.org/details/000777-WindowsEntertainmentPack1` (1-4)
- Best of WEP floppy: `https://archive.org/details/wep_best-of`

**Community 32-bit remakes** (third-party PE executables, untested):
- Source: `https://archive.org/details/wep-32bit`
- File: `wep32.7z`
- Includes remakes: tworld (Chip's Challenge), Funtris (Tetris), Peaks (TriPeaks), Pyramid (Tut's Tomb), CWordZap (WordZap), Rodent2000 (Rodent's Revenge), QuickBlackjack (Dr. Black Jack), Pawn (Chess), JigSawedME (JigSawed), FourStones (Tic Tac Drop), EmPipe (Pipe Dream), bricks (Klotski), Tetravex (TetraVex), Runenlegen (Stones)
- Note: some entries are Flash-based (JezzBall, Maxwell's Maniac, Fuji Golf) and won't work

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
