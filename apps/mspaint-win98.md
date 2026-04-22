# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: PARTIAL — palettes render, title bar/menu missing, drawing untested

As of commit 02b5521 (BI_RLE4 + mask-ROP fixes), the palette children
paint correctly:

- 16 tool glyphs in the Tools palette (pick, magnifier, pencil, brush,
  spray, text, line, curve, rect, polygon, ellipse, freeform)
- Full 28-color palette
- White canvas client area
- Status bar hwnd exists (65540) with help hint text

Child hwnds from `--dump-backcanvas`:
Tools (65545), Colors (65562), per-tool-button children (65546..65561),
status bar (65540), canvas view (65538/65539).

### Remaining issues (visible in browser render)

1. **No title bar drawn.** `client.y=43` on the frame hwnd implies the
   renderer reserves 43px for caption+border, but the child MDI client
   (hwnd 65538, pos=0,0 size=269x350) paints from the top of the window
   surface. Likely the composition path treats child (0,0) as window-
   origin rather than parent-client-origin, so it covers the title bar.
   Notepad (no MDI client intermediary) renders its title fine, which
   supports this theory.
2. **No menu bar.** `LoadMenuA` + `GetMenu` succeed and `CreateWindow`
   reports `menu=12451842` on the frame, but no menu strip renders. Same
   likely cause as #1 — the renderer reserves space but the MDI child
   overlays it.
3. **Drawing not verified.** Canvas is white; no mouse-input test done
   to see if clicking a tool + dragging on the canvas produces strokes.
   The earlier `[view+0x44]==0` gate theory (see git log of this file)
   may or may not still apply now that paint works for chrome.

### Next probes

- Check `lib/renderer.js` composite loop: is a child hwnd with
  pos=(0,0) rendered at `(parent.client.x, parent.client.y)` or at
  `(parent.x, parent.y)`? The latter would explain #1 and #2.
- Inject mouse down/drag via `--input=...:click:...` on canvas
  coordinates and dump the back-canvas PNG to check whether strokes
  appear.

### What the prior blockers actually were

Earlier sessions spent a lot of effort on a phantom `[view+0x44]==0`
gate in `CPaintView::OnDraw` and the `OnInitialUpdate`/`m_pDocument`
path. The MD treated "palette absent" as an MFC CDocTemplate problem,
but the MFC framework was running fine. The real reasons nothing was
visible:

1. **Tool-icon strip (resource 859) was BI_RLE4.** `lib/dib.js` parsed
   the RLE stream into `rleIndices` but the 4bpp expansion path ignored
   it and re-read the compressed bytes as raw nibbles — rainbow noise.
2. **DSna ROP (0x00220326) fell through to SRCCOPY.** mspaint paints
   each tool icon with SRCINVERT + DSna + SRCINVERT; the missing DSna
   wiped the mask cutout so icons drew as solid rects, which the eye
   read as "no icons / blank palette."

Both fixed in 02b5521 (`lib/dib.js`, `lib/host-imports.js`). Sibling
mask-ROPs SRCERASE / NOTSRCERASE / MERGEPAINT added in the same commit.

### Remaining cosmetic gaps

- No title bar / system buttons on the top-level frame in the render
  (window decoration is drawn by the host renderer; see
  `hwnd=65537 title="untitled - Paint"` — the title is set, just not
  painted by the harness in PNG mode)
- Menu bar not rendered (GetMenu returns a handle but the menu items
  don't paint — shared issue across apps, not mspaint-specific)

### Tool added earlier (still useful)

`tools/find_field.js <exe> <off> [--reg=R] [--op=K] [--context=N] [--fn]` —
scan .text for ModRM `[reg+disp]` accesses at a given displacement.
Documented in CLAUDE.md Tools section.

### Useful address references (mspaint Win98 build)

| Name | Runtime | Notes |
|---|---|---|
| CPBFrame vtable | 0x010043a4 | |
| CPBView vtable | 0x01005104 | slot 0xe4=OnPrepareDC 0x0101f427, 0xe8=OnInitialUpdate 0x0101f546, 0xf8=OnDraw 0x0101f23f |
| CPBFrame::OnCreate | 0x0101cf3a | |
| CFrameWnd::OnCreate wrapper | 0x01063799 | mfc42 ord 4457 |
| mfc42 base at runtime | 0x01056000 | delta -0x5e3aa000 |
| CPBFrame `this` | 0x0158b994 | |
| CPBView `this` | 0x0158be24 | |

Class names in .rdata: `CPBDoc`, `CPBFrame`, `CPBView`, `CImgWnd`.

### NT Variant — Unrelated

The NT build fails much earlier at MFC42U's DllMain (Win9x platform
check). See `apps/mspaint-nt.md`.

**Binary:** `test/binaries/mspaint.exe` (344064 bytes — ANSI Win98 build)
