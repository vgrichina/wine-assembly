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
  const byBase = new Map();
  for (const d of ordered) {
    byBase.set(d.base, d);
    if (!byBase.has(d.base + d.size)) byBase.set(d.base + d.size, d);
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

function main() {
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
module.exports = { census };
