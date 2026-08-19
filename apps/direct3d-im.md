# Direct3D Immediate Mode (D3DIM) — Design

**Status:** Design only, not implemented.
**Unblocks:** MCM (Motocross Madness), MW3 (MechWarrior 3 demo), any future DX5/6/7 game that QIs `IDirect3D*` off an `IDirectDraw` root. Also an alternative route to running the 7 Plus! 98 D3DRM screensavers — because the real `d3drm.dll` uses IM internally, so a working IM stack lets us load the real D3DRM DLL instead of stubbing it in WAT.

## Why IM and why now

The `directx.md` plan explicitly listed Direct3D as a non-goal. Since then:

1. `09a8-handlers-directx.wat` sprouted `IDirect3D` and `IDirect3D3` vtables (factory-only — every method returns `E_FAIL = 0x80004005`). They exist because callers QI for them; they do no real work.
2. Two games in our test set drive IM directly from the guest: **MCM** (links `d3drm.dll` *and* uses IM via QI) and **MW3** (no `d3drm.dll`; pure IM via QI — confirmed by imports analysis).
3. The `d3drm.md` feasibility study found that loading the real `d3drm.dll` is almost possible — the only remaining hard blocker is that our IDirect3D IM stubs return E_FAIL, so the DLL aborts early. **Implementing IM knocks out both goals at once.**

So this is no longer speculative scope creep: IM is the next load-bearing DX layer.

## What IM actually is

IM is a **stateful, immediate rendering API**. The guest holds an `IDirect3DDevice`, sets render state (cull, blend, ztest, texture stage…), sets transforms (world/view/projection), optionally binds a vertex buffer, and calls a draw function. There are **two generations** of draw path, and every DX5–DX7 game uses one or the other (some use both):

### Generation 1 (DX3/DX5): Execute Buffers

```
IDirect3DDevice::Execute(lpExecuteBuffer, lpViewport, dwFlags)
```

An `IDirect3DExecuteBuffer` is a guest-allocated blob containing:
- a vertex list (`D3DVERTEX` / `D3DLVERTEX` / `D3DTLVERTEX` — 32/28/32 bytes each)
- an opcode stream with commands like `D3DOP_TRIANGLE`, `D3DOP_MATRIX_MULTIPLY`, `D3DOP_STATE_RENDER`, `D3DOP_STATE_LIGHT`, `D3DOP_PROCESS_VERTICES`.

Each opcode is 4 bytes (`bOpcode`, `bSize`, `wCount`). The device walks the opcode stream, processing vertices into a cached transformed buffer, then emitting triangles.

Old but load-bearing: **the real `d3drm.dll` uses Execute buffers internally.** Even modern DX games that use DrawPrimitive may QI for `IDirect3DDevice` (the original v1) to access this path. We can't skip it.

### Generation 2 (DX5+): DrawPrimitive / DrawIndexedPrimitive

```
IDirect3DDevice2::BeginScene()
IDirect3DDevice2::DrawPrimitive(D3DPT_TRIANGLELIST, D3DVT_LVERTEX, pVerts, nVerts, flags)
IDirect3DDevice2::EndScene()
```

Cleaner, more modern. The DrawPrimitive family takes a vertex format enum + a guest pointer + a count; the device transforms vertices with the current matrix stack and rasterizes. `DrawIndexedPrimitive` adds a separate index buffer. `DrawPrimitiveVB` (DX6) operates on a pre-populated `IDirect3DVertexBuffer`.

MCM, MW3, Fury3 all use this path. D3DRM uses the Execute buffer path.

## Interface surface

The real DX7 SDK exposes this tree of IM interfaces (accessible only via QueryInterface on an existing `IDirectDraw` — there is no `Direct3DCreate` factory until DX8):

| Interface | Methods | Notes |
|-----------|:-------:|-------|
| `IDirect3D` (v1) | 8 | QI target; factories for Light/Material/Viewport/Device |
| `IDirect3D2` | 9 | + `CreateDevice` (takes DDSurface as rendertarget) |
| `IDirect3D3` | 15 | + `CreateVertexBuffer`, `EnumZBufferFormats`, `EvictManagedTextures` |
| `IDirect3D7` | 9 | DX7 root; similar to D3D3 with cleanups |
| `IDirect3DDevice` (v1) | 23 | Old device — Execute, CreateExecuteBuffer, SetMatrix, BeginScene/EndScene, DrawPrimitive (no, only via Execute) |
| `IDirect3DDevice2` | 32 | + `DrawPrimitive`, `DrawIndexedPrimitive`, `GetRenderState`, `SetLightState` |
| `IDirect3DDevice3` | 40 | + `DrawPrimitiveVB`, `SetTexture`, `GetCurrentViewport`, `SetTextureStageState` |
| `IDirect3DDevice7` | 47 | DX7; folds Material+Light into device state, drops Viewports |
| `IDirect3DViewport` | 16 | Clip/project a rect of the device |
| `IDirect3DViewport2` | 17 | + `GetBackgroundDepth2` |
| `IDirect3DViewport3` | 20 | + `Clear2` with stencil/zbuf masks |
| `IDirect3DLight` | 7 | Positional/directional light descriptor |
| `IDirect3DMaterial` | 13 | Color coefficients |
| `IDirect3DMaterial2` | 12 | Superset minus `Reserve`/`Unreserve` |
| `IDirect3DMaterial3` | 12 | Same API, different GUID |
| `IDirect3DTexture` | 11 | Wraps a DDraw surface as a texture; `Load`, `Unload`, `PaletteChanged` |
| `IDirect3DTexture2` | 12 | Superset |
| `IDirect3DExecuteBuffer` | 12 | `Lock`/`Unlock`/`SetExecuteData`/`Optimize`/`Execute` |
| `IDirect3DVertexBuffer` | 10 | DX6; `Lock`/`Unlock`/`ProcessVertices`/`GetVertexBufferDesc` |
| `IDirect3DVertexBuffer7` | 11 | DX7 |

Method counts above are SDK-exact for what we need. Total ~310 methods across 17 interfaces.

**Good news:** we don't implement all of these. The real DX runtime treats v1/v2/v3/v7 as refinements of the same underlying engine. We implement one backend and route every vtable slot to it, with arg-shuffling thunks where signatures differ. Most "new" methods in v2/v3 are supersets that accept extra flags we can ignore.

## Phased scope

### Phase 0 — Plumbing only (sanity check)
- Replace the E_FAIL stubs in `09a8-handlers-directx.wat` for IDirect3D/IDirect3D3 with a real `CreateDevice` that returns a fake device object with a vtable of **return-S_OK** stubs.
- Every IDirect3DDevice method is a no-op returning `D3D_OK`.
- Expected outcome: MW3 and MCM now advance past `CreateDevice` and into their main loops. D3DRM.DLL (if we try it) survives its init. No pixels rendered.
- **~400 lines of WAT, entirely mechanical.** Gets us over the IDirect3D cliff at zero rendering cost.

### Phase 1 — Execute buffer walker, null backend
- Implement `CreateExecuteBuffer`, `Lock`/`Unlock`/`SetExecuteData`, `IDirect3DDevice::Execute`.
- The Execute handler parses the opcode stream, decodes each command, updates the device's internal state blocks (matrices, render state, lights, materials), but **does not rasterize**.
- For `D3DOP_PROCESS_VERTICES`, transform the input vertex list by the current matrix stack and write the transformed result to the device's vertex cache. This is ~60 lines of matrix-multiply WAT.
- For `D3DOP_TRIANGLE`, record the triangle index triplet into a queue.
- At `EndScene`, clear the queue (nothing drawn).
- Same trick for `DrawPrimitive`: transform, clip, queue, discard.
- Outcome: the game runs its entire render loop without crashing, state machine verified. D3DRM.DLL scene traversal works. Timing-dependent paths (MW3 physics tied to frame time) advance.
- **~1200 lines of WAT.**

### Phase 2 — Software rasterizer (flat-shaded solid triangles)
- Add scanline rasterizer: for each queued triangle, interpolate (x, y, z) across edges, emit colored pixels into the render-target DDraw surface DIB at the locked pitch.
- Z-buffer: attach a second DDraw surface to the primary (games do `CreateSurface(DDSCAPS_ZBUFFER)`); rasterizer reads/writes z per pixel.
- Clipping: scissor to viewport rect only (no frustum clip; out-of-range pixels get culled per-scanline).
- Projection: use a fixed pipeline — world × view × projection is multiplied once at `ProcessVertices`, then perspective-divide `(x/w, y/w, z/w)` → screen coords with the viewport's `dvScaleX/Y` + center.
- No texturing. No Gouraud shading. No alpha. No fog. Triangles come out as the material's diffuse color.
- Outcome: MW3's HUD and terrain are visible as flat-shaded silhouettes. D3DRM screensavers animate (cubes/spheres are flat-shaded colored blobs). MCM is recognizable.
- **~2000 lines of WAT.** This is the bulk of the work and can ship independently from Phase 3.

### Phase 3 — Textures + Gouraud
- `SetTexture`: store a DDSurface slot on the device. Rasterizer walks texels via perspective-correct (or affine) UV interpolation.
- `D3DTLVERTEX` and `D3DLVERTEX` already carry per-vertex UV and diffuse color. Rasterizer interpolates color + UV in addition to z.
- Per-vertex diffuse + a nearest-neighbour texel fetch gives real 3D graphics.
- Palette textures: if the bound surface is 8bpp paletted, convert to RGB via the surface's IDirectDrawPalette.
- Outcome: MCM bikes look like bikes, MW3 terrain has textures, screensavers show their `.x` mesh textures.
- **~1500 lines.** Bulk is the scanline inner loop.

### Phase 4+ (deferred)
- Alpha blending (`D3DRS_ALPHABLENDENABLE`): multiply + accumulate.
- Fog (`D3DRS_FOGENABLE`): per-pixel color blend toward fog color by depth.
- Multi-stage texturing (`SetTextureStageState`, DX6 only) — MW3 uses single-stage; deferred.
- Stencil buffer — no app in our set needs it.
- Vertex buffers backed by host-side transform — our transform is fast enough in WAT for anything a 1999 game pushes.

## Memory layout

Extend the existing `DX_OBJECTS` table (already bumped or about-to-bump to 256 per `d3drm.md`). IM adds these object types:

| ID | Interface | Payload (in the existing 32-byte per-slot record) |
|:---:|-----------|---------------------------------------------------|
| 20 | IDirect3DDevice | +8 render-target surface slot, +12 zbuf surface slot, +16 state-block guest ptr |
| 21 | IDirect3DExecuteBuffer | +8 buffer size, +12 guest data ptr, +16 exec data offset |
| 22 | IDirect3DVertexBuffer | +8 fvf, +12 num_vertices, +16 data ptr |
| 23 | IDirect3DViewport | +8 device slot, +12 viewport-data guest ptr |
| 24 | IDirect3DLight | +8 light-desc guest ptr |
| 25 | IDirect3DMaterial | +8 material-desc guest ptr |
| 26 | IDirect3DTexture | +8 backing DDSurface slot, +12 D3DTEXTUREHANDLE |

**Device state block** (~1 KB, one per device, heap-allocated):
- 4 × 4×4 matrix stack (world, view, proj, and a scratch slot) — 256 bytes
- Render state array indexed by `D3DRENDERSTATETYPE` (max ~140 entries) — 560 bytes
- Light state array (8 lights max) — 256 bytes
- Texture stage state — 128 bytes
- Current viewport rect + scale — 40 bytes
- Current material handle — 4 bytes

Total DX_OBJECTS addition is ~7 new type IDs; state blocks live on the normal guest heap, no new memory region.

## Vtable wiring

Identical to the existing D3DRM plan in `d3drm.md`. For each of the ~17 interfaces:

1. Add entries to `api_table.json`: `IDirect3D_QueryInterface`, `IDirect3DDevice2_DrawPrimitive`, etc. ~310 new entries.
2. Extend `init_dx_com_thunks` to allocate a shared vtable for each interface and populate its slots with THUNK_BASE addresses.
3. `gen_dispatch.js` → regenerate `09b2-dispatch-table.generated.wat`.

**Thunk pressure:** ~310 methods × ~8 bytes per thunk ≈ 2.5 KB. Existing `THUNK_BASE` zone is 256 KB. Fine.

**Source file:** new `src/09aa-handlers-d3dim.wat` (continues the alphabetical/numerical scheme: `09a8` DX, `09a9` D3DRM, `09aa` D3DIM). ~6000 lines including the rasterizer once Phase 3 lands.

## Versioning via QueryInterface

Games QI for interface upgrades: `IID_IDirect3D2`, `IID_IDirect3DDevice3`, etc. Same trick as existing IDirectDraw2 upgrade path:
- Recognise the IID by first DWORD for speed.
- Return the same underlying object with AddRef.
- Install the matching vtable address at the returned pointer.

One object, many vtables. The device itself is identical across v1/v2/v3/v7; only the method signatures differ, and arg-shuffling thunks bridge those differences to a single internal handler.

GUIDs (from DX7 headers, first DWORD for fast cmp):
- `IID_IDirect3D`         = `{3BBA0080-...}` → `0x3BBA0080`
- `IID_IDirect3D2`        = `{6AAE1EC1-...}` → `0x6AAE1EC1`
- `IID_IDirect3D3`        = `{BB223240-...}` → `0xBB223240`
- `IID_IDirect3D7`        = `{F5049E77-...}` → `0xF5049E77`
- `IID_IDirect3DDevice`   = `{64108800-...}` → `0x64108800`
- `IID_IDirect3DDevice2`  = `{93281501-...}` → `0x93281501`
- `IID_IDirect3DDevice3`  = `{B0AB3B60-...}` → `0xB0AB3B60`
- `IID_IDirect3DDevice7`  = `{F5049E79-...}` → `0xF5049E79`
- `IID_IDirect3DHALDevice` = `{84E63DE0-...}` → `0x84E63DE0` (device-type GUID, not interface GUID; used to request a HAL device from `CreateDevice`)
- `IID_IDirect3DRGBDevice` = `{A4665C60-...}` → `0xA4665C60` (software fallback — this is what we actually are)

When a game asks for `IID_IDirect3DHALDevice` during `CreateDevice`, we can either (a) return success and pretend to be HAL (MCM/MW3 don't really care about the distinction because they never query the caps in detail) or (b) return `DDERR_INVALIDPARAMS` and wait for them to fall back to RGB (safer). **Pick (a)** — most games don't have an RGB fallback path tested in modern times.

## Device creation flow

```c
// In game code:
IDirectDraw4 *ddraw;  // already exists in our impl
IDirect3D3  *d3d;     // via QI on ddraw
IDirect3DDevice3 *dev; // via d3d->CreateDevice(IID_IDirect3DHALDevice, ddsurf, &dev)
```

Our handlers:

1. `IDirectDraw::QueryInterface(IID_IDirect3D[2|3|7])`:
   - Allocate DX_OBJECT of a new type "D3D root" (reuse type 4 or similar; the DDraw and D3D roots can share a slot since they wrap the same underlying state).
   - Return ddraw pointer, AddRef.

2. `IDirect3D3::CreateDevice(refclsid, lpDDSurface, lplpD3DDevice, pUnkOuter)`:
   - Resolve `lpDDSurface` → DDSurface slot.
   - Allocate new DX_OBJECT of type 20 (IDirect3DDevice3 — but internally one kind of device object).
   - Allocate a 1 KB state block on guest heap; zero-init; set default render state defaults (CULLMODE=CW, ZENABLE=TRUE, LIGHTING=TRUE).
   - Write state ptr to DX_OBJECT slot.
   - Return device guest ptr; `eax = D3D_OK`.

3. `IDirect3DDevice3::SetRenderTarget(lpDDS, dwFlags)`:
   - Swap the render-target surface slot on the device.

## Viewport binding

Viewports are their own COM object but in practice the device keeps a "current viewport" slot:

```c
IDirect3DViewport3 *vp;
d3d->CreateViewport(&vp, NULL);
dev->AddViewport(vp);
dev->SetCurrentViewport(vp);
vp->SetViewport2(&D3DVIEWPORT2{...});
```

Our handler walks:
- `CreateViewport` → DX_OBJECT type 23, viewport-data block zero-init.
- `AddViewport` → store device slot on the viewport (parent back-pointer).
- `SetCurrentViewport` → stamp the viewport slot into the device's state block.
- `SetViewport2(pVP)` → memcpy the `D3DVIEWPORT2` struct into the viewport-data block. The rasterizer reads dwX/Y/Width/Height/dvScaleX/Y at draw time.
- `Clear`/`Clear2` → fill rectangle in the render-target DIB with the clear color, fill z-buffer with the clear z.

## Rasterizer core (Phase 2–3)

One new function: `$rasterize_triangle(dev_slot, v0_ptr, v1_ptr, v2_ptr)`.

Steps:
1. Read three screen-space vertices (already projected). Each is `(x, y, z, w, diffuse, u, v)`.
2. Sort by y so y0 ≤ y1 ≤ y2. Return early if all y's identical.
3. Compute edge deltas: `(x1-x0)/(y1-y0)`, `(x2-x0)/(y2-y0)`, `(x2-x1)/(y2-y1)`.
4. Scissor rect = viewport rect ∩ render-target rect.
5. Walk scanlines y=y0 to y2. For each scanline:
   - Determine left/right x (from edge walk).
   - Interpolate z, diffuse, u/v across the scanline.
   - Inner loop: per-pixel z-test against the z-buffer, sample texture (if bound), multiply by diffuse, write RGBA into the render-target DIB.
6. No SIMD, no asm — straight WAT i32/f32 ops.

16bpp rendertarget is the common case (MCM, D3DRM screensavers). 32bpp is easy. 8bpp paletted is **only** needed if a game does it — MW3 doesn't; MCM does not. Skip 8bpp rendertarget support unless blocked.

**Estimated throughput:** WAT scanline inner loop is maybe 5× slower than native. At 640×480 and ~20 kpix/frame of overdraw, that's ~10 ms/frame of raster work. Fine for 20–30 fps on modern hardware.

## Host imports

None. Rasterizer writes into guest DDraw surface DIBs; existing `host_dx_present` path takes it from there. The only addition is if we decide to accelerate rasterization in JS — *don't*, because the WAT→JS trap overhead kills throughput for small triangles. Keep everything in WAT.

## Comparison against d3drm.md

`d3drm.md` Level 2 already proposes a WAT software rasterizer for the D3DRM scene-graph case. **It's the same rasterizer.** Implementing IM Phase 2 means D3DRM Level 2 is half-done for free — you just need the scene-graph traversal layer on top.

So the strategic order is:
1. **Phase 0 IM plumbing** (replace E_FAIL stubs). Unblocks d3drm.dll init and MW3/MCM run-past-CreateDevice.
2. Decide: ship D3DRM Level 1 stub (in WAT) or load real d3drm.dll?
   - **Real DLL**: immediately frees up 2000 lines of RM stub work, but ties you to the DLL's IM usage patterns. A bug in our IM → every screensaver crashes the same way.
   - **WAT stub**: isolates risk; screensavers work "black" regardless of IM state; you still need IM for MCM/MW3.
3. **Phase 1 Execute walker**. Enables d3drm.dll to actually render whether we stub RM or not.
4. **Phase 2 rasterizer**. Now everyone actually draws.
5. **Phase 3 textures**. Cosmetic, but the difference between "recognisable" and "playable".

Recommendation: Phase 0 first (cheap, obvious win). Then commit to loading the real d3drm.dll and skip WAT RM entirely. The RM scene graph is 2000+ lines of bookkeeping that the real DLL already does correctly; replicating it in WAT is a tax without a reward once IM exists.

## Non-goals

- **DirectX 8 / D3D8+ interfaces.** No binary in our set needs them. `IDirect3D8`, `IDirect3DDevice8`, shaders, vertex declarations, pixel pipelines — all out of scope.
- **Hardware T&L.** We're software. Render state flags that request hardware features are ignored silently.
- **Multi-sample anti-aliasing.** Not in our rasterizer.
- **Stencil buffer.** Deferred.
- **Cubemaps / volume textures / mipmapping beyond level 0.**
- **Deferred scene hidden-surface-removal (e.g., tile-based).** Plain painter's algorithm + z-buffer is fine.

## Open questions

1. **Integer vs float z-buffer.** DX spec uses 16-bit or 24-bit fixed-point. We can either match (faster compare) or use 32-bit float internally (simpler, matches our per-vertex `1/w`). Prefer float; games don't read the z-buffer back in our test set.
2. **Color key in textures.** MCM uses color-keyed textures for the bike rider sprite. Texture fetch needs a `D3DRENDERSTATE_COLORKEYENABLE` path; otherwise transparent pixels come out as solid magenta. Cheap to add but easy to forget — flag it in Phase 3 tests.
3. **MFC42 interactions in MW3.** The MW3 demo links MFC42 and gets stuck very early (crashes before IM). Before IM is useful, MFC startup has to work. That's orthogonal but must land first.
4. **DX5 vs DX6 CreateDevice semantics.** DX5 `IDirect3D2::CreateDevice` takes a DDSurface as render-target; DX6 `IDirect3D3::CreateDevice` takes a `D3DDEVICEDESC` CLSID + surface. Handlers must accept both.
5. **d3dim.dll real DLL loading.** Analogous to the d3drm.dll feasibility study. `d3dim.dll` is a smaller, saner DLL (no CRT init, fewer imports). Worth one pass to see if loading the real DLL on top of our DDraw would be cheaper than WAT IM. **Initial guess: no** — the real d3dim.dll talks to a device driver interface (DDI) below, which we don't have. But worth confirming.

## File layout summary

- **New:** `src/09aa-handlers-d3dim.wat` — all IM handlers + state blocks + rasterizer (Phase 2 onward).
- **Edit:** `src/09a8-handlers-directx.wat` — replace E_FAIL stubs on IDirect3D/IDirect3D3; extend `init_dx_com_thunks` with the new IM vtables; bump `DX_MAX` if not already at 256.
- **Edit:** `tools/gen_api_table.js` — add ~310 virtual-method entries.
- **Regenerated:** `src/01b-api-hashes.generated.wat`, `src/api_table.json`, `src/09b2-dispatch-table.generated.wat`.
- **Edit:** `directx.md` — update the "non-goals" section; D3DIM has moved from "explicit non-goal" to "active phase 0".
- **Edit:** `d3drm.md` — once IM Phase 0 lands, add a note that the real `d3drm.dll` is the preferred implementation path (see "Real-DLL feasibility study" section in that doc).
- **New:** `test/binaries/SOURCES.md` already updated with MW3 + MCM paths (see `shareware/` section).

## Test plan

Smoke tests, in order of cost:

1. Run MCM and MW3 with Phase 0 stubs. Expected: both run past `CreateDevice`, reach `BeginScene`/`Execute`, and crash on the first "unknown method" (not yet stubbed). Add stubs until both reach their main message loop.
2. Run the 7 D3DRM screensavers with real `d3drm.dll`. Expected: DLL DllMain + `Direct3DRMCreate` succeed; scene loaded; runs black (Phase 0 = no rasterizer). Verify no heap leaks across a 60s run.
3. Phase 2: MCM main menu renders as flat-shaded polygons. MW3 HUD visible. D3DRM screensavers animate as flat-colored geometry.
4. Phase 3: textures visible on all three. Declare IM done.
