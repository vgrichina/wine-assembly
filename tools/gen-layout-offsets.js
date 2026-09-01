#!/usr/bin/env node
'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// gen-layout-offsets.js — the offsets a (layout ...) declares, as data
//
// docs/watx-layout-migration-design.md §6.2 and §7. Two jobs, and they are
// opposite sides of the same fact:
//
//   1. AFTER the migration the field offsets are gone from the source. A
//      reverse-engineering session that reads `[esi+0x38]` out of a guest
//      disassembly used to answer "what is at +0x38?" with a grep. There is
//      nothing left to grep, so the answer has to come from here:
//
//        node tools/gen-layout-offsets.js                  # every layout
//        node tools/gen-layout-offsets.js --at=VSock:0x38  # what lives there
//        node tools/gen-layout-offsets.js --field=VSock:flags
//
//   2. A layout that describes a GUEST structure is not ours to change. `MSG`,
//      `RECT`, `BITMAPINFOHEADER`, `WNDCLASSA`, `CRITICAL_SECTION` are
//      Microsoft's, and the guest binary already contains compiled code that
//      reads those offsets. Reordering one is not a refactor, it is a
//      wire-format change that breaks every app at once and traps nowhere.
//      Such a layout carries a FROZEN marker (below) and `--check` treats any
//      movement of its fields as a BUILD FAILURE, not a regeneration.
//
// ── the FROZEN marker ──────────────────────────────────────────────────────
//
//   A block comment on the lines immediately above the declaration, naming the
//   SDK structure FIRST so this tool (and a reader) can say which one it is:
//
//     (; FROZEN: RECT — Win32 ABI, windef.h. These offsets are fixed by the
//        guest, not by us: guest code compiled years ago already reads them. ;)
//     (layout Rect
//       (field left i32) ...)
//
//   The first token after `FROZEN:` is the SDK structure name. Everything after
//   it is prose for humans.
//
// ── the baseline lives in tools/, not build/ ───────────────────────────────
//
//   §6.2 named `build/layout-offsets.json`. `build/` is gitignored, and a
//   baseline that is not committed cannot detect anything — `--check` would
//   compare a fresh build against a file the same build just wrote. So the
//   committed baseline is `tools/layout-offsets.json`, beside the generator,
//   and it is the file `--check` compares against. This is the
//   `gen_dispatch.js --check` pattern, with one addition: `--write` REFUSES to
//   move a frozen layout's fields. Otherwise the whole guarantee is one
//   `--write` away from being erased by the person who broke it.
//
// ── what it does NOT do ────────────────────────────────────────────────────
//
//   It does not check that a layout matches the offsets the code has been
//   using — that is `tools/layout-migrate.js --gate`'s job (a raw site left
//   against a migrated struct) and the byte-identity oracle's (a converted site
//   that moved). This tool only knows what the declarations say.
//
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'layout-offsets.json');

// ── load the vendored compiler and ask IT for the offsets ──────────────────
//
// The offsets are NOT recomputed here. tools/layout-migrate.js already carries
// a second implementation of the field-size table (FIELD_SIZE), and build.sh's
// DxObject comment records what a drift between two such tables costs: every
// field after the divergence is mis-attributed. A third one would be a third
// chance to be wrong, so this reads the real `lowerIR` the build lowers with.
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

// checkTypes is skipped on purpose: it costs ~2.5s on this closure and its only
// contribution here would be the unknown-field-type refusal, which the real
// build performs on every compile anyway. lowerIR still refuses a type its own
// width table has no entry for, so an unknown type cannot silently become 4
// bytes wide in this output either.
function loweredLayouts() {
  const ctx = loadCompilerContext();
  const { watxSourceClosure } = require(path.join(ROOT, 'tools', 'watx-closure.js'));
  const closure = watxSourceClosure();
  let forms = ctx.parseSource(closure.source, closure.entry);
  forms = ctx.resolveIncludes(forms, closure.vfs, new Set(), closure.entry);
  forms = ctx.expandMacros(forms);
  return ctx.lowerIR(forms, { layouts: new Map() }, { layoutsOnly: true });
}

// ── where each layout is declared, and whether it is frozen ────────────────
//
// The lowered record carries no source position, so the declaration site is
// found by scanning src/*.wat for `(layout NAME`. A layout name is unique
// module-wide (the compiler would reject a duplicate), so the first hit is the
// declaration. A hit inside a `;;` line comment is skipped for the same reason
// layout-migrate.js skips them: a file that DOCUMENTS a layout in prose would
// otherwise be read as declaring one.
function declarationSites() {
  const sites = new Map();
  const SRCDIR = path.join(ROOT, 'src');
  for (const f of fs.readdirSync(SRCDIR).sort()) {
    if (!/\.wat$/.test(f)) continue;
    const text = fs.readFileSync(path.join(SRCDIR, f), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*\(layout\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[i]);
      if (!m) continue;
      if (/;;/.test(lines[i].slice(0, m.index + lines[i].indexOf('(layout')))) continue;
      if (sites.has(m[1])) continue;
      sites.set(m[1], { file: `src/${f}`, line: i + 1, frozen: frozenMarkerAbove(lines, i) });
    }
  }
  return sites;
}

// The marker must be within the block comment that ENDS on one of the ~24 lines
// above the declaration — close enough to be unambiguously about this layout,
// far enough to hold the prose a frozen structure deserves. Anything between
// the marker and the declaration must be comment: a marker separated from its
// layout by code is not a marker for it.
function frozenMarkerAbove(lines, declIdx) {
  const from = Math.max(0, declIdx - 24);
  const window = lines.slice(from, declIdx);
  // Everything above the declaration in the window must be comment or blank,
  // walking back from the declaration until the first non-comment line.
  let start = window.length;
  while (start > 0) {
    const l = window[start - 1].trim();
    if (l === '' || l.startsWith(';;') || l.startsWith('(;') || l.endsWith(';)') ||
        (l.startsWith(';') === false && insideBlockComment(window, start - 1))) { start--; continue; }
    break;
  }
  const text = window.slice(start).join('\n');
  const m = /\(;\s*FROZEN:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
  if (!m) return null;
  // The note is everything after the SDK name — prose for humans, and NOT part
  // of the compared model: rewording a comment must not read as an ABI change.
  const full = /\(;\s*FROZEN:\s*[A-Za-z_][A-Za-z0-9_]*([\s\S]*?);\)/.exec(text);
  return { sdk: m[1], note: full ? full[1].replace(/\s+/g, ' ').replace(/^[\s—–-]+/, '').trim() : '' };
}

// Crude but sufficient: a line is inside a block comment if an unclosed `(;`
// appears above it within the window.
function insideBlockComment(window, idx) {
  let depth = 0;
  for (let i = 0; i < idx; i++) {
    depth += (window[i].match(/\(;/g) || []).length;
    depth -= (window[i].match(/;\)/g) || []).length;
  }
  return depth > 0;
}

// ── the model both modes speak ─────────────────────────────────────────────

function currentModel() {
  const lowered = loweredLayouts();
  const sites = declarationSites();
  const layouts = {};
  for (const l of lowered) {
    const site = sites.get(l.name) || { file: '(unknown)', line: 0, frozen: null };
    layouts[l.name] = {
      file: site.file,
      frozen: site.frozen ? site.frozen.sdk : null,
      frozenNote: site.frozen ? site.frozen.note : null,
      size: l.totalSize,
      fields: l.fields.map((f) => ({
        name: f.name, type: f.type, offset: f.offset,
        size: f.size, count: f.count, stride: f.stride,
      })),
    };
  }
  return { layouts };
}

const hex = (n) => `+0x${n.toString(16)}`;

function printTable(model, only) {
  const names = Object.keys(model.layouts).sort();
  for (const name of names) {
    if (only && name !== only) continue;
    const L = model.layouts[name];
    const frozen = L.frozen ? `  [FROZEN: ${L.frozen}${L.frozenNote ? ' — ' + L.frozenNote : ''}]` : '';
    console.log(`${name}  size ${L.size} (0x${L.size.toString(16)})  ${L.file}${frozen}`);
    for (const f of L.fields) {
      const arr = f.count > 1 ? `[${f.count}] stride ${f.stride}` : '';
      console.log(`  ${name} ${hex(f.offset).padEnd(8)} ${f.name.padEnd(20)} ${f.type}${arr ? ' ' + arr : ''}`);
    }
    console.log('');
  }
  if (only && !names.includes(only)) fail(`no layout named '${only}'. Known: ${names.join(', ')}`);
}

// --at=Name:0x38 — the RE session's question. Answers with the field that
// CONTAINS the offset, not just one that starts there: a guest write to +0x3a
// is inside a 4-byte field at +0x38, and saying "no field" there would be a
// wrong answer, not a missing one.
function lookupAt(model, spec) {
  const [name, offStr] = spec.split(':');
  const L = model.layouts[name];
  if (!L) fail(`no layout named '${name}'. Known: ${Object.keys(model.layouts).sort().join(', ')}`);
  const off = Number(offStr);
  if (!Number.isFinite(off)) fail(`--at=${spec}: '${offStr}' is not a number (use 0x38 or 56)`);
  if (off >= L.size) {
    console.log(`${name} is ${L.size} bytes; ${hex(off)} is PAST THE END of the record.`);
    process.exit(1);
  }
  for (const f of L.fields) {
    if (off >= f.offset && off < f.offset + f.size) {
      const within = off - f.offset;
      const idx = f.count > 1 ? `  element ${Math.floor(within / f.stride)}` : '';
      const inner = within % f.stride;
      console.log(`${name} ${hex(off)} -> ${f.name} (${f.type}) declared at ${hex(f.offset)}${idx}` +
        (inner ? `, ${inner} byte(s) into it` : ''));
      return;
    }
  }
  console.log(`${name} ${hex(off)} -> HOLE: inside the record but in no declared field.`);
  process.exit(1);
}

function lookupField(model, spec) {
  const [name, field] = spec.split(':');
  const L = model.layouts[name];
  if (!L) fail(`no layout named '${name}'. Known: ${Object.keys(model.layouts).sort().join(', ')}`);
  const f = L.fields.find((x) => x.name === field);
  if (!f) fail(`${name} has no field '${field}'. Fields: ${L.fields.map((x) => x.name).join(', ')}`);
  const arr = f.count > 1 ? `  [${f.count}] stride ${f.stride}` : '';
  console.log(`${name}.${f.name} ${hex(f.offset)} ${f.type} ${f.size} byte(s)${arr}`);
}

// ── --write / --check ──────────────────────────────────────────────────────

function serialize(model) {
  return JSON.stringify({
    _comment: [
      'GENERATED by tools/gen-layout-offsets.js --write. Do not hand-edit.',
      'The committed record of every (layout ...) offset in src/. A layout',
      'marked frozen describes a GUEST structure whose offsets belong to the',
      'Win32 ABI: --check refuses a change to one, and --write refuses to',
      'record it. See docs/watx-layout-migration-design.md §6.2 and §7.',
    ],
    layouts: model.layouts,
  }, null, 2) + '\n';
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

// Returns a list of human-readable differences, each tagged frozen or not.
function diff(baseline, model) {
  const out = [];
  const names = new Set([...Object.keys(baseline.layouts), ...Object.keys(model.layouts)]);
  for (const name of [...names].sort()) {
    const b = baseline.layouts[name];
    const c = model.layouts[name];
    if (b && !c) { out.push({ frozen: !!b.frozen, msg: `${name}: layout DELETED (was ${b.size} bytes, ${b.file})` }); continue; }
    if (!b && c) { out.push({ frozen: false, msg: `${name}: layout ADDED (${c.size} bytes, ${c.file})` }); continue; }
    const frozen = !!b.frozen || !!c.frozen;
    if (!!b.frozen !== !!c.frozen) {
      out.push({ frozen: true, msg: `${name}: FROZEN marker ${b.frozen ? `REMOVED (was '${b.frozen}')` : `added ('${c.frozen}')`}` });
    }
    if (b.size !== c.size) out.push({ frozen, msg: `${name}: size ${b.size} -> ${c.size}` });
    const bf = new Map(b.fields.map((f) => [f.name, f]));
    const cf = new Map(c.fields.map((f) => [f.name, f]));
    for (const [fn, f] of bf) {
      const g = cf.get(fn);
      if (!g) { out.push({ frozen, msg: `${name}.${fn}: field REMOVED (was ${hex(f.offset)} ${f.type})` }); continue; }
      if (f.offset !== g.offset) out.push({ frozen, msg: `${name}.${fn}: offset ${hex(f.offset)} -> ${hex(g.offset)}` });
      if (f.size !== g.size || f.type !== g.type) out.push({ frozen, msg: `${name}.${fn}: ${f.type}/${f.size}B -> ${g.type}/${g.size}B` });
      if (f.count !== g.count || f.stride !== g.stride) out.push({ frozen, msg: `${name}.${fn}: [${f.count}]x${f.stride} -> [${g.count}]x${g.stride}` });
    }
    for (const [fn, g] of cf) {
      if (!bf.has(fn)) out.push({ frozen, msg: `${name}.${fn}: field ADDED at ${hex(g.offset)} ${g.type}` });
    }
    if (b.file !== c.file) out.push({ frozen: false, msg: `${name}: moved ${b.file} -> ${c.file}` });
    // The frozen NOTE is prose. Rewording it is stale-not-broken: it can never
    // be reported as an ABI change, but the committed file must still match, or
    // the JSON would quietly hold a sentence the source no longer says.
    if ((b.frozenNote || null) !== (c.frozenNote || null)) {
      out.push({ frozen: false, msg: `${name}: FROZEN note reworded (prose only — no offset moved)` });
    }
  }
  return out;
}

function fail(msg) { console.error(`gen-layout-offsets: ${msg}`); process.exit(1); }

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const a = args.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : null; };

  if (has('--help') || has('-h')) {
    console.log('usage: gen-layout-offsets.js [--check|--write] [--at=Name:0x38] [--field=Name:name] [--layout=Name]');
    console.log('  no flags   human-readable table of every declared layout');
    console.log('  --check    fail if tools/layout-offsets.json is stale; a FROZEN layout that moved is an ABI break');
    console.log('  --write    regenerate tools/layout-offsets.json (refuses to record a frozen change)');
    return;
  }

  const model = currentModel();

  if (val('--at')) return lookupAt(model, val('--at'));
  if (val('--field')) return lookupField(model, val('--field'));

  if (has('--write')) {
    const baseline = readBaseline();
    if (baseline) {
      const frozenDiffs = diff(baseline, model).filter((d) => d.frozen);
      if (frozenDiffs.length && !has('--force-unfreeze')) {
        console.error('gen-layout-offsets --write REFUSED: a FROZEN layout changed.\n');
        for (const d of frozenDiffs) console.error(`  ${d.msg}`);
        console.error('\nA frozen layout describes a structure the GUEST owns — the Win32 ABI.');
        console.error('Guest binaries compiled decades ago already read these offsets, so moving');
        console.error('one is not a refactor; it silently misreads every app at once and traps');
        console.error('nowhere. Fix the declaration to match the SDK.');
        console.error('\nIf the SDK structure really is what changed (a wider field, a corrected');
        console.error('offset), say so in the commit message and re-run with --force-unfreeze.');
        process.exit(1);
      }
    }
    fs.writeFileSync(BASELINE, serialize(model));
    console.log(`wrote ${path.relative(ROOT, BASELINE)} (${Object.keys(model.layouts).length} layouts, ` +
      `${Object.values(model.layouts).filter((l) => l.frozen).length} frozen)`);
    return;
  }

  if (has('--check')) {
    const baseline = readBaseline();
    if (!baseline) fail(`${path.relative(ROOT, BASELINE)} is missing. Run: node tools/gen-layout-offsets.js --write`);
    const diffs = diff(baseline, model);
    if (!diffs.length) {
      console.log(`layout offsets OK — ${Object.keys(model.layouts).length} layouts, ` +
        `${Object.values(model.layouts).filter((l) => l.frozen).length} frozen`);
      return;
    }
    const frozenDiffs = diffs.filter((d) => d.frozen);
    if (frozenDiffs.length) {
      console.error('LAYOUT ABI BREAK — a FROZEN layout\'s fields moved:\n');
      for (const d of frozenDiffs) console.error(`  ${d.msg}`);
      console.error('\nThese offsets are the Win32 ABI. They are fixed by the guest binaries,');
      console.error('not by us: a program compiled in 1998 already contains the instruction');
      console.error('that reads this field at this offset. Changing one does not trap — it');
      console.error('reads a neighbouring field, which is a plausible integer, and the app');
      console.error('misbehaves somewhere else entirely.');
      console.error('\nThis is NOT a regeneration. Fix the declaration.');
    }
    const other = diffs.filter((d) => !d.frozen);
    if (other.length) {
      console.error(`${frozenDiffs.length ? '\n' : ''}tools/layout-offsets.json is STALE:\n`);
      for (const d of other) console.error(`  ${d.msg}`);
      console.error('\nRegenerate with: node tools/gen-layout-offsets.js --write');
    }
    process.exit(1);
  }

  printTable(model, val('--layout'));
}

main();
