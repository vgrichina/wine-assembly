# RollerCoaster Tycoon — Progress

**Binary:** `test/binaries/shareware/rct/English/RCT.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/rct/Data/` — CSG1.DAT, CSG1i.DAT, CSS*.DAT, etc.
**Window:** Fullscreen 640x480 8bpp (Chris Sawyer's custom engine)
**Status (2026-04-16):** WM_ACTIVATEAPP fix unblocked startup. Game loads all data files, maps CSG1.DAT (15MB) and CSS1.DAT (4.6MB) via MapViewOfFile, decompresses CSG sprites, enters main rendering loop. Crashes due to memory layout collision — game's large data writes (CSG decompression + rendering copy loop) overflow into emulator-private regions (thread cache, thunks). Memory layout relocated +32MB and MapViewOfFile changed to use guest heap, but game still reaches thunk zone. Need further investigation of how the game computes its large buffer destination addresses.

## What works

- CRT startup, registry, file system setup
- WM_ACTIVATEAPP/WM_ACTIVATE delivered synchronously during CreateWindowExA (CACA0020-0023 thunks)
- DirectDraw: DirectDrawCreate, EnumDisplayModes, SetCooperativeLevel, SetDisplayMode(640,480,8), CreateSurface (primary + 2 offscreen), CreateClipper, CreatePalette, SetPalette, Lock/Unlock
- DirectPlay: DirectPlayEnumerate (stub)
- DirectInput: CreateDevice (keyboard + mouse), SetDataFormat, GetDeviceState, SetCooperativeLevel, Acquire
- VFS: All data files load via root-relative paths (`\Data\CSG1.DAT`). Sibling dirs (Data/, Scenarios/, Saved Games/) mapped from parent.
- Registry: Demo key `HKLM\Software\Fish Technology Group\RollerCoaster Tycoon Demo Setup` with Path=`C:\`
- Scenario loading: SC.IDX index + 9 .SC4 scenario files enumerated via FindFirstFile(`\Scenarios\*.SC4`)
- CSG1.DAT memory-mapped via MapViewOfFile (15MB), CSG1I.DAT index processed and rebased
- CSS1.DAT memory-mapped (4.6MB sound data)
- CSG sprite decompression runs to completion (~50K batches)
- Main rendering/tick loop enters and runs (InterlockedExchange-based frame sync, mm_timer callback)
- Custom cursors loaded from PE resources (20+ LoadCursorA calls)
- GAME.CFG read/write
- Message loop: PeekMessage/TranslateMessage/DispatchMessage

## Current blocker: memory layout collision

The game's rendering copy loop (0x00444600-area) writes data to addresses that collide with emulator-private regions (thread cache at WASM 0x03E52000). The `0xCAC4BAD0` cache corruption marker fires, then EIP goes to 0 or garbage.

**What was tried:**
1. Relocated all emulator internal regions +32MB (GUEST_STACK 0x01C12000→0x03C12000, THUNK_BASE 0x01E12000→0x03E12000, etc.)
2. Changed MapViewOfFile to allocate from guest heap (via `guest_alloc`) instead of high MAP_ALLOC zone

**Why it still fails:** The crash destination (ESI) tracks the relocation — it moved by exactly 32MB when we moved internal regions 32MB. This means the game computes the destination address relative to something that changes with our layout. Likely candidate: the CSG1I.DAT index rebase loop at 0x008FA065 adds a base address (from MapViewOfFile or similar) to each index entry. If that base comes from a pointer that's near the thunk zone, the rebased entries point into the thread cache.

**Key observation:** `heap_ptr` reaches 0x021becf8 after mapping CSG1.DAT (15MB) + CSS1.DAT (4.6MB). The copy loop writes to ESI~0x042889e4 which is past heap_ptr but in the thunk zone (thunk_guest_base=0x04200000). There must be additional large allocations not tracked, or the game computes addresses by adding offsets to a thunk-derived pointer.

**Possible fixes:**
- Increase WASM memory beyond 128MB to push internal regions higher
- Trace the exact origin of the copy loop destination pointer (ESI at 0x00444600)
- Check if game uses GetModuleHandle/GetProcAddress return values as base addresses for data access

## Key addresses

| Address | Description |
|---------|-------------|
| 0x00403C7D | WndProc |
| 0x00403B2E | PeekMessage-based message check (called from main loop) |
| 0x004010FC | Main function: calls init check, game init, game tick loop |
| 0x00438248 | Main game tick function |
| 0x0042F5A5-0x0042F5D9 | CSG sprite decompression inner loop |
| 0x00444600-0x0044463E | Rendering copy loop (memcpy-like, fires per frame) |
| 0x0040C7A6 | mm_timer callback (InterlockedExchange at 0x00562F2C) |
| 0x008FA065 | CSG1I index rebase loop |
| 0x00458720 | CSG data decompression function |

## DirectX usage

RCT uses DirectDraw for display mode selection and surface management, but its rendering is custom x86 asm blitting to the DD surface:
- **DirectDraw** — SetDisplayMode(640,480,8), CreateSurface (primary+2 offscreen), Lock/Unlock, palette, SetDIBitsToDevice for presentation
- **DirectSound** — sound effects (CSS*.DAT sound banks)
- **DirectInput** — keyboard and mouse via GetDeviceState
- **DirectPlay** — multiplayer enumeration (stub)

## COM objects

| Guest addr | Slot | Type | Notes |
|-----------|------|------|-------|
| 0x083e0000 | 0 | DDraw | Main DirectDraw object |
| 0x083e0008 | 1 | DInput | DirectInput object |
| 0x083e0010 | 2 | DIDevice | Keyboard |
| 0x083e0018 | 3 | DIDevice | Mouse |
| 0x083e0020 | 4 | DDSurface | Primary (640x480x8) |
| 0x083e0028 | 5 | DDClipper | Window clipper |
| 0x083e0030 | 6 | DDPalette | 256-entry palette |
| 0x083e0038 | 7 | DDSurface | Offscreen 1 (icon bitmap) |
| 0x083e0040 | 8 | DDSurface | Offscreen 2 (game buffer) |

## Next steps

1. **Trace copy loop destination** — instrument 0x00444600 to log ESI source; find which allocation or computation produces the thunk-zone address
2. **Fix memory collision** — either increase WASM memory to 256MB, or find and fix the pointer that leads into the thunk zone
3. **Fix GetSystemPaletteEntries** — return standard Win98 20 system colors instead of zeros
4. **Verify palette update** — once rendering works, confirm SetEntries loads the real palette
