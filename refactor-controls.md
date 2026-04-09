# Refactor: Controls as Real Windows, JS as Dumb Renderer

Status: STEPs 1-6 done. STEP 7 (route guest CreateWindowExA EDIT/BUTTON/STATIC
through WAT) next — high risk, see Risk register.
Owner: TBD.
Test gate: `test/test-find-typing.js` (6/6, now driven through WAT-side
EditState via new `get_edit_text` / `send_char_to_focus` exports as of
STEP 6 in commit c3f8ecf).

## Goal

Move all control state and behavior into WAT wndprocs so that:

1. Every dialog control (Edit, Button, Static, etc.) is a real entry in `WND_TABLE` with its own `hwnd`, `parentHwnd`, `wndproc`, `style`, `extra_ptr`, `text_ptr`. Same model as a guest-created `CreateWindowExA` child.
2. Input routing (mouse, keyboard, focus) is done by `hwnd`, not by special-case JS pointers like `_focusedDialogEdit`.
3. Control logic — typing into an edit, pressing a button, toggling a checkbox, dialog tab traversal — lives in `$wndproc_edit` / `$wndproc_button` / `$wndproc_static` / `$wndproc_dialog` in WAT.
4. JS becomes a "dumb renderer": it owns the canvas, fonts, color palette, and primitive draw functions. It does NOT track focus, hit-test controls, mutate edit text, or contain any dialog-specific code.

This is **not** justified as a fix for the "Find dialog won't open" bug — that's a separate notepad x86 issue (see `project_notepad_find_dialog.md` memory). The refactor's value is architectural: one window model, real Win32 semantics for `GetDlgItem` / `EnumChildWindows` / `GetFocus`, and far less JS code.

## Current state (snapshot, 2026-04-08, after Commits A+B)

Already in the tree:

- **`WND_RECORDS`** at `0x00002000`, 64 entries × 24 bytes (ends `0x2600`). Single record per window with fields `hwnd`, `wndproc`, `parent`, `userdata`, `style`, `state_ptr`. Replaced the four parallel arrays `WND_TABLE` / `PARENT_TABLE` / `USERDATA_TABLE` / `STYLE_TABLE` (Commit B `9f1e921`).
- **`CLASS_RECORDS`** at `0x00002D80`, 16 entries × 48 bytes (ends `0x3080`). Each record is `(name_hash, atom, WNDCLASSA[40])`. Replaced the parallel `CLASS_TABLE` + `WNDCLASSA_STORE` regions (Commit A `3761c6e`). `MAX_CLASSES = 16`.
- `CONTROL_TABLE` at `0x00002980`, 64 entries × 16 bytes (`ctrl_class`, `ctrl_id`, `check_state`, reserved). Still parallel-indexed to `WND_RECORDS` slot. Slated for deletion: its fields move into the per-class state struct reached via `WND_RECORDS.state_ptr`.
- `WNDPROC_WAT_NATIVE = 0xFFFF0001` (help wndproc).
- `WNDPROC_CTRL_NATIVE = 0xFFFF0002` (built-in control dispatcher) — already wired in `$wat_wndproc_dispatch`.
- `$button_wndproc` skeleton in `src/09c3-controls.wat` (BM_GETCHECK, BM_SETCHECK only).
- `$ctrl_table_set`, `$ctrl_table_get_class`, `$ctrl_get_check_state`, `$ctrl_set_check_state`, `$ctrl_find_by_id`.
- `$wnd_get_state_ptr` / `$wnd_set_state_ptr` in `src/09c-help.wat` — accessors for the new `state_ptr` field. Currently unused; first caller will be `$button_wndproc` in STEP 3.
- `$heap_alloc` / `$heap_free` in `src/10-helpers.wat`. Free-list allocator with 4-byte size header. Returns guest pointers (use `$g2w` to get a WASM linear address).
- `$host_show_find_dialog` host import → `lib/renderer.js: showFindDialog()` — JS-side fake, controls live as `win.controls[]` sub-objects with no hwnd.
- `_focusedDialogEdit` / `_focusedDialogEditWin` in `lib/renderer-input.js` — special-case state used only by find/about dialogs.
- Notepad's main edit area IS already a real child window (`parentHwnd: 0x10001`, `isEdit: true`). It receives focus, keys, scroll, selection — all via the same JS path. This proves the model works; we just need to extend it to dialog controls and move the logic into WAT.

## Key design decisions (revisited)

| Question | Answer |
|---|---|
| Where do per-window records live? | `WND_RECORDS` at `0x2000`, 64 × 24 bytes. Each record carries `state_ptr` directly — no parallel index tables. |
| Where do "extra bytes" (per-class state) live? | `$heap_alloc` from the existing guest heap. The wndproc allocates a `WndState`-shaped struct in `WM_CREATE` and stores its pointer in `WND_RECORDS.state_ptr` via `$wnd_set_state_ptr`. Same allocator that serves guest `LocalAlloc` / `HeapAlloc` / `GlobalAlloc`. **No new heap region**, no `CONTROL_HEAP` constant. |
| Where do control text buffers live? | Inside the per-window state struct: `state->text_ptr` is itself a `$heap_alloc`'d guest buffer. `SetWindowText` frees old, allocs new, copies, updates `state->text_ptr`. Matches real Win32 `USER32` semantics exactly. |
| What if the guest stomps a control's heap block? | That happens in real Windows too (USER32 lives in process address space). Not a concern. `WND_RECORDS` itself at `0x00002000` is below `GUEST_BASE` (`0x00012000`) so the guest cannot reach it via image-relative pointers anyway. |
| New host imports? | **No high-level draw_button-style imports.** JS exposes only GDI primitives (`gdi_rectangle`, `gdi_fill_rect`, `gdi_draw_edge`, `gdi_draw_text`, `gdi_move_to` / `gdi_line_to`, `gdi_create_pen` / `gdi_create_solid_brush` / `gdi_select_object`, `gdi_bitblt`, `measure_text`, `get_text_metrics`). WAT wndprocs **compose** buttons / edits / checkboxes from these in `WM_PAINT`. Same model as real USER32, which has no "draw button" syscall. Only add new `gdi_*` imports if a primitive is missing (e.g. `gdi_clip_rect` for scrolled edits — defer until needed). |
| Focus tracking? | Single global in WAT: `$focused_hwnd`. `WM_SETFOCUS` / `WM_KILLFOCUS` go through normal dispatch. Delete JS-side `_focusedDialogEdit`. |
| JS still drives input? | Yes: JS owns `<canvas>` events. `onMouseDown(x,y,btn) → wasm.exports.host_mouse_down(x,y,btn)`. `onChar(code) → wasm.exports.host_char(code)`. WAT does hit-test, focus assignment, message dispatch. JS is just a transport. |
| What about WAT-native help window? | Already follows this model (sort of). Eventually fold `$help_wndproc` into the new framework as just another class. Out of scope for this refactor — it works today, leave it alone. |

## Memory layout (current, after Commits A+B)

```
 0x00002000  WND_RECORDS    64 × 24    ends 0x2600   (Commit B — unified per-window record)
 0x00002600  (free)
 0x00002980  CONTROL_TABLE  64 × 16    ends 0x2D80   (existing — slated for deletion into state_ptr)
 0x00002D80  CLASS_RECORDS  16 × 48    ends 0x3080   (Commit A — merged class table + WNDCLASSA)
 0x00003080  (free → 0x4000 API_HASH_TABLE)
```

Per-window record fields:
```
 +0   hwnd
 +4   wndproc
 +8   parent
 +12  userdata    (GWL_USERDATA)
 +16  style
 +20  state_ptr   (heap ptr to WndState; 0 if none)
```

Per-class record fields:
```
 +0   name_hash   (0 = empty slot)
 +4   atom        (assigned at registration)
 +8   WNDCLASSA[40]  (lpfnWndProc lives at record+12)
```

The pre-flight assumption that `0x2700–0x2980` was free was wrong — that
region was being used by `RegisterClassA` to back `GetClassInfoA`, with no
named global declared for it. Commit A reorganized that into `CLASS_RECORDS`.

## Per-class state struct layouts (allocated via `$heap_alloc`)

Each wndproc allocates one of these in `WM_CREATE` and stores the pointer
in `WND_RECORDS.state_ptr` via `$wnd_set_state_ptr(hwnd, ptr)`. The pointer
is read back via `$wnd_get_state_ptr(hwnd)`.

```
 EditState  (32 bytes, allocated in WM_CREATE)
   +0   text_buf_ptr   guest ptr from $heap_alloc
   +4   text_len
   +8   text_cap
   +12  cursor
   +16  sel_start
   +20  scroll_top
   +24  flags          bit0=multiline bit1=password bit2=readonly bit3=focused
   +28  max_length     0 = unlimited

 ButtonState  (16 bytes)
   +0   text_buf_ptr
   +4   text_len
   +8   flags          bit0=pressed bit1=checked bit2=default bit3=focused
   +12  ctrl_id

 StaticState  (16 bytes)
   +0   text_buf_ptr
   +4   text_len
   +8   style          (SS_LEFT, SS_CENTER, SS_RIGHT, SS_ICON, SS_BITMAP)
   +12  reserved

 DialogState  (16 bytes — for the dialog window itself)
   +0   child_count
   +4   focused_child_idx
   +8   default_btn_hwnd
   +12  flags
```

Lifetime rule: the wndproc that allocates the state struct in `WM_CREATE`
is responsible for freeing it AND any sub-allocations (text buffers) in
`WM_DESTROY`, then calling `$wnd_set_state_ptr(hwnd, 0)`.

## Host imports — what's there, what's needed

**Rule:** controls are wndproc compositions, drawn via primitives. JS
exposes only GDI primitives; WAT wndprocs compose buttons / edits /
checkboxes by issuing primitive calls. There are **no** high-level
`draw_button` / `draw_edit` / `draw_checkbox` imports — those would
put look-and-feel in the renderer instead of in the wndprocs and break
the "JS as dumb renderer" goal. (See feedback memory
`feedback_compositions_in_wat.md`.)

### Already in the tree (WAT → JS, the GDI primitives WAT will call)

```
gdi_rectangle      (hdc, l, t, r, b)              filled rect with current pen+brush
gdi_fill_rect      (hdc, l, t, r, b, hbrush)      fill with given brush
draw_rect          (x, y, w, h, color)            simple raw-color fill (legacy, ok to use)
gdi_draw_edge      (hdc, l, t, r, b, edge, flags) ◄ THE button bevel: BF_RECT | BDR_RAISED*
gdi_draw_text      (hdc, text_ptr, n_count, rect, format, isWide)  with DT_CENTER, DT_VCENTER, etc.
draw_text          (x, y, text_ptr, len, color)   simple positioned text (no DC)
gdi_move_to        (hdc, x, y)                    for checkmark glyphs, focus rect, etc.
gdi_line_to        (hdc, x, y)
gdi_ellipse        (hdc, l, t, r, b)              for the radio button dot
gdi_arc            (hdc, l, t, r, b, xs, ys, xe, ye)
gdi_create_pen     (style, width, color) → handle
gdi_create_solid_brush (color) → handle
gdi_select_object  (hdc, handle) → previous
gdi_delete_object  (handle)
gdi_bitblt         (dst, dx, dy, w, h, src, sx, sy, rop)  for icon buttons
measure_text       (hdc, text_ptr, n_count) → pixel_width
get_text_metrics   (hdc) → (height | (avg_char_width << 16))
```

These are sufficient to draw a Win98 button:
1. `gdi_fill_rect` background with the face color brush.
2. `gdi_draw_edge` with `BF_RECT | BDR_RAISEDOUTER | BDR_RAISEDINNER`
   (or `BDR_SUNKENOUTER | BDR_SUNKENINNER` when pressed).
3. `gdi_draw_text` with `DT_CENTER | DT_VCENTER | DT_SINGLELINE`.
4. If focused: a 1px-inset dotted focus rectangle via `gdi_move_to` /
   `gdi_line_to` with a stock `DC_PEN`-style alternating pen, or just
   four short segments.

Same template for checkbox (small box + edge + checkmark glyph + text),
radio (ellipse + dot + text), groupbox (edge with text gap), edit
(sunken-edge frame + text + caret line + selection rect).

### Will likely need to add (small WAT → JS additions, judgment call)

- `gdi_intersect_clip_rect(hdc, l, t, r, b)` and matching save/restore —
  for clipping the visible row range of a scrolled multi-line edit.
  Defer until `$wndproc_edit` actually needs it.

### Already in the tree (JS → WAT, the input pump)

JS already calls `host_check_input` / `host_check_input_lparam` /
`host_check_input_hwnd` which WAT polls from the message loop. That
covers mouse + keyboard + focus events through a single channel. No
new mouse/keyboard imports needed — the existing event-poll pattern
fits the new wndproc model fine.

## Step-by-step migration plan

### Batch A — Foundation (no behavior change)

**STEP 0: Test gate.** (DONE 2026-04-08)
- `test/test-find-typing.js` exists.
- `test/run.js` extended with `focus-find` / `dump-find` / `keypress:CODE` / `keydown:VK` / `click:X:Y` event kinds in `--input`.
- Baseline: **6/6 PASS** as of commit `56ea4fe` (the upstream notepad Find dialog bug was fixed there — `DestroyWindow` no longer promotes `main_hwnd` to a child control).

**STEP 1: Unify window memory layout.** (DONE 2026-04-08)

Done as two commits, both verified against notepad/calc/mspaint and the
test gate:

- **Commit A** (`3761c6e`): Merged `CLASS_TABLE` (0x2200, parallel array of `(name_hash, wndproc, atom)`) and `WNDCLASSA_STORE` (0x2700, parallel verbatim WNDCLASSA copies) into a single 48-byte `CLASS_RECORDS` region at `0x2D80`. The wndproc field was previously duplicated across both regions. Added `MAX_CLASSES = 16` to replace the latent `MAX_WINDOWS=64` overrun bound used by class scans. New helpers `$class_record_addr`, `$class_wndclass_addr`. `$class_table_register` no longer takes a wndproc param — caller's subsequent memcpy fills `lpfnWndProc` at record+12.

- **Commit B** (`9f1e921`): Collapsed the four parallel per-window arrays (`WND_TABLE`, `PARENT_TABLE`, `USERDATA_TABLE`, `STYLE_TABLE`) into a single 24-byte `WND_RECORDS` region at `0x2000`. New `state_ptr` field at record+20. New helpers `$wnd_record_addr`, `$wnd_get_state_ptr`, `$wnd_set_state_ptr`. Side benefit: `$wnd_table_set` and `$wnd_table_remove` now zero the whole record on slot allocation/release, fixing a latent bug where recycled slots inherited stale parent/userdata/style.

`CONTROL_TABLE` at `0x2980` is unchanged; its fields (`ctrl_class`, `ctrl_id`, `check_state`) will move into the per-class state struct in a later step and the table will be deleted.

**STEP 2: Verify the existing GDI primitives are sufficient.**

No new high-level draw imports — see "Host imports" section above. The
GDI primitives WAT will need (`gdi_rectangle`, `gdi_fill_rect`,
`gdi_draw_edge`, `gdi_draw_text`, `gdi_move_to` / `gdi_line_to`,
`gdi_create_pen` / `gdi_create_solid_brush` / `gdi_select_object`,
`gdi_ellipse`, `gdi_bitblt`, `measure_text`, `get_text_metrics`) are
all already in `src/01-header.wat` and `lib/host-imports.js`.

Action: write a tiny prototype WAT function (in `09c3-controls.wat`,
near the existing `$button_wndproc` skeleton) that draws a fake button
at fixed coordinates as a sanity check that the primitives compose the
right Win98 look. Call it from a debug entry point only — do not wire
it to any wndproc yet. Once the look matches, delete the prototype and
move on to STEP 3.

If the prototype reveals a missing primitive (most likely candidate:
clipping), add it as a new `gdi_*` import — never as a `draw_button`
composition import.

**Build gate:** `bash tools/build.sh && node test/test-find-typing.js`. Must still report 6/6 (no regression).

### Batch B — First real wndproc

**STEP 3: Flesh out `$button_wndproc` + add `$static_wndproc`.** (DONE 2026-04-08)

Done in a single commit. Test gate stayed at 6/6 (`test-find-typing.js`),
plus notepad/calc/mspaint smoke clean. Code is dormant — no path delivers
WM_CREATE to a button today, so the new state-based branches sit unused
until STEP 5 wires WAT-side dialog creation.

Implementation notes:
- Added `PAINT_SCRATCH` global at WASM `0x2700` (16-byte RECT scratch
  inside the free `0x2600..0x2980` zone, below `GUEST_BASE` so the guest
  cannot reach it). `gdi_draw_text` needs a WASM-linear RECT pointer;
  this is the cheapest way to satisfy that without adding a new
  per-paint heap allocation.
- `ButtonState` allocated in WM_CREATE (16 bytes), pointer parked in
  `WND_RECORDS.state_ptr`. Text buffer is a separate `$heap_alloc`
  block, freed in WM_DESTROY before the state struct itself.
- `WM_LBUTTONUP` toggles checkbox/radio state via the button-kind nibble
  in `flags` (bits 4..7). Posting `WM_COMMAND(MAKEWPARAM(ctrl_id,BN_CLICKED), hwnd)`
  to the parent is left as a TODO — needs `$wnd_send_message` helper that
  routes to either WAT or x86 wndprocs, scheduled for STEP 5.
- `BM_GETCHECK` / `BM_SETCHECK` prefer the new `ButtonState.flags` bit 1
  when `state_ptr != 0`, falling back to the legacy `CONTROL_TABLE`
  `check_state` for the existing JS-side dialog path. This is what keeps
  the test gate at 6/6: today's path is unchanged.
- `$static_wndproc` mirrors the button shape (WM_CREATE / WM_DESTROY /
  WM_SETTEXT / WM_PAINT) and maps `SS_LEFT/CENTER/RIGHT` (low 4 bits of
  the style word stashed in `StaticState`) to
  `DT_LEFT/DT_CENTER/DT_RIGHT`.
- `$control_wndproc_dispatch` now routes class 3 → `$static_wndproc`
  alongside the existing class 1 → `$button_wndproc`.
- New helper `$ctrl_text_dup(src_guest, len) → guest_buf` centralizes
  the "alloc + memcpy + null-terminate" pattern used by both wndprocs.

**Original step description (kept for reference):**
- Handle `WM_CREATE`: `$heap_alloc` a `ButtonState`, copy ctrl_id from `CONTROL_TABLE`, alloc + copy text from `CreateWindowEx` args, call `$wnd_set_state_ptr(hwnd, state)`.
- Handle `WM_LBUTTONDOWN`: set `pressed=1`, `$host_invalidate(hwnd)`.
- Handle `WM_LBUTTONUP`: clear `pressed`, post `WM_COMMAND(parent, ctrl_id)`, invalidate. For checkbox/radio, toggle `checked`.
- Handle `WM_PAINT`: call `$host_BeginPaint`-equivalent to get an hdc, then compose using `gdi_fill_rect` (face brush) + `gdi_draw_edge` (BF_RECT | BDR_RAISEDOUTER | BDR_RAISEDINNER, or sunken when pressed) + `gdi_draw_text` (DT_CENTER | DT_VCENTER | DT_SINGLELINE). For checkbox: small box on the left + checkmark glyph via `gdi_move_to` / `gdi_line_to` if checked + text on the right. For radio: `gdi_ellipse` + filled center dot if checked + text. For groupbox: edge-drawn rectangle with a text gap at the top.
- Handle `WM_DESTROY`: free text buf, free state struct, `$wnd_set_state_ptr(hwnd, 0)`.
- Add `$wndproc_static` (paint only, no input — `gdi_draw_text` with the appropriate `DT_*` style flags).
- **Test path: not yet wired** — buttons in JS-side dialogs still go through the JS path.

### Batch C — Edit + first migrated dialog

**STEP 4: `$wndproc_edit`.**
- New file `src/09c4-wndproc-edit.wat` (or append to `09c3-controls.wat`).
- Handle `WM_CREATE` (alloc EditState + initial text buf, set state_ptr), `WM_CHAR` (insert char at cursor, grow buf via realloc-on-write pattern, invalidate), `WM_KEYDOWN` (backspace, delete, arrows, home, end), `WM_LBUTTONDOWN` (cursor positioning via `measure_text`), `WM_PAINT` (compose: `gdi_draw_edge` for the sunken frame, `gdi_fill_rect` for the white background, `gdi_draw_text` for each visible row, a 1px vertical line at the cursor pixel-X via `gdi_move_to` / `gdi_line_to`, a `gdi_fill_rect` for the selection highlight if any), `WM_SETFOCUS` / `WM_KILLFOCUS`, `WM_DESTROY`.
- Add `$focused_hwnd` global. `WM_SETFOCUS` updates it.
- Keypress dispatch: `host_char(code)` → look up `$focused_hwnd` → `$dispatch_message(focused, WM_CHAR, code, 0)` → routes via `$wat_wndproc_dispatch` → `$control_wndproc_dispatch` → `$wndproc_edit`.
- Register class names `EDIT` / `BUTTON` / `STATIC` in `$class_table` so `CreateWindowExA` from WAT-side can use them.

**STEP 5: `$create_findreplace_dialog` in WAT.** (DONE 2026-04-08, dormant
addition in commit `d95052b`, then activated in STEP 6)

Landed as additions to `src/09c3-controls.wat` rather than a new file:
- `$wnd_send_message` — routes WAT-native wndprocs (>= 0xFFFF0000) through
  `$wat_wndproc_dispatch`. x86 wndproc path is a TODO (returns 0); current
  consumers are all WAT-side controls.
- `$ctrl_create_child` — allocates a fresh hwnd, registers WNDPROC_CTRL_NATIVE,
  populates CONTROL_TABLE, builds a 48-byte CREATESTRUCT on the heap, delivers
  WM_CREATE so the wndproc allocates its state struct. Does NOT call
  `$host_create_window` — WAT-internal state only. Visual rendering still
  comes from the JS-side dialog created by `$host_show_find_dialog`.
  Visual unification deferred to STEP 8.
- `$create_findreplace_dialog(dlg, owner, fr_guest)` — caller provides
  pre-allocated `dlg` hwnd (typically the same hwnd handed to the renderer).
  Builds the 8 child controls with geometry mirroring `showFindDialog()`.
  Stashes the edit child hwnd in `$findreplace_edit_hwnd` for the test
  bridge.

Did NOT delete `lib/renderer.js: showFindDialog()` or the
`host.show_find_dialog` import — both still in use as the visual dialog
and as the source of the `[FindTextA]` log line the test gate looks for.
Visual deletion deferred to STEP 8 (requires renderer-side support for
WAT-managed child windows).

**STEP 6: Flip the test gate to read WAT-side EditState.** (DONE 2026-04-08,
commit `c3f8ecf`)

`$handle_FindTextA` now calls `$create_findreplace_dialog` after
`$host_show_find_dialog`, so each find-dialog open creates parallel WAT
state alongside the JS dialog. New WASM exports drive the test bridge:

- `get_findreplace_dlg` / `get_findreplace_edit` — find-dialog hwnds
- `get_focus_hwnd` / `set_focus_hwnd` — global `$focus_hwnd` accessors
- `send_char_to_focus(code)` — dispatches WM_CHAR via `$wnd_send_message`
- `get_edit_text(hwnd, dest_guest, max)` — copies EditState text into a
  guest scratch buffer (NUL-terminated, clamped)

`test/run.js` `focus-find` / `keypress` / `dump-find` event handlers
prefer the WAT path when those exports are available and fall back to
the legacy JS scan otherwise. The test gate stays at 6/6 but the
"editText=ABC" assertion now reads from `$edit_wndproc`'s `EditState`,
not from `editCtrl.editText` in JS.

**Critical bug fixed during STEP 6:** STEPs 4-5 dormant code repeatedly
used `i32.and` as a logical AND on pointer/length pairs (e.g.
`(if (i32.and src len) ...)`). For `src=0x40e5c4, len=1` the bitwise
AND is 0 because bit 0 of `0x40e5c4` is 0, so the guarded `memcpy` was
silently skipped. Found via three rounds of debug instrumentation. Fixed
across `$edit_ensure_cap`, `$edit_insert_char`, `$edit_wndproc`
(WM_GETTEXT, WM_PAINT text + caret), `$button_wndproc` (WM_GETTEXT), and
the new `get_edit_text` export by nesting two single-arg `if`s instead.

### Batch D — Sweep the rest

**STEP 6: Migrate other JS-fabricated dialogs.**
- About dialog (`showAboutDialog`).
- Calculator dialog (`_showCalculatorDialog`) — note: calc has special static id 403 (display field) which currently has hardcoded rendering in `drawWindow`. Move that into `$wndproc_static` with a flag, or handle via a calc-specific subclass.
- NSIS installer dialogs.
- Each migration deletes its `showXxxDialog` JS function and adds a `$create_xxx_dialog` WAT function.

**STEP 7: Route guest `CreateWindowExA` for EDIT/BUTTON/STATIC to WAT wndprocs.**
- In `$handle_CreateWindowExA`, when `class_name` matches `EDIT` / `BUTTON` / `STATIC` (case-insensitive), set the wndproc to `WNDPROC_CTRL_NATIVE` and let `$control_wndproc_dispatch` route by class.
- This unifies guest-side controls (e.g., notepad's main edit child, NSIS installer's textboxes) with builtin-dialog controls.
- **This is the hottest path in the test suite** — notepad's main edit area is here. Verify with full notepad regression: type into the main edit, scroll, select, save, etc.

**STEP 8: Delete dead JS code.**
- `lib/renderer-input.js`: remove `_focusedDialogEdit`, `_focusedDialogEditWin`, `_handleFindDialogButton`, `_editEnsureCursor`, `_editDeleteSelection`, `_hitTestEdit`, `handleKeyPress`'s edit-mutation branch, double-click word selection, drag-to-select. All of this becomes dead because input goes through `host_mouse_down` / `host_char` directly into WAT.
- `lib/renderer.js`: remove `setDlgItemText`, `checkDlgButton`, `setWindowClass`, `controls[]` arrays, `isFindDialog` / `isAboutDialog` branches, the entire control-drawing loop in `drawWindow` (it becomes wndproc-driven), child enumeration.
- Keep: `drawButton`, `drawEditArea`, `drawCheckbox`, `drawRadioButton`, `drawGroupBox`, `drawStaticText`, `drawTitleBar`, `drawMenuBar`, `drawWindowFrame`, color/font tables. These are the primitives the new host imports wrap.

## Risk register

- **`02-thread-table.wat` handler count.** Adding new WAT functions to the dispatch path may require bumping the `$handlers` table size. Build will fail loudly with a count mismatch — easy to catch.
- **Notepad main edit migration (STEP 7).** Most-tested code path. Migrate behind a flag if needed; have full notepad regression test ready.
- **Z-order with child windows.** Today only top-level windows participate in z-order. Children inherit. Don't change this; child controls should never compete with their parent for z-order.
- **Coordinate origin.** Today's child controls use parent-relative coords (notepad edit child). The find dialog's JS sub-objects ALSO use parent-relative coords (`ctrl.x`, `ctrl.y` in `showFindDialog`). Migration is geometry-preserving — just put the same numbers into the window table instead of `controls[]`.
- **Font metrics.** WAT needs to compute cursor pixel-X to position the caret. New `measure_text` host import is the cleanest solution; cache results in EditState if it becomes a hot path.
- **OOM in `$heap_alloc`.** Returns 0. Wndprocs must check and either fail-fast (`unreachable`) or return a `WM_CREATE` failure. Per project policy: fail-fast.
- **GetDlgItem from guest.** After STEP 7, guest `GetDlgItem(parent, id)` becomes `$ctrl_find_by_id` (already exists). Free.
- **`$cb` table** in `02-thread-table.wat`: control wndprocs are NOT in this table. They're called via direct `$control_wndproc_dispatch`, not via threaded code. No table changes needed for control wndprocs themselves. Only if/when we add new threaded-code opcodes (we don't here).

## What this refactor explicitly does NOT do

- Does NOT fix the notepad Find dialog upstream bug (`project_notepad_find_dialog.md`). That's a notepad x86 / BSS init issue.
- Does NOT touch the WAT-native help window (`$help_wndproc`, `0xFFFF0001`). It works today.
- Does NOT change `02-thread-table.wat` opcode dispatch.
- Does NOT change the PE loader, x86 decoder, ALU, FPU, SEH, or any non-window-system code.
- Does NOT change z-order semantics or window stacking.
- Does NOT introduce any new memory regions, allocators, or constants beyond `EXTRA_PTR_TABLE` / `TEXT_PTR_TABLE` / `TEXT_LEN_TABLE`.

## Pre-flight checklist (resolved)

- [x] **`0x2700–0x2980` was NOT free** — pre-flight assumption was wrong. The region was used by `RegisterClassA` to back `GetClassInfoA` (handler at `09a-handlers.wat:2187,2216,2896`), with no named global declared for it — that's why it didn't show up in any header grep. Resolved in Commit A by reorganizing into `CLASS_RECORDS` at `0x2D80`.
- [x] `$heap_alloc` returns guest pointers (verified `src/10-helpers.wat:60`).
- [x] `MAX_WINDOWS` is 64. Deferred: bump to 256 in a separate commit (see Open questions).
- [x] `WNDPROC_CTRL_NATIVE = 0xFFFF0002` wired in `$wat_wndproc_dispatch` at `09c-help.wat:234`.
- [x] `test/test-find-typing.js` baseline is **6/6 PASS** (not 2/6 as the original draft said — the upstream notepad bug was fixed in commit `56ea4fe` between the doc being written and the work starting).
- [x] Notepad regression: clean exit through `ExitProcess`. Calc: 3579 API calls clean. Mspaint: 1315 API calls clean.

## Open questions

- Should `MAX_WINDOWS` get bumped to 256 to leave headroom for many controls per dialog? With the unified record, the cost is `256 × 24 = 6 KB` (was `256 × (8+4+4+4) = 5 KB` across the old four tables, plus state_ptr makes it `256 × 4 = 1 KB` more). Cheap. **Recommend yes** — but as its own commit, not bundled into the controls work. Verify nothing assumes 64 (grep for `MAX_WINDOWS` and the literal `64` near window code).
- Should we add a `$wnd_create(parent, class_name, x, y, w, h, style, ctrl_id, text_ptr) → hwnd` helper now to centralize allocation, or keep call sites bespoke? **Recommend yes** — write it before STEP 5, use it from STEP 5 onward.
- Font measurement: WAT needs `measure_text`. Do we want one font per text or always the same monospace dialog font? Probably the latter for now. Add a `font_id` parameter so it's extensible.
- Should `CLASS_TABLE` ever grow beyond 16 entries? Notepad/calc/mspaint each register ≤ 3 classes, but a future heavy app (NSIS installer suite, mspaint-NT with MFC) may push this. Current latent overrun bound is now properly enforced (`MAX_CLASSES = 16`), so an overflow would hit the cap cleanly rather than corrupting `PARENT_TABLE` like the old code would have.

## Meta

This document is the source of truth for the refactor. If reality diverges (file paths, function names, table layouts), update this doc first, then the code. Don't let the doc rot — when finishing a step, update its checkbox here. When discovering a wrong assumption, fix it here before fixing it in code.
