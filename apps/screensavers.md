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
| GA_SAVER.SCR | OK | Renders (Garfield/Odie on pogo sticks) | PlaySoundA already stubbed — stale note |
| CITYSCAP.SCR | OK | Blank (spins in GetMessageA, no render) | Not a DIBSection blit issue; see Open Task 3 |
| PHODISC.SCR | OK | Desktop teal (no photo content) | DIB blit no longer wipes canvas; asset-load path still missing |

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
| ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI | OK | Black (no animation) | "No valid modes" throw FIXED (sessions e/f/g/h 2026-04-18). All 7 now run 1500+ batches past the throw into the D3D rendering loop. Screen stays black because actual D3D geometry/texture rendering is stubbed — deeper work, see Open Task 5. |

## Open Tasks

### 1. Fix FOXTROT white silhouettes
**Priority: LOW** — Only affects FOXTROT (PEANUTS/CATHY/DOONBURY now work)
Mask inversion issue — sprites render as white silhouettes instead of colored characters.

**Session 2026-04-20 investigation (inconclusive).** Traced through AND+PAINT compositing pipeline in `lib/host-imports.js` with pixel-level sampling of each step:
- Two bitmap resources loaded: 1500x235 (8bpp, 69-color palette — used for biplane animation) and 225x80 (8bpp, only **3** non-zero palette entries: 0=white, 1=gray, 2=maroon-bg).
- Mono→color expansion for SRCAND is correct: bit 0→destDC.textColor, bit 1→destDC.bkColor. Verified sprite-sheet preprocessing clears bg to 0 and preserves sprite pixels.
- RLE8 decode is correct: center of the 75x80 character sub-sprite in the 225x80 sheet decodes to palette idx 0, which IS white in the source palette.
- 1500x235 biplane renders correctly in full color (visible at top of output PNG).

Conclusion: the small 75x80 character sprites genuinely only have white/gray/maroon pixels in the source art. The rendered "white silhouettes" may be faithful to the source. Either (a) real Windows rendered these characters differently via dynamic palette mapping / SelectPalette+RealizePalette we don't emulate, or (b) the visual is intended and the note was a misdiagnosis. No blit-path fix applies — leaving as-is pending a reference screenshot of the original.

### 2. ~~Stub PlaySoundA for GA_SAVER~~ — DONE (already stubbed; GA_SAVER renders)

### 3. CITYSCAP/PHODISC — why DIB is never populated
**Priority: MEDIUM**
**Files:** `lib/host-imports.js`, CITYSCAP/PHODISC app logic

**Session 2026-04-20 — dibSection resync fix (committed).** `_syncDibSection` used to blindly rebuild the bitmap canvas from guest memory on every BitBlt source resolution. Apps that draw into a DIB section's DC via GDI primitives keep the guest bits at zero, so each subsequent blit wiped the canvas back to black. Fixed by sparse-hashing 256 sample bytes of the guest buffer per sync; skip when unchanged from last hash. Creation-time records the zero-state hash so a GDI-only app is never resynced.

- **PHODISC.SCR** — was fully black, now shows the desktop teal background. Photo content still missing (asset-load path not traced yet).
- **CITYSCAP.SCR** — still black. Root cause is NOT the DIB blit: app spins in GetMessageA (~8000 of 27K total API calls over 2000 batches) with no SetTimer/InvalidateRect ever firing. Its render function never runs. Separate investigation — probably missing a startup message or config-registry read that enables the render path.
- **PEANUTS.SCR regression-tested** — renders correctly (Snoopy/Woodstock scene unchanged).

### 5. D3D screensavers: render pipeline (was "No valid modes")

**Status (2026-04-20):** "No valid modes" throw is fixed (sessions e/f/g/h in prior log). All 7 D3D savers now run 1500+ batches through DDraw + IDirect3D2::EnumDevices + CreateDevice + the per-frame Blt loop without crashing. They produce black frames because the D3D rendering path itself (vertex processing, texture sampling, rasterization) is stubbed — the sub-calls execute but don't commit pixels anywhere. Next work here is not a single fix but a full Direct3D IM render pipeline (out of current session scope).

**Historical log below.**

**Status (2026-04-18):** `MessageBox("Couldn't find any scene definitions…")` was hiding a real emulator bug. With `.SCN`/`.X`/`.GIF` assets staged in `test/binaries/screensavers/` (see `SOURCES.md`), the saver's `FindFirstFileA(".\\*.scn")` now succeeds and D3D init runs further — but the `CA::DXException("No valid modes found for this device")` throw at `0x74414d83` fires after all DDraw/D3D setup completes (verified: batch 120, `prev_eip=0x74414d6b`, throw payload has string at obj+4).

**Corrected filter-call count:** the filter function at `0x74414a30` is called **2 times per run**, not 12. The earlier "12 hits" reading from `--trace-at` was a breakpoint re-arm artifact; `--count=0x74414a30` reports 2, with `0x74414db4` (skip-throw label) hit 1×. So: one call succeeds, one fails. Both calls have bitwise-identical entry state (same ECX=`0x74e125dc`, same EAX=`0x74e127ac`, same ESP=`0x77fff5bc`, same stack contents, same `dbg_prev_eip=0x74415751`) — yet one returns a non-empty filtered mode vector and the other returns empty. This is deterministic emulator state drift between two otherwise-indistinguishable calls.

**Next investigation step:** dump the input mode vector (at `0x74e12798`) + device caps struct (`[ebx+0xC0]` = `[0x74e125dc+0xC0]`) at entry of each of the 2 filter calls. Something mutates between them. Candidates:
- Heap allocator state (a `new` between calls returns different bytes)
- A global/static touched by code between the two calls
- Stale block-cache entry whose behavior depends on state set by a prior call

Suggest instrumenting `--trace-at` with an optional memory-dump attachment (`--trace-at-dump=0xADDR:LEN`) so per-hit state snapshots are comparable.

**Prior notes (kept for historical context):**
**Priority: HIGH** — Blocks 7 d3dim-based savers (ARCHITEC/FALLINGL/GEOMETRY/JAZZ/OASAVER/ROCKROLL/SCIFI)
**Files:** `src/09a8-handlers-directx.wat`, `src/09aa-handlers-d3dim.wat`, `src/01-header.wat`, `src/08-pe-loader.wat`, `src/09b-dispatch.wat`

The statically-linked DirectX sample framework (at `0x74400000` inside each saver .exe) throws `CA::DXException` from `_CxxThrowException` wrapper at `0x7448e2e0` (throwInfo `0x744b93d8` = `.?AVDXException@CA@@`). Traced filter logic in GEOMETRY.SCR:

#### Fixes already applied this session

1. **`$handle_IDirect3D2_EnumDevices` was a no-op stub** (`src/09aa-handlers-d3dim.wat:34`) — returned DD_OK without invoking callback. Now delegates to `$d3d_enum_devices_invoke` like v1/v3.
2. **`$d3d_enum_devices_invoke` only enumerated HAL** — framework needs to find a device by name/GUID (tries Ramp/RGB/HAL/MMX/TnLHal). Rewrote as an iterator with CACA000B continuation thunk that fires the callback 4 times (idx 0=Ramp, 1=RGB, 2=HAL, 3=MMX). See `$d3d_enum_devices_dispatch` and `$d3d_enum_devices_continue` at `src/09a8-handlers-directx.wat:683+`. Added thunk allocation at `src/08-pe-loader.wat:240` and dispatcher wiring at `src/09b-dispatch.wat:356`.
3. **`dwDeviceRenderBitDepth = 0x700`** (DDBD_16|24|32) corrected to `0xD00` (`0x800|0x400|0x100` = DDBD_8|16|32) — `$fill_d3d_device_desc` at `src/09a8-handlers-directx.wat:763`.

After these fixes, `[ctx+0x218]` now points at a DeviceInfo at `0x74a0ea10` whose `+0xC0` field holds our `0xD00` (copied from D3DDEVICEDESC+156 by the framework via 204-byte `rep movsd` at `0x7441431a`, landing at DeviceInfo+0x24..+0xEC).

#### Still broken — throw fires on a later invocation, not the first

Further tracing corrects the earlier reading: the mode-vector at `0x74e12798` is populated correctly on every call — at the first throw-check invocation (batch 118), `end-begin = 0x50 = 4 entries`, `setz al` → `al=0`, `jz` taken → throw skipped. The "no valid modes" path at `0x74414db4` is reached at batches 118/119/120 (count > 0, success).

**But `--trace-at=0x74414a30` shows the filter function is called 12 times, not 3** (my old single-breakpoint counting was truncated by the `--break` re-arm being once-per-batch). All 12 calls have *identical* register state at entry (EBP=0x74e125dc, ESP=0x77fff5bc, same args, same caller return=0x74415760) — same inputs each time.

At batch 143, execution reaches the throw (`call 0x7448e2e0` at `0x74414d83`) with `dbg_prev_eip=0x74414d6b`. Same filter function, same `this`, but this time `count == 0`. So 11 of 12 calls pass, 1 throws — with bitwise-identical inputs at entry.

This smells like emulator state drift: something accumulates in our CPU/memory state across iterations of a tight loop that eventually changes the behavior of the mode-AND inside the filter. Candidates:

- Stale decoded-block cache entry re-used after a write-to-code or after a page mapping change.
- Lazy-flag state or FPU state leaking across the call boundary (filter uses `imul`/`sar` for the div-by-20 — flag or reg corruption would change path).
- One of the CRT helpers called inside filter (`0x74468d60` format-print, CString ctor/dtor at `0x7440dc90`/`0x7440a6a0`/`0x7440aca0`) returns different values after N calls.

**Next steps:**
- ~~Dump vector + DeviceInfo at every filter entry~~ — DONE 2026-04-18. `--trace-at-dump=ADDR:LEN[,...]` now lives in `test/run.js`. Ran `ARCHITEC.SCR --trace-at=0x74414a30 --trace-at-dump=0x74e12798:80,0x74e1269c:64`.
- **Diagnosis revised twice, now settled:**
  - First revision (bogus): "outer-loop non-advance" — came from misreading 12 `--trace-at` hits as 12 filter calls.
  - Root cause of the miscount: a bug in `$run`'s bp mechanism. When the WAT bp at `$eip == $bp_addr` fired, `br $halt` returned without dispatching that block. JS's `--trace-at` re-arm path set the bp again and called `run` — which halted immediately at the same EIP without advancing. Result: 1 real hit + N spurious re-halts per bp-hit. Fixed by adding `$bp_skip_once` (src/01-header.wat + src/13-exports.wat): on halt, set the flag; on next loop entry, if flag is set and `$eip == $bp_addr`, clear the flag and dispatch the block once before re-arming the check. All prior `--trace-at` hit counts in this doc are suspect (use `--count=` for authoritative counts; `--trace-at` is now safe too).
  - Second revision (correct): filter is called exactly 2 times — matches `--count=0x74414a30`. Entry regs and mode-vector differ between the two:
    - **Hit #1:** `EDX=0x7451216c EBX=0 ESI=0x74e12840 EDI=0`. Mode vector `[0x74e12798+4..+12] = 0x00000000 0x00000000 0x00000000` (begin=end=capEnd=NULL — fresh vector).
    - **Hit #2:** `EDX=0x74a13db0 EBX=0x10 ESI=0x8876017c EDI=0x74a0e841`. Mode vector `[0x74e12798+4..+12] = 0x74a13db0 0x74a13db0 0x74a13e00` (begin==end — **allocated but empty**, capacity=0x50 ahead).
  - So the fn is *supposed to* populate the vector in hit #1, producing `end-begin=0x50` (4 entries). On hit #2 the vector is empty → filter iterates nothing → count=0 → `0x74414d83` throws `CA::DXException("No valid modes found for this device")` → `RaiseException` → EIP=0 exit (no SEH catches).
- New next step: the filter body populates the vector via `call 0x74415140` (at `0x74414a9b`) which looks like a mode-enumeration helper. Trace that sub-call on hit #1 vs hit #2: either (a) hit #1's enum succeeds but the produced vector is *destroyed* before hit #2 entry (dtor / `operator=` / clear), (b) hit #1 itself fails to populate but we fall through without noticing, or (c) caller re-uses the same vector object and calls filter twice expecting reuse. Set `--trace-at=0x74414a9b` and `--trace-at=0x74414aa0` (after the sub-call), dump `[0x74e12798:16]` — compare the post-enum vector states on each call.

##### Session 2026-04-18 (b): 0x8876017c is a D3D HRESULT — traced to vtable[0x58] call

Further traced the origin of the `ESI=0x8876017c` seen at filter Hit #2 entry. `0x8876017c` is a DirectX HRESULT (facility `0x876` = D3D/DD, code `0x17c` = 380).

- Outer loop-body fn near `0x74414945` writes mode_entry[i].field_0x10 at **`0x744149ba`**: `mov [eax+ebp+0x10], ecx` where `ecx = [esp+0x40]`. The mode-filter test at `0x74414c5f` (`mov eax, [esp+0x20]; jge insert_path`) reads that same `+0x10` field — so whatever lands there controls ACCEPT/SKIP.
- Watchpoint `--watch=0x77fff5c0 --watch-value=0x8876017c` (= `[esp+0x40]` at `ESP=0x77fff580`) fires at `prev_eip=0x744158c7` (`push esi`), inside fn `0x7441572b`. `esi` there is the HRESULT loaded at `0x744158b5` from `call 0x744168a0` at `0x744158b0`.
- Fn `0x744168a0` (prologue at entry, `sub esp, 0x1cc`; stores `mov ebp, ecx` → this) makes a COM call: `call [ecx+0x58]` at **`0x74416914`** on the interface pointer stored at `[this+0x204]`. Vtable offset `0x58` = slot 22. The HRESULT `esi = return` is then either logged (via `call 0x74422f80` = hr→string) and propagated.
- Caveat: the watchpoint sampled at batch boundary. `push esi` transiently stores `0x8876017c` at `[0x77fff5c0]`, but a following `push eax` (string ptr) overwrites it. After `add esp, 0x10` post-log, the slot's residual value is whatever was last pushed there (the string ptr, not the HRESULT). So `[esp+0x40]` seen by fn `~0x74414945`'s write is **not** this transient — the watchpoint hit is coincidental timing, not the real value source.
- **Correction needed:** `--trace-at=0x744149b2` with `--trace-at-dump=0x77fff5c0:4` returned **0 hits** this run. That means the mode-populator at `0x744149ba` **never actually executes in this run**. So `mode_entry[i].field_0x10` must be set somewhere else entirely. The `0x8876017c` observed at filter-fn entry as **`ESI`** (register) is from the filter fn's caller, not from the mode vector memory.

**Revised understanding:** `ESI=0x8876017c` at Hit #2 entry is a register carry-over from the caller — likely the HRESULT of a failed DX call made between Hit #1 and Hit #2. The "mode vector allocated but empty" at Hit #2 means the caller failed its enum between the two filter invocations. Need to trace what the caller does between the two filter calls: set a breakpoint at `0x74415760` (filter's return address per earlier doc) and log EIP + last-DX-return after Hit #1's return until Hit #2's call.

##### Session 2026-04-18 (c): retry-loop found, HRESULT source is a thunked vtable call

- **Enclosing fn** of the filter caller is at **`0x74415720`** (SEH prologue, `mov ebp, ecx`). Called once via xref from `0x74416fd4`. Find_fn's earlier "0x7441572b" was a mid-instruction misalignment.
- **Retry loop:** `0x74415720` body has a backward `jl 0x74415743` at **`0x7441590c`** (`test esi, esi; jl`). When a DX call returns HRESULT<0, the fn loops back to `0x74415743`, re-tests `[ebp+0x1a0]`, and re-invokes filter at `0x7441575b`. That's why filter is called 2×.
- **The failing call between the two filter invocations:** `call 0x744168a0` at **`0x744158b0`** — a wrapper whose body makes a vtable-22 COM call: `call [ecx+0x58]` at `0x74416914` on the object at `[this+0x204]`.
- **Iface ptr at `[this+0x204]` (= `[0x74e127e0]`) = `0x7c3e0010`.** That memory is NOT in our guest-code region — it's in our **emulator-internal high-memory range** (matches neither `GUEST_BASE`, stack, heap). Its header: `[0x7c3e0010] = { vtable=0x745121d4, refcount?=2, ... }`. The "vtable" at `0x745121d4` contains entries in the **`0x78200xxx` range**, which is our **API thunk zone** (`thunk_base: 0x78200000 thunk_end: 0x782024f0 num_thunks: 1182` from dll-loader at build time). So slot 22 (`[vtable+0x58] = 0x78200970`) is an **API thunk**, and our dispatcher returns `0x8876017c` as the stub response.
- **Key question:** which d3drm/ddraw API does thunk index 302 (`(0x78200970-0x78200000)/8 = 302`) correspond to? That tells us which handler to implement/fix. A d3drm-interface vtable synthesized out of API thunks (rather than real COM object-model pointers) suggests our DLL loader or d3drm stub builds a fake vtable whose slot 22 is wrong or unimplemented.

**Next step:** dump `0x78200000` thunk table and match the thunk at `+0x970` to a d3drm export name. Grep handler for that API in `src/09aa-handlers-d3dim.wat` / `src/09a8-handlers-directx.wat` and check return value. If it's a `crash_unimplemented`, the emulator has been fail-fast-correctly, but something upstream (DLL loader) is installing a thunk that shouldn't be — fix either the handler or the vtable source.

##### Session 2026-04-18 (d): thunk 0x78200970 resolved — vtable is IDirectDrawSurface, but GetSurfaceDesc is NOT the culprit

- Thunk at `0x78200970` has header `[+0] = 0xCACA0010` and `[+4] = 0x3FE` (api_id = **1022 = `IDirectDrawSurface_GetSurfaceDesc`**).
- The vtable at `0x745121d4` is contiguous thunks `0x782008c0 + N*8` for N=0..26+, meaning **slot 0 = thunk #280 (`0x8c0/8`)**. Slot ordering matches the IDirectDrawSurface vtable layout: 0=QI, 1=AddRef, 2=Release, ..., 22=GetSurfaceDesc.
- Our handler `$handle_IDirectDrawSurface_GetSurfaceDesc` at `src/09a8-handlers-directx.wat:1388` returns `eax = 0` (success) unconditionally. So `call [ecx+0x58]` does **not** return `0x8876017c`.
- **Confirmed via `--trace-at=0x744158b5`**: `call 0x744168a0` at `0x744158b0` returns `EAX=0x8876017c`. So fn `0x744168a0` itself returns the HRESULT — not the GetSurfaceDesc call inside it.
- Fn `0x744168a0` exits via `mov eax, edi` at `0x74416f41` (return value = edi). So one of the multiple DX sub-calls inside `0x744168a0` sets `edi = 0x8876017c`.

**Concrete next step (session e):** instrument every vtable call inside fn `0x744168a0` (0x74416914, 0x7441696?, ...) with `--trace-at` + log eax post-return, to identify which specific call returns `0x8876017c`. Once known, search `0x8876017c` in our WAT handlers or treat `0x8876_017c` as `DDERR_INVALIDCAPS` / similar and match the DDRAW HRESULT definition. Candidates by value `0x8876017c` decimal-tail `380`: check DirectX DDERR enum in `ddraw.h` / wine — likely `DDERR_NOTFOUND` (380) or `DDERR_NOHARDWARE` range.

##### Session 2026-04-18 (e): FIXED — fn 0x744168a0 is CreateZBuffer, fails VRAM check

**Root cause identified by reading strings.** Fn `0x744168a0` is **`CreateZBuffer`** (not a mode-filter helper). The string constants pushed in its logging calls give it away:
- `0x744c58b8` = `"%s: Creating z-buffer"` (entry log, `push` at `0x744168ce`)
- `0x744c5898` = `"%s: CreateZBuffer() failed (%s)"` (GetSurfaceDesc-fail path)
- `0x744c57c4` = `"%s: CreateZBuffer AddAttachedSurface() failed (%s)"`
- `0x744c5748` = `"%s: Created z-buffer"` (success)
- `0x744c5760` = `"%s: CreateZBuffer() surface not in VRAM for hardware device."`

**The actual error site** is at `0x74416ec7`: `mov eax, 0x8876017c; jmp epilogue` — a **hardcoded HRESULT constant** in the binary. It's reached via `test bl, bl; jnz` at `0x74416e54` (branch falls through to the error block). `bl` is the "hardware device + surface not in VRAM" flag, set earlier by checking the Z-buffer's reported `DDSCAPS_VIDEOMEMORY` (0x4000).

**Our bug:** `$handle_IDirectDrawSurface_GetSurfaceDesc` in `src/09a8-handlers-directx.wat:1412-1415` reported `ddsCaps = 0x840` (`DDSCAPS_SYSTEMMEMORY | DDSCAPS_OFFSCREENPLAIN`) for all non-primary surfaces — so the Z-buffer appeared to live in system memory, tripping the hardware-device VRAM check.

**Fix:** change the non-primary caps from `0x840` → `0x4040` (`DDSCAPS_VIDEOMEMORY | DDSCAPS_OFFSCREENPLAIN`). We claim hardware acceleration so every surface should logically live in VRAM. Patched `src/09a8-handlers-directx.wat:1412-1417`.

**Verification:** after rebuild, ARCHITEC.SCR no longer hits the "No valid modes found" throw. The trace now shows `DirectDrawCreate → EnumDisplayModes → QI D3D → EnumDevices` completing, and CreateZBuffer is no longer rejected. Progress advances to a later failure: `MessageBoxA "Error": "Failed to create configuration property sheet"` — a PropertySheet / CreatePropertySheetPage API gap in the config dialog path. Different issue, will tackle next session.

##### Session 2026-04-18 (f): FIXED — IDirect3D2 QI returned D3D3 vtable

**Test path.** Switched test to `--args="/s"` (fullscreen screensaver mode, skipping the Config property-sheet UI). In that path, ARCHITEC.SCR got past EnumDevices and into `IDirect3D2_EnumDevices → CreateDevice` but then stalled at EIP=0 with `prev_eip=0x7441895c` (inside a vtable-slot-8 `call [ecx+0x20]` sequence).

**Bug in QI.** The IDirectDraw_QueryInterface handler at `src/09a8-handlers-directx.wat:398` treated IID `{6AAE1EC1-…}` (IDirect3D2) and IID `{BB223240-…}` (IDirect3D3) as the same interface and returned a `DX_VTBL_D3D3` vtable for both. That's wrong because the two interfaces have different slot-8 method signatures:

| Iface | CreateDevice args | Stack pushes |
|---|---|---|
| IDirect3D2 | `REFCLSID, lpDDS, lplpDev`          | 4 (with `this`) |
| IDirect3D3 | `REFCLSID, lpDDS, lplpDev, pUnkOuter` | 5 (with `this`) |

The Borland-compiled screensaver correctly pushed 4 args (IDirect3D2 convention) into a vtable whose slot-8 thunk our emulator built with `api_id=1132 (IDirect3D3_CreateDevice)`, causing `$handle_IDirect3D3_CreateDevice` to pop 5 dwords — 4 bytes of stack drift that nuked EIP on the following Release sequence.

**Fix.** In the QI handler:
- `0x6AAE1EC1` (IDirect3D2) now returns `DX_VTBL_D3D2` (9 slots, api_ids 1272-1280 — thunks already built by `$init_dx_com_thunks`, with `$handle_IDirect3D2_CreateDevice` already popping the correct 4 args).
- Added a new branch for `0xBB223240` (IDirect3D3) returning `DX_VTBL_D3D3`.

**Verification.** After rebuild, ARCHITEC.SCR trace now shows the full DX → D3D pipeline firing: `IDirect3D2_EnumDevices → IDirect3D2_CreateDevice → IDirect3DDevice3_AddRef → IDirect3DDevice_SetMatrix → IDirect3DDevice2_Release → IDirect3D_QueryInterface`. Real per-frame `IDirectDrawSurface_Blt` calls also appear (back-buffer flipping). The next stall is later, at `EIP=0`, `prev_eip=0x745a9353` inside `d3drm.dll` after a QueryInterface that returns `E_NOINTERFACE` (ESI=0x80004002) — a different bug in either our QI IID coverage or a subsequent null-vtable Release. Natural next step.

##### Session 2026-04-18 (g): partial — two more QI cases added; ARCHITEC still stalls at same prev_eip

**What was fixed.** The d3rm function at `0x6478e2c1` (preferred `d3drm.dll` base) calls QI chains that Phase-0 stubs didn't cover. Added two new QI branches in `src/09ab-handlers-d3dim-core.wat::$d3dim_qi`:

1. **D3D family → IID_IDirectDraw (`0x6C14DB80`)**: scans `DX_OBJECTS` for the first slot with `type==1` (DDraw), AddRefs it, writes its wrapper guest ptr. Rationale: d3drm gets a `IDirect3D` via `IDirectDraw::QI` but later needs the DDraw back; since we don't track the D3D→DDraw parent, scan. In practice only one DDraw exists.
2. **Device family → IID_IDirectDrawSurface (`0x6C14DB81`)**: returns the render-target surface stashed in `entry+8` at `$d3dim_create_device` time. AddRefs the surface slot before handing it out.

Also extended `$handle_IDirect3DDevice2_GetRenderTarget` (`src/09aa-handlers-d3dim.wat:358`) from a pure no-op `eax=0` stub into a real implementation that writes the bound rt surface guest ptr into `*arg1` and AddRefs — earlier stub left caller's out-local uninitialized → null-vtable `Release` crash.

**Status.** These three fixes together let the emulator advance through several more API calls (`IDirectDraw_GetCaps`, `IDirectDraw_GetDisplayMode`, a second Device2→Surface QI, `IDirectDrawSurface_GetPalette` which returns `DDERR_NOPALETTEATTACHED` — the normal error for 16-bpp modes). Stall is still at `EIP=0`, `prev_eip=0x745a9353`, but now ESI=`0x887601ff` (was `0x80004002`) — different error code propagating to the same cleanup site. Same crash pattern: `call [ecx+0x8]` where `ecx=[eax]=[ebp-0x8]=0`, so the object at `[ebp-0x8]` is still null.

**Unresolved.** The outer function at `0x6478e2c1` expects `[ebp-0x8]` to be populated by the call at `0x6478e319 call [eax+0x40]` — but after the QI at `0x6478e30a` (IID_IDirect3DDevice v1), `[esi]` points to `DX_VTBL_D3DDEV1` and slot 16 there is `SetMatrix` (3-arg, not 2-arg, and it doesn't return a COM object). The trace confirms `IDirect3DDevice_SetMatrix` is what actually runs at that call site. The next helper at `0x6478e34e call 0x6478df70` then consumes the uninitialized `[ebp-0x8]=0` and the cleanup path Releases it → crash.

The disconnect is that d3drm's compiled code expects slot 16 to return a COM object (Device2-style `GetRenderTarget`), yet queries with IID_IDirect3DDevice v1 (whose slot 16 is `SetMatrix`). Either the IID data in `d3drm.dll` at `0x647813d0` is not what standard `d3d.h` declares (confirmed it IS IID_IDirect3DDevice v1 by bytes), or d3rm links against a differently-shaped v1 vtable where slot 16 *is* GetRenderTarget-like. Left for next session — needs either a controlled disassembly of `0x6478df70` to see what it does with the uninitialized local, or a different mapping from IID `0x64108800` to a vtable whose slot 16 yields a COM object.

##### Session 2026-04-18 (h): COM-wrapper vtable mutation replaced with aux-wrapper pool; same d3rm stall

**What changed.** `$d3dim_qi` previously mutated the primary COM wrapper's vtbl in place on a QI upgrade (pre-fix `src/09ab-handlers-d3dim-core.wat:139`). That's safe only when the caller uses the returned `*ppvObj` pointer and drops the original — but d3rm keeps the original `this` alive in a register and continues calling methods on its ORIGINAL vtbl after the QI. In-place mutation therefore silently swapped the vtbl out from under d3rm, causing slot-16 dispatches to land on the wrong method (e.g. SetMatrix when GetRenderTarget was expected).

**Fix.** Added a 2048-entry auxiliary wrapper pool at WASM `0x07FF2800` (`COM_WRAPPERS_AUX`, 16KB) plus helper `$dx_get_wrapper_for_vtbl(slot, vtbl) → guest_ptr` in `src/09a8-handlers-directx.wat`. Each aux entry is 8 bytes `[vtbl, slot]`, same shape as primary wrappers, so `$dx_from_this` recovers the backing DX_OBJECTS slot for either form. Dedup'd by `(slot, vtbl)` via linear scan of the used prefix. `$d3dim_qi` now calls this helper instead of overwriting the primary wrapper's vtbl. Memory map updated in `src/01-header.wat`.

**Verification of fix correctness.** After rebuild, the trace shows distinct aux wrappers (`0x7c3e0808`/`0x7c3e0810`/`0x7c3e0818`) for each interface the same slot is viewed as, and QI slot-0 dispatches the correct api_id for each vtbl (e.g. QI on aux `0x7c3e0810` now reports `IDirect3DDevice2_QueryInterface` = api_id 1311 where pre-fix the same guest ptr reported DEV1 QI = 1289 due to the silent mutation).

**Regression check.** WIN98.SCR `/s` reaches the same idle point as before (`STUCK at EIP=0x004012a3`, 507 API calls). The aux-wrapper fix does not regress DDraw-only screensavers.

**Status.** ARCHITEC.SCR `/s` still stalls at `prev_eip=0x745a9353` (d3rm preferred VA `0x6478e353`), `ESI=0x887601ff` (DDERR_NOPALETTEATTACHED propagated from a nested `IDirectDrawSurface::GetPalette`). Crash sequence: `mov eax, [ebp-0x8]; mov ecx, [eax]; call [ecx+0x8]` with `EAX=0 → ECX=0 → EIP=0`. `[ebp-0x8]` remains null.

**Reframe.** The outer function at `0x6478e2c1` makes QI + slot-16 calls on `esi`/`edi` that do NOT appear in our COM trace. That means those pointers are **d3rm-internal** (vtables pointing to d3rm native code), not our DX_OBJECTS-backed wrappers. The slot-16 call at `0x6478e319` runs d3rm-internal code that's supposed to write a valid pointer to `[ebp-0x8]`; instead it returns S_OK but leaves `[ebp-0x8]=0`. The `GetPalette` / surface Release / DDraw Release visible in the trace happen inside the nested `0x6478df70` as an error-cleanup path.

**Lead for next session.** The d3rm-internal slot-16 method likely queries d3rm's cached rendertarget surface — which d3rm populates during its own CreateDevice path. Our stubbed `$d3dim_create_device` writes `rt_surf` to the DX_OBJECTS entry, but d3rm's internal bookkeeping is separate and may not be seeing a non-null surface via the DX APIs we expose. Next step: instrument with `--trace-at=0x745a9319 --trace-at-dump=0x745a9319:32` + dump `[esi]` and `[esi_vtbl+0x40]` to see where the d3rm-internal slot-16 dispatch lands; also walk back from return addr `0x745ab53a` (d3rm VA `0x6478b53a`) to find where `esi` is constructed.

#### Related files (session h additions)

| File | Change |
|------|--------|
| `src/09a8-handlers-directx.wat:20-28` | `$COM_WRAPPERS_AUX`, `$COM_WRAPPERS_AUX_MAX`, `$com_aux_next` globals |
| `src/09a8-handlers-directx.wat` (after `$dx_slot_of`) | New `$dx_get_wrapper_for_vtbl` — returns primary if vtbl matches, else dedup'd aux entry |
| `src/09ab-handlers-d3dim-core.wat:136-146` | `$d3dim_qi` no longer mutates the primary wrapper; routes hits through the aux helper |
| `src/01-header.wat:438` | Memory map updated: 16KB `COM_WRAPPERS_AUX` region at `0x07FF2800` |

##### Session 2026-04-19 (i): FIXED — IDirect3D2::CreateDevice returned DEV3 vtable, not DEV2

**Root cause.** `$d3dim_create_device` (helper in `src/09ab-handlers-d3dim-core.wat`) hard-coded `DX_VTBL_D3DDEV3` for the created device, regardless of the caller interface version. `$handle_IDirect3D2_CreateDevice` and `$handle_IDirect3D7_CreateDevice` both routed through this helper, so the object returned from `IDirect3D2::CreateDevice` was an IDirect3DDevice3 wrapper. d3rm.dll, compiled against the real DEV2 vtable, called `call [esi_vtbl+0x40]` (slot 16) expecting `IDirect3DDevice2::GetRenderTarget` — but in the DEV3 layout slot 16 is `Begin`. Begin's stub returned 0 without writing the out-ptr, then the d3rm caller dereferenced `[ebp-0x8]=0` → `call [0]` → EIP=0.

**Fix.** Added a `$vtbl` parameter to `$d3dim_create_device`; V2 path passes `DX_VTBL_D3DDEV2`, V7 path passes `DX_VTBL_D3DDEV7`, V3 continues to use `DX_VTBL_D3DDEV3` (handler in `09a8-handlers-directx.wat` is separate and already correct).

**Verification.** ARCHITEC.SCR `/s` now advances past the `0x745a9353` stall: 6027 API calls vs. 5948 pre-fix. New failure is a `_CxxThrowException` `DXException("\"D3DMgr::GetD3DRM()->CreateDeviceFromD3D(GetD3D(), GetD3DDevice(), &pD3DRMDevice)\" failed")` — the d3rm createDevice chain succeeds internally but the host framework is still seeing `0x887601ff` (`DDERR_NOPALETTEATTACHED`) bubble up. Likely from a nested `IDirectDrawSurface::GetPalette` whose error the d3rm caller shouldn't be propagating, or from an intermediate call. Next lead: instrument `$handle_IDirectDrawSurface_GetPalette` to return `DD_OK` with a stub palette (or return `S_OK` with a null palette output) and see if it advances further.

**Files changed.**

| File | Change |
|------|--------|
| `src/09ab-handlers-d3dim-core.wat:153` | `$d3dim_create_device` gains `$vtbl` param; uses it for `dx_create_com_obj` |
| `src/09aa-handlers-d3dim.wat:82` | `IDirect3D2_CreateDevice` passes `DX_VTBL_D3DDEV2` |
| `src/09aa-handlers-d3dim.wat:118` | `IDirect3D7_CreateDevice` passes `DX_VTBL_D3DDEV7` |

##### Session 2026-04-19 (j): FIXED — GetPalette error triggered DXException in d3rm CreateDeviceFromD3D

**Root cause.** `$handle_IDirectDrawSurface_GetPalette` returned `DDERR_NOPALETTEATTACHED` (0x887601FF) unconditionally. The ARCHITEC.SCR D3DMgr wrapper (via d3rm's CreateDeviceFromD3D) treated the HRESULT as fatal and threw `DXException("CreateDeviceFromD3D failed")` at EIP=0x74497b47.

**Attempts.**
1. Return `S_OK` with `*lplpDDPalette = 0` → d3rm then null-derefs the returned pointer at 0x745a90f4, crashing at EIP=0.
2. Return `S_OK` with a fresh `IDirectDrawPalette` COM wrapper → progresses.

**Fix.** `GetPalette` now allocates a palette wrapper via `dx_create_com_obj(type=3, DX_VTBL_DDPAL)` and writes it to `*lplpDDPalette`. Existing palette handlers (GetCaps / GetEntries / SetEntries / Initialize) already exist as stubs, so Release/QI chains work.

**Verification.** ARCHITEC.SCR `/s` now enters the render loop: 22294 API calls in 600 batches (was 5937). Traffic is dominated by `SetRenderState` (1267), `Execute` (127), `BeginScene`/`EndScene` (64 each), `Flip` (63), `Clear` (63). Scene execution is no-op-rendered (black output), but the app is fully alive — no crash, no EIP=0. WIN98.SCR still runs clean. Remaining work: actual scene pixels — `IDirect3DDevice_Execute` / viewport `Clear` need to write into the DirectDraw surface so Flip can present it.

**Files changed.**

| File | Change |
|------|--------|
| `src/09a8-handlers-directx.wat:1443-1452` | `GetPalette` returns a fresh `IDirectDrawPalette` wrapper instead of `DDERR_NOPALETTEATTACHED` |

**Scope note for Execute path.** Turning the render loop into actual pixels requires a D3D1 execute-buffer interpreter + a minimal software rasterizer — multi-session work, not a quick change. Current infra state:
- `$viewport_fill_rect` (`09ab-handlers-d3dim-core.wat:478`) already writes 8/16/32bpp pixels into the RT DIB — reuse for flat triangle spans.
- `$d3dim_ensure_zbuffer` / `$zbuffer_fill` exist for depth.
- ExecuteBuffer handlers (`$handle_IDirect3DExecuteBuffer_{Lock,Unlock,SetExecuteData,Initialize}` in `09aa-handlers-d3dim.wat:1038-1065`) are all no-op stubs — no buffer allocated, no `lpData` returned. First step: track per-ExecuteBuffer state (alloc `dwBufferSize` bytes, store guest ptr + size in COM entry, return ptr from Lock, remember `D3DEXECUTEDATA` from SetExecuteData).
- `$handle_IDirect3DDevice_Execute` (`09aa:198`) currently ignores its execute-buffer arg. Plan: walk `D3DINSTRUCTION` stream from `dwInstructionOffset`; dispatch on `bOpcode`. Minimum opcodes ARCHITEC almost certainly uses: `D3DOP_MATRIXLOAD`/`MULT` (4/5), `D3DOP_STATERENDER` (8), `D3DOP_STATELIGHT` (7), `D3DOP_PROCESSVERTICES` (9) — transforms verts into HVERTEX, `D3DOP_TRIANGLE` (3) — raster, `D3DOP_EXIT` (11). Add per-opcode trace first and run ARCHITEC once to confirm the actual opcode set before writing the rasterizer.

**Update (2026-04-19): Execute-buffer state + opcode trace wired.**
- `CreateExecuteBuffer` now allocates `dwBufferSize` via `heap_alloc`, stores `{bufPtr,size,vertOff,vertCount,instrOff,instrLen}` in DX_OBJECTS entry (`+8..+31`). `Lock` writes `bufPtr`+`size` into caller's desc; `SetExecuteData` captures offsets.
- `Execute` walks the `D3DINSTRUCTION` stream and calls `host_dx_trace(kind=7, op, size, count, off)` per opcode + `kind=8` at entry. `lib/host-imports.js` prints `[dx] Exec ...` / `[dx] ExecIn ...` when `--trace-dx` is on.

**Surprising finding — Step 1 result (`apps/screensavers-architec-opcodes.log`, 600 batches):**
- Exactly 1 `CreateExecuteBuffer`, 1 buffer reused every frame (Lock→Unlock→SetExecuteData→Execute cycle, 2× per BeginScene/EndScene).
- Every `Execute` call has `instrLen=32` and the stream is a **single** `STATETRANSFORM size=8 count=3` instruction (28 bytes) — nothing else. No `MATRIXLOAD/MULT`, no `STATERENDER`, no `PROCESSVERTICES`, no `TRIANGLE`, no `EXIT`.
- So ARCHITEC's render loop uploads 3 transform matrices per frame and never submits geometry. A rasterizer at this point has nothing to rasterize.

**Next investigation (before writing any rasterizer):** find why ARCHITEC never emits `PROCESSVERTICES/TRIANGLE`. Candidates:
- `.SCN` scene file load fails silently → scene list empty → draw loop skipped.
- Mesh loader (`AR_MESH.X`) fails → no vertex buffers populated.
- Lighting / material path exits early on missing resources.
  Trace `FindFirstFileA("*.scn")` + file-read APIs around `ReadFile` to confirm scene assets land. If they do, set a breakpoint after `SetRenderState` storm to see where the flow bails out before the geometry Execute call.

**Update (2026-04-19) — .SCN reads now work, but app still crashes before emitting geometry.**

Root cause for empty scenes was the INI backend: `lib/storage.js:ini_get_string` read only from `localStorage` (`ini:<filename>`) and never fell back to the actual file on disk. ARCHITEC's `.SCN` format *is* an INI file, so every `GetPrivateProfileStringA("Description", "Name", …, "architec.scn")` returned the default. Added `_parseIniText` + `_iniResolve(vfs, fileName)` that parses the VFS file when no localStorage entry exists — `ini_get_string`/`ini_get_int` now route through it.

Verification with `--trace-ini` (new flag): `[Description] Name="Architecture"`, `Inform0="ar_mesh"`, `Texture0="ar_textu"`, plus full per-material parameter set (Colour*, MaterialSpecular*, MeshDeform*, etc.) resolve correctly for every `.scn`.

**New blocker — batch ~240 crash:** `mov [edx], 0x4c` at `0x745e0403` with `edx=0x7c3e0030` (way past heap end `0x74fd7ee8`). `esi=0x74a16970` (framework data). Some COM call returns a garbage out-pointer that the app writes through. `[edx]=0x4c` looks like a structure `dwSize` init, so it's likely an output DDSURFACEDESC2 or similar that our handler should have supplied. New tasks #5/#6 track this.

**Update (2026-04-19, cont.) — crash located in d3drm.dll, size 0x4c = D3DLIGHT.**

- `0x745e0403` = `d3drm.dll + 0x45403` (d3drm loaded at 0x7459b000). File imageBase=0x64780000, so the crashing function is at `0x647c5376..0x647c54c1` in the shipped DLL.
- The 0x4c-byte struct is **D3DLIGHT**: dwSize(4) + dwLightType(4) + D3DCOLORVALUE(16) + dvPosition(12) + dvDirection(12) + dvRange(4) + dvFalloff(4) + dvAttenuation0/1/2(12) + dvTheta(4) + dvPhi(4) = 76 bytes. The tail `mov dword [edx+0x4c], 0x1` is `dwFlags` being set to 1 (i.e. the caller-side "has light" flag).
- Caller in ARCHITEC at `0x74469b49` is `call [ecx+0x34]` — **IDirect3DDevice2 method 13 = SetCurrentViewport**, matching the preceding `[COM api_id=1324]` trace. So the trap fires *inside* the SetCurrentViewport implementation in d3drm.
- `edx=0x7c3e0030` is our COM_WRAPPERS slot-6 guest address (the viewport wrapper). d3drm's internal light-pool enumerator is treating the viewport wrapper as a D3DLIGHT pool entry and scribbling over it. WASM memory is fine (`g2w(0x7c3e0030)=0x07ff2030`, well under 128 MB) — the OOB actually fires later on a d3drm-internal pointer derived from the corrupted wrapper contents, not on the first `mov` itself. The sanity-clamp in `$dx_slot_wa` never fires, so the viewport slot stays sane.
- **Smoking gun** (violates the fail-fast-stubs memory): `$handle_IDirect3DLight_{Initialize,SetLight,GetLight}` at `src/09a8-handlers-directx.wat:3194-3204` are silent `eax=0` stubs that neither populate the caller's D3DLIGHT* nor update any DX_OBJECTS state. When d3drm's IM-backed RM pipeline later enumerates viewport lights via our `IDirect3DViewport3_AddLight`/`NextLight`, it gets our COM wrappers back and stores them where it expects private light records, leading to the eventual scribble.
- `$handle_IDirect3DViewport3_AddLight`/`NextLight` at lines 3125/3133 likely need review too — haven't inspected yet.

**Next session: start here.** Implement real D3DLight state (dwSize/dwLightType/color/position/attenuation) in DX_OBJECTS, make SetLight/GetLight copy to/from the caller's D3DLIGHT*, and make Viewport::AddLight/NextLight track a per-viewport list of light slot indices. That should keep d3drm's internal pool from adopting our wrappers as light records.

**Update (2026-04-19, cont.2) — Light SetLight/GetLight now real; crash persists.**

Populated `$handle_IDirect3DLight_{SetLight,GetLight}` with per-slot heap-allocated 76-byte D3DLIGHT buffers (guest ptr stashed at DX_OBJECTS entry +8, freed on final Release; lazy-allocated on first SetLight). Re-ran ARCHITEC: **identical crash**, same batch ~240, same EIP, same edx=0x7c3e0030. So d3drm is *not* roundtripping light data through our GetLight before the crash — it tracks lights in its own state and only uses our COM wrappers as opaque tokens.

**New hypothesis:** the crash is an OOB from `mov eax, [0x745fc030+eax*4]` at d3drm offset 0x45413 (not the `mov [edx], 0x4c` at +0x40F). With `eax = [esi+0x34]` and `esi=0x74a16970` (an area past the PE image, unexplained provenance), if `[esi+0x34]` holds a large garbage dword ≥ ~31 M, then `0x745fc030 + eax*4` wraps past the 128 MB WASM cap when converted via g2w. So the real question is what `esi` points to and why `[esi+0x34]` holds junk — likely an uninitialized d3drm-internal light record that some earlier method was supposed to populate (via its own return value, not our buffer).

Next step would be `--watch` on `[esi+0x34]` and a backward walk from the crash to find which d3drm method left that field at a garbage value, but that's a sit-down-with-a-debugger session.

**Still unexplained:** no `CreateFileA("ar_mesh.*")` is observed even with INI working. The mesh-loader path fires after the `Inform0` read but never hits file I/O — likely a catch earlier in the chain. Expect the OOB crash and missing mesh load to be the same bug.

**New trace flags in `test/run.js`:** `--trace-fs` (CreateFile hit/miss), `--trace-ini` (section/key/value resolution). Both gated on `traceCategories.has('fs'|'ini')`.

**Update (2026-04-19, cont.3) — FIXED: batch-240 OOB was guest-vs-WASM pointer confusion in d3dim-core state helpers.**

`$d3ddev_state` returns a **guest** pointer (from `$heap_alloc`, which per `feedback_heap_alloc_guest_ptr` yields guest addresses). Three spots in `src/09ab-handlers-d3dim-core.wat` applied raw `i32.store` / `i32.load` to `state + offset` without `g2w`, treating it as a WASM address:

- `$d3dim_set_texture` — `state + D3DIM_OFF_TEX_STAGE` store
- `$d3dim_set_current_viewport` — `state + D3DIM_OFF_CUR_VP` store
- `$d3dim_get_current_viewport` — `state + D3DIM_OFF_CUR_VP` load

At batch ~240, `$heap_ptr` had grown enough that the state pointer's raw WASM-reinterpretation fell past 128 MB → OOB trap. The earlier "d3rm light-pool scribble" / "`[esi+0x34]` garbage" hypotheses were misdirections — the faulting store was ours, not d3rm's.

Fixed by routing all three through `$gs32`/`$gl32` (which apply `g2w`). ARCHITEC.SCR now runs 800 batches without a trap. Screen is still black: after `~9572` API calls the last COM calls are `SetRenderState(ZFUNC, LESSEQUAL)`, then the guest spins in a tight loop calling `$g2w` with out-of-range guest addresses (the `0xBADA1100` sentinel fires repeatedly on a `ga≈0x003fea90` → `wa≈0x8c010a90` overflow). So one blocker is cleared, next blocker is already visible.

**Update (2026-04-19, cont.4) — FIXED: dx_free was zeroing live COM wrappers, causing NULL-vtable EIP=0 in d3drm.**

After the g2w fixes, a second crash surfaced with `/s` (screensaver mode, which the previous runs didn't exercise): at batch 263 the guest got STUCK at `EIP=0x00000000`, `prev_eip=0x745dd1ec` (d3drm + 0x421ec, an install-surfaces-and-viewport helper). Stack return addr `0x745dd261` points at the instruction right after `call [ecx+0x14]` — IDirect3DViewport3 slot 5 = `SetViewport` — on `this=0x7c3e0030`.

Instrumenting that function entry with `--trace-at=0x745dd1ec --trace-at-dump=0x7c3e0028:16` across 7 calls showed all 6 prior entries had the wrapper populated (`vtbl=0x745124d4 slot=6`), but the 7th had the wrapper zeroed. A `--watch=0x7c3e0030 --watch-value=0x0` confirmed the zeroing was ours: `dx_free` ran `i64.store` on `COM_WRAPPERS + slot*8`. The owning app had called a `Release` that dropped refcount to 0, but d3drm still held an untracked reference (our `SetCurrentViewport` / `AddLight` / etc. stubs don't AddRef the viewport), so its next method call dereferenced a zero vtable.

Fix (`src/09a8-handlers-directx.wat`):
- `$dx_free` no longer touches the COM wrapper — only zeros the DX_OBJECTS entry type.
- `$dx_alloc` skips any slot whose wrapper is non-zero, even when the entry itself is "free" — slots with a guest-visible wrapper are now permanently retired to avoid ABA bugs.

Dangling guest ptrs now continue to dispatch to valid handlers (QI/Release/etc. stay addressable); the worst case is a stale Release that decrements a zero refcount, which is harmless with the `<= 0 ⇒ leak` branch. 256 slots is plenty for a screensaver run.

**Update (2026-04-19, cont.5) — black-frame blocker identified: DrawPrimitive family is stubbed.**

With the d3dim state-ptr fix in, ARCHITEC now runs 800 batches / 27488 API calls clean, no traps — but back-canvas stays solid black. MCM: same story (400 batches / 7330 API calls, black 640×480 canvas).

Root cause is straightforward inspection of `src/09a8-handlers-directx.wat` lines 3024–3054: every D3D draw call is a silent return-zero stub that only pops ESP — `DrawPrimitive`, `DrawIndexedPrimitive`, `DrawPrimitive{Strided,VB}`, `DrawIndexedPrimitive{Strided,VB}`. Same for `IDirect3DDevice_Execute` (the execute-buffer path used by MCM's older d3dim). Clear/BeginScene/EndScene, SetRenderState, SetMatrix, viewport/light state are all real now — but nothing rasterizes primitives into the back buffer, so every `$dx_present` flips an empty surface.

**Next session.** Implementing a software rasterizer is a multi-session project. Minimum viable path:
1. Decode execute-buffer opcodes (`D3DOP_TRIANGLELIST`, `D3DOP_STATERENDER`, `D3DOP_PROCESSVERTICES`, etc.) from the guest-supplied buffer, then call the same draw primitives as the DrawPrimitive path.
2. Triangle rasterizer into the current render-target surface (span-based, no Z-buffer for Phase 1; add ZBUFFER once lit shading looks right).
3. Transform pipeline: concat World × View × Proj, apply to incoming vertices, divide-by-w, viewport scale.
4. Color fill first (diffuse only), then add Gouraud interpolation, then textures.

Even a flat-shaded no-texture rasterizer would show that MCM/ARCHITEC are live and producing geometry. That alone is a good milestone worth chasing.

Verified: ARCHITEC.SCR `/s` runs clean through 2000 batches; MARBLES.EXE unaffected (800-batch smoke).

**Next blocker:** geometry still missing. Per earlier trace each `Execute` is a lone `STATETRANSFORM size=8 count=3` with no `PROCESSVERTICES` / `TRIANGLE` — the mesh-load path still never emits `CreateFileA("ar_mesh.x")`, so the pipeline is rendering nothing. That's the remaining work.

**Update (2026-04-20) — prior "Bug A: texture-path truncation" rabbit hole retracted; root cause re-localized.**

Earlier sessions chased `GetFileAttributes(".gif")` and `CreateFile("c")` failures from a strrchr-based extension stripper inside fn `0x74451020` (texture loader). Closer look this session shows Bug A is **non-blocking**: `lib/filesystem.js fs_search_path` already strips duplicated `.X.X` extensions (lines 467-470), so when the loader builds `Foo.gif.gif` and falls through from a failed `GetFileAttributes` to `SearchPath`, the texture resolves correctly (`SearchPath("Bwroom.gif.gif") → "C:\bwroom.gif"` in trace). Textures actually load.

Other findings localized this session:

1. **`Direct3DRMCreate` IS called and succeeds** — even though `$handle_Direct3DRMCreate` (`src/09a8-handlers-directx.wat:2476`) returns E_FAIL, d3drm.dll is loaded as real PE code (DllMain runs, 1182 thunks patched). The IAT slot for `Direct3DRMCreate` is patched to point at d3drm's real export, NOT our stub. Verified via `--trace-at=0x7440c240 --trace-at-dump=0x744d6a48:8`: cache var goes 0 → 0x74e1339c (real RM object) between trace-at #1 and #2. Our stub never executes.
2. **App uses pure D3DIM — no RM COM methods called.** 300k-line trace-api log shows only `IDirect3DDevice*`, `IDirect3DViewport*`, `IDirect3DExecuteBuffer*`, `IDirect3D*`, `IDirectDrawSurface*`. Zero `IDirect3DRM*` methods. So `Direct3DRMCreate` succeeds but RM is unused for mesh/geometry.
3. **Zero `.X` files opened.** trace-fs CreateFile shows only 4 unique paths total (none `.X`). `Inform0=ar_mesh` is parsed correctly from `.scn` (verified via `--trace-ini`), but the mesh data is never read from disk through any code path.
4. **The empty `CreateFile("")` from d3drm-internal resolver is unrelated** — d3drm's init does some filesystem probing that fails silently, but no app code ever calls `IDirect3DRMMeshBuilder_Load` (those vtable slots never fire), so it's not the rendering blocker.

**Real status:** something between `Inform0=ar_mesh` (parsed from `.scn`) and any file/API access fails silently. The app SHOULD load `AR_MESH.X` either via its own `.X` parser (would call `CreateFile/ReadFile`) or via `IDirect3DRMMeshBuilder->Load` (RM COM method) — neither happens. Scene-loader bails before reaching the mesh-load step.

**Next session strategy:**
- `--break-api=GetPrivateProfileStringA` to catch when `Inform0` is queried.
- Step out, follow the buffer pointer to see who consumes the returned string.
- Look for a call to mesh-load fn that takes that string — likely in the same scene-init code that calls fn `0x74451020` (texture loader). Caller `0x74450abf` is the prime suspect (3rd xref to texture loader, 303 bytes long entry — looks like the dedicated scene-load fn).

**Tracing upgrades landed this session:** `lib/filesystem.js fs_create_file` (commit `0c4699a`) and `fs_get_file_attributes` (commit `8e69dd2`) now log caller RA when path is short (<3/<6), empty, or starts with `.`. Reduces the need for one-off `console.log` hooks when chasing empty-path bugs. Later extended to also stack-scan up to 256 dwords above ESP and print plausible code pointers (range `0x74400000..0x76000000`) as `stack=[...]` — caveat: results contain stale stack values, so chain entries need cross-checking.

**Session 2026-04-20 (b) — traced the `CreateFile("c")` wrapper chain:**

Repeated calls to `CreateFile("c", access=0x80000000, creation=3) → FAIL ra=0x744a901d` during scene enumeration decode as:

- `0x744a9003` — CreateFileA invocation site (`push 0; push edi; ...; call [0x744b212c]`). Fallthrough from 0x744a8fe1 `jnz`.
- `0x744a8e50` — `_sopen(path, oflag, shflag, pmode=0x1a4)`. Parses `[esp+0x30]` oflag via jump table at 0x744a91a4.
- `0x74499490` — fopen-style mode-string parser. Entry switches on first byte of mode string (`'a'`/`'r'`/`'w'`), jumps into per-mode flag table at 0x744995ec.
- `0x74499660` → `0x7448eef0` → `0x7448ef30` — thin fopen wrapper chain (pushes `0x40` shflag, passes through mode).

Mode strings seen at fopen callers: `"rb"` (at `0x744c3fe8`, from caller `0x7440e29e` inside fn `0x7440e260`) and `"rt"` (at `0x744cfa5c`, from caller `0x74458703`). Neither produces a literal `"c"` path — mode is always 2 chars.

The `"c"` path therefore comes from a DIFFERENT high-level caller, not `0x7440e260`. Confirmed: `--break=0x7440e260` and `--break=0x7440e29e` never fire in 10000 batches, even though the stack-scan pointed at `0x7440e2a3` — that was stale data left on the stack by an earlier unrelated call.

**Hypothesis:** `"c"` is one byte of a longer path that got truncated — classic off-by-one where the loader grabbed `path+1` instead of `path`, leaving only the trailing char after `'C'`. OR the path buffer's leading byte was overwritten with NUL after the first char.

**Approach for next session:** add a conditional probe that only fires when path matches `/^[a-z]$/` — e.g. modify `fs_create_file` to dump a FULL stack-walk (+ saved ebp chain if present) only for that case, or run with `--break-api=CreateFileA` and add a conditional in the handler. Alternatively, xref all 51 callers of `0x7448eef0..0x7448ef50` range (see `tools/xrefs.js test/binaries/screensavers/ARCHITEC.SCR 0x7448eefe --near=0x100`) and narrow by which one is active during scene load.

**Session 2026-04-20 (c) — `"c"` path localized to an MFC CString bug in the app:**

Better stack walker in `lib/filesystem.js` (validates candidate RAs by checking the byte before — `E8 rel32` or `FF /r` indirect call) yielded a clean frame reconstruction:

```
frame=[+0:0x744a901d*i (CreateFileA wrapper),
       +44:0x744995a6*R (fopen core),
       +68:0x7448ef14*R (fopen inner wrapper),
       +84:0x7448ef41*R (fopen outer wrapper 0x7448ef30),
       +94:0x7440e2a3*R (real top-level caller = fn 0x7440e260)]
```

`*R` = preceded by `E8` call, `*i` = preceded by `FF` indirect call. Offsets are ESP-relative. Breakpoint confirmation: `--break=0x7440e260` fires at batch 240 — the function IS called. (Mid-block addresses like `0x7440e29e` don't fire because breakpoints only trigger at block boundaries.)

**Fn `0x7440e260` is a fopen-wrapper with SEH:**
- Takes a struct pointer as arg1 (read into `edi = [esp+0x440]`).
- Reads `[edi+4]` = path pointer into `eax`.
- If `eax == 0`, substitutes default `0x744b24a0` (which at runtime holds all zeros → empty path).
- Pushes `push 0x744c3fe8 ("rb")` + `push eax`, calls `0x7448ef30` (fopen wrapper).

**`--trace-at=0x7440e298 --trace-at-dump=0x74a16ae1:64` shows the runtime path content:**

```
0x74a16ad0  63 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00  c...............
0x74a16ae0  01 63 00 00 01 72 69 61 00 00 00 00 00 72 30 00  .c...ria.....r0.
```

`[0x74a16ae0] = 01 63 00 00` decodes as an **MFC CString header**: refcount=1 (byte 0x01), followed by the CString data at `0x74a16ae1` = `"c\0"`. Classic MFC CString layout (`m_pchData` points past a header). So the fopen path IS genuinely "c" — a single-character CString.

The outer-outer caller is fn `0x7440ffa0` (invoked via `ecx = this`; does `mov ebx,[ecx+0x18]; lea ebp,[ecx+0x4]; add ecx,0x8; push ecx; push ebp; push &local; call 0x7440e260`). It's a thiscall method on some class — the CString `"c"` comes from `[this+4]` or `[this+8]` slot. Only 2 xrefs: `0x7440fff6` (this fn) and `0x74410676`.

**Open question:** what SHOULD the CString contain? The nearby bytes `ria` (+4) and `r0` (+13) look like fragments of a longer string that was zeroed in places. Could be "Material0" / "ar_textu" / "Architecture" — any of which would be legitimate scene-asset names that got corrupted to a single char. Watchpoint on `0x74a16ae0` showed only one dword-aligned write (0x74614d00 at batch 170, EIP=0x74402f8c) — subsequent writes are byte-level so don't trigger the dword watch. **Next step: use `--watch` at byte granularity OR add `--watch-byte=0x74a16ae1` to catch where "c" gets stored, then work back from that EIP to find the truncation bug.** Suspect a `strncpy(dst, src, 1)` or an off-by-one in `sscanf`/`CString::Format`.

**Tracing upgrade landed this session (uncommitted):** `lib/filesystem.js fs_create_file` now emits `frame=[...]` with validated RAs (byte-before-RA preceded by `E8` or `FF`) plus ESP-relative offsets. Much more reliable than raw stack-scan for identifying real callers. Commit before next session.

**Session 2026-04-20 (d) — `"c"` is NOT a corruption; it's a legitimate TextureMap lookup miss:**

New `--watch-log` + `--watch-byte` (landed this session) made the mutation timeline on `0x74a16ae0` trivially visible. Full sequence (batches 170→248):

| Batch | Old → New | EIP | Note |
|---|---|---|---|
| 170 | `00000000 → 74614d00` | 0x74402f8c | `rep movs` copies "Mat..." into buffer (CString::AssignCopy, fn 0x74402f5b) |
| 171 | `74614d00 → 74614d01` | 0x74454b5a | refcount bump |
| 172-210 | buffer bounces through release/alloc cycles | | buffer pool reuse |
| 239 | `00 → 63 (byte)` | 0x7441a293 | **'c' written** (EIP is the insn AFTER the writing call) |
| 243-248 | `00006300 → 00006301 → 02 → 03 → 02 → 01` | various | post-write refcount ops |

Backtracking from EIP 0x7441a293 (byte-watch) and prev_eip 0x74402ac6:

- `call at 0x7441a28e → 0x74402a50` (`CString::AssignCopy(src, len)`) is what wrote "c". src came from fn `0x744aac30` (strdup) → fn `0x7448f2c0` (`_strlwr`).
- So the fn body at `0x7441a220` is: strdup the caller's CString → lowercase in place → copy into a new local CString → lookup in hashmap at `0x7441b630` → log via format string `"%s: Retrieved texture \"%s\" from TextureMap"` at `0x744c6624`.
- **Format string identifies the subsystem: TextureMap lookup.** The fn is `TextureMap::Get(CString& out, CString key)` or similar.

Caller chain verified with `--trace-at=0x744214a9` (right after the call returns) and struct dump at ebx=0x74a16910:

```
struct LookupRequest {      // ebx
  +0x00: vtable 0x744b2904
  +0x04: TextureMap*       = 0x74e127e4
  +0x08: 0xFFFFFFFF        (flag)
  +0x0c..+0x18: CString    { hash?, pData=0x74a16971, len=1, alloc=31 }  → "C"
  +0x1c..+0x2c: 4 floats   ≈ 0.86, 0.91, 1.00, 0.98  (RGBA / UV?)
};
```

Pool layout around `0x74a16940`:
```
0x74a16940  00 CALogo.gif\0 ...         ← packed CString slot 1
0x74a16960  00 notfound\0 ...           ← slot 2
0x74a16970  00 C\0 ...                  ← slot 3 (what we've been chasing)
0x74a16990  00 notfound\0 ...           ← slot 4
```

The CString contains literally "C" — not a truncation of "CALogo.gif". They are independent packed entries in a CString pool (each slot = 0x30 bytes, rc byte + data + null + padding).

**Conclusion:** `"C"` is the legitimate texture key being looked up. The TextureMap doesn't contain it → fn returns null → the app takes a fallback path that ultimately calls `fopen("c")`. This is an **asset/scene-loading problem**, not a memory corruption bug.

**Hypotheses for why TextureMap is empty / doesn't contain "C":**
1. The scene file (Architecture.scn or similar) was parsed but texture entries were not registered into the map (texture-loader handler missing / returns early).
2. The map IS populated but with differently-cased keys. Note the code lowercases before lookup — if entries were stored with "c" lowercase that should work. But if stored as "C" uppercase and lookup lowercases, it'd miss.
3. "C" is a per-triangle color/texture ID that indexes into a separate table we haven't loaded.

**Next investigation:** break on `0x7441b630` (hashmap lookup fn) when it's called with NON-"c" keys to see what valid keys it takes. Also `--break-api=CreateFileA` filtered for *.scn/*.bmp opens to see if the texture-file reader ever successfully reads anything. Additionally: dump the TextureMap at `0x74e127e4` to see its current contents.

**Tracing work landed this session** (items 1-6 from the TL;DR): non-interactive `--watch-log`, `--watch-byte/-word` (new WAT `$watch_size`), `--trace-at-watch` diff dumps, `--show-cstring` pretty-printer, shared `walkStackFrame()` in `lib/mem-utils.js`, `_frameHint` refactor in `lib/filesystem.js`. All committed.

**Session 2026-04-20 (e) — TextureMap is empty; scene-picker skips architec.scn:**

Confirmed via `--trace-at=0x7441a220 --trace-at-dump=0x74e12a38:16`: the TextureMap std::map at `this+0x254` has **size=0** and `_Myhead` with left==right==self (empty-tree sentinel). So EVERY TextureMap::Get call misses regardless of input — the map was never populated.

**Why** — `--trace-ini` (category already existed in `lib/storage.js`; had to discover it) revealed the actual scene-loading flow:

1. App enumerates every `.scn` file, reads `[Description]/Name` + `[Description]/Active`.
2. `architec.scn` has `Active=0`; all other `ca_*.scn` files have `Active=1`.
3. App reads **every key** from architec.scn anyway (Texture0=`ar_textu`, Backdrop=`ar_wallp.GIF`, etc.) — this is just the scene-enumeration/metadata pass.
4. Then loads `ca_diagr.scn` (Texture0=`Granite`, Backdrop=`""`, Environment=`YUV`) — a different scene wins the pick.
5. `Granite` isn't on disk as a file; it's a hard-coded texture name presumably served by a built-in TextureMap ("Granite", "Marble", etc.) that the app is supposed to populate at init.
6. The map is still empty at batch 260 → the texture-registration code never ran.

**So the "C" key is most likely a single-char texture lookup derived from a string-iteration pattern OR a glyph cache hit — investigating further needs a watch on where LookupRequest is constructed (who writes "C" as the src CString at `[ebx+0x0c]`).**

**Real next-session starting points:**
1. **Find the TextureMap populate fn.** Vtable is at `0x744b28b0` — disassemble its methods (especially constructor and insert). Search xrefs to `0x74e12a38` (the map's internal hashtable base) OR to the empty-string sentinel `0x744b24a0`.
2. **Identify what string `"Granite"` / `"Marble"` / etc. should trigger.** These are hardcoded built-in texture names; find them as string literals in the PE and trace xrefs to find the init path that registers them with TextureMap.
3. **Confirm whether "C" is a glyph-cache key vs. a texture-name char iteration.** Watch `0x74a16910` (the LookupRequest struct) from earlier batches to see who constructs it and with what source.
4. **Useful tool that's missing:** `--trace-call=0xADDR` — log ARG values on every entry to a given fn. Would immediately answer "what keys get passed to TextureMap::Get?" without the current break-and-dump dance.

**Session 2026-04-20 (f) — fn 0x7441a220 is actually GetOrCreate, not plain Get:**

Second format string `"%s: Adding \"%s\" to TextureMap"` at VA `0x744c65cc` (file offset 0xC55CC in .data) has exactly ONE xref: `0x7441a3c7` — also inside fn 0x7441a220. So this fn is **GetOrCreate(key, flag)**:

- **Hit path**: `0x7441a2ef` logs `"Retrieved texture"` format string at `0x744c6624` → returns `[node+0x1c]`.
- **Miss path + flag check**: `0x7441a3a7` reads `[esp+0x58]` = arg flag, `test; jz no-insert`.
- **Miss + insert path**: logs `"Adding ..."` at `0x744c65cc`, calls `0x7441b6d0` (probably `std::map::insert` / allocator), calls `0x7441b480` (probably load texture from file), calls `0x7441ac80` and `0x7441aa90` (node construction + CString ops), writes result to `[esi+0x1c]`.
- **Miss + no insert**: returns null.

The four wrappers (0x7441a540 / 0x7441a620 / 0x7441a8a0 / 0x7441a980) all pass flag=1 in their observed code paths — so EVERY miss should trigger the insert/load branch. And in our trace it does: miss with "C" → insert path → texture-file load → fopen("c") via CRT (fn 0x744a9003 wrapping import [0x744b212c] = CreateFileA). The file isn't on disk → insert still registers the entry but with a null texture data, OR bails out before inserting.

So the question "why is the map empty" has a concrete answer: **textures are loaded from FILES with their INI name as a lowercased basename (no extension)**. The scene `ca_diagr.scn` wants `Texture0=Granite` → app tries `fopen("granite")` → fails → no entry inserted. Same for "C" (whatever caller is asking for it). The VFS doesn't have these as raw basenames; extensions would be `.gif`/`.bmp`/`.tga`.

**This is a file-extension / naming mismatch, not a missing init pass.** Checking what file extension / search path the texture-loader tries is the direct next step. Break on `0x744a9003` (the fopen wrapper) with an EIP trace to see exactly what filename string is passed in each call, then work backward from there. Also check whether VFS lookup is case-sensitive — since the key is lowercased but files on disk may be uppercase (e.g., `CALogo.GIF`).

**Session 2026-04-20 (g) — "c" is a real 1-char CString, not truncation:**

Raw memory dump at the CreateFileA filename pointer (pathWA=0x628ac1 → guest 0x74a16ac1) at the moment of the call:

```
-8..-1:  00 00 00 00 00 00 00 01   ← MFC CStringData header: nRefs=0, nDataLength=1
+0..+3:  63 00 00 00                ← "c\0"
```

So the CString literally contains one character ("c") with a correctly-formed MFC header declaring length=1. **Not an emulator string-truncation bug** — the scene-parsing code is storing "c" on purpose (or as the result of an upstream logic error that is faithful to the app's intent — e.g. reading the first char of some field).

**Call chain** (from `--trace-fs` `frame=[…]` + `disasm_fn` on each return address):

| Level | Return addr | Fn entry | What it does |
|-------|-------------|----------|--------------|
| 0 | 0x744a901d | 0x744a9003 | fopen-wrapper inner block — calls `[0x744b212c]` = CreateFileA with args built from caller-passed filename/access/mode |
| 1 | 0x744995a6 | 0x744994b7 | fopen mode-dispatch ('a'/'r'/'w') — enters 'w' variant at 0x744994b7 |
| 2 | 0x7448ef14 | 0x7448eefe | `fopen(filename, mode, shflag)` wrapper — pushes 3 args and calls `0x74499490` (fopen mode-parser) |
| 3 | 0x7448ef41 | 0x7448ef30 | `fopen(filename, mode)` → `fopen_share(filename, mode, 0x40)` — forces share flag 0x40 |
| 4 | 0x7440e2a3 | 0x7440e260 | **Texture-loading fn** — `mov eax, [edi+4]; if zero use empty-CString sentinel 0x744b24a0; push mode-"rb"-string@0x744c3fe8; push eax; call 0x7448ef30`. Arg `edi` at `[esp+0x440]` (3rd arg). SEH-protected. |

**Fn 0x7440e260's third arg structure** (`edi`):
- `[edi+0x4]` — CString* pointer (the filename). If null → use empty sentinel; otherwise fopen that CString.
- Callers at 0x7440fff6 and 0x74410676 pass `(orig_ecx+8)` as this arg. So there's an object where offset +0x08+0x04 = +0x0C holds a CString pointer.

**Mode string** at 0x744c3fe8 = `"rb\0\0couldn't read left/top/width…"` — confirming this path reads assets in binary mode, and the "couldn't read" error is what fires after the failed open.

**Next-session concrete experiment:** watch guest addr `0x74a16ac1` for WRITES (the single-byte 'c' value). Who writes 0x63 there? Likely an MFC `CString::operator=` or `strcpy`-equivalent during scene parsing that's being handed a source pointer to a single char — maybe taking address-of a loop variable that holds the current character instead of the full string. Use `--watch-byte=0x74a16ac1 --watch-log` to get a non-stopping log of every write to that byte with the prev_eip of the writer.

Also useful: `--watch-log` on the parent CString pointer slot (wherever `[edi+4]` resides for this particular struct) to find who assigned the 1-char CString to that object.

**Session (g) continued — writer is GetOrCreate's own `strlwr(strdup(key))` result copy, not external corruption:**

`--watch-byte=0x74a16ac1 --watch-log` hit at batch 121 with prev_eip=0x74402ac6 inside a generic MFC `CString::AssignCopy(this, src, len)` at fn 0x74402a50 (106 xrefs — hot path). The specific call that wrote here came from 0x7441a28e inside `TextureMap::GetOrCreate` (fn 0x7441a220) itself:

```
7441a255  push eax                  ; key's buffer-ptr ([key_CString+4])
7441a256  call 0x744aac30           ; strdup → new buffer
7441a25e  push eax
7441a25f  call 0x7448f2c0           ; strlwr (in-place lowercase A-Z)
7441a288  push ecx                  ; nSrcLen (strlen of result)
7441a289  push esi                  ; src = lowercased dup
7441a28a  lea ecx, [esp+0x24]       ; local CString
7441a28e  call 0x74402a50           ; AssignCopy (writes 'c' into 0x74a16ac1)
```

So `0x74a16ac1` is the LOCAL lowercased-key CString built inside GetOrCreate. Its length is 1 because the **caller is passing a 1-char key CString** ("C" uppercase → lowercased to "c").

**Caller traced one more level:** the 4 GetOrCreate wrappers (0x7441a540/620/8a0/980) are each called from exactly one site:

| Wrapper | Flag | Caller | Enclosing fn |
|---------|------|--------|--------------|
| 0x7441a540 | 1 (insert-on-miss) | 0x744214a4 | 0x744213f7 |
| 0x7441a620 | 0 | — (no static xref) | |
| 0x7441a8a0 | 1 | — (no static xref) | |
| 0x7441a980 | 0 | 0x74451242 | 0x7445114e |

Call site at 0x74421498:
```
lea ecx, [ebx+0xc]    ; key-CString address (arg1 of wrapper)
lea edx, [esp+0x18]   ; out-CString buffer
push ecx              ; push &key
mov ecx, [ebx+0x4]    ; TextureMap this = [ebx+0x4]
push edx              ; push &out
call 0x7441a540       ; → GetOrCreate(flag=1)
```

So `ebx` is a record struct where:
- `[ebx+0x04]` holds a TextureMap pointer (the "this" for the member fn)
- `[ebx+0x0C]` is an inline CString member holding the texture key
- `[ebx+0x10]` is the CString's buffer pointer (points to the "C" string data)

Fn `0x744213f7` is clearly a **mesh/material record builder** — its entry region is filled with FPU stores to `[ebp+0x18..0x64]` (floats for position/color/transform). It's almost certainly parsing a chunk from `AR_MESH.X` / `AR_TEXTU.GIF` / the scene geometry stream, and storing a **per-mesh texture key** at `[ebx+0x0C]`. For ARCHITEC the stored key is the 1-char string "C".

**Likely root cause:** the .X / scene binary parser is reading a 1-byte-length-prefixed string incorrectly and stopping after 1 byte. Or the .X file literally has a material named "C" (unlikely but possible) and the app expects a built-in texture named "c" to exist — which it doesn't because our built-in TextureMap is empty.

**Concrete next steps:**
1. xref fn `0x744213f7` upward to find the parser loop that fills the struct at `ebx`.
2. Check `test/binaries/screensavers/AR_MESH.X` and `ALIEN.X` for any single-char material/texture names.
3. Separately, investigate the "built-in textures" theory: there are hard-coded names like `"Granite"`, `"Marble"` that scenes expect — find the init code that registers them. If `"c"` is a single-letter built-in (e.g. color-channel shortcut), that init path is the real missing piece.
4. Tool gap felt this session: add `--trace-call=0xADDR[,...]` that auto-decodes the first CString arg at entry (this-call ECX or [esp+4]). Would have short-circuited 3 levels of disasm.

**Session (g) continued — THE BIG REVEAL: this is a Pascal ShortString / length-prefixed buffer:**

Located the actual key buffer at guest `0x74a16900` (= `[ebx+0x10]` where ebx=0x74a168f0 is the parent struct observed at GetOrCreate entry). `--watch=0x74a16900 --watch-log` produced a sequence of DWORD values that tells the whole story:

| Batch | Old dword | New dword | LE bytes | Interpretation |
|-------|-----------|-----------|----------|----------------|
| 87 | 0x00000000 | 0x6c6f4300 | 00 43 6f 6c | `[len=0]`+"Col" |
| 88 | 0x6c6f4300 | 0x6c6f4301 | 01 43 6f 6c | `[len=1]`+"Col" → observer sees "C" |
| 89 | 0x6c6f4301 | 0x6c6f4300 | 00 43 6f 6c | len back to 0 |
| 94 | 0x6c6f4300 | 0x6c6f0000 | 00 00 6f 6c | "ol" remnant |
| 95 | 0x6c6f0000 | 0x74614d00 | 00 4d 61 74 | `[len=0]`+"Mat" |
| 96 | 0x74614d00 | 0x74614d01 | 01 4d 61 74 | `[len=1]`+"Mat" → observer sees "M" |
| 97 | 0x74614d01 | 0x74614d00 | 00 4d 61 74 | len back to 0 |

**This is a Pascal ShortString layout: first byte = length, subsequent bytes = chars.** OR: it's a fixed 4-byte slot used to hold packed 3-char identifiers ("Col", "Mat") with a separate in-band length/flag byte.

Someone is **repeatedly setting byte[0] to 1, letting code read the buffer as a C-string (seeing just 1 char "C" or "M"), then restoring byte[0] to 0**. That's a property-probe pattern — the caller is asking "what's the first char?" and the implementation is simulating it by temporarily claiming length=1.

Our emulator's TextureMap::GetOrCreate path picks up the 1-char state and honestly tries to load a file named "c" — which fails.

**Why it fails on the emulator but presumably works on real Win98:**
- On real Win98, texture loading is fast and the 1-char state is transient — the "real" texture key gets assigned later, overwriting this probe-artifact. GetOrCreate gets called with a proper key ("MARBLE-green.ppm" etc.) before any fopen matters.
- On our emulator, SOMETHING is calling GetOrCreate while the slot is still in probe state, latching the bad key.
- Alternatively, we have a threading / ordering bug — a code path that's supposed to run AFTER a different one (that writes the real key) is running first.

**Next-session starting points:**
1. Find the full sequence of callers that touch `0x74a16900`. Run with `--trace-at` at EVERY EIP in the watch-log (0x7445de41, 0x74454aca, 0x74402fa9, 0x7440ad33, 0x7445e1b8, 0x744205f2) to understand the setter/getter pairs.
2. The Borland string library almost certainly has a `StrAsg` / `LStrAsg` (AnsiString assignment) that manages refcounts and lengths. Identify the Borland runtime in the PE (look for `@System@LStrAsg` / `System::AnsiString::operator=` patterns) and compare behavior to what our emulator does for memcpy/strcpy primitives.
3. Check whether the struct `ebx` (0x74a168f0) is supposed to have its texture key set by a LATER code path that's being skipped. e.g. the 0x744213f7 fn we identified as the parser may fire for one scene element but not the next — the "c" key may be a LEFTOVER from initialization that a subsequent parse should overwrite but doesn't.

#### Gemini review of emulator WATs — candidate emu bugs

Ran a second-opinion review across `src/03-registers.wat` / `04-cache.wat` / `05-alu.wat` / `06-fpu.wat` / `07-decoder.wat` looking for mechanisms that could cause deterministic divergence after N identical iterations. Findings to verify (ranked by plausibility for this symptom):

1. **2-op / 3-op IMUL sets no flags.** `$th_imul_r_r_i` (`05-alu.wat:782`), `th_imul_r_r`, `th_imul_r_m_ro`, `th_imul_r_m_abs` all do `set_reg(..., i32.mul(...))` with no `set_flags_*` call. Our critical div-by-20 uses 1-op `imul ecx` which goes through `$th_imul32` (`05-alu.wat:746`) — that one DOES call `set_flags_mul`, so the direct div math is unaffected. But any 2-op/3-op IMUL elsewhere in the filter-fn body would leave stale flags for a following `Jcc`. Low-priority unless the CString/format paths use it.
2. **Block cache invalidation only matches block-start page.** `invalidate_page` in `04-cache.wat:30` only clears entries where the cached block's *start* address falls on the invalidated page. A block that spans a 4KB boundary and is invalidated by a write to its *second* page will be skipped → stale code reused. Plausible culprit if any write near the filter-fn code region happens mid-loop.
3. **FPU stack leak wrap at 8.** `fpu_top` is masked `& 7` in `06-fpu.wat:100`; if any FPU op inside the filter pushes without popping (or vice versa), state drifts every call and wraps every 8 iterations. Our failing iteration is the 11th (not a clean 8-multiple), but drift-then-corrupt semantics could still be it. Check if filter or its CRT helpers use x87 at all.
4. **ADC/SBB carry-fix clobbers OF.** `th_adc`/`th_sbb` in `05-alu.wat:231` force `flag_b=0` under the raw-mode branch, destroying overflow semantics. Relevant only if any code between here uses `JO`/`JNO` on ADC output.
5. **SIB index=4 ("no index") encoding.** `emit_sib_or_abs` encodes no-index as `mr_index=-1` → `shl 4` = `0xFFFFFFF0`. `th_compute_ea_sib` masks `>> 4 & 0xF` = `0xF` and compares. Currently correct by accident; fragile if any path ever initializes `mr_index` differently.

Full review saved at `/tmp/gemini-emu-review.txt`.

**Verification (this session):** none of Gemini's top four candidates match the evidence for this specific throw:

- **Cache clears don't fire.** Ran the full reproducer with `--verbose`; greped trace for the `0xCA00F10F` overflow marker and `0xCAC4BAD0` bad-handler marker — 0 hits. So neither `$clear_cache` nor the decoder's overflow path runs during the failing window.
- **No x87 in the filter function.** Scanned disasm of `0x74414a30` +0x320 bytes for opcodes `D8..DF` — 0 matches. The filter body is integer-only, so FPU-stack drift can't be the cause.
- **1-op `imul ecx` is correctly flagged.** Our div-by-20 path goes through `$th_imul32` at `05-alu.wat:746`, which calls `$set_flags_mul`. The gemini-flagged 2/3-op IMUL handlers aren't on the hot path (and flags are overwritten by the following `xor eax,eax; test edx,edx` anyway).
- **ADC/SBB OF loss requires a `JO` after ADC.** Grepping the filter-fn disasm shows no JO/JNO.
- **`$invalidate_page` is only called from `$gs32/gs16/gs8`**, guarded by `[code_start, code_end)` bounds. Guest writes in our scenario land in heap/stack (`0x74a0*`, `0x74e1*`, `0x77ff*`), not code pages — so the gemini cross-page invalidation bug can't be triggered here (the write path to it never runs).

**Conclusion:** the emulator bugs Gemini flagged are real in the abstract but don't explain this specific symptom. The actual cause is still open. New lead worth trying: verify whether the "12 identical trace-at hits at `0x74414a30`" are really 12 distinct calls (stack-walk the return chain on each hit to see whether ESP+ret-addr varies), or an artifact of our batch-boundary bp sampling. If it's actually one or two calls that our bp re-reports, the divergence may be a single pass whose internal loop iterates differently than expected — much smaller search space than "12 independent failures."

#### Related files

| File | Purpose |
|------|---------|
| `src/09a8-handlers-directx.wat:683+` | `$d3d_enum_devices_invoke` + `$d3d_enum_devices_dispatch` + `$d3d_enum_devices_continue` |
| `src/09a8-handlers-directx.wat:763` | `$fill_d3d_device_desc` — DDBD mask fix |
| `src/09aa-handlers-d3dim.wat:33` | `$handle_IDirect3D2_EnumDevices` — now delegates |
| `src/01-header.wat:814` | Globals: `$d3d_enum_dev_{thunk,idx,cb,ctx,ret}` |
| `src/08-pe-loader.wat:240` | CACA000B thunk allocation |
| `src/09b-dispatch.wat:356` | CACA000B dispatch → `$d3d_enum_devices_continue` |
| `test/run.js:512-538` | MSVC C++ throw payload decoder (decodes DXException) |

#### Key VAs in GEOMETRY.SCR framework (shared layout for all 7 savers)

| VA | What |
|----|------|
| `0x74413c00` | EnumDisplayModes callback (filters by refresh rate + 8bpp gate) |
| `0x74413f60` | EnumDevices callback |
| `0x74414149` | `call 0x74414230` inside callback — allocates 268-byte DeviceInfo, copies 204 bytes of D3DDEVICEDESC to `[DeviceInfo+0x24]` (so dwDeviceRenderBitDepth lands at `+0xC0`) |
| `0x74414a30` | Mode-vs-device filter function (entry point of throwing fn) |
| `0x74414c18-c26` | The critical AND: `and eax, [ebx+0xc0]` |
| `0x74414ccf-cfd` | "Filtered list empty?" check |
| `0x74414d83` | `call 0x7448e2e0` = _CxxThrowException wrapper |
| `0x744c51f0` | Format string "No valid modes found for this device" |
| `0x744b93d8` | DXException throwInfo |
| `0x744b66a0..0x744b66d0` | Four fallback device GUIDs: TnLHal, HAL, MMX, Ramp |
| `0x744153f0` | `SelectDeviceByGUID(GUID*)` — matches enumerated DeviceInfo.GUID at `+0xF0` |
| `0x7441557c` | `mov [edi+0x218], ebp` — the one non-zero store to `[this+0x218]` |
| `0x7441ad40` | `std::vector<ModeEntry>::insert` (20-byte elements, div-by-20 via 0x66666667) |

### 4. MFC screensavers blocked on COM/DirectDraw
**Priority: DEFERRED** — WIN98.SCR runs its animation loop (fixed IDirectDraw2 SetDisplayMode stack corruption and implemented IDirectDrawSurface::GetDC) but DDraw surface content is not yet rendered to screen — needs DDraw-to-renderer blitting. All 5 MFC screensavers reach the message loop correctly (CBT hook fix works) but have no visible animation content.

Added `CLSIDFromProgID` stub returning `REGDB_E_CLASSNOTREG` (0x80040154) so the four COM-image screensavers degrade gracefully instead of `crash_unimplemented`. `IDirectDrawFactory` (ddrawex.dll CLSID 0x4FD2A832) short-circuited in `CoCreateInstance` and exposes 5 vtable methods (api_ids 1136–1140) that delegate to the existing DDraw wrappers.

**Investigation (CORBIS.SCR, 2026-04-20).** The "COM image loading" hypothesis was wrong — it's not IPicture/OleLoadPicture. CORBIS actually:
1. `CoCreateInstance(CLSID_DirectDrawFactory {4FD2A832-…}, IID=4FD2A833 IDirectDrawFactory)` — already short-circuited, succeeds.
2. `IDirectDrawFactory::CreateDirectDraw` → `IDirectDraw::CreateSurface` — works.
3. `CLSIDFromProgID(L"DirectAnimation.DAView")` then `CLSIDFromProgID(L"DirectAnimation.DAStatics")` — both stubbed to `REGDB_E_CLASSNOTREG`.
4. Reads `HKLM\SOFTWARE\Microsoft\Plus!98\ScreenSavers.Corbis\MediaDirectory` (not found) and an internal fallback string at `0x4d66bc`.
5. Runaway EIP to `0x0053f3ad` shortly after — likely indirect call through a DAView vtable slot that was never populated because CLSIDFromProgID failed.

The actual blocker is **DirectAnimation** (DAView + DAStatics), a very large COM surface (IDAView, IDAStatics, IDAImage, IDASound, etc. — from `danim.dll`). Not small. Bringing even a minimal DirectAnimation up is probably bigger than the DirectDraw work already done. The other three (FASHION/HORROR/WOTRAVEL) share the framework so likely identical.

Path forward if revisited: either (a) implement a minimal DirectAnimation-over-canvas shim, or (b) detect the CLSIDFromProgID failure path and confirm whether the runaway is just a missing NULL-check in the guest (degrade-to-black instead of crashing) — the latter is probably cheaper but leaves zero animation.

##### Session 2026-04-21 — DrawPrimitive diagnostic: d3rm submits degenerate origin-quads

Picked up from (cont.5) thread. Rebuilt and ran ARCHITEC `/s` with an expanded DP2 trace (lib/host-imports.js case 10 now dumps all 8 dwords per vertex, not just sx/sy/color). Finding:

- 20 `IDirect3DDevice2_DrawPrimitive` calls in 3000 batches. All identical:
  - `primType=5` (TRIANGLESTRIP), `vtxType=3` (TLVERTEX), `count=4`
  - All 4 vertices are byte-for-byte identical within each call:
    `sx=0.0, sy=0.0, sz=0.99, rhw=1.01, color=0x3f000000, spec=0xffffffff, tu=0, tv=0`
- These aren't garbage: rhw≈1.01 and spec=0xffffffff are deliberate d3rm values. The app is submitting real TLVERTEX data — just with (sx,sy) collapsed to origin.

**Why all (0,0)?** Because d3rm has no mesh. Per cont.4: 0 `.X` files ever opened — `AR_MESH.X` / `GRAPPLE.X` never trigger `CreateFileA`. `.SCN` and texture `.GIF` loads work (via `SearchPath`), but the mesh-load leg of d3rm never fires. So d3rm's render loop processes an empty mesh → every "triangle strip" collapses to 4 copies of the origin vertex.

**Implication for priorities:** a software rasterizer is moot until mesh loading works. Even a perfect DrawPrimitive would rasterize 0-pixel degenerate triangles. Next actionable step is finding why d3rm's mesh loader never reaches a file API. Candidates:

1. d3rm's internal `.X` parser may use a CRT path that bypasses our traced wrappers. Confirm by breaking on d3rm's `CreateFile` IAT thunk (whichever module-local thunk at `0x745x_xxxx` resolves `CreateFileA` — d3rm has its own IAT).
2. The app may never pass the mesh filename to d3rm at all — e.g. an app-side `IDirect3DRMMeshBuilder::Load` stub or missing init step. cont.5 notes "zero `IDirect3DRM*` methods called" in the trace, consistent with this.
3. Scene-init may bail before reaching mesh load. Break on app-side scene-load fn (see cont.4 entry re: `fn 0x74451020` texture loader — its peer fn for meshes is unidentified).

**Diagnostic uncommitted:** the richer DP2 formatter in `lib/host-imports.js` (case 10). Worth keeping for future DP inspection.

##### Session 2026-04-21 (cont.) — mesh loader located, executes, but produces nothing

Following cont.6: found the app-side mesh loader. It runs, receives correct names, calls its vtable worker, and returns without opening a file. So the bottleneck isn't "d3rm never gets asked" — it's "app-side load silently succeeds with empty data".

Located via `tools/xrefs.js` on the `"Inform: Loading mesh from \"%s\""` string (`0x744ca9e4`):

- **Scene-loader `LoadMesh(name)` entry:** `0x7442b680`. Sets `ebp = this` (ecx), takes name in `[esp+arg0]`.
- Flow: reject `name == "<none>"` (strcmp vs `0x744caa04`), append `.x` extension (strcmp vs `0x744c9ac0=".x"`), compare vs cached `[ebp+4]`, log "Loading mesh from…", then `call [edx+0x18]` where `edx = *(this+0x104) = 0x744b2a2c` (vtable in `.rdata`).
- Vtable `[+0x18]` = **method `0x74426290`** — the real mesh-load worker.

Evidence it runs:

- `--trace-at=0x7442b680 --trace-at-dump=0x74a16421:32` → 20+ hits in 3000 batches; first arg is ASCII `"Grapple-198"` (matches the scene spec from cont.4).
- `--trace-at=0x7442b725` (post-`<none>`-check) → 22 hits; `--trace-at=0x7442b828` (fail branch) → 8 hits.
- `--trace-at=0x7442b799` (block after `call [edx+0x18]`) → 22 hits. **Vtable call is executed and returns cleanly.**

Yet `--trace-fs` shows zero `.X` opens and trace-api shows zero `IDirect3DRM*` method calls. The load reports neither success via d3rm nor failure via the `"Mesh %s not found or load failed"` error string (`0x744ca9c0`) — it silently returns with empty data.

Disasm of `0x74426290` (first 80 bytes, via `tools/disasm_fn.js`): string-tail comparison against `0x744c9ac4` (likely `xof`/`.xof` suffix), a call to logging fn `0x74468d60` at level 4, strlen>4 gate (`jle 0x7442633f`). No `CreateFileA`, no DX call in the prologue — the load logic is deeper or behind another vtable.

**New hypothesis:** mesh cache already populated (wrongly) before LoadMesh is first called — possibly from an earlier bulk archive scan (`.LST`/`.DAT`) that returned zero entries against our VFS but was treated as "OK, cache built". Each LoadMesh then finds a stub cache entry and returns it.

**Next-session leads (priority order):**

1. Break on call `0x74423c10` at `0x7442b7f7` (reached only if vtable-path fails and falls to the `"Mesh not found"` error-log branch). Currently never hits → vtable thinks it succeeded.
2. Bisect-walk through `0x74426290` to the first point it either (a) reads a file, (b) invokes a d3drm method, or (c) returns. Use `--trace-at` on its jump targets.
3. `--trace-fs` scan for bulk reads during scene-init — look for an archive-style pattern (one open, many reads) before the first `0x7442b680` hit.

**Runtime diagnostics (no source edits needed to reproduce):** `--trace-at=0x7442b680 --trace-at-dump=0x74a16421:32` for mesh-name visibility; `--trace-at=0x7442b725` / `0x7442b799` for branch confirmation.

##### Session 2026-04-21 (cont.2) — mesh load IS loudly failing; culprit is stale d3drm pointer

Revised cont.1: the "silent success" hypothesis was wrong. Every mesh load hits the error-log path; we just never saw the log because the app's logger (`0x74423c10`) doesn't route to `OutputDebugStringA`.

Branch probes (same 3000-batch ARCHITEC `/s` run):

- `--trace-at=0x7442b7ed` (error path, `"Mesh %s not found or load failed"` log) → **22 hits** (every single load).
- `--trace-at=0x7442b7da` / `0x7442b85c` (success paths) → 0 hits.

So `call 0x74425720` at `0x7442b7d1` returns NULL every time — this is the "did-the-vtable-call-produce-a-mesh-object?" getter, and it always reports "no".

**Mesh-load worker `0x74426290` — three candidate loaders tried in sequence:**

After `.xof` suffix strip and "Loading external visual from %s" log at `0x744c9a7c`, the worker calls three helpers; any returning `al=1` wins (`jnz 0x744263e3`). If all fail, bl=0 and `"Couldn't load %s"` (`0x744c9a68`) is logged via `0x74423c70`.

| Helper | Addr | Dispatches via |
|---|---|---|
| A | `0x74425ac0` | Internal — does string stuff then opens something via `0x7446d100`/`0x7446d1c0` (looks like `_mbsdup` + `strlen`). Actual loader body past the first 40 bytes. |
| B | `0x74425750` | `COM_obj = [0x744f828c]; COM_obj->Vtbl[0x18](COM_obj, &out)` — likely `IDirect3DRM::CreateMeshBuilder` (slot 6). Logs `0x744c9818` fmt at entry; logs `0x744c97f4` fmt on failure. |
| C | `0x74425960` | `COM_obj = [0x744f828c]; COM_obj->Vtbl[0x10](COM_obj, 0, &out)` — 2-arg method, possibly `IDirect3DRM::CreateFrame(parent=NULL, &out)` or a loader overload. Logs `0x744c9874` fmt at entry; `0x744c9854` fmt on failure. |

Both B and C null-check `[0x744f828c]`: if NULL, call `0x7448d250(0x80004003)` (E_POINTER) — then re-read the global, implying `0x7448d250` is a **lazy-init constructor** that populates the global on first use.

**Runtime value of `[0x744f828c]`:** `0x74e13390`. This is in app-heap territory (apps frequently alloc at `0x74a0_____` / `0x74e0_____`), **not in our DX_OBJECTS range** (`0x07FF_0000`). So the app's IDirect3DRM pointer is NOT one of our emulator-tracked COM wrappers — it's either a d3drm.dll-internal allocation or an uninitialized slot that got past the NULL check because it holds garbage.

This is the real root cause: **the app dereferences an IDirect3DRM vtable that doesn't resolve to our handler dispatch.** Trace-api would never show `IDirect3DRM*` method calls because the calls go through the stale/wrong vtable and fail synchronously.

**Next-session leads (in priority order):**

1. **Find where `0x744f828c` gets written.** `node tools/xrefs.js ARCHITEC.SCR 0x744f828c` should show `mov [0x744f828c], eax` stores. The writer is almost certainly `0x7448d250` (the lazy-init fn). Break on it, check what it's setting the global to — probably the return value of a `Direct3DRMCreate` call our emulator is mishandling.
2. Confirm by searching for `Direct3DRMCreate` IAT thunk in the `.idata` or in d3drm.dll's thunk area, breakpoint it, observe the return value. If our `handle_Direct3DRMCreate` writes a DX_OBJECTS pointer but something later overwrites `[0x744f828c]` with an app-allocated shim, that's the bug.
3. If `0x74e13390` really is what `Direct3DRMCreate` returned: look at our COM wrapper layout — we may be failing to populate the vtable at `*obj` (so `[eax]` holds garbage and `[ecx+0x18]` dispatches into random code).

**Runtime diagnostics:** `--trace-at=0x7442b7ed` (error-path counter), `--trace-at=0x7442b725 --trace-at-dump=0x744f828c:4` (inspect the global), `tools/xrefs.js ARCHITEC.SCR 0x744f828c` (find writer).

##### Session 2026-04-21 (cont.3) — full call chain pinned: d3drm returns D3DRMERR_FILENOTFOUND

Traced the complete path app→d3drm and identified exactly where the load fails. Revised diagnosis: the COM globals at `0x744f828c` / `0x744f8314` aren't "stale" — they're legitimately populated by d3drm.dll's own allocations (d3drm runs as real x86 code in our emulator, not a stubbed wrapper).

**Global population sequence** (via `tools/xrefs.js ARCHITEC.SCR 0x744f828c --op=store`):

1. Static init at `0x7444a640` zeros both globals.
2. Lazy init at `0x7444a714`:
   - `[0x744f8314]` gets an `IDirect3DRM` (v1) pointer — runtime value `0x74e1339c` (d3drm's internal heap).
   - Then `[0x744f8314]->QueryInterface(IID_IDirect3DRM3, &[0x744f828c])` where IID = `2BC49361-8327-11CF-AC4A-0000C03825A1`. Result: `[0x744f828c] = 0x74e13390`.

So `[0x744f828c]` is an **IDirect3DRM3** pointer into d3drm-allocated memory, with a real d3drm.dll vtable at `0x745fa9b8` — **not** one of our emulator's DX_OBJECTS wrappers. Method calls on it dispatch into d3drm.dll code that runs natively in our emulator.

**MeshBuilder::Load call signature** (loader B at `0x74425750`, after `CreateMeshBuilder` succeeds with HRESULT=0):

```
push [ebp+0x4]     ; lpArg (scene-side user data)
push 0x74450e70    ; lpCallback (app texture-load callback)
push 0x80          ; dwLoadOptions (non-standard — flags nibble doesn't match D3DRMLOAD_*)
push 0             ; lpvObjID
push edi           ; lpvObjSource = "Grapple-198" (no .x extension!)
push esi           ; this (mesh builder)
call [eax+0x2c]    ; vtable +0x2c = IDirect3DRMMeshBuilder::Load (slot 11)
```

Load resolves to d3drm.dll `0x745a518f` → thin CS-wrapped dispatch → real worker `0x74592acc` (d3drm-file VA `0x64792acc`).

**Runtime HRESULT capture** (`--trace-at=0x744257e4`, the block-entry on jge-failure branch): `EAX=0x88760313` on every one of 22 attempts.

Decoded: `0x88760313 = MAKE_DDHRESULT(0x313) = MAKE_DDHRESULT(787)` = **`D3DRMERR_FILENOTFOUND`** (from `d3drmdef.h`: codes 780-790 span BADOBJECT through BADRESOURCE; 787 is FILENOTFOUND).

`--trace-fs` during the same run shows zero `.x` opens and zero `Grapple*` lookups. So d3drm internally decides "file not found" **before reaching `CreateFileA`**. Two plausible causes:

1. **No extension & no search-path:** the app passes `"Grapple-198"` (not `"Grapple-198.x"`). d3drm's Load normally uses `SearchPath` or a DirectX-registered search directory to resolve bare names. If those registry/search-path hooks are stubbed to empty, d3drm bails pre-open.
2. **Accept-check failure:** d3drm verifies the filename against recognized extensions (`.x`, `.xof`) before opening. A bare name without extension and without the FROMMEMORY/FROMSTREAM flag set could be rejected immediately.

The non-standard flags value `0x80` is another clue — it's not any documented `D3DRMLOAD_*` constant. The Windows SDK defines only bits 0..5; bit 7 set suggests either the app is using an undocumented / extended flag, or a d3drm-private "search policy" bit that our d3drm.dll version doesn't recognize.

**Next-session leads (in priority order):**

1. Disasm d3drm.dll at `0x64792acc` (real Load) past the arg-marshalling to find the pre-open rejection. It calls `0x647ce0c5` with six args including buffer `0x64781700` and fn-ptr `0x647914e3` (likely a file-reader factory). The `0x88760313` return site in d3drm: file-offsets `0x1b9f8`, `0x1bb04`, `0x2e06e`, `0x2e309`, `0x4d547`, `0x4d57b` (but these are mid-instruction byte matches, not immediate-load instructions — 0x88760313 is computed inline via `or` from smaller constants, making static location tricky). Strategy: break on d3drm.dll function entries and bisect.
2. **Cheaper experiment:** try giving d3drm what it wants. The app's `SearchPath` / `GetFullPathName` hooks — do we implement them to walk a registered DirectX 3D-R-M search dir? Check `src/09a-handlers.wat` for `SearchPathA`. If bare-name resolution is the issue, maybe we can pre-register the scene asset dir as a search path, or make our CreateFileA fall through to VFS for bare names.
3. Cross-reference what WORKS: `.scn` files open fine (`FindFirstFile(".\*.scn") → "architec.scn"` — see trace-fs output above). So CWD-relative file lookup works for the app's code, but d3drm.dll may use a different resolution path.

**Established ground-truth this session:**
- Mesh-name flow: `Grapple-198` string at `0x74a16421` → passed to `LoadMesh(0x7442b680)` → passed to worker `0x74426290` → passed to loader B `0x74425750` → passed to d3drm.dll `MeshBuilder::Load` → returns `D3DRMERR_FILENOTFOUND`.
- IDirect3DRM3 live at `0x74e13390`, vtable `0x745fa9b8`, Load method at runtime VA `0x745a518f` = dll-file VA `0x6478a18f`.
- d3drm.dll relocation delta at load time: `0x7459b000 - 0x64780000 = 0xfe1b000` (needed to cross-ref between disasm of the DLL and runtime breakpoints).

##### Session 2026-04-22 — cont.3 diagnosis was wrong; real root causes found & fixed

Two unrelated bugs compounded to make d3drm return FILENOTFOUND. The "empty lpvObjSource" symptom from cont.3 was evidence of the first, not the second.

**Bug 1: TIB.ThreadLocalStoragePointer (FS:[0x2c]) was NULL.**

The screensaver's MFC string helpers (`0x7446d100`, `0x7446d1c0`) resolve per-thread scratch buffers via *direct* FS segment access:

```
mov eax, [0x744fa348]     ; slot index stored in .data by TlsAlloc
fs: mov ecx, [0x2c]       ; ThreadLocalStoragePointer (TLS array base)
mov eax, [ecx+eax*4]      ; slot value
lea ebx, [eax+0x1690]     ; per-thread basename buffer
```

They never call `TlsGetValue`. Our `$tls_slots` lives in its own allocation and nothing pointed TIB+0x2c at it, so `fs:[0x2c]` always returned 0 and the helpers dereferenced `[0 + slot*4]` (unrelated guest memory). Every string copy silently read from address ~0 and returned a bogus pointer — the mesh-name buffer presented to `MeshBuilder::Load` was the helper's "return value" NUL-stored into guest address zero, i.e. effectively empty.

Fixed in `src/08-pe-loader.wat` `$enter_entry_point`: eagerly allocate `$tls_slots` at PE load and set `fs_base+0x2c = tls_slots`. Now `TlsSetValue` and direct FS-segment reads agree. Verified with break at `0x745e8f1d` (d3drm's `0x647cdf1d`): `ebp+0xc` now points at a stack buffer that actually contains a filename string.

**Bug 2: `fs_search_path` called `writeStr` with wrong arg order.**

```js
// was:
if (bufGA) writeStr(bufGA, full, bufLen, isWide);
// but writeStr(guestAddr, str, isWide) — only 3 params
```

`bufLen` (0x800) was being consumed as `isWide`, so every SearchPath result was written as UTF-16. When the app's ANSI SearchPathA wrapper then copied the result via `rep movsd` + `rep movsb`, it saw `"C\0:\0\\\0..."` and stopped at the first NUL — 1 char, plus terminator. Downstream buffer: `"C\0"` with prior "lsph16.x" bytes leaking through from underneath, producing the puzzling `"C\0ph16.x"` pattern in memory dumps.

Fixed `lib/filesystem.js` line 497 by dropping the stray `bufLen` arg. Trace now shows:

```
[fs] SearchPath("Grdmelon.gif") → "C:\grdmelon.gif"
[fs] CreateFile("c:\grdmelon.gif", access=0x80000000, creation=3) → 0xf0000001   ← SUCCESS
```

**Post-fix status.** ARCHITEC.SCR `/s` now actually opens at least one texture file. The run then crashes at `EIP=0` after ~9800 API calls; prev EIP `0x744122af` is `mov ecx,[eax]; push eax; call [ecx+8]` — a COM `Release` call through a vtable whose slot 2 is NULL. EBX = `0x7c3e6018` appears repeatedly on the stack — a single object being over-released or whose vtable never got populated. Separate bug; not blocking the same path.

**Why cont.3 was wrong.** The "Grapple-198 string at 0x74a16421" observation was a disasm-time guess, not a runtime confirmation. At runtime, with TLS broken, the string the app tried to pass was never constructed. cont.3's call chain (LoadMesh → worker → loader B → MeshBuilder::Load) is still correct; what flows through it was wrong. The lesson ([memory note](feedback_verify_runtime_call_site.md) already applies): disasm hints where a string *should* come from but can't tell you what it *is* at call time.

**Regression check:** notepad, calc, mspaint (Win98), pinball all run clean after the TLS change — no API behavior depends on TIB+0x2c being zero.

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
