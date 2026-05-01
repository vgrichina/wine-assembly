# Plus! 98 Screensavers — Progress

**Binaries:** `test/binaries/screensavers/` (19 screensavers from Plus! 98)
**Command-line:** `/s` = run screensaver, `/c` = config dialog, `/p <hwnd>` = preview
**Status:** Config dialogs work for all. 4/7 GDI savers render with sprites. 5 MFC42 savers reach the message loop. 7 D3D/DDraw savers run their game loop but produce only HUD/fade chrome — main mesh-render path is never entered (see Task 3).

## Categories

### Pure GDI
| Screensaver | /s Visuals | Notes |
|-------------|-----------|-------|
| PEANUTS / CATHY / DOONBURY | Renders | Sprite compositing fixed |
| FOXTROT | White silhouettes | See Task 1 |
| GA_SAVER | Renders | Garfield/Odie on pogo sticks |
| CITYSCAP | Blank | Spins in GetMessageA, render fn never runs (Task 2) |
| PHODISC | Desktop teal only | Asset-load path missing (Task 2) |

### MFC42-based
| Screensaver | /s Visuals | Notes |
|-------------|-----------|-------|
| WIN98 | Renders | DDraw QI AddRef fix |
| CORBIS / FASHION / HORROR / WOTRAVEL | Black | Need DirectAnimation (DAView/DAStatics). Deferred — large COM surface. |

### Organic Art (statically-linked DX framework, all 7 are the same 1,005,056-byte PE — `md5 fef9ed080d8cbb34df636f9c71b406cd`)
ARCHITEC / FALLINGL / GEOMETRY / JAZZ / OASAVER / ROCKROLL / SCIFI: Config OK; `/s` reaches the per-frame loop, but only emits a HUD quad + fade overlay via direct D3D2::DrawPrimitive. d3rm submits a single state-only Execute buffer per frame and never reaches its mesh-emission path. See Task 3.

## Open Tasks

### 1. FOXTROT white silhouettes (LOW)

Inconclusive after 2026-04-20 investigation: the 75×80 character sub-sprites in the 225×80 sheet have only white/gray/maroon palette entries in the source art. Either real Win98 used dynamic palette mapping we don't emulate, or the rendering is faithful and the original note misdiagnosed. Need a reference screenshot before further work.

### 2. CITYSCAP / PHODISC blank screens (MEDIUM)

- **PHODISC:** DIB blit no longer wipes canvas (sparse-hash sync fix shipped) — now shows desktop teal but no photos. Asset-load path not traced yet.
- **CITYSCAP:** Spins in GetMessageA without ever calling SetTimer/InvalidateRect. Render fn never runs. Probably missing a startup message or a registry value that gates rendering.

### 3. d3rm MeshBuilder::Load fails on ProgressiveMesh (HIGH)

**Test bed:** DX SDK `viewer.exe` loading `camera.x` is the minimal repro for the same d3rm path the Organic Art screensavers use. `IDirect3DRMMeshBuilder::Load` returns `D3DRMERR_NOTFOUND (0x88760311)`; viewer pops "Failed to load camera.x.\n(null)". Same root path is what leaves the screensavers' main mesh-render dead.

**Architectural facts (settled, don't re-litigate):**

- d3drm.dll is a **guest** PE running on our emulator (image base `0x64780000`, runtime base `0x7459b000`, delta `0xfe1b000`). `$handle_Direct3DRMCreate` is dead code in this configuration.
- d3dxof.dll is loaded dynamically via `LoadLibraryA` from d3drm at `d3drm+0x647d0a90`. Its DllMain populates the template registry.
- The 7 Organic Art savers are byte-identical; only the .SCN config differs.
- Scene-picker is fine: ROCKROLL.SCN has no `Active=` key but still loads its own assets. `Active=` only gates the random CA_* pool. Don't chase OrgSuppList.txt.
- Per-frame Execute buffers in screensaver runs contain ONLY a 28-byte `STATETRANSFORM(count=3)` + 4-byte `EXIT` — no `PROCESSVERTICES`/`TRIANGLE`/`POINT`/`LINE`. Confirms geometry never reaches D3DIM; the only `DrawPrimitive` calls are SCR-side HUD/fade chrome (`0x744217e7`, `0x74420f28`).
- ROCKROLL/screensavers do **not** call any public `IDirect3DRM*` API beyond `Direct3DRMCreate`; everything else is COM vtable indirect, so `--trace-api`/`--break-api` are blind for d3rm internals. d3rm runs entirely inside the guest binary.

**Recent fixes shipped on this thread:**
- **cont.59 (2026-04-29):** `test/run.js` skipped `callDllMain` on dynamic `LoadLibraryA` ("Plugin DLLs don't need complex init"). d3dxof emphatically does — its template registry init lives in DllMain. One-line uncomment fixes it. Post-fix: 35 `RegisterTemplates` adds, parser runs cleanly end-to-end (CreateFileA → memory-map → UnmapViewOfFile pair on camera.x), then fails downstream with the new HRESULT below.

**Investigation chain (condensed) leading to current bug surface:**

| Step | VA | Finding |
|------|----|---------|
| viewer Load wrapper | `viewer+0x401ff1` | `call [eax+0x2c]` = `IDirect3DRMMeshBuilder::Load`; `--trace-at` shows EAX=`0x88760311` (D3DRMERR_NOTFOUND) on return. |
| NOTFOUND emit site | `d3drm+0x647d09f6` | Only one of 12 candidate `push 0x88760311` sites fires. Enclosing fn `0x647d0868` is the d3rm "load top-level objects from X-file" walker; bail at `0x647d09ea: test bl,0x80; jz success / cmp [ebp-8],0; jnz success` ⇒ "flag bit 7 set AND no objects loaded → NOTFOUND". |
| Per-object dispatcher | `d3drm+0x647d02cd` | Cascades GUID-equality compares; for each match calls `find_guid_in_pointer_list(filter, count, type_guid)` at `0x647d0701`. If type isn't in caller-supplied filter → bail. Helper returns 1 on `count==0` (empty filter accepts everything). |
| Hit counts (ROCKROLL/viewer, 8000 batches) | | dispatcher entry: 2 (Header + ProgressiveMesh objects). Header consumer: 1. **PM GUID match: 1. PM handler call (`0x647d04d9` → `0x647cf6a7`): 0.** Generic bail (`0x647d06b8`): 1. Mesh/Frame consumers: 0. |
| Filter haystack at PM arm | `--trace-at-dump` on `0x647d0701` | `*arg1 = 0x0041d700` → `d3drm+0x64781700` = TID_D3DRMMesh. arg3 needle = `d3drm+0x647818d0` = TID_D3DRMProgressiveMesh. **Filter list is `[TID_D3DRMMesh]` (count=1); PM is not in it.** |
| Filter source | walker chain `MeshBuilder::Load → 0x647cdf1d → 0x647d0868 → ...` | 4 of 7 `0x647cdf1d` callers push `[edi+0x2c]` / `[esi+0x2c]` as the filter. So `[meshbuilder_obj+0x2c] = &static_array_of_one_GUID_pointer = [&TID_D3DRMMesh]`. |

**Bug surface:** real DX5 MeshBuilder::Load is supposed to convert ProgressiveMesh → Mesh transparently. Two competing hypotheses:

- (a) Filter is [Mesh]-only by design; the PM arm should NOT gate on the filter — instead it should call the PM handler at `0x647cf6a7` to flatten PM → Mesh and re-dispatch. If true, the filter check is logically misplaced for the PM arm and our path through the dispatcher misses the early-out that real d3rm has.
- (b) `[obj+0x2c]` is supposed to point at a multi-entry array (`[&TID_D3DRMMesh, &TID_D3DRMProgressiveMesh, ...]`) and a static blob got the wrong pointer due to a relocation/load-order issue.

**cont.62 plan:**
1. Disasm the static at `d3drm+0x64781700` and `d3drm+0x647818d0` neighbourhoods — is there a longer pointer-array (multiple consecutive GUID-pointer slots) anywhere near `0x64781700`? If yes, the runtime is reading the wrong base pointer (option b). If `0x64781700` is a single-pointer literal, option (a) is more likely.
2. Disasm `d3drm+0x647cf6a7` (the would-be PM handler, never reached). If it's "convert PM data → Mesh and re-dispatch", then option (a) is confirmed and the fix is to bypass the filter check on the PM arm.
3. Cross-check by feeding viewer a **plain-Mesh** `.x` file. Every X file in `test/binaries/dx-sdk/bin/` is PM. Hand-craft a minimal `xof 0303bin 0032 / Header { … } / Mesh { … }` and save as camera.x. If MeshBuilder::Load succeeds, the bug is purely PM-handling.

**Tooling tip surfaced this session:**
- `--count` is a native WASM hit-counter and only fires on **block-entry** EIP. Mid-block addresses (e.g. `wvsprintfA` call site `0x40200e`/`0x402013`, `yyerror` call site inside the parser error block) read 0 even when execution clearly passes through. Use `--trace-at` (single-addr, forces BATCH_SIZE=1) or `--break-once` for any address whose value lives inside a function body rather than at a fn entry / call-return landing. (See `13-exports.wat:46`.)
- `--trace-eip-range=LO-HI` (module-relative VAs supported) was added on this thread to debug the parser-error region; logs every block-entry EIP inside the range. Closed the cont.54b "is yyerror reachable?" puzzle by showing it fires exactly once per parse failure.
- `module+0xVA` syntax accepted by `--trace-at`, `--count`, `--break`, `--trace-eip-range` — auto-resolves after deferred DLL load.

**Earlier hypotheses retracted (kept for record only — full chronicle in git log):**

The investigation went through ~60 continuation entries before localizing to MeshBuilder::Load. False leads that consumed major effort, summarized so they don't get re-explored:

- "Empty viewport.+0xc4 list" / "[entry+0x84]=0 bind path is dead" / "Frame::AddLight slot 6 of vtable 0x647dfcc0" — vtable mis-identified, predicate gates apply only to fog/light handling, not the live render path. ROCKROLL never invokes those.
- "Public IDirect3DRMViewport::Render at `0x6478be6d` is dead at SCR boundary" — true but irrelevant: SCR doesn't drive RM via public methods at all post-`Direct3DRMCreate`.
- "Dirty bits at `[device+0x90]` never set, gates ff51/fe13 chain" — chain entry is `IDirect3DRMDevice::HandlePaint` at `0x647857cf`; `[device+0x90]` flag setter is slot 36 = `SetRenderMode(BLENDED+SORTED)`, only matters for transparency mode, not for emitting geometry.
- "Custom Visual classes via render callbacks" / "d3rm software-rasterizes, geometry never reaches D3DIM" / "Caps mishandled" — all falsified by runtime hit counts. Geometry-emit subtree is dead because **no Mesh ever loads**, not because the render walker skips it.
- "ARCHITEC vertex zeros" / "D3DIM matrix table only emits STATETRANSFORM" — symptom, not cause; same NOTFOUND-on-Load underneath.
- "d3xof binary lexer mishandles tag 0xff at state 0x28" (cont.55b) — wrong: 0xff is a synthetic EOF emitted by `yylex` wrapper at `0x5c506e2d` when the global flag at `0x5c51cc34` is set, and the flag is set by a parser semantic action that called `lookup(name) → 0` on an empty template registry. Real fix was cont.59 (DllMain skip).

The full chronicle (cont.1 through cont.60b, plus the parallel "scene-walker / dispatcher / list ownership" chain) is preserved in the git history of this file. Don't excavate it unless a new finding contradicts the current narrative.

**2026-04-30 cont.62 — filter mechanics fully decoded; the gate is real in the shipped binary, so the bug must be upstream of dispatcher.**

Statically traced the filter source. Key findings:

1. **The 6-entry table at `d3drm+0x64782380` is a red herring.** It's a `(GUID*, vtable*)` pair list inside an outer directory at `d3drm+0x647826d0` mapping class IIDs to filter-blocks. `0x647826e0` pairs `0x64781520` (an IID) → `0x64782380`. NOT the runtime filter passed to the walker.

2. **The 7 public-Load wrappers calling `0x647cdf1d` build the filter as a single-element stack local.** Reference: `0x647ce066` (a non-MeshBuilder Load wrapper):

   ```
   647ce06b  mov eax, 0x647816b0          ; static GUID literal
   647ce07d  mov [ebp-4], eax              ; local = &GUID
   647ce0a1  lea eax, [ebp-4]
   647ce0a4  push 1                        ; ★ count = 1
   647ce0a6  push eax                      ; ★ filter = &local (one ptr)
   ...
   647ce0b0  call 0x647cdf1d
   ```

   The `push [edi+0x2c]` cont.61 misread as "filter from per-instance field" is actually arg1 (an unrelated payload). cont.61's "[obj+0x2c] = filter array" claim is wrong.

3. **CreateMeshBuilder helper at `0x6478fcf4` hardcodes the MeshBuilder's primary template GUID = `0x64781700` (`TID_D3DRMMesh`)** — single GUID, no PM. So the shipped d3drm.dll really does instantiate MeshBuilder with a Mesh-only filter.

4. **PM handler `0x647cf6a7` is a re-dispatch shim:** it calls `IDirectXFileData::GetNextObject` on the PM data object, QIs the child as IDirectXFileData, runs `IDirectXFileData::GetType` on the outer, verifies it matches IID at `0x64781c20`, then re-invokes the user callback `[ebp+0x1c]` with `&TID_D3DRMProgressiveMesh`. Function flow is consistent with "expand PM into Mesh data, then call the original handler" — but the dispatcher's PM arm at `0x647d048d-0x647d049a` gates the call to `0x647cf6a7` on `find_guid_in_pointer_list(filter, count, &PM)`. With filter=[Mesh] only, the gate fails and the PM handler is never reached.

**Reconciling with real DX5:** since the shipped binary really does have count=1 + Mesh-only filter AND the PM gate at `0x647d048d`, real Win98+DX5 must reach a successful Load via a different path than `MeshBuilder::Load → 0x647cdf1d → 0x647d0868 → 0x647d075c → 0x647d02cd`. Three remaining hypotheses:

- (a) **PM expansion happens at the d3xof layer**, not in d3rm: `IDirectXFileEnumObject::GetNextDataObject` could materialize a PM as a synthetic Mesh data object (or the X-file parser silently rewrites PM templates as Mesh on load). Then by the time the d3rm dispatcher sees the data object, its template GUID is already TID_D3DRMMesh and the filter passes. Worth checking d3xof's binary parser for any PM-aware translation step.
- (b) **MeshBuilder::Load uses a different walker for the .x file's top-level objects** than the chain above. cont.61 traced `MeshBuilder::Load → 0x647cdf1d` from the runtime hit counts on the bail site `0x647d09f6`, but maybe the bail site is reached from a different upstream call than CreateMeshBuilder/Load. Trace MeshBuilder::Load's first instruction (vtable slot 11 of the IDirect3DRMMeshBuilder vtable returned by CreateMeshBuilder) and walk forward — confirm it reaches `0x647cdf1d` via the chain we assumed.
- (c) **The version of d3drm.dll we're using doesn't match viewer.exe's expectations.** Verify file-level metadata (PE timestamp, version resource).

**cont.63 plan:**
1. Locate IDirect3DRMMeshBuilder vtable; identify slot 11 = Load. Set `--break-once` on its entry, capture the actual call chain to `0x647d02cd` via `dbg_prev_eip` and stack walk. Confirm or refute the chain MeshBuilder::Load → 0x647cdf1d.
2. Disasm d3xof's IDirectXFileEnumObject::GetNextDataObject (find via tools/find_string.js for "DirectXFile" or the IDirectXFileEnumObject IID, then xref); check whether it has any PM→Mesh template-rewriting logic.
3. Check the d3drm.dll version against the camera.x DX SDK version. If they're mismatched, swap to the DX SDK's bundled d3drm if any.

### 4. MFC screensavers — full DirectAnimation (DEFERRED)

CORBIS investigation (2026-04-20): the COM dependency isn't IPicture/OleLoadPicture but **DirectAnimation** (DAView + DAStatics from `danim.dll`). `CLSIDFromProgID(L"DirectAnimation.DAView"/L"DAStatics")` stubbed to `REGDB_E_CLASSNOTREG`; app then crashes on a null vtable from an unpopulated DAView pointer. Bringing up even minimal DirectAnimation is larger than the existing DDraw work. FASHION/HORROR/WOTRAVEL share the framework.

`CLSIDFromProgID` returns `REGDB_E_CLASSNOTREG`. `IDirectDrawFactory` (CLSID `0x4FD2A832`, ddrawex.dll) is short-circuited in `CoCreateInstance`; its 5 vtable methods (api_ids 1136–1140) delegate to existing DDraw wrappers. WIN98.SCR works via this path.

## Tooling — recently added (keep using)

- `tools/dump_va.js <pe> 0xVA[,...] [len]` — peek static PE/DLL bytes; explicitly tags BSS so a zeroed sentinel doesn't masquerade as initialized data.
- `tools/vtable_dump.js <pe> 0xVTBL_VA [n]` — enumerate N vtable slots with first-instruction disasm of each target.
- `tools/find_vtable_calls.js <pe> <slot>` — locate `call dword [reg+disp]` (FF /2) sites by vtable slot or raw displacement; complements xrefs.js (data refs) and find_field.js (data accesses).
- `--trace-dx-raw` (lib/host-imports.js case 8) — hex-dumps the full Execute-buffer instruction stream, not just the walker's parse.
- `--trace-at-dump=ADDR:LEN[,...]` — per-hit memory snapshot; pair with `--trace-at-watch` for diff-vs-previous.
- `--trace-eip-range=LO-HI` — block-entry EIP log over a VA range; module-relative form supported. Use to enumerate which blocks in a region actually execute (handles block-cache fusion that defeats single-addr `--count`).
- `[dx] ExecIn` formatter (lib/host-imports.js:4397) annotates each Execute with `caller=<retAddr>` so the originating wrapper is identifiable in one glance.

## Completed (for reference; details in git log)

- **InSendMessage / EnumWindows + ESP cleanup** — fixed ESP drift across stdcall handlers; unblocked 7 DDraw savers' MFC init.
- **DirectDraw QI AddRef** — QI must AddRef even when returning the same wrapper, otherwise Release frees the DX_OBJECTS slot. Unblocked WIN98.SCR rendering.
- **Sprite SRCAND/SRCPAINT compositing** — black silhouettes → correct colors (PEANUTS/CATHY/DOONBURY).
- **MFC42 CBT hook stack fix** — CACA0002 missing saved_ret/saved_hwnd pushes; unblocked CORBIS/FASHION/HORROR/WIN98/WOTRAVEL message loop.
- **THREAD_BASE moved out of thunk zone** — was 0x01D52000, now 0x01E52000.
- **D3D init crashes** (sessions 2026-04-18 a..j): "No valid modes" CA::DXException — root-caused to GetSurfaceDesc reporting SYSTEMMEMORY caps for Z-buffers. Plus IDirect3D2 QI returning D3D3 vtable, IDirect3D2::CreateDevice returning DEV3 vtable, GetPalette error triggering DXException, COM-wrapper vtable mutation replaced with aux-wrapper pool. All shipped.
- **TLS via fs:[0x2c]** — MFC string helpers read TLS array via direct FS-segment access, never call TlsGetValue. Eagerly allocate `$tls_slots` and set `fs_base+0x2c` in `$enter_entry_point`.
- **fs_search_path arg-order bug** — `writeStr(bufGA, full, bufLen, isWide)` consumed `bufLen` as `isWide`, so SearchPath results were UTF-16-encoded. Fixed.
- **IDirectDrawSurface2 GetDDInterface / PageLock / PageUnlock** — `esp += 8` instead of `esp += 12` caused -4 ESP drift; downstream `pop edi` read wrong slot, manifested as a phantom EDI corruption across an unrelated callee.
- **QI for Texture2 / DDSurface must upgrade vtable** — DX3-compat "return same wrapper for any QI" broke Texture2→DDSurface roundtrips. Now uses aux-wrapper pool keyed by IID.
- **SEH walker fix** — `frame_ebp = seh_rec + 0x10` (was `+0xC`) for the 5-dword MSVC `__SEH_prolog4` layout; also reset `$steps=0` on unwind so `$th_call` doesn't clobber the unwind target. Apps with top-level MFC `__except` handlers now exit cleanly.
- **dibSection sparse-hash sync** — `_syncDibSection` no longer wipes the canvas on every BitBlt source resolution. Unblocked PHODISC's desktop-color render.
- **GetClipBox / Timer ID 0 / SetStretchBltMode / GetBkColor / GetTextColor / GdiFlush / PlaySoundA stub** — implemented.
- **DllMain on dynamic LoadLibraryA** — `test/run.js` was skipping `callDllMain` for runtime-loaded DLLs. d3dxof's template registry init lives in DllMain; uncommenting unblocked the X-file parser end-to-end.
