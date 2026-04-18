# MCM (Motocross Madness, Microsoft, 1998)

**Exe:** `test/binaries/shareware/mcm/mcm_ex/MCM.EXE`
**DX path:** DDRAW.dll only (no D3DIM.DLL direct link). QIs IDirect3D3 off IDirectDraw at runtime — potential D3DIM execute-buffer / DrawPrimitive test target.
**Entry point:** (TBD)
**Run:** `node test/run.js --exe=test/binaries/shareware/mcm/mcm_ex/MCM.EXE --max-batches=500 --trace-api`

## Status (2026-04-18)

Advances through splash → DirectDraw setup → 12 Flip-loop frames → secondary crash at EIP=0 during D3D device setup.

**Progressed past (this session):**
- Error 3002 "Could not find any 3-D acceleration hardware" — was a no-op `IDirect3D3_EnumDevices` stub. Fixed by implementing a real HAL callback in `src/09a8-handlers-directx.wat` that fills D3DDEVICEDESC (HW + HEL, 252 bytes) and D3DPRIMCAPS (56 bytes), invokes callback via CACA0007 continuation. Commit `45a6952`.
- MCM now calls: `IDirectDraw::QI(IID_IDirectDraw2)` → `IDirectDraw::QI(IID_IDirect3D3)` → `IDirect3D3::EnumDevices` → `IDirectDraw::CreateSurface` → `IDirectDrawSurface::QI(DA044E00-69B2-...)` → `Flip×12` → `GetPixelFormat` → crash.

## Current blocker — 8-byte ESP leak in function 0x00491a00

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
