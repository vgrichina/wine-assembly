#!/usr/bin/env node
'use strict';
//
// control-variant-gate.js — the completeness + wrong-variant gate for the
// per-window CONTROL STATE union in src/09c3-controls.wat
// (docs/watx-layout-migration-design.md §5.4, §6.1, §6.2; wave 7, class B).
//
// ── tl;dr (ASCII) ───────────────────────────────────────────────────────────
//
//   WND_RECORDS.state_ptr points at a per-class state block that each control
//   wndproc allocates for itself in WM_CREATE. It is a DISCRIMINATED UNION and
//   a stronger one than GdiObject:
//
//     * no shared prefix — even +0 is a guest text POINTER for Button/Static/
//       Combo/Edit, a signed `min` for Progress/TrackBar, an item COUNT for
//       ListView and a selected index for ColorGrid;
//     * no shared size — 8/12/16/20/24/40/44/56/64/72/80/128 bytes;
//     * no in-record discriminant — GdiObject carries its type at +4, this
//       carries nothing. The tag is CONTROL_TABLE.class and, operationally,
//       *which wndproc allocated the block*.
//
//   So there is no (layout ControlState), and deliberately no
//   `ControlStateAny`: there would be nothing true to put in it. There is one
//   partial view, `ControlTextState`, over the exactly four variants that do
//   agree on text_buf_ptr@0 / text_len@4 — the GdiPenBrush precedent.
//
//   Picking the variant at a site is a TYPING decision no codemod can make.
//   Here it is unusually cheap, because almost every site sits in a function
//   whose own name states the class, so this tool holds that mapping as DATA
//   and the build checks it:
//
//     1. NO RAW SITE. A hand-spelled offset off a control-state base — in
//        EITHER spelling, `(i32.add (local.get $sw) (i32.const N))` or
//        `offset=N (local.get $sw)` — fails the build. This is the §6.1
//        back-stop: it is what stops the migration silently reversing.
//     2. EVERY converted site must be ATTRIBUTED. A (load.field …) naming one
//        of these layouts inside a function this table does not map to that
//        layout fails, so a new function cannot reach for a variant without
//        someone deciding it is that class.
//     3. EVERY attributed function must exist, and every attributed function
//        that is expected to carry sites must carry at least one — an entry
//        that has rotted off its function is dead attribution, and dead
//        attribution reads like coverage it no longer has.
//     4. The layouts must be declared with the sizes their allocators use, so
//        a field added or reordered without moving the heap_alloc is caught.
//
//   Byte identity is NOT an oracle for any of this. All 541 converted sites
//   compile to the bytes they replaced (measured: the wasm is unchanged at
//   1ed8e600…), which is exactly why it says nothing about whether the NAME is
//   true. This gate is what carries that half.
//
// ── usage ──────────────────────────────────────────────────────────────────
//
//   node tools/control-variant-gate.js            # check; exit 1 on failure
//   node tools/control-variant-gate.js --list     # per-function site counts
//
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', '09c3-controls.wat');
const REL = 'src/09c3-controls.wat';

// The bases a control-state record is reached through in this file. Both are
// plain locals/params; the migration left NO raw arithmetic on either, so any
// reappearance is a new hand-spelled offset against a union member.
const BASES = ['sw', 'state_w'];

// Declared size of each variant, and the allocation that pins it. The size is
// checked against the (layout …) actually in the file; the allocator is cited
// so the next reader can re-derive it rather than trust this table.
const VARIANTS = {
  ButtonState:        { size: 72,  alloc: '$button_wndproc WM_CREATE heap_alloc 72' },
  StaticState:        { size: 20,  alloc: '$static_wndproc / $syslink_wndproc heap_alloc 20' },
  ProgressState:      { size: 16,  alloc: '$progress_wndproc heap_alloc 16 (twice: WM_CREATE + lazy)' },
  TrackBarState:      { size: 24,  alloc: '$trackbar_wndproc heap_alloc 24' },
  ListBoxState:       { size: 56,  alloc: '$listbox_wndproc heap_alloc 56' },
  ComboBoxState:      { size: 44,  alloc: '$combobox_wndproc heap_alloc 44' },
  ListViewState:      { size: 80,  alloc: '$listview_wndproc heap_alloc 80' },
  EditState:          { size: 40,  alloc: '$edit_wndproc WM_CREATE heap_alloc 40' },
  ColorGridState:     { size: 8,   alloc: '$colorgrid_wndproc heap_alloc 8' },
  ColorSpectrumState: { size: 12,  alloc: '$colorspectrum_wndproc heap_alloc 12' },
  TooltipState:       { size: 64,  alloc: '$tooltip_wndproc heap_alloc 64' },
  ToolbarState:       { size: 80,  alloc: '$toolbar_ensure_state heap_alloc 80' },
  TabNativeState:     { size: 128, alloc: '$tab_native_state_get heap_alloc 128' },
  // The partial view. Not an allocation of its own: it is a window onto the
  // first two words of ButtonState / StaticState / ComboBoxState / EditState,
  // which are the only four variants that agree there.
  ControlTextState:   { size: 8,   alloc: 'VIEW over Button/Static/ComboBox/Edit +0/+4', view: true },
};

// ── The attribution, which IS the reverse-engineering result ────────────────
//
// Keyed by enclosing function, because that is where the evidence lives: the
// wndproc that ran heap_alloc in WM_CREATE, or a helper whose name carries the
// class it serves. Anything whose class is NOT obvious from the name is listed
// at the bottom with the line of evidence that decided it.
const BY_FUNCTION = {};
const add = (variant, names, why) => {
  for (const n of names) {
    if (BY_FUNCTION[n]) throw new Error(`attribution: ${n} listed twice`);
    BY_FUNCTION[n] = { variant, why };
  }
};

// Accessor layers. Each function's NAME is the field name, so the mapping is
// self-evidencing: $btn_flags is ButtonState.flags and cannot be anything else.
add('ButtonState', [
  '$btn_text_ptr', '$btn_set_text_ptr', '$btn_text_len', '$btn_set_text_len',
  '$btn_flags', '$btn_set_flags', '$btn_ctrl_id', '$btn_set_ctrl_id',
  '$btn_image_type', '$btn_image_handle', '$btn_set_image',
], 'accessor layer: the function name is the field name');

add('StaticState', [
  '$static_text_ptr', '$static_set_text_ptr', '$static_text_len',
  '$static_set_text_len', '$static_style', '$static_set_style',
  '$static_image_ord', '$static_set_image_ord', '$static_font', '$static_set_font',
], 'accessor layer; $syslink_wndproc allocates the same 20-byte shape and reads through these');

add('ProgressState', [
  '$prog_min', '$prog_set_min', '$prog_max', '$prog_set_max',
  '$prog_pos', '$prog_set_pos', '$prog_step', '$prog_set_step',
], 'accessor layer; $prog_state_init writes the comctl32 defaults 0/100/0/10 through these');

add('TrackBarState', [
  '$trk_min', '$trk_set_min', '$trk_max', '$trk_set_max', '$trk_pos', '$trk_set_pos',
  '$trk_line', '$trk_set_line', '$trk_page', '$trk_set_page',
  '$trk_thumb_len', '$trk_set_thumb_len',
], 'accessor layer; min/max/pos alias ProgressState +0/+4/+8, which is why the names matter');

add('ListBoxState', [
  '$lb_items_ptr', '$lb_set_items_ptr', '$lb_items_used', '$lb_set_items_used',
  '$lb_items_cap', '$lb_set_items_cap', '$lb_count', '$lb_set_count',
  '$lb_cur_sel', '$lb_set_cur_sel', '$lb_top_index', '$lb_set_top_index',
  '$lb_ctrl_id', '$lb_set_ctrl_id', '$lb_drag_anchor_y', '$lb_set_drag_anchor_y',
  '$lb_drag_anchor_top', '$lb_set_drag_anchor_top', '$lb_data_ptr', '$lb_set_data_ptr',
  '$lb_data_cap', '$lb_set_data_cap', '$lb_sel_ptr', '$lb_set_sel_ptr',
  '$lb_sel_cap', '$lb_set_sel_cap', '$lb_item_h', '$lb_set_item_h',
], 'accessor layer');

add('ComboBoxState', [
  '$cb_text_ptr', '$cb_set_text_ptr', '$cb_text_len', '$cb_set_text_len',
  '$cb_style', '$cb_set_style', '$cb_ctrl_id', '$cb_set_ctrl_id',
  '$cb_cur_sel', '$cb_set_cur_sel', '$cb_lb_hwnd', '$cb_set_lb_hwnd',
  '$cb_popup_hwnd', '$cb_set_popup_hwnd', '$cb_edit_hwnd', '$cb_set_edit_hwnd',
  '$cb_is_dropped', '$cb_set_is_dropped', '$cb_variant', '$cb_set_variant',
  '$cb_suppress_edit_notify', '$cb_set_suppress_edit_notify',
], 'accessor layer');

add('ListViewState', [
  '$lv_item_count', '$lv_set_item_count', '$lv_item_cap', '$lv_set_item_cap',
  '$lv_cells_ptr', '$lv_set_cells_ptr', '$lv_col_count', '$lv_set_col_count',
  '$lv_col_cap', '$lv_set_col_cap', '$lv_col_widths_ptr', '$lv_set_col_widths_ptr',
  '$lv_col_texts_ptr', '$lv_set_col_texts_ptr', '$lv_selected', '$lv_set_selected',
  '$lv_top_index', '$lv_set_top_index', '$lv_ctrl_id', '$lv_set_ctrl_id',
  '$lv_ex_style', '$lv_set_ex_style', '$lv_drag_anchor_y', '$lv_set_drag_anchor_y',
  '$lv_drag_anchor_top', '$lv_set_drag_anchor_top', '$lv_image_list', '$lv_set_image_list',
  '$lv_bk_color', '$lv_set_bk_color', '$lv_text_color', '$lv_set_text_color',
  '$lv_text_bk_color', '$lv_set_text_bk_color', '$lv_state_image_list',
  '$lv_set_state_image_list', '$lv_normal_image_list', '$lv_set_normal_image_list',
], 'accessor layer. NOTE the deliberate omissions: $lv_cell_addr, $lv_item_*_addr and ' +
   '$lv_copy_cell_text address the 44-byte CELL ROW that item_cells_ptr points at, ' +
   'which is a different record and is NOT part of this union');

// Edit has NO accessor layer — its sites are spelled inline across 43 helpers
// and the wndproc, which is why naming buys the most here. Every one of these
// is an $edit_* function and every $state_w in them is
// $g2w($wnd_get_state_ptr(<an edit hwnd>)).
add('EditState', [
  '$edit_copy_range', '$edit_delete_range', '$edit_doc_width', '$edit_ensure_cap',
  '$edit_hscroll_to', '$edit_insert_bytes', '$edit_insert_char', '$edit_layout_build',
  '$edit_layout_xy_to_offset', '$edit_line_from_char', '$edit_line_index',
  '$edit_line_len', '$edit_line_start', '$edit_reset_caret_timer',
  '$edit_scroll_caret_into_view', '$edit_scroll_to', '$edit_sel_hi', '$edit_sel_lo',
  '$edit_stop_caret_timer', '$edit_stream_project', '$edit_view_metrics',
  '$edit_wndproc', '$edit_word_end', '$edit_word_start', '$edit_xy_to_offset',
], 'the $edit_* functions that reach the record directly; it is the 40 bytes ' +
   '$edit_wndproc allocates in WM_CREATE. The other 18 $edit_* functions are ' +
   'deliberately absent — see the note above NO dead attribution');

add('TooltipState', [
  '$tooltip_wndproc', '$tooltip_item_ptr', '$tooltip_find_tool', '$tooltip_hit_test',
], 'the wndproc that heap_allocs 64 bytes, plus its three helpers, all taking that block as $sw');

add('TabNativeState', [
  '$tab_native_note_message', '$tab_native_paint',
], 'the two readers of $tab_native_state_get\'s 128-byte block');

add('ToolbarState', [
  '$toolbar_ensure_state', '$toolbar_button_ptr', '$toolbar_button_raw_width',
  '$toolbar_child_combo_width_by_cmd', '$toolbar_ensure_capacity',
  '$toolbar_find_command_index', '$toolbar_button_width', '$toolbar_layout_width',
  '$toolbar_button_rect', '$toolbar_calc_rows', '$toolbar_sync_child_combos',
  '$toolbar_hit_test', '$toolbar_autosize', '$toolbar_wndproc',
], 'every $toolbar_* function whose $sw is the 80-byte block $toolbar_ensure_state allocates. ' +
   '$toolbar_init_button / $toolbar_copy_button_in are NOT here: they address a 20-byte ' +
   'TBBUTTON snapshot, not this record');

add('ColorGridState', [
  '$colorgrid_wndproc',
], 'the wndproc that heap_allocs 8 bytes and stores -1 then CREATESTRUCT.hMenu');

add('ColorSpectrumState', [
  '$colorspectrum_commit', '$colorspectrum_wndproc',
  '$colordlg_sync_spectrum_from_rgb', '$colordlg_commit_hsl_edits',
], 'the HSL picker\'s own wndproc, plus the two colour-dialog helpers that reach it by ' +
   'control id 0x467; $colorspectrum_commit passes +0/+4/+8 positionally to ' +
   '$colordlg_hsl_to_rgb (param $h) (param $s) (param $l), which is what names the three words');

// ── Borrowers: functions that hold someone ELSE's control state ─────────────
// These are the entries whose class is not readable from the function name, so
// each carries the line of evidence that decided it.
add('EditState', ['$opendlg_trigger_download'],
  'reads the state of $edit = the file-name EDIT it just looked up, to build "C:\\" + name');
add('EditState', ['$findreplace_copy_edit_to_buffer'],
  'copies the find/replace EDIT\'s text into the guest FINDREPLACE buffer');
add('EditState', ['$shelldlg_wndproc'],
  'reads $shelldlg_edit_hwnd\'s state; the code comment beside it says so — ' +
  '"An EDIT keeps its text pointer at +0 of its state block and the length at +4"');
add('ComboBoxState', ['$combobox_relayout_children'],
  'reads +28 = edit_hwnd to move the combo\'s inner EDIT child');
// The one genuinely class-agnostic pair, and the reason ControlTextState exists.
add('ControlTextState', ['$ctrl_decimal_value', '$ctrl_inches_milli'],
  'looks a control up by DIALOG ID and parses whatever text it has, so it must NOT claim ' +
  'a class: it is used on Print/PageSetup EDITs but nothing in the function restricts it ' +
  'to one. It reads only +0/+4, which is exactly where Button/Static/ComboBox/Edit agree');

// There is deliberately NO "attributed but siteless" allowance. A function that
// does not reach the record does not need an attribution, and listing one is
// how dead attribution accumulates: it reads as coverage that is no longer
// there. If such a function later grows a site, check (2) fires as
// NOT ATTRIBUTED and somebody has to decide its class — which is the point.
// This is why $edit_wraps, $edit_stream_read, $toolbar_repaint_now and six
// others are absent below despite being obvious members of their families:
// they reach their state only through helpers, so they are not attributed.

function main() {
  const list = process.argv.includes('--list');
  const src = fs.readFileSync(FILE, 'utf8');
  const lines = src.split('\n');
  const errors = [];

  // ── (4) the layouts, and their sizes ─────────────────────────────────────
  const declared = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\(layout\s+(\w+)\s*$/.exec(lines[i]);
    if (!m) continue;
    let size = 0, j = i + 1;
    for (; j < lines.length; j++) {
      // A field's trailing comment may continue on its own line (EditState's
      // `flags` does). Skip pure-comment lines rather than reading them as the
      // end of the layout — doing so measured EditState at 28 bytes instead of
      // 40 and made the size check fire on a correct declaration.
      if (/^\s*;;/.test(lines[j])) continue;
      const f = /^\s*\(field\s+(\w+)\s+(\w+)(?:\s+(\d+))?\s*\)?\)?\s*(;;.*)?$/.exec(lines[j]);
      if (!f) break;
      const width = { i32: 4, ptr: 4, weak: 4, u8: 1, s8: 1, u16: 2, s16: 2, i64: 8, f32: 4, f64: 8 }[f[2]];
      if (width === undefined) { errors.push(`${REL}:${j + 1}: unknown field type '${f[2]}'`); break; }
      size += width * (f[3] ? parseInt(f[3], 10) : 1);
      if (/\)\)\s*(;;.*)?$/.test(lines[j])) { j++; break; }
    }
    declared[m[1]] = { size, line: i + 1 };
  }
  for (const [name, spec] of Object.entries(VARIANTS)) {
    const d = declared[name];
    if (!d) { errors.push(`layout ${name} is not declared in ${REL} — this gate's variant table has rotted`); continue; }
    if (d.size !== spec.size)
      errors.push(`${REL}:${d.line}: layout ${name} is ${d.size} bytes, expected ${spec.size} (${spec.alloc})`);
  }

  // ── walk the file, tracking the enclosing function ───────────────────────
  const sitesByFunc = new Map();   // func -> Map(variant -> count)
  let fn = '(top level)';
  const rawRe = new RegExp(
    'i32\\.(?:load|store)[a-z0-9_]*\\s+(?:offset=\\d+\\s+)?\\(local\\.get \\$(' + BASES.join('|') + ')\\)' +
    '|i32\\.(?:load|store)[a-z0-9_]*\\s+\\(i32\\.add \\(local\\.get \\$(' + BASES.join('|') + ')\\)');
  const fieldRe = /\((?:load|store)\.field(?:-elem)?(?:\.memarg)?\s+(\w+)\s/g;

  for (let i = 0; i < lines.length; i++) {
    const f = /^\s*\(func\s+(\$[\w.]+)/.exec(lines[i]);
    if (f) fn = f[1];

    // (1) NO RAW SITE — both spellings.
    if (rawRe.test(lines[i]))
      errors.push(`${REL}:${i + 1}: ${fn}: hand-spelled offset off a control-state base. ` +
        `Use (load.field.memarg <Variant> <field> ptr) / (store.field…) — the variant comes ` +
        `from the class of the window whose state_ptr this is, not from the record.`);

    // (2) every converted site must be attributed.
    let m;
    fieldRe.lastIndex = 0;
    while ((m = fieldRe.exec(lines[i])) !== null) {
      const variant = m[1];
      if (!VARIANTS[variant]) continue;             // some other family's layout
      const att = BY_FUNCTION[fn];
      if (!att) {
        errors.push(`${REL}:${i + 1}: ${fn} reaches ${variant} but is NOT ATTRIBUTED. ` +
          `Decide which control class owns this pointer and add it to BY_FUNCTION with the evidence.`);
      } else if (att.variant !== variant) {
        errors.push(`${REL}:${i + 1}: ${fn} is attributed to ${att.variant} but reaches ${variant}.`);
      }
      if (!sitesByFunc.has(fn)) sitesByFunc.set(fn, new Map());
      const c = sitesByFunc.get(fn);
      c.set(variant, (c.get(variant) || 0) + 1);
    }
  }

  // (3) no dead attribution.
  const declaredFns = new Set();
  for (const line of lines) {
    const f = /^\s*\(func\s+(\$[\w.]+)/.exec(line);
    if (f) declaredFns.add(f[1]);
  }
  for (const [name, att] of Object.entries(BY_FUNCTION)) {
    if (!declaredFns.has(name)) {
      errors.push(`attribution names ${name} (${att.variant}), which is not a function in ${REL}`);
      continue;
    }
    if (!sitesByFunc.has(name))
      errors.push(`attribution names ${name} (${att.variant}) but it has no site — dead attribution. Remove it.`);
  }

  if (list) {
    const rows = [...sitesByFunc.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let total = 0;
    for (const [name, counts] of rows)
      for (const [variant, n] of counts) {
        total += n;
        console.log(`  ${String(n).padStart(4)}  ${variant.padEnd(20)} ${name}`);
      }
    console.log(`  ${String(total).padStart(4)}  TOTAL over ${rows.length} function(s), ` +
      `${Object.keys(VARIANTS).length} variants`);
  }

  if (errors.length) {
    for (const e of errors) console.error(`control-variant-gate: ${e}`);
    console.error(`control-variant-gate: ${errors.length} problem(s).`);
    process.exit(1);
  }
  const total = [...sitesByFunc.values()]
    .reduce((a, c) => a + [...c.values()].reduce((x, y) => x + y, 0), 0);
  console.log(`control-variant-gate: ok — ${total} site(s) across ` +
    `${Object.keys(VARIANTS).length} variants, ${sitesByFunc.size} function(s) attributed, ` +
    `0 raw offsets off a control-state base.`);
}

main();
