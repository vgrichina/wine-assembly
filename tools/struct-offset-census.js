#!/usr/bin/env node
'use strict';
//
// struct-offset-census.js — census of hand-spelled struct field accesses in src/*.wat
//
// ── tl;dr (ASCII) ───────────────────────────────────────────────────────────
//
//   src/*.wat has ZERO uses of WATX's (layout ...) struct system. Every record
//   field is reached by hand-spelled address arithmetic:
//
//       (i32.load (i32.add (call $wnd_record_addr $slot) (i32.const 4)))
//       (i32.load offset=92 (local.get $dc))
//
//   A wrong hand-copied constant there is SILENT. This tool answers, per struct
//   family, "how many sites, in which files, in which shape" so the migration to
//   (layout)/load.field can be waved by risk instead of by guess.
//
//   Method: read each WAT file as s-expressions, find every memory op, peel the
//   address expression down to a BASE symbol while accumulating the constant
//   offsets and any index*stride term, then group the sites by that base.
//
//       address expr                                   -> base           off
//       (i32.add (call $wnd_record_addr I) (i32.const 4)) -> call $wnd_record_addr  4
//       (i32.add (global.get $TV_TABLE) (i32.mul I 64))   -> $TV_TABLE     0 stride 64
//       offset=92 (local.get $dc)                         -> local $dc     92 (memarg)
//
//   Classification (the three buckets the migration plan is built on):
//
//     A  FUNNELED  base is a call to an address helper — every site in the
//                  family goes through one function, so a layout conversion is
//                  an edit to that helper plus its field constants. Cheap.
//     B  RAW       base is a table global or an absolute constant, spelled at
//                  each site. Expensive: every site is its own chance to be wrong.
//     C  GUEST/ABI base descends from $g2w or $GUEST_BASE — the bytes belong to
//                  the guest program (MSG, RECT, BITMAPINFO, WNDCLASS, ...). A
//                  layout is still worth writing, but it IS the Win32 ABI and
//                  must be marked frozen: changing it changes what guests see.
//
//   Byte-identity column (`bi%`): the share of a family's sites whose current
//   spelling would compile to the IDENTICAL wasm bytes after conversion.
//   load.field lowers to `ptr; i32.const off; i32.add; <load align=natural>`,
//   so an add-form site of a layout-expressible width matches exactly; a
//   memarg (`offset=`) site or a 16-bit width does not. See
//   docs/watx-layout-migration-design.md §"the oracle".
//
// ── usage ──────────────────────────────────────────────────────────────────
//
//   node tools/struct-offset-census.js                 # ranked table, all files
//   node tools/struct-offset-census.js --min=20        # only families >= 20 sites
//   node tools/struct-offset-census.js --class=a       # one bucket
//   node tools/struct-offset-census.js --base='call $wnd_record_addr'  # detail
//   node tools/struct-offset-census.js --file=09c0-window-table.wat
//   node tools/struct-offset-census.js --json
//
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// ── the memory ops we care about, with their natural alignment log2 ──
// A layout field can be typed i32/f32/i64/f64/u8/ptr — there is no u16 and no
// signed byte, so 16-bit and load8_s sites are marked "untypeable" and cannot
// convert without a compiler change.
const LOAD_OPS = {
  'i32.load': { w: 32 }, 'i64.load': { w: 64 }, 'f32.load': { w: 32 }, 'f64.load': { w: 64 },
  'i32.load8_u': { w: 8 }, 'i32.load8_s': { w: 8, untypeable: true },
  'i32.load16_u': { w: 16, untypeable: true }, 'i32.load16_s': { w: 16, untypeable: true },
  'i64.load8_u': { w: 8, untypeable: true }, 'i64.load8_s': { w: 8, untypeable: true },
  'i64.load16_u': { w: 16, untypeable: true }, 'i64.load16_s': { w: 16, untypeable: true },
  'i64.load32_u': { w: 32, untypeable: true }, 'i64.load32_s': { w: 32, untypeable: true },
};
const STORE_OPS = {
  'i32.store': { w: 32 }, 'i64.store': { w: 64 }, 'f32.store': { w: 32 }, 'f64.store': { w: 64 },
  'i32.store8': { w: 8 }, 'i32.store16': { w: 16, untypeable: true },
  'i64.store8': { w: 8, untypeable: true }, 'i64.store16': { w: 16, untypeable: true },
  'i64.store32': { w: 32, untypeable: true },
};

// ── s-expression reader ────────────────────────────────────────────────────
// WAT/WATX: `;;` line comments, `(; ;)` block comments, "strings", atoms.
// Nodes carry the line number so the census can point at a site.
function parseWat(text) {
  const forms = [];
  const stack = [];
  let i = 0, line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === ';' && text[i + 1] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '(' && text[i + 1] === ';') {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '\n') line++;
        if (text[i] === '(' && text[i + 1] === ';') { depth++; i += 2; continue; }
        if (text[i] === ';' && text[i + 1] === ')') { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    if (c === '(') {
      const node = []; node.line = line;
      if (stack.length) stack[stack.length - 1].push(node); else forms.push(node);
      stack.push(node); i++; continue;
    }
    if (c === ')') { stack.pop(); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      const atom = text.slice(i, j + 1);
      if (stack.length) stack[stack.length - 1].push(atom);
      i = j + 1; continue;
    }
    let j = i;
    while (j < n && !' \t\r\n()'.includes(text[j])) {
      if (text[j] === ';' && text[j + 1] === ';') break;
      j++;
    }
    const atom = text.slice(i, j);
    if (stack.length) stack[stack.length - 1].push(atom);
    i = j;
  }
  return forms;
}

const head = (node) => (Array.isArray(node) && typeof node[0] === 'string') ? node[0] : null;
const isConst = (node) => Array.isArray(node) && node[0] === 'i32.const' && typeof node[1] === 'string';
const constVal = (node) => {
  const t = node[1];
  const v = t.startsWith('0x') || t.startsWith('-0x') ? Number.parseInt(t, 16) : Number.parseInt(t, 10);
  return Number.isFinite(v) ? v : null;
};

// ── peel an address expression down to its base symbol ─────────────────────
// Accumulates every constant addend into `off` and remembers an index*stride
// term (the array-of-struct shape) so a family's record stride is visible.
function peelAddress(node) {
  let off = 0, stride = null, depth = 0;
  let cur = node;
  for (;;) {
    if (!Array.isArray(cur)) break;
    const h = head(cur);
    if (h === 'i32.add' && cur.length === 3) {
      const [, a, b] = cur;
      if (isConst(b) && constVal(b) !== null) { off += constVal(b); cur = a; depth++; continue; }
      if (isConst(a) && constVal(a) !== null) { off += constVal(a); cur = b; depth++; continue; }
      // (i32.add BASE (i32.mul IDX (i32.const S)))  /  (i32.shl IDX (i32.const k))
      const strideOf = (nd) => {
        if (!Array.isArray(nd)) return null;
        if (head(nd) === 'i32.mul' && nd.length === 3) {
          if (isConst(nd[2])) return constVal(nd[2]);
          if (isConst(nd[1])) return constVal(nd[1]);
        }
        if (head(nd) === 'i32.shl' && nd.length === 3 && isConst(nd[2])) {
          const k = constVal(nd[2]);
          return k === null ? null : (1 << k);
        }
        return null;
      };
      const sb = strideOf(b), sa = strideOf(a);
      if (sb !== null) { if (stride === null) stride = sb; cur = a; depth++; continue; }
      if (sa !== null) { if (stride === null) stride = sa; cur = b; depth++; continue; }
      // Two non-constant operands and neither is an index term: the left one is
      // conventionally the base in this codebase.
      cur = a; depth++; continue;
    }
    break;
  }
  let base = null, kind = 'other';
  const h = head(cur);
  if (h === 'global.get' && typeof cur[1] === 'string') { base = cur[1]; kind = 'global'; }
  else if (h === 'call' && typeof cur[1] === 'string') { base = `call ${cur[1]}`; kind = 'call'; }
  else if (h === 'local.get' && typeof cur[1] === 'string') { base = `local ${cur[1]}`; kind = 'local'; }
  else if (h === 'i32.const' && constVal(cur) !== null) { base = `abs ${constVal(cur) >>> 0}`; kind = 'abs'; }
  else if (h) { base = `(${h} ...)`; kind = 'expr'; }
  else base = '<unknown>';
  return { base, kind, off, stride, depth, node: cur };
}

// A site is GUEST/ABI when its address descends from the guest translation.
// $g2w is the guest->wasm translator; $GUEST_BASE is the same arena reached raw.
const GUEST_BASES = ['call $g2w', '$GUEST_BASE', 'call $g2w_affine_span'];
function classify(base, kind) {
  if (GUEST_BASES.some(g => base === g || base.startsWith(g + ' @'))) return 'C';
  if (kind === 'call' || kind === 'call-via-local') return 'A';
  return 'B'; // global / abs / param / unresolved local — spelled at each site
}

// ── local provenance ───────────────────────────────────────────────────────
// A raw `local $rec` base says nothing on its own: the interesting question is
// where that pointer came from. Inside one function, collect every
// (local.set $x EXPR) / (local.tee $x EXPR) and peel each initializer. When
// every initializer of a local peels to the SAME call/global base, the sites
// through that local are really sites of that family — a `local $rec` fed only
// by `(call $sock_record_addr ...)` is funneled (class A), not scattered.
// Params have no initializer here; their provenance is the caller's, and they
// are reported as their own kind so "struct passed by pointer" stays visible.
function localProvenance(fnNode) {
  const params = new Set();
  const inits = new Map(); // local name -> Set of base strings
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const h = head(node);
    if (h === 'param' && typeof node[1] === 'string' && node[1].startsWith('$')) params.add(node[1]);
    if ((h === 'local.set' || h === 'local.tee') && typeof node[1] === 'string' && node[2] !== undefined) {
      const p = peelAddress(node[2]);
      let s = inits.get(node[1]);
      if (!s) { s = new Set(); inits.set(node[1], s); }
      // Only a symbolic base is provenance; a bare local/expr says nothing.
      s.add(p.kind === 'call' || p.kind === 'global' ? p.base : `?${p.kind}`);
    }
    for (const c of node) walk(c);
  };
  walk(fnNode);
  const resolved = new Map();
  for (const [name, set] of inits) {
    if (set.size === 1) {
      const only = [...set][0];
      if (!only.startsWith('?')) resolved.set(name, only);
    }
  }
  return { params, resolved };
}

function collectSites(file, text) {
  const forms = parseWat(text);
  const sites = [];
  let fnName = '(top)';
  let prov = { params: new Set(), resolved: new Map() };
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    const h = head(node);
    if (h === 'func' && typeof node[1] === 'string' && node[1].startsWith('$')) {
      const savedName = fnName, savedProv = prov;
      fnName = node[1];
      prov = localProvenance(node);
      for (const c of node) walk(c);
      fnName = savedName; prov = savedProv;
      return;
    }
    const spec = h && (LOAD_OPS[h] || STORE_OPS[h]);
    if (spec) {
      // Skip the memarg atoms to find the address operand.
      let k = 1, memOff = 0, memarg = false;
      while (k < node.length && typeof node[k] === 'string' &&
             (node[k].startsWith('offset=') || node[k].startsWith('align='))) {
        if (node[k].startsWith('offset=')) {
          const t = node[k].slice(7);
          const v = t.startsWith('0x') ? Number.parseInt(t, 16) : Number.parseInt(t, 10);
          if (Number.isFinite(v)) { memOff += v; memarg = true; }
        }
        k++;
      }
      const addr = node[k];
      if (addr !== undefined) {
        const p = peelAddress(addr);
        // Re-attribute a local base to whatever initialized it, when that is
        // unambiguous; otherwise scope the name to its file, since `local $rec`
        // in two files is two unrelated structs.
        let base = p.base, kind = p.kind, via = null;
        if (p.kind === 'local') {
          const lname = p.base.slice(6);
          const src = prov.resolved.get(lname);
          if (src) {
            base = src; via = p.base;
            // Funneled only if the pointer came out of a helper CALL. A local
            // seeded straight off a table global is still raw arithmetic — the
            // address shape is spelled here, not in one place.
            kind = src.startsWith('call ') ? 'call-via-local' : 'global-via-local';
          }
          else if (prov.params.has(lname)) { base = `${file} :: param ${lname}`; kind = 'param'; }
          else { base = `${file} :: ${p.base}`; kind = 'local'; }
        }
        // Guest structs differ per file; one bucket would hide all of them.
        if (GUEST_BASES.includes(base)) base = `${base} @ ${file}`;
        const off = p.off + memOff;
        // Convertible-and-byte-identical requires: the add form (no memarg), a
        // width a layout field can express, and a non-negative offset.
        const identical = !memarg && !spec.untypeable && off >= 0;
        sites.push({
          file, fn: fnName, line: node.line || 0, op: h, base, kind, via,
          off, stride: p.stride, memarg, untypeable: !!spec.untypeable,
          identical, isStore: !!STORE_OPS[h],
        });
      }
    }
    for (const child of node) walk(child);
  };
  for (const f of forms) walk(f);
  return sites;
}

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : dflt;
  };
  const flag = (name) => args.includes(`--${name}`);
  const minSites = Number(opt('min', '8'));
  const wantClass = (opt('class', '') || '').toUpperCase();
  const wantBase = opt('base', null);
  const fileFilter = opt('file', null);
  const topN = Number(opt('top', '40'));

  let files;
  try {
    const { WAT_FILES } = require(path.join(ROOT, 'lib', 'compile-wat.js'));
    files = WAT_FILES.slice();
  } catch (e) {
    files = fs.readdirSync(SRC).filter(f => f.endsWith('.wat')).sort();
  }
  if (fileFilter) files = files.filter(f => f.includes(fileFilter));

  const all = [];
  for (const f of files) {
    const p = path.join(SRC, path.basename(f));
    if (!fs.existsSync(p)) continue;
    all.push(...collectSites(path.basename(f), fs.readFileSync(p, 'utf8')));
  }

  // Group by base symbol.
  const groups = new Map();
  for (const s of all) {
    let g = groups.get(s.base);
    if (!g) {
      g = {
        base: s.base, kind: s.kind, cls: classify(s.base, s.kind),
        sites: 0, stores: 0, memarg: 0, untypeable: 0, identical: 0,
        offsets: new Set(), strides: new Set(), files: new Map(), fns: new Map(),
      };
      groups.set(s.base, g);
    }
    g.sites++;
    if (s.isStore) g.stores++;
    if (s.memarg) g.memarg++;
    if (s.untypeable) g.untypeable++;
    if (s.identical) g.identical++;
    g.offsets.add(s.off);
    if (s.stride !== null) g.strides.add(s.stride);
    g.files.set(s.file, (g.files.get(s.file) || 0) + 1);
    g.fns.set(s.fn, (g.fns.get(s.fn) || 0) + 1);
  }

  let ranked = [...groups.values()].sort((a, b) => b.sites - a.sites);
  if (wantClass) ranked = ranked.filter(g => g.cls === wantClass);
  ranked = ranked.filter(g => g.sites >= minSites);

  if (wantBase) {
    const g = groups.get(wantBase);
    if (!g) { console.error(`no such base: ${wantBase}`); process.exit(1); }
    console.log(`${g.base}   class ${g.cls}   ${g.sites} sites (${g.stores} stores)`);
    console.log(`  distinct offsets : ${[...g.offsets].sort((a, b) => a - b).map(o => '0x' + (o >>> 0).toString(16)).join(' ')}`);
    console.log(`  strides seen     : ${[...g.strides].sort((a, b) => a - b).join(' ') || '(none)'}`);
    console.log(`  memarg form      : ${g.memarg}   untypeable width: ${g.untypeable}   byte-identical-capable: ${g.identical}`);
    console.log('  files:');
    for (const [f, c] of [...g.files].sort((a, b) => b[1] - a[1])) console.log(`    ${String(c).padStart(5)}  ${f}`);
    console.log('  top functions:');
    for (const [f, c] of [...g.fns].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${String(c).padStart(5)}  ${f}`);
    console.log('  sites:');
    for (const s of all.filter(s => s.base === wantBase).slice(0, 200)) {
      console.log(`    ${s.file}:${s.line}  ${s.fn}  ${s.op}  +0x${(s.off >>> 0).toString(16)}${s.memarg ? ' [memarg]' : ''}${s.untypeable ? ' [untypeable]' : ''}${s.via ? ` via ${s.via}` : ''}`);
    }
    return;
  }

  if (flag('json')) {
    console.log(JSON.stringify(ranked.map(g => ({
      base: g.base, class: g.cls, sites: g.sites, stores: g.stores,
      memarg: g.memarg, untypeable: g.untypeable, identical: g.identical,
      offsets: [...g.offsets].sort((a, b) => a - b),
      strides: [...g.strides].sort((a, b) => a - b),
      files: [...g.files].sort((a, b) => b[1] - a[1]).map(([f, c]) => ({ file: f, sites: c })),
    })), null, 2));
    return;
  }

  const totals = { A: 0, B: 0, C: 0 };
  const ident = { A: 0, B: 0, C: 0 };
  for (const g of groups.values()) { totals[g.cls] += g.sites; ident[g.cls] += g.identical; }
  const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '--';
  console.log(`struct-offset census — ${all.length} memory sites over ${files.length} files`);
  console.log(`  class A (funneled through an address helper): ${totals.A}  (${ident.A} byte-identical-capable, ${pct(ident.A, totals.A)})`);
  console.log(`  class B (raw arithmetic off a table/global) : ${totals.B}  (${ident.B} byte-identical-capable, ${pct(ident.B, totals.B)})`);
  console.log(`  class C (guest-visible, layout IS the ABI)  : ${totals.C}  (${ident.C} byte-identical-capable, ${pct(ident.C, totals.C)})`);
  const memargTotal = all.filter(s => s.memarg).length;
  const untypeableTotal = all.filter(s => s.untypeable).length;
  const storeTotal = all.filter(s => s.isStore).length;
  console.log(`  spelled with an offset= memarg (not byte-identical after conversion): ${memargTotal}`);
  console.log(`  width a (layout) field cannot express (16-bit / signed byte)        : ${untypeableTotal}`);
  console.log(`  stores (blocked until store.field drops its trailing i32.const 0)   : ${storeTotal}`);
  console.log('');
  console.log('  cls  sites  stores  flds  memarg  u16/i8   bi%  base                                 files');
  console.log('  ---  -----  ------  ----  ------  ------  ----  -----------------------------------  ---------------------------');
  for (const g of ranked.slice(0, topN)) {
    const bi = g.sites ? Math.round(100 * g.identical / g.sites) : 0;
    const fileList = [...g.files].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([f, c]) => `${f.replace(/\.wat$/, '')}:${c}`).join(' ');
    console.log(
      `  ${g.cls.padEnd(3)}  ${String(g.sites).padStart(5)}  ${String(g.stores).padStart(6)}  ` +
      `${String(g.offsets.size).padStart(4)}  ${String(g.memarg).padStart(6)}  ` +
      `${String(g.untypeable).padStart(6)}  ${String(bi).padStart(3)}%  ` +
      `${g.base.slice(0, 35).padEnd(35)}  ${fileList}`);
  }
  console.log('');
  console.log(`(showing ${Math.min(topN, ranked.length)} of ${ranked.length} families with >= ${minSites} sites;`);
  console.log(` "flds" = distinct constant offsets seen = a lower bound on the field count.`);
  console.log(` "bi%" = share of sites whose current spelling compiles to identical wasm after conversion.)`);
}

if (require.main === module) main();
module.exports = { parseWat, peelAddress, collectSites, classify };
