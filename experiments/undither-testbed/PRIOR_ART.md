# Undithering prior-art audit

This audit is intentionally narrower than a list of image smoothers. It keeps
methods that claim to recognize dither or pseudo-transparency and excludes
generic resamplers that cannot decide whether a low-color pattern is texture,
line art, or a reconstructed tone.

## Algorithms

| Method | Recognition model | Palette-aware | Testbed status | Main risk |
| --- | --- | --- | --- | --- |
| [Kornelski `undither`](https://github.com/kornelski/undither) | Prewitt edge gate plus pair weights derived from whether another palette color lies near the pair midpoint | Yes | Ported; two author input/output pairs bundled | Targets Floyd–Steinberg-like error diffusion, not arbitrary intentional pixel texture |
| [MDAPT](https://forums.libretro.com/t/mdapt-gdapt-dithering-treatment-updated-06-06-14/375) | Five 1× passes detect checkerboards and vertical alternation, consolidate local evidence, then blend | No | Actual WineAssembly WebGL shader bundled | Pattern false positives; designed around console/arcade motifs |
| GDAPT | More aggressive, simplified MDAPT-style pattern rules | No | Researched, not ported | Mostly overlaps MDAPT while accepting more false positives |
| [SGENPT-MIX](https://github.com/libretro/slang-shaders/blob/master/dithering/shaders/sgenpt-mix.slang) | Selects a horizontal neighbor for alternating-line pseudo-transparency, blends in gamma space, clamps ringing | No | Default v10 path ported | Specialized for vertical-line/pseudo-transparency patterns |
| [Checkerboard-Dedither](https://forums.libretro.com/t/checkerboard-dedither-shader/38730) | Multipass checker recognition, pattern completion, and stray-pixel trimming, including 2×3 cells | No | Best next pattern-specific port | Not a general error-diffusion inverse; source needs a separate license/provenance review |
| [Jinc2 dedither](https://github.com/libretro/slang-shaders/tree/master/dithering) | Fixed 16-tap resampling kernel | No | Actual WineAssembly WebGL shader bundled as a broad baseline | Smooths without proving the pixels are dither |
| PS1 dedither box/comparison | Box filtering or pair comparison tuned to PlayStation ordered dither | No | Researched, not ported | Console-specific and largely a blur baseline for this 4/8-bpp PC corpus |
| Koko-aio dedither | Basic/extensive neighborhood searches with sensitivity and blend controls | No | Researched, not ported | Large integrated shader; extracting its behavior needs targeted validation |

The Libretro repository's [dithering directory](https://github.com/libretro/slang-shaders/tree/master/dithering)
is the source inventory for MDAPT, GDAPT, Checkerboard-Dedither, Jinc2, PS1,
and SGENPT variants. The testbed keeps its broad box/Gaussian/bilateral/
anisotropic filters as failure-revealing signal-processing baselines, not as
claims of proper dither detection.

## Example-image audit

| Source | What it provides | Decision |
| --- | --- | --- |
| Kornelski README | Two palette PNG inputs and two author-produced undithered outputs at the same native dimensions; one uses 256 displayed colors and one 32 | Bundled. These are the only current samples with a directly comparable positive target. |
| Checkerboard-Dedither forum | Multiple raw/filtered game pairs plus an explicitly native 320×224 Pulseman input | Inspected but not bundled. The filtered gallery frames are presentation-scaled, and neither those nor the game screenshot are ground truth; redistribution terms are also unclear. |
| MDAPT/GDAPT forum | Genesis and arcade before/after galleries, including Altered Beast, Lion King, and Street Fighter examples | Linked but not bundled. Useful qualitative targets, mostly not native indexed source/reference pairs. |
| WineAssembly app corpus | Age of Empires, Diablo, Heroes II, Space Cadet Pinball, and Classic WordZap captures | Bundled as mixed hypotheses. Pinball has visually confirmed stippled ramps/shading and WordZap has localized alternating pixels in gray lettering, but neither has high-color truth. Other visual texture is not treated as proof of dithering. |
| Reviewed Win98 utility/game screenshots | Bricks, Solitaire, SkiFree, Klotski, and other low-color windows | Only Bricks remains as a no-dither control. The others added redundant low-color negatives. |

The next high-value fixture is not another low-color screenshot. It is a real
4/8-bpp capture bundle containing the native index plane, complete palette,
frame metadata, and a manually reviewed region that visibly uses dither. A
known high-color source quantized with several error-diffusion, ordered, and
stochastic methods is the deterministic complement.
