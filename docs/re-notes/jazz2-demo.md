# Jazz Jackrabbit 2 Shareware 1.23s

## Original installer

The source fixture is the unchanged 20,069,847-byte `J2swc123.exe`; installed
files remain local test material and are not a replacement distribution. The
emulated COMCTL32 `PropertySheetA` now builds the installer wizard from its
inline `PROPSHEETPAGEA` records and real dialog resources. Current validation
walks Welcome, DirectX Setup, Destination, Jazz Jackrabbit 2 Links, and Finish
Installation, selecting **No, continue without installing DirectX 5**.

Finish opens the original `Extracting Jazz Jackrabbit 2 Shareware` dialog,
creates `C:\\Games\\Jazz2Sw\\License.doc`, and reads its compressed member from
the installer. `PSN_WIZFINISH` returns through the modal continuation rather
than forcing the entire install through the property sheet's synchronous
notification helper. The original installer now completes through its own
`Installation Complete` dialog, exits with code 0, and writes all 53 payload
files and shortcuts. The saved completion capture is
`/private/tmp/jazz2-install-complete.png`; its VFS is
`/private/tmp/jazz2-installed-vfs/`.

The completed run used the CLI's frozen stdio controller and internal
`--max-seconds=180` guard. It remained parked while waiting for commands, then
finished extraction after an explicit `step 40000`; no external timeout or
archive bypass was involved. A subsequent gameplay gate launches
`C:\\Games\\Jazz2Sw\\jazz2.exe` directly from that saved installer output by
setting `JAZZ2_INSTALLED=/private/tmp/jazz2-installed-vfs/games/jazz2sw`. It
reached animated Darn Ratz gameplay in 31 seconds; two accepted frames had
181/180 sampled colors and 129,164 changed pixels. The visually inspected,
unobstructed gameplay capture is `/private/tmp/jazz2-installer-gameplay.png`.

Property-sheet Cancel currently returns the documented zero result directly.
Jazz's page procedure normally opens a confirmation MessageBox from
`PSN_QUERYCANCEL`; delivering that notification requires nested modal state,
while the current common-dialog pump deliberately stores one modal frame.

## Package and launch

The localhost-only dropdown mounts the installed payload from
`test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/` and
launches `jazz2.exe` with `Share1.j2l -nonetwork`. The direct level argument
does **not** avoid the shareware logo sequence in this 1.23s executable. It
plays `Logolq.j2v`, `GODlq.j2v`, and `IntroLQ.j2v` before acting on the
remaining startup state. As documented below, the resulting movie path is
rendered and no longer striped, and the Worker path now reaches animated
`Darn Ratz` demo gameplay.

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

The default run is deliberately a fast production-launch smoke. It asserts the
registered arguments remain `Share1.j2l -nonetwork` and the production slice
remains 1,000, then measures the three 600x120 loading-splash uploads. A fresh
run completed in 4.2 seconds and all three matched raw/source/target layers
were clean. This gate exits before the long logo sequence; it does not assert
that the level argument has been consumed:

```bash
node test/test-jazz2-demo-web.js
```

That splash result alone is not a gameplay acceptance. An earlier bounded CLI attempt using
the exact registered arguments, 100,000 blocks per batch and 500 batches
provided a 50-million-step execution budget, but finished at `0x004b6123`
with only one
live 640x480x8 primary DirectDraw surface (`colors=1`, sampled nonzero indices
`0/1850`). The saved canvas `/private/tmp/jazz-prod-fast-dx.png` is blank, and
`/private/tmp/jazz-prod-ddraw/` contains the same blank primary. The run did
open and replace several audio voices and toggle the game menu, but this is not
evidence that `Share1.j2l` reached playable episode rendering. The later
Worker acceptance under "Threaded Darn Ratz loading" closes that gap.

## Fullscreen low-resolution movies

The small decorated 320x200 movie window was not caused by an absent installer
configuration. Jazz's startup selector is byte `0x004f8a6c`: command-line
parser `0x0048ad07` assigns 1 for `-windowed` and 2 for `-fullscreen`; without
an override, `0x0048e141` reads REG_DWORD `Last VideoMode` from
`HKCU\Software\Epic MegaGames\Jazz Jackrabbit 2\1.23\System`. Values 0, 1 and
2 mean "Any compatible mode", "Any windowed mode" and "Any fullscreen mode"
respectively. `VideoSize` values `Width`, `Height` and `BPP` are independent of
that selector.

Disposable registry A/Bs made the distinction exact. Seeding `Last VideoMode`
to 2, or seeding only `VideoSize=640x480x8`, both entered exclusive 640x480x8
at startup. Both later restored the decorated window for `Logolq.j2v` before
the DirectDraw mode-table correction. `uninst.j2` lists `Jazz2.cfg`, logs,
scores, saves and registry trees as uninstall cleanup targets, but contains no
`Last VideoMode` or `-fullscreen` default; those records do not prove that the
installer supplied a missing mode preference.

The real branch is the executable's performance fallback. The one-time
`Intro.j2v` benchmark returns at `0x0045d2d8`; an exact run returned 1, which
the code doubles to a measured 2 FPS. The comparison at `0x0045d2df` selects
low-resolution movies when that doubled result is below 25. `Logolq.j2v` is
320x200x8, whereas `Logo.j2v` is 640x480x8. When the requested exact mode fails,
the movie setup at `0x0045d5ef` clears the descriptor's selector byte and
retries with "Any compatible mode". Jazz itself advertises a 320x200 Window
(DIB) candidate; the emulator previously enumerated fullscreen DirectDraw
modes only from 640x480 upward, so the retry necessarily selected the decorated
window even when `Last VideoMode=2`.

`IDirectDraw::EnumDisplayModes` now appends exactly one 320x200x8 entry after
the existing 18 modes. It does not reorder ordinary resolution menus or invent
16/32-bpp low-resolution variants. On the exact registered
`Share1.j2l -nonetwork` route, the same low-resolution benchmark path now keeps
WS_POPUP/exstyle 8, remains in exclusive cooperative mode, and calls
`SetDisplayMode(320,200,8)` instead of restoring the overlapped window. The
bounded rendered capture is `/private/tmp/jazz-ddraw-320-exclusive.png`.
Focused enumeration, build, broad DirectDraw unit gates, and the default Jazz
browser matched-layer smoke pass. Normal cooperative-level restoration remains
covered by the generic DirectDraw regression. The later Worker acceptance
proves that the requested level eventually opens.

## Production route diagnosis

Post-FXCH captures correct the earlier description of the blank direct route.
The final DirectDraw primary can remain blank while the active cinematic is
drawn through a separate 8-bpp DIB, `StretchBlt`, and the GDI window surface.
`/private/tmp/jazz-direct-baseline.png` is a visible, animated checkerboard and
orange-ball logo from an exact `Share1.j2l -nonetwork` launch. Thus the blank
primary was a layer-selection error in the diagnostic, not proof that the
application failed to render.

At this checkpoint the requested level still had not opened. A 140-second, 3,600-batch exact run
read the low-quality logo/Gathering/intro movie sequence, then returned to menu
setup without a `share1.j2l` read. A shorter-slice follow-up also remained in
`GODlq.j2v` after 60 seconds; keeping Escape asserted through DirectInput did
not skip the decoder. Reordering the two registered arguments made no
difference. A diagnostic `-SERVER Share1.j2l -windowed` launch skipped the
movies but correctly reached Jazz's own `Network Error / Could not start
Server` screen rather than a level (`/private/tmp/jazz-server-diagnostic.png`).

The missing interactive skip was a generic keyboard-hook gap, not DirectInput.
Jazz installs a `WH_KEYBOARD` hook at `0x0048d2b0`; it records held keys in the
byte table at `0x00607760 + VK` and queues key events for the movie controller.
The emulator previously returned a successful handle from `SetWindowsHookExA`
for hook type 2 without ever invoking the guest hook, so Escape could not enter
Jazz's private key state. `GetMessage` and `PeekMessage` now call the hook for
keyboard and system-key messages through a typed continuation. The focused
`test/test-keyboard-hook.js` regression executes a real x86 hook and proves
`HC_ACTION`, `VK_ESCAPE`, the original `lParam`, preserved `MSG`, and the API's
own return value. Stock behavior checks Escape in the roughly 250 ms gap after
each J2V clip: the clip currently playing finishes, then the remaining intro
sequence is skipped.

This behavior is consistent with the stock 1.23s executable, not an identified
emulator semantic. Its command parser recognizes `-nonetwork`, and its embedded
usage text advertises `[Levelname[.j2l]]`, but the executable contains no
`-menu` switch. The [JJ2+ release
notes](https://jj2.plus/system.php) explicitly describe removing code that
prevented official levels from being launched from the command line. No safe,
generic runtime correction follows from the current evidence, so the registry
arguments have not been papered over and no CPUID or app-specific workaround
has been added. The registered route now reaches gameplay after the separate
NONCLIENTMETRICS correction below.

### Threaded Darn Ratz loading fix

After `WH_KEYBOARD` delivery made Escape functional, the Worker route reached
the fullscreen `Darn Ratz` loading screen but appeared to stop there. An exact
Worker-local EIP ring placed the last guest call at `0x0049c46a`, the import
site for `TextOutA`. Worker-local import capture showed a normal call:
`hdc=0x0031005c`, `x=22`, `y=3`, and `count=27`. This was neither Worker
teardown nor a truncated `share1.j2l` read; the Worker was monopolized inside
the synchronous WAT bitmap-font renderer.

The corrupt font originated in `SPI_GETNONCLIENTMETRICS`. Jazz initializes
`NONCLIENTMETRICSA.cbSize` to `0x154` but, as Win9x software commonly did,
passes `uiParam=0`. `$spi_core` previously treated `uiParam` as the only size:
it cleared zero bytes and replaced `cbSize` with zero before writing selected
fields. Jazz's slash-filled stack therefore survived in every unspecified
LOGFONT member. The captured message font had `lfHeight=-11` but
`lfWidth=0x2f2f2f2f`, italic and pitch/family bytes derived from the same fill,
and an unterminated `MS Sans Serif` face.

That stale width entered `$gdi_bitmap_font_width_height_dc`; its intermediate
32-bit multiply wrapped and was then consumed as an unsigned scale. A normal
27-character `TextOutA` consequently attempted hundreds of millions of
horizontal glyph pixels even though the destination surface was only 648x37.
The apparent Worker-only failure was timing: the long synchronous call held one
Worker slice while the cooperative path happened to progress under a different
observation window.

`$spi_core` now falls back to the incoming structure's `cbSize` when
`uiParam=0`, rejects layouts smaller than the complete 340-byte ANSI or
500-byte Unicode Win98 structure, clears exactly the recognized layout, and
preserves the declared `cbSize`. `$spi_write_logfont` also writes its own face
terminator instead of depending on prior buffer contents. The focused
`test/test-system-parameters-info-nonclient.js` regression starts both A and W
buffers with `0x2f`, exercises the zero-`uiParam` contract, checks every
LOGFONT width/italic/terminator, verifies tail canaries, and covers undersized
and explicit-`uiParam` calls.

The final real-browser acceptance kept **Threads** enabled and used the exact
registered `Share1.j2l -nonetwork` route with Escape delivery. `Darn Ratz` was
static from seconds 58 through 66, changed into gameplay at second 68, and
continued producing distinct animated frames through second 90 while the app
remained live. `/private/tmp/jazz-loading-fixed/final.png` shows the rendered
level and `/private/tmp/jazz-loading-fixed/page-072.png` shows a different
gameplay frame. Disabling Threads is no longer required.

To exercise the exact reported GDI logo layer, the opt-in diagnostic overrides
only the spawned test process with Jazz's own `-windowed` switch and runs the
same hook under the CLI host. Production remains exclusive; selecting windowed
here keeps the decoder DIB and matched `StretchBlt` target synchronously
observable after the generic 320x200x8 DirectDraw mode was added. The diagnostic
remains hard-bounded and is not the default `run-all` behavior:

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
historical capture remains the exact corruption attribution. After fullscreen
320x200x8 support moved production movies off this observable GDI target, the
opt-in command became a windowed matched-layer smoke at ordinal 120: it fails
if a periodic frame appears before that point or if ordinal 120 is periodic at
any of the three layers. The focused x87 regression, rather than a different
animation ordinal, remains the exact semantic gate for the FXCH defect.

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
pass. These results remove the reported logo stripe without disabling MMX.
The later NONCLIENTMETRICS correction and Worker browser acceptance close the
separate direct-level gameplay gap described above.
