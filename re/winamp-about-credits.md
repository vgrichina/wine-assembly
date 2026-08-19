# Winamp About/Credits Rendering Notes

Focused notes for the real Winamp About dialog renderer in `winamp.exe`.
Addresses are static VAs in `test/binaries/winamp.exe` with image base
`0x400000`.

## Current Finding

The About/Credits tab is not DirectX. The animated Credits page is a mix of:

- a real CPU software texture/raster path that writes into guest bitmap memory;
- a GDI text-strip renderer that paints tiny glyph pieces into an offscreen DC;
- a final GDI `BitBlt` present into the About dialog.

The visible slowdown is dominated by the text-strip GDI path and worker
scheduling, not by bitmap decode or C runtime math. A profiled run to roughly
batch 502 produced:

| item | count / time | note |
| --- | ---: | --- |
| `BitBlt` API calls | 54,424 | most are tiny glyph/blank strip blits |
| `gdi_bitblt` host time | ~2,443 ms | average ~45 us/call |
| `gdi_draw_text` host time | ~396 ms | secondary |
| `GetDIBits` | 2 calls / ~1.4 ms | not the runtime bottleneck |
| `GetDIBColorTable` | 2 calls / ~0.05 ms | not the runtime bottleneck |
| `sin` / `pow` | ~1,100 each | under 1 ms host time total |

The main-thread batch profile showed `run_total ~= 2731 ms` and
`paint_total ~= 2488 ms`. This excludes part of the worker-thread cost, so the
web symptom can still look like a hang when the visible-window worker budget is
too low.

## Relevant Hooks Already Added

These are real algorithmic helpers, not fallback rendering:

| VA | helper | purpose |
| --- | --- | --- |
| `0x00402c47` | `winamp_credits_image_init` | resample Credits resource bitmap into texture memory |
| `0x00406740` | `winamp_credits_quantize_init` | build palette/shade lookup tables |
| `0x0040503d` | `winamp_credits_span_step` | accelerate the real inner pixel span loop |
| `0x00403b9b` | `winamp_credits_palette_search` | accelerate the real nearest-palette inner loop |

Do not reintroduce the old synthetic frame hook at `0x00402220`. That produced
fake stripes/logo output and bypassed Winamp's real renderer.

Also do not skip `0x00403af0`. That function is the real palette-map builder:
it frees/allocates `[obj+0x58]`, initializes `[obj+0x5c]` through `0x403a90`
when needed, and fills the lookup table used by the span renderer. A previous
shortcut returned from `0x403af0` immediately, which left `[obj+0x58]` empty and
made the Credits 3D background blit as mostly black pixels even though the text
strip still advanced.

## Bitmap / Texture Init

The Credits texture setup lives around `0x402b70..0x402cc5`.

Observed behavior:

- loads resource bitmap data;
- calls `GetDIBits` and `GetDIBColorTable`;
- selects/deletes temporary GDI objects;
- at `0x402c47`, resamples the source into a 256x256 texture.

Important resource from the binary:

| resource | dimensions | note |
| --- | --- | --- |
| `109` | `392x192`, 8 bpp | main Credits bitmap source |
| `126` | `275x116`, 8 bpp | secondary image asset |
| `248` | `100x64`, 8 bpp | unrelated Nullsoft Video-looking asset |

This path is not slow in host profiling. It is important for correctness, but it
is not the reason the Credits tab appears stuck.

## Palette / Shade Table Init

`0x406740..0x4068da` builds the lookup tables used by the software renderer.
The accelerated helper preserves the real computation and fills the same guest
tables used by the span loop.

The runtime API profile shows this is not a major wallclock cost. Host math
imports are negligible compared with the many small `BitBlt` operations.

The per-object palette map is separate and lives at `0x403af0..0x403c1a`.
Its hot loop at `0x403b9b` searches the palette for the nearest RGB entry and
writes the best index through the table pointer at `[obj+0x58]`. The helper for
`0x403b9b` must preserve the native loop semantics and continue at `0x403bea`,
where Winamp writes `[esi + [obj+0x58]] = bestIndex` and advances the outer
entry loop.

Verified after removing the `0x403af0` skip: Credits-page present blits changed
from sparse source DIBs to dense real scene frames. In one CLI run the Credits
source DIB rose to `120268..158992 / 163624` non-black pixels, with matching raw
guest DIB byte counts. Captured frames show the textured 3D tunnel/ring behind
the Credits tab instead of a black background.

## Software Rasterizer

Disassembly range: `0x404d40..0x405190`.

High-level structure:

- `0x404e47`: outer scan/triangle loop;
- `0x404f2e..0x404f50`: horizontal span length calculation;
- `0x404fb4`: row loop;
- `0x40503d`: hot inner pixel span loop;
- `0x405123..0x405174`: advance to next scanline;
- `0x40517a..0x405188`: epilogue.

The hot loop at `0x40503d` is a real textured/paletted span renderer:

1. clamp or derive a shade/depth index from stack state;
2. compute texture coordinate pieces from `ebp`, `edi`, and stack masks;
3. read one texel from the texture base;
4. combine texel plus shade through the precomputed table;
5. write the final byte to the destination pointer;
6. advance shade, `u`, `v`, and destination pointer.

The current `winamp_credits_span_step` helper targets this inner loop. This is
the right place for CPU-side emulation speedup of the actual 3D-ish Credits
effect.

## Text Strip / Credits Caption Renderer

Disassembly range: `0x40e600..0x40e7e4`.
The first bytes in that range are table/padding data; the executable renderer
body starts at `0x40e660`.

This is the more obvious runtime bottleneck in the API profile. It paints a
small animated text strip into offscreen DC `[0x44febc]` from glyph atlas DC
`[0x45001c]`, then presents that strip.

Entry behavior:

- initial destination x is `0x6f`;
- visible y is around `0x19..0x23`;
- if `[0x450658]` is set, it clips and clears the strip region:
  - `IntersectClipRect([0x44febc], 0x6f, 0x19, 0x108, 0x23)`;
  - select brush/object `[0x450004]`;
  - `Rectangle([0x44febc], 0x6c, 0x18, 0x10b, 0x25)`;
  - restore and clear clipping via `ExtSelectClipRgn`.

Main glyph loop at `0x40e704`:

- reads one byte from the text string;
- calls `0x40e080(char, &out1, &out2)` to decode glyph atlas coordinates;
- for visible characters, issues a `BitBlt`:
  - dst DC: `[0x44febc]`;
  - dst y: `0x1b`;
  - height: `6`;
  - width: usually up to `5`;
  - source DC: `[0x45001c]`;
  - ROP: `SRCCOPY`;
  - hot callsite: `0x40e761`.

Blank-fill loop at `0x40e797` / `0x40e7ba`:

- after the string ends, it fills the rest of the strip up to x `< 0x109`;
- each column is a separate `1x6` `BitBlt`;
- source is always `[0x45001c]` at source x `4`, source y `0`;
- this produced 48,312 sampled hits at `0x40e7ba` in one short run.

This blank tail is pathological for our host renderer. It can issue around 150
tiny `BitBlt`s per strip update, even when the visual result is just a
contiguous blank area.

End of text strip:

- `0x40e7c2` calls `0x40ded0(0x6f, 0x19, 0x9a, 0x0a)`;
- then calls `0x40bf80(0)` and returns.

## Present Helper

Disassembly range: `0x40ded0..`.

`0x40ded0` is the strip present wrapper:

- checks `[0x44b154]` and `[0x45a580]`;
- obtains a destination DC via `0x40bb40([0x45a580])`;
- calls `0x40e050(esi)` for DC setup;
- if `[0x45cce6] == 0`, performs a full-region `BitBlt`;
- source DC is `[0x44febc]`;
- ROP is `0xcc0020` (`SRCCOPY`);
- cleans up selected/deleted objects and releases the DC.

The helper at `0x40e050` is small DC setup. It conditionally calls imports at
`[0x44605c]` and `[0x446058]` when `[0x450010]` is nonzero.

## Glyph Decoder

`0x40e080` maps an input byte to glyph source data.

Known structure:

- sign-extends the character byte;
- adds `0x7d`;
- bounds-checks against `0x7c`;
- uses table `0x40e5d4`;
- dispatches through jump table `0x40e598 + edx * 4`.

This decoder affects which glyph cells are blitted, but it is not the source of
the high call count. The high count comes from the caller's one-`BitBlt`-per-
small-piece strategy.

## Why Credits Feels Hung On Web

The slow path is not one expensive API. It is many small pieces:

- worker thread emulation continues to run while a visible dialog exists;
- old visible-window scheduling gave worker threads too few instructions per
slice;
- Credits uses CPU-side x86/WASM loops plus many tiny GDI blits;
- the blank text-tail loop alone can account for tens of thousands of `BitBlt`
calls in a short run.

Raising the visible-window worker budget helps show forward progress, but it
does not remove the underlying tiny-blit bottleneck.

## CLI Frame Capture Status

The CLI can now capture real Credits-tab frames, but frame presentation advances
slowly and many adjacent captures are identical. The most useful harness setup
so far is:

- dismiss first-run survey at batch `10` with `WM_COMMAND IDCANCEL`;
- post Winamp's `Nullsoft Winamp...` command id `40041`;
- click the Credits tab around canvas coordinate `170,42`;
- capture About dialog hwnd `0x1000a` (`65546`) via `hwnd-png-pixels`;
- use `--batch-size=500` when trying to fit multiple animation states under a
  15 second command timeout.

Confirmed artifact set:

```text
/tmp/winamp-credits-unique/01.png .. 10.png
/tmp/winamp-credits-unique/contact-sheet.png
```

Pixel hashes for the curated set are all distinct:

| file | SHA-1 prefix |
| --- | --- |
| `01.png` | `4ae66c1c61db` |
| `02.png` | `cdbe941071fc` |
| `03.png` | `98ee05de7ae2` |
| `04.png` | `cdb6fbc7e408` |
| `05.png` | `141360d64150` |
| `06.png` | `e31272d150e0` |
| `07.png` | `ba4e89a37f2f` |
| `08.png` | `e8552d551c28` |
| `09.png` | `7884fb16bf43` |
| `10.png` | `b2aeebe18af3` |

Single-run attempt with ten captures at `--batch-size=500` completed under the
15 second ceiling, but only produced four unique states because the same
presented frame repeats for several capture intervals. Combining targeted runs
at different timing/scheduler settings produced the ten unique frames above.

## Next Optimization Targets

Best first target: collapse the blank-fill tail at `0x40e797..0x40e7ba`.

Reason:

- it is real Winamp behavior, not fallback content;
- it is visually a contiguous blank run;
- it accounts for the hottest sampled instruction count;
- replacing N `1x6` `BitBlt`s with one wider fill/blit should preserve output.

Possible implementations should stay in generic USER/GDI scheduling, not in a
Winamp-only WAT hook:

- add host-side `BitBlt` coalescing or batching for repeated same-source tiny
  SRCCOPY calls into adjacent destination columns;
- reduce per-call overhead for small same-size `SRCCOPY` without changing GDI
  opacity, clipping, or palette semantics;
- improve worker-thread slicing so the Credits render thread cannot monopolize
  a browser frame while visible dialogs are active.

Second target: reduce host overhead for small same-canvas `SRCCOPY` blits. The
current renderer spends significant time per call, so a fast path for tiny
opaque `drawImage` or direct pixel copies may help more broadly. This needs care
around alpha and palette semantics.

Third target: continue validating the software rasterizer output after the span
helper. The span loop is the correct real-renderer acceleration point, but the
Credits tab still needs screenshots after several seconds to confirm the whole
animation state is matching real Winamp.

## Useful Commands

All commands below should stay under the user's requested 15 second ceiling.

```sh
timeout 15 node tools/disasm.js test/binaries/winamp.exe 0x40e600 0x40e7e4
timeout 15 node tools/disasm.js test/binaries/winamp.exe 0x404d40 0x405190
timeout 15 node tools/disasm_fn.js test/binaries/winamp.exe 0x40ded0 360
timeout 15 node tools/disasm_fn.js test/binaries/winamp.exe 0x40e050 520
timeout 15 node tools/disasm.js test/binaries/winamp.exe 0x40e080 0x40e210
```
