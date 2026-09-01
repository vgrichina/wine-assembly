#!/usr/bin/env node
'use strict';
//
// gdi-variant-gate.js — the completeness + wrong-layout gate for the GdiObject
// DISCRIMINATED UNION (docs/watx-layout-migration-design.md §5.4, §6.1, §6.2).
//
// ── tl;dr (ASCII) ───────────────────────────────────────────────────────────
//
//   The 48-byte GDI object record is a union, not a struct: +0 is the handle
//   and +4 the type, and every offset from +8 up means something different for
//   each of the seven object types. +24 alone is a bitmap's pixel bits, a
//   font's FNT strike, a palette's entry storage, a metafile's record bits, or
//   a brush's owned pattern-bitmap HANDLE.
//
//   So there is no single (layout GdiObject). src/10d-gdi-region-path.wat
//   declares SEVEN variants instead — GdiPen, GdiBrush, GdiPenBrush, GdiBitmap,
//   GdiFont, GdiPalette, GdiMetafile — each 48 bytes, all agreeing on
//   handle@0 / type@4.
//
//   Picking the right variant at a site is a TYPING decision no codemod can
//   make: it comes from the type check in scope, or from the producer of the
//   handle. This tool holds that attribution as DATA and checks it, so that
//   the reverse engineering behind it is enforced by the build instead of
//   sitting in a comment that rots.
//
//   For every site the census finds against `call $gdi_object_record`:
//
//     1. the site must be ATTRIBUTED to a variant (or to an offset every
//        variant agrees on, i.e. handle@0 / type@4) — an unattributed site
//        fails the build, which is what stops a new hand-spelled offset from
//        being added against this union without someone deciding its type;
//     2. the site's offset must be a NAMED, NON-RESERVED field of that
//        variant — reading a word the variant does not own is the wrong-layout
//        bug (§6.2), caught here rather than at Diablo's main menu;
//     3. every variant must be exactly $GDI_OBJECT_STRIDE bytes and must agree
//        on handle@0 / type@4, so (size-of ...) still pins the table stride
//        whichever variant a site reaches for.
//
//   Nothing here depends on byte identity, which is unavailable for this
//   family: all 160 sites are `offset=` memarg-spelled and load.field lowers to
//   the add form (§3.4). This gate is what replaces that oracle.
//
// ── usage ──────────────────────────────────────────────────────────────────
//
//   node tools/gdi-variant-gate.js            # check; exit 1 on any failure
//   node tools/gdi-variant-gate.js --list     # print the attribution per site
//
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LAYOUT_FILE = path.join(ROOT, 'src', '10d-gdi-region-path.wat');
const HEADER_FILE = path.join(ROOT, 'src', '01-header.wat');
const BASE = 'call $gdi_object_record';
const VARIANTS = ['GdiPen', 'GdiBrush', 'GdiPenBrush', 'GdiBitmap', 'GdiFont',
                  'GdiPalette', 'GdiMetafile'];

// Which value of the +4 discriminant each variant is FOR. This is what lets the
// gate check an attribution against the source rather than against itself: a
// function that guards `(i32.load offset=4 rec) == 4` and is attributed to
// GdiPalette is a contradiction, and check (4) below says so. Without this, a
// mis-attribution between two variants that both happen to declare a field at
// the offset in question passes silently — measured, and the reason this table
// exists.
const VARIANT_TYPES = {
  GdiPen:      [1],
  GdiBrush:    [2],
  GdiPenBrush: [1, 2],
  GdiBitmap:   [3],
  GdiFont:     [4],
  GdiPalette:  [5],
  GdiMetafile: [6, 7],
};

// ── The attribution, which IS the reverse-engineering result ────────────────
//
// Keyed by enclosing function. The evidence for each is cited beside it: a
// `+4 == N` guard in the function, a named predicate that is one ("valid"
// helpers), or the producer that made the handle. Functions that touch more
// than one variant are listed in BY_SITE below instead.
const BY_FUNCTION = {
  // --- bitmap (type 3) ---
  '$host_gdi_get_object_w':      'GdiBitmap',  // 01-header:471 `+4 == 3`
  '$host_gdi_get_object_h':      'GdiBitmap',  // 01-header:478 `+4 == 3`
  '$cursor_scale_bitmap':        'GdiBitmap',  // 09a:4551 $gdi_bitmap_record_valid
  '$cursor_plane_row':           'GdiBitmap',  // 09a:4824 $hbm is a cursor plane
  '$handle_CreateDIBSection':    'GdiBitmap',  // 09a4:2276 from create_dib_section
  '$gdi_bitmap_alloc':           'GdiBitmap',  // 10e:306 gdi_object_alloc(3,..)
  '$gdi_bitmap_storage':         'GdiBitmap',  // 10e:409 `+4 == 3`
  '$gdi_bitmap_public_bits':     'GdiBitmap',  // 10e:417 `+4 == 3`
  '$gdi_bitmap_bpp':             'GdiBitmap',  // 10e:426 `+4 == 3`
  '$gdi_metafile_recording_dc_create': 'GdiBitmap', // 10e:531 compat bitmap
  '$gdi_bitmap_bits':            'GdiBitmap',  // 10a:723 record_valid
  '$gdi_bitmap_create_common_toolbar': 'GdiBitmap', // 10a:794 create_owned
  '$gdi_bitmap_clone_owned':     'GdiBitmap',  // 10a:873 record_valid
  '$gdi_screen_surface_clear_rect': 'GdiBitmap', // 10f:967 $gdi_screen_bitmap
  '$gdi_screen_readback_sync':   'GdiBitmap',  // 10f:1025 $gdi_screen_bitmap
  '$gdi_printer_page_clear':     'GdiBitmap',  // 10f:1043 `+4 == 3`
  '$gdi_raster_palette_color':   'GdiBitmap',  // 10g:3688 desc+68 round trip
  '$gdi_raster_palette_base':    'GdiBitmap',  // 10g:3746 desc+68 round trip
  '$gdi_raster_channel_mask':    'GdiBitmap',  // 10g:3938 desc+68 round trip
  '$gdi_raster_read_blt_source': 'GdiBitmap',  // 10g:4041/4072 desc+68
  '$gdi_raster_desc_from_bitmap':'GdiBitmap',  // 10g:5736 record_valid
  '$gdi_get_dibits':             'GdiBitmap',  // 10g:5772 desc_from_bitmap first

  // --- font (type 4) ---
  '$handle_GetFontData':         'GdiFont',    // 09a4:1255 handle is DC+88
  '$gdi_bitmap_font_bind':       'GdiFont',    // 10b:1007 callers all font_create
  '$gdi_bitmap_font_selected':   'GdiFont',    // 10b:1069 `+4 == 4`
  '$gdi_bitmap_font_height':     'GdiFont',    // 10b:1152 handle is DC+88
  '$gdi_font_height':            'GdiFont',    // 10f:579 `+4 == 4`
  '$gdi_font_width':             'GdiFont',    // 10f:599 `+4 == 4`
  '$gdi_font_set_width':         'GdiFont',    // 10f:607 `+4 == 4`
  '$gdi_font_pitch_and_family':  'GdiFont',    // 10f:618 `+4 == 4`
  '$gdi_font_set_pitch_and_family': 'GdiFont', // 10f:626 `+4 == 4`
  '$gdi_font_weight':            'GdiFont',    // 10f:634 `+4 == 4`
  '$gdi_font_italic':            'GdiFont',    // 10f:643 `+4 == 4`
  '$gdi_font_create':            'GdiFont',    // 10f:670 gdi_object_alloc(4,..)
  '$gdi_font_face':              'GdiFont',    // 10f:685 `+4 == 4`

  // --- pen (type 1) ---
  '$gdi_dc_path_widen':          'GdiPen',     // 10d:2877 `+4 == 1`
  '$gdi_object_width':           'GdiPen',     // 10e:390 every caller is a pen
  '$gdi_surface_descriptor':     'GdiPen',     // 10f:1842 DC+4, set only at
                                               //   10f:548 under `type == 1`
  '$gdi_line_desc_can_raster':   'GdiPen',     // 10g:1687 gdi_object_type != 1
  '$gdi_geometric_line_desc':    'GdiPen',     // 10g:1740 sole caller gated by
                                               //   $gdi_line_desc_can_raster
  '$gdi_polyline_try':           'GdiPen',     // 10g:3307 DC+4

  // --- brush (type 2) ---
  '$gdi_bitmap_wrap_pattern_brush': 'GdiBrush',// 10a:899 gdi_object_alloc(2,..)
  '$gdi_brush_valid':            'GdiBrush',   // 10g:732 gdi_object_type != 2
  '$gdi_brush_solid_color':      'GdiBrush',   // 10g:3552 `+4 == 2`

  // --- pen OR brush, genuinely polymorphic through the shared prefix ---
  '$gdi_object_color':           'GdiPenBrush',// 10e:370 all callers pen/brush
  '$gdi_object_style':           'GdiPenBrush',// 10e:376 all callers pen/brush

  // --- metafile (types 6/7) ---
  '$gdi_metafile_create':        'GdiMetafile',// 10e:437-443 type forced 6|7

  // --- reads only the discriminant, so every variant agrees ---
  '$gdi_palette_record':         null,         // 10e:11 is the `+4 == 5` test
  '$gdi_object_type':            null,         // 10e:355 returns +4
  '$gdi_metafile_record':        null,         // 10e:464 compares +4
  '$gdi_dc_bitmap_record':       null,         // 10f:1119 is the `+4 == 3` test
};

// Functions that hold more than one variant, resolved per site. These are the
// three places where the union is visible inside a single stack frame, and are
// the reason a per-function map is not enough.
const BY_SITE = {
  // $gdi_object_delete_full (10e:2569) — the union's own dispatch. Each arm is
  // guarded by an explicit `+4 == N` and frees a different +24.
  '10e-gdi-metafile.wat:2579': 'GdiBitmap',    // bits,        under `type == 3`
  '10e-gdi-metafile.wat:2580': 'GdiBitmap',    // flags,       under `type == 3`
  '10e-gdi-metafile.wat:2581': 'GdiBitmap',    // self_handle, under `type == 3`
  '10e-gdi-metafile.wat:2585': 'GdiPalette',   // storage,     under `type == 5`
  '10e-gdi-metafile.wat:2586': 'GdiPalette',   // flags,       under `type == 5`
  '10e-gdi-metafile.wat:2588': 'GdiFont',      // face,        under `type == 4`
  '10e-gdi-metafile.wat:2592': 'GdiMetafile',  // bits,        under `type == 6|7`
  '10e-gdi-metafile.wat:2593': 'GdiMetafile',  // flags,       under `type == 6|7`
  '10e-gdi-metafile.wat:2595': 'GdiBrush',     // style,       under `type == 2`
  '10e-gdi-metafile.wat:2596': 'GdiBrush',     // style,       under `type == 2`
  '10e-gdi-metafile.wat:2597': 'GdiBrush',     // pattern_bitmap, style is 3|6

  // $gdi_object_write_pen_brush (10f:817) — style and flags are read BEFORE the
  // pen/brush branch, which is precisely why GdiPenBrush exists.
  //
  // These six keys are LINE NUMBERS, so any edit above them in the file moves
  // the sites out from under their attribution and the gate fails with "NOT
  // ATTRIBUTED" — it does not silently mis-attribute, which is the important
  // half, but it does mean an unrelated change to 10f lands on whoever made it.
  // They were last shifted by +37 when the GdiDcState layout block was declared
  // at the top of 10f-gdi-dc.wat. If you are here because the gate just fired:
  // check that the site at each new line still does what its comment says
  // (the pre-branch pair, then the `type == 1` arm, then the else arm) and
  // renumber; do NOT delete the entry to make the gate pass.
  '10f-gdi-dc.wat:843': 'GdiPenBrush',         // style, pre-branch
  '10f-gdi-dc.wat:844': 'GdiPenBrush',         // flags, pre-branch
  '10f-gdi-dc.wat:847': 'GdiPen',              // width, in the `type == 1` arm
  '10f-gdi-dc.wat:848': 'GdiPen',              // color, in the `type == 1` arm
  '10f-gdi-dc.wat:850': 'GdiBrush',            // color, in the `type == 2` arm
  '10f-gdi-dc.wat:851': 'GdiBrush',            // hatch, in the `type == 2` arm

  // $gdi_brush_sample (10g:775) holds a brush record AND the record of the
  // bitmap named by brush.pattern_bitmap, in one frame, and reads +16 from
  // both. The clearest single-frame demonstration of the union.
  '10g-gdi-raster.wat:782': 'GdiBrush',        // style
  '10g-gdi-raster.wat:785': 'GdiBrush',        // color
  '10g-gdi-raster.wat:791': 'GdiBrush',        // pattern_bitmap
  '10g-gdi-raster.wat:808': 'GdiBitmap',       // flags   of the pattern bitmap
  '10g-gdi-raster.wat:815': 'GdiBitmap',       // palette_count
  '10g-gdi-raster.wat:818': 'GdiBitmap',       // palette
  '10g-gdi-raster.wat:838': 'GdiBitmap',       // bpp
  '10g-gdi-raster.wat:856': 'GdiBrush',        // hatch
  '10g-gdi-raster.wat:882': 'GdiBrush',        // color
};

// ── Parse the (layout ...) declarations out of the WAT ──────────────────────
function parseLayouts(text) {
  const out = new Map();
  for (const name of VARIANTS) {
    const start = text.indexOf(`(layout ${name}\n`);
    if (start < 0) continue;
    // Scan to the matching close paren, ignoring parens inside line comments.
    let depth = 0, i = start, end = -1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = text.slice(start, end + 1).replace(/;;[^\n]*/g, '');
    const fields = [];
    let offset = 0;
    const re = /\(field\s+([A-Za-z0-9_]+)\s+(i32|i64|f32|f64|u8)\s*(\d+)?\s*\)/g;
    let m;
    while ((m = re.exec(body))) {
      const size = { i32: 4, i64: 8, f32: 4, f64: 8, u8: 1 }[m[2]];
      const count = m[3] ? Number(m[3]) : 1;
      fields.push({ name: m[1], offset, size, count, bytes: size * count });
      offset += size * count;
    }
    out.set(name, { name, fields, totalSize: offset });
  }
  return out;
}

function fieldAt(layout, off) {
  return layout.fields.find(f => f.offset === off && f.count === 1) || null;
}

// ── Harvest each function's OWN type guards straight out of the source ──────
//
// Returns fn name -> Set of N for every `(i32.load offset=4 …) … (i32.const N)`
// comparison the function body contains, i.e. the discriminant values the code
// itself tests. A function with no such guard gets an empty set and is treated
// as producer-typed (check (4) is skipped, and it is counted and reported).
function harvestGuards(files) {
  const guards = new Map();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    let fn = null, buf = [];
    const flush = () => {
      if (!fn) return;
      const body = buf.join('\n');
      const set = guards.get(fn) || new Set();
      // `(i32.eq (i32.load offset=4 X) (i32.const N))` and the i32.ne form,
      // tolerating the line break the sources wrap these across.
      const re = /i32\.(?:eq|ne)\s*\(i32\.load\s+offset=4\s*\([^()]*\)\)\s*\(i32\.const\s+(\d+)\)/g;
      let m;
      const flat = body.replace(/;;[^\n]*/g, '').replace(/\s+/g, ' ');
      while ((m = re.exec(flat))) set.add(Number(m[1]));
      guards.set(fn, set);
      buf = [];
    };
    for (const line of lines) {
      const fm = line.match(/^\s{0,4}\(func\s+(\$[\w.$-]+)/);
      if (fm) { flush(); fn = fm[1]; }
      if (fn) buf.push(line);
    }
    flush();
  }
  return guards;
}

function main() {
  const list = process.argv.includes('--list');
  const layouts = parseLayouts(fs.readFileSync(LAYOUT_FILE, 'utf8'));
  const problems = [];

  // --- (3) shape checks: stride, and the shared handle/type prefix ----------
  const strideM = fs.readFileSync(HEADER_FILE, 'utf8')
    .match(/\(global \$GDI_OBJECT_STRIDE i32 \(i32\.const (\d+)\)\)/);
  if (!strideM) { console.error('gdi-variant-gate: $GDI_OBJECT_STRIDE not found'); process.exit(1); }
  const STRIDE = Number(strideM[1]);

  for (const name of VARIANTS) {
    const L = layouts.get(name);
    if (!L) { problems.push(`layout ${name} is not declared in ${path.basename(LAYOUT_FILE)}`); continue; }
    if (L.totalSize !== STRIDE)
      problems.push(`layout ${name} is ${L.totalSize} bytes, but $GDI_OBJECT_STRIDE is ${STRIDE} — ` +
                    `every variant must pin the same table stride`);
    const h = fieldAt(L, 0), t = fieldAt(L, 4);
    if (!h || h.name !== 'handle')
      problems.push(`layout ${name}: +0 must be the shared field 'handle', got '${h && h.name}'`);
    if (!t || t.name !== 'type')
      problems.push(`layout ${name}: +4 must be the shared field 'type', got '${t && t.name}'`);
  }

  // --- run the census -------------------------------------------------------
  let census;
  try {
    census = execFileSync('node', [path.join(ROOT, 'tools', 'struct-offset-census.js'), `--base=${BASE}`],
                          { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 });
  } catch (e) {
    console.error('gdi-variant-gate: census failed:', e.message);
    process.exit(1);
  }

  const siteRe = /^\s+([\w.-]+\.wat):(\d+)\s+(\$\S+)\s+(\S+)\s+\+0x([0-9a-f]+)/;
  const files = [...new Set(census.split('\n').map(l => (l.match(siteRe) || [])[1]).filter(Boolean))];
  const guards = harvestGuards(files);
  const producerTyped = new Set();
  let checked = 0, agnostic = 0, guarded = 0, perArm = 0;
  for (const line of census.split('\n')) {
    const m = line.match(siteRe);
    if (!m) continue;
    const [, file, lineNo, fn, op, offHex] = m;
    const off = parseInt(offHex, 16);
    const key = `${file}:${lineNo}`;

    // (1) offsets every variant agrees on need no attribution.
    if (off === 0 || off === 4) { agnostic++; if (list) console.log(`${key}  ${fn}  +${off}  (shared prefix)`); continue; }

    let variant = BY_SITE[key];
    let how = 'site';
    if (variant === undefined) {
      if (!(fn in BY_FUNCTION)) {
        problems.push(`${key} ${fn} reads +${off} of a GDI object record but is NOT ATTRIBUTED to a ` +
                      `variant. Decide which object type this record is (the type check in scope, or ` +
                      `the producer of the handle) and add it to BY_FUNCTION/BY_SITE in ${path.basename(__filename)}.`);
        continue;
      }
      variant = BY_FUNCTION[fn];
      how = 'function';
      if (variant === null) {
        problems.push(`${key} ${fn} is recorded as reading only the shared prefix, but it reads +${off}`);
        continue;
      }
    }

    const L = layouts.get(variant);
    if (!L) { problems.push(`${key} ${fn}: attributed to unknown layout ${variant}`); continue; }

    // (2) the offset must be a named, non-reserved field of that variant.
    const f = fieldAt(L, off);
    if (!f) {
      problems.push(`${key} ${fn} (${op}) reads +${off}, which is not a field boundary of ${variant} ` +
                    `— either the attribution is wrong or the layout is`);
      continue;
    }
    if (/^reserved/.test(f.name)) {
      problems.push(`${key} ${fn} (${op}) reads +${off}, which ${variant} declares as '${f.name}'. ` +
                    `A reserved word is one this variant does not own: if this type really uses it, ` +
                    `name the field (with evidence); if not, the attribution is wrong.`);
      continue;
    }
    // (4) cross-check the attribution against the function's OWN type guard.
    // A function that tests `+4 == 4` and is attributed to GdiPalette is a
    // contradiction the table cannot talk its way out of.
    // Only sound for a function attributed as a WHOLE. A function listed in
    // BY_SITE holds more than one variant, so the guards harvested from its
    // body are a union across its arms and prove nothing about any one site —
    // which is the very reason those sites are attributed per-arm by hand.
    const guard = how === 'function' ? guards.get(fn) : null;
    if (how !== 'function') perArm++;
    if (guard && guard.size) {
      const allowed = VARIANT_TYPES[variant];
      const agrees = [...guard].some(n => allowed.includes(n));
      if (!agrees) {
        problems.push(`${key} ${fn} is attributed to ${variant} (type ${allowed.join('|')}), but the ` +
                      `function's own discriminant guard tests +4 against ${[...guard].join('|')}. ` +
                      `One of the two is wrong.`);
        continue;
      }
      guarded++;
    } else {
      producerTyped.add(fn);
    }

    checked++;
    if (list) console.log(`${key}  ${fn}  +${off}  ${variant}.${f.name}  (by ${how})`);
  }

  const total = checked + agnostic;
  if (problems.length) {
    console.error(`\ngdi-variant-gate: ${problems.length} problem(s) across ${total} sites:\n`);
    for (const p of problems) console.error('  ' + p);
    console.error('');
    process.exit(1);
  }
  console.log(`gdi-variant-gate: ${total} GdiObject sites OK ` +
              `(${agnostic} on the shared handle/type prefix, ${checked} attributed to a variant, ` +
              `of which ${guarded} are cross-checked against the function's own +4 guard ` +
              `and ${perArm} are per-arm sites in a multi-variant function; ` +
              `${VARIANTS.length} variants, all ${STRIDE} bytes)`);
  if (list && producerTyped.size) {
    console.log(`\n${producerTyped.size} function(s) carry no +4 guard of their own and are typed by ` +
                `their PRODUCER — the attribution comment is the only evidence, so check (4) cannot ` +
                `run on them:\n  ` + [...producerTyped].sort().join('\n  '));
  }
}

main();
