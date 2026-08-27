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

## CPU-feature checks and exact fault

Jazz genuinely changes its startup-selected code paths after testing CPUID bit
23. A normal full run retires millions of MMX instructions, while `--no-mmx`
retires zero. Those instructions are not themselves the source of the video
stripe. Main-thread handler histograms and a dump of the hot generated range
`0x010bcff4..0x010bd7e7` identify the dominant packed-instruction path as an
audio resampler/mixer. The independent packed-operation checks are green:

- `node tools/mmx-check.js --iters=2000` passes all 53 packed operations.
- An injected real-decoder qword copy passes aligned, unaligned, DIB-backed,
  and page-crossing MMX loads/stores.
- An injected copy of the 32-pixel interpolation sequence at `0x0045c2ce`
  produces the x86-defined unpack, shift, mask and store result.

These checks rule out a blanket error in one packed operation, qword alignment,
page crossing, or the known interpolation leaf. They also explain why a global
or Jazz-only MMX disable would have hidden the relevant startup choice instead
of fixing the emulator semantic.

The J2V update routine at `0x0045d8c5` copies decoded spans through the
function pointer at `0x004d2d74`. The CPU-feature setup at `0x00491394`
installs optimized copy routine `0x0049b26c`. Its 32-byte loop copies arbitrary
payload with this x87 sequence twice:

```text
FILD qword [source]
FILD qword [source+8]
FXCH st(1)
FISTP qword [target]
FISTP qword [target+8]
```

The emulator already retained an exact raw-i64 shadow for an unchanged
`FILD m64`/`FISTP m64` pair. `FXCH`, however, swapped the approximate f64
values with two calls to `fpu_set` and thereby cleared both raw shadows. Each
arbitrary payload was then rounded through f64's 53-bit significand. In the
captured constant video frame, `0x0a0a0a0a0a0a0a0a` consequently stored as
`0x0a0a0a0a0a0a0a00`: exactly one zero byte for every eight decoded pixels.

`src/06-fpu.wat` now moves the two raw shadows along with their values during
`FXCH`. The focused CPU regression reproduces the paired copy with two
different non-f64-exact qwords and verifies all 16 bytes after the swap and
stores. This is a generic x87 payload-preservation correction; it does not
change CPUID or special-case Jazz.

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

Before the x87 correction, the first corrupt matched upload was video ordinal
148, rect `[6,26,326,244]`. Its 320x200, top-down, stride-320 raw DIB has index
0 in every phase-0 column (`zero=1`, black palette entry) and index 10 in every
phase-1 through phase-7 column (`zero=0`, RGB `[6,7,9]`). The palette-expanded
source repeats the same pattern, and the 32-bpp target repeats it shifted to
screen phase 6 by the client offset. Therefore the eight-column corruption is
already present in canonical guest-written raw indices. Palette conversion,
`StretchBlt`, and browser composition do not create it. The diagnostic writes
`indices.png`, `source.png`, `target.png`, `result.json`,
`classification.json`, and `cli.log` under `scratch/jazz2-demo-web/`. The
opt-in command is now a regression gate: it fails if a periodic frame appears
before ordinal 148 or if ordinal 148 remains periodic at any of the three
layers.

## Verification and scalar limitation

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

The scalar ordinal has no period-eight stripe, but it is not the same animation
content merely because its filtered presentation count is also 148. With
audio and decoder throughput changed, its image statistics and timing differ
materially from the normal run. That A/B correlated the issue with the startup
CPU-feature choice; it did not on its own prove an instruction semantic. The
static copy-path disassembly, exact qword-loss arithmetic, and focused CPU
regression above provide that proof.

After the `FXCH` correction, a normal CPUID/MMX-enabled CLI run reached ordinal
148 while retiring 7,112,640 MMX instructions. All eight raw phases are now
index 10 with concentration 1, `zeroSpread=0`, and `meanSpread=0`. Source and
target RGBA both have luma 6.9, black fraction 0, `blackSpread=0`, and
`lumaSpread=0`. The exact post-fix artifacts are:

- `/private/tmp/jazz-fxch-fixed/indices.png`
- `/private/tmp/jazz-fxch-fixed/source.png`
- `/private/tmp/jazz-fxch-fixed/target.png`
- `/private/tmp/jazz-fxch-fixed/result.json`
- `/private/tmp/jazz-fxch-fixed.log`

The default production-path browser smoke still passes in about 4.2 seconds,
and the opt-in ordinal-148 gate passes in about 22 seconds. The CPU regression
reports `105 passed, 0 failed`; the normal build and WAT structural check also
pass. These results remove the reported logo stripe without disabling MMX. The
following correction closes the separate direct-level gameplay acceptance gap.

## Threaded Darn Ratz loading fix

The Worker route later appeared to stop on the fullscreen `Darn Ratz` loading
screen. A Worker-local EIP ring placed the last guest call at `0x0049c46a`, the
import site for a normal `TextOutA(hdc=0x0031005c, x=22, y=3, count=27)` call.
The Worker was monopolized inside the synchronous bitmap-font renderer.

The corrupt font originated in `SPI_GETNONCLIENTMETRICS`. Jazz initializes
`NONCLIENTMETRICSA.cbSize` to `0x154` but passes `uiParam=0`, as Win9x software
commonly did. `$spi_core` previously used `uiParam` as the only size, clearing
zero bytes and replacing `cbSize` with zero. Slash-filled stack data survived
in LOGFONT, including `lfWidth=0x2f2f2f2f` and an unterminated face. That width
wrapped through the font scaler and caused hundreds of millions of horizontal
glyph iterations for a 648x37 destination.

`$spi_core` now falls back to the incoming structure's `cbSize`, rejects
layouts smaller than the complete 340-byte ANSI or 500-byte Unicode Win98
structure, clears exactly the recognized layout, and preserves the declared
size. `$spi_write_logfont` also terminates its face explicitly. The focused
`test/test-system-parameters-info-nonclient.js` regression covers slash-filled
A/W buffers, tail canaries, undersized declarations, and explicit `uiParam`.

The final real-browser acceptance kept Threads enabled and used the registered
`Share1.j2l -nonetwork` route with Escape delivery. `Darn Ratz` was static from
seconds 58 through 66, changed into gameplay at second 68, and continued
producing distinct frames through second 90 while the app remained live.
Artifacts are `/private/tmp/jazz-loading-fixed/page-072.png` and
`/private/tmp/jazz-loading-fixed/final.png`. Disabling Threads is no longer
required.
