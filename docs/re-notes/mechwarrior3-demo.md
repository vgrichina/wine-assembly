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
row with four source-alpha cases. H436 samples its structural head/tail and
hashes the complete 173-byte body, derives its pixel count from the guest
frame's `[ebp-0x18]` bound, and publishes x86 state at each safety chunk. Its
emitted back/fall operands come from the matched location rather than those
demo VAs, so an identical loop in a differently linked build is recognized.
The `mw3` manifest alone enables the existing copy-superop gate; default
behavior for every other app is unchanged. `test/test-mw3-rgb565-alpha-run.js`
compares ordinary and fused execution over all alpha arms, bounds, flags,
registers, a relocated authentic body, and a one-byte near miss.

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
textured/lit scene (minor scheduler-dependent HUD pixels may differ). The gate separately rejects cyan,
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
HUD geometry in both cooperative and real-Worker modes. The later
perspective/sampler correction below supersedes the digest recorded by this
intermediate fix.

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

## Perspective, UV-set, and sampler-state parity (2026-08-29)

The stride correction above was necessary but not sufficient: its statement
that the first texture set is always preserved was wrong for MW3. A live
Device3 state trace showed stage 0 changing `D3DTSS_TEXCOORDINDEX` among 0, 1,
and 2 while submitting `FVF=0x3c4`. The generic packer advanced over all three
sets but copied only set 0 into the canonical TL vertex, so detail and light-map
passes sampled their base-texture UVs. Device state also discarded every stage
state above type 7; MW3's `ADDRESSU/V` wrap/clamp and point/linear filter
changes therefore never reached the sampler.

The same capture found visible-triangle RHW values from roughly 0.00069 to
0.0107, over a 15x range. The scan converter linearly interpolated raw U/V,
which is only valid when RHW is constant. It now carries `u*rhw`, `v*rhw`, and
`rhw` across edges and spans, then divides at the pixel. Near-plane clipping
also interpolates colour, specular, and UV attributes instead of copying the
first endpoint. Stage 0 stores and consumes coordinate selection, wrap/mirror/
clamp addressing, and point/linear filtering. `COLOROP`/`ALPHAOP` now honor the
observed `SELECTARG1` and `MODULATE` transitions rather than always modulating.

`test/test-d3dim-indexed-texture.js` isolates each rule with the exact TEX3 FVF:
set 1 selects blue rather than UV0 red, set 2 at V=1 clamps to yellow rather
than wrapping to green, a centre linear sample averages all four texels, and a
high-RHW triangle pixel stays red where affine interpolation selects green. It
retains the ARGB4444, framebuffer-blend, alpha, and attached reversed-Z checks.

The accepted 640x480 CLI gameplay captures now comfortably clear the texture
detail gates with zero cyan/magenta corruption; representative late Worker
captures measured 2,310–2,331 exact colours and 139–141 terrain bins. Their
sky, terrain, cockpit, and HUD are visually coherent.
Worker timing can leave the operation-map button inactive at an early scripted
click, so the acceptance route no longer guesses fixed transition batches. It
waits for the operation map's measured near-black-pixel range before clicking,
then waits for the cockpit's distinct >100k-dark-pixel range before capture.

The then-labelled batches-840..1080 CPU-profile window fell from 12.27 seconds
sampled before these corrections to 8.40 seconds after them (31.6%). The current
profile spends 69.3% in WebAssembly; the largest renderer function is the
textured span at 567 ms (6.8% total), followed by texture decode (290 ms),
colour interpolation (288 ms), FVF packing (201 ms), texel fetch (197 ms), and
addressing (142 ms). Presentation `drawImage`/`putImageData` totals about
0.93 seconds, while API-name logging alone costs 0.58 seconds even in the CLI;
the browser Runtime log should remain off when measuring gameplay FPS.

SIMD does help the one contiguous operation the profile identified: MW3's hot
0x3c4 pack now copies the 24-byte position/colour/specular header with one
`v128` load/store plus one `i64` load/store, then copies the selected UV pair.
It does not solve the dominant sampler because WebAssembly still has no gather;
four-way filtering requires four scalar, format-aware texel fetches. Further
SIMD work belongs behind a new profile rather than changing fixed-function
results for a speculative vector fast path.

## Relative mouse clip edge and current cost split (2026-08-29)

MW3 hides the Win32 cursor and consumes relative DirectInput motion for its
software cursor. Pointer-lock events were first applied to the emulator's
virtual Win32 cursor and clipped to `ClipCursor`; the DirectInput delta was then
derived from that already-clipped position. Once the virtual cursor touched an
edge, motion farther toward the edge became zero even though a physical mouse
still reported movement. This is incorrect for any game which applies its own
sensitivity or keeps an independently bounded software cursor.

Relative input now converts the raw browser delta through the active native
presentation scale, retains fractional native movement between events, and
feeds that unbounded value to DirectInput. Ordinary `WM_MOUSEMOVE` and the
emulator's visible cursor remain clipped as Win32 requires. The focused
`test/test-relative-mouse-clip-edge.js` covers both the logical 2x transform and
the separate physical presentation viewport used by sharp/FSR scaling. A CLI
MW3 capture also clarifies that the yellow cursor ring's centre stopping about
nine pixels below the top is game behavior: MW3 keeps the complete roughly
18-pixel sprite visible. It is not evidence that raw DirectInput motion stopped.

The mixed deploy/early-game profile above remains useful for locating renderer
cost, but the measurements below supersede its description as representative
steady gameplay: the deterministic cockpit predicate did not match until batch
891. WebAssembly accounts for 69.3% of that sampled 8.40-second window. The six
largest named software-D3D functions total about 1.69 seconds (20.1% of the
whole window); presentation is about 0.93 seconds (11.1%), and API-name logging
is 0.58 seconds (6.9%). These categories are not a complete partition and the
sample crosses deployment, so they are ceilings and ordering evidence, not a
steady-state FPS attribution. Keep Runtime log off for play and measurement.
The existing SIMD header copy addresses the hot contiguous FVF operation; the
format-aware sampler remains gather-bound, so more SIMD is not an
evidence-backed next optimization.

## Measured x86 loops and render-Worker feasibility (2026-08-29)

### Measurement boundary and authentic CRT execution

The first hot-block pass armed at batch 840 because the cockpit had appeared in
an earlier fixed-timing run. The state-driven route used here did not satisfy
the cockpit's measured dark-pixel predicate until batch 891. Consequently the
840..1080 result is a deploy/load plus early-game sample, not a steady-gameplay
sample. Wall-clock time was also unusable while the development host was
saturated, so the results below use deterministic guest batches, basic-block
entries, API-call deltas, and DirectDraw `Flip` counts only.

Wine-Assembly is executing the shipped x86 `MSVCRT.DLL`, not a WAT replacement.
It is loaded at `0x01808000` from original base `0x78000000`; exported `free` is
`0x7800138a` and `malloc` is `0x78001498`. In the mixed 840..1080 window, exactly
48,000,000 x86 basic-block entries were recorded. Six MSVCRT blocks accounted
for 47,997,521 (99.995%):

| Runtime EIP | Original EIP | Entries | Share | Static role |
|---|---:|---:|---:|---|
| `0x018093fb` | `0x780013fb` | 14,282,161 | 29.75% | compare freed pointer with small-block descriptor start |
| `0x0180943d` | `0x7800143d` | 14,282,161 | 29.75% | advance the circular descriptor list |
| `0x01809400` | `0x78001400` | 14,282,159 | 29.75% | compare freed pointer with descriptor end |
| `0x018092af` | `0x780012af` | 4,120,831 | 8.59% | scan zero bytes in a small-block page's run map |
| `0x018091d2` | `0x780011d2` | 515,105 | 1.07% | test a small-block page-range descriptor |
| `0x0180920c` | `0x7800120c` | 515,104 | 1.07% | advance descriptor and corresponding 4 KiB page |

This is a distribution of emulated x86 block entries, not a distribution of
wall time. Native-Wasm D3DIM raster functions run synchronously inside an API
handler and do not appear as x86 blocks, so “99.995% of x86 blocks” must not be
read as “99.995% of total CPU.”

The `free` ownership walk is not a corrupt circular list. Live memory showed the
relocated sentinel at `0x01845178`, its next descriptor at `0x041d863c`, and a
second descriptor at `0x0440b804`; successive frees of `0x4f591770` and
`0x4f591760` reached an owner and returned. A shadow call stack resolved the
path as MSVCRT helper `0x780013f2` -> `free` -> EXE `0x00483110` (a small
`if (*p) free(*p)` destructor) -> EXE `0x004b98b0`, reached from the game's
`0x00559dxx` update loop. The high count is many temporary-object frees, not one
infinite list traversal.

The later byte-run scan initially looked more concerning, but a memory trace
disproved that interpretation. A histogram armed only after the first accepted
cockpit frame stopped at `0x780012af` when the diagnostic same-EIP watchdog saw
eleven full batches end there. It had recorded 2,369,615 entries at that byte
scan (69.67% of recorded blocks), plus 515,105 and 515,104 at the two page-range
blocks. Moving the arm point to batch 930 reproduced the distribution. Those
are aggregate *block entries across many allocations*, however, not one scan
advancing through millions of bytes. The watchdog compared only EIP across
batch boundaries and ignored the changing `EAX`/`ECX` loop progress.

At the first traced post-cockpit entry (batch 904), the authentic CRT state was
coherent: page base `EDI=0x4f586000`, run-map cursor `ESI=0x4f58604d`, scan
cursor `EAX=0x4f58604e`, requested run `EDX=0x1e`, and the next real nonzero
run marker (`0xff`) was at `0x4f58607b`. This individual search crossed only 46
zero bytes, remained inside the page's 248-byte run map, and then took the
normal successor. `EBP=0x4f58606b` was `ESI+EDX`, the prospective requested-run
end used by the outer algorithm, not the end of mapped metadata. There is no
evidence here of an x86 semantic error, overwritten heap metadata, a missing
sentinel, or an infinite CRT loop. The earlier “millions of zero bytes” claim
was a profiling-unit error and must not be used as a correctness diagnosis.

There was a separate real loader bug. `initMsvcrtGlobals` intended to disable
the authentic small-block heap, but recognized only a private implementation
starting `55 8b ec a1` and then wrote a guessed `__active_heap` address. MW3's
Win98 `MSVCRT.DLL` exports `_set_sbh_threshold` at `0x78018512` with body
`8b 44 24 04 ... a3 68 d1 03 78`; its live threshold was `0x1e0` at runtime
address `0x01845168`. The private byte pattern therefore silently matched
nothing. The loader now resolves and calls the authentic public export as
`_set_sbh_threshold(0)` after DLL initialization. This is the CRT-supported
operation: future small allocations use its HeapAlloc path, while any SBH pages
created during `DllMain` remain registered so later `free` calls can still
recognize their owners.

With that call active, the same 892..950 post-cockpit histogram contains none
of `0x780012af`, `0x780011d2`, or `0x7800120c`; its leading handlers are the
game's FPU-heavy transform work and its leading MSVCRT block is only 2.63%.
Both cooperative and real-Worker routes still match the textured-cockpit visual
predicate (133,341 dark pixels). A same-host fixed-950-batch A/B took about
59.5 seconds with the ineffective patch and 57.0 seconds through the public
threshold call, but this approximately 4% wall difference is directional only:
fixed batches do not represent fixed work and host load is uncontrolled. At
batch 950 the new path had issued 279,589 `HeapAlloc` and 44,131 `HeapFree`
calls, so eliminating the emulated SBH search exposes API/thunk and WAT-native
heap cost rather than making allocation free. Further allocator optimization
must profile that path directly; SIMD for `0x780012af` is no longer justified
as an MW3 correctness fix.

A wholesale WAT-native `malloc/free` interposition is not a safe shortcut.
MSVCRT, MSVCP50, MFC42, and the EXE exchange allocator-owned pointers, while
direct calls inside each authentic DLL bypass the EXE import table. Replacing
only imported `malloc/free` would create two incompatible heaps. Replacing the
complete allocation family would also need `calloc`, `realloc`, C++ new/delete,
small-block ownership, locking, and every internal direct-call edge. Calling
the CRT's own threshold API is different: authentic MSVCRT still owns the
allocation contract and deliberately selects its existing HeapAlloc fallback.
If its SBH is ever retained for performance, an exact decode-time fold of a
verified CRT loop remains lower risk than interposition: it continues to read
and update MSVCRT's structures and resumes at the authentic x86 successor with
identical registers and flags. The existing `$fast_msvc_sbh_scan` is precedent,
not a solution to these addresses: it recognizes one exact descriptor/range
shape and does not replace CRT allocation generally.

### Command mix after the first accepted cockpit frame

These command counts were collected before the public threshold-call fix, while
the loader's ineffective private-pattern patch still left SBH enabled. They
remain useful as a per-present render-command mix; fixed-batch totals before and
after changing allocator code must not be compared as equal gameplay work.

Three otherwise identical no-threads runs ended at batches 830, 892, and 950.
The cockpit predicate matched at batch 891. Subtracting the batch-892 census
from batch 950 isolates 58 batches in which the guest executed 20
`IDirectDrawSurface::Flip` calls. Counts are deterministic; no wall-clock FPS is
inferred.

| API | At 830 | At 892 | At 950 | Post-cockpit delta | Per `Flip` | Worker treatment |
|---|---:|---:|---:|---:|---:|---|
| `Device3::DrawPrimitive` | 20 | 1,037 | 16,041 | 15,004 | 750.20 | queue; own packed vertex payload |
| `Device3::SetTexture` | 20 | 1,037 | 16,041 | 15,004 | 750.20 | queue/coalesce surface id + generation |
| `SetTextureStageState` | 0 | 40 | 833 | 793 | 39.65 | queue/coalesce |
| `SetRenderState` | 131 | 194 | 782 | 588 | 29.40 | queue/coalesce |
| `BeginScene` / `EndScene` | 20 / 20 | 30 / 30 | 147 / 146 | 117 / 116 | 5.85 / 5.80 | ordered markers; no fence by themselves |
| Surface `Lock` / `Unlock` | 563 / 562 | 691 / 691 | 762 / 762 | 71 / 71 | 3.55 pairs | fence only conflicting surface users |
| Surface `Blt` | 489 | 492 | 517 | 25 | 1.25 | queue with read/write dependencies |
| Surface `Flip` | 494 | 503 | 523 | 20 | 1.00 | frame/presentation fence |
| `Texture2::Load` / `Release` | 24 / 24 | 141 / 141 | 168 / 168 | 27 / 27 | 1.35 / 1.35 | ordered copy; deferred destruction |

The state/draw rows contain 31,622 queueable calls, about 1,581 per `Flip`.
Calling `postMessage` or performing an RPC for each one would be worse than the
current direct WAT calls. A frame-sized shared command ring is plausible: it
amortizes wakeup overhead and has about 750 draws over which the game can build
the remainder of a frame while another core rasterizes earlier draws. The
unknown variable is vertex payload volume; `DrawPrimitive` supplies a borrowed
guest pointer today, so a prototype must measure packed bytes as well as calls.

### What Threads mode already does

In browser Threads mode, slot 0 (the guest main thread) already runs in a Web
Worker. D3DIM is WAT called synchronously by that instance, so software
rasterization is already off the browser UI thread. The browser thread serves
imports and composites completed surfaces. A dedicated render Worker would not
fix UI-thread blocking; its purpose would be to overlap the main guest's x86
simulation/command generation with native-Wasm raster work.

The existing renderer cannot simply be called concurrently from a second
instance. Render targets, depth buffers, textures, DX object records, and most
device state are in shared WebAssembly memory, which is promising. However,
lighting caches and several D3DIM control/debug values are mutable
per-instance globals, scratch vertices live inside the device state block, and
draw handlers currently consume guest pointers then free temporary packed FVF
buffers before returning. WebAssembly instances are not re-entrant across
Workers. The render side therefore needs an explicit command ABI rather than a
second caller entering the guest instance.

### Feasible command-stream design

Use one SharedArrayBuffer-backed single-producer/single-consumer ring per D3D
device. The guest Worker is the producer; a dedicated render Worker owns a
renderer-only instance over the same shared memory. Each packet has a sequence,
opcode, payload length, referenced surface slot plus generation, and read/write
surface sets. Publish the packet length/sequence with an atomic release store;
the consumer advances a completed sequence and wakes any targeted fence.

For MW3's measured path:

1. `SetTexture`, render state, texture-stage state, and scene markers are tiny
   ordered packets. The encoder may coalesce states that are overwritten before
   a draw, but the replay contract should first be proved without coalescing.
2. `DrawPrimitive` packs the selected FVF once directly into command-owned
   canonical vertices. The current Device3 path allocates a temporary packed
   buffer, draws from it synchronously, then frees it; enqueueing the borrowed
   pointer would be a use-after-free. Direct packing into ring payload avoids a
   second copy and gives the consumer immutable input.
3. Textures, render targets, and attached depth buffers remain in shared
   DirectDraw surface memory. A draw references stable slot/generation/CPU-epoch
   values rather than copying whole textures.
4. Track `lastReadSequence` and `lastWriteSequence` per surface. `Lock` waits
   only when CPU access conflicts with queued reads/writes of that surface;
   `Unlock` publishes a new CPU epoch used by later commands. `Blt` and
   `Texture::Load` carry source-read and destination-write dependencies.
5. `Flip` queues presentation after all writes to its front/back pair and waits
   for that sequence before returning/publishing. This is one mandatory fence
   per measured frame. `GetDC`, read locks, status/readback calls, and any API
   returning rendered pixels are also barriers.
6. A COM `Release` that reaches zero tombstones the slot/generation immediately
   but defers reuse and backing-memory reclamation until its last referenced
   sequence completes. This usually needs no producer stall.

The 71 measured lock pairs are an upper bound of 3.55 possible surface fences
per frame, not 3.55 guaranteed global stalls: locks of surfaces absent from the
queued dependency set proceed immediately. Instrument the surface ids before
predicting overlap. Conversely, `Flip` limits cross-frame queue depth, so the
expected gain comes from overlap within a frame, not from rendering arbitrarily
far ahead.

This is technically feasible but medium/high complexity. It does not reduce
total raster CPU and can regress on a two-core/mobile host. The earlier mixed
profile's 20.1% named-D3D share gives only a rough perfect-offload Amdahl ceiling
of `1 / (1 - 0.201) = 1.25x`; it is not a prediction because that sample crosses
deployment and excludes the newly exposed CRT pathology. Fix or explain the
allocator scan, then take a wall profile over verified moving frames before
committing to the Worker.

Implementation should be staged behind an opt-in:

1. Define packets and replay them synchronously on the current guest Worker.
   At every `Flip`, compare render-target/depth/texture state and the captured
   primary image with the direct-call path in both scheduler modes.
2. Add generation/lifetime and per-surface dependency tests for
   Draw -> Lock, Unlock -> Draw, Blt/Load ordering, attached depth, and Release
   before replay. No API may report successful completion while guest-visible
   output is still observably stale; this is the truthful-semantics boundary
   from `fable-review.md`.
3. Move the already-proven replay consumer to a dedicated Worker and batch one
   wakeup per filled chunk/frame, using the existing OpenGL command stream as a
   transport precedent rather than sharing its GL-specific command format.
4. Re-run the command/byte/barrier census and matched moving-frame wall profile.
   Keep the Worker only if overlap exceeds queue copies, atomics, and lost-core
   cost without changing the gameplay image.

### Settled-cockpit x86 profile and disassembly

The allocator investigation above measured the wrong phase before its scope was
corrected. The useful profile is a deterministic moving-cockpit interval: the
visual wait accepted the cockpit at batch 888, `W` went down at shifted batch
958, and handler/hot-block recording covered batches 1000 through 1100. All
four runs used the same no-threads route, 200,000-block slices, quiet API/block
logging, and the public `_set_sbh_threshold(0)` fix. These counts measure guest
threaded dispatch, not wall time or Direct3D raster cost.

| Gameplay build | Handler dispatches | Delta from prior | Delta from initial |
|---|---:|---:|---:|
| Authentic MSVCRT `_ftol`, ordinary x87 branches | 123,275,668 | — | — |
| WAT-native ABI-correct `_ftol` | 117,610,360 | -5,665,308 (-4.60%) | -4.60% |
| Native `_ftol` plus H439 x87 status-branch fusion | 111,232,878 | -6,377,482 (-5.42%) | -12,042,790 (-9.77%) |
| H439 plus browser-equivalent MW3 COPY opt-in | 104,827,560 | -6,405,318 (-5.76%) | -18,448,108 (-14.96%) |

The first three CLI profiles did not pass `--copy-superops`. That is a real
harness distinction: the browser reads `copySuperops: true` from MW3's app
manifest, while `test/run.js` deliberately requires its explicit CLI switch.
The fourth row uses the switch and therefore includes both exact MW3 lowerings,
H436 and H440. The 6,405,318 delta must not be attributed to H440 alone.

The first baseline's hottest block was runtime `0x0180cdc1`, the rebased body
of the authentic Win98 MSVCRT `_ftol` at original `0x78004dc1`. This is not an
allocator and its traffic is not startup residue:

```asm
78004dc1  push ebp
78004dc2  mov  ebp,esp
78004dc4  add  esp,-0xc
78004dc7  wait
78004dc8  fnstcw [ebp-2]
78004dcc  mov  ax,[ebp-2]
78004dd0  or   ah,0xc
78004dd3  mov  [ebp-4],ax
78004dd7  fldcw [ebp-4]
78004dda  fistp qword [ebp-0xc]
78004ddd  fldcw [ebp-2]
78004de0  mov  eax,[ebp-0xc]
78004de3  mov  edx,[ebp-8]
```

It is MSVC's signed-i64, truncate-toward-zero helper. The EXE has 489 static
call sites, but return-address attribution accounts for 435,868 of the 435,943
sampled calls and shows that four sites dominate:

| Call instruction | Calls | Purpose from surrounding disassembly |
|---|---:|---|
| `0x547a58` | 86,507 | scale and pack per-vertex alpha/intensity |
| `0x547c71` | 86,507 | scale first lit vertex color component |
| `0x547c83` | 86,507 | scale second lit vertex color component |
| `0x547c98` | 86,507 | scale third lit vertex color component |

Those four sites are 79.4% of `_ftol` calls. The surrounding `0x5479e0`
function walks the game's Direct3D vertex buffers, multiplies lighting values,
clamps or converts them, and packs 32-bit diffuse colors. Keeping authentic
`malloc/free` while routing only exported `_ftol` to native WAT is therefore a
sound acceleration boundary. The native handler must still pop ST(0), select
truncate rounding, produce the full signed result in EDX:EAX, restore the x87
control word, and remove only its return address. The prior native stub returned
only a saturated i32 and left stale EDX, so it was not safe to enable. Focused
coverage includes positive/negative truncation, a value above 32 bits,
NaN/infinity integer-indefinite, control-word restoration, and stack cleanup.

After native `_ftol`, the largest adjacent semantic pattern was the pre-P6 x87
condition sequence:

```asm
51bc38  fcomp  dword [0x5989d4]
51bc3e  fnstsw ax
51bc40  test   ah,0x41
51bc43  jne    0x51bc4d
```

The same shape repeats through `0x51bc31..0x51bce7` and the `0x5243xx` terrain
work. It is legitimate clamp/physics code: FCOM writes C0/C2/C3 in the x87
status word, FNSTSW copies them into AH, TEST selects the needed conditions,
and Jcc branches. In the native-`_ftol` profile, `H189 -> H217` alone occurred
3,133,484 times, followed primarily by JZ/JNZ. H439 now recognizes only the
exact contiguous byte sequence `DF E0 F6 C4 imm8 Jcc`, publishes the same AX,
TOP/status, byte-width TEST flags and EIP, and ends the block in one dispatch.
It executed 3,167,564 times in the follow-up window. Two dispatches saved per
execution predict 6,335,128 removed operations; the measured 6,377,482 delta is
within 0.04% of total work after normal frame-route variation. A focused short
and near-Jcc regression also proves that a `TEST AL` near miss stays ordinary.

The new top of the x86 profile is now mostly real application work:

| Block / handler | Count | Interpretation and next action |
|---|---:|---|
| H190 / H189 / H188 | 17,868,915 / 10,068,856 / 8,911,103 | scalar x87 memory/register operations; optimize only from repeated verified sequences, not a blanket float rewrite |
| `0x00528268` | 364,175 loop entries | RGB565 color-key row: load word, compare key, conditionally copy, advance; best next exact loop-fold candidate |
| `0x00528275` | 322,048 | tail of the same color-key loop |
| `0x00515a9c` | 169,503 | indexed 12-byte vec3 gather into contiguous scratch; control/index arithmetic dominates and Wasm SIMD has no general gather |
| `0x00528064` | 126,425 | exact MW3 RGB565 alpha-run lowering (active when the COPY opt-in is enabled) |
| `0x0051bf10` | 108,475 | scalar trig/table-lookup helper; possible exact fold, lower priority than the color-key row |

The `0x528268` candidate is especially clear:

```asm
528268  mov  cx,[eax]
52826b  cmp  cx,[ebp+0xc]       ; transparent color key
52826f  je   0x528275
528271  mov  [eax+ebx],cx
528275  add  eax,2
528278  dec  esi
528279  jne  0x528268
```

A bounded exact row super-op removes several dispatches per pixel without
changing DirectDraw ownership. It stays scalar because a destination store may
overlap a later source word; speculative multiword loads would change the x86
result. Recognizing the loop is the primary win even with scalar Wasm. The vec3
gather at `0x515a9c` is a weaker SIMD target
because each source is selected by an index and only the 12-byte copy is
contiguous. The broad x87 total likewise does not justify converting the whole
emulated stack to SIMD; its dependencies are scalar and compatibility requires
x87 status, rounding, NaN, and 80-bit-adjacent behavior. Exact sequences and
renderer spans remain the safer acceleration boundary.

### RGB565 color-key row lowering and corpus scope

H440 recognizes the complete verified 19-byte sequence at any guest VA, under
the same process-wide MW3 COPY opt-in as H436. The emitter derives and records
the loop's back/fall addresses from the matched location rather than embedding
the demo's `0x00528268`, so differently linked game builds can reuse it. It
loads the transparent RGB565 key from `[EBP+0x0c]`, takes the source cursor from
EAX, destination displacement from EBX, and count from ESI. The executor is a
scalar Wasm loop by design: every conditional store to `[EAX+EBX]` occurs
before the next `[EAX]` load, so forward-overlapping source/destination ranges
retain x86 read-after-write behavior. It also preserves ECX's upper half,
publishes ADD-then-DEC lazy flags in the original order (DEC retains ADD's CF),
and charges the guest instruction and two-block-per-pixel budgets.

`test/test-mw3-rgb565-colorkey-run.js` extracts the authentic bytes from the
pinned demo and compares H440 with ordinary x86 for transparent and copied
pixels, 1/8/37-pixel counts, disjoint storage, and both overlap directions. A
`dst = src + 2` case specifically fails any implementation which batches loads
before stores. The same authentic bytes are also injected at a second arbitrary
VA to prove recognition and control flow are address-independent. A valid
one-byte addressing near miss remains ordinary x86.

A static corpus scan checked 1,108 paths / 585 unique PE files in `binaries`
and `test/binaries` for both the exact bytes and a register-flexible structural
form (`load16; cmp16 key; conditional skip; store16; +2; counted back edge`).
Only `mech3demo.exe`, file offset `0x127668`, VA `0x00528268`, matched. This does
not mean color-key blitting is unique to MW3: the WAT-native DirectDraw
`BltFast` path already implements ordinary source color keys, so applications
using the API do not expose an equivalent guest x86 loop to this scan. H440 is
therefore intentionally an MW3-only fold, not a claimed corpus-wide primitive.

In the deterministic moving-cockpit interval, enabling the browser-equivalent
COPY gate removes both `0x00528268` and `0x00528275` from the hot-block list and
drops dispatch from 111,232,878 to 104,827,560. Fresh cooperative and real
guest-Worker captures with that gate are pixel-identical. Each measured 2,411
exact colors, 423 quantized colors, 128 terrain bins,
75,040 orange-sky pixels, 75,053 dark-cockpit pixels, and 2,936 green HUD
pixels, with zero cyan/magenta artifacts. The CLI gameplay acceptance now
passes `--copy-superops` so it tests the same opt-in arm as the browser.

### In-place terrain/grid filter lowering

The next target was selected from sampled CPU time rather than block count
alone. Corrected gameplay profiles put the interpreter's `$next`, register
accessors, branch return path, and `$g2w` address translation ahead of any one
software-D3D helper. The settled hot-block profile then identifies
`0x00518f02..0x00518f67` as the strongest loop which exercises all four: it
enters 116,300 times in the 100-batch interval and executes 37 x86 instructions
per cell.

The loop is an in-place 16-bit terrain/grid filter. Each trip performs twelve
loads and two stores across the current, upper, lower, and parity rows. Its one
guest `JNZ` backedge is predictable except at exit; the branch-pressure concern
is instead the threaded interpreter's changing `return_call_indirect` target
for each of the 37 handlers. Browser/Node V8 profiling on this macOS host does
not expose retired-branch or branch-miss hardware counters, so no
"mispredictions removed" number is claimed. Handler dispatch is the observable
proxy: H441 replaces those 37 changing indirect calls with one scalar Wasm loop
branch per cell and one handler entry per safety chunk.

H441 is gated by MW3's existing COPY opt-in and proves the complete authentic
101-byte body with a hash plus structural head/tail checks. It derives its
back/fall addresses from the matched location. The executor preserves the
original load/store order and ADD-then-DEC flags; vectorizing multiple cells is
not valid because a store from cell N can feed a neighbour load at cell N+1.
It reduces translation overhead without pretending memory traffic vanished:
the same twelve loads and two stores still occur, while adjacent word groups
use three affine-span translations plus the parity-byte translation instead of
up to fourteen separate guest-memory helper translations per cell. Stack
locals use one additional affine translation per safety chunk and are reloaded
in their original order, so intervening stores remain observable.

`test/test-mw3-grid-filter-run.js` extracts the pinned bytes and compares
ordinary and H441 execution for 1/8/37 cells, registers, flags, full memory, a
relocated body, and a valid one-byte near miss. Across those rows the ordinary
stream retires 1,705 handlers and H441 retires seven (one per safety chunk plus
the final returns). This is an isolated mechanism measurement, not an FPS
claim.

The matched settled-gameplay A/B is the useful whole-window result:

| Gameplay build | Handler dispatches | Delta |
|---|---:|---:|
| H439 + H436/H440 COPY opt-in | 104,827,560 | — |
| Same build + H441 grid filter | 100,531,476 | -4,296,084 (-4.10%) |

`0x00518f02` disappears from the hot-block list. The cooperative gameplay gate
still measures 2,411 exact colours, 423 quantized colours, 128 terrain bins,
75,040 orange-sky pixels, 75,053 dark-cockpit pixels, and 2,936 green HUD
pixels, with zero cyan/magenta corruption. Wall time and web FPS remain
unquoted because the shared host load exceeded the repository's measurement
threshold throughout this run.

This profile also bounds what x86-only work can accomplish. H439, the COPY row
folds, and H441 together reduce the initial matched gameplay window from
123,275,668 to 100,531,476 guest dispatches (-18.45%), but the earlier wall CPU
profile attributed a separate roughly 20.1% named share to D3DIM/software
rasterization. Both sides are material. A dedicated render Worker can overlap
them in Threads mode, as designed above, but does not reduce total raster CPU.
The highest remaining exact block entry is the MSVCRT `_ftol` import trampoline
at `0x005776a0`, followed by the vector gather at `0x00515a9c` and block
`0x00518f8c`; the next decision should come from a matched moving-frame wall
profile on a quiet host rather than another startup or fixed-batch timing claim.
