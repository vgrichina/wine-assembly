# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: CHROME RENDERS but layout is broken — toolbars overlap canvas

Chrome paints (title bar, menu, Tools + Colors palettes, status bar),
but overall layout is wrong:

- Main frame restores to 275×400 (too small — toolbars overlap canvas)
- MDI client (`0x10002`) fills the full client area (0,0,269,332)
- Tool palette (`0x10009`) and Color palette (`0x1001a`) paint **on top**
  of the canvas rather than occupying reserved dock-bar strips
- Status bar does paint at y=332 but is clipped off the 275×400 frame

### Layout-bug root cause (2026-04-22 session)

**Symptom:** `CFrameWnd::RepositionBars` runs, sends
`SendMessageA(dockbar, 0x361=WM_SIZEPARENT, 0, &rect)` to each of the 4
dock bars (`0x10005..0x10008`). Each returns "I need 0 thickness"
(`CDockBar::OnSizeParent` iterates `m_arrBars`, finds it empty). MFC
then tells MDI client to take the whole area via `DeferWindowPos(MDI,
0, 0, 0x10d, 0x14c)` — which is exactly what we see.

**Why `m_arrBars` is empty:** the toolbars were never registered with
any dock bar. Evidence: **zero `SetParent` calls in the entire trace.**
Normal MFC `CDockBar::DockControlBar` reparents the toolbar before
adding it to `m_arrBars`. None of that ran.

**CPBFrame::OnCreate is a stub** — 14 insns at `0x0101cf3a`: calls base
`CFrameWnd::OnCreate` via IAT (→ `0x102ebf4` → jmp `[0x1001478]`), then
saves three member pointers (`+0xd8 → 0x103c744`, `+0x17c → 0x103d180`,
`+0x298 → 0x103c808`) and returns. No `EnableDocking`, no
`DockControlBar`, no toolbar creation.

So mspaint's toolbars are **standalone child windows**, not MFC-managed
dock bars. MFC42 does still create the 4 dock-bar hwnds (via
`CFrameWnd::OnCreate`) — they just stay empty. The toolbars 0x10009 /
0x1001a get `SetWindowPos(-2,-2, 0, 0, SWP_NOSIZE|...)` at APIs
#2347/#2410 — someone is positioning them at dock-bar-relative (-2,-2),
but without SetParent, they're at (-2,-2) on the **frame**, not
inside a dock bar. That the PNG shows them at plausibly-docked positions
is incidental — the renderer walks parent/child geometry and happens to
land them on top of the client area in roughly the right place.

**Where to resume next session:**
1. Dump `CPBFrame` vtable at `0x010043a4` slot-by-slot; compare against
   base `CFrameWnd` vtable to find overrides (`OnSize`, `RecalcLayout`,
   `OnCreateClient` etc). Custom layout likely lives in one of those.
2. Break on `SetWindowPos(0x10009, ..., -2, -2, ...)` at API #2347 and
   walk the call stack back through mfc42 to identify the docking path
   that runs partially (enough to position at -2,-2) but skips
   `SetParent` / `m_arrBars.Add`.
3. `CFrameWnd::DockControlBar` in mfc42 — find its runtime entry,
   break, confirm it never runs for either toolbar. If it doesn't, the
   bug is upstream (app never calls it). If it does, trace internal
   short-circuit.

**Not the bug (ruled out this session):**
- `DeferWindowPos` handler (src/09a-handlers.wat:6829) — applies moves
  immediately with correct stack args. MFC itself passes cx=0/cy=0 for
  empty dock bars. Values are right given MFC's state; the problem is
  upstream of the API boundary.
- `EndDeferWindowPos` — trivial no-op, safe because DeferWindowPos
  already applied everything.

### Original "chrome complete" session fixes (kept for context)

Commits 02b5521 (BI_RLE4 + mask-ROP), 0fe2e37 (menu handle tag),
6cd71d5 (child erase offset) got us from "solid teal" to the current
layout-broken-but-everything-paints state:

- Blue title bar gradient + "untitled - Paint" + min/max/close ✓
- Menu bar: File / Edit / View / Image / Colors / Help ✓
- Tools palette (16 glyphs) ✓
- 28-color palette ✓
- White canvas client area ✓ (but fills too much — see above)
- Status bar ✓ (but clipped — frame too small)
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
