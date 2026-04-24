# MSPaint Win98 (test/binaries/mspaint.exe)

## Status (2026-04-24 later): I1 NOT A BUG, I2 + I3 FIXED — Colors now docks at bottom

### I2/I3 root cause: renderer never saw SetParent

`$handle_SetParent` updated WAT's `$wnd_parent` but there was no host
bridge, so `renderer.windows[child].parentHwnd` stayed at the creation-
time parent (always `0x10001` = frame) forever. Colors (`0x1001a`) was
correctly reparented into bot-dock at the MFC level, but the renderer
still thought its parent was the frame, so `_getDrawTarget` placed it
at frame-client-origin (top of window) instead of inside bot-dock.

Second bug found in the same path: `_getDrawTarget` only added one
hop of child-position to the back-canvas offset. For two-level chains
(Colors → bot-dock → frame) it missed the intermediate dock-bar
position (`y=283`), so even with parentHwnd fixed the offset was short.

### Fix (3 parts)
- New `set_parent` host import (`src/01-header.wat`), called from
  `$handle_SetParent` (`src/09a-handlers.wat`).
- Host impl updates `renderer.windows[hwnd].parentHwnd` + `isChild`.
- `_getDrawTarget` (`lib/host-imports.js`) now walks the full
  renderer-tracked ancestor chain when computing back-canvas offsets,
  not just one hop.

### I1: not a bug

`cx=0x113=275` / `cy=0x190=400` are **hardcoded literals** in the
`CPBFrame` constructor at `mspaint.exe 0x0101cd3c`:

```
0101cd3c  mov eax, 0x113     ; 275
0101cd41  mov ecx, 0x190     ; 400
0101cd46  mov [esi+0xd0], eax   ; CPBFrame::m_minX
0101cd4c  mov [esi+0xd4], ecx   ; CPBFrame::m_minY
```

`CPBFrame::PreCreateWindow` (at `0x0101cde3`) reads a saved-rect at
`[0x103d000..0x103d00c]` (uninitialised at first run → 0) and falls
back to `m_minX/m_minY` for `cs.cx/cs.cy`. That's 275×400 by design.
Earlier note "nothing in mspaint.exe contains push 0x113" was misled
by looking only at `push`; the values are `mov`-ed. No action needed.

draw test still 7/7 after the fix.

## Status (2026-04-24): I4 FIXED — pencil drag now draws (31053 px diff in test)

Root cause was not TLS-related. `$handle_GetMessagePos` in
`09a-handlers.wat` was missing the `esp += 4` retaddr pop, violating
the "handlers must pop ESP" invariant. mfc42 ord 3021 calls
GetMessagePos → GetMessageTime; the skipped pop shifted ESP by 4, so
ord 3021's later `ret` popped saved-esi (0x0158c58c) as retaddr and
jumped into CPBView data. Fix: one-line add of the ESP pop in the
GetMessagePos handler. test-mspaint-draw.js now 7/7.

I1/I2/I3 layout bugs remain open below.

## Status (2026-04-23 evening): REGRESSED + new open bugs

Visual (see screenshot): main window is cramped 275×400, Colors palette
sits *above* the canvas (should be at bottom), canvas doesn't extend to
the bottom of the frame (grey dead space), and the pencil-drag test
still reports 0 changed pixels inside the document bbox.

### Open issues (newest first)

#### I1. Main frame too small (275×400)

Confirmed via `--break-api=CreateWindowExA` stack dump for hwnd=0x10001:
`x=y=CW_USEDEFAULT` but `cx=0x113=275, cy=0x190=400` are **explicit**.
Our CW_USEDEFAULT fallback at `09a5-handlers-window.wat:267-275` never
fires — MFC is passing 275×400 directly.

Bumping `SM_CXSCREEN`/`SM_CYSCREEN` from 640×480 to 1024×768 makes
no difference — Paint is not deriving cx/cy from screen metrics.
Nothing in mspaint.exe nor mfc42.dll contains a `push 0x113` or
`push 0x190` constant, so the values are computed at runtime.

Caller is mfc42 `CWnd::CreateEx` at ret=0x0105fdb7; just before the
CreateWindowExA call it does a virtual call `[eax+0x64]` which is
`CWnd::PreCreateWindow(CREATESTRUCT& cs)` — CPBFrame's override is
where cs.cx/cs.cy get substituted. Next step: break at 0x5f409d7e
(after the vcall, file VA; runtime = mfc42_base + 0x9d7e) and dump cs
before/after to see which fields PreCreateWindow set.

Side fix committed this session: SM_CXSCREEN/CYSCREEN now read the
actual renderer canvas via `host_get_screen_size` so `--screen=WxH`
is honored by metrics-driven apps (commit 9388bb0).

#### I2. Colors palette docks at top instead of bottom

Chrome repaints show Colors palette as a band **above** the canvas
rather than the bottom (real mspaint's default). The 2026-04-23
"LAYOUT FIXED" fix (`WS_VISIBLE` OR-in on ShowWindow) made the dock
bars *reserve space*, but the dock-side assignment for Colors
(`0x1001a`) is wrong. `SetParent(0x1001a, 0x10006=bot-dock)` is
called (API #2415) but the canvas layout places it at top.

Likely cause: our MDI client / dock-bar z-ordering or the offset
computation in `_drawWindowFrame` for the frame's client rect. Also
possible: `0x10006` isn't actually the bottom dock — MFC picks dock
sides from CREATESTRUCT order.

#### I3. Dead grey strip at bottom of frame

Canvas ends partway down; ~60 px of background colour between
canvas bottom and frame bottom. Consistent with I2: if Colors took
the "top" slot, bot-dock has zero content but still reserved strip
height. Or canvas max size is clamped by an old Image/Attributes
default (e.g. 212×283) that doesn't auto-stretch to client size.

#### I4. Pencil drag produces 0 pixels — guest STUCK after WM_LBUTTONDOWN to MDI client

`test/test-mspaint-draw.js` 6/7. Click pencil `(39,146)` → `0x10010`,
mouseup → `0x10009` (`SetCapture`/`ReleaseCapture` pair is clean).
Then mousedown canvas `(140,170)` → `0x10003` (MDI client). After
that, **EIP jumps into data at `0x0158c58c`** (inside CPBFrame, not
code). STUCK detection fires; all subsequent `check_input` polls stop,
so queued mousemoves never drain. Same regardless of whether
mousemoves are sent.

Call site: `mspaint.exe 0x01018bb7 call 0x0102ea80` which is
`jmp [0x1001370]` — IAT entry for **mfc42.dll ordinal 3021**.
At the break, `ECX=0x0158c58c` (bogus `this`), `prev_eip=0x010116cf`.
The call is inside mspaint's WM_LBUTTONDOWN path for the view/doc.
Something computed `this` as an address inside CPBFrame's own data,
then mfc42 ord 3021 presumably did a `jmp ecx`-style operation (or
its own vtable load landed on data that happens to equal ecx).

mfc42 ord 3021 resolves to a real export at RVA=0x13fbd
(runtime `0x01069fbd`). Disasm shows a thread-state accessor that
starts with `push esi / push 0x5f406dee / mov ecx, 0x5f4cbe28 /
call 0x5f401000`. The inner `call 0x5f401000` reads a TLS-backed
thread-state pointer via `[0x5f4cf32c]` (TlsGetValue thunk); if the
TLS slot is 0/garbage, the subsequent `mov esi, [eax+N]` /
`mov [esi+0x44], eax` chain scribbles into random memory and ord 3021
returns a bogus pointer. Current hypothesis: our TlsGetValue/TlsSetValue
doesn't retain whatever MFC stowed at thread init for the main thread,
so the first time this accessor runs (during WM_LBUTTONDOWN dispatch
on the MDI client) it corrupts state.

Next steps: (a) break at `0x01018bb7` and single-step into
`0x0102ea80 → IAT[0x1001370] → 0x01069fbd`, dumping `[0x5f4cbe28]`
and the TlsGetValue result to see if it's zero; (b) walk back to the
TlsSetValue(s) that should have populated MFC's thread-state during
DllMain / CWinApp init; (c) if the slot never got set, implement the
AFX_MODULE_STATE seeding (`AfxGetModuleState` / `_afxBaseModuleState`).
I1/I2/I3 remain ahead of I4 — fixing layout is orthogonal to the TLS
issue and may also shrink the repro once the canvas is the right
size.

Old hypothesis (messages starved by post-queue) is wrong — host
polling halts because the guest is STUCK, not busy.

Actual image diff between before/after PNG: 1330 pixels in bbox
`(24,62)-(187,306)` — outside canvas bbox `(80,38)-(292,321)` on
the X axis. Change is in the palette/toolbar strip, not document.

Next steps:
- Dump the dispatched wndproc for hwnd=0x10003 on LBUTTONDOWN —
  confirm it's MDI client DefFrameProc and not a document child.
- Check if mspaint creates a child document window inside
  `0x10003` (classic MDI child) — may never happen without
  `File > New` / `OnNewDocument`.
- If there's no document window, canvas drag has nothing to draw
  on. Either synthesize the default new-document init (MFC
  `CSingleDocTemplate::OpenDocumentFile(NULL)`) or route the
  down/move to the MDI client's active child.

## Earlier status (kept for reference): LAYOUT FIXED — dock bars reserve proper strips

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
