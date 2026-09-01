#!/usr/bin/env node
// region-layout.js — where the regions ACTUALLY land, asked of the compiler.
//
// WHY THIS EXISTS
// Until wave 3 every region was `region.declare-fixed`, so its base was written
// in `src/00-regions.wat` and a text scan could read it. Five tools did exactly
// that. From wave 3 on most regions are `region.declare` and their bases are the
// ALLOCATOR's output — there is no base in the source to scan, and a tool that
// keeps scanning for one reports an empty map with no error.
//
// So there is one reader, and it does not parse: it hands the declaration file to
// the vendored compiler and reads `result.regions`, the same layout the shipped
// wasm is built against. A bug here cannot disagree with a build, which is the
// property `tools/region-alloc.js` already relies on and the reason that tool
// does not reimplement the allocator either.
//
//   const { layout } = require('./region-layout');
//   layout().byName.get('WND_RECORDS')   // { name, kind, base, size, align, owner }
//   layout().regions                     // sorted by base
//   layout().end                         // last byte the map reaches
//   layout().holes                       // [{ base, size, after, before }]
//
// `layout({ shake: 'gap' })` asks for a permuted placement (§8) without touching
// the tree. The result is memoized per shake key, because several callers ask for
// the same layout in one process and a compile is not free.
//
// CLI:
//   node tools/region-layout.js            # the placed map
//   node tools/region-layout.js --holes    # the gaps in it, largest first
//   node tools/region-layout.js --json
//   node tools/region-layout.js --shake=gap
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DECLS = path.join(ROOT, 'src', '00-regions.wat');

// 512 MB — `(import "host" "memory" (memory 8192 8192 shared))` in
// src/01-header.wat. The allocator refuses a region that ends past the memory
// guaranteed at instantiation, so the synthetic module has to declare the real
// size or the map would be rejected for running off the end of a memory that
// only this file is small enough to have.
const MEMORY_PAGES = 8192;

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

const cache = new Map();

function layout(options = {}) {
  const shake = options.shake || null;
  const key = String(shake);
  if (cache.has(key) && !options.fresh) return cache.get(key);

  const source = fs.readFileSync(DECLS, 'utf8');
  const { compile } = require(path.join(__dirname, 'watx.js'));
  // A trivial function and export so the module is well formed; the declarations
  // themselves emit nothing, which is the whole point of the family.
  const module = `(memory ${MEMORY_PAGES} ${MEMORY_PAGES})\n${source}\n` +
    `(func $noop (effects heap) (nop))\n(wasm-export "noop" $noop)\n`;
  const opts = { mode: 'production', standardWat: true, runtimeBuiltins: false, tailCalls: true };
  if (shake) opts.regionShake = shake;
  const r = compile(module, new Map(), opts);
  if (!r.success) {
    throw new Error(`region-layout: src/00-regions.wat does not compile: ${r.error}`);
  }
  const report = r.regions;
  const regions = report.regions.slice().sort((a, b) => a.base - b.base);
  const byName = new Map(regions.map(x => [x.name.replace(/^\$/, ''), x]));

  // Holes are computed over the regions that OWN bytes. A span is a named
  // address limit that contains other regions, so counting it as occupied would
  // report the whole map as one region and no holes at all.
  const solid = regions.filter(x => x.kind !== 'span');
  const holes = [];
  let cursor = 0, prev = null;
  for (const x of solid) {
    if (x.base > cursor) {
      holes.push({ base: cursor, size: x.base - cursor,
                   after: prev ? prev.name : '(the floor)', before: x.name });
    }
    cursor = Math.max(cursor, x.base + x.size);
    prev = x;
  }
  const end = cursor;

  const result = {
    regions, byName, holes, end,
    spans: regions.filter(x => x.kind === 'span'),
    counts: {
      pinned: regions.filter(x => x.kind === 'fixed').length,
      derived: regions.filter(x => x.kind === 'derived').length,
      allocated: regions.filter(x => x.kind === 'alloc').length,
      span: regions.filter(x => x.kind === 'span').length,
    },
    floor: report.floor,
    imageBase: report.imageBase,
    shake: report.shake,
    // Shaken layouts only: how many regions had to be placed without their gap
    // or padding because no free window held the inflated footprint.
    shakeScaledDown: report.shakeScaledDown || 0,
    memoryBytes: MEMORY_PAGES * 65536,
  };
  cache.set(key, result);
  return result;
}

function main() {
  const arg = (n) => {
    const hit = process.argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
    if (!hit) return null;
    const eq = hit.indexOf('=');
    return eq < 0 ? true : hit.slice(eq + 1);
  };
  const shake = arg('shake');
  const L = layout({ shake: shake === true ? 'gap' : shake });
  if (arg('json')) { console.log(JSON.stringify(L.regions, null, 2)); return 0; }
  if (arg('holes')) {
    for (const h of [...L.holes].sort((a, b) => b.size - a.size)) {
      console.log(`${hex(h.base)} +${String(h.size).padStart(10)}  ` +
        `between ${h.after} and ${h.before}`);
    }
    const total = L.holes.reduce((n, h) => n + h.size, 0);
    console.log(`region-layout: ${L.holes.length} hole(s), ${hex(total)} bytes`);
    return 0;
  }
  for (const x of L.regions) {
    console.log(`${hex(x.base)} +${String(x.size).padStart(10)}  ${x.kind.padEnd(8)} ${x.name}`);
  }
  const c = L.counts;
  console.log(`region-layout: ${L.regions.length} regions ` +
    `(${c.pinned} pinned, ${c.derived} derived, ${c.allocated} allocated, ${c.span} span), ` +
    `floor ${hex(L.floor)}, map ends at ${hex(L.end)}, ` +
    `${hex(L.memoryBytes - L.end)} clear above it` +
    (L.shake ? `, SHAKEN (${L.shake})` : ''));
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); }
  catch (err) { console.error(String(err && err.message || err)); process.exit(2); }
}

module.exports = { layout, MEMORY_PAGES };
