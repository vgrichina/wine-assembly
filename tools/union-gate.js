#!/usr/bin/env node
'use strict';
//
// union-gate.js — the completeness + wrong-variant gate for every WATX
// (layout-union ...) in the tree. Replaces tools/gdi-variant-gate.js.
//
// ── tl;dr (ASCII) ───────────────────────────────────────────────────────────
//
//   A discriminated union is a record whose meaning above a shared prefix
//   depends on a tag field. The GDI object record is the tree's example: +0 is
//   the handle and +4 the type, and +24 alone is a bitmap's pixel bits, a
//   font's FNT strike, a palette's entry storage, a metafile's record bits, or
//   a brush's owned pattern-bitmap HANDLE.
//
//   Since docs/watx-typed-pointers-design.md landed, that shape is DECLARED:
//
//     (layout-union GdiObject (tag type GdiType)
//       (prefix (field handle i32) (field type i32))
//       (variant GdiBitmap (tag-value BITMAP) (field width i32) ...)
//       ...)
//
//   Three of the things the old gate checked by reading the source back are
//   therefore no longer checkable failures at all — the compiler cannot emit
//   them:
//
//     * a variant that disagrees about the prefix   (it is written ONCE)
//     * variants of differing size                  (padded to the widest)
//     * a union site reading above the prefix       (unknown-field error)
//
//   What is left is the part no compiler can decide, and it is the part worth
//   a gate: WHICH VARIANT a given site is holding. That comes from the type
//   check in scope or from the producer of the handle, and it is recorded here
//   as data with its evidence cited. For every site found against a union's
//   base call:
//
//     1. the site must be ATTRIBUTED to a variant (or read only the prefix) —
//        an unattributed site fails the build, which is what stops a new
//        offset from being spelled against a union without someone deciding
//        its type;
//     2. the variant the SOURCE names and the variant the ATTRIBUTION names
//        must agree — the wrong-layout bug (§6.2), caught here rather than at
//        Diablo's main menu;
//     3. the attribution is cross-checked against the function's own
//        discriminant guard, using the TAG VALUES THE COMPILER LOWERED from
//        the (enum ...) — a function that tests `+4 == 4` and is attributed to
//        GdiPalette is a contradiction;
//     4. raw hand-spelled offset arithmetic against the base is refused;
//     5. a `reserved*` field is refused: it is a word the variant does not own.
//
//   Everything structural comes from the compiler's own lowered union table
//   (lowerIR({ layoutsOnly: true })), not from a regex over the WAT and not
//   from a hand-copied variant->tag map. The old gate carried both, and the
//   comment on its VARIANT_TYPES records that a mis-attribution between two
//   variants slipped through until that table was added by hand. Reading it
//   from the declaration removes the copy that could drift.
//
// ── usage ──────────────────────────────────────────────────────────────────
//
//   node tools/union-gate.js            # check; exit 1 on any failure
//   node tools/union-gate.js --list     # print the attribution per site
//   node tools/union-gate.js --unions   # print what the compiler lowered
//
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Where the SITES are read from. Normally src/. `--src=DIR` points the site
// scan, the guard harvest and the stride read at a copy instead, which is how
// test/test-union-gate.js plants a negative without mutating the shared tree —
// a gate whose only proof is that it passes has no evidence it can still fail.
// The DECLARATIONS always come from the real compile of the real tree.
const srcArg = process.argv.find(a => a.startsWith('--src='));
const SRCDIR = srcArg ? path.resolve(srcArg.slice(6)) : path.join(ROOT, 'src');

// ── Per-union configuration ─────────────────────────────────────────────────
//
// Structure (variants, prefix, tag, tag values, field offsets) is NOT here —
// it is read from the declaration. What is here is the base call whose result
// is a record of this union, the stride global the table is indexed by, and
// the attribution.
const UNIONS = {
  GdiObject: {
    base: 'call $gdi_object_record',
    strideGlobal: '$GDI_OBJECT_STRIDE',
    // Projections declared with (view ...) over some of the variants. A site
    // may spell one of these instead of a variant; it is checked against the
    // attribution by the view's TARGETS (spelling GdiPenBrush is correct at a
    // site attributed to GdiPen or GdiBrush, and wrong anywhere else).
    views: ['GdiPenBrush'],

    // ── The attribution, which IS the reverse-engineering result ────────────
    //
    // Keyed by enclosing function. The evidence for each is cited beside it: a
    // `+4 == N` guard in the function, a named predicate that is one ("valid"
    // helpers), or the producer that made the handle. Functions that touch more
    // than one variant are listed in bySite below instead.
    byFunction: {
      // --- bitmap (type 3) ---
      '$host_gdi_get_object_w':      'GdiBitmap',  // 01-header:471 `+4 == 3`
      '$host_gdi_get_object_h':      'GdiBitmap',  // 01-header:478 `+4 == 3`
      '$cursor_scale_bitmap':        'GdiBitmap',  // 09a:4551 $gdi_bitmap_record_valid
      '$cursor_plane_row':           'GdiBitmap',  // 09a:4824 $hbm is a cursor plane
      '$copy_image_bitmap':          'GdiBitmap',  // 09a:18619 record_valid
      '$handle_CreateDIBSection':    'GdiBitmap',  // 09a4:2276 from create_dib_section
      '$gdi_bitmap_alloc':           'GdiBitmap',  // 10e:306 gdi_object_alloc(3,..)
      '$gdi_bitmap_storage':         'GdiBitmap',  // 10e:409 `+4 == 3`
      '$gdi_bitmap_public_bits':     'GdiBitmap',  // 10e:417 `+4 == 3`
      '$gdi_bitmap_bpp':             'GdiBitmap',  // 10e:426 `+4 == 3`
      '$gdi_metafile_recording_dc_create': 'GdiBitmap', // 10e:531 compat bitmap
      '$gdi_bitmap_bits':            'GdiBitmap',  // 10a:723 record_valid
      '$gdi_bitmap_create_common_toolbar': 'GdiBitmap', // 10a:794 create_owned
      '$gdi_bitmap_clone_owned':     'GdiBitmap',  // 10a:873 record_valid
      '$shell_system_icon_handle':   'GdiBitmap',  // 09a9:189 record_valid/source + create_owned destination
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
      '$gdi_font_height':            'GdiFont',    // 10f:616 `+4 == 4`
      '$gdi_font_width':             'GdiFont',    // 10f:636 `+4 == 4`
      '$gdi_font_set_width':         'GdiFont',    // 10f:644 `+4 == 4`
      '$gdi_font_pitch_and_family':  'GdiFont',    // 10f:655 `+4 == 4`
      '$gdi_font_set_pitch_and_family': 'GdiFont', // 10f:663 `+4 == 4`
      '$gdi_font_requested_charset': 'GdiFont',    // 10f:677 `+4 == 4`
      '$gdi_font_set_charset':       'GdiFont',    // 10f:692 `+4 == 4`
      '$gdi_font_charset':           'GdiFont',    // 10f:705 `+4 == 4`
      '$gdi_font_weight':            'GdiFont',    // 10f:728 `+4 == 4`
      '$gdi_font_italic':            'GdiFont',    // 10f:737 `+4 == 4`
      '$gdi_font_create':            'GdiFont',    // 10f:767 gdi_object_alloc(4,..)
      '$gdi_font_face':              'GdiFont',    // 10f:779 `+4 == 4`

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
    },

    // Functions that hold more than one variant, resolved per site. These are
    // the three places where the union is visible inside a single stack frame,
    // and are the reason a per-function map is not enough.
    bySite: {
      // $gdi_object_delete_full (10e:2571) — the union's own dispatch. Each arm
      // is guarded by an explicit `+4 == N` and frees a different +24.
      '10e-gdi-metafile.wat:2581': 'GdiBitmap',    // bits,        under `type == 3`
      '10e-gdi-metafile.wat:2582': 'GdiBitmap',    // flags,       under `type == 3`
      '10e-gdi-metafile.wat:2583': 'GdiBitmap',    // self_handle, under `type == 3`
      '10e-gdi-metafile.wat:2587': 'GdiPalette',   // storage,     under `type == 5`
      '10e-gdi-metafile.wat:2588': 'GdiPalette',   // flags,       under `type == 5`
      '10e-gdi-metafile.wat:2590': 'GdiFont',      // face,        under `type == 4`
      '10e-gdi-metafile.wat:2594': 'GdiMetafile',  // bits,        under `type == 6|7`
      '10e-gdi-metafile.wat:2595': 'GdiMetafile',  // flags,       under `type == 6|7`
      '10e-gdi-metafile.wat:2597': 'GdiBrush',     // style,       under `type == 2`
      '10e-gdi-metafile.wat:2598': 'GdiBrush',     // style,       under `type == 2`
      '10e-gdi-metafile.wat:2599': 'GdiBrush',     // pattern_bitmap, style is 3|6

      // $gdi_object_write_pen_brush (10f:870) — style and flags are read BEFORE
      // the pen/brush branch, which is precisely why the GdiPenBrush view
      // exists.
      //
      // These six keys are LINE NUMBERS, so any edit above them in the file
      // moves the sites out from under their attribution and the gate fails
      // with "NOT ATTRIBUTED" — it does not silently mis-attribute, which is
      // the important half, but it does mean an unrelated change to 10f lands
      // on whoever made it. If you are here because the gate just fired: check
      // that the site at each new line still does what its comment says (the
      // pre-branch pair, then the `type == 1` arm, then the else arm) and
      // renumber; do NOT delete the entry to make the gate pass.
      '10f-gdi-dc.wat:902': 'GdiPenBrush',         // style, pre-branch
      '10f-gdi-dc.wat:903': 'GdiPenBrush',         // flags, pre-branch
      '10f-gdi-dc.wat:906': 'GdiPen',              // width, in the `type == 1` arm
      '10f-gdi-dc.wat:907': 'GdiPen',              // color, in the `type == 1` arm
      '10f-gdi-dc.wat:909': 'GdiBrush',            // color, in the `type == 2` arm
      '10f-gdi-dc.wat:910': 'GdiBrush',            // hatch, in the `type == 2` arm

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
    },
  },
};

// ── Ask the compiler what it lowered ────────────────────────────────────────
//
// Same access path tools/gen-layout-offsets.js uses, for the same reason: the
// alternative is a second implementation of the layout arithmetic, and a second
// implementation is a second chance to be wrong.
function loadCompilerContext() {
  const SRC = path.join(ROOT, 'tools', 'watx-src');
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, TextDecoder,
    Float32Array, Float64Array, Uint8Array, ArrayBuffer,
    Map, Set, RegExp, Array, Object, String, Number, Math,
    parseInt, parseFloat, isNaN,
  };
  vm.createContext(ctx);
  for (const f of ['compiler-parser.js', 'compiler-stages.js', 'compiler-codegen.js', 'compiler.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

function loweredDeclarations() {
  const ctx = loadCompilerContext();
  const { watxSourceClosure } = require(path.join(ROOT, 'tools', 'watx-closure.js'));
  const closure = watxSourceClosure();
  let forms = ctx.parseSource(closure.source, closure.entry);
  forms = ctx.resolveIncludes(forms, closure.vfs, new Set(), closure.entry);
  forms = ctx.expandMacros(forms);
  const lowered = ctx.lowerIR(forms, { layouts: new Map() }, { layoutsOnly: true });

  const layouts = new Map(), unions = new Map(), views = new Map();
  for (const rec of lowered) {
    if (rec.type === 'layout-lowered') layouts.set(rec.name, rec);
    else if (rec.type === 'union-lowered') unions.set(rec.name, rec);
    else if (rec.type === 'view-lowered') views.set(rec.name, rec);
  }
  return { layouts, unions, views };
}

// ── Harvest each function's OWN type guards straight out of the source ──────
//
// fn name -> Set of N for every `(i32.load offset=4 …) … (i32.const N)`
// comparison the body contains, i.e. the discriminant values the code itself
// tests. A function with no such guard is producer-typed: check (3) is skipped,
// counted and reported.
function harvestGuards(files, tagOffset, tagName) {
  const guards = new Map();
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(SRCDIR, file), 'utf8'); } catch { continue; }
    let fn = null, buf = [];
    const flush = () => {
      if (!fn) return;
      const set = guards.get(fn) || new Set();
      const flat = buf.join('\n').replace(/;;[^\n]*/g, '').replace(/\s+/g, ' ');
      // BOTH spellings, and that is load-bearing: the discriminant reads are
      // themselves migrated, to `(load.field.memarg GdiObject type X)`.
      // Matching only the raw form silently harvested nothing after the
      // conversion, which took this check — the one that exists because the
      // others were measured insufficient — down to zero sites without failing
      // anything. A check that stops running is worse than no check.
      const res = [
        new RegExp(`i32\\.(?:eq|ne)\\s*\\(i32\\.load\\s+offset=${tagOffset}\\s*\\([^()]*\\)\\)\\s*\\(i32\\.const\\s+(\\d+)\\)`, 'g'),
        // The field name is pinned to the union's OWN tag field. Leaving it as
        // `\w+` matches any field comparison at all — measured: it harvested
        // `bpp == 0` and `flags == 32` as discriminant guards and produced 18
        // false contradictions against correct attributions.
        new RegExp(`i32\\.(?:eq|ne)\\s*\\(load\\.field(?:\\.memarg)?\\s+\\w+\\s+${tagName}\\s*\\([^()]*\\)\\)\\s*\\(i32\\.const\\s+(\\d+)\\)`, 'g'),
      ];
      let m;
      for (const re of res) { re.lastIndex = 0; while ((m = re.exec(flat))) set.add(Number(m[1])); }
      guards.set(fn, set);
      buf = [];
    };
    for (const line of text.split('\n')) {
      const fm = line.match(/^\s{0,4}\(func\s+(\$[\w.$-]+)/);
      if (fm) { flush(); fn = fm[1]; }
      if (fn) buf.push(line);
    }
    flush();
  }
  return guards;
}

// ── Where the sites are: the migrated spelling ──────────────────────────────
//
// A site is `(load.field.memarg GdiBitmap bits (…))`, so struct-offset-census.js
// — which looks for hand-spelled arithmetic — correctly finds nothing. Every
// src/*.wat is scanned (not a fixed list, so a new file that reaches this record
// is covered the day it is added) and each site is reported with its file,
// 1-based line, enclosing function and the LAYOUT THE SOURCE NAMES. The offset
// is recovered from the lowered declaration by field name, which is why a
// renamed field cannot slip past the attribution.
function scanConverted(names, layouts, views) {
  const out = [];
  const re = /\((load|store)\.field(?:\.memarg)?\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z0-9_]+)/g;
  for (const base of fs.readdirSync(SRCDIR).filter(f => f.endsWith('.wat')).sort()) {
    const text = fs.readFileSync(path.join(SRCDIR, base), 'utf8');
    const funcs = [];
    const fre = /^\s{0,4}\(func\s+(\$[\w.$-]+)/gm;
    let fm;
    while ((fm = fre.exec(text))) funcs.push({ at: fm.index, name: fm[1] });
    const nl = [];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') nl.push(i);
    const lineOf = (i) => { let lo = 0, hi = nl.length; while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < i) lo = m + 1; else hi = m; } return lo + 1; };
    const fnOf = (i) => { let name = null; for (const f of funcs) { if (f.at <= i) name = f.name; else break; } return name; };
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const [, kind, layoutName, fieldName] = m;
      if (!names.has(layoutName)) continue;                // some other family
      const L = layouts.get(layoutName) || views.get(layoutName);
      const f = L && L.fields.find(x => x.name === fieldName);
      if (!f) continue;   // the compiler rejects an unknown field; nothing here
      out.push({
        file: base, lineNo: String(lineOf(m.index)), fn: fnOf(m.index) || '$?',
        op: `${kind}.field`, off: f.offset, field: fieldName, spelled: layoutName,
      });
    }
  }
  return out;
}

function checkUnion(unionName, cfg, decl, problems, list) {
  const { layouts, unions, views } = decl;
  const U = unions.get(unionName);
  if (!U) {
    problems.push(`(layout-union ${unionName} ...) is not declared anywhere in src/*.wat. ` +
                  `union-gate.js is configured for it; either the declaration was removed or renamed.`);
    return null;
  }
  const variantNames = U.variants.map(v => v.name);
  const prefixNames = new Set(U.prefixFields.map(f => f.name));
  const prefixOffsets = new Set(U.prefixFields.map(f => f.offset));

  // ── structural assertions ────────────────────────────────────────────────
  //
  // The compiler makes these true by construction, so they are not defences
  // against a source edit any more — they are defences against the COMPILER
  // changing under us. They cost nothing and they are the reason the old gate's
  // three shape checks can be dropped rather than lost.
  const strideM = fs.readFileSync(path.join(SRCDIR, '01-header.wat'), 'utf8')
    .match(new RegExp(`\\(global \\${cfg.strideGlobal} i32 \\(i32\\.const (\\d+)\\)\\)`));
  if (!strideM) problems.push(`union-gate: ${cfg.strideGlobal} not found in src/01-header.wat`);
  const STRIDE = strideM ? Number(strideM[1]) : null;
  if (STRIDE !== null && U.totalSize !== STRIDE) {
    problems.push(`(layout-union ${unionName}) is ${U.totalSize} bytes but ${cfg.strideGlobal} is ` +
                  `${STRIDE}. The table is indexed by that global, so the widest variant must end ` +
                  `exactly on it — pad the widest variant with a trailing reserved field, or fix ` +
                  `the global.`);
  }
  for (const v of variantNames) {
    const L = layouts.get(v);
    if (!L) { problems.push(`variant ${v} of ${unionName} was not lowered`); continue; }
    if (L.totalSize !== U.totalSize)
      problems.push(`variant ${v} is ${L.totalSize} bytes, union ${unionName} is ${U.totalSize} ` +
                    `— the compiler is supposed to pad every variant to the union size`);
    for (const pf of U.prefixFields) {
      const own = L.fields.find(f => f.name === pf.name);
      if (!own || own.offset !== pf.offset)
        problems.push(`variant ${v} does not carry prefix field '${pf.name}' at +${pf.offset}`);
    }
  }
  if (!U.tagField)
    problems.push(`(layout-union ${unionName}) declares no (tag ...). This gate cross-checks an ` +
                  `attribution against the function's own discriminant guard and cannot without one.`);
  const untagged = U.variants.filter(v => !v.tagValues.length).map(v => v.name);
  if (U.tagField && untagged.length)
    problems.push(`variant(s) ${untagged.join(', ')} of ${unionName} carry no tag value, so no site ` +
                  `attributed to them can be cross-checked against a +${U.tagField.offset} guard.`);

  const tagOf = new Map(U.variants.map(v => [v.name, v.tagValues]));
  // A view stands for its targets: spelling it is right at a site attributed to
  // any one of them. The targets come from the declaration, so adding a variant
  // to a view does not need an edit here.
  for (const viewName of cfg.views || []) {
    const V = views.get(viewName);
    if (!V) { problems.push(`(view ${viewName} ...) is not declared; union-gate.js expects it`); continue; }
    tagOf.set(viewName, V.of.flatMap(t => tagOf.get(t) || []));
  }
  const spellable = new Set([unionName, ...variantNames, ...(cfg.views || [])]);

  // ── the RAW census ───────────────────────────────────────────────────────
  //
  // Every site is migrated, so the expected answer is NOTHING:
  // struct-offset-census.js exits nonzero with "no such base" when the base call
  // has no hand-spelled field arithmetic left against it, and that is this
  // family's healthy state. Any raw site it finds is a REFUSE-RAW failure —
  // somebody added hand-spelled offset arithmetic against a union record
  // without deciding its type.
  let census = '', rawCensusEmpty = false;
  try {
    census = execFileSync('node', [path.join(ROOT, 'tools', 'struct-offset-census.js'), `--base=${cfg.base}`],
                          { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    if (/no such base/.test(out)) { census = ''; rawCensusEmpty = true; }
    else { console.error('union-gate: census failed:', e.message); process.exit(1); }
  }
  const siteRe = /^\s+([\w.-]+\.wat):(\d+)\s+(\$\S+)\s+(\S+)\s+\+0x([0-9a-f]+)/;

  const sites = [
    ...scanConverted(spellable, layouts, views),
    ...census.split('\n').map(l => l.match(siteRe)).filter(Boolean).map(m => ({
      file: m[1], lineNo: m[2], fn: m[3], op: m[4], off: parseInt(m[5], 16),
      field: null, spelled: null,
    })),
  ];
  const guards = harvestGuards([...new Set(sites.map(s => s.file))],
                               U.tagField ? U.tagField.offset : 4, U.tagField ? U.tagField.name : 'type');
  const producerTyped = new Set();
  const stats = { checked: 0, agnostic: 0, guarded: 0, perArm: 0, raw: 0, rawCensusEmpty, STRIDE,
                  variants: variantNames.length, union: unionName };

  for (const site of sites) {
    const { file, lineNo, fn, op, off, field, spelled } = site;
    const key = `${file}:${lineNo}`;

    if (spelled === null) {
      stats.raw++;
      problems.push(`${key} ${fn} (${op}) is RAW hand-spelled +${off} arithmetic against a ` +
                    `${unionName} record. This family is fully migrated: spell it ` +
                    `(load.field.memarg <variant> <field> ptr), choosing the variant from the type ` +
                    `check in scope or the producer of the handle.`);
    }

    // (1) a prefix field means the same thing to every variant, and a site
    // reading one has not decided a type — often it is the read that decides.
    // Those spell the union name, and naming a variant there is the failure.
    if (prefixOffsets.has(off) && (field === null || prefixNames.has(field))) {
      stats.agnostic++;
      if (spelled !== null && spelled !== unionName)
        problems.push(`${key} ${fn} reads the shared prefix (+${off}) but spells it ${spelled}. ` +
                      `A prefix site claims no variant: spell it ${unionName}.`);
      if (list) console.log(`${key}  ${fn}  +${off}  ${spelled || '(raw)'}  (shared prefix)`);
      continue;
    }
    // Reading above the prefix through the union name is an unknown-field
    // COMPILE error now, so this can only be reached by a raw site.
    if (spelled === unionName) {
      problems.push(`${key} ${fn} spells ${unionName} at +${off}, above the shared prefix.`);
      continue;
    }

    let variant = cfg.bySite[key];
    let how = 'site';
    if (variant === undefined) {
      if (!(fn in cfg.byFunction)) {
        problems.push(`${key} ${fn} reads +${off} of a ${unionName} record but is NOT ATTRIBUTED ` +
                      `to a variant. Decide which variant this record is (the type check in scope, ` +
                      `or the producer of the handle) and add it to byFunction/bySite in ` +
                      `${path.basename(__filename)}.`);
        continue;
      }
      variant = cfg.byFunction[fn];
      how = 'function';
      if (variant === null) {
        problems.push(`${key} ${fn} is recorded as reading only the shared prefix, but it reads +${off}`);
        continue;
      }
    }
    if (!spellable.has(variant)) {
      problems.push(`${key} ${fn}: attributed to '${variant}', which is not a variant of ` +
                    `${unionName} nor one of its views [${variantNames.join(', ')}]`);
      continue;
    }

    // THE WRONG-VARIANT CHECK. The source names a variant and the attribution
    // names one, and the two must agree. A site that reads a bitmap's +24 as a
    // font's strike compiles perfectly and is exactly what §6.2 is about. A
    // view is accepted wherever one of its targets is attributed.
    if (spelled !== null && spelled !== variant) {
      const V = views.get(spelled);
      const viewCovers = V && V.of.includes(variant);
      const attrIsView = views.get(variant);
      const viewAttrCovers = attrIsView && attrIsView.of.includes(spelled);
      if (!viewCovers && !viewAttrCovers) {
        problems.push(`${key} ${fn} spells ${spelled} at +${off}, but the attribution (by ${how}) ` +
                      `says ${variant}. One of the two is wrong: fix the site, or fix ` +
                      `byFunction/bySite in ${path.basename(__filename)} with the evidence.`);
        continue;
      }
    }

    // (5) the offset must be a named, non-reserved field of that variant.
    const L = layouts.get(variant) || views.get(variant);
    const f = L.fields.find(x => x.offset === off && (x.count === undefined || x.count === 1));
    if (!f) {
      problems.push(`${key} ${fn} (${op}) reads +${off}, which is not a field boundary of ${variant} ` +
                    `— either the attribution is wrong or the layout is`);
      continue;
    }
    if (/^(reserved|__rest)/.test(f.name)) {
      problems.push(`${key} ${fn} (${op}) reads +${off}, which ${variant} declares as '${f.name}'. ` +
                    `A reserved word is one this variant does not own: if this variant really uses ` +
                    `it, name the field (with evidence); if not, the attribution is wrong.`);
      continue;
    }

    // (3) cross-check the attribution against the function's OWN tag guard,
    // using the values the compiler lowered from the (enum ...).
    // Only sound for a function attributed as a WHOLE: a function listed in
    // bySite holds more than one variant, so the guards harvested from its body
    // are a union across its arms and prove nothing about any one site — which
    // is the very reason those sites are attributed per-arm by hand.
    const guard = how === 'function' ? guards.get(fn) : null;
    if (how !== 'function') stats.perArm++;
    if (guard && guard.size) {
      const allowed = tagOf.get(variant) || [];
      if (!allowed.length || ![...guard].some(n => allowed.includes(n))) {
        problems.push(`${key} ${fn} is attributed to ${variant} (tag ${allowed.join('|') || 'none'}), ` +
                      `but the function's own discriminant guard tests +${U.tagField.offset} against ` +
                      `${[...guard].join('|')}. One of the two is wrong.`);
        continue;
      }
      stats.guarded++;
    } else {
      producerTyped.add(fn);
    }

    stats.checked++;
    if (list) console.log(`${key}  ${fn}  +${off}  ${variant}.${f.name}  (by ${how})`);
  }
  stats.producerTyped = producerTyped;
  return stats;
}

function main() {
  const list = process.argv.includes('--list');
  const decl = loweredDeclarations();

  if (process.argv.includes('--unions')) {
    for (const [name, U] of decl.unions) {
      console.log(`(layout-union ${name}) ${U.totalSize} bytes, tag ` +
                  `${U.tagField ? `${U.tagField.name}@+${U.tagField.offset} of enum ${U.enumName}` : '(none)'}`);
      console.log(`  prefix   ${U.prefixFields.map(f => `${f.name}@+${f.offset}`).join(', ')}`);
      for (const v of U.variants)
        console.log(`  variant  ${v.name.padEnd(16)} tag ${v.tagValues.join('|') || '-'}  ` +
                    `own bytes to +${v.size}`);
    }
    for (const [name, V] of decl.views)
      console.log(`(view ${name}) over ${V.of.join(', ')}: ` +
                  `${V.fields.map(f => `${f.name}@+${f.offset}`).join(', ')}`);
    return;
  }

  const problems = [];
  const all = [];
  for (const [name, cfg] of Object.entries(UNIONS)) {
    const s = checkUnion(name, cfg, decl, problems, list);
    if (s) all.push(s);
  }

  // A gate that silently stops running is worse than no gate (see the note in
  // harvestGuards). If a configured union produced no sites at all, something
  // structural moved and the "0 problems" below would be meaningless.
  for (const s of all) {
    if (s.checked + s.agnostic === 0)
      problems.push(`union-gate found ZERO sites for ${s.union}. The gate is configured for it, so ` +
                    `either every site was deleted or the scan no longer recognizes the spelling.`);
  }

  if (problems.length) {
    const total = all.reduce((n, s) => n + s.checked + s.agnostic, 0);
    console.error(`\nunion-gate: ${problems.length} problem(s) across ${total} sites:\n`);
    for (const p of problems) console.error('  ' + p);
    console.error('');
    process.exit(1);
  }
  for (const s of all) {
    console.log(`union-gate: ${s.checked + s.agnostic} ${s.union} sites OK, all migrated ` +
                `(${s.agnostic} on the shared prefix spelled ${s.union}, ` +
                `${s.checked} spelling a variant that matches its attribution, ` +
                `of which ${s.guarded} are cross-checked against the function's own tag guard ` +
                `and ${s.perArm} are per-arm sites in a multi-variant function; ` +
                `${s.variants} variants, union ${s.STRIDE} bytes; ` +
                `${s.rawCensusEmpty ? 'no' : s.raw} raw hand-spelled site(s) remain)`);
    if (list && s.producerTyped.size)
      console.log(`\n${s.producerTyped.size} function(s) carry no tag guard of their own and are typed ` +
                  `by their PRODUCER — the attribution comment is the only evidence, so the ` +
                  `cross-check cannot run on them:\n  ` + [...s.producerTyped].sort().join('\n  '));
  }
}

main();
