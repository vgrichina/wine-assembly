# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: RENDERS — tool palette, color palette, and canvas all visible

As of commit 02b5521 (BI_RLE4 + mask-ROP fixes), mspaint renders its
expected chrome:

- 16 tool glyphs in the Tools palette (pick, magnifier, pencil, brush,
  spray, text, line, curve, rect, polygon, ellipse, freeform)
- Full 28-color palette
- White canvas client area
- Status bar with help hint text

Child hwnds live and correctly sized (from `--dump-backcanvas`):
Tools (65545), Colors (65562), per-tool-button children (65546..65561),
status bar (65540), canvas view (65538/65539).

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
