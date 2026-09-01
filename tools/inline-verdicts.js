#!/usr/bin/env node
// What did V8 do with each wasm inlining candidate?
//
//   node --trace-wasm-inlining test/run.js --app=heroes2_demo --quiet-api \
//        --max-batches=40000 > /tmp/inl.log 2>&1
//   node tools/inline-verdicts.js /tmp/inl.log                 # top denied callees
//   node tools/inline-verdicts.js /tmp/inl.log --func='$g2w'   # one callee's verdicts
//   node tools/inline-verdicts.js /tmp/inl.log --index=295,299 # same, by index
//
// V8 prices a callee's WHOLE graph against a growth budget, so a hot leaf whose
// fast path is buried behind a cold tier gets refused at every site that only
// needs the fast path. `--trace-wasm-inlining` says so per site but in tens of
// thousands of lines; this reduces them to "who is being refused, how often,
// and how many calls does that cost". The default view weights each site by the
// call count V8 itself reports, which is the ranking that matters: a callee
// denied at one cold site is noise, one denied at sites carrying three million
// calls is the lever.
//
// Resolve an index to a name with `node tools/func-index.js N` (and back with
// `--name='$g2w'`); indices are per-build, so a log and the build that produced
// it must match.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const log = args.find(a => !a.startsWith('--'));
if (!log) {
  console.error('usage: inline-verdicts.js <trace-wasm-inlining log> [--func=$name] [--index=N,N] [--top=N]');
  process.exit(2);
}
const getArg = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const top = Number(getArg('top') || 15);

let want = new Set();
const idxArg = getArg('index');
if (idxArg) want = new Set(idxArg.split(',').map(Number));
const funcArg = getArg('func');
if (funcArg) {
  // func-index.js is the one place that knows the import count and the order.
  const { execFileSync } = require('child_process');
  const tool = path.join(__dirname, 'func-index.js');
  for (const name of funcArg.split(',')) {
    const out = execFileSync('node', [tool, `--name=${name}`], { encoding: 'utf8' });
    const m = out.match(/is function #(\d+)/);
    if (!m) { console.error(`inline-verdicts: could not resolve ${name}`); process.exit(1); }
    want.add(Number(m[1]));
  }
}

const LINE = /considering candidate \{@\d+, index=(\d+), count=(\d+), size=(\d+),[^}]*\}[^:]*: (.*?)\]?$/;
const size = new Map();
const byIdx = new Map(); // idx -> {verdict -> {sites, calls}}
for (const line of fs.readFileSync(log, 'utf8').split('\n')) {
  const m = LINE.exec(line);
  if (!m) continue;
  const idx = Number(m[1]);
  if (want.size && !want.has(idx)) continue;
  size.set(idx, Number(m[3]));
  const verdict = m[4].startsWith('decided to inline') ? 'inlined' : m[4].trim();
  if (!byIdx.has(idx)) byIdx.set(idx, new Map());
  const t = byIdx.get(idx);
  const cur = t.get(verdict) || { sites: 0, calls: 0 };
  cur.sites += 1;
  cur.calls += Number(m[2]);
  t.set(verdict, cur);
}

if (!byIdx.size) {
  console.log('no inlining candidates in that log (was --trace-wasm-inlining passed to node?)');
  process.exit(0);
}

if (want.size) {
  for (const [idx, verdicts] of [...byIdx].sort((a, b) => a[0] - b[0])) {
    console.log(`#${idx}  size=${size.get(idx)}B`);
    for (const [v, c] of [...verdicts].sort((a, b) => b[1].calls - a[1].calls)) {
      console.log(`   ${String(c.sites).padStart(5)} sites  ${String(c.calls).padStart(10)} calls  ${v}`);
    }
  }
} else {
  const rows = [...byIdx].map(([idx, verdicts]) => {
    let denied = 0, inlined = 0;
    for (const [v, c] of verdicts) (v === 'inlined' ? (inlined += c.calls) : (denied += c.calls));
    return { idx, denied, inlined };
  }).sort((a, b) => b.denied - a.denied).slice(0, top);
  console.log('  idx    size   calls@denied  calls@inlined');
  for (const r of rows) {
    console.log(String(r.idx).padStart(5), String(size.get(r.idx)).padStart(6),
      String(r.denied).padStart(14), String(r.inlined).padStart(14));
  }
  console.log('\nname an index with: node tools/func-index.js <idx>');
}
