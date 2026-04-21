# MSPaint Win98 (test/binaries/mspaint.exe)

## Status: WARN-BLANK — CPBFrame::OnCreate is CALLED but CFrameWnd::OnCreate never returns

**Current symptom:** render is a bare Win98 frame with title "Paint" and system buttons;
client area solid gray (just one `FillRect` + `DrawEdge` on hwnd 0x10002). No toolbar,
no tool palette, no color palette, no status bar.

### Major correction (latest session): WM_CREATE *does* reach CPBFrame::OnCreate

Previous sessions concluded WM_CREATE fell through to DefWindowProcA because
the message-map chain walk failed. **That was wrong.** Verified end-to-end:

1. Vtable layout: CPBFrame::GetMessageMap is at vtable slot **12** (offset 0x30),
   not slot 11. Entry `mov eax, 0x01004130; ret` at 0x0101ccea, reached via
   `call [eax+0x30]` at mfc42 0x5f402374.
2. CPBFrame::messageMap @ 0x01004130:
   - `pfnGetBaseMap = 0x0102905f` (thunk: `mov eax, [0x01001458]; ret` — IAT slot
     for CFrameWnd::messageMap, ord 4242, resolves to mfc42 RVA 0x98e70 = runtime
     0x010eee70 ✓)
   - `lpEntries = 0x01004138` (24-byte AFX_MSGMAP_ENTRY records)
3. Entry[1] @ 0x01004150 = `{ nMessage=1 (WM_CREATE), nCode=0, nID=0, nLastID=0,
   nSig=9, pfn=0x0101cf3a (CPBFrame::OnCreate) }` ✓
4. `CWnd::OnWndMsg` at mfc42 0x5f40232d does hashed-cache lookup with miss-path
   at 0x5f40247d → `AfxFindMessageEntry` at 0x5f4016df.
5. **Runtime trace confirmed** (mfc42 loaded at 0x01056000, so delta -0x5e3aa000):
   - 0x010576df (Find entry): args = lpEntries=0x01004138, msg=1, 0, 0 ✓
   - 0x0105770d (Find match): EBX=0x01004150 (the WM_CREATE entry) ✓
   - 0x01057717 (Find load-ret): [ebp+8]=0x01004150 stored correctly ✓
   - 0x0105849c (OnWndMsg post-call): EAX=0x01004150 ✓ (cache miss → stored in
     `mov [ebx+4], eax`, then dispatched via sig=9 at 0x5f4025b5 →
     `push esi; jmp 0x5f40251b` → `mov ecx, edi; call ebx`)
   - **0x0101cf3a (CPBFrame::OnCreate entry): HIT with ECX=0x0158b994 (this),
     ESI=0x01000100 (CREATESTRUCT*), [esp+4]=0x01000100** ✓

So the entire MFC message-map machinery works in our emulator. WM_CREATE is
dispatched correctly.

### The real blocker: CFrameWnd::OnCreate never returns

CPBFrame::OnCreate disasm (at 0x0101cf3a):
```
0101cf3a  push esi
0101cf3b  mov esi, ecx              ; esi = this
0101cf3d  push [esp+0x8]            ; push lpCreateStruct
0101cf41  call 0x0102ebf4           ; IAT thunk → CFrameWnd::OnCreate (mfc42)
0101cf46  cmp eax, -1
0101cf49  jnz 0x0101cf4f            ; success path
0101cf4b  or eax, eax
0101cf4d  jmp 0x0101cf73            ; fail path: return eax unchanged (usually -1)
0101cf4f  ...                        ; success: stash pointers, xor eax,eax, return 0
0101cf73  pop esi; ret 0x4
```

**Trace at 0x0101cf73 with 100 batches NEVER fires.** OnCreate enters but
control never returns from `call 0x0102ebf4`. So the problem is inside
mfc42's CFrameWnd::OnCreate — which is where MFC creates the view, toolbar,
status bar, menu bar. One of those sub-CreateWindow calls is hanging, or
some framework state check is wedging.

### Ruled-out paths (cumulative across sessions)

1. CBT hook fires with correct `m_pWndInit` ✓
2. CWnd::Attach populates m_hWnd at [pWnd+0x20] and handle map ✓
3. SetWindowLongA swaps GWL_WNDPROC to AfxWndProc; old wndproc saved as m_pfnSuper ✓
4. WM_CREATE dispatched to AfxWndProc (via `wnd_table_get`) ✓
5. AfxWndProc → FromHandlePermanent returns correct CPBFrame* 0x0158b994 ✓
6. AfxCallWndProc invokes virtual `CWnd::WindowProc` (vtable+0xa0) ✓
7. IAT slot for cross-module `CFrameWnd::classCFrameWnd` patched ✓
8. `CWnd::OnWndMsg` finds WM_CREATE entry in CPBFrame::messageMap.lpEntries ✓
9. Sig=9 dispatcher calls `pWnd->OnCreate(lpcs)` correctly ✓
10. **CPBFrame::OnCreate is entered with correct args ✓**
11. **CFrameWnd::OnCreate (mfc42) never returns ✗**

### Next-session plan

Focus moved to mfc42's CFrameWnd::OnCreate internals:

1. Find mfc42.dll's CFrameWnd::OnCreate entry point. IAT thunk at 0x0102ebf4 in
   mspaint.exe is `jmp [0x0100141c]`. At runtime, read [0x0100141c] to get the
   resolved mfc42 address.
2. Disassemble CFrameWnd::OnCreate and identify its internal child-window
   creation calls (CreateView, CreateStatusBar, CreateToolBar, LoadFrameToolBar
   pattern, or OnCreateClient).
3. Trace-at each successive instruction block inside CFrameWnd::OnCreate to find
   where it wedges:
   - Child CreateWindowExA call that never returns?
   - SendMessageA deadlock?
   - LoadBitmap/LoadImage returning NULL causing a retry loop?
4. Check the API trace around the 0x0101cf41 call site for the last API call
   before the stall — that narrows which sub-call is hanging. Previous
   trace showed LoadIcon/LoadMenu earlier; first child CreateWindowExA
   (hwnd=0x10002 class="AfxFrameOrView42") happens and returns, so the view
   is created but something after that hangs.

**Binary:** `test/binaries/mspaint.exe` (344064 bytes — ANSI Win98 build)

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
2. ~~`pThreadState->m_pWndInit` is NULL or wrong when the CBT hook reads it~~
   **RULED OUT** (this session). Trace at CBT entry 0x010577a4 dumping thread
   state at EAX=0x01188cdc (AfxGetThreadState return):
   - Hit #1 (main frame): `[0x01188cdc+0x14] = 0x0158b994` — pWnd non-NULL.
     Dumping 0x0158b994: `vtable=0x010043a4, m_hWnd=0x00000001`.
   - Hit #2 (child view): `[0x01188cdc+0x14] = 0x0158be24` — pWnd non-NULL.
     Dumping 0x0158be24: `vtable=0x01005104, m_hWnd=0x00000001`.

   Two distinct vtables, both sensible. So `m_pWndInit` is populated correctly
   by `AfxHookWindowCreate` before each CreateWindowExA, the CBT hook reads it
   correctly, and a typed CWnd-derived object (CMainFrame resp. CPaintView)
   is available to Attach.
3. Virtual dispatch `call [eax+0xa0]` (AfxCallWndProc @ 0x5f40228e) lands on the
   wrong vtable — a generic CWnd vtable rather than CFrameWnd's.
4. ~~Attach virtcalls don't complete~~ **RULED OUT** (this session). Trace at
   0x0105780e (post-virtcalls) with 64-byte dump of pWnd shows `m_hWnd` at
   **offset 0x20** (not 0x04 — mfc42 CWnd has 0x20 bytes of CCmdTarget prefix)
   populated as 0x00010001 for main frame. CWnd::Attach is at
   `call 0x5f40534d` (*before* the virtcalls — it's `CCmdTarget::operator=`
   style, stores hwnd at `[esi+0x20]` and does `CHandleMap::SetPermanent`
   via call 0x5f40299e). So handle map is live.
5. **(remaining)** The Attach did happen but AfxWndProc's `OnWndMsg` walks only
   CWnd's base map (message map chain broken) — e.g., the static
   `CMainFrame::messageMap` .rdata struct wasn't relocated, so its
   `pBaseMap` pointer is bogus. **Most likely remaining cause.**
6. ~~`FromHandlePermanent(hwnd)` fails at AfxWndProc dispatch~~ **RULED OUT**
   (this session). Trace at 0x0105820d (right after `call 0x5f4012ce` =
   FromHandlePermanent inside AfxWndProcBase) on the WM_CREATE hit
   (msg=1, hwnd=0x10001, lParam=0x01000100) returns `EAX=0x0158b994` — the
   correct CMainFrame* from step 3. The handle map works.

### Current conclusion

- `m_pWndInit` correct ✓
- `CWnd::Attach` runs, `m_hWnd` (at CWnd+0x20) populated ✓
- `SetPermanent` adds hwnd→pWnd to the module's handle map ✓
- `FromHandlePermanent(0x10001)` returns CMainFrame* 0x0158b994 ✓
- …yet `OnWndMsg` returns FALSE for WM_CREATE → `CWnd::Default` → `DefWindowProcA` ✗

**Only hypothesis #5 remains: message-map chain walk fails inside OnWndMsg.**
Most likely: `CMainFrame::messageMap` static (in EXE .rdata) has a
`pBaseMap` pointer that references `CFrameWnd::messageMap` (in mfc42.dll
.rdata) via a cross-module import thunk (`?messageMap@CFrameWnd@@...`).
If our DLL import resolution didn't patch this IAT slot, `pBaseMap` is
NULL/garbage and the walk stops without reaching `ON_WM_CREATE`.

### Dispatch trace (confirmed this session)

AfxCallWndProc disasm (mfc42 0x5f402223, runtime 0x01058223):
- At 0x5f40228e: `call [eax+0xa0]` where `eax = [pWnd]` — this is the
  **virtual `CWnd::WindowProc` call** (vtable slot 0xa0/4 = 40).
  Runtime addr of indirect: **0x0105828e**.
- `CWnd::WindowProc` internally calls `OnWndMsg(msg, wParam, lParam, &lResult)`
  which walks `GetMessageMap()` chain.
- Return value 0/FALSE → `CWnd::Default()` at end of WindowProc →
  `CallWindowProcA(m_pfnSuper=0x04e03550, ...)` → DefWindowProcA (trace #1187).

### Immediate next step

~~Break at 0x01058294 to see EAX after WindowProc virtcall.~~ **DONE but
inconclusive** (this session). For WM_CREATE on CPBFrame (pWnd=0x0158b994,
msg=1), EAX=0 at 0x01058294. But for WM_CREATE, return 0 means "success"
regardless of whether OnWndMsg handled it or DefWindowProcA did — both
return 0 on successful create. So EAX=0 doesn't discriminate.

CPBFrame's vtable slot 40 (offset 0xa0) → `0x0102e8d0` → `jmp [0x0100123c]`
IAT import for `CWnd::WindowProc` from mfc42 — routes correctly.

### Class name correction

The main frame class is **`CPBFrame`** (from CRuntimeClass classname at
0x01004390), not CMainFrame. CRuntimeClass struct at 0x01004118:
- classname ptr → "CPBFrame"
- objectSize = 0x338 (824 bytes)
- pfnGetBaseClass at 0x0102889b = `mov eax, [0x01001454]; ret` — reads IAT
  for `CFrameWnd::classCFrameWnd`.

### Imports ARE patched

Runtime dump of IAT slot 0x01001454 = **0x010ef280** — in mfc42's .rdata
range (0x010ee000+). The import resolved correctly. So cross-module thunks
work, which weakens hypothesis #5 (it'd have to be a *specific* unresolved
thunk for the message-map chain — possible but less likely).

### New hypotheses

7. **WM_CREATE never reaches AfxWndProc for hwnd=0x10001.** The two-call
   sequence #1186 CallWindowProcA(pfn=0x04e03550=placeholder, hwnd=0x10001,
   WM_CREATE) + #1187 DefWindowProcA is suspicious. If our host's
   CreateWindowExA synthesizes WM_CREATE by calling the **class wndproc**
   (stored at class-registration time) instead of the current hwnd wndproc
   (post-subclass), WM_CREATE bypasses AfxWndProc entirely. The subclass
   was done via SetWindowLongA at #1174, so a correct dispatch should
   re-fetch GWL_WNDPROC. Check `$handle_CreateWindowExA` in
   `09a5-handlers-window.wat`.
8. **Both paths fire.** Trace-at #1 at 0x01058294 (inside AfxCallWndProc)
   DID hit with msg=1 and the correct pWnd, proving AfxWndProc also sees
   WM_CREATE. So WM_CREATE reaches AfxWndProc. But #1186+#1187 also fire.
   That means TWO WM_CREATE dispatches happen — or AfxWndProc's Default()
   really does chain to the class wndproc placeholder after OnWndMsg
   returns FALSE.

### Most efficient next probe

~~Hypothesis #7 (CreateWindowExA uses class wndproc not subclassed wndproc)~~
**RULED OUT** (this session). 09b-dispatch.wat line 166 in the CACA0002
(CBT-hook continuation) path:
```
(global.set $eip (call $wnd_table_get (global.get $createwnd_saved_hwnd)))
```
This fetches the CURRENT wndproc from the window table, which was updated
by SetWindowLongA's `wnd_table_set` call at 09a-handlers.wat:1472. So WM_CREATE
IS correctly dispatched to AfxWndProc post-subclass.

Also verified: SetWindowLongA returns the old (class) wndproc 0x04e03550
(DefWindowProcA thunk), which MFC stores in `CWnd::m_pfnSuper` (offset 0x2C).
That's exactly what later shows up in trace #1186 via `CallWindowProcA(m_pfnSuper,
...)` from `CWnd::Default()` — consistent with OnWndMsg returning FALSE.

### Summary of ruled-out paths

The entire mechanical chain works:
1. CBT hook fires with correct `m_pWndInit` ✓
2. CWnd::Attach populates m_hWnd at [pWnd+0x20] and handle map ✓
3. SetWindowLongA swaps GWL_WNDPROC to AfxWndProc; old wndproc saved as
   m_pfnSuper ✓
4. WM_CREATE dispatched to AfxWndProc (via `wnd_table_get`) ✓
5. AfxWndProc → FromHandlePermanent returns correct CPBFrame* 0x0158b994 ✓
6. AfxCallWndProc invokes virtual `CWnd::WindowProc` (vtable+0xa0) ✓
7. IAT slot for cross-module `CFrameWnd::classCFrameWnd` is patched ✓
8. …yet WM_CREATE chains down to DefWindowProcA via m_pfnSuper.

### Final narrowed target: OnWndMsg's map walk

The remaining failure has to be inside mfc42's `CWnd::OnWndMsg` — either
`GetMessageMap()` on CPBFrame returns a map whose `lpEntries` doesn't
contain ON_WM_CREATE, or the `pBaseMap` chain walk stops early.

**Next-session plan:**

1. Find CPBFrame's `GetMessageMap` override. Scan mspaint.exe .text for
   `B8 ?? ?? ?? ?? C3` (`mov eax, imm; ret`) where imm points into mspaint's
   .data (0x0103b000-0x0103d4b4). Most MFC classes have this 6-byte stub
   right next to their other virtual overrides. The addr they return is
   `CPBFrame::messageMap`.
2. Dump the messageMap struct (8 bytes): `{ pBaseMap, lpEntries }`.
   Verify pBaseMap points to a valid CFrameWnd::messageMap (likely via
   another IAT slot) and lpEntries points to a nonzero array.
3. If map looks fine, trace inside `CWnd::OnWndMsg` (likely ~mfc42 offset
   0x29xx near AfxCallWndProc). Dump the first iteration's map entry
   struct and the search key — mismatch exposes either a byte-packing or
   signature-mismatch bug.

Then trace inside the virtcall target: read `[0x010043a4 + 0xa0]` (CMainFrame
vtable slot 0x28 / offset 0xa0) to find which function it points to. If
it's `CWnd::WindowProc` in mfc42 (~0x5f40xxxx → runtime 0x0105xxxx), trace
its entry to see what `pWnd->GetMessageMap()` returns — that gives the
first `AFX_MSGMAP*`. Then dump the struct: if `pBaseMap` is garbage or
`lpEntries` points to an empty/sentinel-only array, the EXE's
CMainFrame::messageMap wasn't relocated and/or the IAT thunk for
`CFrameWnd::messageMap` wasn't patched.

### Suggested next diagnostics

- **Verify Attach's virtcalls execute.** Trace at `0x0105780e` (after first
  `call [eax+0x58]`) and `0x01057818` (after `call [eax+0x88]`) — if the trace
  never fires, our indirect-call decoder is tripping on the attach path.
  Also dump the CWnd at ESI — after Attach, `m_hWnd` (offset 4) should equal
  the real hwnd (0x10001 / 0x10002), not the bogus `0x00000001` seen pre-attach.
- **Inspect CMainFrame's message map at runtime.** AfxWndProc's `OnWndMsg`
  reads `pWnd->GetMessageMap()` (virtual). That returns a `const AFX_MSGMAP*`
  in .rdata: `{ pBaseMap, lpEntries }`. If `pBaseMap` wasn't relocated, the
  chain breaks one level up and ON_WM_CREATE entries defined on CMainFrame
  won't resolve. Grep .reloc entries for the CMainFrame message-map address.
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
