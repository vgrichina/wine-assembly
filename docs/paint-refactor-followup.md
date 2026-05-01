# Paint refactor — remaining work

Phase B steps 1–4 landed (commits `c522119`, `a0d4fcf`, `d014c0d`, `d8b3810`).
Region-driven WM_PAINT pump is live; mspaint baseline holds. The items
below are intentionally deferred — they form a coherent follow-up rather
than partial work.

## 1. Step 2 completion: migrate synthesized-hdc sites

**Why deferred.** Step 2a migrated the sites with natural alloc/release
pairs (GetDC/ReleaseDC, GetWindowDC, BeginPaint/EndPaint). The remaining
inline `(i32.add hwnd 0x40000)` / `0xC0000` sites synthesize an hdc that
gets handed to a wndproc which draws and discards — there is no return
trip that can call `host_release_dc`. Migrating them under the allocator
leaks records into `_dcTable` indefinitely.

**Sites still on the legacy encoding** (grep `0x40000\)|0xC0000\)` in
`src/*.wat`, post step 2a):

| File | Line | Pattern |
|------|------|---------|
| `src/09a-handlers.wat` | 7666 | WM_ERASEBKGND msg payload (wParam=hdc) |
| `src/09a4-handlers-gdi.wat` | 263 | CreateDC fake screen DC return |
| `src/09a5-handlers-window.wat` | 847, 992 | WM_ERASEBKGND / WM_PAINT msg payload |
| `src/09a8-handlers-directx.wat` | 1906 | DDraw forwarded hdc |
| `src/09c-help.wat` | 436 | help WM_PAINT inline hdc |
| `src/09c4-defwndproc.wat` | 69 | NCPAINT whole-window DC |
| `src/09c5-menu.wat` | 156, 231, 261, 472 | menu paint inline hdc (×4) |
| `src/09c3-controls.wat` | 1032, 1783, 2049, 2298, 2457, 3127, 4045, 4800, 4838, 4867, 5901 | control wndproc WM_PAINT inline hdc / DRAWITEMSTRUCT.hDC (×11) |

**Lifecycle options to investigate:**

- **Wndproc-completion hook.** The dispatch site that delivers WM_PAINT
  / WM_DRAWITEM / WM_ERASEBKGND knows when the wndproc returns. Add a
  "transient hdc" attribute to the DcRecord; wndproc-completion in
  GetMessageA / SendMessageA frees any transient record allocated since
  the call entered. Needs care for nested SendMessage.
- **Per-message ephemeral handle.** Dedicate a single hdc per
  message-loop tick that lives until `next_dirty_hwnd` is called again.
  Cheaper than per-call alloc; acceptable because the paint walks are
  serialized.
- **Keep legacy decoder as the resolver, but route through `_dcTable`
  for state.** Inline sites stay on `hwnd+0x40000` encoding; only the
  per-DC GDI state (penColor, brushColor, …) lives in the table. Pure
  refactor benefit, no leak. Step 5 cleanup deletes `_dcState` only,
  keeps the decoder.

**Gate to chase:** `grep -rn '0x40000\|0xC0000' src/*.wat | grep -v
'0x4000000\|0xC000000'` returns 0, AND `_dcTable.size` over a long
mspaint session stays bounded.

## 2. Step 5: delete legacy decoders

Blocked on (1). Once every site uses `_dcTable`:

- Delete `_isWindowDC`, `_isWholeWindowDC`, `_isSurfaceDC`, `_hwndFromDC`
  in `lib/host-imports.js`.
- Delete `_legacyGetDrawTarget` (the original `_getDrawTarget` body).
- Delete `_dcState` and its 11 references — state moves into DcRecord.
- Confirm no callers: `grep -rn _isWindowDC\|_hwndFromDC\|_dcState lib/
  src/ host.js` returns 0.
- The `+ 0x40000` / `+ 0xC0000` arithmetic in WAT must be gone first.

Also delete the dead paint-pump scaffolding in `src/09a5-handlers-window.wat`
that step 4 obsoleted — `paint_pending` global setters that no longer
gate dispatch, and `paint_flag_take`/`paint_flag_first`/`paint_flag_any`
if no other consumer remains. Keep PAINT_FLAGS only if a non-pump
consumer uses it.

## 3. gdi_fill_rect ≥80%-coverage sibling auto-invalidate

**What.** When `gdi_fill_rect` (or any primitive that erases parent
background) hits a window without WS_CLIPCHILDREN, walk children and
seed their `_updateRgns` for any rect overlap. Trigger only when the
fill covers ≥80% of the client area, so child-internal draws aren't
treated as background erases.

**Why deferred.** This is a behavior change with no obvious test that
exercises it under the new pump. Better to land in isolation against a
known-good baseline so a regression points at this change specifically.
Tracked in `project_mspaint_tool_palette_repaint.md` — the bug it
addresses is "tool button click wipes siblings from back-canvas." That
bug is independent of the A.2 pump fix and is still latent.

**Where.** Inside the `gdi_fill_rect` host import in
`lib/host-imports.js` (around line 2516). After resolving the target
hwnd, before drawing:

```js
if (target_hwnd_lacks_clipchildren && rect_covers_>=80%_of_client) {
  for each WS_CHILD intersecting rect:
    _invalRectHwnd(child, intersected_rect_in_child_coords);
}
```

**Gate.** Mspaint tool palette must still match baseline; clicking a
tool button must not lose sibling icons. New screenshot test under
`test/test-mspaint-tool-click.js` would lock this in.

## 4. Misc loose ends

- `host_alloc_window_dc` currently computes ox/oy at alloc time using
  the renderer's window record. If the window moves/resizes between
  alloc and use (rare but possible for long-lived GetDC handles), the
  stored offset is stale. `_resolveDcRecord` could re-resolve from
  `rec.hwnd` each call instead of trusting `rec.ox/rec.oy`. Decide
  per-kind: 'window'/'whole' should re-resolve; 'mem'/'surface' are
  fine static.
- The dual-path `_getDrawTarget` walks `_dcTable.get` first on every
  draw call. After step 5, the legacy fallback goes away and the check
  becomes a single Map lookup; until then it's a free hot-path branch.
  Don't optimize until step 5 lands.
