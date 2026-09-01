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
// ── multi-file families (wave 4) ───────────────────────────────────────────
//
//   A record is not always confined to the file that declares it: the DX object
//   record is reached from five files. Two options exist for that shape:
//
//     --file=a.wat,b.wat,c.wat   process several files in one run; the per-file
//                                census is printed separately and --gate fails
//                                if ANY of them still carries a raw site, so one
//                                build.sh line covers the whole family.
//     --layout-from=src/X.wat    read the (layout ...) declaration from X rather
//                                than from each migrated file. Layouts are
//                                module-global to the compiler (all WAT_FILES
//                                are lowered as one module), so the declaration
//                                belongs beside the record it describes and the
//                                other files just use it.
//
// ── --skip-func: where a local NAME is not enough ──────────────────────────
//
//   Base recognition by local name has no provenance: `(local.get $entry)` is
//   matched because of what it is CALLED, not what was assigned to it. That is
//   fine while a name means one thing per file, and wave 4 found three places
//   where it does not — `$entry` is a 12-byte D3DIM_STATEBLOCKS record in
//   09ab's stateblock functions and a *packed debug key* in
//   $d3dim_lights_refresh, and a PE message-table cursor in 09a7's
//   $message_table_lookup.
//
//   Byte identity CANNOT catch this. A mislabelled site compiles to the exact
//   same bytes as the arithmetic it replaced — the oracle proves the program is
//   unchanged, which is precisely why it says nothing about whether the field
//   NAME now claimed for those bytes is a lie. The only defence is to not do it.
//
//     --skip-func=$a,$b   inside these functions, DO NOT match a base by local
//                         name. A `(call $dx_from_this ...)` base still
//                         converts there: that one is self-evidencing.
//
// ── --base-local-from-call: provenance instead of a blacklist ──────────────
//
//   --skip-func is a list of the places somebody NOTICED the name meant
//   something else. It cannot be complete, and the oracle cannot help: a
//   mislabelled site compiles to the same bytes as what it replaced.
//
//   --base-local-from-call inverts that. A local is a record pointer inside a
//   function iff, IN THAT FUNCTION, it is assigned at least once and EVERY
//   assignment to it is `(local.set $X (call BASECALL …))` (or `local.tee`).
//   Provenance is then derived from the source, per function, rather than
//   asserted by a name — and the tool declines the sites nobody had noticed yet.
//
//   Measured on the family this landed with: `src/10d-gdi-region-path.wat` has
//   46 assignments to `$entry` and they are THREE different records —
//   $gdi_dc_path_entry, $gdi_dc_clip_entry and $gdi_dc_system_clip_entry, plus
//   one hand-computed `(i32.add (global.get $GDI_DC_PATH_TABLE) …)` inside the
//   accessor itself. `--base-local=entry` would have labelled every clip-table
//   access as a field of the path record, byte-identically and undetectably.
//   `--base-local-from-call=entry` converts the 8 functions where $entry
//   provably came from $gdi_dc_path_entry and leaves the other 22 alone.
//
//   A `(param $entry i32)` never qualifies: a parameter has no assignment in
//   the function, so there is nothing in scope to derive provenance from.
//
// ── --memarg: the other lowering (design §3.4) ─────────────────────────────
//
//   6,547 of the tree's 12,061 field sites spell the offset in the instruction:
//
//       (i32.load offset=8 (local.get $p))   ->  (load.field.memarg L f p)
//
//   That is a DIFFERENT encoding from the add-form — three bytes shorter — so
//   it needs the compiler's `.memarg` modifier to stay byte-identical, and the
//   modifier is per-site precisely because one layout's sites are spelled both
//   ways. This rewrite is therefore OPT-IN, and deliberately so: turning it on
//   by default would change what `--gate` means for every family already
//   migrated (VSock, WndRecord, DxObject all still carry memarg sites), and
//   those gate lines would start failing in build.sh with nobody having asked
//   for a conversion. One family opts in, in one reviewed commit, at a time.
//
//   Declined, and reported rather than guessed:
//     * an `align=` that is not the access's natural alignment (the emitted
//       memarg would not match);
//     * a memarg on top of arithmetic — `(i32.load offset=4 (i32.add p (i32.const 8)))`
//       — where the field is at 12 but the address expression must survive;
//     * any other bare operand.
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

// log2 of the natural alignment each access carries when no `align=` is given.
// An explicit `align=` that disagrees is a DIFFERENT memarg, so a site carrying
// one is declined rather than converted (the compiler emits natural alignment).
const NATURAL_ALIGN = {
  'i32.load': 2, 'i32.store': 2, 'f32.load': 2, 'f32.store': 2,
  'i64.load': 3, 'i64.store': 3, 'f64.load': 3, 'f64.store': 3,
  'i32.load8_u': 0, 'i32.store8': 0,
};

function normalize(s) { return s.replace(/\s+/g, ' ').trim(); }

// Byte extents of the named functions, so --skip-func can ask "is this site
// inside one of them?". Recomputed per pass, because a rewrite shifts indices.
function funcRanges(text, names) {
  if (!names || !names.size) return [];
  const out = [];
  const re = /\(func\s+(\$[A-Za-z0-9_.]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (!names.has(m[1])) continue;
    const close = matchParen(text, m.index);
    if (close < 0) continue;
    out.push({ name: m[1], start: m.index, end: close + 1 });
  }
  return out;
}

// Every `(func $name …)` in the file, with its byte extent. Recomputed per pass,
// because a rewrite shifts every index after it.
function allFuncRanges(text) {
  const out = [];
  const re = /\(func\s+(\$[A-Za-z0-9_.]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const close = matchParen(text, m.index);
    if (close < 0) continue;
    out.push({ name: m[1], start: m.index, end: close + 1 });
  }
  return out;
}

// Per function, the locals whose value provably came from `baseCall` — every
// assignment to them in that function is `(local.set $X (call BASECALL …))`.
// A local with even one other assignment is dropped: it is the SAME slot, and
// which record it holds at a given site is a flow question this tool does not
// answer. See --base-local-from-call in the header.
function verifiedBaseLocals(text, ranges, names, baseCall) {
  const perFunc = new Map();
  if (!names || !names.size || !baseCall) return perFunc;
  for (const r of ranges) {
    const body = text.slice(r.start, r.end);
    const seen = new Map();   // name -> { fromCall, other }
    const re = /\((local\.set|local\.tee)\s+(\$[A-Za-z0-9_.]+)/g;
    let m;
    while ((m = re.exec(body))) {
      const name = m[2].slice(1);
      if (!names.has(name)) continue;
      const close = matchParen(body, m.index);
      if (close < 0) continue;
      const ops = splitOperands(body, m.index + 1 + m[1].length + 1 + m[2].length, close);
      const rhs = ops && ops.length === 1 ? normalize(ops[0].text) : null;
      const rec = seen.get(name) || { fromCall: 0, other: 0 };
      if (rhs && rhs.startsWith(`(call ${baseCall} `)) rec.fromCall++;
      else rec.other++;
      seen.set(name, rec);
    }
    const ok = new Set();
    for (const [name, rec] of seen) if (rec.fromCall > 0 && rec.other === 0) ok.add(`(local.get $${name})`);
    if (ok.size) perFunc.set(r, ok);
  }
  return perFunc;
}

function migrate(text, layout, opts) {
  const baseLocals = new Set(opts.baseLocals.map(x => `(local.get $${x})`));
  const verifiedNames = new Set(opts.verifiedLocals || []);
  const skipNames = new Set((opts.skipFuncs || []).map(x => (x.startsWith('$') ? x : `$${x}`)));
  const stats = {
    converted: 0, convertedMemarg: 0, skippedOffset: [], skippedWidth: [], remaining: 0,
    byField: new Map(), skippedFunc: new Map(), skippedMemarg: new Map(),
    verifiedFuncs: new Set(),
  };
  let ranges = [];
  let allRanges = [];
  let verified = new Map();
  const skipFuncAt = (i) => {
    for (const r of ranges) if (i >= r.start && i < r.end) return r.name;
    return null;
  };
  // The --base-local-from-call set in force at byte `i` (the enclosing
  // function's, or none).
  const verifiedAt = (i) => {
    for (const [r, set] of verified) if (i >= r.start && i < r.end) return { set, name: r.name };
    return null;
  };

  // `nameOk` is false inside a --skip-func body: there, only a base that
  // evidences itself (a call to the accessor) may be matched. A local name
  // proves nothing about what was assigned to it.
  const isRecordPtr = (s, nameOk, at) => {
    const t = normalize(s);
    if (nameOk && baseLocals.has(t)) return true;
    if (opts.baseCall && t.startsWith(`(call ${opts.baseCall} `)) return true;
    // A local whose every assignment in this function came from the base call
    // is evidence, not a name match — so it holds even inside a --skip-func.
    if (verifiedNames.size) {
      const v = verifiedAt(at);
      if (v && v.set.has(t)) { stats.verifiedFuncs.add(v.name); return true; }
    }
    return false;
  };

  let changed = true, passes = 0;
  while (changed && passes < 25) {
    changed = false; passes++;
    // Per-pass counters: a site the pass declined is re-examined next pass, so
    // accumulating them across passes double-counts.
    stats.remaining = 0; stats.skippedOffset = []; stats.skippedWidth = [];
    stats.skippedFunc = new Map(); stats.skippedMemarg = new Map();
    // NOT reset per pass, unlike the decline counters: this one records where
    // work was DONE, and the last pass is the one that converts nothing.
    ranges = funcRanges(text, skipNames);
    allRanges = verifiedNames.size ? allFuncRanges(text) : [];
    verified = verifiedBaseLocals(text, allRanges, verifiedNames, opts.baseCall);
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
      const inSkip = skipFuncAt(i);
      const nameOk = inSkip === null;
      let addr = null, off = null, memarg = false;

      if (ops.some(o => o.atom)) {
        // ── the memarg spelling (§3.4) ──
        // Convertible only with --memarg, and only into the compiler's
        // `.memarg` lowering, which is a different encoding from the add form.
        if (!opts.memarg) continue;
        const decline = (why) => { stats.skippedMemarg.set(why, (stats.skippedMemarg.get(why) || 0) + 1); };
        let k = 0, mOff = 0, badAtom = null, badAlign = null;
        while (k < ops.length && ops[k].atom) {
          const a = ops[k].text;
          const eq = a.indexOf('=');
          const key = eq < 0 ? a : a.slice(0, eq);
          const raw = eq < 0 ? '' : a.slice(eq + 1);
          const n = /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(raw) ? Number(raw) : NaN;
          if (key === 'offset' && Number.isInteger(n)) mOff = n;
          else if (key === 'align' && Number.isInteger(n)) {
            // An explicit alignment that is not the natural one is a different
            // memarg than the compiler emits, so the conversion would move bytes.
            if (Math.log2(n) !== NATURAL_ALIGN[op]) badAlign = a;
          } else badAtom = a;
          k++;
        }
        if (badAtom) { decline(`unrecognized operand '${badAtom}'`); continue; }
        if (badAlign) { decline(`explicit ${badAlign} is not this access's natural alignment`); continue; }
        const rest = ops.slice(k);
        if (isStore ? rest.length !== 2 : rest.length !== 1) continue;
        const a0 = rest[0].text;
        if (/^\(i32\.add[\s(]/.test(a0)) {
          // offset=N ON TOP of arithmetic: the field is at N + K, but the
          // address expression has to survive, and `.memarg` folds only the
          // field offset. Left alone rather than guessed at.
          const inner = splitOperands(a0, '(i32.add'.length, a0.length - 1);
          if (inner && inner.length === 2 && isRecordPtr(inner[0].text, nameOk, i)) decline('offset= on top of an i32.add');
          continue;
        }
        if (!isRecordPtr(a0, nameOk, i)) {
          if (inSkip && isRecordPtr(a0, true, i)) stats.skippedFunc.set(inSkip, (stats.skippedFunc.get(inSkip) || 0) + 1);
          continue;
        }
        addr = a0; off = mOff; memarg = true;
        // Rewrite through the shared tail below, but with the operands the
        // memarg form has (the value, for a store, is the second of `rest`).
        ops.length = 0; ops.push(rest[0]); if (isStore) ops.push(rest[1]);
      } else {
        if (isStore ? ops.length !== 2 : ops.length !== 1) continue;
        const addrForm = ops[0].text;

        // (i32.add ADDR (i32.const N))  or  ADDR (offset 0)
        const addM = /^\(i32\.add[\s(]/.test(addrForm);
        if (addM) {
          const inner = splitOperands(addrForm, '(i32.add'.length, addrForm.length - 1);
          if (inner && inner.length === 2 && /^\(i32\.const\s+(-?(0x)?[0-9a-fA-F]+)\s*\)$/.test(normalize(inner[1].text))) {
            const cm = /^\(i32\.const\s+(-?(?:0x)?[0-9a-fA-F]+)\s*\)$/.exec(normalize(inner[1].text));
            const v = cm[1].startsWith('0x') ? parseInt(cm[1], 16) : parseInt(cm[1], 10);
            if (isRecordPtr(inner[0].text, nameOk, i)) { addr = inner[0].text; off = v; }
            else if (inSkip && isRecordPtr(inner[0].text, true, i)) stats.skippedFunc.set(inSkip, (stats.skippedFunc.get(inSkip) || 0) + 1);
          }
        } else if (isRecordPtr(addrForm, nameOk, i)) { addr = addrForm; off = 0; }
        else if (inSkip && isRecordPtr(addrForm, true, i)) stats.skippedFunc.set(inSkip, (stats.skippedFunc.get(inSkip) || 0) + 1);
      }
      if (addr === null) continue;

      const field = layout.byOffset.get(off);
      if (!field) { stats.skippedOffset.push({ off, op }); continue; }
      if (field.count !== 1) { stats.skippedOffset.push({ off, op, why: 'array field' }); continue; }
      const want = isStore ? STORE_FOR[field.type] : LOAD_FOR[field.type];
      if (want !== op) { stats.skippedWidth.push({ off, op, want, field: field.name }); continue; }
      if (isStore && opts.loadsOnly) { stats.remaining++; continue; }

      const head = (isStore ? 'store.field' : 'load.field') + (memarg ? '.memarg' : '');
      const tail = isStore ? ` ${ops[1].text}` : '';
      const replacement = `(${head} ${layout.name} ${field.name} ${addr}${tail})`;
      text = text.slice(0, i) + replacement + text.slice(close + 1);
      stats.converted++;
      if (memarg) stats.convertedMemarg++;
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
  const fileArg = opt('file');
  const layoutName = opt('layout');
  if (!fileArg || !layoutName) {
    console.error('usage: layout-migrate.js --file=src/X.wat[,src/Y.wat] --layout=NAME --base-local=a,b --base-call=$fn');
    console.error('       [--layout-from=src/Z.wat] [--skip-func=$a,$b] [--loads-only] [--write] [--gate]');
    console.error('       [--base-local-from-call=a,b] locals whose EVERY assignment in a function is the base call');
    console.error('       [--memarg]                   also convert offset=N sites, via the .memarg lowering');
    process.exit(2);
  }
  const root = path.resolve(__dirname, '..');
  const resolve = (f) => (path.isAbsolute(f) ? f : path.join(root, f));
  const files = fileArg.split(',').map(s => s.trim()).filter(Boolean);

  // The layout is declared beside the record it describes; other files that
  // reach the same record just use it (layouts are module-global — every file
  // in WAT_FILES is lowered as one module).
  const layoutFile = opt('layout-from', files[0]);
  const layout = readLayout(fs.readFileSync(resolve(layoutFile), 'utf8'), layoutName);
  if (!layout) { console.error(`no (layout ${layoutName} ...) declaration in ${layoutFile}`); process.exit(1); }

  console.log(`layout ${layout.name} (declared in ${layoutFile}): ${layout.fields.length} fields, size-of = ${layout.totalSize}`);
  for (const f of layout.fields) {
    console.log(`  +${String(f.offset).padStart(3)}  0x${f.offset.toString(16).padStart(2, '0')}  ${f.name.padEnd(14)} ${f.type}${f.count > 1 ? ` [${f.count}]` : ''}`);
  }

  const opts = {
    baseLocals: (opt('base-local', '') || '').split(',').filter(Boolean),
    verifiedLocals: (opt('base-local-from-call', '') || '').split(',').map(s => s.trim().replace(/^\$/, '')).filter(Boolean),
    baseCall: opt('base-call', null),
    skipFuncs: (opt('skip-func', '') || '').split(',').map(s => s.trim()).filter(Boolean),
    loadsOnly: flag('loads-only'),
    memarg: flag('memarg'),
  };
  if (opts.verifiedLocals.length && !opts.baseCall) {
    console.error('--base-local-from-call needs --base-call: the whole point is that the local is'
      + ' matched because of what was ASSIGNED to it, not because of its name.');
    process.exit(2);
  }

  let gateFailed = false;
  for (const file of files) {
    const abs = resolve(file);
    const orig = fs.readFileSync(abs, 'utf8');
    const { text, stats } = migrate(orig, layout, opts);

    console.log(`\n── ${file}`);
    console.log(`converted ${stats.converted} sites in ${stats.passes} passes`
      + (opts.memarg ? `  (${stats.convertedMemarg} of them memarg-spelled)` : '')
      + (opts.loadsOnly ? `  (${stats.remaining} store sites left by --loads-only)` : ''));
    if (opts.verifiedLocals.length) {
      console.log(`  base locals verified from ${opts.baseCall} in ${stats.verifiedFuncs.size} function(s)`);
    }
    for (const [f, c] of [...stats.byField].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${f}`);
    if (stats.skippedOffset.length) {
      const agg = new Map();
      for (const s of stats.skippedOffset) agg.set(`${s.off}${s.why ? ' (' + s.why + ')' : ''}`, (agg.get(`${s.off}${s.why ? ' (' + s.why + ')' : ''}`) || 0) + 1);
      console.log(`  LEFT ALONE, offset is not a scalar field: ${[...agg].map(([k, v]) => `+${k} x${v}`).join(', ')}`);
    }
    if (stats.skippedWidth.length) {
      const agg = new Map();
      for (const s of stats.skippedWidth) { const k = `+${s.off} ${s.field}: site uses ${s.op}, field wants ${s.want}`; agg.set(k, (agg.get(k) || 0) + 1); }
      console.log(`  LEFT ALONE, access width does not match the field type:`);
      for (const [k, v] of agg) console.log(`    ${k}  x${v}`);
    }
    if (stats.skippedMemarg.size) {
      console.log(`  LEFT ALONE, memarg site the .memarg lowering cannot reproduce byte-for-byte:`);
      for (const [why, c] of [...stats.skippedMemarg].sort((a, b) => b[1] - a[1])) console.log(`    ${why}  x${c}`);
    }
    if (stats.skippedFunc.size) {
      console.log(`  LEFT ALONE, --skip-func (local name is not this record here):`);
      for (const [fn, c] of [...stats.skippedFunc].sort((a, b) => b[1] - a[1])) console.log(`    ${fn}  x${c}`);
    }

    if (flag('gate')) {
      if (stats.converted > 0) {
        console.error(`GATE FAIL: ${stats.converted} raw field access(es) against ${layout.name} remain in ${file}.`);
        console.error(`Use (load.field ${layout.name} <name> ptr) / (store.field ...) instead of hand-spelled offsets.`);
        gateFailed = true;
      } else {
        console.log(`GATE OK: no raw scalar field arithmetic against ${layout.name} in ${file}.`);
      }
      continue;
    }

    if (flag('write')) {
      if (text === orig) { console.log('  no change'); continue; }
      fs.writeFileSync(abs, text);
      console.log(`  wrote ${file}`);
    }
  }

  if (flag('gate')) { if (gateFailed) process.exit(1); return; }
  if (!flag('write')) console.log('\n(dry run — pass --write to apply, --gate to enforce)');
}

if (require.main === module) main();
module.exports = { readLayout, migrate, matchParen, splitOperands };
