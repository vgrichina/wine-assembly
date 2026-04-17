# RollerCoaster Tycoon — Progress

**Binary:** `test/binaries/shareware/rct/English/RCT.exe`
**Image base:** 0x00400000
**Data files:** `test/binaries/shareware/rct/Data/` — CSG1.DAT, CSG1i.DAT, CSS*.DAT, etc.
**Window:** Fullscreen 640x480 8bpp (Chris Sawyer's custom engine)
**Status (2026-04-16):** WM_ACTIVATEAPP fix unblocked startup. Game loads all data files, maps CSG1.DAT (15MB) and CSS1.DAT (4.6MB), decompresses CSG sprites, enters main rendering loop. **Fixed:** `src/04-cache.wat` threshold check was `fn >= 270` but recent 16-bit opcode commit (b5b73ee) grew handler table to 280 — caused spurious `0xCAC4BAD0` "cache corruption" resets whenever the game used any 270–279 handler (looked like an infinite loop at `0x008fb473`, a sprite-blit fn). Raised check to `fn >= 280`. **Also fixed:** `GetSystemPaletteEntries` now returns the real 20 reserved Win98 system colors (was zeroing the buffer). Did not change the PostQuit behavior — break-on-PostQuit still fires at batch 12473 with the same trace as before, so palette-entry detection is not what gates the quit. Still exits after ~6216 API calls / GAME.CFG 95-byte write.

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

## Current blocker: game PostQuitMessage's almost immediately after init

Trace summary (after the cache-guard fix shipped in 0004f79):

1. CRT/init/data-file discovery — all fine.
2. CSG1I rebase at 0x008fa065 completes (~33k iters).
3. CreateWindowExA creates `hwnd=0x10002 "RollerCoaster Tycoon"` 640x480 with menu ≠ 0 — *suspicious for a fullscreen DDraw game*.
4. DirectDraw chain: GetCaps → SetCooperativeLevel → SetDisplayMode → CreateSurface (primary) → CreateClipper → Clipper_SetHWnd → CreatePalette → SetPalette.
5. Second CreateSurface (offscreen) → LoadImageA (logo bitmap) → Restore → GetDC → BitBlt(GDI→DDraw surface) → ReleaseDC → SetColorKey → another CreateSurface → SetPalette → Lock/Unlock on something.
6. **CreateFileA("\\Data\\GAME.CFG", GENERIC_WRITE) → WriteFile(95 bytes) → PostQuitMessage(0)** — game saves a 95-byte config and exits cleanly.
7. Shutdown pump (PeekMessage/IsWindow/Translate/Dispatch ×4, DefWindowProc) drains.
8. After WinMain returns, EIP lands in a fill helper at 0x008fa0d5 with EDI=0, EDX=0xfffffeef (a 4-billion-iter spin) — looks like stale-register execution after an incorrect return target or CRT exit path that we mis-dispatch. Interpreter-visible infinite loop, not an RCT bug per se.

**Key observation:** `SetDIBitsToDevice` fires **exactly once** in the entire 49k-batch run (at the first Unlock, with `nonZero=false`). No frames are ever actually rendered to the back-canvas, which is why the PNG stays black. The game quits before it ever presents real content.

**Why it quits is the real mystery:**
- The 95-byte GAME.CFG write is a config-save. RCT demo's WinMain probably saves cfg whenever WinMain unwinds.
- PostQuitMessage(0) = graceful exit. Something in our environment convinces the game to take the exit branch before it ever runs a real frame.
- Likely suspects: a) WM_ACTIVATEAPP delivered with wParam=FALSE, b) a COM call returning a failure HRESULT that RCT treats as "DirectDraw unavailable, abort", c) GetSystemPaletteEntries returning zeros, making palette detection fail (rct.md prior note mentioned this), d) a malformed surface desc for the offscreen surface causing the image-blit step to set a fatal flag.

**Call chain into PostQuitMessage** (dumped via new `API BREAK ENTRY` stack walk in `test/run.js`):

```
ret=0x004045bb     ; AppExit wrapper at 0x004045ad — just "push 0; call [PostQuitMessage]"
└ called from 0x00555b7a — quit helper at 0x00555b75:
    call 0x00452345   ;; checks [0x5a93d4], runs 5 shutdown calls, sets flag
    call 0x004045ad   ;; -> PostQuitMessage(0)
    ret
└ called from 0x00555aea inside a longjmp-style trampoline at 0x00555ae0:
    mov dword [0x560194], 1          ;; fatal-exit flag
    call 0x00555b75                  ;; run shutdown + PostQuitMessage
    mov esp, [0x008d8fac]            ;; *** longjmp: restore saved ESP ***
    pop ebp ; ret
```

So RCT is taking a `longjmp`-based **fatal-exit** path — the `mov esp,[0x8d8fac]` at `0x00555aef` is the giveaway. The game registered a `setjmp` target early in startup (the saved ESP+EBP live at `[0x8d8fac]`/`[0x8d8fa8]`-ish); somewhere in the DDraw/logo-blit sequence it decides something is unrecoverable, raises the fatal flag at `[0x560194]`, and longjmps out. The 95-byte GAME.CFG write happens inside `0x00452345`'s shutdown chain, not as cause of exit.

**To find *why* the longjmp fires:** watch on `[0x008d8fac]` to find the **setjmp** point (should be reached exactly once during init, likely right after WinMain's main-try entry), then watch on `[0x560194]` (currently 0 → becomes 1) to find the **raise** site. The latter is the real culprit branch.

**Raise site located (2026-04-16, after 84236e4).** `--watch=0x560194 --watch-value=0x1` fires at batch 12473. Two fatal-exit trampolines exist, both pattern `mov [0x560194],1 ; call 0x555b75 ; mov esp,[0x8d8fac] ; pop ebp ; ret`:

| Entry | Raise instruction | Error-code regs |
|---|---|---|
| 0x00555a84 (or nearby, via call)  | `mov [0x560194],1` at 0x00555a9f | uses BX error ID |
| 0x00555ab6 (entered via `jmp`)    | `mov [0x560194],1` at 0x00555ae0 | uses EAX,EBX pair |

RCT takes the **second** one. Call site: **0x009026dc — `jmp 0x555ab6`** after setting `EAX=0x344, EBX=0x346` (error-message string IDs). This is inside a **video-mode probe chain** at 0x009026af:

```
0x009026af  call 0x8fa000         ; init
0x009026b4  call 0x457d3c
0x009026b9  call 0x90252c
0x009026be  mov  al, [0x56fd6b]   ; currently-chosen mode flag
0x009026c3  cmp  al, 0xff ; jnz +2 ; mov al, 1     ; default to mode 1
0x009026c9  call 0x9024b4         ; TRY the selected mode
0x009026ce  or   al, al
0x009026d0  jnz  0x9026e1         ; success → continue init
0x009026d2  mov  eax, 0x344
0x009026d7  mov  ebx, 0x346
0x009026dc  jmp  0x555ab6         ; FATAL EXIT
```

`0x009024b4` dispatches on `al` (1/2/3 branches) and ultimately calls `0x00401220(mode_id)` with `mode_id ∈ {1,3,4,5}`. That callee returns nonzero on success; `[0x56fd6b]` records which mode succeeded. **Our DDraw returns 0/failure for every mode**, so the chain falls through to the fatal `jmp`.

`0x00401220` prologue reads `[0x560100]` (a handle — probably an existing surface/DD object) and calls through IAT slot `[0x562dd4]` before continuing at `0x00401416`. That IAT slot is the video-mode setup import (likely `SetDisplayMode` or `CreateSurface`), and its return is what ultimately decides success.

**Next concrete steps:**
1. `--break=0x00401220` + dump EIP trail: see what mode ids get tried and what return value lands in AL at `0x009024d1`/`0x9024fa`/`0x902522`.
2. Check `[0x00562dd4]` — **NOT an IAT entry**. The .data section is 0x560000-0x56aeb4; PE imports live at RVAs 0x15e000-0x15e2ff (IAT bases for USER32/GDI32/KERNEL32/DINPUT/DPLAYX/DSOUND/etc. are all 0x15e000+). `[0x00562dd4]` is a **runtime-populated function pointer**, set by earlier init code. Find its writer via a store-watch on 0x562dd4 before this code runs.
3. Compare DDraw return chain (SetCooperativeLevel, SetDisplayMode, CreateSurface primary) HRESULTs against real Win98 to find the one we're getting wrong.

**API sequence right before quit** (from `--break-api=PostQuitMessage --trace-api`):
```
#6188 GetSystemPaletteEntries(hdc, 0,   10, buf)
#6189 GetSystemPaletteEntries(hdc, 246, 10, buf)
#6213 CreateFileA("\\Data\\GAME.CFG", GENERIC_WRITE, ..., CREATE_ALWAYS)
#6214 WriteFile(h, buf, 0x5f)           ;; 95-byte config
#6216 PostQuitMessage(0)
```
So whatever decision the game makes, it makes it in the ~24 blocks between the second GetSystemPaletteEntries return and the GAME.CFG write. Not the palette call itself (we now return proper data and PostQuit still fires at the same batch).

**Next steps:**
1. Break at CreateFileA for GAME.CFG-write (filter `str="\Data\GAME.CFG"` *AND* `arg1==0x40000000`) and walk back guest stack to find the decision site.
2. Try `--break=0x005c2b1a` (return site listed by trace) and step backwards through block cache to find the branch that led into the exit path.
3. Revisit COM HRESULTs: any of the 4 `CreateSurface`, `Restore`, `SetColorKey`, `Lock/Unlock`, `BitBlt` calls in the offscreen-logo setup could return a non-OK HRESULT we're miscomputing. Dump all DDraw call returns in the 0-6213 API range and compare against real Win98 expected values.
4. Once quit is avoided, revisit why the render-copy loop writes aren't landing in the primary DIB (the `nonZero=false` from the only Unlock).

## Prior status (resolved)

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
3. **Fix GetSystemPaletteEntries** — DONE (2026-04-16). Now returns standard 20 reserved system colors for indices 0-9 and 246-255.
4. **Verify palette update** — once rendering works, confirm SetEntries loads the real palette
