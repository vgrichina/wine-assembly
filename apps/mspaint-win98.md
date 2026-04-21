# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: WARN-BLANK — MFC subclass OK, but CMainFrame::OnCreate not firing

**Current symptom:** render is a bare Win98 frame with title "Paint" and system buttons;
client area solid gray (just one `FillRect` + `DrawEdge` on hwnd 0x10002). No toolbar,
no tool palette, no color palette, no status bar — none of CMainFrame's child windows
are created, because `CMainFrame::OnCreate()` never runs.

### New finding (this session): WM_CREATE falls through to DefWindowProcA

Trace API # 1186 on the main frame (hwnd=0x10001) shows:

```
#1186 CallWindowProcA(pfn=0x04e03550, hwnd=0x10001, msg=WM_CREATE, wParam=0, lParam=0x01000100)
#1187 DefWindowProcA(0x10001, WM_CREATE, 0, 0x01000100)
```

`pfn=0x04e03550` is the class-placeholder thunk → `DefWindowProcA` (thunk idx 1706,
api_id 98). This is MFC's `CWnd::Default()` chaining to the old wndproc from inside
`AfxCallWndProc` (mfc42 at 0x5f40275f), which only happens when `OnWndMsg` returns
FALSE — i.e. the message map lookup for WM_CREATE on the attached CWnd didn't find
a handler.

Possible explanations:
1. `FromHandlePermanent(0x10001)` returns a *temporary* / generic `CWnd` (no map
   entry for CMainFrame's ON_WM_CREATE). Would happen if MFC's CBT hook never
   called `pWnd->Attach(hwnd)` against the CMainFrame passed via
   `AfxHookWindowCreate`.
2. `pThreadState->m_pWndInit` is NULL or wrong when the CBT hook reads it
   (TLS mismatch). Our `TlsAlloc` returns index 0 first — MFC and MSVCRT both
   use slot 0 / 1 in this trace; if any slot collides, the thread-state pointer
   could be wrong.
3. Virtual dispatch `call [eax+0xa0]` (AfxCallWndProc @ 0x5f40228e) lands on the
   wrong vtable — a generic CWnd vtable rather than CFrameWnd's.

### Suggested next diagnostics

- **Probe `m_pWndInit` at CBT hook entry.** Use `--trace-at=0x0105778f` (MFC CBT
  filter) with `--trace-at-dump` to dump the thread-state struct referenced by
  `TlsGetValue(slot0)` — confirms whether Attach can find the CMainFrame*.
- **Break at AfxCallWndProc vtable indirect** (`0x0105228e` under our relocation,
  i.e. 0x5f40228e − 0x5f400000 + 0x01056000 = `0x0105828e`). Dump `[edi]` (vtable
  ptr) and compare to CFrameWnd's vtable — if they don't match, the Attach picked
  the wrong CWnd.
- **Compare against a CBT-subclassed path that works.** The child at hwnd=0x10002
  runs the same CBT→subclass dance (#1199 SetWindowLongA) — does *its* WM_CREATE
  reach CView::OnCreate, or does it also fall through? We never see LoadBitmap /
  LoadToolbar / additional CreateWindowEx after either, so likely both fall through.

### Prior fix (intact): Child CBT hook continuation (CACA0026)

See "Fix Applied (this session)" history below — children now get HCBT_CREATEWND,
and MFC's hook does `SetWindowLongA(child, GWL_WNDPROC, AfxWndProc)`. That part
is working; the remaining gap is that the subclassed wndproc's message map still
doesn't recognize WM_CREATE as CMainFrame::OnCreate.

**Binary:** `test/binaries/mspaint.exe` (344064 bytes — ANSI Win98 build)

## Fixed: Stack Leak in Message Loop

Previous investigation (fixed in commit 5291175): the EIP-in-thunk-zone
dispatch path in `$run` (src/13-exports.wat) never set EIP after a
normal-API handler ran. When `$handle_DispatchMessageA` redirected EIP
to a wndproc that lives in the thunk zone (e.g. the placeholder
DefWindowProcA thunk that MFC registers as the class wndproc), the
main loop re-dispatched the same thunk forever, bleeding 20 bytes off
ESP per pass.

Fix: save `prev_eip`/`prev_esp`; if the handler didn't redirect EIP,
pop `[prev_esp]` as the new EIP (mirrors `$th_call_ind`).

## Current Issue: CBT hook not invoked for child windows

MFC42's class-registration + subclass pattern:

1. `RegisterClassA("MSPaintApp"/"AfxFrameOrView42", lpfnWndProc=DefWindowProcA)`
   — the class wndproc is a placeholder thunk (trace shows
   `wndProc=0x04e03530`, thunk index 1706, api_id 98 = DefWindowProcA).
2. `SetWindowsHookExA(WH_CBT=5, 0x0105778f, ...)` — MFC installs its
   per-thread CBT hook right before creating windows.
3. `CreateWindowExA(class="MSPaintApp", ...)` — creates main hwnd=0x10001.
4. Inside CreateWindow, Windows fires the CBT hook with HCBT_CREATEWND;
   MFC's hook routes the hwnd into the per-thread `CWnd *` (saved in TLS
   before the CreateWindow call), then calls
   `SetWindowLongA(hwnd, GWL_WNDPROC, AfxWndProc)` to subclass.
5. The class stays as DefWindowProcA; each hwnd is subclassed to
   AfxWndProc individually.

In our trace this works for hwnd=0x10001 (main):

```
#1160 SetWindowsHookExA(WH_CBT=5, 0x0105778f)     — hook installed
#1161 CreateWindowExA(..."MSPaintApp"...)          — hwnd=0x10001
#1174 SetWindowLongA(0x10001, GWL_WNDPROC=-4, 0x0105819d)
#1175 CallNextHookEx(...)
```

But for the child (#1193, class "AfxFrameOrView42", hwnd=0x10002), the
trace has **no `SetWindowLongA`** — the child never gets subclassed.
Every message it receives dispatches through DefWindowProcA (the class
placeholder), which is why the client area stays empty: no CView draw,
no MFC framework, no toolbar/palette/status bar.

**Root cause in our code:** `$handle_CreateWindowExA` in
`src/09a5-handlers-window.wat` only invokes the CBT hook on the
main-window path (lines 303-321). The child-window branch (lines
348-356) just flags pending `WM_CREATE`/`WM_SIZE` and pushes the hwnd
onto the paint queue. MFC never sees the HCBT_CREATEWND for the child,
so it never subclasses it.

## Fix Applied (this session)

Added CACA0026 child-CBT continuation thunk so `$handle_CreateWindowExA`
now invokes the CBT hook for child windows too. Trace after fix:

```
#1161 CreateWindowExA("MSPaintApp", ...)         → hwnd=0x10001 (main)
#1174 SetWindowLongA(0x10001, GWL_WNDPROC, AfxWndProc)
#1193 CreateWindowExA("AfxFrameOrView42", ...)   → hwnd=0x10002 (child)
#1199 SetWindowLongA(0x10002, GWL_WNDPROC, AfxWndProc)  ← NEW
#1201..1296 DeferWindowPos, AdjustWindowRectEx, LoadAccelerators,
            GetMenu, SetWindowPlacement, BringWindowToTop, ShowWindow...
```

MFC's CFrameWnd::LoadFrame now advances past child subclass into menu
loading, accelerator setup, and the full show chain. PNG output is still
solid gray (no chrome or client paint) — that is a separate, pre-existing
issue (reproduces against baseline before this fix). Next work: trace
WM_PAINT / WM_NCPAINT traffic after ShowWindow; the paint pipeline may
not be delivering to the now-subclassed hwnds.

## Fix Plan (original — implemented)

Invoke the CBT hook for child CreateWindowEx calls too, using a new
continuation thunk (e.g. `0xCACA0026`) that, unlike `CACA0002`, does
*not* dispatch WM_CREATE after the hook — it just returns to the
CreateWindowEx caller with `EAX = hwnd`. The existing pending_child
queue path continues to deliver WM_CREATE and WM_SIZE via
`GetMessageA`.

Files:
- `src/01-header.wat` — new global `$createwnd_child_cbt_thunk`.
- `src/08-pe-loader.wat` — allocate CACA0026 thunk alongside the
  existing CACA thunks.
- `src/09b-dispatch.wat` — new branch for CACA0026: set
  `EAX = saved_hwnd`, `EIP = saved_ret`, return.
- `src/09a5-handlers-window.wat` — in the child branch, push CBT args
  + CACA0026 ret thunk, set EIP = cbt_hook_proc. Guarded by
  `if ($cbt_hook_proc)` — without the hook, the existing pending_child
  flow runs as today.

## Verification

1. Re-run mspaint; confirm trace shows `SetWindowLongA(0x10002,
   GWL_WNDPROC, ...)` immediately after child CreateWindowEx.
2. Render PNG; expect menu bar, toolbar, tool palette, color palette
   to appear (MFC's CView and associated CFrameWnd children painting
   via AfxWndProc).
3. Regression: notepad + calc render unchanged.

## NT Variant — Unrelated

The NT build fails much earlier at MFC42U's DllMain (Win9x platform
check). See `apps/mspaint-nt.md`.
