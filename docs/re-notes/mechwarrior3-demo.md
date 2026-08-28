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
it does not add shaders or change DirectDraw presentation. The focused
`test/test-d3dim-indexed-texture.js` builds an 8x8 render target, binds a
four-colour RGB565 texture, submits an indexed TL triangle through the real
Device3 handler, and verifies texture colours reach the target. Before the fix
the same test produces only white diffuse pixels; after it, three non-diffuse
texture colours are present.

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
