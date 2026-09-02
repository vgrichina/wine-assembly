#!/usr/bin/env node
'use strict';
//
// control-variant-gate.js — the completeness + wrong-variant gate for the
// per-window CONTROL STATE layout family across the complete src/main.watx closure
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
const { parseSource, watxNodeLine } = require('./watx');
const { WAT_FILES } = require('../lib/wat-manifest');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILES = WAT_FILES.map((file) => `src/${file}`);

// The allocation that pins each variant. There is deliberately NO size here:
// the old gate duplicated all 13 numbers in this table and only interpolated
// `alloc` into an error string, so changing a real heap_alloc independently
// stayed green. The AST walk below reads the named local.set(call heap_alloc)
// sites and compares their literal arguments to the parsed layout size.
const alloc = (func, count = 1) => ({ func, target: '$state', count });
const VARIANTS = {
  ButtonState:        { allocators: [alloc('$button_wndproc')] },
  StaticState:        { allocators: [alloc('$static_wndproc'), alloc('$syslink_wndproc')] },
  ProgressState:      { allocators: [alloc('$progress_wndproc', 2)] },
  TrackBarState:      { allocators: [alloc('$trackbar_wndproc')] },
  ListBoxState:       { allocators: [alloc('$listbox_wndproc')] },
  ComboBoxState:      { allocators: [alloc('$combobox_wndproc')] },
  ListViewState:      { allocators: [alloc('$listview_wndproc')] },
  EditState:          { allocators: [alloc('$edit_wndproc')] },
  ColorGridState:     { allocators: [alloc('$colorgrid_wndproc')] },
  ColorSpectrumState: { allocators: [alloc('$colorspectrum_wndproc')] },
  TooltipState:       { allocators: [alloc('$tooltip_wndproc')] },
  ToolbarState:       { allocators: [alloc('$toolbar_ensure_state')] },
  TabNativeState:     { allocators: [alloc('$tab_native_state_get')] },
  // The partial view. Not an allocation of its own: it is a window onto the
  // first two words of ButtonState / StaticState / ComboBoxState / EditState,
  // which are the only four variants that agree there.
  ControlTextState:   { viewOf: ['ButtonState', 'StaticState', 'ComboBoxState', 'EditState'] },
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
  '$btn_flags', '$btn_set_flags',
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
  '$lb_drag_anchor_y', '$lb_set_drag_anchor_y',
  '$lb_drag_anchor_top', '$lb_set_drag_anchor_top', '$lb_data_ptr', '$lb_set_data_ptr',
  '$lb_data_cap', '$lb_set_data_cap', '$lb_sel_ptr', '$lb_set_sel_ptr',
  '$lb_sel_cap', '$lb_set_sel_cap', '$lb_item_h', '$lb_set_item_h',
], 'accessor layer');

add('ComboBoxState', [
  '$cb_text_ptr', '$cb_set_text_ptr', '$cb_text_len', '$cb_set_text_len',
  '$cb_style', '$cb_set_style',
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
  '$lv_top_index', '$lv_set_top_index',
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
add('EditState', [
  '$findreplace_native_richedit_replace', '$findreplace_native_richedit_find',
  '$findreplace_wndproc', '$opendlg_wndproc', '$wnd_send_message_inner',
], 'cross-control message/dialog paths resolve an EDIT hwnd before following its state_ptr');
add('EditState', ['$shelldlg_wndproc'],
  'reads $shelldlg_edit_hwnd\'s state; the code comment beside it says so — ' +
  '"An EDIT keeps its text pointer at +0 of its state block and the length at +4"');
add('ComboBoxState', ['$combobox_relayout_children'],
  'reads +28 = edit_hwnd to move the combo\'s inner EDIT child');
add('ComboBoxState', ['$combobox_hit_h'],
  'receives a combo hwnd and reads its style while calculating the hit height');
add('ColorGridState', ['$colordlg_add_custom', '$create_color_dialog'],
  'the colour dialog resolves its ColorGrid child before reading or initializing its selection');
// The one genuinely class-agnostic pair, and the reason ControlTextState exists.
add('ControlTextState', ['$ctrl_decimal_value', '$ctrl_inches_milli'],
  'looks a control up by DIALOG ID and parses whatever text it has, so it must NOT claim ' +
  'a class: it is used on Print/PageSetup EDITs but nothing in the function restricts it ' +
  'to one. It reads only +0/+4, which is exactly where Button/Static/ComboBox/Edit agree');

// Cross-file readers. Anonymous exported functions get a stable `export:name`
// identity from functionIdentity() below. These used to be invisible because
// the gate parsed only 09c3; several still spelled the record as raw offsets
// even after the in-file migration was complete.
add('EditState', [
  'export:get_edit_text', 'export:get_edit_cursor', 'export:get_edit_sel_start',
  'export:get_edit_flags', 'export:get_edit_text_len', '$test_edit_visual_line_count',
], '13-exports test/renderer readers receive an EDIT hwnd and follow its state_ptr');
add('ButtonState', ['$dialog_first_default_button'],
  '10-helpers filters children to ctrl_class 1 before following state_ptr');
add('ColorGridState', ['export:colorgrid_get_sel'],
  '13-exports receives a ColorGrid hwnd and reads its selected-cell word');
add('ListViewState', [
  'export:listview_get_count', 'export:listview_get_column_count',
  'export:listview_get_top_index', 'export:listview_get_selected_index',
  'export:listview_get_column_width',
], '13-exports ListView renderer/test readers receive a ListView hwnd');
add('StaticState', ['export:static_get_image_ordinal'],
  '13-exports receives a STATIC hwnd and reads the resource ordinal used by its icon branch');
add('ControlTextState', ['$handle_GetDlgItemInt'],
  '09a resolves a dialog child by id and may read any of the four text-bearing control variants');
add('ControlTextState', ['$combobox_wndproc'],
  'the combo wndproc reads the shared text prefix of its inner EDIT child');

// There is deliberately NO "attributed but siteless" allowance. A function that
// does not reach the record does not need an attribution, and listing one is
// how dead attribution accumulates: it reads as coverage that is no longer
// there. If such a function later grows a site, check (2) fires as
// NOT ATTRIBUTED and somebody has to decide its class — which is the point.
// This is why $edit_wraps, $edit_stream_read, $toolbar_repaint_now and six
// others are absent below despite being obvious members of their families:
// they reach their state only through helpers, so they are not attributed.

const FIELD_WIDTH = {
  i32: 4, ptr: 4, weak: 4,
  u8: 1, s8: 1, u16: 2, s16: 2,
  i64: 8, f32: 4, f64: 8,
};

const head = (form) => Array.isArray(form) ? form[1] : null;
const lineOf = (form) => Array.isArray(form) ? watxNodeLine(form[0]) : 0;

function integerAtom(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/_/g, '');
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

// Parse layouts structurally. This is deliberately an AST walk rather than a
// line grammar: comments, line breaks, hexadecimal counts and a closing paren
// on the field's line cannot change which forms belong to the declaration.
function collectLayouts(forms, rel, errors) {
  const layouts = new Map();
  for (const form of forms) {
    if (head(form) !== 'layout') continue;
    const name = form[2];
    let offset = 0;
    const fields = [];
    for (const field of form.slice(3)) {
      if (head(field) !== 'field') continue;
      const [, , fieldName, type, countText, strideText] = field;
      const elemSize = FIELD_WIDTH[type] ?? (/^ptr<[^>]+>$/.test(type || '') ? 4 : undefined);
      if (elemSize === undefined) {
        errors.push(`${rel}:${lineOf(field)}: layout ${name} has unknown field type '${type}'`);
        continue;
      }
      const count = countText === undefined ? 1 : integerAtom(countText);
      const stride = strideText === undefined ? elemSize : integerAtom(strideText);
      if (!Number.isInteger(count) || count < 1 || !Number.isInteger(stride) || stride < elemSize) {
        errors.push(`${rel}:${lineOf(field)}: layout ${name}.${fieldName} has invalid count/stride`);
        continue;
      }
      const size = count * stride;
      fields.push({ name: fieldName, type, offset, elemSize, count, stride, size });
      offset += size;
    }
    layouts.set(name, { name, size: offset, fields, line: lineOf(form) });
  }
  return layouts;
}

function walk(form, visit) {
  if (!Array.isArray(form)) return;
  visit(form);
  for (let i = 2; i < form.length; i++) walk(form[i], visit);
}

function allocationsIn(funcForm, target) {
  const found = [];
  walk(funcForm, (form) => {
    if ((head(form) !== 'local.set' && head(form) !== 'local.tee') || form[2] !== target) return;
    const value = form[3];
    if (head(value) !== 'call' || value[2] !== '$heap_alloc') return;
    found.push({ line: lineOf(value), arg: value[3] });
  });
  return found;
}

function allocationSize(arg, layout) {
  if (head(arg) === 'i32.const') return integerAtom(arg[2]);
  if (head(arg) === 'size-of' && arg[2] === layout.name) return layout.size;
  return null;
}

function functionIdentity(form) {
  if (typeof form[2] === 'string' && form[2].startsWith('$')) return form[2];
  for (const child of form.slice(2)) {
    if (head(child) === 'export' && typeof child[2] === 'string') {
      const atom = child[2];
      const name = atom.startsWith('"') ? JSON.parse(atom) : atom;
      return `export:${name}`;
    }
  }
  return null;
}

function pointerVariant(type) {
  const match = /^ptr<([^>]+)>$/.exec(type || '');
  return match && VARIANTS[match[1]] ? match[1] : null;
}

// Find the linear-memory locals that really hold a control-state record. This
// is provenance, not a spelling convention: typed ptr<Variant> params/locals
// are roots, and legacy cross-file readers are followed from
// wnd_get_state_ptr -> g2w. A fixed point also follows local copies and casts.
function controlStateBases(func) {
  const guest = new Set();
  const linear = new Set();

  for (const child of func.slice(2)) {
    if ((head(child) === 'param' || head(child) === 'local') &&
        typeof child[2] === 'string' && pointerVariant(child[3])) linear.add(child[2]);
  }

  const isGuestValue = (value) =>
    (head(value) === 'local.get' && guest.has(value[2])) ||
    (head(value) === 'call' && value[2] === '$wnd_get_state_ptr');
  const isLinearValue = (value) => {
    if (head(value) === 'cast' && pointerVariant(value[2])) return true;
    if (head(value) === 'local.get' && linear.has(value[2])) return true;
    return head(value) === 'call' && value[2] === '$g2w' && isGuestValue(value[3]);
  };

  let changed = true;
  while (changed) {
    changed = false;
    walk(func, (form) => {
      if ((head(form) !== 'local.set' && head(form) !== 'local.tee') ||
          typeof form[2] !== 'string') return;
      if (isGuestValue(form[3]) && !guest.has(form[2])) { guest.add(form[2]); changed = true; }
      if (isLinearValue(form[3]) && !linear.has(form[2])) { linear.add(form[2]); changed = true; }
    });
  }
  return { guest, linear, isGuestValue, isLinearValue };
}

// A raw control-state address is either the state pointer itself (the memarg
// offset spelling) or an i32.add whose immediate operand is that pointer. Do
// not recurse through arbitrary expressions: a pointer loaded from a named
// state field and indexed afterward belongs to a different record.
function isRawControlAddress(form, bases) {
  if (bases.isLinearValue(form)) return true;
  return head(form) === 'i32.add' &&
    (bases.isLinearValue(form[2]) || bases.isLinearValue(form[3]));
}

function memoryAddress(form) {
  let i = 2;
  while (typeof form[i] === 'string' && /^(?:offset|align)=/.test(form[i])) i++;
  return form[i];
}

function sameField(a, b) {
  return a && b && a.name === b.name && a.type === b.type &&
    a.offset === b.offset && a.count === b.count && a.stride === b.stride;
}

function analyzeSources(sources) {
  const errors = [];
  const layouts = new Map();
  const functions = new Map();

  for (const { src, rel } of sources) {
    let forms;
    try {
      forms = parseSource(src, rel);
    } catch (err) {
      errors.push(`${rel}:${err.line || 0}: cannot parse: ${err.message}`);
      continue;
    }
    for (const [name, layout] of collectLayouts(forms, rel, errors)) {
      if (layouts.has(name)) errors.push(`${rel}:${layout.line}: duplicate layout ${name}`);
      else layouts.set(name, { ...layout, rel });
    }
    for (const form of forms) {
      if (head(form) !== 'func') continue;
      const name = functionIdentity(form);
      if (!name) continue;
      if (functions.has(name)) errors.push(`${rel}:${lineOf(form)}: duplicate function identity ${name}`);
      else functions.set(name, { form, rel });
    }
  }

  // (4) Each real variant's parsed layout size must equal EVERY named state
  // allocation. A function may allocate unrelated buffers too; the target
  // local is part of the evidence and prevents those from entering the count.
  // The partial text view instead has to be an exact prefix of all four real
  // variants it claims to view.
  for (const [name, spec] of Object.entries(VARIANTS)) {
    const layout = layouts.get(name);
    if (!layout) {
      errors.push(`layout ${name} is not declared in the source closure — this gate's variant table has rotted`);
      continue;
    }
    if (spec.viewOf) {
      for (const ownerName of spec.viewOf) {
        const owner = layouts.get(ownerName);
        if (!owner) { errors.push(`view ${name} names missing owner layout ${ownerName}`); continue; }
        for (const field of layout.fields) {
          const actual = owner.fields.find((f) => f.offset === field.offset);
          if (!sameField(field, actual)) {
            errors.push(`${layout.rel}:${layout.line}: view ${name}.${field.name} is not the same ` +
              `field at +${field.offset} in ${ownerName}`);
          }
        }
      }
      continue;
    }
    for (const pin of spec.allocators) {
      const entry = functions.get(pin.func);
      if (!entry) {
        errors.push(`${name} allocator ${pin.func} does not exist in the source closure`);
        continue;
      }
      const sites = allocationsIn(entry.form, pin.target);
      if (sites.length !== pin.count) {
        errors.push(`${name} allocator ${pin.func} should assign ${pin.count} heap_alloc call(s) ` +
          `to ${pin.target}, found ${sites.length}`);
      }
      for (const site of sites) {
        const size = allocationSize(site.arg, layout);
        if (size === null) {
          errors.push(`${entry.rel}:${site.line}: ${name} allocator ${pin.func} must use a literal ` +
            `(i32.const N) or (size-of ${name}) for ${pin.target}`);
        } else if (size !== layout.size) {
          errors.push(`${entry.rel}:${site.line}: ${name} allocator ${pin.func} requests ${size} bytes ` +
            `for ${pin.target}, but the parsed layout is ${layout.size} bytes`);
        }
      }
    }
  }

  // (1) raw accesses and (2) attributed converted accesses. Traversing the
  // parsed form makes line wrapping irrelevant and sees offset=0x8 exactly as
  // it sees offset=8. The old per-line regex missed both shapes.
  const sitesByFunc = new Map();
  for (const [fn, entry] of functions) {
    const bases = controlStateBases(entry.form);
    const castsByDestination = new Map();
    walk(entry.form, (form) => {
      const op = head(form);
      if ((op === 'local.set' || op === 'local.tee') &&
          typeof form[2] === 'string' && head(form[3]) === 'cast' && pointerVariant(form[3][2])) {
        const key = `${form[2]}:${form[3][2]}`;
        if (!castsByDestination.has(key)) castsByDestination.set(key, []);
        castsByDestination.get(key).push(lineOf(form));
      }
      if (/^i32\.(?:load|store)/.test(op || '')) {
        const address = memoryAddress(form);
        if (isRawControlAddress(address, bases)) {
          errors.push(`${entry.rel}:${lineOf(form)}: ${fn}: hand-spelled offset off a control-state base. ` +
            `Use (load.field.memarg <Variant> <field> ptr) / (store.field…) — the variant comes ` +
            `from the class of the window whose state_ptr this is, not from the record.`);
        }
      }

      if (!/^(?:load|store)\.field(?:-elem)?(?:\.memarg)?$/.test(op || '')) return;
      const variant = form[2];
      if (!VARIANTS[variant]) return;
      const att = BY_FUNCTION[fn];
      if (!att) {
        errors.push(`${entry.rel}:${lineOf(form)}: ${fn} reaches ${variant} but is NOT ATTRIBUTED. ` +
          `Decide which control class owns this pointer and add it to BY_FUNCTION with the evidence.`);
      } else if (att.variant !== variant) {
        errors.push(`${entry.rel}:${lineOf(form)}: ${fn} is attributed to ${att.variant} but reaches ${variant}.`);
      }
      if (!sitesByFunc.has(fn)) sitesByFunc.set(fn, new Map());
      const counts = sitesByFunc.get(fn);
      counts.set(variant, (counts.get(variant) || 0) + 1);
    });
    const duplicateReports = new Set();
    const reportDuplicate = (label, lines) => {
      if (lines.length <= 1) return;
      const reportKey = lines.join(',');
      if (duplicateReports.has(reportKey)) return;
      duplicateReports.add(reportKey);
      errors.push(`${entry.rel}:${lines[1]}: ${fn} repeats ${label} ${lines.length} times ` +
        `(lines ${lines.join(', ')}). Cast once when the pointer enters a typed local, then use ` +
        `that binding; repeating the claim defeats the active type.`);
    };
    for (const [binding, lines] of castsByDestination) {
      const split = binding.indexOf(':');
      reportDuplicate(`the ${binding.slice(split + 1)} binding ${binding.slice(0, split)}`, lines);
    }
  }

  // (3) no dead attribution.
  for (const [name, att] of Object.entries(BY_FUNCTION)) {
    if (!functions.has(name)) {
      errors.push(`attribution names ${name} (${att.variant}), which is not a function in the source closure`);
    } else if (!sitesByFunc.has(name)) {
      errors.push(`attribution names ${name} (${att.variant}) but it has no site — dead attribution. Remove it.`);
    }
  }

  const total = [...sitesByFunc.values()]
    .reduce((sum, counts) => sum + [...counts.values()].reduce((a, b) => a + b, 0), 0);
  return { errors, total, sitesByFunc, layouts, sourceCount: sources.length };
}

function printList(result) {
  const rows = [...result.sitesByFunc.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, counts] of rows)
    for (const [variant, n] of counts)
      console.log(`  ${String(n).padStart(4)}  ${variant.padEnd(20)} ${name}`);
  console.log(`  ${String(result.total).padStart(4)}  TOTAL over ${rows.length} function(s), ` +
    `${Object.keys(VARIANTS).length} variants`);
}

function main() {
  const list = process.argv.includes('--list');
  const sources = SOURCE_FILES.map((rel) => ({ rel, src: fs.readFileSync(path.join(ROOT, rel), 'utf8') }));
  const result = analyzeSources(sources);
  if (list) printList(result);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`control-variant-gate: ${error}`);
    console.error(`control-variant-gate: ${result.errors.length} problem(s).`);
    process.exit(1);
  }
  console.log(`control-variant-gate: ok — ${result.total} site(s) across ` +
    `${Object.keys(VARIANTS).length} variants, ${result.sitesByFunc.size} function(s) attributed, ` +
    `0 raw offsets off a control-state base in ${result.sourceCount} source files.`);
}

if (require.main === module) main();
module.exports = { analyzeSources, VARIANTS, BY_FUNCTION, SOURCE_FILES };
