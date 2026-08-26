# Jazz Jackrabbit 2 Shareware 1.23s

## Package and launch

The localhost-only dropdown mounts the installed payload from
`test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/` and
launches `jazz2.exe` with `Share1.j2l -nonetwork`. The direct level argument
avoids waiting through the long logo sequence during ordinary direct-route
tests; the executable still exercises its J2V/GDI setup while attempting that
route. As documented below, playable rendering has not yet been proven.

## Vertical-stripe report

The visible logo corruption is a strict eight-pixel pattern. In the existing
browser capture `/private/tmp/jazz2-local-dropdown.png`, column phase 0 is
99.9% black while the other seven phases contain the image. The existing
headless capture `/private/tmp/jazz2.png` has the same one-near-black-column-
per-eight fingerprint. This rules out a browser-only compositor or WebGL
failure.

J2V is not using the DirectDraw layer when this happens. The retained
`/private/tmp/jazz2-g.log` shows startup DirectDraw surfaces being locked,
flipped and released, followed by `CreateDIBSection` and repeated GDI
`StretchBlt` calls for the video. A diagnostic that reads `_dxFrameLayer`
therefore observes a stale or absent startup surface, not the corrupt frame.

The old MMX A/B was not comparable. The actual screenshot-producing logs are
`jazz2-d.log` for `jazz2.png` and `jazz2-e.log` for `jazz2-nommx.png`. Both ran
8,000 batches, but the faster MMX run reached 185 `StretchBlt` calls while the
scalar run reached only 131, so the screenshots are different animation
ordinals. They show that the scalar capture happens to be clean; they do not
by themselves prove that MMX caused the stripes.

## SIMD checks

Jazz genuinely selects an MMX decoder leaf after testing CPUID bit 23. The
full run retired 418,443 MMX instructions, while `--no-mmx` retired zero.
Current focused evidence does not identify a broken emulated instruction:

- `node tools/mmx-check.js --iters=2000` passes all 53 packed operations.
- An injected real-decoder qword copy passes aligned, unaligned, DIB-backed,
  and page-crossing MMX loads/stores.
- An injected copy of the 32-pixel interpolation sequence at `0x0045c2ce`
  produces the x86-defined unpack, shift, mask and store result.

These checks still matter after the matched capture below: they rule out a
simple blanket error in one packed operation, qword alignment, page crossing,
or the known interpolation leaf. They do not prove every instruction sequence
in the selected decoder path. Disabling MMX globally or only for Jazz would
hide the defect and discard the measured J2V speedup; it is not a proven fix.

## Matched-layer diagnostic

`test/test-jazz2-demo-web.js` installs its test-only hook before launch and
captures the canonical GDI path rather than DirectDraw. The hook runs
synchronously inside `gdi_surface_upload`, after `StretchBlt` updates the
target but before the guest can start decoding its next frame. At one exact
filtered video-presentation ordinal it saves:

- the live 8-bpp J2V DIB's raw index bytes and RGB palette metrics;
- that DIB converted to RGBA by `GdiSurface`;
- the 32-bpp target window surface produced by `StretchBlt`.

Raw indices, refreshed palette, source RGBA and target RGBA are measured in
that one synchronous call and therefore describe the same `StretchBlt`
presentation. Phase-by-eight luma/black metrics and raw-index mode
concentrations distinguish the remaining cases:

- periodic raw indices: guest decoder/output corruption;
- clean indices but periodic source RGBA: palette interpretation;
- clean source RGBA but periodic target: WAT `StretchBlt`/raster conversion;
- clean target but a striped page: browser composition.

The default run is deliberately a fast production-path smoke. It asserts the
registered arguments remain `Share1.j2l -nonetwork` and the production slice
remains 1,000, then measures the three 600x120 loading-splash uploads. A fresh
run completed in 4.2 seconds and all three matched raw/source/target layers
were clean. The direct-level production path intentionally skips the long logo
sequence, so this ordinary run never waits for corruption that it cannot
reach:

```bash
node test/test-jazz2-demo-web.js
```

That splash result is not a gameplay acceptance. A bounded CLI attempt using
the exact registered arguments, 100,000 blocks per batch and 500 batches
provided a 50-million-step execution budget, but finished at `0x004b6123`
with only one
live 640x480x8 primary DirectDraw surface (`colors=1`, sampled nonzero indices
`0/1850`). The saved canvas `/private/tmp/jazz-prod-fast-dx.png` is blank, and
`/private/tmp/jazz-prod-ddraw/` contains the same blank primary. The run did
open and replace several audio voices and toggle the game menu, but this is not
evidence that `Share1.j2l` reached playable episode rendering. Playability of
the direct-level route remains a separate acceptance gap.

To exercise the exact reported logo path, the opt-in diagnostic overrides only
the spawned test process's arguments to empty and runs the same hook under the
CLI host. It remains hard-bounded and is not the default `run-all` behavior:

```bash
JAZZ_STRIPE_DIAGNOSTIC=1 node test/test-jazz2-demo-web.js
```

The first corrupt matched upload is video ordinal 148, rect
`[6,26,326,244]`. Its 320x200, top-down, stride-320 raw DIB has index 0 in
every phase-0 column (`zero=1`, black palette entry) and index 10 in every
phase-1 through phase-7 column (`zero=0`, RGB `[6,7,9]`). The palette-expanded
source repeats the same pattern, and the 32-bpp target repeats it shifted to
screen phase 6 by the client offset. Therefore the eight-column corruption is
already present in canonical guest-written raw indices. Palette conversion,
`StretchBlt`, and browser composition do not create it. The diagnostic writes
`indices.png`, `source.png`, `target.png`, `result.json`,
`classification.json`, and `cli.log` under `scratch/jazz2-demo-web/`.

## Matched MMX/scalar result

`WA_JAZZ_CAPTURE_ORDINAL=148` makes the same prelaunch hook save a requested
video presentation even when it is clean. The exact scalar comparison was:

```bash
WA_JAZZ_CLI_HOOK=1 \
WA_JAZZ_LAYER_OUT=/private/tmp/jazz-layer-scalar \
WA_JAZZ_CAPTURE_ORDINAL=148 \
node -r ./test/test-jazz2-demo-web.js test/run.js \
  --app=jazz2_demo --args= --quiet-api --no-mmx \
  --batch-size=1000 --max-batches=900
```

At the same filtered video ordinal 148 and the same 320x218 presentation rect,
the scalar raw-index phase mean spread is only 1.14 with zero spread 0. Its
target black-fraction spread is 0.0024 and luma spread is 1.15; there is no
period-eight stripe. The run retired zero MMX instructions. In contrast, the
normal MMX-selected ordinal 148 has the exact raw phase-0/index-0 stripe above.
This assigns the failure to the guest decoder/output produced by the
MMX-selected path at a matched presentation ordinal, rather than to a later
render layer.

It does not yet identify a faulty emulator instruction or safe correction.
The independent 53-operation suite, qword alignment/page tests, and injected
`0x0045c2ce` sequence remain green. No runtime compatibility change was made;
a global or app-specific CPUID/MMX disable would be a workaround without the
required semantic localization.
