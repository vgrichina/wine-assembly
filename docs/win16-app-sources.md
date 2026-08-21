# Win16 Entertainment Pack source provenance

This document records the source and byte-level verification for the three
Entertainment Pack files repaired locally on 2026-08-20. Internet Archive is
the primary source. WinWorld is used only as an independent raw-media
cross-check. The game corpus under `test/binaries/` is intentionally ignored by
Git, so these hashes are the reproducible record for restoring the local files.

## Primary Internet Archive sources

- [Microsoft Entertainment Pack Volume 2 IBM PC Floppy Image](https://archive.org/details/000210-MicrosoftEntertainmentPackVolume2)
  (`000210-MicrosoftEntertainmentPackVolume2`), described by the archive as two
  verified 720 KB raw images. Downloaded file:
  `000210_microsoft_entertainment_pack_vol_2.7z`, SHA-256
  `8ba04ff48e94926b3da788187e00beb46762f6793a03e8b8e0f54ad29a617f72`.
  Its image SHA-256 values are
  `a695a6e85fa33ed98f720b03a1871fb62569fd7f04b653e4b882f0aab2465007`
  (`disk1.img`) and
  `24bcb2a7b3e5dc23e26dab09ca2c49fec10ac951374450dde3b5ea55303f0d1d`
  (`disk2.img`).
- [Microsoft Entertainment Pack Volume 3 IBM PC Floppy Image](https://archive.org/details/000209-MicrosoftEntertainmentPackVolume3)
  (`000209-MicrosoftEntertainmentPackVolume3`), described as one verified
  720 KB raw image. Downloaded file:
  `000209_microsoft_entertainment_pack_vol_3.7z`, SHA-256
  `cd8af5710c7dde4d4cd458d64976bb2b068d71d7b14e9353c5e8f3f97c9d4e14`.
  `disk1.img` SHA-256 is
  `db8a9a7f562811ded65d260ff910845fe5544aceb0cd819ac4c69f5e204b1adc`.
- [Microsoft Entertainment Pack Volume 4 IBM PC Floppy Image](https://archive.org/details/001744-MicrosoftEntertainmentPackVolume4)
  (`001744-MicrosoftEntertainmentPackVolume4`), two 720 KB raw images.
  Downloaded file: `001744_microsoft_entertainment_pack_volume_4.7z`,
  SHA-256
  `3fa380c0276023c857fd57464d1a719d566e2345b2885d64cf000e4a354627ed`.
  Image SHA-256 values are
  `fa1a690d7d868231a4ebfb38e74d2435f8afae462d1a7299c75593a6ae76f2f6`
  (`disk01.img`) and
  `c819f6eee24c9aa77f890f29b95eaf5c380d4640b1b3a65de1cb1ee1c1d22e2e`
  (`disk02.img`).
- [Microsoft Entertainment Pack Volumes 1-4, unpacked](https://archive.org/details/wep_20200803)
  (`wep_20200803`). `WEP.zip` SHA-256 is
  `2be1a70d849afbdeae73260fdccfcce8a49bdbed85b2d8882ab1f4acfc49f31c`.
  The separately supplied `FUJIGOLF.DAT` is 24,624 bytes with SHA-256
  `4c8d598c737dbc995af8dc7cbb0bcd64126f488b8d55befa6f1a8d0d54861701`.
- [Rodent's Revenge standalone archive](https://archive.org/details/rodents-revenge)
  (`rodents-revenge`) was used as an independent extracted-file check.
  `rodents-revenge.zip` SHA-256 is
  `3a34c605d74a462cb8ecf73bbc6aa0236a0fda270e8d6550058d732a91d77007`.

## Recovered local files

| Local file | Size | SHA-256 | Verification |
| --- | ---: | --- | --- |
| `test/binaries/wep16/WEP2/RODENT.EXE` | 56,424 | `57b693794b83738353a3e561fb54cfb621b443a2f6375bd6814e5db06dbc6fae` | Identical in both Internet Archive extracted collections above. The previous local file (`0d9831289302435f88eb22151d8d1589506dc3ed95c153835616f1ab5439c8f6`) differed in 802 byte positions and raised Visual Basic “Subscript out of range.” |
| `test/binaries/wep16/WEP3/FUJIGOLF.EXE` | 253,952 | `fa26bef5b3768a01898180f5edc794d6f104412b39be9ba110821e35af8111f0` | Existing executable is identical to the Internet Archive unpacked copy; no executable replacement was needed. |
| `test/binaries/wep16/WEP3/FUJIGOLF.DAT` | 24,624 | `4c8d598c737dbc995af8dc7cbb0bcd64126f488b8d55befa6f1a8d0d54861701` | Restored from the separate file in `wep_20200803`; the Volume 3 raw image independently contains the installer-compressed `BIN/FUJIGOLF.DA$`. |
| `test/binaries/wep16/WEP4/TICTACDP.EXE` | 120,864 | `1cc429e6e8f9928c799b7cdf187ad41e5100a3f70e30194729ad685ea6619b2d` | Internet Archive unpacked copy is byte-identical to the file expanded from the Volume 4 raw disk. The previous local file (`e28bfa2eac85e5d0df9ae2099852ecbc02b3250012e710d0541b84f64e3f6049`) differed in 1,470 byte positions and raised Visual Basic “Division by zero.” |
| `test/binaries/wep16/WEP4/TicTacDp.brd` | 189 | `072e63a61a16825b6483d0717d3bc9b9a2147b77107464f0551305f55411543c` | Existing board data is byte-identical to the Internet Archive unpacked copy; no replacement was needed. |

## Independent raw-media and extraction checks

The corresponding [WinWorld Volume 2](https://winworldpc.com/product/microsoft-entertainm/2),
[Volume 3](https://winworldpc.com/product/microsoft-entertainm/3), and
[Volume 4](https://winworldpc.com/product/microsoft-entertainm/4) downloads were
used only as secondary checks. Every WinWorld disk image compared byte-for-byte
equal to the corresponding Internet Archive image listed above. Their container
SHA-256 values were, respectively,
`c9e80a20060d15d6edf46fe09deb790688b93d7a1329b2bb6b81a999b8c2b257`,
`380c2ddd7a96b57c31ad23ab476e20ef5a6e49ec0baa6475521e0b57379c597e`,
and `e71b7a70f79e005ff6af8dd0d2f3ea9f97ac3c888a5cbfd0c057998b84eb107d`.

The Volume 4 KWAJ/SZDD payload was expanded with
[libmspack](https://github.com/kyz/libmspack) 0.11alpha (`msexpand`). The source
archive used to build that diagnostic tool had SHA-256
`8fa80dd7f038cd2ccad381f5bcdf7290a49fcb3c432ff0912f33c086e3a4be42`.
The expanded `TICTACDP.EXE` hash was the same as both Internet Archive copies
recorded above. No output from this tool or from WinWorld is committed.

## Pipe Dream Help format evidence

The primary application artifact for the Pipe Dream Help repair is `PIPE.HLP`
from the [Internet Archive Volume 2 disk-image item](https://archive.org/details/000210-MicrosoftEntertainmentPackVolume2)
listed above. The local file is 21,418 bytes with SHA-256
`6bf9c13daeedb6008f2ff2e85bbba7e5d213780cf6d6bfd6647c123581148fdd`.
Its `|SYSTEM` stream identifies compiler format minor version 15 (HC30), and
its `|TOPIC` stream contains 12 titled topics plus the compiler's empty final
topic-header sentinel. Its 116-byte `|TOMAP` stream has the INDEX topic at
slot 0, unused zero slots 1–15, and twelve physical topic positions at slots
16–27: `12, 573, 1328, 3233, 5112, 6026, 7110, 7357, 7687, 8346, 8804,
9015`. The visible Overview link in the INDEX topic stores topic number 17;
therefore its detail target is `|TOMAP[17] = 573`, not byte position 17.

The technical interpretation is cross-checked against HelpDeco's
[Windows Help File Format](https://github.com/joncampbell123/helpdeco/blob/master/doc/html/Windows%20Help%20File%20Format.htm),
an independently reverse-engineered description of the undocumented WinHelp
format. It specifies that HC30 uses 2 KB topic blocks, relative `PrevBlock` and
`NextBlock` byte distances that include skipped physical headers, and record
type 1 for displayable text; HC31 uses absolute topic positions and record type
`0x20`. Those distinctions are the parser behavior exercised by the checked-in
synthetic regression and the original `PIPE.HLP` diagnostic. The same format
reference documents the hyperlink-specific rule: HC30 topic numbers begin at
16 and index `|TOMAP` directly without subtracting 16, while slot 0 is the
special INDEX topic. That rule is exercised by both a real `PIPE.HLP` parser
test and the browser click-through test that opens Overview details.

## Help viewer interaction references

The Internet Archive Volume 2 item and its byte-identical `PIPE.HLP` remain the
primary evidence for the application, its topics, and its link/scroll extent.
The viewer integration follows these Microsoft window-manager references:

- [WM_SIZE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-size)
  defines `LOWORD(lParam)` and `HIWORD(lParam)` as the new client width and
  height. The Help viewer uses those dimensions to rewrap the retained topic,
  move its navigation row, invalidate the whole client, and repaint.
- [Invalidating the Client Area](https://learn.microsoft.com/en-us/windows/win32/gdi/invalidating-the-client-area)
  documents that invalidating all or part of a client area schedules the
  corresponding `WM_PAINT`; the resize path invalidates the complete viewer.
- [SCROLLINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-scrollinfo)
  defines the standard range, page, position, and drag position fields.
  [SetScrollInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setscrollinfo)
  further specifies the useful maximum position as
  `nMax - max(nPage - 1, 0)`. The viewer publishes topic pixels as this standard
  state, letting the shared non-client scrollbar handle arrows, pages, and
  thumb tracking.
- [WM_SETCURSOR](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-setcursor)
  defines the low word of `lParam` as the hit-test code and says a handler
  returns true after choosing the cursor. Microsoft’s
  [Using Cursors](https://learn.microsoft.com/en-us/windows/win32/menurc/using-cursors)
  likewise identifies `WM_SETCURSOR` as the place to select a cursor for a
  condition. The Help viewer selects the system `IDC_HAND` while a retained
  hotspot or navigation link is under the pointer and restores `IDC_ARROW`
  elsewhere.

## Pipe Dream About-dialog evidence

The primary application source is again the
[Internet Archive Volume 2 disk-image item](https://archive.org/details/000210-MicrosoftEntertainmentPackVolume2).
The archive describes two verified 720 KB raw disks from Microsoft
Entertainment Pack Volume 2 version 1.0. The extracted files used by the
regression are:

| File | Size | SHA-256 |
| --- | ---: | --- |
| `test/binaries/wep16/WEP2/PIPE.EXE` | 124,960 | `877698244e2d9ecad690d9311a04eb40286f8f3cf20cc3b7d457a685c976a597` |
| `test/binaries/wep16/WEP2/WEPUTIL.DLL` | 19,200 | `7bd426e4d1ca0afea88e5ad22d9add44d4df79432cdc4b5cb165c10c6023e6bd` |

The local NE resource audit found Pipe Dream's `RT_GROUP_ICON` 99 and its
three 32x32 `RT_ICON` images in `PIPE.EXE`. `WEPUTIL.DLL` supplies the About
template (dialog 100, 140x128 dialog units), the 259x64 logo bitmaps 666
(4-bpp) and 999 (1-bpp), and the owner-draw logo control. Its dialog procedure
loads Pipe icon 99, sends Win16 static message `0x0400` to zero-sized
`SS_ICON` control 701, and creates the 260x65 owner-draw logo panel at dialog
position 10,10.

A reviewed Windows 98 oracle was captured with the repository's v86 harness.
The 640x480 screenshot SHA-256 is
`d332b9310714d1a423d2e43df49ab8cef32bb6712c6dcfd854da721745103c44`.
It measures the outer dialog at 285x280 pixels, the 140x128-DLU client at
280x256 pixels, the panel at 260x65, and the assigned Pipe icon at 32x32.
That establishes an 8x16 Win16 system-font base and 5x24 top-level non-client
extent for this template. The capture used v86 `0.5.432+gf3d4472`
([upstream commit](https://github.com/copy/v86/commit/f3d4472a9c934b9ad78a311f5849ba711a296d23)),
its SeaBIOS and VGA BIOS at that commit, and the harness's documented
[Windows 98 disk](https://i.copy.sh/windows98/.img) and
[saved state](https://i.copy.sh/windows98_state-v2.bin.zst). Those images are
reference-environment inputs only; the Internet Archive WEP2 disks remain the
primary source for every application byte and resource assertion.

The API behavior is cross-checked against Microsoft's documentation:

- [GetDialogBaseUnits](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getdialogbaseunits)
  defines the low/high words as horizontal/vertical system-font base units and
  gives the `MulDiv(x, baseX, 4)` / `MulDiv(y, baseY, 8)` conversion used here.
- [LoadIcon](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-loadicona)
  identifies the application instance as the module containing a named or
  ordinal icon resource. The Win16 bridge therefore retains the NE module and
  resource id together instead of flattening every icon to one opaque handle.
- [STM_SETICON](https://learn.microsoft.com/en-us/windows/win32/controls/stm-seticon)
  places the icon handle in `wParam`, leaves `lParam` unused, and associates it
  with the static icon control. The focused regression exercises the original
  WEPUTIL call and verifies both the 32x32 control state and visible icon
  pixels.

The Win98 oracle selects WEPUTIL's 4-bpp logo 666 after its DLL initialization
checks display color capability. The runtime currently renders the DLL's valid
1-bpp fallback 999 because general Win16 DLL entry-point (`LibMain`) execution
is not yet modeled. This is a recorded palette-fidelity difference, not a
layout, clipping, icon, or control-visibility failure.
