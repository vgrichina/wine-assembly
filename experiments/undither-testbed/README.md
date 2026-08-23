# Indexed-color undithering testbed

This is a standalone repository experiment. It does not modify the emulator
renderer, appear in the debug menu, or participate in the main build and test
suite. A bundled snapshot of the presentation filter supplies the two current
WineAssembly comparison shaders without coupling the lab to runtime state.

Run it with:

```sh
cd experiments/undither-testbed
node test.js
node server.js
```

Then open <http://127.0.0.1:8765/>.

## What is included

The selector deliberately separates dither evidence from mere low color count:

- two positive Floyd–Steinberg examples from `kornelski/undither`, each with
  the author's undithered output as a comparison target;
- Age of Empires, Diablo, and Heroes II 640×480 corpus frames, labeled as
  mixed candidates rather than assumed-positive examples;
- one reviewed native Bricks frame as an explicit no-dither control.

Solitaire, SkiFree, and Klotski were removed because screenshot inspection
showed low color counts but no reconstruction target worth testing. Bricks is
retained only to expose false positives on hard text, flat fills, and deliberate
one-pixel ornament.

Each sample includes annotated inspection regions and a stated expectation.
The UI shows original and reconstructed pixels side by side, a 4x absolute
difference image, runtime, changed-pixel percentage, channel deltas, and every
displayed color used by the frame. The two Kornelski samples also show the
author-provided reference and report input/output mean absolute error against
it. Views are always enlarged with nearest neighbor so the browser does not
hide the algorithm's output.

Selectable algorithms are:

1. exact original bypass;
2. box low-pass baseline;
3. Gaussian low-pass baseline;
4. bilateral filtering;
5. Perona–Malik-style anisotropic diffusion;
6. multiscale-gradient adaptive FIR reconstruction;
7. exact-color palette-pair/alternation reconstruction;
8. fixed-phase 2x2 or 4x4 ordered-cell reconstruction;
9. a source-level port of Kornel Lesiński's palette-aware `undither`;
10. a source-level port of Hyllian's SGENPT-MIX v10 default path;
11. the current WineAssembly five-pass MDAPT shader;
12. the current WineAssembly 16-tap Jinc2 shader.

The new reconstruction methods mix colors in linear light. The palette-pair
and ordered-cell methods derive labels from exact displayed RGB triples instead
of treating numeric palette indices as scalar intensities. The two
WineAssembly compatibility entries load the bundled
`wine-assembly-presentation-filter.js` snapshot and run its real WebGL shader
path. The snapshot is byte-identical to the current implementation at the time
the testbed was created, so the committed experiment does not depend on other
uncommitted renderer work. These entries intentionally retain the shaders'
sRGB math and fixed parameters. The isolated Node test uses matching CPU
reference ports when WebGL is unavailable.

See [PRIOR_ART.md](PRIOR_ART.md) for the researched alternatives, example-image
audit, and the reasons only some algorithms are in the selector. See
[THIRD_PARTY.md](THIRD_PARTY.md) for source and license details.

## Important limitation

These PNGs are visual exploration fixtures. They contain palette-expanded RGB,
not the game's original index plane or unused palette entries. The displayed
palette is recovered losslessly from the unique RGB triples used in each frame,
but two identical RGB palette entries cannot be distinguished and palette
cycling provenance is absent.

This means the lab can reject destructive algorithms and help tune hypotheses,
but cannot certify the final palette-aware implementation. The eventual
fidelity corpus still needs native `.idx + .pal + metadata` capture bundles and
synthetic fixtures with known high-color truth.

The commercial-game captures are research fixtures from the local application
corpus. Their distribution status should be reviewed before publishing them
outside this repository. The standalone experiment also contains GPL-covered
prior art; consult `THIRD_PARTY.md` before redistributing it independently.
