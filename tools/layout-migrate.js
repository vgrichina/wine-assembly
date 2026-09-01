#!/usr/bin/env node
'use strict';
//
// layout-migrate.js — convert hand-spelled struct field arithmetic into WATX
// (layout ...) field accessors, mechanically.
//
// ── tl;dr (ASCII) ───────────────────────────────────────────────────────────
//
//   Wave tool for docs/watx-layout-migration-design.md. Given a file that
//   already declares a (layout L ...) and a way to recognize a pointer to one
//   of those records, it rewrites:
//
//       (i32.load  (i32.add ADDR (i32.const 56)))        -> (load.field  L flags ADDR)
//       (i32.store (i32.add ADDR (i32.const 4)) VAL)     -> (store.field L state ADDR VAL)
//       (i32.load  ADDR)                                 -> (load.field  L state ADDR)   (offset 0)
//       (i32.load8_u (i32.add ADDR (i32.const 12)))      -> (load.field  L flags ADDR)   (u8 field)
//
//   ADDR is recognized as a record pointer when its text is `(local.get $X)`
//   for an X named by --base-local, or a call to --base-call. ADDR and VAL are
//   spliced through VERBATIM, so formatting and any nested expression survive;
//   nested sites are picked up by later passes (the rewrite runs to a fixpoint).
//
//   The field names and offsets are read from the (layout ...) declaration IN
//   THE FILE, so the tool cannot disagree with the declaration, and a site whose
//   offset is not a declared field, or whose access width does not match the
//   field's type, is LEFT ALONE and reported. Refusing is the whole safety
//   story: a guessed field is exactly the silent bug this migration deletes.
//
// ── why this is safe to run mechanically ───────────────────────────────────
//
//   Because the oracle is total. load.field / load.elem / load.field-elem lower
//   to the IDENTICAL wasm bytes as the add-form spelling (measured; see §3.2 of
//   the design doc), so a conversion that compiles to a byte-identical
//   build/wine-assembly.wasm is not "probably right" — it is the same program.
//   Run the build before and after and compare the shasum. If the bytes moved,
//   the conversion is wrong, and the diff says where.
//
//   NOTE (wave 0): store.field/store.elem/store.field-elem emit a trailing
//   `i32.const 0` even under standardWat, which makes the module fail
//   validation. Until that compiler fix lands, run with --loads-only.
//
// ── usage ──────────────────────────────────────────────────────────────────
//
//   node tools/layout-migrate.js --file=src/09d-winsock.wat --layout=VSock \
//        --base-local=rec,prec,lrec,crec --base-call='$vsock_rec' \
//        --loads-only [--write]
//
//   Without --write it is a dry run: it prints the site census and what it
//   would do. --gate reports remaining raw sites and exits nonzero if any
//   convertible one is left (the back-stop for a migrated struct).
//
const fs = require('fs');
const path = require('path');

// ── paren matching over WAT text (comments and strings are not paren-bearing) ──
function matchParen(text, open) {
  let depth = 0, i = open;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ';' && text[i + 1] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '(' && text[i + 1] === ';') {
      i += 2;
      while (i < n && !(text[i] === ';' && text[i + 1] === ')')) i++;
      i += 2; continue;
    }
    if (c === '"') { i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } i++; continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

// Split the operands of a form whose body starts at `from` and ends at `end`
// (exclusive of the closing paren). Returns [{text, start, end}].
function splitOperands(text, from, end) {
  const out = [];
  let i = from;
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === ';' && text[i + 1] === ';') { while (i < end && text[i] !== '\n') i++; continue; }
    if (c === '(' && text[i + 1] === ';') {
      i += 2; while (i < end && !(text[i] === ';' && text[i + 1] === ')')) i++; i += 2; continue;
    }
    if (c === '(') {
      const close = matchParen(text, i);
      if (close < 0 || close >= end) return null;
      out.push({ text: text.slice(i, close + 1), start: i, end: close + 1 });
      i = close + 1; continue;
    }
    // bare atom (a memarg like offset=4, or an identifier)
    let j = i;
    while (j < end && !' \t\r\n()'.includes(text[j])) j++;
    out.push({ text: text.slice(i, j), start: i, end: j, atom: true });
    i = j;
  }
  return out;
}

// ── read the (layout NAME ...) declaration out of the file ──
function readLayout(text, name) {
  // Skip matches that sit inside a `;;` comment — a file that DOCUMENTS its own
  // layout ("the (layout VSock ...) below is ...") would otherwise be parsed as
  // declaring an empty one, and every site would then be silently left alone.
  const re = new RegExp(`\\(layout\\s+${name}\\b`, 'g');
  let m = null, hit;
  while ((hit = re.exec(text))) {
    const lineStart = text.lastIndexOf('\n', hit.index) + 1;
    if (text.slice(lineStart, hit.index).includes(';;')) continue;
    m = hit; break;
  }
  if (!m) return null;
  const close = matchParen(text, m.index);
  if (close < 0) return null;
  const body = text.slice(m.index + m[0].length, close);
  const fields = [];
  let offset = 0;
  const fieldRe = /\(field\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(?:\s+(\d+))?(?:\s+(\d+))?\s*\)/g;
  let f;
  while ((f = fieldRe.exec(body))) {
    const [, fname, ftype, countS, strideS] = f;
    const elemSize = ftype === 'i64' || ftype === 'f64' ? 8 : ftype === 'u8' ? 1 : 4;
    const count = countS ? Number(countS) : 1;
    const stride = strideS ? Number(strideS) : elemSize;
    fields.push({ name: fname, type: ftype, offset, count, stride, elemSize, size: stride * count });
    offset += stride * count;
  }
  return { name, fields, totalSize: offset, byOffset: new Map(fields.map(f => [f.offset, f])) };
}

// Which memory op goes with which field type. A mismatch means the site is NOT
// this field (or the layout is wrong) — either way, do not touch it.
const LOAD_FOR = { i32: 'i32.load', ptr: 'i32.load', f32: 'f32.load', f64: 'f64.load', i64: 'i64.load', u8: 'i32.load8_u' };
const STORE_FOR = { i32: 'i32.store', ptr: 'i32.store', f32: 'f32.store', f64: 'f64.store', i64: 'i64.store', u8: 'i32.store8' };
const OPS = new Set([...Object.values(LOAD_FOR), ...Object.values(STORE_FOR)]);

function normalize(s) { return s.replace(/\s+/g, ' ').trim(); }

function migrate(text, layout, opts) {
  const baseLocals = new Set(opts.baseLocals.map(x => `(local.get $${x})`));
  const stats = { converted: 0, skippedOffset: [], skippedWidth: [], remaining: 0, byField: new Map() };

  const isRecordPtr = (s) => {
    const t = normalize(s);
    if (baseLocals.has(t)) return true;
    if (opts.baseCall && t.startsWith(`(call ${opts.baseCall} `)) return true;
    return false;
  };

  let changed = true, passes = 0;
  while (changed && passes < 25) {
    changed = false; passes++;
    // Per-pass counters: a site the pass declined is re-examined next pass, so
    // accumulating them across passes double-counts.
    stats.remaining = 0; stats.skippedOffset = []; stats.skippedWidth = [];
    // Scan right-to-left so a rewrite never invalidates an earlier index.
    const hits = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== '(') continue;
      const m = /^\(([a-z0-9_.]+)[\s(]/.exec(text.slice(i, i + 24));
      if (!m || !OPS.has(m[1])) continue;
      hits.push({ i, op: m[1] });
    }
    for (let h = hits.length - 1; h >= 0; h--) {
      const { i, op } = hits[h];
      const close = matchParen(text, i);
      if (close < 0) continue;
      const ops = splitOperands(text, i + 1 + op.length, close);
      if (!ops) continue;
      const isStore = op.startsWith('i32.store') || op.startsWith('i64.store') || op.startsWith('f32.store') || op.startsWith('f64.store');
      if (ops.some(o => o.atom)) continue;               // memarg form — §3.4, not byte-identical
      if (isStore ? ops.length !== 2 : ops.length !== 1) continue;
      const addrForm = ops[0].text;

      // (i32.add ADDR (i32.const N))  or  ADDR (offset 0)
      let addr = null, off = null;
      const addM = /^\(i32\.add[\s(]/.test(addrForm);
      if (addM) {
        const inner = splitOperands(addrForm, '(i32.add'.length, addrForm.length - 1);
        if (inner && inner.length === 2 && /^\(i32\.const\s+(-?(0x)?[0-9a-fA-F]+)\s*\)$/.test(normalize(inner[1].text))) {
          const cm = /^\(i32\.const\s+(-?(?:0x)?[0-9a-fA-F]+)\s*\)$/.exec(normalize(inner[1].text));
          const v = cm[1].startsWith('0x') ? parseInt(cm[1], 16) : parseInt(cm[1], 10);
          if (isRecordPtr(inner[0].text)) { addr = inner[0].text; off = v; }
        }
      } else if (isRecordPtr(addrForm)) { addr = addrForm; off = 0; }
      if (addr === null) continue;

      const field = layout.byOffset.get(off);
      if (!field) { stats.skippedOffset.push({ off, op }); continue; }
      if (field.count !== 1) { stats.skippedOffset.push({ off, op, why: 'array field' }); continue; }
      const want = isStore ? STORE_FOR[field.type] : LOAD_FOR[field.type];
      if (want !== op) { stats.skippedWidth.push({ off, op, want, field: field.name }); continue; }
      if (isStore && opts.loadsOnly) { stats.remaining++; continue; }

      const head = isStore ? 'store.field' : 'load.field';
      const tail = isStore ? ` ${ops[1].text}` : '';
      const replacement = `(${head} ${layout.name} ${field.name} ${addr}${tail})`;
      text = text.slice(0, i) + replacement + text.slice(close + 1);
      stats.converted++;
      stats.byField.set(field.name, (stats.byField.get(field.name) || 0) + 1);
      changed = true;
    }
  }
  stats.passes = passes;
  return { text, stats };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };
  const flag = (n) => args.includes(`--${n}`);
  const file = opt('file');
  const layoutName = opt('layout');
  if (!file || !layoutName) {
    console.error('usage: layout-migrate.js --file=src/X.wat --layout=NAME --base-local=a,b --base-call=$fn [--loads-only] [--write] [--gate]');
    process.exit(2);
  }
  const abs = path.isAbsolute(file) ? file : path.join(path.resolve(__dirname, '..'), file);
  const orig = fs.readFileSync(abs, 'utf8');
  const layout = readLayout(orig, layoutName);
  if (!layout) { console.error(`no (layout ${layoutName} ...) declaration in ${file}`); process.exit(1); }

  console.log(`layout ${layout.name}: ${layout.fields.length} fields, size-of = ${layout.totalSize}`);
  for (const f of layout.fields) {
    console.log(`  +${String(f.offset).padStart(3)}  0x${f.offset.toString(16).padStart(2, '0')}  ${f.name.padEnd(12)} ${f.type}${f.count > 1 ? ` [${f.count}]` : ''}`);
  }

  const opts = {
    baseLocals: (opt('base-local', '') || '').split(',').filter(Boolean),
    baseCall: opt('base-call', null),
    loadsOnly: flag('loads-only'),
  };
  const { text, stats } = migrate(orig, layout, opts);

  console.log(`\nconverted ${stats.converted} sites in ${stats.passes} passes` + (opts.loadsOnly ? `  (${stats.remaining} store sites left by --loads-only)` : ''));
  for (const [f, c] of [...stats.byField].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${f}`);
  if (stats.skippedOffset.length) {
    const agg = new Map();
    for (const s of stats.skippedOffset) agg.set(`${s.off}${s.why ? ' (' + s.why + ')' : ''}`, (agg.get(`${s.off}${s.why ? ' (' + s.why + ')' : ''}`) || 0) + 1);
    console.log(`  LEFT ALONE, offset is not a scalar field: ${[...agg].map(([k, v]) => `+${k} x${v}`).join(', ')}`);
  }
  if (stats.skippedWidth.length) {
    console.log(`  LEFT ALONE, access width does not match the field type:`);
    for (const s of stats.skippedWidth.slice(0, 20)) console.log(`    +${s.off} ${s.field}: site uses ${s.op}, field wants ${s.want}`);
  }

  if (flag('gate')) {
    const left = stats.remaining + stats.skippedWidth.length;
    if (stats.converted > 0) {
      console.error(`\nGATE FAIL: ${stats.converted} raw field access(es) against ${layout.name} remain in ${file}.`);
      console.error(`Use (load.field ${layout.name} <name> ptr) / (store.field ...) instead of hand-spelled offsets.`);
      process.exit(1);
    }
    console.log(`\nGATE OK: no raw scalar field arithmetic against ${layout.name} in ${file}.`);
    return;
  }

  if (flag('write')) {
    if (text === orig) { console.log('\nno change'); return; }
    fs.writeFileSync(abs, text);
    console.log(`\nwrote ${file}`);
  } else {
    console.log('\n(dry run — pass --write to apply, --gate to enforce)');
  }
}

if (require.main === module) main();
module.exports = { readLayout, migrate, matchParen, splitOperands };
