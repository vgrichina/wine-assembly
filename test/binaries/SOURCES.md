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

**Community 32-bit remakes** (third-party PE executables, staged in `wep32-community/`):
- Source: `https://archive.org/details/wep-32bit`
- File: `wep32.7z` (2.6 MB)
- Extraction: archive ships with a deliberately-broken 7z magic byte (`37 78 ...` instead of `37 7a ...`) so it doesn't auto-extract — the uploader intends you to drag it onto their bundled `un7z.exe`. To extract with standard 7z, patch byte 1 back to `0x7a`:
  ```bash
  printf '\x7a' | dd of=wep32.7z bs=1 seek=1 count=1 conv=notrunc
  7z x wep32.7z
  ```
- Remakes copied into `wep32-community/`: bricks (Klotski), EMPIPE (Pipe Dream), Funtris/Peaks/Pyramid/FourStones (Funpack: Tetris/TriPeaks/Tut's Tomb/Tic Tac Drop), JigSawedME, Pawn (Chess), QuickBlackjack, Rodent2000, Runenlegen (Stones), Tetravex, tworld (Chip's Challenge, needs SDL), Winarc (Pegs/Krypto/LifeGen bundle), CWordZap
- Flash-based games in the archive (JezzBall, Maxwell's Maniac, Fuji Golf) are skipped — they need Flash Player, not a PE runtime.

## Plus! 98

**`plus98/`** — Microsoft Plus! 98 add-on pack for Win98.
Source: `https://archive.org/details/MicrosoftPlusforWindows98`
File: `PLUS98.ISO` (298 MB). Everything ships inside `plus98/PLUS98.CAB` — extract with `cabextract -F "MARBLES.*" -F "SPIDER.*" PLUS98.CAB` (no JezzBall — that was Plus! 95, not 98).

| Binary | Game | Notes |
|--------|------|-------|
| SPIDER.EXE | Spider Solitaire | Pure Win32 + ole32. Viable. |
| MARBLES.EXE | Lose Your Marbles | Needs DDRAW/DINPUT/DSOUND — won't run until DirectX support lands. |

**`screensavers/`** — Plus! 98 screensavers (.SCR = PE executables). Extracted from same `PLUS98.CAB`.

| Binary | Screensaver | DLL deps |
|--------|-------------|----------|
| CATHY.SCR | Cathy (comic strip) | KERNEL32, USER32, GDI32, ADVAPI32 |
| CITYSCAP.SCR | Cityscape | + COMCTL32, threads |
| CORBIS.SCR | Corbis Photography | MFC42 |
| DOONBURY.SCR | Doonesbury (comic strip) | KERNEL32, USER32, GDI32, ADVAPI32 |
| FASHION.SCR | Fashion | MFC42 |
| FOXTROT.SCR | FoxTrot (comic strip) | KERNEL32, USER32, GDI32, ADVAPI32 |
| GA_SAVER.SCR | Garfield | + WINMM |
| HORROR.SCR | Horror Channel | MFC42 |
| PEANUTS.SCR | Peanuts (comic strip) | KERNEL32, USER32, GDI32, ADVAPI32 |
| PHODISC.SCR | Photo Discovery | KERNEL32, USER32, GDI32, ADVAPI32 |
| WIN98.SCR | Windows 98 | MFC42 |
| WOTRAVEL.SCR | World Traveler | MFC42 |
| ARCHITEC.SCR | Architecture | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| FALLINGL.SCR | Falling Leaves | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| GEOMETRY.SCR | Geometry | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| JAZZ.SCR | Jazz | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| OASAVER.SCR | Online Art Saver | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| ROCKROLL.SCR | Rock & Roll | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |
| SCIFI.SCR | Sci-Fi | DDRAW, OLEAUT32, VERSION, WINMM, COMCTL32 |

Plus! 98 also ships MFC42.DLL (954 KB, 1998-05-01) and MSVCRT.DLL (280 KB) inside the CAB. EDISK.SCR and PB.SCR are text config files, not PE binaries — skipped.

**D3DIM saver assets:** ARCHITEC/FALLINGL/GEOMETRY/JAZZ/OASAVER/ROCKROLL/SCIFI each look for scene files via `FindFirstFileA(".\\*.scn")` at startup. Without matching .SCN + mesh (.X) + backdrop (.GIF/.BMP) files in the VFS they `MessageBox` "Couldn't find any scene definitions in location \"\" - reinstall?". Extract from the same CAB alongside the .SCR files:

```bash
cd test/binaries/screensavers
cabextract -F '*.SCN' -F '*.X' -F '*.PAL' -F '*.GIF' -F '*.BMP' /path/to/plus98/PLUS98.CAB
```

(Full extraction is ~13 MB — all gitignored by `binaries/*.exe` / `*.bmp` / etc.) Even with assets present all 7 D3DIM savers currently throw `CA::DXException("No valid modes found for this device")` at `0x74414d83`; see `apps/screensavers.md`.

Same abandonware posture as the rest of `test/binaries/` — not officially redistributable but widely mirrored; consistent with the existing pinball-plus95 precedent.

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
| winamp295.exe | `https://archive.org/details/winamp295` — Winamp 2.95 (NSIS installer) |
| mirc59.exe | `https://archive.org/details/mirc59` — mIRC 5.9 |

## Winamp plug-ins

**`plugins/`** — Winamp plug-ins kept in the local fixture pool.

`in_mp3.dll` and `out_wave.dll` are the known-good playback path used with the
Winamp 2.91 fixture. The additional input/output/general plug-ins below were
copied from a local extraction of `installers/winamp295.exe`. All are
recoverable from the commands below, but the web fixture currently mounts only
`in_mp3.dll` and `out_wave.dll`: Winamp's Visualization preferences page
enumerates `C:\Plugins\*.DLL`, and loading arbitrary non-visualizer plugins
currently prevents the pane from completing its move/show initialization.

| Binary | Notes |
|--------|-------|
| cddbcontrolwinamp.dll | CDDB support |
| cddbuiwinamp.dll | CDDB UI support |
| enc_vorbis.dll | Vorbis encoder |
| gen_ml.dll | Media Library general plug-in |
| in_cdda.dll | CD audio / line-in input |
| in_midi.dll | MIDI input |
| in_mod.dll | Module decoder |
| in_vorbis.dll | Vorbis input |
| in_wm.dll | Windows Media input |
| out_wm.dll | Windows Media output |
| read_file.dll | Winamp support library |

Recover the local plug-in fixture pool from the installers with the emulator's
VFS dump path:

```bash
rm -rf /private/tmp/winamp291-vfs /private/tmp/winamp295-vfs
node test/run.js --exe=test/binaries/installers/winamp291.exe --args=/S --max-batches=8000 --batch-size=5000 --save-vfs=/private/tmp/winamp291-vfs
node test/run.js --exe=test/binaries/installers/winamp295.exe --args=/S --max-batches=8000 --batch-size=5000 --save-vfs=/private/tmp/winamp295-vfs

mkdir -p test/binaries/plugins
cp "/private/tmp/winamp291-vfs/program files/winamp/plugins/in_mp3.dll" test/binaries/plugins/
cp "/private/tmp/winamp291-vfs/program files/winamp/plugins/out_wave.dll" test/binaries/plugins/
cp "/private/tmp/winamp295-vfs/program files/winamp/plugins/"{cddbcontrolwinamp.dll,cddbuiwinamp.dll,enc_vorbis.dll,gen_ml.dll,in_cdda.dll,in_midi.dll,in_mod.dll,in_vorbis.dll,in_wm.dll,out_wm.dll,read_file.dll} test/binaries/plugins/
```

**`plugins/candidates/`** — unmounted visualization candidates. These are kept
locally for compatibility work but are intentionally not listed in the web
Winamp manifest yet, so they do not affect startup, playback, or plug-in
enumeration until each candidate is validated.

From `https://archive.org/details/winamp5666_full_en-us_redux`
(`winamp5666_full_en-us_redux.exe`, SHA1
`06fe238861ee178ded0efcd323fd0affe009c327`):

| Binary | Size | SHA1 | Compatibility note |
|--------|------|------|--------------------|
| vis_avs.dll | 462,902 | `8084b90489072a9b02c5cafdfc036bea7f1b706a` | Best near-term candidate. Static imports include DDRAW plus MSVFW32/AVIFIL32 for optional AVI features. |
| vis_nsfs.dll | 33,792 | `a763ea519713eff86e909d5f6636acdf6cf2fa7f` | DirectDraw-based Nullsoft fullscreen visualizer; small, but imports MSVCR90. |
| vis_milk2.dll | 425,472 | `1b81c81a578952ecccc0f53ddea5ec37acc975c1` | MilkDrop 2. Dynamically loads D3D9/D3DX9; not a minimal-change target. |

From `https://archive.org/details/milk-drop-104e`
(`MilkDrop104e.zip`, SHA1 `ab1d0ce1f3dc5d0728c5d5486902b775e5c905d0`):

| Binary | Size | SHA1 | Compatibility note |
|--------|------|------|--------------------|
| vis_milk.dll | 430,592 | `099cefe04c8cb88f38f7f1f1a9b1923434259792` | MilkDrop 1.04e. Dynamically loads D3D8; not a minimal-change target. |

Recover the unmounted visualization candidates:

```bash
rm -rf /private/tmp/winamp5666-vis /private/tmp/milkdrop104e-extract
mkdir -p /private/tmp/winamp5666-vis test/binaries/plugins/candidates
curl -L -o /private/tmp/winamp5666_full_en-us_redux.exe \
  "https://archive.org/download/winamp5666_full_en-us_redux/winamp5666_full_en-us_redux.exe"
7z e -y -o/private/tmp/winamp5666-vis /private/tmp/winamp5666_full_en-us_redux.exe \
  "Plugins/vis_avs.dll" "Plugins/vis_nsfs.dll" "Plugins/vis_milk2.dll"
cp /private/tmp/winamp5666-vis/{vis_avs.dll,vis_nsfs.dll,vis_milk2.dll} test/binaries/plugins/candidates/

curl -L -o /private/tmp/MilkDrop104e.zip \
  "https://archive.org/download/milk-drop-104e/MilkDrop104e.zip"
unzip -q /private/tmp/MilkDrop104e.zip -d /private/tmp/milkdrop104e-extract
cp /private/tmp/milkdrop104e-extract/vis_milk.dll test/binaries/plugins/candidates/

shasum -a 1 test/binaries/plugins/candidates/vis_*.dll
```

## Shareware (`shareware/`)

Downloaded to profile DirectDraw and Direct3D surfaces. Each SFX/installer extracted; game EXE pulled out.

| Binary | Source | Imports | Notes |
|--------|--------|---------|-------|
| `HOVER!/HOVER.EXE` | `https://archive.org/download/hoverwindows95/hover.zip` | WINMM+GDI+USER | Pure Win32, no DX. Early MFC-era thunking. |
| `mcm/mcm_ex/MCM.EXE` (Motocross Madness) | `https://archive.org/details/MotocrossMadnessDemo` | DDRAW, DSOUND, DINPUT, DPLAYX, d3drm | Uses `d3drm.dll` + direct IM via QI (`D3DIM` string present). |
| `aoe/aoe_ex/Empires.exe` (AoE 1 demo) | `https://archive.org/details/AgeofEmpires_1020` | DDRAW, DSOUND, DPLAYX | 2D isometric, no 3D. |
| `aoe2/aoe2_ex/EMPIRES2.EXE` (AoE II AoK demo) | `https://archive.org/details/AgeofEmpiresIITheAgeofKings_1020` | DDRAW, DSOUND, DPLAYX, MSVFW32 | 2D isometric. |
| `abe/ex/AbeDemo.exe` (Oddworld: Abe's Oddysee demo) | `https://archive.org/details/Abes_Oddysee_demo` | DDRAW, DSOUND | 2D prerendered backgrounds + sprites. |
| `rct/English/RCT.exe` (RollerCoaster Tycoon demo) | `https://archive.org/details/RollercoasterTycoonDemo` | **no DDRAW**, DSOUND, DINPUT | Chris Sawyer hand-assembly engine — pure GDI SetDIBitsToDevice path. |
| `mw3/ex/Program_Files/mech3demo.exe` (MechWarrior 3 demo) | `https://archive.org/details/Mechwarrior3Demo` | DDRAW, DSOUND, DINPUT, DPLAYX, MFC42, AVIFIL32 | DX6 IM via QI on DDraw (no d3dim.dll or d3drm link). |
| `shareware/J2swc123.exe` (Jazz Jackrabbit 2 demo) | `https://archive.org/details/JazzJackrabbit2Demo` | — | InstallShield SFX; 7z cannot unpack. Not extracted yet. |
| `dx-sdk/bin/*.exe` + `dx-sdk/foxbear/` (DirectX 5 SDK prebuilt samples) | `https://archive.org/download/ms-dx5-sdk/DirectX5SDK.iso` | DDRAW, D3DIM, DSOUND, DINPUT | Mount ISO (`hdiutil attach`) and copy `/sdk/bin/*.exe` + `/foxbear/`. D3DIM verify gate: tunnel, twist, boids, globe, bellhop, viewer, flip3dtl, wormhole. DDraw-only: ddex1-5, flip2d, palette, stretch, donut, donuts, foxbear. |

MW3 extracted via `unshield x data1.cab`. Other SFX archives extracted with `7z`.

## Top-level binaries

| Binary | Notes |
|--------|-------|
| notepad.exe | Windows Notepad |
| calc.exe | Windows Calculator |
| mspaint.exe | MS Paint (Win98) |
| nt/mspaint.exe | MS Paint (NT) |
