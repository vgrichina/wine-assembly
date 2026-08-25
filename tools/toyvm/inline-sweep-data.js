#!/usr/bin/env node

'use strict';

// Substitute a sweep's rows into an artifact template's __DATA__ placeholder.
//
//   node tools/toyvm/inline-sweep-data.js tpl.html sweep.json out.html
//
// The artifact CSP blocks every external fetch, so the page cannot load its own
// data at runtime -- it has to be inlined. Keeping the template and the data
// separate means a re-run of the sweep is a one-line refresh of the page rather
// than a hand-edit of 50 table rows, which is where transcription errors live.

const fs = require('fs');

const [tpl, sweep, out] = process.argv.slice(2);
if (!out) {
  console.log('usage: node tools/toyvm/inline-sweep-data.js <tpl.html> <sweep.json> <out.html>');
  process.exit(2);
}

const s = JSON.parse(fs.readFileSync(sweep, 'utf8'));
const rows = s.rows
  .filter(r => r.shells && r.shells.ok && r.dispatched >= 1e6)
  .map(r => ({
    n: r.name,
    px: r.pixels || 0,
    d: Math.round(r.dispatched / 1e5) / 10,
    base: Math.round(r.shells.ns.tailcall.min * 100) / 100,
    r: {
      rt: Math.round(r.shells.rel.repl_tailcall * 1000) / 1000,
      c: Math.round(r.shells.rel.calls * 1000) / 1000,
      s: Math.round(r.shells.rel.switch * 1000) / 1000,
    },
    j: r.jit && r.jit.speedup ? {
      a: Math.round(r.jit.speedup.t01 * 100) / 100,
      b: Math.round(r.jit.speedup.t12 * 100) / 100,
      c: Math.round(r.jit.speedup.t02 * 100) / 100,
      ops: r.jit.trace.ops,
    } : null,
  }))
  // Slowest baseline first would rank by program, not by result; alphabetical
  // keeps a re-run's diff readable.
  .sort((a, b) => a.n.toLowerCase() < b.n.toLowerCase() ? -1 : 1);

const html = fs.readFileSync(tpl, 'utf8');
if (!html.includes('__DATA__')) throw new Error('template has no __DATA__ placeholder');
fs.writeFileSync(out, html.replace('__DATA__', JSON.stringify({ rows })));
console.log(`${out}: ${rows.length} rows, ${fs.statSync(out).size} bytes`);
