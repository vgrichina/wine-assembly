#!/usr/bin/env node
'use strict';

// Near-duplicate function census over src/*.wat.
//
//   node tools/wat-dup-census.js [--min-tokens=40] [--jaccard=0.85] [--top=60]
//                                [--new-from=REV] [--prefix-total=test_call_]
//                                [--check|--record]
//
// Every `(func $name ...)` body is comment-stripped and tokenized. Its own name
// is replaced by $SELF and its params/locals are alpha-renamed by declaration
// order, so spelling `$src` as `$path` cannot hide a clone. Exact matches are
// reported as groups; near matches are
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
const CHECK = process.argv.includes('--check');
const RECORD = process.argv.includes('--record');
const VERBOSE = process.argv.includes('--verbose') || (!CHECK && !RECORD);
const baselineArg = arg('baseline', null);
const BASELINE = baselineArg
  ? path.resolve(baselineArg)
  : path.join(__dirname, 'wat-dup-census.baseline.json');
// Shingles shared by more than this many functions are treated as boilerplate
// (handler prologues, `esp += N` epilogues) and dropped from the index.
const SHARED_CAP = Number(arg('shared-cap', 64));

function stripComments(text) {
  // Keep every newline so reported line numbers match the file on disk.
  return text.replace(/;;.*$/gm, '')
    .replace(/\(;[\s\S]*?;\)/g, m => m.replace(/[^\n]/g, ''));
}

function normalizedTokens(body, ownName) {
  const tokens = body.match(/\(|\)|[^\s()]+/g) || [];
  const bindings = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] !== '(' || (tokens[i + 1] !== 'param' && tokens[i + 1] !== 'local')) continue;
    let depth = 1;
    for (let j = i + 2; j < tokens.length && depth; j++) {
      if (tokens[j] === '(') depth++;
      else if (tokens[j] === ')') depth--;
      else if (depth === 1 && tokens[j].startsWith('$') && !bindings.includes(tokens[j])) {
        bindings.push(tokens[j]);
      }
    }
  }
  const alpha = new Map(bindings.map((name, i) => [name, `$L${i}`]));
  let exportNamePending = false;
  return tokens.map(token => {
    if (ownName.startsWith('$') && token === ownName) return '$SELF';
    if (!ownName.startsWith('$')) {
      if (exportNamePending) {
        exportNamePending = false;
        return '"$SELF"';
      }
      if (token === 'export') exportNamePending = true;
    }
    return alpha.get(token) || token;
  }).filter(token => token !== '(' && token !== ')');
}

for (const [label, a, aName, b, bName, expected] of [
  ['local alpha-renaming',
    '(func $copy (param $src i32) (local $dst i32) (local.set $dst (local.get $src)))', '$copy',
    '(func $clone (param $path i32) (local $out i32) (local.set $out (local.get $path)))', '$clone', true],
  ['callee identity',
    '(func $copy (call $left))', '$copy',
    '(func $clone (call $right))', '$clone', false],
]) {
  const same = normalizedTokens(a, aName).join(' ') === normalizedTokens(b, bName).join(' ');
  if (same !== expected) throw new Error(`duplicate normalizer self-check failed: ${label}`);
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
    const tokens = normalizedTokens(body, name);
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
const identity = fn => `${fn.file}:${fn.name}`;

if (PREFIX_TOTAL && VERBOSE) {
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
if (VERBOSE) {
  console.log(`EXACT duplicate groups (name/local-agnostic, >=12 tokens): ${groups.length}`);
  for (const g of groups.slice(0, TOP)) {
    console.log(`  x${g.length} ${g[0].tokens.length} tokens`);
    for (const fn of g) console.log(`     ${tag(fn)}${label(fn)}`);
  }
}

const duplicateMembers = [...new Set(groups.flatMap(g => g.map(identity)))].sort();
const snapshot = {
  comment: 'Known exact duplicate members. --check allows groups/members to disappear, rejects a new member, and caps the group count.',
  maxExactGroups: groups.length,
  allowedMembers: duplicateMembers,
};

if (RECORD) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wat-dup-census: recorded ${groups.length} exact groups / ${duplicateMembers.length} members in ${path.relative(ROOT, BASELINE)}`);
}

if (CHECK) {
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    console.error(`wat-dup-census: cannot read ${path.relative(ROOT, BASELINE)}: ${err.message}`);
    process.exitCode = 1;
  }
  if (baseline) {
    const allowed = new Set(baseline.allowedMembers || []);
    const additions = duplicateMembers.filter(member => !allowed.has(member));
    if (groups.length > baseline.maxExactGroups || additions.length) {
      if (groups.length > baseline.maxExactGroups) {
        console.error(`wat-dup-census: exact groups grew ${baseline.maxExactGroups} -> ${groups.length}`);
      }
      for (const member of additions.slice(0, 20)) {
        console.error(`wat-dup-census: NEW duplicate member ${member}`);
      }
      if (additions.length > 20) {
        console.error(`wat-dup-census: ...and ${additions.length - 20} more new duplicate members`);
      }
      console.error('wat-dup-census: duplicate WAT grew; share a body or explicitly review and record the new baseline.');
      process.exitCode = 1;
    } else {
      console.log(`wat-dup-census: ratchet ok — ${groups.length}/${baseline.maxExactGroups} exact groups, ${duplicateMembers.length}/${allowed.size} members`);
    }
  }
}

// The build ratchet needs exact groups only. Near-pair scoring is the
// interactive report's expensive half, so do not add it to every build.
if ((CHECK || RECORD) && !VERBOSE) process.exit(process.exitCode || 0);

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
if (VERBOSE) {
  console.log(`\nNEAR duplicate pairs (jaccard>=${MIN_J}, >=${MIN_TOKENS} tokens): ${pairs.length}`);
  for (const p of pairs.slice(0, TOP)) {
    console.log(`  J=${p.j.toFixed(2)} ${tag(p.a)}${label(p.a)}\n          ${tag(p.b)}${label(p.b)}`);
  }
}
const newPairs = pairs.filter(p => added.has(p.a.name) || added.has(p.b.name));
if (NEW_FROM && VERBOSE) console.log(`\npairs involving a function added since ${NEW_FROM}: ${newPairs.length}`);
