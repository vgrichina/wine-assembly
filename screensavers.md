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
| WIN98.SCR | OK | Renders (Win98 logo on color quadrants) | Fixed by DDraw QueryInterface AddRef |
| WOTRAVEL.SCR | OK | Black (no animation) | Same COM dependency |

### DirectDraw-based (need DDRAW.DLL)
| Screensaver | /c Config | /s Visuals | Notes |
|-------------|-----------|------------|-------|
| WIN98.SCR | OK | Renders | DDraw QI AddRef fix |
| ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI | OK | Black (no animation) | All reach Direct3DRMCreate (returns E_FAIL); throw C++ exception. Need IDirect3DRM impl. |

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

Added `CLSIDFromProgID` stub returning `REGDB_E_CLASSNOTREG` (0x80040154) so the four COM-image screensavers degrade gracefully instead of `crash_unimplemented`. `IDirectDrawFactory` (ddrawex.dll CLSID 0x4FD2A832) short-circuited in `CoCreateInstance` and exposes 5 vtable methods (api_ids 1136–1140) that delegate to the existing DDraw wrappers.

## Completed

### InSendMessage / EnumWindows + ESP cleanup (6 DDraw screensavers)
**Files:** `src/09a-handlers.wat`, `tools/gen_api_table.js`
ARCHITEC/FALLINGL/GEOMETRY/JAZZ/OASAVER/ROCKROLL/SCIFI all crashed in MFC framework init at `call [0x744b22bc]` (USER32!InSendMessage IAT entry — these screensavers share a statically-linked framework at base 0x74400000). Implemented InSendMessage (returns FALSE — single-threaded emulator) and added EnumWindows (returns TRUE without invoking callback — caller's "duplicate instance" probe wants empty enumeration). Crucially, both handlers must `esp += 4 + nargs*4` to pop the return address pushed by `th_call_ind` AND the stdcall args — without that, ESP drifted by 4 each call and downstream code eventually jumped through a corrupted vtable into the PE header. After fix, all 7 reach Direct3DRMCreate in the message loop.

### DirectDraw QueryInterface refcount fix (WIN98.SCR)
**Files:** `src/09a8-handlers-directx.wat`
IDirectDraw::QueryInterface and IDirectDrawSurface::QueryInterface were returning the same object pointer but NOT incrementing the refcount. Per COM rules, QI must AddRef. After the guest called QI and subsequently Release, refcount dropped to 0 and the primary surface's DX_OBJECTS slot got freed. The next CreateSurface then reused slot 0 — so the "primary" guest wrapper actually pointed at an offscreen entry (flag=4), and Blt to the primary never triggered `dx_present`. With AddRef in both QIs, WIN98.SCR now renders its animation via SetDIBitsToDevice from the DDraw primary surface.

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
