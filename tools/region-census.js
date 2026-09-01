#!/usr/bin/env node
// region-census.js — how much of the fixed memory map is still magic numbers?
//
// Milestone 6's goal is not "validate the addresses", it is "each base address
// appears exactly ONCE in the tree — in its region declaration". Validation is
// the safety net during the migration; this is the odometer.
//
// It counts raw integer literals that land inside a declared region, per region
// and per file. A literal counted here is a place where the map is written down
// a second time: change the region and that number does not follow.
//
//   node tools/region-census.js                 # the whole census, worst first
//   node tools/region-census.js --region=DX_OBJECTS   # one region, with sites
//   node tools/region-census.js --file=src/09a8-handlers-directx.wat
//   node tools/region-census.js --json
//   node tools/region-census.js --gate          # refuse an INCREASE vs baseline
//   node tools/region-census.js --record        # rewrite the baseline
//   node tools/region-census.js --js-copies     # refuse a hand-copied ALLOCATED base in JS
//
// THE RATCHET. --gate compares against tools/region-census.baseline.json and
// fails when any file's count goes UP, or when a region marked `converted` in
// the baseline has any raw literal at all. So a region that has been fully
// symbolized can never quietly regrow one, and everything else can only shrink.
// This is deliberately per-FILE rather than a single total: one number lets a
// cleanup in one file pay for a regression in another, which is how ratchets
// stop ratcheting.
//
// CALIBRATION, and why the obvious definition is useless. "Any literal inside
// any declared region" counts 7136 sites, and almost none of them are the map.
// $GUEST_BASE is a 60MB address SPACE, so every guest VA, every 0x400000 image
// base and every large constant in the tree falls inside it; $CLIENT_RECT is a
// 4KB table low in memory, so the GDI raster tests' colour constants (0x6A6A
// and friends) land in it by arithmetic accident. A number that big cannot
// ratchet anything, because nobody can tell a real conversion from noise.
//
// So a site counts when it is actually a second copy of the map:
//
//   BASE     the literal EQUALS a declared region's base or its exclusive end.
//            This is the debt by definition — the address written twice.
//   INTERIOR the literal lies inside a declared TABLE (size <= INTERIOR_MAX)
//            in the high WAT-private map (base >= INTERIOR_FLOOR), where no
//            ordinary number lives, so `0x07F60400` is an address and not a
//            colour.
//
// Everything else is reported only under --loose, which exists to show why it
// is not the default. Read the direction of the number, not its magnitude.
//
// ONE EXPLICIT EXEMPTION, and why it has to exist. The BASE rule assumes a
// region's base is a distinctive number. Wave 2 declared the low string pool
// ($STRING_CONSTANTS at 0x100) and the MapVirtualKey tables ($VK_SCAN_TABLES
// at 0x380, ending 0x400) — real regions covering 57 previously undeclared
// data segments, but at addresses that are also three of the most ordinary
// integers in an x86 emulator. Counting them added 113 sites in one commit,
// none of them the map: buffer sizes, loop bounds, 0x100 as "256". Worse, the
// per-file ratchet would then refuse any future edit that merely writes 256 in
// hex. So these three VALUES are exempt from the BASE/END rule, by value and
// not by region — an INTERIOR hit inside those regions still counts, and every
// other region's accounting is untouched. This is the same judgement
// INTERIOR_FLOOR already makes: the rule only holds where a number that looks
// like an address is one.
//
// ============================================================================
// --js-copies — THE OTHER HALF, and the hole this fills.
//
// The ratchet above deliberately ignores ALLOCATED bases (see the WAVE 3 note
// by `byBase`): counting a coincidence against an address the allocator picked
// this morning took the census from 351 to 884 with no source change. That is
// right for the odometer and wrong for the runtime, because an allocated base
// is exactly the address a JS file must never hold: it MOVES whenever a size
// changes or a region is added, and nothing about that edit produces an error.
// Wave 3 spent hours on three such literals whose symptoms surfaced six regions
// from the cause, and `d59ce229` found a fourth that was zeroing 32KB of
// $PE_STAGING on every worker spawn.
//
// So this mode asks the narrower question the ratchet cannot: does a JS file
// other than the generated mirror contain a literal EQUAL to an allocated
// region's base or exclusive end? It is a hard gate, not a ratchet — the
// answer must be zero.
//
// THE FLOOR IS MEASURED, NOT GUESSED. Allocated bases pack from 0x100 up, so
// the low ones are 0x1000, 0x2000, 0x4000, 0x10000 — some of the commonest
// integers in a Win32 emulator, and matching them naively is the 884-false-
// positive trap all over again. Swept over lib/, tools/, test/ and host.js
// against today's layout (base and end, generated mirror excluded):
//
//     floor        candidate values   raw hits
//     0x00000000        202             780
//     0x00001000        199             702
//     0x00010000        149             205
//     0x00020000        139               3
//     0x00100000        139               3
//     0x01000000        139               3
//
// There is a cliff at 0x20000 and a plateau above it: every allocated value in
// the map is either below 0x20000 or above 0x100000, so 0x20000 is the LOWEST
// floor that reaches all 139 candidate values — a higher one costs coverage for
// nothing. Below it the map runs through the flag constants (0x10000 alone is
// WS_TABSTOP, DT_MODIFYSTRING, the MAKEINTRESOURCE boundary and the default
// thread stack size) and the rule stops meaning anything.
//
// Of the 3 hits at the chosen floor, 2 were the real $PE_STAGING scribble fixed
// in d59ce229 and the third is `['$GUEST_HEAP_BASE', 0x03D12000]` in
// tools/region-alloc.js — the allocator's own table of PINNED bases, which is a
// place the map IS legitimately written down. It is not exempted by filename:
// 0x03D12000 is $GUEST_HEAP_BASE, a derived base, that merely happens to also
// be the exclusive end of the region packed below it, and `pinnedBases` below
// drops every pinned/derived BASE — 139 candidates down to 138 checked. So the
// gate stands at ZERO today with no per-file exception beyond the generated
// mirror itself.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');
const { collectDeclarations } = require('./check-region-decls');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'region-census.baseline.json');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const flag = (name) => process.argv.includes(`--${name}`);

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

// Files to scan. The WAT parts are the map's home; the JS files hold the copies
// that tools/check-wat-js-constants.js polices with a regex per copy, and each
// of those becomes a generated constant instead (docs/watx-region-safety-design.md).
function scanTargets() {
  const targets = WAT_FILES.filter(f => f !== '00-regions.wat').map(f => `src/${f}`);
  for (const dir of ['lib', 'test']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (f.endsWith('.js')) targets.push(`${dir}/${f}`);
    }
  }
  return targets;
}

// The line that DECLARES a region's base or extent is the one copy we want, so
// it must not be counted as debt.
const DECLARING = /^\s*\(global\s+\$[A-Za-z0-9_]+(?:_SIZE)?\s+(?:i32|\(mut\s+i32\))\s+\(i32\.const\s/;

function stripComment(line, isWat) {
  if (isWat) {
    const at = line.indexOf(';;');
    return at === -1 ? line : line.slice(0, at);
  }
  const at = line.indexOf('//');
  return at === -1 ? line : line.slice(0, at);
}

function census(options = {}) {
  const decls = collectDeclarations().filter(d => d.base !== null && d.size !== null);
  const ordered = [...decls].sort((a, b) => a.base - b.base);
  // The high WAT-private map, where a number that looks like an address is one.
  const INTERIOR_FLOOR = 0x07000000;
  const INTERIOR_MAX = 0x10000;
  const LOOSE = options.loose ?? flag('loose');
  // See the header: region bases that are also ordinary integers.
  const NOISE_BASES = new Set([0x100, 0x380, 0x400]);
  // WAVE 3: only a PINNED region's base can be a copy of the map. An allocated
  // region's base is an output — it is written down nowhere, so no literal can
  // be a second copy of it, and any literal that happens to equal it equals a
  // number the allocator chose this morning. That is not a nuance: packing put
  // regions at 0x1000, 0x2000, 0x3000, 0x4000 and 0x10000, and counting base
  // coincidence against those took the census from 351 to 884 without a single
  // line of source changing. The signal the odometer exists to measure —
  // "somebody typed an address the declaration owns" — survives exactly on the
  // seven pinned regions and on the INTERIOR rule below.
  const byBase = new Map();
  for (const d of ordered) {
    if (d.kind === 'alloc') continue;
    if (!NOISE_BASES.has(d.base)) byBase.set(d.base, d);
    const end = d.base + d.size;
    if (!NOISE_BASES.has(end) && !byBase.has(end)) byBase.set(end, d);
  }
  const classify = (v) => {
    const exact = byBase.get(v);
    if (exact) return { region: exact, kind: v === exact.base ? 'base' : 'end' };
    // Innermost wins: a (within $OUTER) region is the more specific answer.
    let best = null;
    for (const d of ordered) {
      if (v >= d.base && v < d.base + d.size && (!best || d.size < best.size)) best = d;
    }
    if (!best) return null;
    const interior = best.base >= INTERIOR_FLOOR && best.size <= INTERIOR_MAX;
    if (!interior && !LOOSE) return null;
    return { region: best, kind: interior ? 'interior' : 'loose' };
  };

  const byFile = new Map();
  const byRegion = new Map();
  const sites = [];
  for (const rel of options.targets || scanTargets()) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const isWat = rel.endsWith('.wat');
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (isWat && DECLARING.test(raw)) continue;
      const code = stripComment(raw, isWat);
      for (const m of code.matchAll(/0[xX][0-9a-fA-F]{4,8}\b/g)) {
        const value = Number.parseInt(m[0], 16) >>> 0;
        const hit = classify(value);
        if (!hit) continue;
        const region = hit.region;
        byFile.set(rel, (byFile.get(rel) || 0) + 1);
        byRegion.set(region.name, (byRegion.get(region.name) || 0) + 1);
        sites.push({ file: rel, line: i + 1, literal: m[0], value, region: region.name,
                     kind: hit.kind, offset: value - region.base, text: raw.trim() });
      }
    }
  }
  return { decls, byFile, byRegion, sites };
}

// ---------------------------------------------------------------------------
// --js-copies
// ---------------------------------------------------------------------------

// See the header block. Measured, not chosen: the lowest floor that reaches
// every checkable allocated value, and the point at which the flag constants
// stop colliding with the map.
const JS_COPY_FLOOR = 0x20000;

// The generated mirror IS the map rendered for JS. It is the one file allowed
// to spell these addresses, which is the whole reason the rest may not.
const JS_COPY_EXEMPT = new Set(['lib/region-map.generated.js']);

function jsCopyTargets() {
  const targets = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })
                      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.js')) targets.push(child);
    }
  };
  for (const dir of ['lib', 'tools', 'test']) walk(dir);
  targets.push('host.js');
  return targets;
}

// `options.sources` is a Map(relPath -> text) that REPLACES the disk scan. It
// exists so test/test-region-js-copies.js can plant a violation in a string and
// prove the gate catches it, rather than proving only that today's tree is
// clean — a gate nobody has ever seen fire is a gate nobody knows works.
function jsCopies(options = {}) {
  const decls = collectDeclarations().filter(d => d.base !== null && d.size !== null);

  // A PINNED or DERIVED region's BASE is legitimately written down —
  // src/00-regions.wat states it outright and tools/region-alloc.js holds the
  // table of them — so it is not a copy of anything the allocator chose, even
  // when the region packed below it makes that address its own exclusive end.
  //
  // BASES ONLY, and that is load bearing. A pinned region's END is just the
  // next region's base: $THUNK_BASE ends at 0x07152000, which is where the
  // allocator put $PE_STAGING, and that is the exact address d59ce229 found
  // being scribbled. Exempting pinned ends would have let this gate report the
  // tree clean while the bug it exists to catch sat in lib/thread-manager.js.
  const pinnedBases = new Set();
  for (const d of decls) if (d.kind !== 'alloc') pinnedBases.add(d.base >>> 0);

  // Regions pack, so one address is routinely both a base and the region
  // below's exclusive end. BASES ARE ENTERED FIRST so the report names the
  // region a reader would recognise the address as, rather than the neighbour
  // it happens to abut.
  const byValue = new Map();
  const claim = (value, name, what) => {
    const v = value >>> 0;
    if (v < JS_COPY_FLOOR || pinnedBases.has(v) || byValue.has(v)) return;
    byValue.set(v, { name, what });
  };
  for (const d of decls) if (d.kind === 'alloc') claim(d.base, d.name, 'base');
  for (const d of decls) if (d.kind === 'alloc') claim(d.base + d.size, d.name, 'end');

  const scan = (rel, text) => {
    const found = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i].indexOf('//');
      const code = at === -1 ? lines[i] : lines[i].slice(0, at);
      for (const m of code.matchAll(/0[xX][0-9a-fA-F]{4,8}\b/g)) {
        const hit = byValue.get(Number.parseInt(m[0], 16) >>> 0);
        if (!hit) continue;
        found.push({ file: rel, line: i + 1, literal: m[0],
                     value: Number.parseInt(m[0], 16) >>> 0,
                     region: hit.name, what: hit.what, text: lines[i].trim() });
      }
    }
    return found;
  };

  const hits = [];
  if (options.sources) {
    for (const [rel, text] of options.sources) {
      if (JS_COPY_EXEMPT.has(rel)) continue;
      hits.push(...scan(rel, text));
    }
  } else {
    for (const rel of jsCopyTargets()) {
      if (JS_COPY_EXEMPT.has(rel)) continue;
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      hits.push(...scan(rel, fs.readFileSync(abs, 'utf8')));
    }
  }
  return { hits, checkedValues: byValue.size, floor: JS_COPY_FLOOR };
}

function main() {
  if (flag('js-copies')) {
    const r = jsCopies();
    for (const h of r.hits) {
      console.error(`region-census: ${h.file}:${h.line} holds ${h.literal}, ` +
        `which is $${h.region.replace(/^\$/, '')}'s ALLOCATED ${h.what}`);
      console.error(`    ${h.text.slice(0, 120)}`);
    }
    if (r.hits.length) {
      console.error('region-census: an allocated base is chosen by the compiler and MOVES ' +
        'whenever a size changes or a region is added — a JS copy of one is wrong at the ' +
        'next edit with no error to say so. Read lib/region-map.generated.js instead ' +
        '(docs/watx-region-safety-design.md).');
      process.exit(1);
    }
    console.log(`region-census OK: no JS file copies an allocated region address ` +
      `(${r.checkedValues} value(s) checked at or above ${hex(r.floor)})`);
    return;
  }

  const result = census();
  const total = result.sites.length;

  if (flag('json')) {
    console.log(JSON.stringify({
      total,
      byFile: Object.fromEntries([...result.byFile].sort((a, b) => b[1] - a[1])),
      byRegion: Object.fromEntries([...result.byRegion].sort((a, b) => b[1] - a[1])),
    }, null, 2));
    return;
  }

  const oneRegion = arg('region', '');
  const oneFile = arg('file', '');
  if (oneRegion || oneFile) {
    const hits = result.sites.filter(s =>
      (!oneRegion || s.region === oneRegion) && (!oneFile || s.file === oneFile));
    for (const s of hits) {
      console.log(`${s.file}:${s.line}  ${s.literal} = $${s.region}` +
        (s.offset ? ` + ${hex(s.offset)}` : ' (base)'));
      console.log(`    ${s.text.slice(0, 110)}`);
    }
    console.log(`${hits.length} raw literal(s)`);
    return;
  }

  if (flag('record')) {
    fs.writeFileSync(BASELINE, JSON.stringify({
      recorded: new Date().toISOString().slice(0, 10),
      note: 'Per-file counts of raw literals inside declared regions. This is a ' +
            'RATCHET: counts may fall, never rise. `converted` regions must stay at 0.',
      total,
      converted: readBaseline()?.converted || [],
      byFile: Object.fromEntries([...result.byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    }, null, 2) + '\n');
    console.log(`region-census: recorded ${total} literal(s) across ${result.byFile.size} file(s)`);
    return;
  }

  if (flag('gate')) {
    const base = readBaseline();
    if (!base) {
      console.error('region-census: no baseline; run --record once and commit it.');
      process.exit(1);
    }
    const problems = [];
    for (const [file, count] of result.byFile) {
      const was = base.byFile[file] ?? 0;
      if (count > was) problems.push(`${file}: ${was} -> ${count} raw region literal(s)`);
    }
    for (const name of base.converted || []) {
      const count = result.byRegion.get(name) || 0;
      if (count) problems.push(`$${name} is marked converted but has ${count} raw literal(s)`);
    }
    if (problems.length) {
      for (const p of problems) console.error(`region-census: ${p}`);
      console.error('region-census: the map is a ratchet — a raw address may be ' +
        'removed, never added. Address the region by name ' +
        '(docs/watx-region-safety-design.md).');
      process.exit(1);
    }
    const delta = base.total - total;
    console.log(`region-census OK: ${total} raw region literal(s)` +
      (delta > 0 ? `, ${delta} fewer than the baseline (run --record to bank it)` : ''));
    return;
  }

  const kinds = new Map();
  for (const s of result.sites) kinds.set(s.kind, (kinds.get(s.kind) || 0) + 1);
  console.log(`${total} raw region literal(s) across ${result.decls.length} declared regions ` +
    `(${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}).\n`);
  console.log('worst files:');
  for (const [file, count] of [...result.byFile].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(count).padStart(5)}  ${file}`);
  }
  console.log('\nworst regions:');
  for (const [name, count] of [...result.byRegion].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(count).padStart(5)}  $${name}`);
  }
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return null;
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

if (require.main === module) main();
module.exports = { census, jsCopies, JS_COPY_FLOOR };
