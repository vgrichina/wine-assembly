# Third-party material

This file describes only material copied or adapted inside this standalone
experiment. It does not change the license of unrelated WineAssembly files.

## Kornelski `undither`

- Source: <https://github.com/kornelski/undither>
- Author: Kornel Lesiński
- Upstream version reviewed: 1.0.8
- Upstream license: GPL-3.0-or-later
- Local material: the `kornelskiUndither` source-level JavaScript adaptation in
  `prior-art.js` and the four `assets/kornelski-*.png` README example images

The adaptation retains the upstream palette-midpoint similarity classes,
Prewitt field, edge thresholds, center weights, and eight-neighbor accumulator.
Treat the combined standalone experiment as GPL-3.0-or-later when distributing
this adaptation. The license text is available from the upstream repository
and <https://www.gnu.org/licenses/gpl-3.0.txt>.

## SGENPT-MIX v10

- Source: <https://github.com/libretro/slang-shaders/blob/master/dithering/shaders/sgenpt-mix.slang>
- Author: Hyllian
- Upstream license: MIT
- Local material: the `sgenptMix` JavaScript adaptation in `prior-art.js`

The port implements the shader's default horizontal filtering mode, power-2
gamma conversion, 0.85 blend level, neighbor choice, and anti-ringing clamp.
The testbed's Strength control is an additional outer interpolation to the
unfiltered input.

## WineAssembly presentation filter snapshot

`wine-assembly-presentation-filter.js` is a byte-for-byte snapshot of the local
WineAssembly presentation filter at testbed creation time. It contains the
project's MDAPT integration and the existing Jinc2 compatibility notice. The
snapshot keeps this experiment isolated from concurrent renderer changes.
