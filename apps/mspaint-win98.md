# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: PARTIAL — palettes + menu bar render, title bar gradient lost, drawing untested

After commit 02b5521 (BI_RLE4 + mask-ROP fixes) + this session's menu-handle
tag fix, the window chrome is most of the way there:

- 16 tool glyphs in the Tools palette ✓
- Full 28-color palette ✓
- White canvas client area ✓
- Status bar with help hint text ✓
- **Menu bar with File / Edit / View / Image / Colors / Help ✓** (new)
- **Title bar: still missing the blue caption gradient ✗**
- Drawing (mouse-drag on canvas) untested

### This session — fixes

**Menu bar wasn't rendering.** MFC calls `LoadMenuA(hInst, id=2)`, our handler
returns `id | 0x00BE0000 = 0xBE0002` as a fake handle. CreateWindowExA with
`hMenu=0xBE0002` forwarded that into WAT's `$menu_load`, which then called
`find_resource(4, 0xBE0002)` — fails, because the real resource ID is 2.

Fix: strip the `0x00BE0000` tag inside `$menu_load` before resource lookup
(`src/09c5-menu.wat`). After rebuild, `menu_bar_count` > 0, nccalcsize
reserves the expected 18 px, and the menu strip paints via `menu_paint_bar`.

### Still broken — title bar gradient disappears between draw and save

Instrumented `gdi_gradient_fill_h` and confirmed the caption blue is actually
rendered into the back-canvas:

```
[grad] hdc=0xd0001 rect=3,3,272,21 clip=branches=1 bbox=(-INT,-INT,INT,INT)
[grad] t.ox=0 t.oy=0 paint@ 3,3 269x18 canvas=275x400
[grad] pixel after paint at (53,8): rgb=3,25,143    ← blue, correct
```

…but a sample of the dumped back-canvas PNG at the same (53,8) reads
`rgb=192,192,192` (btnFace gray). Something after the gradient call wipes
the caption. The 0xd0001 trace for the whole run shows only 7 ops:

```
fill_rect(0xd0001, 0,0,275,400, btnFace)       ; whole NC fill (excludes client)
gradient_fill_h(0xd0001, 3,3,272,21, blue)     ; caption gradient  ← blue confirmed
draw_text(0xd0001, "untitled - Paint", …)      ; title label
fill_rect(0xd0001, 254,5,270,19, btnFace)      ; close button BG
fill_rect(0xd0001, 236,5,252,19, btnFace)      ; max button BG
fill_rect(0xd0001, 239,8,248,10, black)        ; max glyph
fill_rect(0xd0001, 220,5,236,19, btnFace)      ; min button BG
fill_rect(0xd0001, 224,14,231,16, black)       ; min glyph
```

None of those touches x≈53, y≈8 on the back-canvas. So the overwrite is
happening OUTSIDE the 0xd0001 path. Candidates (not yet investigated):

1. Direct canvas clear in `repaint()` / `_repaintOnce` — but that only
   fills the screen canvas, not the back-canvas.
2. A child DC (e.g. hdc `0x50003` for the MDI client hwnd 0x10003) hitting
   the same back-canvas region. Traces show that child draws with
   `ox=3, oy=41` — caption at y=3..21 is outside. Doesn't explain it.
3. ncpaint running a SECOND time later with `is_active=0` (gray gradient)
   — but the whole-run trace has exactly one `gradient_fill_h` call.
4. The `--dump-backcanvas` path composites differently from the draw path
   (e.g. re-fills NC from style before dumping).

**Next probe (1-line hypothesis test):** add a second `[grad] sample`
right before the PNG dump call in `test/run.js`'s `--dump-backcanvas`
handler — if it reads gray there but blue at draw time, the back-canvas
was modified between those points and we can binary-search the caller.
If it reads blue at both points, the dump path is the problem.

### Menu-handle tag stripping — technical note

`$menu_load(hwnd, menu_id)` now does:

```wat
(if (i32.eq (i32.and (local.get $menu_id) (i32.const 0xFFFF0000))
            (i32.const 0x00BE0000))
  (then (local.set $menu_id (i32.and (local.get $menu_id) (i32.const 0xFFFF)))))
```

Only trips for hMenu values produced by our `LoadMenuA` stub. Named-
menu guest pointers (≥ 0x10000, but with different high bits) and raw
MAKEINTRESOURCE ints (< 0x10000) fall through unchanged. Other apps
unaffected (notepad, calc, freecell, sol regression-checked via smoke
renders — still produce identical chrome).

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
