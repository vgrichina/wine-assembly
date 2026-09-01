#!/usr/bin/env node
// region-alloc.js — the allocated map: is it legal, does it still pin the ABI,
// and how much room is left for a shake to move things?
//
//   node tools/region-alloc.js                # counts, pins, slack
//   node tools/region-alloc.js --list         # the resulting layout
//   node tools/region-alloc.js --diff         # the seven pinned bases vs the ABI
//   node tools/region-alloc.js --shake=gap    # what a permuted layout looks like
//   node tools/region-alloc.js --shake-all    # GATE: every shake mode still places
//   node tools/region-alloc.js --reclaim      # ONE-SHOT: fixed -> allocated
//
// WHAT CHANGED IN WAVE 3. Until 2026-08-31 every region in src/00-regions.wat
// was `region.declare-fixed`, and this tool's job was to prove that an
// ALLOCATED form — declaration order, first-fit, and an explicit
// `(region.gap …)` at every hand-placed hole — reproduced that map byte for
// byte. It did, and then the map was converted (§8.1): the gaps are gone, the
// floor is 0x100, seven regions stay pinned and the other ~167 are placed by
// the allocator. So the emitted-and-compared form no longer exists; the real
// file IS the allocated form, and the questions worth asking about it are
// different ones.
//
// `--diff` is still the gate, but it now means: **the seven pinned bases are
// exactly the addresses the guest ABI and the JavaScript side hold.** Those are
// the only bases in the map that may not move. Everything else moving is the
// point of the exercise, so diffing it against yesterday's address would report
// success as failure.
//
// There is ONE allocator. This tool does not reimplement it — tools/region-
// layout.js asks the vendored compiler where the regions landed, so a bug here
// cannot disagree with a build.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DECLS = path.join(ROOT, 'src', '00-regions.wat');

// The floor. Below it lives NULL_SENTINEL at 0xF0, which $g2w's sink behaviour
// pins; nothing there may be allocated. It sits at 0x100 — not 0x1000 —
// because the low string pool is a real declared region ($STRING_CONSTANTS at
// 0x100, $VK_SCAN_TABLES at 0x380), and a floor above them makes first-fit
// unable to place them at all.
const ALLOC_FLOOR = 0x100;

// The guest image base every `g2w` is stated against, and the seven bases that
// are an ABI rather than a placement. Four are anchored by a guest address
// (declared `region.declare-derived (base (g2w VA))`, so the arithmetic is in
// the source rather than in a comment) and three are the backing windows,
// which are sized to consume whatever memory is left and therefore have
// nowhere to move to. §8.1 of docs/watx-region-safety-design.md is where the
// list comes from.
const IMAGE_BASE = 0x400000;
const PINNED_ABI = new Map([
  ['$GUEST_BASE', 0x00012000],
  ['$GUEST_HEAP_BASE', 0x03D12000],
  ['$GUEST_STACK', 0x07012000],
  ['$THUNK_BASE', 0x07112000],
  ['$VIRTUAL_BACKING_BASE', 0x08000000],
  ['$DIB_BACKING_BASE', 0x1C000000],
  ['$THREAD_RPC', 0x1FF00000],
]);
// $GUEST_BASE itself stays `region.declare-fixed`: it is the anchor every
// `(g2w …)` is resolved through, so it cannot be expressed in terms of itself.
const DERIVED = new Set(['$GUEST_HEAP_BASE', '$GUEST_STACK', '$THUNK_BASE']);

// The top of the guest-visible window. Slack below it is the budget a shake
// spends; above it sit the three backing windows with nothing between them.
const SHAKE_CEILING = 0x08000000;

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

function arg(name, fallback = null) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
}

// A small dedicated reader, for the same reason tools/check-region-decls.js has
// one: this runs beside the build's gates, and reading the file with the
// compiler it is describing makes a failure recursive.
const HEAD = /^(\s*)\(region\.declare(-fixed|-derived|-span)?\s+(\$[A-Za-z0-9_]+)\b/;
function readDeclarations() {
  const lines = fs.readFileSync(DECLS, 'utf8').split(/\r?\n/);
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    const head = HEAD.exec(lines[i]);
    if (!head) continue;
    let depth = 0, body = '', j = i;
    do {
      body += lines[j] + '\n';
      for (const ch of lines[j]) { if (ch === '(') depth++; else if (ch === ')') depth--; }
      j++;
    } while (depth > 0 && j < lines.length);
    const num = (name) => {
      const m = new RegExp(`\\(${name}\\s+([^)\\s]+)\\)`).exec(body);
      if (!m) return null;
      return /^0x/i.test(m[1]) ? Number.parseInt(m[1], 16) : Number.parseInt(m[1], 10);
    };
    const owner = (/\(owner\s+"([^"]*)"\)/.exec(body) || [])[1] || null;
    const base = num('base');
    const end = num('end');
    const size = num('size') !== null ? num('size') : (end !== null && base !== null ? end - base : null);
    decls.push({
      name: head[3],
      kind: { '-fixed': 'fixed', '-derived': 'derived', '-span': 'span' }[head[2]] || 'alloc',
      base, size, align: num('align') || 4, owner, line: i + 1, first: i, last: j - 1,
    });
    i = j - 1;
  }
  return decls;
}

// ── The one-shot conversion ─────────────────────────────────────────────────
// Rewrites the declaration HEADS in place and leaves every comment, clause and
// line break where it is: the file is 450 lines of hard-won annotation, and a
// generated replacement would throw all of it away to save an afternoon.
//
// A fixed region becomes `region.declare` and loses its `(base …)`, because an
// allocated region's base is an OUTPUT. The four guest-anchored ones keep
// their address, three of them stated as the guest VA they actually mean.
// Running it twice is a no-op.
function reclaim() {
  const decls = readDeclarations();
  const lines = fs.readFileSync(DECLS, 'utf8').split(/\r?\n/);
  let converted = 0, pinned = 0, derived = 0;
  for (const d of decls) {
    if (d.kind !== 'fixed') continue;
    if (PINNED_ABI.has(d.name) && !DERIVED.has(d.name)) { pinned++; continue; }
    const line = lines[d.first];
    if (DERIVED.has(d.name)) {
      const va = d.base - PINNED_ABI.get('$GUEST_BASE') + IMAGE_BASE;
      lines[d.first] = line
        .replace('(region.declare-fixed ', '(region.declare-derived ')
        .replace(/\(base\s+0x[0-9A-Fa-f]+\)/, `(base (g2w ${hex(va)}))`);
      derived++;
      continue;
    }
    lines[d.first] = line
      .replace('(region.declare-fixed ', '(region.declare ')
      .replace(/\(base\s+0x[0-9A-Fa-f]+\)\s*/, '');
    converted++;
  }
  // The floor goes in ahead of the first declaration, wherever the comments
  // put it, so the file keeps its shape.
  if (!/\(region\.floor\b/.test(lines.join('\n'))) {
    const first = decls.find(d => d.kind !== 'span');
    lines.splice(first.first, 0,
      `  ;; The allocator starts here. Below it: NULL_SENTINEL at 0xF0, which`,
      `  ;; $g2w's sink behaviour pins and nothing may be placed on top of.`,
      `  (region.floor ${hex(ALLOC_FLOOR)})`,
      ``);
  }
  fs.writeFileSync(DECLS, lines.join('\n'));
  console.log(`region-alloc --reclaim: ${converted} region(s) now allocated, ` +
    `${derived} derived from a guest VA, ${pinned} left pinned`);
  return 0;
}

// The five shakes §8 defines. A named mode is a fixed permutation; the seed is
// a pseudo-random one, held constant so this is a gate and not a lottery.
const SHAKE_MODES = ['gap', 'pad', 'rotate', 'reverse', '0x9E3779B9'];

// ── The gate: can every shake still be PLACED? ──────────────────────────────
// docs/watx-region-safety-design.md §8 says the shake is the instrument that
// proves nothing in the tree has memorized an allocated base. That instrument
// only works while the shaken layout compiles, and it has been one region-size
// bump away from not compiling with nothing watching.
//
// MEASURED 2026-08-31: `rotate` leaves 0x00000000 free below 0x08000000.
// $TV_IMAGE_TABLE lands at 0x07FFF000 and is 4096 bytes long, so it ends on
// $VIRTUAL_BACKING_BASE's first byte exactly.
//
// That reads like a one-page knife edge and IS NOT ONE — I checked, because the
// number invites the wrong conclusion. Growing $TV_IMAGE_TABLE by a page does
// not break rotate; placeShakenAroundPins is BEST fit, so it re-drains the
// small regions into different windows and rotate comes back with 0x280 spare.
// The zero is what perfect packing looks like, not what running out looks like.
// The real headroom is the tightest mode's slack — `gap`, at 0x001B1000 — and
// it takes about 6 MB of new region under the ceiling to make any mode fail.
// So this gate is not a tripwire under somebody's next 4 KB table; it is the
// thing that will notice the 6 MB one.
//
// The failure it prevents is silent in the direction that matters: tools/
// build.sh never ran a shake and tools/region-shake-smoke.js is wired into
// nothing, so the first symptom would have been whoever next reached for the
// shake finding it broken, with no way to tell whether the map or their own
// change did it.
//
// The check is deliberately "does it PLACE", not "is there N bytes spare". A
// slack floor would fail today, on a map that is legal, and a gate that is red
// on arrival gets switched off. placeShakenAroundPins throws when a region
// does not fit in any free window, so exercising each mode IS the check; the
// slack column is reported so the trend is visible before it hits zero.
function shakeAll() {
  const { layout } = require('./region-layout.js');
  const rows = [];
  let failures = 0;
  for (const mode of SHAKE_MODES) {
    let placed = null, err = null;
    try { placed = layout({ shake: mode }); }
    catch (e) { err = String(e && e.message || e); }
    if (err) { failures++; rows.push({ mode, err }); continue; }
    let used = 0;
    for (const r of placed.regions) {
      if (r.kind === 'span' || r.base >= SHAKE_CEILING) continue;
      used = Math.max(used, r.base + r.size);
    }
    rows.push({ mode, slack: SHAKE_CEILING - used, scaled: placed.shakeScaledDown });
  }
  for (const r of rows) {
    if (r.err) { console.log(`  ${r.mode.padEnd(12)} CANNOT PLACE — ${r.err}`); continue; }
    console.log(`  ${r.mode.padEnd(12)} places, ${hex(r.slack)} free below ${hex(SHAKE_CEILING)}` +
      (r.scaled ? `, ${r.scaled} region(s) placed without their padding` : '') +
      (r.slack === 0 ? '  <-- AT THE CEILING, nothing may grow' : ''));
  }
  if (failures) {
    console.log(`region-alloc --shake-all: ${failures} of ${SHAKE_MODES.length} shake mode(s) ` +
      `cannot be placed. The map has outgrown the room a shake needs to move it, so §8's ` +
      `instrument is unusable. Shrink something below ${hex(SHAKE_CEILING)}, or decide that ` +
      `$VIRTUAL_BACKING_BASE's 320 MB is the wrong shape (design doc §13, "next, in order").`);
    return 1;
  }
  console.log(`region-alloc --shake-all: all ${SHAKE_MODES.length} shake modes place`);
  return 0;
}

function main() {
  if (arg('reclaim')) return process.exit(reclaim());
  if (arg('shake-all')) return process.exit(shakeAll());

  const decls = readDeclarations();
  const shake = arg('shake');
  const { layout } = require('./region-layout.js');
  const placed = layout(shake ? { shake: shake === true ? 'gap' : shake } : {});
  const byName = placed.byName;

  if (arg('list')) {
    for (const r of placed.regions) {
      console.log(`${hex(r.base)} +${String(r.size).padStart(9)}  ${r.name}` +
        (r.kind === 'alloc' ? '' : `  [${r.kind}]`));
    }
  }

  // Slack: the bytes still free below the backing windows, which is the whole
  // budget a shake has to displace anything into.
  let used = 0;
  for (const r of placed.regions) {
    if (r.kind === 'span' || r.base >= SHAKE_CEILING) continue;
    used = Math.max(used, r.base + r.size);
  }
  const slack = SHAKE_CEILING - used;

  const diffs = [];
  for (const [name, abi] of PINNED_ABI) {
    const got = byName.get(name.slice(1));
    if (!got) { diffs.push(`${name}: not declared at all`); continue; }
    if (got.base !== abi) {
      diffs.push(`${name}: ABI ${hex(abi)}, placed ${hex(got.base)} ` +
        `(${got.base > abi ? '+' : ''}${got.base - abi})`);
    }
  }

  const kinds = { fixed: 0, derived: 0, alloc: 0, span: 0 };
  for (const r of placed.regions) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  console.log(`region-alloc: ${decls.length} declared — ${kinds.alloc} allocated, ` +
    `${kinds.fixed} fixed, ${kinds.derived} derived, ${kinds.span} span; ` +
    `floor ${hex(placed.floor)}, map ends ${hex(placed.end)}, ` +
    `${hex(slack)} free below ${hex(SHAKE_CEILING)}` +
    (shake ? `, SHAKEN (${placed.shake})` : ''));

  if (diffs.length) {
    for (const line of diffs) console.log(`  ${line}`);
    console.log(`region-alloc: ${diffs.length} PINNED region(s) are not at their ABI address`);
    process.exit(1);
  }
  console.log('region-alloc: every pinned base is at its ABI address');
  process.exit(0);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(String(err && err.message || err)); process.exit(2); }
}

module.exports = { readDeclarations, ALLOC_FLOOR, PINNED_ABI, DERIVED, IMAGE_BASE };
