# RollerCoaster Tycoon — Progress

**Binary:** `test/binaries/shareware/rct/English/RCT.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/rct/Data/` — CSG1.DAT, CSG1i.DAT, CSS*.DAT, etc.
**Window:** Fullscreen 640x480 8bpp (Chris Sawyer's custom engine)
**Status (2026-04-16):** WM_ACTIVATEAPP fix unblocked startup. Game loads all data files, maps CSG1.DAT (15MB) and CSS1.DAT (4.6MB), decompresses CSG sprites, enters main rendering loop. **Fixed:** `src/04-cache.wat` threshold check was `fn >= 270` but recent 16-bit opcode commit (b5b73ee) grew handler table to 280 — caused spurious `0xCAC4BAD0` "cache corruption" resets whenever the game used any 270–279 handler (looked like an infinite loop at `0x008fb473`, a sprite-blit fn). Raised check to `fn >= 280`. Game now runs its rendering copy loop (0x004446cb) cleanly; heap_ptr grows to 0x021becf8 (CSG1+CSS1 mapped). Browser should now show actual menu content instead of the clipped/broken dialog.

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

## Current status: reached splash/menu, idle event loop

The game now starts up fully. Prior "memory collision" and "stuck at 0x00440b9f" hypotheses were misreadings:

- `0x008fa065` — trivial CSG1I rebase loop (33244 iters `add [esi],eax; add esi,0x10; loop`). Default `--stuck-after=10` was too aggressive and aborted mid-loop. With `--stuck-after=500 --batch-size=10000` it completes.
- `0x00424f70` — sprite-table walker (8-byte entries; tag in `byte[esi]&0x3c`; recurses into `0x0042e252` for tag 5). Runs to completion.
- `0x00440b9f` — tail of a 5-slot queue-insert helper (`0x00440b29`) called from `0x00438ee8` with `al=0x46 ah=0xff`. **Not a hang** — it's just where the idle event loop's per-frame work most often ends a batch. The game is in its main message pump waiting for input.
- Browser run shows a splash/menu dialog painted via DirectDraw surface blits. Headless `--png` captures only the GDI-composited back-canvas (still teal desktop) because RCT's own rendering goes straight to the primary surface.
- Previous `0xCAC4BAD0` cache-corruption / thunk-zone overlap no longer reproduces — the earlier +32MB memory-layout relocation + guest-heap MapViewOfFile held.

**Next steps:**
1. Capture the DirectDraw primary surface in `--png` so we can see what dialog the game is showing.
2. Inject a click / ENTER via `--input=` to advance past the splash and see what the next phase does.
3. Revisit `--stuck-after` default handling — idle-loop detection should not abort when WM_NULL / timer messages are being pumped normally.

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
| 0x008FA065 | CSG1I index rebase loop (`add [esi],eax; add esi,0x10; loop` × 33244) |
| 0x00458720 | CSG data decompression function |
| 0x00424F70 | Sprite-table walk: 8-byte entries, tag in `byte[esi]&0x3c`, recursive call to 0x0042E252 for tag-5 |
| 0x0042E252 | Called from sprite-walk when tag nibble is 5 (sub-entries) |
| 0x00440B9F | Small 5-iter `xchg [esi+ecx*4+0xb0],eax` init (ECX 0..4); ends with `or [esi+0x45],1; pop ecx; ret`. Currently appears stuck — likely re-entered by outer loop. |

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
