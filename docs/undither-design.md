# Indexed-color undithering design

Status: **design only**. No implementation is implied by this document.

Design date: 2026-08-22. Updated: 2026-08-23.

## Summary

Undithering should operate on a game's native indexed pixels and its effective
palette before those pixels become RGBA. It must not activate merely because a
surface or bitmap has a low bit depth. Many 1/4/8-bpp games use flat colors,
sharp pixel art, masks, stipples, or photographic texture that would be damaged
by a generic smoothing pass.

The safe design is therefore:

1. Preserve every 1-bpp source exactly; only 4/8-bpp color sources are eligible.
2. Treat eligible indexed color as **eligibility**, not proof of dithering.
3. Preserve raw indices, bit depth, palette, and source role through the render
   path.
4. Detect credible spatial color mixtures at native resolution.
5. Build an explicit structural-edge and semantic rejection mask; do not rely
   on a smoother merely being described as edge-aware.
6. Reconstruct only high-confidence regions and leave every other pixel exact.
7. Validate every initially supported game and rendering path with native PNG
   captures, nearest-neighbor A/B enlargements, and a changed-pixel mask.
8. Feed the same-size reconstructed texture into the existing scaler. Scaling,
   aspect-ratio fitting, Retina sizing, and CRT effects remain separate stages.

The intended first target is 8-bpp fullscreen DirectDraw. The second target is
complete 4/8-bpp GDI DIB buffers such as Pinball's back buffer and CWordZap's
RLE4 splash. Arbitrary WEP bitmap resources come later because many color
images participate in multi-step raster operations. Their 1-bpp resources stay
exact and never enter the undither detector.

## Terminology

- **Eligible indexed source**: packed 4-bpp or byte-per-pixel 8-bpp pixels,
  interpreted through a palette. A 1-bpp source is always ineligible.
- **Palette capacity**: 16 or 256 entries for eligible 4/8-bpp sources. A
  1-bpp source may have two entries, but the undither stage never reads them.
- **Effective palette size**: the number of distinct RGB colors in the current
  palette. Different indices may name the same color.
- **Active colors**: distinct palette entries referenced by the current source.
- **Dither**: a spatial mixture of available colors intended to represent a
  color or transparency that the palette cannot represent directly.
- **Texture**: deliberate spatial detail such as grass, stone, cloth, card-back
  lines, noise, or sprite shading. Texture is not automatically dither.
- **Undither**: reconstructing a likely intended color from a detected dither
  mixture without changing geometry. The existing UI calls this `Dedither`;
  this document uses the two words interchangeably.

## Goals

- Use the actual indices and effective palette when they exist.
- Handle ordered, clustered, error-diffusion, and irregular/stochastic dither;
  do not rely on one checkerboard phase.
- Preserve text, UI borders, pixel-art contours, deliberate patterns, texture,
  transparency masks, and color-key behavior.
- Support palette cycling and palette fades without temporal crawling.
- Produce an output at exactly the native source width and height.
- Keep undithering independent of Scale 2x/3x/4x, browser HQ, FSR1, and CRT
  effects so every combination remains possible.
- Fail closed: missing metadata, low confidence, unsupported composition, or a
  shader failure must display the original pixels.
- Avoid a GPU-to-Canvas-to-GPU round trip between undithering and GPU scaling.

## Non-goals

- 16/24/32-bpp framebuffer dequantization.
- Increasing a game's logical resolution or inventing detail.
- Replacing game palettes, changing guest memory, or changing GDI/DirectDraw
  semantics.
- Treating every low-color asset as dithered.
- Blurring deliberate noise or making photographic textures uniformly smooth.
- Folding scanlines, phosphor masks, glow, curvature, or color bleed into the
  undither stage.
- Undithering 1-bpp sources. They are always preserved exactly, whether they
  represent masks, monochrome art, stipple, or halftone.

## What the current games establish

### Complete indexed framebuffers

| Game | Observed source | Initial implication |
|---|---|---|
| Age of Empires | 800x600x8 DirectDraw | Exact index plane and live palette are available. Terrain is heavily textured, so global smoothing is unsafe. |
| Marbles | 640x480x8 DirectDraw | Exact indices and palette are available, including palette animation. Stone and soil detail is intentional texture. |
| RollerCoaster Tycoon | 640x480x8 DirectDraw | Exact indices and palette are available. Requires gameplay screenshot audit. |
| Liquid War | 640x480x8 DirectDraw | Exact indices and palette are available. Requires menu and gameplay audit. |
| StarCraft Shareware | 8-bpp DirectDraw | Exact palette data is available once its primary presents. Resolution and representative captures still need a focused audit. |
| Pinball | 600x416x8 `DIB_PAL_COLORS` back buffer | Exact indices and logical palette exist at the DIB source. Title and table artwork must be audited separately. |

### Lower-depth WEP and community assets

A local resource census found:

| Assets | Resource depths |
|---|---|
| `cards.dll` used by FreeCell, Solitaire, Cruel, and Golf | 41 x 1-bpp, 33 x 4-bpp |
| SkiFree | 89 x 4-bpp |
| Rattler/Snake | 5 x 1-bpp, 2 x 4-bpp |
| Taipei | 49 x 1-bpp, 38 x 4-bpp |
| Minesweeper | 3 x 1-bpp, 3 x 4-bpp |
| TicTactics | 1 x 1-bpp, 1 x 4-bpp |
| Bricks | 13 x 1-bpp, 4 x 4-bpp |
| EmPipe | 34 x 4-bpp |
| Funtris/FunPack | 127 x 4-bpp, 2 x 8-bpp |
| CWordZap splash | BI_RLE4 with logical-palette indices |
| Quick Blackjack | 30 x 1-bpp, 9 x 4-bpp, 13 x 24-bpp |

These counts describe source resources, not final framebuffer formats. Normal
GDI windows are backed by a 32-bpp canonical surface, so palette provenance is
usually lost after the indexed bitmap is decoded and blitted.

### Preliminary screenshot audit

This is a rejection-oriented audit, not an enablement allowlist. Captures must
be repeated after the audit tooling described below is implemented.

| Capture | Visible result | Design decision |
|---|---|---|
| FreeCell deal | Mostly flat card colors, hard glyph edges, and suit shapes | No broad undithering. Card resources are a negative corpus. |
| SkiFree gameplay/title | Mostly flat sprites and UI colors | No broad undithering. Low bit depth alone would be a false positive. |
| Quick Blackjack table | Flat colors plus deliberate fine card-back lines | Preserve the lines; do not classify periodicity alone as dither. |
| Marbles gameplay | Dense stone, soil, and sprite texture | Do not smooth globally. Any valid regions must be detected locally. |
| Age of Empires gameplay | Dense terrain and sprite texture | Do not smooth globally. Terrain is a critical negative corpus. |
| CWordZap splash | A nearest-pixel crop shows alternating gray/tan palette pixels inside anti-aliased background lettering | Localized candidate only. Reconstruct letter interiors while protecting their boundaries, the hard-color logo, and window chrome. No high-color truth exists yet. |
| Pinball 600x416 back buffer | A nearest-pixel crop shows deliberate palette stippling in the launch-ramp gradient, lamp halos, and dark playfield shading, mixed with sharp rails and labels | Strong mixed candidate. Detection must isolate smooth shaded areas and preserve mechanical texture, outlines, and display glyphs. No high-color truth exists yet. |

The default conclusion is therefore **no-op** for an indexed frame until the
detector and screenshots demonstrate a real improvement.

## Current architecture and loss point

DirectDraw already retains display width, height, bpp, surface pitch, and the
raw surface address. It also retains the effective primary palette and applies
`IDirectDrawPalette::SetEntries` updates. The host currently expands each index
through that palette into an RGBA `ImageData`, after which the presentation
filter receives only a Canvas.

```text
guest DirectDraw surface
  raw 8-bit indices + pitch + effective palette
                     |
                     | current host conversion
                     v
                RGBA Canvas
                     |
                     v
      current MDAPT/Jinc2 presentation pass
                     |
                     v
          scaler -> CRT -> Retina canvas
```

For ordinary GDI, the loss occurs earlier and at smaller granularity:

```text
indexed RT_BITMAP/DIB + per-resource/logical palette
                     |
          decode and GDI raster operations
                     v
          32-bit top-level window surface
                     |
                     v
             final window composite
```

Once multiple assets, primitives, masks, and ROPs have been combined into that
32-bit surface, there may be no single correct palette or index plane for the
whole frame.

## Required indexed-source descriptor

Presentation code needs an explicit descriptor instead of inferring format
from a Canvas:

```js
{
  kind: 'indexed',
  owner: 'ddraw-surface' | 'gdi-dib' | 'gdi-bitmap',
  role: 'framebuffer' | 'color' | 'mask' | 'unknown',
  width,
  height,
  bpp: 4 | 8,
  stride,
  topDown,
  indexEncoding: 'packed-msb-1' | 'packed-high-nibble-4' | 'u8',
  memoryOffset,
  palette,             // 2, 16, or 256 effective RGB entries
  paletteId,
  pixelsVersion,
  paletteVersion,
  transparentIndex: null | number,
}
```

The concrete API may use a memory getter rather than exposing `palette` or a
long-lived typed-array view. A descriptor must not retain a stale view if the
WASM memory buffer is replaced. It must also identify whether the index bytes
are a complete presentable frame or merely one asset participating in a later
composition.

### Per-surface DirectDraw palettes

The current DirectDraw implementation stores one global effective primary
palette pointer. That is enough for the common one-primary-palette case, but it
is not a sound source contract when different surfaces attach different
palettes. Add palette ownership keyed by DirectDraw surface slot, preferably in
a parallel table so the established 32-byte `DX_OBJECTS` entry layout does not
need unrelated reinterpretation. The global pointer can remain a compatibility
fallback while callers migrate.

`SetPalette` changes the surface's palette identity. `SetEntries` changes that
palette's version and RGB contents. A presented offscreen substitute must use
its own attached palette, not whichever palette was assigned most recently to
some other surface.

### Effective versus submitted palette

Undithering must use the palette that the emulator actually displays. The
current DirectDraw compatibility behavior intentionally ignores one suspicious
all-black full-table update in a palette-cycling case. That means the effective
emulated palette can differ from the last table submitted by the guest. The
effective palette is the correct input because it corresponds to the visible
source and preserves current compatibility behavior.

## Target render graph

For fullscreen indexed DirectDraw, keep the entire graph on the GPU:

```text
native index texture ----+
                         +--> detect/reconstruct at native size
palette texture ----------+              |
                                         v
                              same-size RGB(A) texture
                                         |
                           Scale 2x/3x/4x, FSR1, sharp/HQ
                                         |
                                  optional CRT effects
                                         |
                           aspect-preserving Retina output
```

There must be no derived logical Win98 desktop canvas between the native
framebuffer and detection. There must also be no readback to Canvas followed by
another upload when the selected scaler already runs on WebGL. Canvas/browser
HQ modes may consume the reconstructed GPU canvas at their natural boundary,
but should not introduce an extra native-resolution round trip.

Undithering never changes `width`, `height`, the source crop, or the presentation
viewport. Existing physical-pixel multiplier selection and aspect-ratio
letterboxing remain authoritative.

## Detection: bit depth is not a trigger

The automatic mode has three gates. All must pass.

### 1. Source eligibility gate

- Source is 4 or 8 bpp. A 1-bpp source bypasses the detector unconditionally.
- A valid palette and index plane cover the exact candidate rectangle.
- Source role is not `mask` or `unknown` in a risky GDI composition.
- The candidate is observed before arbitrary browser filtering.
- Transparent/color-key pixels are excluded from reconstruction support.

### 2. Spatial evidence gate

Build candidate color pairs from actual index co-occurrence, not all palette
pairs. For each local region, measure:

- dominance of two or a small number of indices;
- short-range alternation and repeated phase for ordered/clustered patterns;
- stable local coverage ratios for error-diffusion or stochastic patterns;
- whether the mixture's mean lies in a large gap between available palette
  colors;
- consistency over a connected region larger than isolated sprite details;
- color-pair distance and luminance/chroma direction;
- edge continuity before and after the candidate region;
- temporal consistency of the index pattern across adjacent frames.

Ordered patterns may produce a strong phase score. Error-diffusion and random
dither may not; they instead require a stable local distribution in an
edge-aware window. Neither path is allowed to equate "high frequency" with
"dither."

### 3. Structural edge-protection gate

Edge protection is an explicit native-resolution mask, not just a property of
the reconstruction filter. A raw Sobel/Prewitt threshold is insufficient:
dither itself deliberately creates strong one-pixel transitions, so treating
all high-frequency energy as an edge would reject every useful positive.

Build the structural mask from linear-light luminance and chroma using both a
native 3x3 gradient and gradients after two small low-pass scales. Classify an
edge as coherent when its direction and magnitude survive the larger scale;
alternating dither transitions normally cancel as scale increases, while a
silhouette, glyph boundary, rail, or UI border remains aligned. Palette-index
boundaries and alpha/color-key boundaries contribute independent hard evidence.

The resulting protection behavior is:

- strong coherent edges and transparency boundaries: undither strength is
  exactly zero, with a one-pixel dilation to protect both sides of the contour;
- medium coherent edges: attenuate strength continuously rather than creating
  a visible binary seam;
- connected one-pixel lines, small glyph components, and closed sprite
  contours: hard rejection even if their local pair statistics resemble an
  ordered pattern;
- isolated alternating micro-transitions inside a stable mixture region: do
  not reject solely on the native gradient response.

In compact form:

```text
mixture confidence ----\
structural edge mask ---+--> final confidence --> reconstruction blend
text/line mask ---------+              |
alpha/ROP mask ---------/              +--> zero means exact source pixel
```

`finalConfidence = mixtureConfidence * (1 - structuralProtection) *
(1 - semanticRejection)`. Implementations may factor the terms differently,
but must expose them separately for debugging so a false positive can be
attributed to detection rather than hidden inside a filter weight.

### 4. Rejection gate

Reject or reduce confidence for:

- text-sized connected components, one-pixel outlines, and UI borders;
- isolated sprite highlights and deliberate pixel-art clusters;
- long coherent lines such as a card back, hatch brush, or wire fence;
- broad-spectrum texture with more than a small stable color mixture;
- regions whose local statistics change abruptly under a one-pixel shift;
- any source involved in `SRCAND`, `SRCPAINT`, `NOTSRCERASE`, mask blits, text
  expansion, or other boolean ROP composition;
- palette-only motion treated as dither evidence; a stable detection mask may
  survive palette cycling, but its pair distances and output colors must be
  revalidated against every effective palette version;
- any region where the reconstructed result increases edge ringing or changes
  transparency coverage.

The output of detection is a confidence mask and a candidate mixture identity,
not a global yes/no bit. Reconstruction strength is zero below a conservative
threshold and ramps only within validated connected regions.

### Relationship to current testbed algorithms

The standalone testbed currently contains several different kinds of edge
behavior. They must not be presented as equivalent:

| Method | Current edge behavior | Suitable as the final rejection mask? |
|---|---|---|
| Kornelski `undither` | Explicit Prewitt field: strong edges bypass reconstruction and medium edges heavily weight the source pixel | Useful prior art, but its fixed luminance thresholds and 3x3 scale are not sufficient alone |
| Multiscale adaptive FIR | Correlates gradients at two low-pass scales and continuously reduces its blend near coherent edges | Closest signal-processing prototype; still needs text/line, index, transparency, and composition rejection |
| Bilateral / anisotropic diffusion | Reduce cross-edge color flow implicitly | No; they do not identify or expose protected zones and can still alter fine contours |
| Palette-pair / ordered-cell / MDAPT | Limit changes to detected color patterns | No; pattern confidence is positive evidence, not an independent structural-edge veto |
| SGENPT-MIX | Uses local contrast and anti-ringing bounds | No explicit protected-zone mask |
| Box / Gaussian / Jinc2 | Smooth without proving dither or protecting structure | No |

The testbed should therefore grow diagnostic views for the raw mixture
confidence, structural-edge protection, semantic rejection, final confidence,
and actual changed pixels. Until an algorithm returns those masks, its changed-
pixel image is only an observed effect, not proof that its detector selected the
right zones.

## Reconstruction algorithms

### Palette-aware MDAPT

The existing experimental MDAPT port detects connected checkerboard and
pseudo-transparency signals over multiple native-resolution passes. Retain its
connected-pattern logic, but provide actual palette/index information and gate
its output with the rejection mask above. Index equality is preferable to
floating-point RGB equality, especially during palette fades.

Best fit:

- ordered and clustered two-color patterns;
- pseudo-transparency patterns;
- small repeated patterns with coherent boundaries.

Weak fit:

- error-diffusion and stochastic noise without a stable phase;
- multi-color texture.

### Palette-aware local mixture reconstruction

Add an edge-aware statistical path for irregular/error-diffusion dither:

1. Find the dominant co-occurring two- or three-index set in a local window.
2. Verify that it is stable across overlapping windows and belongs to a
   connected region.
3. Estimate mixture weights from index coverage, excluding edges and
   transparent pixels.
4. Reconstruct the mixture color and blend it only through the confidence mask.
5. Preserve the original center pixel when evidence is weak.

Candidate palette-pair distance should be precomputed on palette changes in a
perceptual space. The emitted mixture should be evaluated in linear light and
against a CRT-like gamma curve during screenshot validation; the choice must be
fixed by real-game A/B results rather than assumed from theory.

This path can handle non-periodic dither, but it is also the easiest path to
confuse with grass, soil, stone, cloth, and noise. Its thresholds must be tuned
primarily against negative screenshots such as Age of Empires and Marbles.

### Jinc2

Jinc2 is a useful aggressive/manual comparison because it suppresses broad
high-frequency dither without requiring an index model. It must not be the
automatic indexed-color path: it can blur texture and pixel art, and it does
not use the actual palette.

The current experimental Jinc2 shader is attributed GPL-2.0-or-later while this
repository is MIT. Shipping that source requires an explicit licensing
decision. Otherwise omit it from release or replace it with an independently
licensed implementation. The design does not depend on Jinc2.

### Algorithms intentionally excluded

Do not restore standalone "simple checkerboard" or fixed "ordered 2x2" modes.
They accept too little evidence, cover only a narrow subset of real dithering,
and make deliberate one-pixel patterns easy to damage. Those patterns remain
useful as unit fixtures inside the full detector, not as user-facing algorithms.

## Palette and index analysis

For every candidate frame the implementation can know:

- palette capacity;
- effective palette size;
- used index set;
- active effective colors;
- index-pair co-occurrence counts;
- spatial and temporal index-pattern stability.

The number of colors alone is not a detection feature. A 16-color image may
have no dither; a 256-color image may dither only one gradient; an 8-bpp game
may use intentional noisy textures everywhere.

Palette changes and pixel changes need separate versions. Detection masks based
on indices can often survive a palette fade, while pair distances and emitted
colors must be recomputed. A palette animation must not force the detector to
rediscover unchanged geometry every frame.

## GPU representation

- Upload 8-bpp indices as a nearest-sampled 8-bit luminance/alpha texture in
  WebGL 1, with unpack alignment 1.
- Either unpack 4-bpp nibbles to bytes on upload or add a packed-nibble shader
  path after profiling. Start with byte-unpacked indices for simplicity.
- Never upload 1-bpp sources to the undither graph; preserve their existing
  presentation path exactly.
- Upload the effective palette as a nearest-sampled 2/16/256 by 1 RGBA texture,
  padded if a single texture shape simplifies programs.
- Upload palette data only when `paletteVersion` changes.
- Upload or mark dirty index regions when `pixelsVersion` changes. A full upload
  is acceptable for the first 640x480/800x600 implementation and is still less
  data than an RGBA upload.
- Preserve alpha/color-key coverage separately from reconstructed RGB.
- Keep detector intermediates and the scaler input as textures; do not copy the
  native result through a 2D Canvas between GPU stages.

## DirectDraw integration

DirectDraw is the first implementation target because the primary or selected
present surface is a complete native framebuffer.

1. Associate palettes with surfaces, while retaining the current global
   effective palette as a compatibility fallback.
2. Extend the present descriptor with surface slot, dimensions, bpp, pitch,
   index address, palette identity, and versions.
3. Attach that descriptor to the exclusive presentation source.
4. Let `PresentationFilter.present` receive the descriptor alongside the Canvas.
5. When enabled and eligible, upload indices and palette directly and start the
   GPU render graph there.
6. When disabled or rejected, preserve the existing RGBA/Canvas path exactly.

DirectDraw modes below 8 bpp are not currently part of the emulated mode table
or pitch implementation. The undither scope is 8-bpp DirectDraw plus 4/8-bpp
GDI color sources. It excludes 1-bpp everywhere and does not assume that 4-bpp
DirectDraw already works.

## GDI integration

GDI needs source-role tracking because the final top-level window surface is
32 bpp.

### Phase GDI-1: complete indexed DIB buffers

Target calls where one indexed buffer is itself the logical frame or a large
stable image:

- Pinball's shared 600x416x8 `DIB_PAL_COLORS` buffer;
- CWordZap's BI_RLE4 splash;
- other full-frame `SetDIBitsToDevice`/`StretchDIBits` sources discovered by
  tracing.

Retain packed indices and the resolved logical palette until the source has
been classified and reconstructed. Apply GDI clipping and destination geometry
normally. This phase avoids arbitrary resource composition.

### Phase GDI-2: standalone color resources

Extend DIB/resource metadata so 4/8-bpp sources retain indices and palettes.
Only color resources copied by safe operations such as an ordinary `SRCCOPY`
are initially eligible. Cache an optional reconstructed color canvas alongside
the exact original. ROPs, readback, mask construction, and guest-visible bitmap
operations continue to use the original pixels. This is a derived presentation
cache for a bitmap, not another GDI window drawing surface or guest-visible
render target.

### Phase GDI-3: composed sprites

Some WEP sprites use an exact 1-bpp mask plus a 4-bpp color bitmap through a
sequence of boolean ROPs. Undithering an input color layer can change
mask/color-key semantics. If these games need support, detect the completed
sprite or stable strip after composition, not either raw layer. This requires
provenance or an explicit composite cache and should not be inferred from bit
depth alone.

### 1-bpp hard safety rule

All 1-bpp sources bypass undithering unconditionally. There is no screenshot,
palette, source-role, or manual-mode exception. They retain their existing
indices, palette expansion, ROP behavior, scaling, and presentation exactly.

## UI and persistence

Keep one independent `Dedither`/`Undither` dropdown in the debug menu. Proposed
eventual options:

- **Off** — exact source pixels; default until the screenshot corpus passes.
- **Auto (palette-aware)** — conservative detector choosing pattern or local
  mixture reconstruction per region.
- **MDAPT** — manual pattern-oriented mode, still safety-gated for masks.
- **Adaptive palette** — manual irregular/error-diffusion reconstruction.
- **Jinc2 (experimental)** — only if licensing is resolved; manual and not
  described as palette-aware.

Legacy `checkerboard` and `ordered2` persisted values may continue migrating to
MDAPT. Scale and CRT selections remain separate persisted settings.

Debug diagnostics should expose, without changing the normal image:

- raw mixture-confidence mask;
- structural-edge protection mask;
- semantic/metadata rejection mask;
- final detected-region confidence mask;
- active palette-pair/mixture IDs;
- used/effective color counts;
- changed-pixel count and percentage;
- rejection reasons such as `mask`, `text-edge`, `texture`, `unstable`, or
  `no-palette`;
- selected backend and native input dimensions.

## Screenshot audit protocol

Every enabled game/path must pass this protocol. A low-bpp declaration or
synthetic shader fixture is not enough.

### Capture

1. Disable undithering, scaling filters, and CRT effects.
2. Capture the native source at 1:1 to lossless PNG, before Retina enlargement.
3. Capture at least a menu/title, representative gameplay, and any palette fade
   or animation. Capture multiple consecutive gameplay frames.
4. Record source owner, dimensions, bpp, palette size, used indices, and palette
   version with the image.
5. For GDI, record whether the image is a complete DIB, a standalone color
   bitmap, a mask, or an already composed 32-bpp window.

For an eligible 4/8-bpp source, capture a replayable indexed-frame bundle:

```text
frame.png       palette-expanded native screenshot for human review
frame.idx       normalized one-byte-per-pixel palette indices
frame.pal       effective RGB(A) palette in index order
frame.json      width, height, bpp, pitch/orientation, source owner/slot,
                palette and pixel versions, transparent index, hashes,
                app/scene/capture provenance
```

The normalized `.idx` makes offline algorithm tests independent of packed
4-bpp nibble layout. When format decoding itself is under test, also retain or
regenerate the original packed/RLE bytes and describe them in `frame.json`.
For `DIB_PAL_COLORS`, `frame.pal` contains the effective RGB colors after
resolving the selected logical palette, while the metadata records that palette
resolution was used.

The capture point must be before index-to-RGBA conversion and must use the
palette attached to that exact surface or DIB. A screenshot histogram cannot
reconstruct duplicate palette entries, unused entries, index identity, or a
palette that changes between frames.

### Review

For each capture generate:

- original at 8x nearest-neighbor zoom;
- Auto output at 8x nearest-neighbor zoom;
- manual algorithm outputs for comparison;
- absolute RGB difference image;
- detector confidence/changed-pixel mask;
- representative crops containing gradients, text, outlines, transparency,
  texture, and deliberate patterns.

Review the images visually. Pixel statistics can locate changes but cannot
decide whether grass, stipple, cloth, or card-back lines are intentional.
The structural-edge mask must also be reviewed directly: an unchanged edge can
otherwise be accidental cancellation from a weak filter rather than a reliable
detector veto.

### Acceptance

An automatic result passes only when:

- visible dither is reduced in the claimed regions;
- text, borders, silhouettes, one-pixel details, and transparency remain
  stable;
- deliberate texture is not flattened;
- the changed-pixel mask is localized to credible dither regions;
- consecutive frames do not crawl or flicker;
- palette fades/cycling remain smooth;
- Off remains pixel-identical to the existing presentation;
- aspect ratio and destination viewport are unchanged.

Initially, a human-reviewed screenshot manifest should record `no-op`,
`candidate`, or `approved` for each capture and algorithm. Do not encode an
application allowlist before representative screenshots exist. An approved
capture validates a rendering path and scene, not every frame that executable
can produce.

## Test plan

### Metadata and format tests

- DirectDraw `SetDisplayMode`, `CreateSurface`, `SetPalette`, and `SetEntries`
  produce the correct descriptor and version changes.
- Different DirectDraw surfaces retain different palettes.
- 4-bpp high/low nibble order and row padding are exact.
- BI_RLE4 and BI_RLE8 decode to exact index planes before palette expansion.
- `DIB_PAL_COLORS` resolves through the selected logical palette.
- Palette cycling changes output colors without corrupting a stable index mask.
- Stale WASM typed-array views are not retained.

### Synthetic still-image laboratory

Build a deterministic still-image harness before tuning Auto against games. A
fixture begins with a known high-color `truth.png`, quantizes it to an explicit
4-bpp or 8-bpp palette, applies a selected dither, runs undithering on the
resulting index plane and palette, and compares the reconstruction with the
original truth.

```text
high-color truth + protected-region mask
                    |
           quantize to 4/8-bpp palette
                    |
          apply deterministic dither
                    |
             indices + palette
                    |
               run undither
                    |
        compare reconstruction to truth
```

The generated source should combine positive and negative regions in one image:

- smooth grayscale and color ramps;
- radial gradients and pseudo-transparency over flat backgrounds;
- hard geometric edges, one-pixel diagonals, and small text;
- flat pixel-art sprites with isolated highlights;
- deliberate hatch, stripe, and card-back patterns;
- deterministic grass, stone, cloth, and broad-spectrum noise patches;
- transparent/color-key boundaries.

Generate fixed-seed 4-bpp and 8-bpp variants using at least:

- Bayer/ordered matrices at multiple sizes and phases;
- clustered-dot patterns;
- Floyd-Steinberg and Atkinson error diffusion;
- one wider diffusion kernel such as Sierra or Stucki;
- fixed-seed white-noise and blue-noise-like stochastic placement;
- no-dither nearest-palette quantization as a required no-op control.

Every case stores or deterministically regenerates the truth pixels, palette,
indices, dither name, seed, and protected-region mask. A PNG by itself is not a
complete palette-aware fixture because it has already lost index identity.

For each case emit:

- truth, palette-expanded input, Auto output, and manual algorithm outputs;
- 8x nearest-neighbor comparison sheet;
- absolute RGB difference from truth;
- detector confidence and changed-pixel masks;
- a JSON report with error before/after and changes inside/outside allowed
  regions.

Automated assertions should require:

- perceptual or linear-RGB error improves by a fixed margin in positive regions;
- protected text, edges, patterns, texture, transparency, and all 1-bpp bypass
  controls remain exact or within an explicitly tiny bound;
- no-dither 4/8-bpp controls remain unchanged;
- CPU/reference and browser/WebGL implementations agree within a defined
  channel tolerance;
- fixed seeds and palettes reproduce byte-identical fixture inputs.

Use error metrics to catch regressions and rank parameter changes, not to decide
visual quality alone. SSIM, PSNR, or aggregate color error can reward unwanted
blur. The generated comparison sheet and changed-pixel mask remain required
review artifacts.

A practical repository layout is a reusable `tools/undither-stills.js` runner,
a small committed fixture manifest containing palettes/seeds/expected bounds,
and `test/test-undither-stills.js` for deterministic assertions. Large A/B
sheets and masks should be generated into a requested output directory rather
than committed or read from incidental `scratch/` captures.

### Real-game indexed replay corpus

Feed captured `.idx` + `.pal` + `.json` bundles into the same still-image runner
used for synthetic cases. This separates three questions cleanly:

1. Did the emulator capture the correct native indices and effective palette?
2. Does the detector identify credible regions in a real game frame?
3. Does reconstruction improve those regions without damaging the rest?

Capture representative scenes, not one convenient startup frame: menus,
gameplay, flat UI, texture-heavy regions, gradients, palette fades, palette
cycling, and consecutive animation frames. Prefer small annotated native crops
for regression tests, but retain full frames for human review and detector
tuning.

Commercial-game images and palettes may not be appropriate committed public
fixtures. The harness must therefore support both committed fixtures and local
capture bundles. A committed manifest can record source, dimensions, hashes,
expected decisions, and crop coordinates while a focused test skips when the
corresponding local candidate assets are unavailable. Synthetic fixtures remain
the portable baseline; real indexed captures are the fidelity gate.

### Detector tests

Synthetic tests should cover ordered, clustered, error-diffusion, and stochastic
mixtures, but are only unit tests. Negative fixtures are equally important:

- one-pixel text and diagonal lines;
- hatch and card-back patterns;
- sprite outlines and isolated highlights;
- every 1-bpp source, with a pixel-exact bypass assertion;
- color-keyed transparency;
- grass, soil, stone, and broad-spectrum noise;
- palette fades and index-stable palette animation.

### Real screenshot tests

- Add audited native crops plus their captured index planes and effective
  palettes from representative DirectDraw and GDI games, with provenance and
  expected changed/rejected regions.
- Pin exact Off output hashes.
- Bound the changed-pixel percentage for approved positive crops.
- Require zero or tightly bounded changes on negative crops from FreeCell,
  SkiFree, Quick Blackjack, Age of Empires terrain, and Marbles texture.
- Exercise consecutive frames and compare confidence-mask stability.

### Presentation tests

- Undither runs at native resolution before every scaler.
- 2x/3x/4x output pixels and pass graphs remain exact after integration.
- Browser HQ and sharp modes consume the same native reconstructed source.
- CRT remains downstream and independently toggleable.
- DPR 1, fractional DPR, and DPR 2 preserve aspect ratio and viewport geometry.
- GPU failure and unsupported metadata fall back to exact original pixels.

### Performance tests

- Measure native 640x480 and 800x600 frames in the browser performance HUD.
- Report game fps, page fps, paint time, long tasks, and texture upload bytes.
- Verify palette-only animation does not rebuild index-dependent detector state.
- Verify Off does not pay detector or index-upload cost.
- Compare the single-GPU-graph path against any Canvas readback fallback.

## Rollout

### Phase 0: audit tooling

- Add source metadata logging and native capture support.
- Add indexed-frame bundle capture (`PNG + indices + effective palette + JSON`)
  before index-to-RGBA conversion.
- Add the deterministic truth-to-4/8-bpp synthetic still-image harness and its
  comparison-sheet/JSON outputs.
- Generate A/B, difference, and confidence-mask artifacts.
- Build the negative screenshot corpus before tuning thresholds.
- No visual behavior changes.

### Phase 1: 8-bpp DirectDraw metadata and manual modes

- Add per-surface palette identity and indexed present descriptors.
- Feed raw indices and the effective palette into the GPU graph.
- Expose manual MDAPT/adaptive comparison and detector diagnostics.
- Keep Off as the default.

### Phase 2: conservative Auto for DirectDraw

- Implement the three detection gates.
- Tune against positive crops and the texture-heavy negative corpus.
- Approve individual capture classes only after visual review.
- Keep automatic processing region-local even for an approved executable.

### Phase 3: complete 4/8-bpp GDI DIBs

- Preserve RLE4/RLE8 and `DIB_PAL_COLORS` index metadata.
- Target Pinball, CWordZap, and other stable whole-buffer paths.
- Re-run all GDI raster, readback, and ROP tests with Off pixel-exact.

### Phase 4: WEP color resources

- Track resource roles and ROP usage.
- Enable safe 4/8-bpp color-copy resources only.
- Keep 1-bpp permanently excluded. Keep multi-ROP 4/8-bpp sprite pipelines
  disabled until composition-level evidence and tests exist.

### Phase 5: default decision

Consider making Auto the user-facing default only after the screenshot manifest
contains broad positive and negative coverage, temporal tests pass, licensing is
resolved, and measured browser cost is acceptable. Until then, Off remains the
default and Auto remains an explicit debug choice.

## Completion criteria

The design is implemented when:

- complete 8-bpp DirectDraw frames reach the filter as indices plus their
  surface-specific effective palettes;
- eligible 4/8-bpp GDI DIBs retain source metadata through the correct stage;
- no 1-bpp source can be altered by any automatic or manual mode;
- Auto requires spatial screenshot-validated evidence and defaults to no-op;
- ordered and irregular/error-diffusion dither have distinct reconstruction
  paths;
- the result stays at native resolution and flows directly into the scaler;
- aspect ratio, Retina scaling, browser HQ, and CRT composition remain
  unchanged;
- real-game A/B screenshots and negative captures demonstrate improvement
  without texture, text, edge, transparency, or temporal regressions;
- all source/license obligations for shipped algorithms are compatible with the
  repository's distribution decision.

## Relevant implementation files

- `src/09a8-handlers-directx.wat` — DirectDraw modes, surfaces, palettes, and
  presents.
- `lib/host-imports.js` — indexed surface metadata, palette refresh, and current
  index-to-RGBA conversion.
- `lib/dib.js` — host-side 1/4/8-bpp and RLE DIB decoding.
- `lib/gdi-surface.js` — canonical indexed GDI surface storage and palette
  lookup.
- `src/10e-gdi-metafile.wat`, `src/10f-gdi-dc.wat`, and
  `src/10g-gdi-raster.wat` — bitmap, palette, DC, and raster semantics.
- `lib/renderer.js` — exclusive native-source selection and presentation
  viewport.
- `lib/presentation-filter.js` — current MDAPT/Jinc2 experiments, scalers, and
  CRT composition.
- `index.html` — debug dropdowns and persisted presentation settings.
