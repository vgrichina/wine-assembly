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
//   node tools/region-census.js --embedded-wat  # refuse a hand-written address in a
//                                               # WAT fragment a JS test splices into src
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

// ============================================================================
// --hand-rolled — the form the other three rules cannot see, because it uses
// no literal address at all.
//
// `(i32.add (global.get $CONSOLE_INPUT) (i32.const 16))` is spelled entirely in
// symbols, so the census counts nothing, --js-copies sees no JS and
// --embedded-wat no fragment. It is still a second spelling of
// `(region.addr $CONSOLE_INPUT 16)`, and it is strictly weaker than one:
//
//   - region.addr CHECKS that offset + span is inside the region, at compile
//     time. The add form cannot: a global plus a number is a number, and an
//     offset that walks off the end of its table is exactly the bug the region
//     family exists to catch. That check is the entire reason to prefer it.
//   - region.addr is a CONSTANT (base + offset folded by the compiler); the add
//     form emits a global.get and an i32.add per site, which is why converting
//     23 sites made the module 29 bytes smaller with pixel-identical output.
//
// The rule only fires on a REGION BASE global — one spelled
// `(global $X i32 (region.addr $X 0))` — because that is the only case where
// the two forms mean the same address. `(i32.add (global.get $D3DIM_OFF_VP_RECT)
// (i32.const 4))` looks identical and is a struct field offset, not a region;
// there are 4342 such sites and none of them are the map. Getting that
// distinction wrong is what makes a naive grep report 86 hits where there are
// 40, so the region set is asked of the compiler, never of a name pattern.
//
// RATCHET, not a wall. The remaining sites live in files other lanes hold, so
// this records per-file counts in the baseline under `handRolledByFile` and
// fails when any file goes UP or a file absent from the baseline has any at
// all. New code cannot introduce the form; the existing ones are a list.
function regionBaseGlobals() {
  const names = new Set();
  for (const f of WAT_FILES) {
    const txt = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    const re = /\(global\s+(\$[A-Za-z0-9_]+)\s+i32\s+\(region\.addr\s+(\$[A-Za-z0-9_]+)\s+0\)\)/g;
    let m;
    while ((m = re.exec(txt))) if (m[1] === m[2]) names.add(m[1]);
  }
  return names;
}

function handRolled() {
  const bases = regionBaseGlobals();
  const placed = require('./region-layout.js').layout();
  const hits = [];
  const byFile = new Map();
  for (const f of WAT_FILES.filter(x => x !== '00-regions.wat')) {
    const rel = `src/${f}`;
    const lines = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = stripComment(raw, true);
      const re = /\(i32\.add\s+\(global\.get\s+(\$[A-Za-z0-9_]+)\)\s+\(i32\.const\s+(0x[0-9A-Fa-f]+|\d+)\)\)/g;
      let m;
      while ((m = re.exec(line))) {
        if (!bases.has(m[1])) continue;
        const region = placed.byName.get(m[1].slice(1));
        const offset = Number(m[2]);
        // An offset at or past the region's size is not debt, it is a BUG: the
        // region.addr form would refuse to compile it. Reported separately and
        // fatally, whatever the ratchet says.
        const outOfRegion = region ? offset >= region.size : false;
        hits.push({ file: rel, line: i + 1, global: m[1], offset, raw: m[2],
                    size: region ? region.size : null, outOfRegion, text: raw.trim() });
        byFile.set(rel, (byFile.get(rel) || 0) + 1);
      }
    });
  }
  return { hits, byFile, regions: bases.size };
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

// ============================================================================
// --embedded-wat — the half neither the ratchet nor --js-copies can see.
//
// A JS test may append WAT to a source part before compiling it (the
// `String.raw` corpus: 160 files today, via bootRenderHarness({ extraWat }) or
// compileSrcWasm). That fragment is compiled by our own compiler, so
// `region.addr $R off` is available inside it — which makes a bare
// `(i32.const N)` in a MEMORY-OPERAND position a copy of the map by
// construction, with no judgement call about whether the number "looks like an
// address": in that position it IS the address.
//
// --js-copies cannot catch these, and test-wave-out-get-id is the proof. It
// stored the open waveOut handle at a hard-coded 0xD160, which was
// $WAVE_OUT_SHARED before the map became allocated. Two independent reasons
// that gate was blind to it: the value equals no CURRENT base or end (a STALE
// copy matches nothing, and staleness is the entire failure mode), and 0xC140
// — where the region actually sits — is below its measured 0x20000 floor.
// Meanwhile 0xD160 had become an interior address of $SCROLL_TABLE, so the
// store was quietly scribbling on the scroll table and $handle_waveOutGetID
// answered MMSYSERR_INVALHANDLE to a valid handle.
//
// So this rule is INTERIOR-aware where --js-copies is base/end-only: any value
// inside an ALLOCATED region's extent counts, not just its endpoints. It can
// afford that precisely because the position already proved it is an address.
//
// PRECISION OVER RECALL. The positions checked are exactly these, all FOLDED:
//
//   (T.load*  <ADDR>)              T in i32/i64/f32/f64, any width/sign suffix
//   (T.store* <ADDR> <value>)      the first operand of a store is its address
//   (T.atomic.load|store|rmw*.OP <ADDR> ...)
//   (memory.fill|copy|init <ADDR> ...)   destination address
//
// where <ADDR> is literally `(i32.const N)` and `offset=`/`align=` immediates
// may sit between the opcode and it. NOT checked, deliberately: the stack
// (non-folded) form, computed addresses like `(i32.add (i32.const N) ...)`,
// and every other operand position — a store's VALUE, a call argument, a
// global.set. Those need a judgement about what the number means, and a gate
// that guesses is a gate that cries wolf and gets deleted. This one only ever
// fires on a syntactic position where being wrong is not possible.
//
// Only ALLOCATED regions are consulted. A pinned or derived base does not move,
// so a literal inside one is not the drift this exists to catch.
// ============================================================================

// A template literal that plausibly holds WAT. Requires a real opening form,
// so a JS backtick string of prose or SQL is never scanned.
const WAT_FRAGMENT = /\(\s*(?:module|func|global|memory|data|elem|type|table|local|i32|i64|f32|f64)\b/;

// THE SCOPE, and why it is the file and not the fragment. "Our map" means the
// map of the module the fragment is compiled INTO, so only a fragment SPLICED
// INTO THE EMULATOR'S OWN SOURCES is addressing it. There are exactly two ways
// to do that — bootRenderHarness({ extraWat }) and compileSrcWasm(), both of
// which append to a src/*.wat part before compiling the tree.
//
// Everything else compiling WAT in this repo is a compiler unit test
// (test/watx-compiler-*.test.js), which builds a SELF-CONTAINED module with its
// own (memory ...) and sometimes its own region.declare. Its 0x100 is an offset
// into an address space that exists for four lines and has nothing to do with
// $STRING_CONSTANTS. Flagging those is the 884-false-positive trap of the
// original census in a new costume: 38 hits, every one of them noise, in the
// files whose whole job is to write small standalone modules.
//
// This is a discriminator, not a filename exemption — a compiler test that
// starts splicing into our sources would be scanned, and a new appending
// harness only has to be named here.
const WAT_APPENDERS = /\b(?:extraWat|compileSrcWasm)\b/;

// And a second guard at the fragment level, for the same reason stated locally:
// a fragment that brings its own memory or declares its own regions carries its
// own address space, so its literals cannot be copies of ours.
// `memory` must be followed by whitespace or a close paren so this matches the
// memory SECTION — `(memory 1 1 shared)` — and not the instruction
// `(memory.fill ...)`, whose own dot is a word boundary.
const SELF_CONTAINED = /\(\s*(?:memory[\s)]|region\.declare)/;

// The address operand of every folded memory access. See the header above for
// the positions this does and does not cover.
const MEM_OPERAND = new RegExp(
  '\\(\\s*(?:'
  + '(?:i32|i64|f32|f64)\\.(?:atomic\\.)?'
  + '(?:rmw(?:8|16|32)?\\.[a-z_]+|(?:load|store)(?:8|16|32)?(?:_[su])?)'
  + '|memory\\.(?:fill|copy|init)'
  + ')\\s+(?:(?:offset|align)=[0-9A-Fa-fxX]+\\s+)*'
  + '\\(\\s*i32\\.const\\s+(0[xX][0-9A-Fa-f]+|\\d+)\\s*\\)',
  'g');

// Blank out `;;` comments while preserving every offset, so a match's index
// still maps to the right line and an address named in prose is not a hit.
function blankWatComments(text) {
  return text.replace(/;;[^\n]*/g, (m) => ' '.repeat(m.length));
}

// Every template-literal body in a JS source, with its absolute start offset.
// A real lexer pass rather than a backtick regex: a backtick inside a string or
// a `//` comment must not open a fragment, and `${ }` may nest one template
// inside another.
function templateLiterals(text) {
  const out = [];
  // Each open template pushes { start, depth }: `depth` counts the `${ }` it is
  // currently inside, so the backtick that closes it is the one seen at depth 0.
  const stack = [];
  const inTemplateBody = () => stack.length > 0 && stack[stack.length - 1].depth === 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }

    // INSIDE a template body only backticks, `${` and escapes are syntax. This
    // is not a detail: a WAT `;;` comment reading "the callback's stdcall RET 4"
    // has an apostrophe in it, and treating that as a JS string start swallowed
    // the rest of the file — the scanner then reported zero fragments and the
    // gate passed everything.
    if (inTemplateBody()) {
      if (c === '`') {
        const { start } = stack.pop();
        out.push({ start, text: text.slice(start, i) });
      } else if (c === '$' && text[i + 1] === '{') {
        stack[stack.length - 1].depth += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c && text[i] !== '\n') {
        i += (text[i] === '\\' ? 2 : 1);
      }
      i += 1;
      continue;
    }
    if (c === '`') { stack.push({ start: i + 1, depth: 0 }); i += 1; continue; }
    if (c === '{' && stack.length) { stack[stack.length - 1].depth += 1; i += 1; continue; }
    if (c === '}' && stack.length && stack[stack.length - 1].depth > 0) {
      stack[stack.length - 1].depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function embeddedWat(options = {}) {
  const decls = collectDeclarations()
    .filter(d => d.base !== null && d.size !== null && d.kind === 'alloc')
    .sort((a, b) => a.base - b.base);

  const owner = (v) => decls.find(d => v >= (d.base >>> 0) && v < ((d.base + d.size) >>> 0));

  const scan = (rel, text) => {
    const found = [];
    let fragments = 0;
    if (!WAT_APPENDERS.test(text)) return { found, fragments };
    for (const frag of templateLiterals(text)) {
      if (!WAT_FRAGMENT.test(frag.text)) continue;
      if (SELF_CONTAINED.test(frag.text)) continue;
      fragments += 1;
      const body = blankWatComments(frag.text);
      for (const m of body.matchAll(MEM_OPERAND)) {
        const value = (m[1].startsWith('0x') || m[1].startsWith('0X')
          ? Number.parseInt(m[1], 16) : Number.parseInt(m[1], 10)) >>> 0;
        const region = owner(value);
        if (!region) continue;
        const at = frag.start + m.index;
        found.push({
          file: rel,
          line: text.slice(0, at).split('\n').length,
          literal: m[1],
          value,
          region: region.name,
          offset: (value - region.base) >>> 0,
          text: m[0].replace(/\s+/g, ' '),
        });
      }
    }
    return { found, fragments };
  };

  const hits = [];
  let fragments = 0;
  const each = (rel, text) => {
    const r = scan(rel, text);
    hits.push(...r.found);
    fragments += r.fragments;
  };
  if (options.sources) {
    for (const [rel, text] of options.sources) each(rel, text);
  } else {
    for (const rel of jsCopyTargets()) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      each(rel, fs.readFileSync(abs, 'utf8'));
    }
  }
  return { hits, fragments, checkedRegions: decls.length };
}

function main() {
  if (flag('hand-rolled')) {
    const r = handRolled();
    const bugs = r.hits.filter(h => h.outOfRegion);
    for (const h of bugs) {
      console.error(`region-census: ${h.file}:${h.line} addresses ${h.global} + ${h.raw}, ` +
        `but the region is only 0x${h.size.toString(16)} bytes — this is OUT OF REGION`);
      console.error(`    ${h.text.slice(0, 120)}`);
    }
    const baseline = readBaseline() || {};
    const recorded = baseline.handRolledByFile || {};
    if (flag('record')) {
      const out = { ...baseline, handRolledByFile: Object.fromEntries(
        [...r.byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) };
      fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
      console.log(`region-census --hand-rolled --record: ${r.hits.length} site(s) in ` +
        `${r.byFile.size} file(s) recorded`);
      return;
    }
    const risen = [];
    for (const [file, n] of r.byFile) {
      const was = recorded[file] || 0;
      if (n > was) risen.push({ file, n, was });
    }
    for (const x of risen) {
      console.error(`region-census: ${x.file} has ${x.n} hand-rolled region address(es), ` +
        `baseline ${x.was}`);
      for (const h of r.hits.filter(h => h.file === x.file)) {
        console.error(`    ${x.file}:${h.line}  write (region.addr ${h.global} ${h.raw})`);
      }
    }
    if (risen.length || bugs.length) {
      console.error('region-census: (i32.add (global.get $REGION) (i32.const N)) is ' +
        '(region.addr $REGION N) with the bounds check removed and two instructions added. ' +
        'The region.addr form proves at compile time that the offset is inside the region; ' +
        'the add form cannot, which is how an offset walks off a table with nothing to say ' +
        'so. Ratchet baseline: tools/region-census.baseline.json handRolledByFile ' +
        '(--hand-rolled --record to re-cut it after a conversion).');
      process.exit(1);
    }
    const listed = Object.values(recorded).reduce((a, b) => a + b, 0);
    console.log(`region-census OK: ${r.hits.length} hand-rolled region address(es) in ` +
      `${r.byFile.size} file(s), none above the ${listed}-site baseline ` +
      `(${r.regions} region base globals checked)`);
    return;
  }

  if (flag('embedded-wat')) {
    const r = embeddedWat();
    for (const h of r.hits) {
      const name = h.region.replace(/^\$/, '');
      console.error(`region-census: ${h.file}:${h.line} addresses ${hex(h.value)} directly, ` +
        `which is inside ALLOCATED $${name} (+${hex(h.offset)})`);
      console.error(`    ${h.text.slice(0, 120)}`);
      console.error(`    write (region.addr $${name} ${hex(h.offset)}) instead`);
    }
    if (r.hits.length) {
      console.error('region-census: a WAT fragment embedded in JS is compiled by our own ' +
        'compiler, so region.addr resolves inside it. A bare address there is a copy of a ' +
        'map the allocator re-places on every layout change — and it goes stale silently, ' +
        'landing in whatever region moved on top of it (docs/watx-region-safety-design.md).');
      process.exit(1);
    }
    console.log(`region-census OK: no embedded WAT fragment addresses the map by hand ` +
      `(${r.fragments} fragment(s), ${r.checkedRegions} allocated region(s))`);
    return;
  }

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
module.exports = { census, jsCopies, embeddedWat, handRolled, templateLiterals, JS_COPY_FLOOR };
