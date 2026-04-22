# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: CHROME COMPLETE — title bar, menu bar, palettes all render

After commits 02b5521 (BI_RLE4 + mask-ROP), 0fe2e37 (menu handle tag),
and 6cd71d5 (child erase offset), the full Win98 mspaint chrome paints:

- Blue title bar gradient + "untitled - Paint" + min/max/close ✓
- Menu bar: File / Edit / View / Image / Colors / Help ✓
- Tools palette (16 glyphs) ✓
- 28-color palette ✓
- White canvas client area ✓
- Status bar ✓
- Drawing (mouse-drag on canvas) still untested

### Session fixes

**1. Menu bar wasn't rendering** (commit 0fe2e37).
MFC calls `LoadMenuA(hInst, id=2)`, our handler returns
`id | 0x00BE0000 = 0xBE0002` as a fake handle. CreateWindowExA forwards
that to `$menu_load`, which then calls `find_resource(4, 0xBE0002)` —
fails, because the real resource ID is 2. Fixed by stripping the
`0x00BE0000` tag in `$menu_load` before resource lookup.

**2. Child WM_ERASEBKGND wiped caption** (commit 6cd71d5).
`gdi_gradient_fill_h` rendered the blue correctly (sampled pixel
confirmed `rgb=3,25,143` right after the call). But pixel samples
between repaints showed it go gray later, with no `gdi_*` call hitting
that coord. Culprit: `erase_background` for child hwnd 0x10002
(MDI client) used `_getClientOrigin(hwnd)` = `(win.x=0, win.y=0)` —
which is the child's position within the *parent's client area*. But
the fill target was the top-level's full-window back-canvas, so the
erase landed at back-canvas (0,0) instead of clientRect-offset
(3, 41). Wiped the entire caption + menu + top border every erase.

Fix: for child hwnds, compose screen-space origin from the parent
chain and subtract the top-level's screen position to get the real
back-canvas-local offset.

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

### NT variant — unrelated

The NT build fails much earlier at MFC42U's DllMain (Win9x platform
check). See `apps/mspaint-nt.md`.

**Binary:** `test/binaries/mspaint.exe` (344064 bytes — ANSI Win98 build)
