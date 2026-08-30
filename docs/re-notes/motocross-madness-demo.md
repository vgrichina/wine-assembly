# Motocross Madness demo

## Test route

The browser build can reach a live race without Wine. With a persisted profile,
the reliable 640x480 guest-coordinate route is:

1. `(310,441)` captures the mouse over the existing-profile screen.
2. `(445,45)` twice enters the main menu and Single Player Event.
3. `(350,442)` advances through track selection, rider selection, and Start.

The CLI-driven Puppeteer probe used during the 2026-08-30 investigation waited
45 seconds after Start in cooperative mode and 60 seconds in true browser
Worker mode. Both reached UI id 104 and rendered the quarry, rider, HUD, and
attached 16-bit Z surface. The Worker run was served with COOP/COEP isolation
and reported `hasWorker:true`; its loading phase is substantially slower but is
not stuck.

## Rendering findings

- MCM submits legacy `D3DLVERTEX` records with the documented eight-DWORD,
  32-byte layout: XYZ, reserved, diffuse, specular, U, V. Treating the record as
  28 bytes shifts every vertex after the first and reads the reserved DWORD as
  diffuse colour.
- Direct `DrawPrimitive` receives projected vertices that can straddle the near
  plane. Drawing those triangles without reconstructing and clipping their
  homogeneous coordinates leaves camera-near holes containing old menu pixels.
  Clipping at `z=0`, then reprojecting the generated vertices, produces
  continuous terrain from the horizon to the rider. A positive reciprocal W
  does not make a vertex near-plane-visible: MCM also produces vertices with
  `rhw > 0` but `z/w < 0`. Classifying only by RHW sends those triangles to the
  raw rasterizer and creates giant landscape wedges and repeated billboard
  labels. The first correction classified those vertices correctly but still
  intersected every rejected edge with `z=0`. That is also insufficient: when
  a negative-RHW endpoint retains positive clip-z, the edge enters through the
  far plane `z=w`, and a forced near intersection collapses the visible part
  into a fan. The direct path now clips a bounded convex polygon against both
  homogeneous depth inequalities, `z>=0` and `z<=w`; together they imply a
  positive W. Pre-transformed UI records with `rhw=0` retain the raw path
  because their original homogeneous coordinates cannot be reconstructed.
- MCM enables `D3DRENDERSTATE_COLORKEYENABLE` and uses packed 16-bit source
  colour keys. A keyed sample is discarded before both colour and Z writes.
- The HUD uses paired system/video-memory surfaces. For example, the traced
  64x64 gauge source and destination were slots 406 and 407 with identical
  pixels. `IDirect3DTexture::Load` must copy the source-key flag and packed key
  to the destination, converting the key when the surface formats differ.
  Pixel-only loads leave the destination texture's `0xf81f` magenta background
  visible even though the renderer implements colour-key discard correctly.
- DirectDraw `Blt` must apply `DDBLT_KEYSRC` to nearest-neighbour stretches as
  well as equal-size copies. MCM exercises that path for scaled 2D art.

The focused coverage is in `test/test-d3dim-indexed-texture.js` and
`test/test-directdraw-cursor-background-restore.js`. The verified final race
screenshots from the investigation were
`/private/tmp/mcm-fixed-coop2-final-wait-45000.png` and
`/private/tmp/mcm-fixed-worker-final-wait-60000.png`.
