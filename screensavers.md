# Plus! 98 Screensavers — Progress

**Binaries:** `test/binaries/screensavers/` (19 screensavers from Plus! 98)
**Command-line:** `/s` = run screensaver, `/c` = config dialog, `/p <hwnd>` = preview
**Status:** Config dialogs work for all. Visual mode (`/s`) renders for 4/7 GDI screensavers with working sprite compositing. 5 MFC42 screensavers reach message loop. 7 DirectDraw screensavers require DDRAW support (deferred).

## Categories

### Pure GDI (no DLL deps beyond KERNEL32/USER32/GDI32/ADVAPI32)
| Screensaver | /c Config | /s Visuals | Notes |
|-------------|-----------|------------|-------|
| PEANUTS.SCR | OK | Renders, sprites working | Sprite compositing fixed |
| CATHY.SCR | OK | Renders, sprites working | Sprite compositing fixed |
| DOONBURY.SCR | OK | Renders, sprites working | Sprite compositing fixed |
| FOXTROT.SCR | OK | Renders, white silhouettes | Mask inversion issue |
| GA_SAVER.SCR | OK | Crashes on PlaySoundA | Needs WINMM stub |
| CITYSCAP.SCR | OK | Blank (no drawing) | Uses CreateDIBSection/StretchDIBits for rendering |
| PHODISC.SCR | OK | Blank (no drawing) | Likely same CreateDIBSection issue |

### MFC42-based (need MFC42.DLL)
| Screensaver | /c Config | /s Visuals | Notes |
|-------------|-----------|------------|-------|
| CORBIS.SCR | OK | Black (no animation) | Needs COM — CoCreateInstance for image loading fails |
| FASHION.SCR | OK | Black (no animation) | Same COM dependency |
| HORROR.SCR | OK | Black (no animation) | Same COM dependency |
| WIN98.SCR | OK | Black (no animation) | Loads bitmap, then needs DirectDraw |
| WOTRAVEL.SCR | OK | Black (no animation) | Same COM dependency |

### DirectDraw-based (need DDRAW.DLL)
ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI, WIN98 — blocked on DDRAW

## Open Tasks

### 1. Fix FOXTROT white silhouettes
**Priority: LOW** — Only affects FOXTROT (PEANUTS/CATHY/DOONBURY now work)
Mask inversion issue — sprites render as white silhouettes instead of colored characters.

### 2. Stub PlaySoundA for GA_SAVER
**Priority: LOW** — GA_SAVER crashes on PlaySoundA. Needs to be added to api_table.json and stubbed to return TRUE.

### 3. Implement CreateDIBSection / StretchDIBits rendering path
**Priority: MEDIUM** — Needed for CITYSCAP and PHODISC
**Files:** `src/09a-handlers.wat`, `lib/host-imports.js`

These screensavers use CreateDIBSection to create bitmaps with direct pixel access, then StretchDIBits to blit them. StretchDIBits is implemented but may have issues. CreateDIBSection needs a working `ppvBits` return (pointer to pixel data in guest memory).

### 4. MFC screensavers blocked on COM/DirectDraw
**Priority: DEFERRED** — CORBIS/FASHION/HORROR/WOTRAVEL call `CoCreateInstance` to load images via COM (likely IPicture). Our stub returns E_NOINTERFACE, so no images load and no timer is ever set. WIN98.SCR now runs its animation loop (fixed IDirectDraw2 SetDisplayMode stack corruption and implemented IDirectDrawSurface::GetDC) but DDraw surface content is not yet rendered to screen — needs DDraw-to-renderer blitting. All 5 MFC screensavers reach the message loop correctly (CBT hook fix works) but have no visible animation content.

## Completed

### Sprite rendering fix (PEANUTS, CATHY, DOONBURY)
**Files:** `lib/host-imports.js`
Fixed SRCAND/SRCPAINT compositing for transparent sprite technique. Black silhouettes → correct colored sprites.

### MFC42 screensavers — CBT hook stack fix (CORBIS, FASHION, HORROR, WIN98, WOTRAVEL)
**Files:** `src/09b-dispatch.wat`
CACA0002 (CBT hook continuation) was missing saved_ret/saved_hwnd pushes before WndProc args. After wndproc returned via `ret 0x10`, CACA0001 read garbage as the return address. Fixed by pushing saved state below WndProc args, matching the no-hook path.

### THREAD_BASE memory layout fix
**Files:** `src/01-header.wat`, `src/13-exports.wat`
THREAD_BASE was 0x01D52000 (inside thunk zone). Fixed to 0x01E52000 (after THUNK_END).

### Previous session

### GetClipBox — implemented
**Files:** `src/09a-handlers.wat`, `src/01-header.wat`, `lib/host-imports.js`
Was `crash_unimplemented`. Now queries DC dimensions via `host_gdi_get_clip_box` host import. Returns SIMPLEREGION (2). Handles window DCs (client area) and memory DCs (selected bitmap size).

### Timer ID 0 fix
**Files:** `src/09a-handlers.wat`, `src/01-header.wat`
Screensavers call `SetTimer(hwnd, 0, interval, 0)` with timerID=0. The timer table used id=0 as "empty slot" sentinel, so timer never fired. Fixed: empty slots now detected by hwnd=0 (always non-zero for valid timers). Auto-generates unique IDs starting at 0x1000 when caller passes timerID=0.

### SetStretchBltMode — implemented
Was `crash_unimplemented`. Returns BLACKONWHITE (1) as previous mode. No-op otherwise.

### GetBkColor / GetTextColor — implemented
**Files:** `src/09a-handlers.wat`, `src/01-header.wat`, `lib/host-imports.js`
Both were `crash_unimplemented`. Now query DC state via host imports.

### GdiFlush — implemented
**Files:** `src/09a-handlers.wat`, `src/api_table.json`
Added to API table (id=972). No-op, returns TRUE.
