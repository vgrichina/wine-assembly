# MechWarrior 3 demo

## Binary and runtime layout

- App id: `mw3`
- EXE: `test/binaries/shareware/mw3/ex/Program_Files/mech3demo.exe`
- VC++ runtime: `test/binaries/shareware/mw3/ex/Shared_DLLs/MSVCP50.DLL`
- The EXE imports only two symbols from MSVCP50: the constructor and destructor
  for `std::_Lockit` (`??0_Lockit@std@@QAE@XZ` and
  `??1_Lockit@std@@QAE@XZ`).

## Browser `_Lockit` startup regression (2026-08-27)

The browser detected `msvcp50.dll` in the EXE import table but loaded only
`msvcrt.dll` and `mfc42.dll`, then trapped at EIP `0x0049daf0` on the unresolved
`std::_Lockit` constructor. The CLI did not reproduce the failure because its
DLL search includes the sibling `../Shared_DLLs` directory. A browser has no
directory search and can fetch an app-local DLL only when the app manifest
provides its URL.

The `mw3` manifest therefore carries the authentic `MSVCP50.DLL` as an explicit
`dlls` seed. This is deliberately app-local rather than a generic no-op API
stub: MSVCP50's real `DllMain`, imports, and lock implementation run, and no
other app opts into the runtime.

Focused verification:

```sh
node test/test-debug-dropdown-manifests.js
/opt/homebrew/bin/timeout -s KILL 90 node test/run.js --app=mw3 \
  --max-batches=3 --batch-size=100000 --quiet-api --quiet-blocks \
  --no-close --no-build
```

The boot run loads MSVCP50 first, patches the EXE's `MSVCP50.dll` imports to DLL
slot 0, completes all three runtime `DllMain` calls, loads `mech3msg.dll`, and
creates/shows the `MW3 Demo v0.183 build 1` window without an unimplemented API
trap.

## Browser resources and menu text

The demo's button captions are resources in `Mech3Msg.dll`, not literals in
the EXE. The browser manifest mounts that DLL explicitly so labels resolve to
the shipped Campaign, Training, Instant Action, Multi Player, Options, and Quit
strings.

MW3 measures those captions on a compatible memory DC before selecting a DIB.
`DrawText(DT_CALCRECT)` previously rejected that DC because it had no drawable
surface, leaving every measured `RECT` at zero and producing an empty caption
atlas. The GDI text path now permits font-only DC state for `DT_CALCRECT` while
ordinary drawing still requires a bitmap. `test/test-wat-gdi-calcrect-memory-dc.js`
covers both halves.

## Opt-in RGB565 alpha row

The authentic loop at EIP `0x00528064..0x00528111` composites a bounded RGB565
row with four source-alpha cases. H436 matches only that exact byte/signature
shape, derives its pixel count from the guest frame's `[ebp-0x18]` bound, and
publishes x86 state at each safety chunk. The `mw3` manifest alone enables the
existing copy-superop gate; default behavior for every other app is unchanged.
`test/test-mw3-rgb565-alpha-run.js` compares ordinary and fused execution over
all alpha arms, bounds, flags, registers, and a one-byte near miss.

Threads mode creates one WebAssembly instance per guest thread over shared
memory. The gate was originally a mutable WebAssembly global, so only the main
instance observed `copySuperops: true`; a worker decoding the compositor kept
the default-off path. `LOOP_PROCESS_STATE` now stores that process opt-in in an
atomic shared-memory word. The same regression instantiates two decoders over
one shared memory and proves opt-in and rollback are visible in both directions.

## Gameplay input

Pilot entry calls the five-argument USER32 `ToAscii`. The handler delegates to
the existing `ToAsciiEx` keyboard-state implementation and adjusts the stack
for the shorter signature. `test/test-to-ascii.js` checks lower/uppercase
translation and the exact stdcall ESP delta. With that API present, a pilot can
be created and the Instant Action flow remains live instead of trapping on the
first typed character.

## Indexed Direct3D texture loss (2026-08-27)

MW3 uses Direct3D 3's fixed-function immediate mode; programmable vertex and
pixel shaders do not exist in this API generation. The broken gameplay frame
showed valid projected/cullable world geometry and the intact 2D cockpit HUD,
but the world triangles carried only flat diffuse colours.

The software D3DIM bridge had two terminal triangle paths. `DrawPrimitive`
resolved stage 0 and sampled the bound DirectDraw surface, while
`DrawIndexedPrimitive` transformed the same TL vertex shape and then called
the flat rasterizer unconditionally. The latter bypass discarded `tu/tv` and
the live texture binding without failing the draw, which explains the very
specific geometry-present/textures-absent result.

Indexed triangles now enter the shared cull-and-maybe-texture helper used by
unindexed triangles. This is a fixed-function software-rasterizer correction;
it does not add shaders or change DirectDraw presentation.

That first regression was incomplete: it bound the DirectDraw surface through
the newer `IDirect3DDevice3::SetTexture` entry point. MW3's gameplay path uses
the legacy Direct3D sequence instead:

1. `IDirect3DTexture2::GetHandle` returns the surface's texture handle.
2. `IDirect3DDevice3::SetRenderState(D3DRENDERSTATE_TEXTUREHANDLE, handle)`
   makes that handle the active stage-0 texture.
3. `DrawIndexedPrimitive` submits the terrain.

Device2 and Device7 already routed `SetRenderState` through the common helper
that performs step 2. Device3 had a private copy which saved the render-state
dword but did not update the stage-0 binding. Its indexed draw therefore still
fell back to flat diffuse polygons in real MW3 even while the original
`SetTexture`-based test passed. Device3 now uses the same helper.

The textured rasterizer also used to discard the diffuse colour after lighting
and copy the sampled texel directly. It now Gouraud-interpolates diffuse RGB and
applies fixed-function stage-0 modulation, so lighting affects textured terrain
instead of being visible only on the flat fallback. The focused
`test/test-d3dim-indexed-texture.js` now exercises the authentic Texture2
handle → Device3 render state → indexed draw chain and verifies a half-intensity
diffuse colour modulates a four-colour RGB565 texture. The old Device3 handler
produces only white/empty target pixels; a raw-texture-only implementation also
fails the expected modulated-colour assertion.

## Operation-map false stall report (2026-08-28)

The debug popup formerly printed `Yield 9 = blocked EnterCriticalSection` as an
unconditional heading. On MW3's operation map that looked like a diagnosis even
though the row below it said `yield=0 (running)`. Live real-Worker sampling
confirmed no lock problem: main T1 had `csWaits=0`, `csWaitAddr=0`, and advanced
its slice counter while idling in the normal `PeekMessageA` pump at
`0x00559d62`; transition T2 advanced through distinct EIPs and exited cleanly.
The same isolated Threads route progressed from the map to the textured Instant
Action configuration screen.

The map is also an interactive campaign screen: its circular `Start` marker is
near the lower-left, and the separate debug popup can cover it. The popup now
prints an actual aggregate status such as `Status: no blocked guest threads` and
keeps yield 9 only as an explicitly labelled legend.

## Deterministic gameplay capture and fixed-function blending (2026-08-28)

`test/test-mw3-gameplay.js` drives the complete Instant Action route with
relative mouse input, creates a pilot, crosses the operation map, deploys, and
captures a 640x480 cockpit frame. It runs both the ordinary scheduler and the
real guest-worker Threads path. The local demo executable is pinned by SHA-256,
and a missing demo is reported as a skip rather than silently testing another
binary.

The catastrophic flat-frame repro measured only 135 exact colours, 89
four-bit-per-channel colours, and five colours in the terrain sample. The final
explicit-primary capture measures 2,053, 405, and 159 respectively, with separate minimums
for the orange lit sky, dark textured cockpit, and readable green HUD. This
makes the test reject a reachable-but-untextured game instead of treating any
gameplay-shaped frame as success.

The trace also showed textured draws using the legacy framebuffer blend state:
`ZERO/SRCCOLOR` for modulation and `SRCALPHA/INVSRCALPHA` for fades. The
software textured span now preserves interpolated vertex alpha, reads the
destination pixel, and applies those fixed-function blend factors before
writing RGB565. `test/test-d3dim-indexed-texture.js` pins the destination
modulation case independently of the proprietary demo.

Run the acceptance directly with:

```sh
node test/test-mw3-gameplay.js
```

The resulting CLI evidence is written to
`build/mw3-gameplay/no-threads.png` and
`build/mw3-gameplay/threads.png`. Both modes must produce the same measured
textured/lit frame and the same PNG digest. The gate separately rejects cyan,
magenta, and electric-blue texels characteristic of a pixel-format regression.
It explicitly captures DirectDraw slot 5, the primary/front surface; an
arbitrary snapshot of slot 6 can catch the back buffer midway through a frame
and is not valid evidence of a presentation defect.

## 16-bit texture format corruption and raster cost (2026-08-28)

The remaining cyan/green/purple scenery was not missing texture data. A live
surface census found common 16-bit words such as `0xF678`, `0xF334`, `0x0877`,
and `0x2877`. They are coherent grey texels in ARGB4444, but the sampler treated
every 16-bit DirectDraw surface as RGB565. The same defect affected
`Texture::Load`: equal bit counts triggered a raw copy even when source and
destination channel masks differed. `Lock`, `GetPixelFormat`, and
`GetSurfaceDesc` then compounded the error by reporting RGB565 regardless of
the format requested at creation.

DirectDraw now retains a normalized format kind per surface and reports the
original RGB/alpha masks. Sampling and `Texture::Load` support RGB565,
XRGB1555, ARGB1555, ARGB4444, XRGB8888, and ARGB8888, including alpha in the
fixed-function blend path. The focused indexed-texture regression proves an
opaque ARGB4444 `0xF678` texel renders grey and transparent `0x0877` preserves
the destination. In both scheduler modes the gameplay capture now contains
zero cyan and zero magenta artifact pixels.

The software rasterizer remains the valid acceleration path for D3D3: it runs
native WebAssembly against lockable DirectDraw surfaces and avoids emulating an
x86 pixel loop. The hot span used to reload immutable texture metadata for
every pixel and execute seven integer divisions plus a floating division per
pixel. Metadata is now hoisted per span, division by 255 uses an exact bounded
identity, the interpolation reciprocal is computed once, and MW3's two observed
blend pairs have direct paths. The complete no-threads menu-to-gameplay CLI run
dropped from 92.3 seconds to 60.3 seconds while retaining the accepted frame;
threads mode completes in 75.9 seconds and produces the identical PNG.

This is not a claim that all advertised legacy Direct3D capabilities are
implemented. `fill_primcaps` still reports broad comparison, filtering,
addressing, shading, and blend masks while the rasterizer implements a smaller
fixed-function subset, and several Device methods remain compatibility stubs.
That contradicts the truthful-semantics guidance in `fable-review.md`; future
work should narrow caps alongside implementing the corresponding render states.
For later Direct3D resource models where render targets are not CPU-lockable,
the correct extension is host-GPU resource/shader translation rather than
pretending those surfaces support the D3D3 memory contract.

## Attached depth and multi-texture FVF stride (2026-08-29)

The later cockpit repro had two independent correctness defects. First, every
triangle path was effectively submission ordered. MW3 creates a 16-bit
`DDSCAPS_ZBUFFER`, attaches it to the render target with
`AddAttachedSurface`, clears it to zero with `DDBLT_DEPTHFILL`, and selects
`D3DCMP_GREATEREQUAL`. DirectDraw discarded both creation caps and the
attachment relationship, while D3DIM used a private plane the application
could neither clear nor lock. Per-surface metadata now retains
`{creation caps,parent slot+1}`; D3DIM locates the real attached depth surface,
compares and writes its native 16/32-bit values, and honors `ZENABLE`,
`ZWRITEENABLE`, and all eight `ZFUNC` values. A full-surface zero Blt uses
WebAssembly bulk fill instead of 307,200 scalar stores.

Second, the remaining screen-sized diagonal sheet was not a matrix or Z
precision error. Live `IDirect3DDevice3::DrawPrimitive` calls used
`FVF=0x3c4`: `XYZRHW | DIFFUSE | SPECULAR | TEX3`. That descriptor has a
48-byte source stride. The Device3 handler recognized `XYZRHW` but passed the
source to the canonical 32-byte `D3DTLVERTEX` reader without repacking it.
Vertex 0 happened to be valid; subsequent vertices began in texture-coordinate
data and produced infinities and enormous coordinates. Device3 now shares the
FVF packer already used by Device7, preserving the first texture set while
advancing across all three sets. The focused indexed-texture regression uses
the exact `0x3c4` layout and would fail under the former 32-byte stepping.

The same regression attaches a real 16-bit Z surface and draws overlapping red
and green triangles. It proves a lower reversed-Z triangle is rejected, a
higher one passes, and the application-visible depth pixels are updated. The
deterministic primary capture now has coherent road, hills, cockpit, sky, and
HUD geometry in both cooperative and real-Worker modes; both PNGs have SHA-256
`f15852d55ab5e1e9cdb55aec37734707df3df735cfc8ed2276ac9edbf9bf7e25`.

The dark foreground is consistent with the submitted fixed-function state,
not evidence of a missing shader. MW3 selects stage-0
`MODULATE(TEXTURE,DIFFUSE)`, then uses `ZERO/SRCCOLOR` framebuffer passes for
light maps. Preserving those operations is required; replacing them with raw
texture copies makes the scene brighter but semantically wrong.

## Corrected renderer profile and SIMD assessment (2026-08-29)

On the same no-threads 1,000-batch route, the pre-fix CPU profile sampled
82.35 seconds: 64.10 seconds in WebAssembly, with textured triangle/span work
at 15.13 seconds (18.4% of total). Those numbers mostly measured pathological
overdraw from malformed 48-byte vertices, not the cost of the intended scene.
After FVF repacking and the depth-clear fast path, the profile sampled 33.65
seconds: 26.15 seconds in WebAssembly, while
`viewport_draw_textured_span` fell to 0.23 seconds (0.7%). The dominant costs
are now the x86 engine's `$next`, register accessors, and branch machinery;
canvas `drawImage`/`putImageData` are the largest host-side costs.

SIMD is therefore not the next useful MW3 renderer optimization. Texture
addresses differ per pixel and WebAssembly SIMD has no gather operation, so a
four-pixel sampler would still require scalar loads before any vector math.
Potential later SIMD candidates are four-wide depth comparisons, post-gather
modulation/blending, and RGB565 packing. They should be attempted only against
a representative profile; state-specialized scalar paths, incremental
interpolation, and bulk clears remain better first choices. This follows the
`fable-review.md` boundary: fixed-function logic and resource truth stay in
WAT, while JS remains a presentation/raster host rather than a second D3D
implementation.
