# MCM (Motocross Madness, Microsoft, 1998)

**Exe:** `test/binaries/shareware/mcm/mcm_ex/MCM.EXE`
**DX path:** DDRAW.dll only (no D3DIM.DLL direct link). QIs IDirect3D3 off IDirectDraw at runtime — potential D3DIM execute-buffer / DrawPrimitive test target.
**Entry point:** (TBD)
**Run:** `node test/run.js --exe=test/binaries/shareware/mcm/mcm_ex/MCM.EXE --max-batches=500 --trace-api`

## Status (2026-04-19, night-3) — winmm aux* stubbed; MCM reaches steady-state main loop

Added minimal stubs for `auxGetNumDevs`, `auxGetDevCapsA`, `auxGetVolume`, `auxSetVolume`, `auxOutMessage` in `src/09a3-handlers-audio.wat`. NumDevs=0, GetDevCaps=BADDEVICEID(2), GetVolume writes 0 and returns NOERROR (MCM probes device 0 even after NumDevs=0; silent success keeps it moving), Set/OutMessage return NOERROR.

**Result:** MCM no longer crashes. `--max-batches=8000` runs to completion with **15,929 API calls** and no unimplemented-API trap. Last visible activity is a steady stream of `EnterCriticalSection` / `LeaveCriticalSection` / `<ord>` (lang.dll ordinal) calls — a stable main-loop pattern rather than a crash. Need to verify rendering and input work end-to-end.

**Next step:** run MCM with `--png=` at increasing batch budgets to see if it's drawing the title screen / menu, and with `--trace-dc` to check that the back-canvas is receiving its DDraw blits. If nothing is drawn, likely the next blocker is in the DDraw primary-surface flip path or a missing d3dim method that silently stalls. If it *is* rendering, wire up a `--input=` sequence to click through to gameplay.

## Status (2026-04-19, night-4) — rendering plumbing fires but back-canvas is tiny

With audio stubs in place, MCM reaches DDraw presentation:
- Creates `CreateWindowExA` hwnd=0x10001 title="Microsoft Motocross Madness" style=0x80080000 (WS_POPUP|WS_SYSMENU) **size=640x480**.
- Does 314 DDraw/surface COM calls: CreateSurface (primary + backbuffer flip chain), Blt, Flip in a steady loop.
- `$dx_present` fires 57× per 8k batches, calling `gdi_set_dib_to_device(hdc=0x50001, w=0x280, h=0x1e0 = 640×480)` on the main hwnd.

**But the PNG is blank teal.** `--trace-dc` shows the reason:
```
[CreateWindow] hwnd=0x10001 ... size=640x480
[ShowWindow] hwnd=0x10001 cmd=1
[ShowWindow] hwnd=0x10001 cmd=0   ← HIDE
[dc] hdc=0x50001 hwnd_in=0x0 → hwnd=0x10001 top=0x10001 ox=0 oy=0 canvas=8x47
```
Every present blits 640×480 into an **8×47 back-canvas**. Data is clipped to near-nothing. Sequence of `ShowWindow` cmds is `1 → 0 → 5 → 5` (SHOWNORMAL → HIDE → SHOW → SHOW); the back-canvas was allocated at default dims and never got resized to match the 640×480 CreateWindow size (or got truncated by the SW_HIDE pass).

**Next step:** trace `renderer.getWindowCanvas` allocation vs. the WM_SIZE path for hwnd=0x10001. Likely one of:
1. The CreateWindow size isn't being propagated to the window record (check `wnd_set_rect` / `wnd_set_state_ptr` sequence during CreateWindowExA for WS_POPUP style).
2. `ShowWindow(SW_HIDE)` is clobbering the stored size before it was ever read, so when the final SW_SHOW goes through the renderer falls back to its minimum default.
3. The back-canvas is allocated off stale hwnd client-rect dims before CreateWindow has finished populating them.

Check with `--trace-host=wnd_set_state_ptr,renderer_get_window_canvas` and compare window-record dims at each ShowWindow boundary. Fix goes in `src/09a5-handlers-window.wat` (CreateWindowExA / ShowWindow handlers) and/or `lib/renderer.js` (getWindowCanvas).

## Status (2026-04-19, night-2) — DDCAPS_3D + DI-QI AddRef; new blocker is winmm aux*

Two fixes cascaded MCM deep into init:

1. **`IDirectDraw::GetCaps` — add `DDCAPS_3D` (0x1) to dwCaps.** Made MCM pass the 3D-acceleration gate at `0x00465441`.
2. **`IDirectInputDevice::QueryInterface` — AddRef the returned `this`.** Without it, MCM's `CreateDevice → QI → Release(original)` pattern was freeing the DX_OBJECTS slot while MCM still held the QI pointer, crashing at `0x00450f4e` on a dangling vtable deref. Fix mirrors the existing rule from `feedback_com_qi_addref.md`.

**New blocker:** MCM now reaches the audio-init path:
```
FindFirstFileA × many (content scan)
DirectSoundCreate
auxGetNumDevs     ← crash_unimplemented
```
MCM calls `auxGetNumDevs` (from `WINMM.DLL`) to count aux audio devices. We have no aux* handlers.

**Next step:** add minimal winmm aux handlers: `auxGetNumDevs` (return 0 = no aux devices), plus likely `auxGetDevCapsA` if MCM iterates the count. These are low-risk stubs since MCM just probes for volume-control devices. Real implementations later.

## Status (2026-04-19, night) — FIXED: DDCAPS_3D was missing from GetCaps

Root cause of the whole "Could not find any 3-D acceleration hardware" bail: our `IDirectDraw::GetCaps` handler filled `DDCAPS.dwCaps = 0x24040` (BLT | BLTCOLORFILL | COLORKEY) but forgot `DDCAPS_3D = 0x1`.

MCM's device wrapper stores the DDCAPS struct at `[wrapper+0x28..]`, so `[wrapper+0x2c]` IS `DDCAPS.dwCaps`. The acceptability gate at `0x00465441` (`test cl, 0x1; jnz skip_error`) is literally `DDCAPS.dwCaps & DDCAPS_3D`. Without that bit, every driver is marked as "no 3D" regardless of how many modes/formats we enumerate downstream.

Fix (`src/09a8-handlers-directx.wat:987,1005`): `dwCaps = 0x24041` for both HW and HEL caps.

**Result:** MCM now passes the 3D gate and proceeds into the real init path:
- LoadString / MessageBox "testing video memory" (as before)
- Registry DriverInfo writes (new)
- DirectInput init — `CreateDevice` → `QueryInterface` → `Release` cycle (new — API #0x436, 0x43b, 0x43d)
- Crashes further down at `dbg_prev_eip=0x00450f4e` with EIP=0, arg `0xffc1202c` — entirely new code region; prior bail location 0x00465xxx is long past.

Next session: narrow the new crash at 0x00450f4e. The suspicious args `0xbada1100 / 0x0000002c / 0xffc1202c` suggest a bogus function-pointer argument (the `ffc1202c` looks like heap-garbage cast to a pointer), probably an unimplemented COM method slot still returning 0 that MCM then dereferences.

## Status (2026-04-19, evening) — method 23 exonerated; real bail is [dev+0x2c] bit 0

Traced method 23 (`0x00465830`) to completion with `--trace-at=0x00465c26` + mode-table dump. **Method 23 returns 1** — mode 2 (640x480x16) survives the full filter chain with `[mode+0x10]=1`:

```
0x011ec0c4  80 02 00 00 e0 01 00 00 08 00 00 00 ...   mode0 640x480x8    [+10]=0 [+14]=0
0x011ec0e0  20 03 00 00 58 02 00 00 08 00 00 00 ...   mode1 800x600x8    [+10]=0 [+14]=0
0x011ec0fc  80 02 00 00 e0 01 00 00 10 00 00 00 ...   mode2 640x480x16   [+10]=1 [+14]=1  ← survivor
0x011ec118  20 03 00 00 58 02 00 00 10 00 00 00 ...   mode3 800x600x16   [+10]=0 [+14]=1
0x011ec134  80 02 00 00 e0 01 00 00 20 00 00 00 ...   mode4 640x480x32   [+10]=0 [+14]=0
0x011ec150  20 03 00 00 58 02 00 00 20 00 00 00 ...   mode5 800x600x32   [+10]=0 [+14]=0
```

Pass-3 (0x465bd9–0x465c24) finds mode 2's `[+0x10]=1`, does NOT decrement survivors; ebx stays 1; `sbb/inc` → eax=1.

**Real bail path:** caller `0x00465120` at `0x00465431`:
```
00465431  mov eax, [esi+0x14]     ; 0 for single-device path
00465434  test eax, eax
00465436  jnz 0x46546b            ; not taken
00465438  mov eax, [esi+0x4]      ; selected device = [0x523070] = 0x011ec42c
0046543b  mov ecx, [eax+0x2c]     ; [dev+0x2c]
0046543e  test cl, 0x1
00465441  jnz 0x46546b            ; NOT TAKEN → falls into LoadString 0xbba + MessageBox
```

`[dev+0x2c]` observed value = `0x0000016c`. **Bit 0 is clear** → bail.

So the missing piece is whoever sets bit 0 of `[dev+0x2c]` during enumeration/registration. Bit 0 marks "device is acceptable." Previously-noted `EnumDevices` callback `0x00492810` allocates the per-device record and copies D3DDEVICEDESC; the acceptability flag is presumably OR'd in there based on a caps test. Known `[dev+0x2c]` state at method 23 entry already has bits 2,3,5,6,8 set (= 0x16c) but not bit 0 — so whatever sets other bits runs, but the bit-0 predicate fails for our HAL stub.

**Next step:** `tools/xrefs.js` for stores to `[*+0x2c]` in the range `0x00492000–0x00493000` (D3D device-wrapper methods) and around `0x00465600`. Look for `or [reg+0x2c], 1` (`83 48 2C 01` etc.) or `mov [reg+0x2c], N` where `N & 1 == 1`. Likely gated on a D3DDEVICEDESC.dpcTriCaps / dwFlags / dwDevCaps check against HAL fields we're leaving zero in our EnumDevices descriptor.

## Status (2026-04-19, later)

**MCM-2 progress — texture video-memory test passes** (pending commit): MCM measures texture allocation cost by delta-ing `IDirectDraw2::GetAvailableVidMem` across `CreateSurface`/`Release`. Fixed by: (1) track a running `$dx_vidmem_used` counter incremented in `CreateSurface` (surface + backbuffer + mipmap chain ≈ `dib_size × 4/3` when `DDSCAPS_MIPMAP` is set) and decremented in `IDirectDrawSurface::Release` (exact bytes stashed at entry+24); (2) `GetAvailableVidMem` returns `8MB - used` for lpdwFree, constant 8MB for lpdwTotal; (3) in `CreateSurface`, fall back to `$dx_display_bpp` when ddpfPixelFormat.dwRGBBitCount is 0 — MCM builds texture DDSDs from our stub `EnumTextureFormats` which leaves the format zeroed.

Effect — OutputDebugString now matches expected for every level:
```
16 bit 256x256 texture requires 131072 bytes (expected 131072)
16 bit 256x256 mipmap  requires 174762 bytes (expected 174762)
16 bit 128x128 texture requires  32768 bytes (expected  32768)
16 bit 128x128 mipmap  requires  43690 bytes (expected  43690)
...
```

**Still blocked:** MCM still bails with "Could not find any 3-D acceleration hardware." Re-narrowed (previous "0x4655e0 doesn't return" claim was wrong — `--trace-at` only takes one address; chained values in the same flag silently parse as one):

Path inside `0x00465120`:
- `0x004652f0 call 0x468130` — DriverInfo registry validator. **Returns 1 (failure).** Calls `RegOpenKeyExA(HKLM, "SOFTWARE\Microsoft\Microsoft Games\Motocross Madness Trial\1.0\DriverInfo\{00000000-0000-0000-0000-000000000000}", KEY_ALL_ACCESS)` at `0x004681ae`. Our DDraw driver GUID is all-zeros and the subkey doesn't exist → `ERROR_FILE_NOT_FOUND` → MCM treats validator as failed.
- Return value of 0x468130 is then **discarded** (`mov eax, [esi]` at 0x4652f7).
- `0x004652fb call [eax+0x5c]` — vtable method[23] = `0x00473820` → wraps `0x00465830`. **Returns 0 → "Could not find" MessageBox.**
- `0x00465830` walks the registered-device list at `[0x523070]` (count `[0x4e6668]`), invalidates entries via per-device method[12] (`call [edi+0x30]` at 0x465877) and table sweeps at offsets 0x300/0x310, then returns `(survivors >= 1) ? 1 : 0`. Survivors must have at least one valid entry left after pruning.

**Next step:** instrument the per-device pruning loop (0x465887–0x465902) to see why every device's mode/format table at `[dev+0x310]` ends up entirely invalidated. Two angles:
1. Check what `[dev+0x310]` looks like after the initial enumeration vs. after method[12] wipes entries (offsets 0x10 and 0x14 get zeroed when `[entry+0x8] in {0x18,0x20}` and other size/dim mismatches).
2. Pre-populate the `DriverInfo\{00000000-0000-0000-0000-000000000000}` registry key + its expected schema so 0x468130 succeeds; that's the "happy path" MCM was designed for after a successful first-run vidmem test. Schema is set via the parallel `RegSetValueExA`/`RegCreateKeyExA` calls inside the test routine — easier to just let it run and capture writes.

## Status (2026-04-19)

**MCM-2 partial fix** (commit `15b81d3`): GetCaps now fills `dwVidMemTotal`/`dwVidMemFree` (offset 0x3C/0x40 = 8MB) and `dwZBufferBitDepths` (0x38 = DDBD_16). MCM caches driver caps into its per-device wrapper and uses `DDCAPS.dwVidMemTotal` as the surface-budget in the per-mode video-memory check inside method-23 sub-function `0x00491400`. With 8MB reported, modes pass that gate and MCM now progresses through the full per-mode test path: SetDisplayMode → CreateSurface → Blt/Flip loop (video-memory testing) → GetPixelFormat → CreateDevice → EnumTextureFormats → CreateMaterial → GetHandle → SetMaterial → Release chain, for each of the two candidate 16bpp modes (640x480, 800x600).

**Still blocked:** after all that, method 23 still returns 0 → "Could not find any 3-D acceleration hardware". Rejection now lives downstream in the post-mode-test finalization — likely `call 0x492bf0` at `0x465e3e` inside `0x00465c40`'s final loop (`0x465da7`), which is called for the first surviving mode. If 0x492bf0 returns 0 or `[mode+0x10]` gets zeroed by the final device-level check, count stays at 0.

**Next investigation step:** disasm 0x492bf0 (Direct3D-device-creation wrapper that MCM uses during the mode-acceptance path). Determine which D3D/DDraw query it dispatches and which field we're returning wrong. Candidates: D3DDevice::EnumTextureFormats enumeration match, CreateSurface with DDSCAPS_ZBUFFER (we may need to accept that), CreateDevice wglQuery for a particular GUID, or a `[surface+0x??]` field on a back-buffer/z-buffer we didn't set. Another lead: our `GetAvailableVidMem` returns a constant 8MB regardless of allocations — some drivers' test logic expects it to decrease after CreateSurface proves vidmem is real. Trace shows multiple `GetAvailableVidMem` calls interleaved with CreateSurface/Release.

## Status (2026-04-18)

**MCM-8 fixed** (commit `7b1ad89` + `3673bed`): registry install-check now passes. Two bugs: (1) `_regHandles` used signed/unsigned mismatch between store and lookup, causing all RegQueryValueEx reads to fail. (2) Seeded `InstallType='Trial'` caused `fn 0x429770` to set `[this+0x82c]=1` (not-CD-installed); MCM expects value `2` which requires string == "Full". Changed seed to `Full`.

### MCM-2 re-examined (2026-04-18)

MCM actually calls `IDirect3D2_EnumDevices` (not D3D3 as originally assumed). Control flow after enum:

1. Callback `0x00492780` delegates to `0x00492810`, which allocates a 0x2b4-byte device record, copies hw+hel descs (204 bytes each, via `rep movsd 0x33`) and description/name strings into it, then conditionally appends to a dynamic array at `[ctx+0x338]`. Capacity at `[ctx+0x334]` grows via realloc on overflow. Callback always returns 1 (DDENUMRET_OK).
2. **Watchpoint data:** `[0x004e6668]` (global device count, set later by `0x4655e0` registration helper) goes 0→1 after enumeration. So MCM registers **only 1 device out of the 4 we enumerate (Ramp/RGB/HAL/MMX)**. Expected ≥1; the 1 is likely the HAL.
3. Caller `0x004331d6 call 0x465120` is the 3D-available gate. Inside `0x00465120`:
   - At `0x0046528b`, `call 0x4655e0` → writes count-1 to `[0x004e6668]` and returns device-index-plus-one in eax → saved to `[esi+0x5f4]`.
   - If nonzero, shows "testing video memory" MsgBox (LoadString 0x13d8 — **currently reached**, visible in trace as API #1687).
   - Then `call [esi_vtbl+0x5c]` (method 23, fn `0x00465830`) to finalize. Result → edi.
   - At `0x00465312 test edi, edi; jz 0x4651a8 → LoadString 0xbba ("no 3D hardware")`.
4. **Method 23 (`0x00465830`):** iterates `[0x004e6668]` (=1) entries in a device-list struct at `[0x523070]` (=pointer to an allocated manager). For each, inspects fields at `[eax+0x300]`, `[eax+0x310]`, and reads hw/hel desc fields via the 204-byte copy at `[device+0x114..0x1e0..]`. Some per-device filter within 0x00465830 is setting edi=0 → "no 3D".

**Next investigation step:** disasm the loop body of `0x00465830` past `0x004658a1` to identify which D3DDEVICEDESC/D3DPRIMCAPS field fails its acceptance check. Suspect: dwDeviceRenderBitDepth mask (we set 0xD00 = DDBD_8|16|32; MCM may require DDBD_16 only, or stricter dtcTransformCaps / dpcTriCaps.dwTextureCaps bits). Another lead: the 204-byte `rep movsd 0x33` copies only the first 204 bytes of our 252-byte desc — MCM reads through offset 0x33*4=0xcc = 204 — so only offsets 0..204 matter.

**NOTE:** Below block (referencing EIP=0 from 0x00466791) is from an earlier session and still-correct for the post-MsgBox behavior: after PostQuitMessage, MCM dispatches a few WM_ messages and hits `call [esi+0x28]` on a null vtable slot. That's downstream of the 3D decision — fix method 23, and this chain won't trigger.



Advances through splash → DirectDraw setup → 12 Flip-loop frames → new crash at EIP=0 from `dbg_prev_eip=0x00466791` (next function up from the fixed leak).

**Progressed past (this session):**
- Error 3002 "Could not find any 3-D acceleration hardware" — was a no-op `IDirect3D3_EnumDevices` stub. Fixed by implementing a real HAL callback in `src/09a8-handlers-directx.wat` that fills D3DDEVICEDESC (HW + HEL, 252 bytes) and D3DPRIMCAPS (56 bytes), invokes callback via CACA0007 continuation. Commit `45a6952`.
- **MCM-1 fixed (commit `905f012`):** 8-byte ESP leak at `0x00491d7e → 0x00491d90` was `IDirectDraw2::SetDisplayMode` (method 21) popping as IDirectDraw v1 (4 args, 20 bytes) when MCM calls it through the v2 vtable (6 args, 28 bytes). Handler now disambiguates by reading `[arg0]` and comparing to `DX_VTBL_DDRAW2`. Localized in one iteration via `--trace-esp=0x491a00-0x491f2e` (commit `d092389`).
- MCM now calls: `IDirectDraw::QI(IID_IDirectDraw2)` → `IDirectDraw::QI(IID_IDirect3D3)` → `IDirect3D3::EnumDevices` → `IDirectDraw::CreateSurface` → `IDirectDrawSurface::QI(DA044E00-69B2-...)` → `Flip×12` → `GetPixelFormat` → `SetDisplayMode` → continues into `0x00466791` caller chain.

## Current blocker — EIP=0 from `0x00466791` (vtable[10] == 0)

Enclosing function: `0x00466610` (found via `tools/find_fn.js`). Clean disasm from the jmp target `0x00466783`:

```
00466783  mov eax, [ebx+0x2f0]        ; ebx = C++ this (m_game)
00466789  test eax, eax
0046678b  jz   0x4668af
00466791  mov eax, [ebx+0x8]          ; eax = m_gfx member
00466794  mov eax, [eax+0xc]          ; eax = COM interface ptr inside m_gfx
00466797  push eax                    ; this (only arg — no other args)
00466798  mov esi, [eax]              ; vtable
0046679a  call [esi+0x28]             ; method index 10
```

The crash is **not** an ESP leak — it's `[esi+0x28] == 0`, so `call` jumps to address 0. Confirmation: stack at crash still has `0x0046679d` on top (the ret slot the `call` pushed), meaning the callee never ran — the call target was null.

**Context at crash (from `--trace-api`):**
- App has ALREADY called `LoadStringA(0xbba)` = string 3002 = *"Could not find any 3-D acceleration hardware"* → `DestroyWindow` → `ShowCursor(1)` → `PostQuitMessage(0)`. It's in shutdown.
- Then enters a `PeekMessage/TranslateMessage/DispatchMessageA/DefWindowProcA` loop (WM_SHOWWINDOW 0x18, WM_PAINT 0x0f) — WM_QUIT never delivered, so the pump keeps invoking the wndproc → render function → 0x00466610 → the null vtable slot.
- **So MCM is STILL failing the 3D-HW check even though `EnumDevices` now returns a full HAL D3DDEVICEDESC.** The error path happens before the crash, so the "12 Flip frames" line in the status above is misleading — those flips happen during the error UI, not gameplay.

**Two independent bugs here:**

1. **Pre-crash: MCM rejects our HAL caps.** Some flag in our D3DDEVICEDESC (dwFlags / dpcTriCaps / dwDeviceRenderBitDepth / dwMinTextureWidth / etc.) fails MCM's check. Need to diff a real DX5/DX6 HAL desc against what we fill in `$handle_IDirect3D3_EnumDevices` (`src/09a8-handlers-directx.wat`).
2. **Crash itself: method 10 of some COM interface is null in the vtable.** Which interface? `eax = [m_game+0x8]`; `interface = [eax+0xc]`. The last COM created before the crash was during error-path shutdown — likely a `CreateSurface` or `GetAttachedSurface` result. Plan:
   - Instrument: `--break=0x0046679a` + `r`/`d` to dump `esi` and look it up in DX_OBJECTS.
   - Or add a one-line log in `init_com_vtable` / `extend_com_vtable` to print vtable base + size, then grep which one method 10 is zero for.
   - Most likely candidate: a vtable initialized with fewer than 11 slots (e.g. `init_com_vtable(_, 10)`). Check `09b2-dispatch-table.generated.wat` for any `init_com_vtable` with count ≤ 10 — those are the suspects (`DDPAL=7`, `DDCLIP=9`, `DINPUT=8`).

**Most likely culprit:** `DDPAL` (7 methods) or `DINPUT` (8 methods) — but neither makes sense at this call site. More likely we're calling method 10 on `DDCLIP` (9 methods) via `IDirectDrawSurface::GetClipper`. Investigate `IDirectDrawClipper` methods 0-10; method 10 does not exist (interface has 9 methods 0-8). If MCM expects a larger clipper-v2 interface, we need to extend it.

**Starting point next session:**
```bash
node test/run.js --exe=test/binaries/shareware/mcm/mcm_ex/MCM.EXE \
  --max-batches=20000 --break=0x0046679a
# then `r` to read ESI; dword at [ESI+0x28] should be 0
# then look up ESI among global.get $DX_VTBL_* to identify interface
```

## 2026-04-18 follow-up: the real root cause is upstream

Confirmed by dumping `[ebx+0x8]` at the crash block (via `--trace-at=0x00466791` + `--dump=0x00505cb0:16`): `[ebx+0x8] = 0x00000000`. The m_gfx member is **null**. So `mov eax, [eax+0xc]` reads from guest address `0xc`, `mov esi, [eax]` reads junk, `call [esi+0x28]` lands on 0 — not a vtable slot bug at all. m_gfx is null because 3D init failed and the game tried to continue (still hitting the render path during the message-pump-after-PostQuitMessage).

### Why does 3D init fail?

Located the LoadString(0xbba) call site by temporarily instrumenting `test/run.js` trace-api with a caller-ret dump (reverted). Only hit: `ret=0x00465339` (so the `call LoadStringA` at `0x00465333`, error 3002 push at `0x00465327`).

Function containing that push starts at `0x00465276`. Disasm of the relevant tail (`0x004652f0` onward):

```
004652f0  mov ecx, esi
004652f2  call 0x468130          ; "continue 3D init" path
004652f7  mov ecx, esi
004652f9  mov eax, [esi]         ; vtbl of game-class esi
004652fb  call [eax+0x5c]        ; GAME-CLASS method #23: "is 3D ready?"
004652fe  mov edi, eax
...
00465309  mov ecx, esi
0046530b  mov eax, [esi]
0046530d  call [eax+0x5c]        ; same method, alt path (when [esi+0x5f4] was 0)
00465310  mov edi, eax
00465312  test edi, edi
00465314  jnz 0x46533e           ; success: skip error
00465316  mov eax, [ebp+0x14]
00465319  test eax, eax
0046531b  jz 0x4651a8
00465321  push 0x100
00465326  push eax               ; user-provided error-detail buffer
00465327  push 0xbba             ; IDS_ERR_NO_3D_HW
0046532c  push [esi+0x46c]       ; hInstance
00465333  call LoadStringA       ; <-- the crash's proximate trigger
00465339  jmp 0x4651a8
```

**So `call [esi+0x5c]` returns 0** — that's method #23 on MCM's own game class (not a DX COM vtable; offset 0x5c on a DX interface would be out-of-range on IDirect3D3). It checks some boolean set during DX setup. Something in our DX-init-sequence leaves this state unset, **despite all the DDraw/D3D calls succeeding at the COM layer**.

### Likely offenders (educated guess, not verified)

Possible culprits (rank by likelihood for an MCM-shaped D3D init flow):

1. **`IDirect3D3::CreateDevice` not returning a valid `IDirect3DDevice3` wrapper.** We added a HAL desc in EnumDevices, but do we actually create the device for the GUID MCM picks? Check `09a8-handlers-directx.wat` / `09ab-handlers-d3dim-core.wat` for `CreateDevice` and whether it's filling the out-pointer with a DX_VTBL_D3DDEV3 COM wrapper.
2. **`IDirectDrawSurface::GetAttachedSurface` not returning the Z-buffer.** A classic DX5-era init flow: create primary w/ backbuffer, create zbuf, attach zbuf, `GetAttachedSurface(DDSCAPS_ZBUFFER)` → bind to device. If we stub GetAttachedSurface, MCM sees no Z and bails.
3. **`IDirect3DDevice3::SetRenderTarget` / `GetCaps`** quietly failing/stubbing to 0.

Next session: grep `09a8*.wat` + `09ab*.wat` for `CreateDevice`, `GetAttachedSurface`, `SetRenderTarget`, `QueryInterface` on D3D-device IIDs — check each for "creates a real COM wrapper / returns S_OK" vs "stubs 0 and esp += N". Also: put a `--trace-at=0x00468130` to see how far into "continue init" we get before returning to method 23's null-state-check.

### Takeaway

The 0x00466791 crash is a **symptom**, not the root cause. The two "stacked bugs" are actually one bug: 3D init silently fails → game flags m_3d_ready = 0 → error 3002 → PostQuitMessage → message pump still fires render path → m_gfx is null → call [0]. Fixing the DX init chain eliminates both.

## 2026-04-18 correction: 0x468130 is NOT 3D init, and MCM never reaches CreateSurface

Previous session guessed that `call 0x468130` at `0x004652f2` was the "continue 3D init" path. **Wrong.** Disasm of 0x468130 shows a registry-enumeration helper (calls `[0x525524]` = RegOpenKeyExA, `[0x525520]` = RegQueryValueExA, `[0x525514]` = RegDeleteKeyA, `[0x52552c]` = RegEnumKeyExA via ebp). No DirectDraw / Direct3D calls inside it. It's probably "scrub stale display settings out of the registry" after a failed enumeration.

### What the trace actually shows MCM doing before error 3002

Full DX call sequence from `--trace-api` (lines 945..1790 of /tmp/mcm-trace.log, ordered):

1. `DirectDrawCreate` (twice — first for a preflight enum, second for real init)
2. `IDirectDraw::QueryInterface(IID_IDirectDraw2)` → `IDirectDraw2::GetCaps`
3. `IDirectDraw2::EnumDisplayModes` (inside callback: `HeapAlloc` for each mode)
4. `IDirectDraw::GetDisplayMode`
5. `IDirectDraw::QueryInterface(IID_IDirect3D3)` → `IDirect3D3::EnumDevices` (our HAL callback fires)
6. `IDirectDraw::SetCooperativeLevel` (cooperative=0x8 / normal)
7. `GetDC` / `GetDeviceCaps` / `ReleaseDC` / window-style manipulation / `SetWindowPos` / `ShowWindow`
8. `IDirectDraw::GetDisplayMode` (again)
9. `IDirectDraw::SetCooperativeLevel` (cooperative=0x13 / fullscreen exclusive)
10. `IDirectDraw2::GetAvailableVidMem`
11. `IDirectDraw::SetDisplayMode` **×3** — probes (640,480,16), (640,480,16), (800,600,16)
12. A pile of `RegCreateKeyExA` / `RegSetValueExA` — writing discovered video settings to registry
13. **`LoadStringA(0xbba)` — error 3002 fires here.**

**MCM never calls `CreateSurface`, `CreateDevice`, `GetAttachedSurface`, `SetRenderTarget`, `Direct3D::CreateDevice`, or any Z-buffer/device creation.** It bails during preflight.

### Where the bailout decision lives

The `call [esi+0x5c]` in function 0x465276 (where `esi` is MCM's main game-class `this`) reads an internal flag set during preflight. It returns 0 → error 3002. That flag is written somewhere inside `call 0x4655e0` at `0x0046528b` (the first call in the function, whose result goes to `[esi+0x5f4]`).

0x4655e0 is a large function (162+ bytes before tail, contains repeated "build registry path via sprintf-like helper at 0x4bd200, call virtual method 0x467680 on self" blocks). Its children are what produce the DX calls we see — including EnumDisplayModes and the 3 SetDisplayMode probes. So the "does MCM have a usable 3D mode" check is probably:

> For each desired (w,h,bpp), call `SetDisplayMode` and see if it succeeds. Our handler returns 0 (S_OK) unconditionally, but MCM may also verify the result by calling `GetDisplayMode` and checking that width/height/bpp match.

Checked `$handle_IDirectDraw_GetDisplayMode` at `src/09a8-handlers-directx.wat:903` — it already reports the last `SetDisplayMode` values via `$dx_display_w/h/bpp` globals, with proper DDPIXELFORMAT (size=32, DDPF_RGB, 16bpp 565 masks). So a naive "set then get" probe would match. Not this.

### Remaining suspects (ranked)

1. **`IDirect3D3::EnumDevices` HAL desc is rejected by MCM's device selector.** Our callback was added but MCM may set `[esi+0x5f4]` to the chosen device GUID only if the callback returns a specific "I want this one" code, or only if dwDeviceRenderBitDepth includes 16bpp (`DDBD_16`). `[esi+0x5f4]` being non-zero here *should* mean "3D device found" since the non-zero branch leads into LoadString(0x13d8) with string "Using 3D hardware: %s" or similar.
2. **`IDirectDraw2::EnumDisplayModes` callback contract.** Trace shows it runs (HeapAllocs per mode) and MCM then calls `SetDisplayMode(800,600,16)` — probably the selected mode. If the callback has to return `DDENUMRET_OK` (=1) to continue, our dispatch may be mis-popping stack or returning `DDENUMRET_CANCEL`, truncating the mode list.
3. **`IDirectDraw::GetCaps`** — MCM may filter caps bits (DDCAPS_3D, DDCAPS2_NO2DDURING3DSCENE, vidmem size). We fill some, not all.

### Session 2026-04-18 update — preflight picks a 3D device, crashes later

Ran `--trace-at=0x004652f0,0x004652fb,0x00465309,0x00465312`. Only `0x004652f0` fires (once, ESI=0x00505ca8 = MCM `this`). This means:

- `[esi+0x5f4]` **was non-zero** — `call 0x4655e0` successfully picked a 3D device. EnumDevices / display-mode probe is NOT the blocker.
- Flow enters the success branch at `0x4652f0`: `call 0x468130` (registry enum, runs fine), then `call [eax+0x5c]`, then `call 0x466030`.
- None of `0x4652fb / 0x465309 / 0x465312` are ever reached, so **control never returns** from the sequence — the crash happens inside one of those three calls.

`prev_eip=0x00466791` pins the crash site. `find_fn` says this is inside function **`0x00466610`** (xrefs only from data vtables at `0x004d5c78` and `0x004d6050` — it's a virtual method). Disasm at `0x00466783`:

```
00466783  mov eax, [ebx+0x2f0]     ; ebx = this (MCM class, was ecx on entry)
00466789  test eax, eax
0046678b  jz 0x4668af              ; guard passes (some object is set up)
00466791  mov eax, [ebx+0x8]       ; [this+8] — likely a DX wrapper MCM holds
00466794  mov eax, [eax+0xc]       ; [[this+8]+0xc] — another wrapper
00466797  push eax
00466798  mov esi, [eax]           ; vtable — **NULL**
0046679a  call [esi+0x28]          ; → EIP=0
```

Classic null-vtable call. `[this+8]` is a DX-related holder object whose `+0xc` field points at something whose vtable hasn't been populated. The method being called is at vtable offset **`0x28`** (index 10 — matches historical "null vtable[10]" note).

Note 0x00466610 is NOT called directly from `0x465302 call 0x466030` — `0x466030` is a tiny loop over `[0x523070]` that calls `0x467e40` per slot. So 0x466610 is reached deeper, via one of the vtable-dispatched methods fired from within that loop (or from `call [eax+0x5c]` at `0x4652fb`).

### Session 2026-04-18 update 2 — `[this+8]` is never written

Dumped `[0x00505ca8:0x600]` post-run: `[this+8] = 0`. Set `--watch=0x00505cb0` across the full run — **zero hits**. The field stays null throughout execution.

Tracked where the guard `[this+0x2f0]` gets set. Watch on `0x00505f98` fires once, `prev_eip=0x00464cf4`. That block is inside function **`0x00464c06`** (the MCM instance-init routine). Key facts about this function (ebx = `this`):

| EIP | instruction | effect |
|---|---|---|
| `0x00464c1d` | `mov dword [ecx], 0x4d5c54` | sets an early vtable (later replaced by `0x4d602c`) |
| `0x00464c35` | **`mov [ebx+0x8], edi` (edi=0)** | **explicitly zeroes `[this+8]`** |
| `0x00464c38` | `mov [ebx+0xc], edi` | zeroes `[this+0xc]` |
| `0x00464c3b` | `mov [ebx+0x5f4], edi` | zeroes the "3D device" slot too |
| `0x00464c9c` | `mov [ebx+0x2f8], 0x280` | sets display width default = 640 |
| `0x00464ca6` | `mov [ebx+0x2fc], 0x1e0` | sets display height default = 480 |
| `0x00464d00` | `mov [ebx+0x2f0], esi` (esi=1) | **sets the guard flag to 1** |
| `0x00464d24` | `mov [ebx+0x314], esi` | sets another "init-done"-style flag |

So `[this+0x2f0]=1` is set by the *constructor-time* initializer. It is NOT a "DX init succeeded" flag — it's an "instance created" flag. The crash fn `0x00466610` (a virtual method) mis-uses it as a "you may read `[this+8]`" gate.

`[this+8]` is supposed to be populated much later by a separate init path (presumably the one driven by `call 0x4655e0` which also sets `[this+0x5f4]`). That path runs our full DX preflight (EnumDevices, EnumDisplayModes, 3× SetDisplayMode, GetAvailableVidMem). `[this+0x5f4]` *does* end up non-zero (trace-at at `0x004652f0` fires) — so *some* state is populated — but `[this+8]` is not among them.

### Remaining hypothesis

MCM's real `0x4655e0` path includes a step that assigns a DX wrapper to `[this+8]` (plausibly the `IDirectDraw2` it creates, or a wrapping object for the D3D device). One of our COM handlers in that chain returns success without writing the output pointer the guest expected. The caller then ignores the "null out-pointer" and presses on, so `[this+0x2f0]` is set, `[this+0x5f4]` is set, but `[this+8]` stays zero from the constructor.

### Session 2026-04-18 update 3 — `0x4655e0` is not the DX factory; crash is vtable slot 9

Disassembled `0x4655e0`: it's a **driver-database lookup loop** doing repeated `sprintf` (`0x4bd200`) + registry-string comparisons against entries in table `[0x523070]` at offsets `+0xcb8`/`+0x6b8`/`+0x8b8`. It does not create any DX interface. The matching outer loop `0x466030` does the same per-device walk via `0x467e40`. So `[this+0x5f4]` is a **selected-device-index** from MCM's own driver DB, not a DX object pointer. The DX API calls we see (Enum/SetDisplayMode/etc.) must be driven from a different code path — probably reached *after* `call 0x466030` via one of the virtual calls at `0x4652fb`/later.

Also pinned down vtable layout at `0x4d602c`:

| slot | fn | role |
|---|---|---|
| +0x00 | 0x00464f00 | (dtor?) |
| +0x14 | 0x00466200 | |
| +0x18 | 0x00466250 | |
| +0x24 | **0x00466610** | **crash fn (slot 9)** |
| +0x5c | 0x00466070 | called at `0x4652fb`; wraps API `[0x525828]`, uses `[this+4]`/`[this+0x18]` — NOT the caller of crash fn |

So crash is not on the `[eax+0x5c]` path. The crash fn is reached via some `call [vtable+0x24]` elsewhere in the flow after `0x4652f0`. Entry point is still unidentified.

### Session 2026-04-18 update 4 — caller identified: main game-tick at `0x00466ac0`

`--trace-at=0x00466610` fired once with ret-addr `0x00466b4b` on the stack. Caller is **`0x00466ac0`**, a frame-tick/render routine. Relevant tail:

```
00466ac5  mov eax, [ecx+0x468]       ; last-tick timestamp
...                                  ; reads GetTickCount via [0x525878] or fn 0x466b70
00466b00  fmul [0x4d5c40]            ; scale delta by dt constant (frame time)
00466b16  mov eax, [esi+0x444]
00466b1c  test eax, eax
00466b1e  jnz 0x466b58               ; *** SKIP tick body if [this+0x444] != 0 ***
...                                  ; else: per-frame work
00466b44  mov edi, [esi]             ; edi = this->vtable
00466b48  call [edi+0x24]            ; → 0x00466610 (crash fn, slot 9)
00466b4d  call [edi+0x2c]
00466b50  mov ecx, [esi+0x8]         ; *** also derefs [this+8]! ***
00466b53  call 0x4930b0
```

So the crash is inside MCM's normal **per-frame tick**. MCM reached the main loop with its DX/D3D chain half-initialized: `[this+0x2f0]` and `[this+0x5f4]` are set, but `[this+8]` (some DX/scene object) is still zero from the constructor, and `[this+0x444]` (the "pause rendering" flag) is also zero — so the tick doesn't short-circuit and just dives in. The crash method at slot 9 then does `mov esi,[[this+8]+0xc]; call [esi+0x28]` on a null chain.

`[this+0x444]` is set to 1 at `0x00464c72` (init, value `0x40000000` - wait, that's `[this+0x458]`) — let me re-check. Init writes `[ebx+0x458]=0x40000000`, not `[ebx+0x444]`. So `[this+0x444]` starts at zero and *something later* should set it to 1 to mean "render paused / not ready." That something must be an error-handler in the real DX init path. On our run, that error-handler never fires (we return S_OK from everything), so MCM thinks it's OK to render, enters the tick, and blows up.

### New hypothesis — this is actually a "fail-open" bug chain

We may be returning success from a COM call that should fail. MCM's normal flow is:

1. Try full DX init.
2. If any step fails → set `[this+0x444]=1` (render paused) → error UI.
3. Otherwise populate `[this+8]` with the frame/scene object and begin rendering.

We're landing in a fourth state MCM doesn't handle: "all init calls reported success, but `[this+8]` is still zero." That's a contract we violated — probably by returning a valid interface pointer from some COM method but with its internal state (pointed to by +0xc) uninitialized.

### Session 2026-04-18 update 5 — `[this+8]` initializer identified: vtable slot 7 (fn `0x00466260`), never called

Byte-scanned for `89 46 08` (`mov [esi+8], eax`) across `MCM.EXE`. Hit at `0x004662ef`, enclosing function entry **`0x00466260`** (SEH-prologue fn starting with `64 a1 00 00 00 00 / push ebp`). Body:

```
00466260  [SEH prologue + this = esi]
00466283  mov ecx, [ecx+0x8]
00466286  test ecx, ecx
00466288  jnz 0x46633f               ; early-out if [this+8] already set
...
004662aa  push 0x8c4                 ; malloc size = 2244 bytes
004662af  call 0x4bd170              ; operator new
004662c7  call 0x492b80              ; ctor on new obj
...
004662e7  mov ecx, eax               ; this = new obj
004662e9  push ebx                   ; ebx = [main_this+0x4]
004662ea  call 0x492bf0              ; Initialize(new_obj, [main_this+4])
004662ef  mov [esi+0x8], eax         ; *** [this+8] = Initialize return value ***
004662f2  test eax, eax
004662f4  jnz 0x4662fa               ; fail = leave [this+8] null & return 0
```

This function is **vtable slot 7** of main MCM class (offset `0x1c`, `vtable[0x4d602c + 0x1c] = 0x00466260`).

Ran `--trace-at=0x00466260,0x004662ef,0x004663a0` → **zero hits**. The method is never invoked at all. That's the real regression: MCM's startup chain should call `[vtable+0x1c]` somewhere (probably after DX init succeeds), but we're diverging earlier and skipping past it.

Every downstream symptom follows:
- `[this+8]` = 0 (never written) ✓ confirmed
- tick fn at `0x00466ac0` runs anyway because `[this+0x444]=0` (would have been set by the error path of the missing init) ✓
- crash fn at `0x00466610` reads `[[this+8]+0xc]` → null deref ✓

### Session 2026-04-18 update 6 — caller of `[vtable+0x1c]` found at `0x0046610e`; MCM actually hits shutdown before crash

Byte-scanned for `ff 50 1c`, `ff 51 1c`, etc. The one relevant hit on MCM main class is at **`0x00466112`** (`mov eax,[esi]; mov ecx,esi; call [eax+0x1c]`). The guard just before it:

```
004660e1  [sets up mode args: [this+0x2f8/0x2fc/0x300] = width/height/bpp]
00466100  call 0x490a50              ; main mode-set helper on [this+4]
00466105  test eax, eax
00466107  jnz 0x46610e               ; if success → call [vtable+0x1c] (the initializer)
00466109  xor eax, eax; pop; ret     ; else → bail without initializing [this+8]
```

So `[vtable+0x1c]` is gated on `0x00490a50` returning non-zero. That function is a helper on `[this+4]` (some DX wrapper), invoked with the full (w,h,bpp) mode triplet.

**But:** `--trace-at=0x00466100,0x00466105,0x0046610e,0x00466260` → **zero hits across the board**. We never even reach the guard. The `call [eax+0x5c]` at `0x004652fb` that should invoke `0x00466070` (which is `0x00466070`'s chain leading here) also never fires in trace — despite API trace showing plenty of activity afterward. Likely cause: `call 0x468130` (registry enum) doesn't return in a way the block decoder continues from `0x004652f7`. Need to verify with a targeted trace of 0x468130's RET.

**Surprise finding from API trace:** MCM runs LoadStringA(**0x13d8**) = the SUCCESS string "Using 3D hardware: %s" BEFORE LoadStringA(0xbba) = the failure string. So MCM *does* announce it found 3D hardware, then does a bunch of registry/window/mode-set work, then ends up loading the error string anyway and calling DestroyWindow → PostQuitMessage. The crash at `0x00466791` fires later still, during post-quit message-pump where the tick function runs one more time with `[this+8]=0`.

So the chain is actually:
1. Preflight says "3D OK" → shows confirmation MessageBox
2. Deeper init succeeds partially (SetDisplayMode gets called on both 640x480 and 800x600)
3. Some final step fails → LoadString(0xbba) error UI
4. MCM calls DestroyWindow + PostQuitMessage
5. Message pump continues, invokes tick fn once more
6. Tick fn derefs null `[this+8]` → crash
7. Emulator sees EIP=0 and halts

The `[this+8]` initializer never ran because step 2 or 3 failed before reaching `0x0046610e`. Root cause is earlier than the code path I'd been analyzing.

### Next session

1. **Locate the earlier failure point.** Between `LoadString(0x13d8)` (API #1680) and `LoadString(0xbba)` (API #1716) in `/tmp/mcm-api.log`, the APIs are: RegOpen×4, ordinal call `<ord>(0x083e0000, ...)`, window-style manipulation (GetWindowLong, SetWindowLong, SetRect, AdjustWindowRectEx, SetWindowPos×3, SystemParametersInfoA, GetWindowRect, ShowWindow), Reg ops, ordinals at 0x280×0x1e0 and 0x320×0x258 (SetDisplayMode-like). The `<ord>` imports need decoding — figure out which DLL ordinal they are (check `tools/pe-imports.js --all MCM.EXE` for ordinal slots). One of these returns wrong and MCM takes the error path.
2. **Decode `<ord>` at 0x083e0000**: that's a thunk address. Check `pe-imports.js --all` and match the import slot. Based on args (hwnd, flags) it looks like DirectDrawCreate or a D3D interface method via ordinal.
3. **Verify call chain from 0x4652f0 forward.** Add `--trace-at=0x00468130` to confirm the registry-enum fn is entered, and `--trace-at=0x00468130+N` at its `ret` sites to confirm it returns. If it doesn't return, investigate why (SEH? longjmp? stack smash?).

### Artifacts worth keeping between sessions

- `0x00466260` = `vtable[0x1c]` = allocator for `[this+8]` scene object. First thing to check is always whether this method runs.
- `0x00466610` = `vtable[0x24]` = per-frame method that crashes when `[this+8]` is null.
- `0x00466ac0` = main tick, guarded by `[this+0x444]`.
- `0x00472576` = main ctor (vtable `0x4d602c`).
- `0x00464c06` = instance-init routine (zeroes `[this+8]`, sets `[this+0x2f0]=1`).

## Historical blocker — 8-byte ESP leak in function 0x00491a00 (RESOLVED)

Crash: `EIP=0x00000000`, `ESP=0x03fff8a4`, `dbg_prev_eip=0x00491f24` after `ret 0xc` at `0x491f2e`.

**Mechanism (confirmed):**
- `0x491a00` called from `0x491850` (inside `0x004917b6`) with entry `ESP=0x03fff89c`, ret addr `0x491855` correctly pushed to `[0x03fff89c]`.
- Prologue: `sub esp, 0x438` + push ebx/esi/edi/ebp (0x10). Expected body-ESP = `0x03fff454`.
- At epilogue `0x491f24` (breakpoint confirmed): observed `ESP=0x03fff44c` — **8 bytes below expected**.
- Epilogue: `pop ×4 + add esp, 0x438` → `ESP=0x03fff894` (8 bytes below the real ret-slot `0x03fff89c`).
- `ret 0xc` pops `[0x03fff894]` = 0 (pre-zeroed by an unrelated `rep stosd` in `0x004655e0` at prev_eip `0x004655fb`, batch 24) → EIP=0.

**Root cause (unconfirmed but narrowed):** a call site inside `0x491a00` leaks 8 bytes of ESP. Likely a COM/vtable method whose handler's `esp +=` count is off by 2 args.

**Ruled out (this session):**
- `0x491e7b` `call [ebx+0x14]` — never hit (breakpoint silent).
- `0x491ef8` `call [ebx+0x7c]` (GetPixelFormat on `[esi+0x314]`) — hit, handler pops correct 12 bytes.
- Standard COM handlers (Flip, GetPixelFormat, timeGetTime) — pop counts verified correct.
- `0x491aa6..0x491aeb` MSVC **stack-pseudo-register idiom** (push-args-for-next-call-before-returning-from-current). Initially looked like an 8-byte leak: GetMenu (1-arg) gets 2 pushes, GetWindowLongA (2-arg) gets 3 pushes. Verified balanced as a group: total 5+2+3+2=12 pushes match 5+1+2+4=12 pops across SetRect/GetWindowLongA/GetMenu/GetWindowLongA/AdjustWindowRectEx. All four USER32 handlers have correct `esp += 4+nargs*4`.
- IDirectDraw_CreatePalette (pops 24), IDirectDrawSurface_SetPalette (12), IDirectDrawSurface_GetPixelFormat (12) — all verified correct.

**Still to check:** 17 remaining call sites in `0x491a00..0x491f2e`. Rather than breakpoint bisect, next approach is to add per-API-call ESP delta logging to `test/run.js` — prints `esp_before → esp_after` per dispatched API. Grep the transcript for any delta that doesn't match `4 + nargs*4`. Call sites to audit: COM Release×3 (0x491a68/7f/99), CreateSurface×2 (0x491b41/ee), QI×2 (0x491b6f/1c), Release×2 (0x491b93/c40), CreateClipper (0x491c5b), SetHWnd (0x491c89), SetClipper (0x491cb5), GetPixelFormat (0x491df6), CreatePalette (0x491e7b), SetPalette×3 (0x491ea3/ec/f8). Internal call-site `0x48f750` (custom error helper) uses cdecl `add esp, 0xc` — 3 args cleaned explicitly.

**Last API before crash (from `--trace-api`, 500 batches):** `IDirectDrawSurface_GetPixelFormat(this=0x083e0010, lpPF=0x03fff464)`. Entry ESP = 0x03fff454, PF-buffer at 0x03fff464 is 16 bytes above ESP — safely inside frame. Not the culprit.

**`--esp-delta` infrastructure (this session, committed):** `test/run.js` now accepts `--esp-delta`. WAT-side hook: `01-header.wat` imports `host.log_api_exit`, `09b-dispatch.wat` calls it immediately after `$dispatch_api_table` returns. JS captures ESP on the pre-dispatch `h.log` and re-reads on `h.log_api_exit` → `delta = esp_after - esp_before` = exactly what the handler popped. Expected: `4 + nargs*4` for every stdcall handler.

Run: `node test/run.js --exe=.../MCM.EXE --max-batches=500 --esp-delta > /tmp/mcm_esp2.txt`. Across **1720 API calls** leading up to the crash, the delta distribution is:

| delta | count | meaning |
|---|---|---|
| +8 | 1042 | 1-arg stdcall (Release, timeGetTime, etc.) |
| +4 | 258 | 0-arg (GetLastError, GetTickCount) |
| +20 | 164 | 4-arg (Flip, CreateWindowExA) |
| +16 | 87 | 3-arg |
| +36 | 66 | 8-arg |
| +12 | 46 | 2-arg (GetPixelFormat) |
| +28 | 30 | 6-arg |
| +24 | 18 | 5-arg |
| +32 | 4 | 7-arg (CreateFileA, SetWindowPos) ✓ |
| -12 | 4 | DirectDrawEnumerate{A,ExA} — callback-dispatch pattern (handler invokes guest callback via continuation thunk, defers pop — not a bug) |
| +0 | 1 | First `CreateEventA` during CRT init (re-entered, second call pops correctly) |
| -16 | 2 | `ShowWindow` + one `<ord>` — EIP-redirect-to-wndproc path, wndproc prolog does its own push/sub (not a bug) |

**All 1720 handler pops are correct.** Every non-`4+nargs*4` delta has a known explanation (callback dispatch, EIP redirect).

**New narrowing:** the 8-byte ESP leak causing EIP=0 on MCM is **NOT an API handler bug**. Must be one of:
1. A guest-code stack bug (MCM's own `push/pop` imbalance — unlikely for shipped retail software running fine on Win98)
2. An x86 emulator bug in some push/pop/sub/add/mov-esp sequence triggered by a rare instruction pattern during 0x491a00's init phase or teardown

**Next step:** narrow to a short instruction window. Approach: set `--break=0x491a00` to enter the function, dump ESP at every block boundary inside `0x491a00..0x491f2e`, diff against the per-instruction stack-effect model (push=-4, pop=+4, call=-4, ret=+4+imm16, sub esp=−k, add esp=+k, etc.) to find the one instruction whose effect doesn't match. Or: add a per-block ESP trace (write ESP to a ringbuffer keyed on EIP) and look for a block where `Δesp_actual ≠ Δesp_expected`.

**Cross-check with gemini emu review (`/tmp/gemini-emu-review.txt`, 2026-04-18):** gemini flagged 5 emu-bug classes that could cause iteration-N divergence. Of those, #5 (**SIB Index=4/ESP decoder confusion** in `07-decoder.wat` `emit_sib_or_abs` / `05-alu.wat` `th_compute_ea_sib`) is the top candidate for MCM's ESP leak — fn `0x491a00` uses `lea ebx,[esp+0x448]`, `sub esp,0x438`, `add esp,0x438`, and many `[esp+k]` accesses. A miscomputed EA for any of those would explain an 8-byte drift invisible to per-handler ESP tracking. Aligns with existing `project_decoder_sib_order` memory note. Gemini #1 (FPU stack), #2 (IMUL flags), #4 (ADC/SBB OF) don't affect ESP directly. #3 (block-cache page-boundary hole) is plausible only if MCM is self-modifying, which is unlikely for a retail DX5 demo.

## Viability as D3DIM verify target

**Confirmed**: MCM actively QIs `IDirect3D3` and iterates HAL devices (so it definitely takes the D3D path post-fix).

**Unknown**: whether MCM uses `IDirect3DExecuteBuffer::Execute` (plan Steps 4-7 target) or `IDirect3DDevice3::DrawPrimitive`. DX5-era (1998) games split between both APIs. Only observable post-crash-fix.

## Related files

| File | Relevance |
|---|---|
| `src/09a8-handlers-directx.wat` | `$handle_IDirect3D_EnumDevices`, `$handle_IDirect3D3_EnumDevices`, `$d3d_enum_devices_invoke`, `$fill_d3d_device_desc`, `$fill_primcaps`. GetPixelFormat handler at line 1282. |
| `src/09ab-handlers-d3dim-core.wat` | D3DIM Phase 0/2/3 — QI upgrade routing `$d3dim_qi`, matrix math, viewport clear/zbuffer. |
| `src/09aa-handlers-d3dim.wat` | D3DIM handler stubs, including IDirect3DExecuteBuffer methods (lines 988-1044) — targets for plan Step 4 (execute-buffer walker). |
| `src/08-pe-loader.wat` | Thunk allocation for CACA0007 (EnumDevices continuation reuse). |
| `src/09b-dispatch.wat` | CACA0007 handler (lines 340-353). |
| `/Users/vg/.claude/plans/radiant-greeting-gray.md` | D3DIM Phase 0+1+2+3 plan. Steps 1-3 committed, Steps 4-7 blocked on verify gate. |

## Open tasks

- **MCM-1** Find the 8-byte ESP leak that crashes MCM. `--esp-delta` (WAT-side per-handler hook) **rules out API handler pop bugs** — all 1720 handler pops from startup to crash match `4 + nargs*4`. Leak is in either (a) guest code stack imbalance in 0x491a00 itself, or (b) an x86 emu bug in a push/pop/mov-esp instruction. Next: per-block ESP trace inside 0x491a00..0x491f2e, compare each block's actual ESP delta vs model-predicted (sum of push=-4, pop=+4, call=-4, ret=+4+imm16, sub/add esp, lea esp, etc.). First block where they diverge is the culprit.
- **MCM-2** Post-fix: trace which `IDirect3DDevice3_*` methods MCM calls to confirm execute-buffer vs DrawPrimitive path.
- **D3D-1** If MCM uses DrawPrimitive (not execute-buffers), pivot verify gate to a DX SDK sample. **Top pick (bg-agent research, 2026-04-18):** DX5 SDK on archive.org — [idx5sdk](https://archive.org/details/idx5sdk) / [ms-dx5-sdk](https://archive.org/details/ms-dx5-sdk). Self-contained prebuilt exes in `samples/Multimedia/D3dim/Bin/` (Tunnel, ExecBuf, Bumper, Boids, Donut, MFCFog) cover **both** Execute-buffer and DrawPrimitive paths. Also: [DX3 SDK](https://archive.org/details/dxsdk__3) (Execute-only, pure Gen-1), [DX6 SDK](https://archive.org/details/dx-6-sdk) + [prebuilt samples mirror](https://github.com/NickCis/directx-6-1-sdk-samples). Games (Hellbender, MTM) have CD-check risk — skip unless SDK samples insufficient.
- **Plan-4** Execute-buffer walker (`IDirect3DExecuteBuffer::Execute` opcode dispatch) in `09aa-handlers-d3dim.wat`.
- **Plan-5** `DrawPrimitive` / `DrawIndexedPrimitive` data path.
- **Plan-6** Scanline rasterizer (needs compile-wat.js f32 ops — already committed `97daa09`).
- **Plan-7** Texture upload + sampling.
- **Misc** Pre-existing uncommitted reverts in `lib/host-imports.js` (BltRect/BltPtr trace-dx log removal) and `test/run.js` (C++ throw decoding for RaiseException) — not from this session; user decision on commit/discard pending.

## Prior notes

- `apps/aoe.md` 2026-04-18 entry notes two DDraw fixes (SetEntries memcpy, 8bpp COLORFILL) that "visually unlock MCM" — those are likely what got MCM past the splash freeze.

## 2026-04-18 session 7 — root cause found: LoadStringA ignores hInstance, lang.dll strings invisible

**TL;DR:** MCM ships with **no RT_STRING resources in the EXE**. All UI/error strings live in `lang.dll` (loaded at `0x011cd000`, API #270). `$handle_LoadStringA` in `src/09a-handlers.wat:1605` discards the `hInstance` arg; `$string_load_a` in `src/10-helpers.wat:806` only walks `global.get $image_base` (the main EXE). So **every** `LoadStringA` returns 0 for MCM. Cascade:

1. `LoadStringA(hLangDll, 0x13d8, buf, 0x200)` → 0. At `0x004652b8` the `test eax,eax; jz 0x4652f0` skips the user-confirm `DialogBoxParamA` entirely — the dialog (where the user would accept 3D) is never shown.
2. Control jumps to `call 0x468130` (registry subkey-wipe — see correction below) → `call [eax+0x5c]` (game-class method 23, the real 3D-init entry) → returns 0 (likely because subsequent internal `LoadString`s for sub-init also return 0).
3. `LoadStringA(hLangDll, 0xbba, …)` → 0 → empty error buffer.
4. App falls into its "something failed, quit" path: `DestroyWindow` → `ShowCursor(1)` → `PostQuitMessage(0)`.
5. `[this+8]` stays at its constructor-zeroed value since the initializer (vtable slot 7 at `0x00466260`) is only called from `0x0046610e`, which is downstream of the `[eax+0x5c]` chain. Message pump runs tick fn one more time → null deref at `0x00466791`.

**All previous "null vtable / `[this+8]` uninit / 3D caps rejected" notes describe downstream symptoms of this one root cause.**

### Verification

- `node tools/parse-rsrc.js test/binaries/shareware/mcm/mcm_ex/MCM.EXE` → `Strings: 0, Menus: 0, Dialogs: 0, Icons: 1, Accelerators: 0`. Raw `.rsrc` dir at VA `0x527000` has 3 ID entries only: RT_ICON (3), RT_GROUP_ICON (14), RT_VERSION (16).
- `grep LoadLibrary /tmp/mcm-api.log` → `[LoadLibrary] lang.dll loaded at 0x11cd000, dllMain=0x11ce170`, and MCM stashes that HMODULE in `[esi+0x46c]` (passed as `hInstance` to every `LoadStringA`).
- `--trace-at=0x004652b8` → `EAX=0x00000000` after `LoadStringA(0x13d8)`.
- `--trace-at=0x00465339` → `EAX=0x00000000` after `LoadStringA(0xbba)`.

### Correction to session 3 note (line 110)

`0x00468130` calls via IAT slots `[0x525524]`/`[0x525520]`/`[0x52552c]`. Previously mis-identified. USER32 IAT for ADVAPI32 is at base `0x525510`:
- `0x525524` = **RegOpenKeyExA** ✓
- `0x525520` = **RegEnumKeyA** (not RegQueryValueExA)
- `0x52552c` = **RegDeleteKeyA** (matches `mov ebp, [0x52552c]` at `0x004681dd`)

So `0x00468130` really is an "enumerate-and-delete subkeys" routine (registry cleanup). Still not 3D init.

### Fix direction (not yet committed — needs user scope approval)

`$string_load_a` (and by extension LoadStringA / FindResource / LoadResource / LoadAcceleratorsA / LoadMenuA / LoadBitmapA / etc.) needs **per-module resource lookup**. Currently hardwired to `global.get $image_base`. Plan:

1. DLL loader (`src/08b-dll-loader.wat` + `lib/dll-loader.js`) registers each loaded DLL's `.rsrc` base + size in a small table keyed by HMODULE.
2. `$find_resource` / `$string_load_a` take an optional `hInstance` arg; when non-zero AND matches a loaded DLL, walk that DLL's `.rsrc`; else fall back to main EXE.
3. LoadStringA plumbs `arg0` (hInstance) through. Same for other Load* APIs that take hInstance.

Files likely touched: `src/09a-handlers.wat` (LoadStringA, LoadAcceleratorsA, LoadMenuA, LoadBitmapA, LoadIconA, LoadCursorA, FindResourceA, LoadResource, SizeofResource), `src/10-helpers.wat` ($string_load_a, $find_resource, $rsrc_find_data_wa), `src/08b-dll-loader.wat` (HMODULE→rsrc registration), `lib/dll-loader.js` (pass rsrc info to WAT at load time).

**Scope consideration:** this also unblocks any other app that localizes UI strings into a satellite DLL. If we choose to defer, a minimal hack is to have LoadStringA fall through a list of all loaded DLLs' `.rsrc` bases — ugly but small.

### Supersedes (in this file)

- Sessions 4-6 hypotheses about "null vtable[10]", "3D caps rejected", "vtable slot 7 never runs" — all correct observations but downstream of this single root cause.
- "MCM-1" open task (ESP leak) — pre-existing fix already landed; not related to current blocker.

## 2026-04-18 session 8 — MCM-7 fixed: per-module resource lookup

Implemented per-module `.rsrc` routing end-to-end:

- `src/08b-dll-loader.wat` now records each DLL's resource-dir RVA+size in a new parallel `DLL_RSRC_TABLE` (0x04462200, 16×8B).
- `src/10-helpers.wat` adds `$r_base` / `$r_rva` helpers plus `$push_rsrc_ctx(hInstance)` / `$pop_rsrc_ctx`. `$find_resource`, `$find_resource_named_type`, `$rsrc_find_data_wa`, `$string_load_a`, `$dlg_load` all route through the helpers so they follow the active module.
- Handlers that take an `hInstance` now push/pop context: `LoadStringA`/`W`, `FindResourceA`/`W`, `FindResourceExA`, `LoadAcceleratorsA`/`W`, `DialogBoxParamA`, `CreateDialogParamA`/`W`.
- `lib/filesystem.js` MapViewOfFile base shifted 0x04462200 → 0x04462400 to make room for the new table.

**Outcome:** `LoadStringA(hLangDll, 0x13b3, ...)` now returns real strings. MCM no longer crashes on the "Could not find 3-D acceleration hardware" path; it advances ~1079 API calls further to a registry-based installation check that posts MessageBox *"Installation error. Please reinstall Microsoft Motocross Madness."* and exits cleanly. Different, unrelated blocker — open as MCM-8.

### MCM-8 (new)

Installation check at `RegOpenKeyExA(HKLM, 0x03fffb00, ...)` (API #927) fails (returns nonzero; our stub returns 0x100010) and the app takes its "reinstall" branch. Need to inspect the subkey path at `0x03fffb00`, decide whether to fake a "MCM is installed at path X" registry entry, or synthesize it via `test/run.js` pre-seeded registry. No WAT changes expected.

### Not yet covered by per-module context

- `LoadMenuA`/`W`, `LoadBitmapA`/`W`, `LoadIconA`/`W`, `LoadCursorA`/`W`: these return fake handles and resolve lazily; not wired through `$push_rsrc_ctx` yet. Fix if any app ships menus/bitmaps/cursors in a satellite DLL (none known today).
- `LockResource`: HRSRC is just a data-entry offset; caller loses track of which module owns it. Fine as long as `FindResource` → `LoadResource` → `LockResource` chains stay within the main EXE, which is the only path exercised today.
- `GetFileVersionInfoSizeA`/`A`: always read from main EXE (`lpFilename` ignored). Matches current semantics.
- The line 110 note about `0x468130` calling RegQueryValueExA — wrong, it's RegEnumKeyA.
