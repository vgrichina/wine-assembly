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
| ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI | OK | Black (no animation) | Throw `CA::DXException("No valid modes found for this device")` after EnumDisplayModes + IDirect3D2::EnumDevices. See Open Task 5. |

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

### 5. D3D screensavers: "No valid modes found for this device"

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
