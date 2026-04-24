# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: LAYOUT FIXED — dock bars reserve proper strips

Chrome + dock layout now correct. Tools at left, Colors at bottom,
MDI canvas inset to 57,0 212×283 with dock bars reserving 57 px / 49 px.

### Root cause + fix (2026-04-23)

`GetWindowLong(hwnd, GWL_STYLE)` did not reflect `WS_VISIBLE` set via
`ShowWindow` — the WAT-side stored style remained at the original
`CreateWindowEx` value. MFC's `CDockBar::OnSizeParent` iterates
`m_arrBars` and *skips* any docked bar lacking `WS_VISIBLE` in its
`GetStyle()`, so every dock-bar computed zero thickness, MDI filled
the whole client area, and the palettes were left painting on the
frame at `(-2,-2)`.

Fix: `$handle_ShowWindow` now OR's `WS_VISIBLE (0x10000000)` into
stored style on show (`arg1 != SW_HIDE`) and clears it on hide.
General fix — applies to any MFC app that creates a control bar
without `WS_VISIBLE` and shows it later (the normal MFC idiom).

### Path of the investigation (kept for archaeology)

### Layout-bug root cause (updated 2026-04-23)

**Symptom:** `CFrameWnd::RepositionBars` runs, sends
`SendMessageA(dockbar, 0x361=WM_SIZEPARENT, 0, &rect)` to each of the 4
dock bars (`0x10005..0x10008`). MFC then tells MDI client to take the
whole area via `DeferWindowPos(MDI, 0, 0, 0x10d, 0x14c)` — MDI ends
up 269×332, filling the frame. Toolbars land at (-2,-2) of the frame
and paint over the canvas.

**Corrected evidence (supersedes the 2026-04-22 theory below):**

The prior note claimed "zero `SetParent` calls in the entire trace."
That was wrong. `--trace-api` shows **two** SetParent calls, both from
mfc42 VA `0x5f40e42b` (`CWnd::SetParent`):

```
[API #2352] SetParent(0x10009 Tools  → 0x10007 left-dock)   ret=0x0106442b
[API #2415] SetParent(0x1001a Colors → 0x10006 bottom-dock) ret=0x0106442b
```

So the toolbars ARE being reparented into dock bars. What's still
broken: a second `RepositionBars` pass runs *after* both reparents
(API #2845 onward) and sends `WM_SIZEPARENT (0x361)` to each of the 4
dock bars plus the status bar:

```
[API #2854] SendMessageA(0x10004 status,    0x361, 0, &rect)
[API #2903] SendMessageA(0x10005 top-dock,  0x361, 0, &rect)
[API #2928] SendMessageA(0x10006 bot-dock,  0x361, 0, &rect)
[API #2955] SendMessageA(0x10007 left-dock, 0x361, 0, &rect)
[API #2982] SendMessageA(0x10008 right-dock,0x361, 0, &rect)
```

**What's missing:** `CDockBar::OnSizeParent` is supposed to iterate
`m_arrBars` and forward `WM_SIZEPARENT` to each docked toolbar. There
are **zero nested `SendMessage(toolbar, 0x361, ...)` calls** between
#2955 and the end of the pass. Tools (0x10009) and Colors (0x1001a)
are never asked for their preferred size — so the dock bars compute
their own thickness as 0, MDI takes everything, toolbars stay at their
pre-reparent frame-relative (-2,-2).

So: reparenting happened (`SetParent` ran), but `m_arrBars.Add` on the
dock bar apparently did not — or `CDockBar::OnSizeParent` is iterating
an array that never got populated.

**Mfc42 call context (for next investigation):** the function that
invokes `CWnd::SetParent` on the toolbar is at `mfc42+0xe3xx`. At
`mfc42+0xe431` it tests `[esi+0x74]` (likely `CControlBar::m_pDockSite`
or `m_pDockContext`). If zero, it calls `mfc42+0x22204` (structure:
`lea ebx, [esi+0x80]` → operates on `CDockBar::m_arrBars`-equivalent
at offset 0x80 on *this*, calls an `InsertAt`-style helper at
`mfc42+0x2828b`). If non-zero, that Add path is skipped.

**Empirical state at the SetParent call sites** (via
`--trace-at=0x0106441e`, the block entry right before the `call [SetParent]`):

| | ESI (toolbar `this`) | [ESI+0x74] before SetParent |
|---|---|---|
| #2352 Tools→left-dock  | 0x0158ba08 | **0x00000000** |
| #2415 Colors→bottom-dock | 0x0158bb24 | **0x00000000** |

Both enter the Add path (`cmp [esi+0x74], 0 → jz` taken). After the
Tools Add ran, `[0x0158ba7c] = 0x0164ed64` (a heap-allocated
CDockContext pointer) — confirming the post-SetParent bookkeeping
*did* write to this field. So the Add-side allocation runs; this is
not the "gate skipped" failure.

**New mystery:** Add runs for both toolbars, but still no nested
`WM_SIZEPARENT` dispatch from `CDockBar::OnSizeParent`. Two paths to
narrow next:

1. Dump each of the 4 CDockBar `this` pointers + `[this+0x80..0x90]`
   (CObArray header: m_pData, m_nSize, m_nMaxSize, m_nGrowBy) at the
   entry of the 2nd `WM_SIZEPARENT` pass (API #2903–2982). Need to
   first find CDockBar `this` — they're referenced by the dock-bar
   hwnds 0x10005..0x10008 via MFC's `CHandleMap`. Hook AfxWndProc
   (CBT-style) or trace `CWnd::FromHandlePermanent` returning the
   CDockBar for hwnd=0x10007, stash its address, dump during the
   WM_SIZEPARENT.

   - If `m_nSize==0`: Add targeted a different object than the
     dockbar's m_arrBars — likely the CDockContext object (the thing
     stored at `toolbar+0x74`) has its own array and *that's* what
     got populated, while OnSizeParent reads the plain m_arrBars on
     the dock bar itself.
   - If `m_nSize>0`: OnSizeParent is iterating but filtering. Check
     `dwStyle` / visibility on the stored toolbars.

2. Dump the entire CControlBar around `[esi+0x70..0xa0]` for Tools
   after the 1st Add — field 0x74 = CDockContext ptr, but MFC 4.2
   typically has `m_pDockSite` *and* `m_pDockBar` separately. If
   `m_pDockBar` is null, OnSizeParent on 0x10007 will skip this
   toolbar.

**Tools toolbar memory map** (`CToolBar` @ `0x0158ba08`, after dock):

```
+0x00  010043c3b  vtable (CToolBar vtable — NOT CPBFrame)
+0x20  0x00010009 m_hWnd ✓
+0x68  0x50001fb0 m_dwStyle (WS_CHILD|WS_VISIBLE|...)
+0x6c  0x00005000 m_dwExStyle (WS_EX_TOOLWINDOW)
+0x70  0x0158b88c → CPBFrame `this`   (m_pDockSite? / parent)
+0x74  0x0164ed64 → CDockContext      (allocated after 1st SetParent)
+0x78  0x0164f19c → ?
+0x7c  0x0158b56c → ?
+0x80  0x0158bbd4 → "Paint\nun..." string buffer (NOT m_pDockBar)
+0x84  0x0164e12c → ?
+0x88  0x0164e12c → ?
```

`m_pDockBar` is not at +0x80. Still needs to be located — likely one
of `+0x78`, `+0x7c`, `+0x84`, or `+0x88`. Probe each by dereferencing
and checking for a CDockBar vtable (CWnd object with m_hWnd == 0x10007).

**Not the bug (ruled out this session):**
- `DeferWindowPos` / `EndDeferWindowPos` handlers — correct.
- Our `$handle_SetParent` (src/09a-handlers.wat:7512) — it only
  updates the WAT `$wnd_parent` field; MFC's `m_arrBars` is pure
  MFC-internal bookkeeping we do not and cannot touch.
- "Toolbars never reparented" — wrong; they are.

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
