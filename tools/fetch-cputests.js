#!/usr/bin/env node

'use strict';

// Fetch per-opcode 8088 CPU test vectors into a local cache.
//
//   node tools/fetch-cputests.js --ops=00,01,88,8b        # named opcodes
//   node tools/fetch-cputests.js --ops=00-0f              # inclusive range
//   node tools/fetch-cputests.js --list                   # what the suite has
//   node tools/fetch-cputests.js --have                   # what we cached
//   node tools/fetch-cputests.js --ops=01 --show=3        # decode a few cases
//
// WHY: every A/B in this project is validated by a pixel diff, which cannot see
// a flag bit. SingleStepTests/8088 is per-instruction ground truth recorded off
// a physical AMD D8088 -- full initial register+flag+memory state, and a final
// state listing exactly what changed. That is the one corpus that can say a
// dispatch variant computes the same thing rather than merely drawing the same
// picture.
//
// The suite is ~700MB across 324 gzipped files, so this fetches the opcodes you
// ask for and caches them under test/corpus/8088/ (gitignored). Nothing here
// runs a test; tools/toyvm/ does that.
//
// Format note, from the suite's own README: the 'cycles' and 'queue' fields are
// for cycle-accurate verification and can be ignored entirely. What a state gate
// needs is initial.regs / initial.ram / final.regs / final.ram, and `final` is a
// DELTA -- only changed registers appear, with the whole flags word present if
// any flag moved.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, 'test', 'corpus', '8088');
const BASE = 'https://raw.githubusercontent.com/SingleStepTests/8088/main/v2';
const API = 'https://api.github.com/repos/SingleStepTests/8088/contents/v2';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (name) => process.argv.slice(2).includes(`--${name}`);

// Opcode names are the suite's own filenames: two upper-case hex digits, plus a
// handful of group forms like "80.0" (opcode 0x80, /0). Ranges expand over the
// plain two-digit ones only -- a group form has to be named outright.
function parseOps(spec) {
  const out = [];
  for (const piece of spec.split(',').map(s => s.trim()).filter(Boolean)) {
    const range = /^([0-9a-fA-F]{2})-([0-9a-fA-F]{2})$/.exec(piece);
    if (range) {
      const lo = parseInt(range[1], 16), hi = parseInt(range[2], 16);
      if (lo > hi) throw new Error(`empty range: ${piece}`);
      for (let i = lo; i <= hi; i++) out.push(i.toString(16).toUpperCase().padStart(2, '0'));
    } else if (/^[0-9a-fA-F]{2}(\.[0-7])?$/.test(piece)) {
      const [op, sub] = piece.split('.');
      out.push(op.toUpperCase().padStart(2, '0') + (sub === undefined ? '' : `.${sub}`));
    } else {
      throw new Error(`not an opcode or range: ${piece}`);
    }
  }
  return [...new Set(out)];
}

async function get(url, asJson) {
  const res = await fetch(url, { headers: { 'user-agent': 'wine-assembly-fetch-cputests' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return asJson ? res.json() : Buffer.from(await res.arrayBuffer());
}

async function listRemote() {
  const entries = await get(API, true);
  return entries
    .filter(e => e.name.endsWith('.json.gz'))
    .map(e => ({ name: e.name.replace(/\.json\.gz$/, ''), size: e.size }));
}

function cachedPath(op) { return path.join(CACHE, `${op}.json.gz`); }

// Returns the parsed test array for one opcode, fetching it if it is not cached.
// Exported so the runner reads vectors through the same path the CLI does.
async function loadOpcode(op, { quiet = false } = {}) {
  const file = cachedPath(op);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    if (!quiet) process.stderr.write(`fetching ${op} ... `);
    const buf = await get(`${BASE}/${op}.json.gz`, false);
    fs.writeFileSync(file, buf);
    if (!quiet) process.stderr.write(`${(buf.length / 1e6).toFixed(1)}MB\n`);
  }
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

async function main() {
  if (flag('list')) {
    const remote = await listRemote();
    const total = remote.reduce((a, e) => a + e.size, 0);
    for (const e of remote) console.log(`${e.name}\t${(e.size / 1e6).toFixed(2)}MB`);
    console.log(`\n${remote.length} opcode files, ${(total / 1e6).toFixed(0)}MB gzipped total`);
    return;
  }

  if (flag('have')) {
    if (!fs.existsSync(CACHE)) { console.log('nothing cached'); return; }
    const have = fs.readdirSync(CACHE).filter(f => f.endsWith('.json.gz')).sort();
    let bytes = 0;
    for (const f of have) bytes += fs.statSync(path.join(CACHE, f)).size;
    for (const f of have) console.log(f.replace(/\.json\.gz$/, ''));
    console.log(`\n${have.length} cached, ${(bytes / 1e6).toFixed(1)}MB in ${path.relative(ROOT, CACHE)}`);
    return;
  }

  const spec = arg('ops');
  if (!spec) {
    console.log('usage: node tools/fetch-cputests.js --ops=00,01,88 | --ops=00-0f | --list | --have');
    process.exit(2);
  }

  const ops = parseOps(spec);
  const show = Number(arg('show', 0));
  let cases = 0;
  for (const op of ops) {
    const tests = await loadOpcode(op);
    cases += tests.length;
    const names = new Set(tests.map(t => t.name.split(/\s+/)[0]));
    console.log(`${op}  ${String(tests.length).padStart(6)} cases  ${[...names].join('/')}`);
    for (let i = 0; i < show && i < tests.length; i++) {
      const t = tests[i];
      console.log(`      "${t.name}"  bytes=${t.bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log(`      initial flags=0x${t.initial.regs.flags.toString(16)} ip=0x${t.initial.regs.ip.toString(16)}`);
      console.log(`      final   ${Object.entries(t.final.regs).map(([k, v]) => `${k}=0x${v.toString(16)}`).join(' ')}`
        + (t.final.ram && t.final.ram.length ? `  ram=${t.final.ram.length} bytes` : ''));
    }
  }
  console.log(`\n${ops.length} opcodes, ${cases} cases`);
}

module.exports = { loadOpcode, parseOps, CACHE };

if (require.main === module) {
  main().catch(e => { console.error(String(e.message || e)); process.exit(1); });
}
