#!/usr/bin/env node
'use strict';

// Near-duplicate function census over src/*.wat.
//
//   node tools/wat-dup-census.js [--min-tokens=40] [--jaccard=0.85] [--top=60]
//                                [--new-from=REV] [--prefix-total=test_call_]
//
// Every `(func $name ...)` body is comment-stripped, tokenized, and its own
// name replaced by $SELF, so two functions that differ only in what they are
// called hash the same. Exact matches are reported as groups; near matches are
// scored by Jaccard over 4-token shingles through an inverted index (shingles
// shared by more than 64 functions are dropped as boilerplate). Pairs are
// ranked by the smaller function's size, so the biggest copy-paste is first.
// `--new-from=REV` marks a function NEW when its header line is an addition in
// `git diff REV..HEAD -- src`, which is how a review window is scoped.
// `--prefix-total=P` also prints the total line count of every function whose
// header mentions P (e.g. every `test_call_` export wrapper).

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const MIN_TOKENS = Number(arg('min-tokens', 40));
const MIN_J = Number(arg('jaccard', 0.85));
const TOP = Number(arg('top', 60));
const NEW_FROM = arg('new-from', null);
const PREFIX_TOTAL = arg('prefix-total', null);
// Shingles shared by more than this many functions are treated as boilerplate
// (handler prologues, `esp += N` epilogues) and dropped from the index.
const SHARED_CAP = Number(arg('shared-cap', 64));

function stripComments(text) {
  // Keep every newline so reported line numbers match the file on disk.
  return text.replace(/;;.*$/gm, '')
    .replace(/\(;[\s\S]*?;\)/g, m => m.replace(/[^\n]/g, ''));
}

function extractFuncs(file, text) {
  const out = [];
  const lines = text.split('\n');
  const clean = stripComments(text);
  const re = /\(func\s+(\$[^\s()]+|\(export\s+"[^"]+"\))/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    let depth = 0, end = m.index;
    for (; end < clean.length; end++) {
      if (clean[end] === '(') depth++;
      if (clean[end] === ')' && --depth === 0) { end++; break; }
    }
    const body = clean.slice(m.index, end);
    const line = clean.slice(0, m.index).split('\n').length;
    const nlines = body.split('\n').length;
    const name = m[1];
    const norm = body.split(name).join('$SELF').replace(/\s+/g, ' ');
    const tokens = norm.split(/[\s()]+/).filter(Boolean);
    out.push({ file, name, line, nlines, tokens, header: lines[line - 1] || '' });
    re.lastIndex = end;
  }
  return out;
}

const funcs = [];
for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.wat')).sort()) {
  funcs.push(...extractFuncs(f, fs.readFileSync(path.join(SRC, f), 'utf8')));
}

let added = new Set();
if (NEW_FROM) {
  const diff = childProcess.execFileSync('git', ['diff', `${NEW_FROM}..HEAD`, '--', 'src'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 });
  for (const l of diff.split('\n')) {
    const m = /^\+\s*\(func\s+(\$[^\s()]+|\(export\s+"[^"]+"\))/.exec(l);
    if (m) added.add(m[1]);
  }
}
const tag = fn => (added.has(fn.name) ? 'NEW ' : '    ');
const label = fn => `${fn.file}:${fn.line} ${fn.name} (${fn.nlines}L)`;

if (PREFIX_TOTAL) {
  const hits = funcs.filter(fn => fn.header.includes(PREFIX_TOTAL));
  const total = hits.reduce((s, fn) => s + fn.nlines, 0);
  console.log(`prefix "${PREFIX_TOTAL}": ${hits.length} functions, ${total} lines\n`);
}

// Exact duplicates (name-agnostic).
const exact = new Map();
for (const fn of funcs) {
  if (fn.tokens.length < 12) continue;
  const key = fn.tokens.join(' ');
  if (!exact.has(key)) exact.set(key, []);
  exact.get(key).push(fn);
}
const groups = [...exact.values()].filter(g => g.length > 1)
  .sort((a, b) => b[0].tokens.length * b.length - a[0].tokens.length * a.length);
console.log(`EXACT duplicate groups (name-agnostic, >=12 tokens): ${groups.length}`);
for (const g of groups.slice(0, TOP)) {
  console.log(`  x${g.length} ${g[0].tokens.length} tokens`);
  for (const fn of g) console.log(`     ${tag(fn)}${label(fn)}`);
}

// Near duplicates.
const big = funcs.filter(fn => fn.tokens.length >= MIN_TOKENS);
const shingles = big.map(fn => {
  const s = new Set();
  for (let i = 0; i + 4 <= fn.tokens.length; i++) s.add(fn.tokens.slice(i, i + 4).join('\u0001'));
  return s;
});
const index = new Map();
shingles.forEach((s, i) => { for (const sh of s) { if (!index.has(sh)) index.set(sh, []); index.get(sh).push(i); } });
const co = new Map();
for (const [, ids] of index) {
  if (ids.length > SHARED_CAP || ids.length < 2) continue;
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const k = ids[a] * big.length + ids[b];
    co.set(k, (co.get(k) || 0) + 1);
  }
}
const pairs = [];
for (const [k, c] of co) {
  const a = Math.floor(k / big.length), b = k % big.length;
  if (exact.get(big[a].tokens.join(' ')) === exact.get(big[b].tokens.join(' '))) continue;
  const j = c / (shingles[a].size + shingles[b].size - c);
  if (j >= MIN_J) pairs.push({ a: big[a], b: big[b], j });
}
pairs.sort((x, y) => Math.min(y.a.nlines, y.b.nlines) - Math.min(x.a.nlines, x.b.nlines));
console.log(`\nNEAR duplicate pairs (jaccard>=${MIN_J}, >=${MIN_TOKENS} tokens): ${pairs.length}`);
for (const p of pairs.slice(0, TOP)) {
  console.log(`  J=${p.j.toFixed(2)} ${tag(p.a)}${label(p.a)}\n          ${tag(p.b)}${label(p.b)}`);
}
const newPairs = pairs.filter(p => added.has(p.a.name) || added.has(p.b.name));
if (NEW_FROM) console.log(`\npairs involving a function added since ${NEW_FROM}: ${newPairs.length}`);
