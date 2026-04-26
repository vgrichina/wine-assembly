# Direct3D Retained Mode (D3DRM) — Design

**Status:** SUPERSEDED. We took a different path: ship the real **d3drm.dll** (DX5/6 redist) as a guest PE and let it run on our emulator. The host-side `$handle_Direct3DRMCreate` E_FAIL stub is dead code — d3drm.dll exports its own Direct3DRMCreate that constructs guest-internal COM vtables. This design (Level 1 host-side stub graph) is kept for historical reference only; do not implement.
**Blocks:** ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI, WIN98 — all 7 Plus! 98 Organic Art DirectDraw screensavers (single byte-identical PE, differentiated by `.SCN` config).

## Current state (2026-04-25)

- `d3drm.dll` (DX6 redist) loaded as guest PE at runtime base 0x7459b000. Runs fine.
- `d3dxof.dll` (DX6 redist, 107792 B, 1999-01-08) shipped at `test/binaries/dlls/d3dxof.dll` — was the gate for `.x` mesh parsing. Without it, `0x647d0a8b` LoadLibrary failed and the parser early-exited with HRESULT 0x8876031a, so meshes were never read.
- ROCKROLL.SCR `--args=/s` end-to-end: 37 distinct `.x` + texture file mappings via `fs_create_file_mapping`/`fs_map_view_of_file`; per-frame STATETRANSFORM Execute buffers + Flip; 1 `IDirect3DDevice2_DrawPrimitive` per frame submitting a static 4-vertex TLVERTEX HUD watermark.
- Render path verified WORKING via canary: the watermark rasterizes to the back-canvas and shows in the PNG snapshot at (550,434)–(595,468). Lock/Unlock direct-write theory ruled out.
- **Open blocker:** d3rm never emits scene geometry (no PROCESSVERTICES, no TRIANGLE op, no DrawPrimitive with mesh data). Most likely the `.x` parse → `IDirect3DRMMeshBuilder::Load` succeeds but no `IDirect3DRMFrame::AddVisual` call ever attaches the mesh to the scene graph, so `IDirect3DRMViewport::Render` walks an empty visual list. All IDirect3DRM* methods live inside d3rm.dll and never cross our COM boundary, so `--trace-api` won't show them; need static disasm of d3rm to locate the AddVisual / Render functions and `--break=` on them.

See memory/`project_organic_art_engine.md` for the active investigation log.

## Original design (kept for context — DO NOT IMPLEMENT)

## Context

All seven DDraw screensavers call `Direct3DRMCreate` from `D3DRM.DLL` as their first 3D step. Today it's unimplemented; they receive E_FAIL and throw a C++ exception, producing a black screen. D3DRM is a high-level scene-graph API deprecated after DX7; every screensaver uses the same small slice (load `.x` mesh → spin frame → render).

## Scope levels

### Level 0 — "Honest failure" (not in this design, but noted)
Return E_FAIL cleanly from `Direct3DRMCreate` and catch the C++ throw at the PE boundary so the app exits without a crash log. Gains nothing visually; exists only as a fallback.

### Level 1 — Stub-to-running (target of this design)
Every method returns D3DRM_OK, the scene graph is tracked but ignored, and no pixels are produced. Screensavers will "run" (message loop ticks, timers fire) but screen stays black. Lets us confirm the object lifecycle is correct before spending effort on a rasterizer.

### Level 2 — Minimal software rasterizer
Walk the frame tree each `Tick()`, project triangles with a fixed-pipeline transform, flat-shade to the DDraw primary surface's DIB. Roughly 2–3 weeks of work, out of scope for this design.

This doc specifies Level 1 with hooks for Level 2.

## Wiring into the existing DX machinery

D3DRM fits the same pattern as `09a8-handlers-directx.wat`:

1. One new source file: **`src/09a9-handlers-d3drm.wat`** (keeps file alphabetical-order coherent — follows `09a8`).
2. New COM object types in `DX_OBJECTS`:
   - `8` = IDirect3DRM (root)
   - `9` = IDirect3DRMFrame
   - `10` = IDirect3DRMMeshBuilder
   - `11` = IDirect3DRMMesh
   - `12` = IDirect3DRMDevice
   - `13` = IDirect3DRMViewport
   - `14` = IDirect3DRMLight
   - `15` = IDirect3DRMTexture
   - `16` = IDirect3DRMMaterial
   - `17` = IDirect3DRMAnimation / AnimationSet (share one slot; variant flag in misc0)
   - `18` = IDirect3DRMFace
   - `19` = IDirect3DRMWrap (texture-coord wrap)

`DX_OBJECTS` has 32 slots today; D3DRM scenes can easily exceed that. **Bump `DX_MAX` to 256** (and its backing region — currently 32×32 = 1KB at 0xE970; 256×32 = 8KB overflows into 0x10970, which is still below `GUEST_BASE=0x12000`, so fits).

Per-object payload reuses the existing 32-byte layout:
- `+0` type, `+4` refcount (existing)
- `+8` parent slot (frames) / mesh slot (meshbuilder) / device slot (viewport)
- `+12` aux0 (frame: transform matrix handle; viewport: width)
- `+16` aux1 (viewport: height; mesh: vertex_count)
- `+20` aux_ptr (guest heap block holding larger state — transform matrix, vertex array, etc.)
- `+24` flags
- `+28` next_sibling slot (for frame children linked list)

Anything bigger than ~16 bytes of state lives in a separate `heap_alloc` block whose guest address goes in `aux_ptr`. Matrices (16 floats = 64 bytes) and vertex arrays always use `aux_ptr`.

3. New vtables registered in `init_dx_com_thunks`:
   - `DX_VTBL_D3DRM` — 21 methods
   - `DX_VTBL_D3DRMFRAME` — 41 methods
   - `DX_VTBL_D3DRMMESHBUILDER` — 56 methods (MeshBuilder3)
   - `DX_VTBL_D3DRMMESH` — 32 methods
   - `DX_VTBL_D3DRMDEVICE` — 26 methods
   - `DX_VTBL_D3DRMVIEWPORT` — 31 methods
   - `DX_VTBL_D3DRMLIGHT` — 11 methods
   - `DX_VTBL_D3DRMTEXTURE` — 18 methods
   - `DX_VTBL_D3DRMMATERIAL` — 12 methods
   - `DX_VTBL_D3DRMANIMATION` — 14 methods
   - `DX_VTBL_D3DRMFACE` — 17 methods
   - `DX_VTBL_D3DRMWRAP` — 13 methods

Allocate at the tail of the existing `init_dx_com_thunks` function. Total ~282 new thunks — `THUNK_BASE` is 256KB so we have headroom.

4. **API table additions** (`tools/gen_api_table.js` → regen):
   - `Direct3DRMCreate` exported from `D3DRM.DLL` (single top-level function).
   - 282 virtual-method entries as `D3DRM_<iface>_<method>` for the dispatch generator, same pattern as `IDirectDraw_QueryInterface`.

The dispatch generator (`tools/gen_dispatch.js`) already handles this format — the 09b2 br_table grows by ~282 cases automatically.

## Object-creation flow

`Direct3DRMCreate(ppD3DRM)` → `dx_create_com_obj(type=8, DX_VTBL_D3DRM)` → write guest ptr to `*ppD3DRM` → return D3DRM_OK. Identical to `DirectDrawCreate`.

Child objects come from the root via `CreateFrame`, `CreateMeshBuilder`, `CreateDeviceFromSurface`, `CreateViewport`, etc. Each allocates a new slot, stores the parent slot at `+8` where applicable, and returns the guest pointer.

### DeviceFromSurface

`IDirect3DRM::CreateDeviceFromSurface(lpGUID, lpDD, lpDDS, lplpDev)`:
- Resolve the DDS guest ptr to a DX_OBJECTS slot (existing `dx_from_this` helper).
- Create a Device object with `aux0` = target surface slot, `aux1` = 0 (frame count).
- Level 1: never reads the surface.
- Level 2: reads `dib_ptr` at surface+20 as the render target.

### MeshBuilder::Load

Called with a `D3DRMLOADRESOURCE` or filename. All seven screensavers load `.x` mesh files from the PE's RT_RCDATA resources (type = `"MESH"` or numeric). At Level 1:
- Recognize `D3DRMLOAD_FROMRESOURCE` (flag=1), resolve the resource via the existing resource walker in `09c-help.wat` / WAT-native resource code.
- Record the resource address in `aux_ptr` (no parsing) so later `GetVertexCount`/`GetFace` calls can return plausible zeroes.
- Return D3DRM_OK.
- Level 2 adds a `.x` text parser (see "Deferred items" below).

### Frame hierarchy

Frames form a tree. `AddChild(parent, child)` links child into parent's child list via `+28` (next_sibling) and `+8` (parent back-pointer). `AddVisual(frame, meshbuilder)` attaches geometry; Level 1 stores mesh slot in a separate "visuals" linked list keyed off the frame.

Transforms: `SetOrientation`, `AddRotation`, `SetPosition`. Matrix lives in `aux_ptr` (64 bytes, row-major 4×4 float). Each mutation allocates or rewrites that block. Level 1 keeps the matrix updated (cheap; needed for Level 2) but never reads it.

### Viewport::Render + Tick

`IDirect3DRM::Tick(D3DVALUE delta)` is the per-frame driver. At Level 1 it's a no-op returning D3DRM_OK. The screensaver's message loop will keep ticking, timers will fire, and the DDraw primary surface stays unchanged (black unless the app calls `IDirectDrawSurface::Blt` with a color fill, which at least one of them does for the clear).

**Level 2 hook:** `Tick` walks all viewports, each viewport walks its scene root, each frame composes its matrix into a stack, each mesh rasterizes into the device's target surface DIB, then `dx_present` is triggered via the existing DDraw path.

## Method-by-method plan (Level 1)

All methods share this skeleton:

```
(func $handle_D3DRM_<Iface>_<Method>
  (param ...) (param $name_ptr i32)
  ;; (optional: read "this", update state)
  (global.set $eax (i32.const 0))  ;; D3DRM_OK = S_OK = 0
  (global.set $esp (i32.add (global.get $esp) (i32.const <4 + nargs*4>))))
```

Three categories:

| Category | Count | Behavior |
|----------|-------|----------|
| **State-tracking** (AddRef, Release, AddChild, AddVisual, Set* matrix ops, CreateX factories) | ~60 | Update DX_OBJECTS fields; return D3DRM_OK |
| **Query** (GetClassName, GetName, GetAppData, GetCount, GetParent) | ~40 | Return zeros / empty strings; D3DRM_OK |
| **No-op** (everything else: lighting params, animation keys, texture setters) | ~180 | Return D3DRM_OK |

Release is the only method with real logic: decrement refcount, free DX_OBJECTS slot and any `aux_ptr` heap block at zero. (Matches existing IDirectDraw_Release pattern.)

## Enum / flag values the guest will write

From the DX5/6 SDK headers we need to acknowledge without acting on:
- `D3DRMLOAD_*` flags passed to `MeshBuilder::Load`
- `D3DRMRENDER_*` flags to `Device::SetQuality`
- `D3DRMLIGHT_*` types
- `D3DVALUE` is a 32-bit float — no byte-swapping needed
- `D3DRMCOLOR` is `packed u32 ARGB`
- `D3DRMMATRIX4D` is 16 floats, 64 bytes

No enum validation at Level 1 — we accept anything.

## IID handling

`IDirect3DRM::QueryInterface` gets called for `IID_IDirect3DRM2` and `IDirect3DRM3` (the v2/v3 upgraded root interfaces). At Level 1, return the same object with AddRef (same trick we use for `IDirectDraw2` QI today) and install `DX_VTBL_D3DRM` for all three — the v2/v3 methods we care about are a superset and the differing prototypes all return D3DRM_OK anyway. If a screensaver hits a v3-only method not in our v1 vtable, dispatch will 404; we add that method on demand.

IID GUIDs the guest will ask for (compare first DWORD for speed):
- `IID_IDirect3DRM`   = `{2bc49361-...}` → first DWORD `0x2bc49361`
- `IID_IDirect3DRM2`  = `{4516ec83-...}` → `0x4516ec83`
- `IID_IDirect3DRM3`  = `{4516ec83-...}` — **same first DWORD as RM2** in some headers; use full 16-byte compare here.

## Deferred items (Level 2)

Listed so the design is complete but scope is clearly bounded:

1. **`.x` file parser.** Text-format DirectX mesh. Header: `xof 0302txt 0032`. Tokenizer → template-aware parser. All seven screensavers embed text `.x` files in resources; no binary variant seen.
2. **Matrix math in WAT.** 4×4 float multiply, translate, rotate (Euler and quaternion). ~150 lines of WAT with f32 ops. Transforms compose via matrix stack during Tick.
3. **Software rasterizer.** Per triangle: transform verts to screen space, clip, scanline-fill to the device's target surface DIB. Flat-shade only. Z-buffer allocated as `aux_ptr` on the device object, sized to surface width×height × 2 bytes.
4. **Present path.** After rasterizing to the DIB, trigger the same `dx_present` path `IDirectDrawSurface::Blt` uses so `SetDIBitsToDevice` lands on the renderer canvas. No new host import required.
5. **Texture handling.** Load DIB from resource → allocate texture slot → map UVs during rasterization. Can be deferred further; most of these screensavers are flat-shaded geometry (ARCHITEC is literally wireframe-ish buildings).

## File layout summary

- **New:** `src/09a9-handlers-d3drm.wat` (Level 1 bodies, ~2000 lines; Level 2 grows this to ~4000 with rasterizer).
- **Edit:** `src/09a8-handlers-directx.wat` — extend `init_dx_com_thunks` with 12 more vtables, bump `DX_MAX` to 256.
- **Edit:** `tools/gen_api_table.js` — add `Direct3DRMCreate` + 282 virtual method entries.
- **Regenerated:** `src/01b-api-hashes.generated.wat`, `src/api_table.json`, `src/09b2-dispatch-table.generated.wat`.
- **Edit:** `lib/dll-loader.js` if D3DRM.DLL isn't already in the stub DLL set — it should be, since the screensavers already link to it and reach `Direct3DRMCreate`.
- **Edit:** `screensavers.md` — move the 7 DDraw entries out of "blocked on Direct3DRMCreate".

## Findings from string analysis (resolves prior open questions)

All 7 screensavers share a **single identical D3DRM framework** (D3DMgr) — byte-for-byte identical `.rdata` string tables. One stub set works for all.

1. **Versions used:** v1 + v2 only. Guest QIs for `IID_IDirect3DRM2` and `IID_IDirect3DRMDevice2`. No `ProgressiveMesh`, no RM3. → Design drops `DX_VTBL_D3DRM3` and progressive-mesh vtable. Saves ~30 methods.
2. **D3DRM.DLL presence:** Not in `test/binaries/dlls/`. Stub route is the only option.
3. **Texture sourcing:** Primary path is `CreateTextureFromSurface(pDDSurface1, ...)` — texture pixels come from a DDSurface whose `dib_ptr` is already tracked in `DX_OBJECTS`. Secondary path is `EnableLoadTextureCallback` + `LoadTextureCallback` for file-based loads. Level 1 stores source-surface slot on the texture object; Level 2 reads `dib_ptr` during rasterization.

## Non-COM D3DRM.DLL exports (also need handlers)

Beyond `Direct3DRMCreate`, the 7 screensavers call 7 standalone C functions. All are pure math — **implement correctly at Level 1** (trivial and the framework calls them in hot loops):

| Export | Signature | Behavior |
|--------|-----------|----------|
| `D3DRMCreateColorRGB` | `(D3DVALUE r, g, b) → D3DRMCOLOR` | Pack `0xFF000000 \| (r*255<<16) \| (g*255<<8) \| (b*255)` |
| `D3DRMCreateColorRGBA` | `(D3DVALUE r, g, b, a) → D3DRMCOLOR` | Pack with supplied alpha |
| `D3DRMColorGetRed` | `(D3DRMCOLOR) → D3DVALUE` | `((c>>16)&0xFF)/255.0` |
| `D3DRMColorGetGreen` | `(D3DRMCOLOR) → D3DVALUE` | `((c>>8)&0xFF)/255.0` |
| `D3DRMColorGetBlue` | `(D3DRMCOLOR) → D3DVALUE` | `(c&0xFF)/255.0` |
| `D3DRMVectorNormalize` | `(D3DVECTOR *v) → D3DVECTOR*` | In-place normalize, returns same ptr |
| `D3DRMVectorRotate` | `(D3DVECTOR *r, D3DVECTOR *v, D3DVECTOR *axis, D3DVALUE θ) → D3DVECTOR*` | Rodrigues rotation |
| `D3DRMVectorSubtract` | `(D3DVECTOR *r, D3DVECTOR *a, D3DVECTOR *b) → D3DVECTOR*` | `r = a - b` |

`D3DVECTOR` = 3× f32. f32 return via ST0 (cdecl FP return).

## Corrections to design based on findings

- **Device creation:** Replace all references to `CreateDeviceFromSurface` with `CreateDeviceFromD3D(lpD3D, lpD3DDevice, lplpRMDevice)`. The RM device's `aux0` stores the D3D device slot (from existing `09a8` DX_OBJECTS); the render-target DDSurface is reached indirectly through the D3D device, not held directly.
- **Device QI for `IID_IDirect3DRMDevice2`:** must self-AddRef-return like the existing IDirectDraw2 pattern.
- **Must-succeed config methods:** `SetQuality`, `SetRenderMode`, `SetDither`, `SetBufferCount`, `SetTextureQuality` — all must return D3DRM_OK at Level 1. The framework aborts on any failure (each call is wrapped in a `"..." failed` guard).
- **`skull.x`:** baked into framework as fallback/demo mesh. Our MeshBuilder Load stub sees this name; no special handling needed.

---

## Real-DLL feasibility study

Acquired `d3drm.dll` (437,008 bytes, sha256 `fd80f3839a035b6b52362735b22eb8d2523d3434bf18afb3e0f1b5ace84357b0`) from the dxwnd SourceForge redist. Stored in `test/binaries/dlls/_d3drm_candidates/d3drm_dxwnd.dll` for analysis only — **not yet** added to the standard DLL set. PE32 GUI DLL, image base `0x64780000`, stripped.

### Exports (23, all ordinal-and-name)

```
Direct3DRMCreate         DllGetClassObject        DllCanUnloadNow
D3DRMCreateColorRGB      D3DRMCreateColorRGBA
D3DRMColorGetRed/Green/Blue/Alpha
D3DRMVectorAdd/Subtract/CrossProduct/DotProduct/Modulus
D3DRMVectorNormalize/Reflect/Rotate/Scale/Random
D3DRMMatrixFromQuaternion
D3DRMQuaternionFromRotation/Multiply/Slerp
```

The 7 non-COM helpers we identified are all present and exported (good — confirms the framework's calls resolve). `DllGetClassObject` is also exported, which means the framework *could* (but doesn't appear to) instantiate D3DRM via `CoCreateInstance` — `Direct3DRMCreate` is the actual call site in our screensavers.

### Imports the real DLL needs

| DLL | Count | Status in our emulator |
|-----|-------|------------------------|
| KERNEL32 | 100 | All present (CRT-style: heap, TLS, file mapping, MultiByteToWideChar, LCMapString, etc.) |
| USER32 | 6 | GetDC, SetRect, ClientToScreen, ReleaseDC, wsprintfA, GetSystemMetrics — all present |
| GDI32 | 2 | GetSystemPaletteEntries, GetDeviceCaps — GetDeviceCaps present, GetSystemPaletteEntries needs verification |
| ADVAPI32 | 3 | RegOpenKeyExA, RegQueryValueExA, RegCloseKey — all present (Reg* dispatcher) |
| DDRAW | 1 | DirectDrawCreate — present |
| **MSVFW32** | 1 | **ICImageDecompress — NOT present.** Video for Windows codec, used for texture decompression. |
| **ole32** | 3 | **CoInitialize, CoUninitialize, CoCreateInstance — currently stubbed (CoCreateInstance returns E_NOINTERFACE).** |
| **OLEAUT32** | 2 | **Ordinal-only imports (#6 = SysFreeString, #2 = SysAllocString). Not yet implemented.** |
| **ntdll** | 1 | **RtlUnwind — not implemented (used for SEH).** |

### Verdict

**Loading the real `d3drm.dll` is plausible but not free.** Gaps to fill before it would even DllMain successfully:

1. `RtlUnwind` (ntdll) — needed for SEH/CRT init. Stub or thread through existing 11-seh.wat.
2. `OLEAUT32` ordinals 6 & 2 — `SysAllocString`/`SysFreeString`. Trivial wrappers around heap_alloc + UTF-16 copy.
3. `ICImageDecompress` (MSVFW32) — non-trivial; this is a Video-for-Windows codec dispatch. Used by `IDirect3DRMTexture::Load` for compressed textures. Could return failure for Level-1-equivalent behavior.
4. `CoCreateInstance` already stubbed — D3DRM uses it internally for sub-object factories (e.g., texture loaders). May still return E_NOINTERFACE if it never CoCreates anything outside its own DLL.

Even after all imports are satisfied, the real DLL's `Direct3DRMCreate` will then call `IDirect3D::CreateDevice` on our DDraw stack — which currently returns stubbed objects. The DLL will try to `Lock`/`GetCaps`/build vertex buffers via IM. Our IM stubs are sparse, so it would crash deeper than where we currently fail. Net: we'd push the boundary ~5 method calls deeper at the cost of 4 new shim DLLs.

**Recommendation:** Keep the dxwnd `d3drm.dll` archived in `test/binaries/dlls/_d3drm_candidates/` for reference (we can disasm it to crib the math helper implementations and the IID GUIDs verbatim), but ship the WAT stub design. The real DLL becomes attractive only once IM (`IDirect3DDevice::Execute`) is also viable, and at that point we're closer to Level-2 in scope anyway.

### Useful reference uses for the real DLL

Even without loading it:
- **Disasm the math helpers** (`D3DRMVector*`, `D3DRMMatrix*`, `D3DRMQuaternion*`, `D3DRMColor*`) — they're ~20 lines each of x87 FPU. Faster to port than to derive from the SDK headers.
- **Extract IID GUIDs** from `.rdata` for `IDirect3DRM`, `IDirect3DRM2`, `IDirect3DRMDevice`, `IDirect3DRMDevice2`, `IDirect3DRMFrame`, `IDirect3DRMMeshBuilder2/3`, etc. — ground truth for our QI handlers.
- **Confirm vtable layouts** — index-by-index match against the SDK headers, in case our manually-counted method counts are off by one anywhere.

---

## What remains on the broader task list (after this doc lands)

Ordered by effort-to-value:

1. **PlaySoundA stub** for GA_SAVER — trivial (one handler, return TRUE, pop ESP).
2. **FOXTROT mask inversion** — isolated bug in sprite compositing path; probably a SRCAND/SRCINVERT swap.
3. **CreateDIBSection / StretchDIBits** — unblocks CITYSCAP + PHODISC; medium-sized and self-contained.
4. **Level 1 D3DRM** (this design) — unblocks 7 screensavers to "running but black".
5. **Level 2 D3DRM rasterizer** — makes them actually animate. Largest chunk of work by far.
6. **CoCreateInstance / IPicture** — unblocks CORBIS, FASHION, HORROR, WOTRAVEL (the MFC-COM-image-load ones). Separate COM rabbit hole.
