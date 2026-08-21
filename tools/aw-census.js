#!/usr/bin/env node
// A/W handler census.
//
// Win32 ships most string-taking APIs twice, as FooA and FooW. There is only
// one correct relationship between the pair: the W entry point narrows (or
// widens) its strings and delegates to the A implementation, or vice versa.
// Anything else means two independent implementations of one API, which drift
// -- and they drift silently, because an app that calls only one spelling
// looks fine while the other spelling answers differently.
//
// This prints every $handle_* pair that exists in both spellings, how big each
// body is, and what the relationship between them actually is:
//
//   DELEGATES   one calls the other. This is the shape we want.
//   SHARED      both call a common $..._impl / helper. Also fine.
//   STUB        one is a fail-fast crash or a constant return while its twin
//               has a real body. This is a live bug: the stubbed spelling
//               answers wrong where the other spelling works.
//   DIVERGENT   two real bodies that never meet. Candidates for merging;
//               size ratio says how far apart they have drifted.
//
// Usage:
//   node tools/aw-census.js                 # summary table, worst first
//   node tools/aw-census.js --kind=STUB     # only one class
//   node tools/aw-census.js --name=Foo      # one pair, with both bodies' calls

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const argKind = (process.argv.find(a => a.startsWith('--kind=')) || '').split('=')[1];
const argName = (process.argv.find(a => a.startsWith('--name=')) || '').split('=')[1];

// Collect every (func $handle_NAME ...) body in the WAT sources. Paren depth is
// enough to find the end: WAT has no strings that contain unbalanced parens in
// these files, and comments are stripped per line before counting.
function collectHandlers() {
  const out = new Map();
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.wat')).sort()) {
    const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*\(func\s+\$handle_([A-Za-z0-9_]+)/);
      if (!m) continue;
      const name = m[1];
      let depth = 0, body = [];
      for (let j = i; j < lines.length; j++) {
        const code = lines[j].replace(/;;.*$/, '');
        body.push(lines[j]);
        for (const ch of code) {
          if (ch === '(') depth++;
          else if (ch === ')') depth--;
        }
        if (depth === 0) break;
      }
      out.set(name, { name, file, line: i + 1, body, lines: body.length });
    }
  }
  return out;
}

// What a body calls, minus the boilerplate every handler has.
const BOILERPLATE = /^(g2w|w2g|strlen|strlen_a|strlen_w|zero_memory|memcpy|heap_alloc|heap_free|crash_unimplemented)$/;
function callsOf(h) {
  const set = new Set();
  for (const line of h.body) {
    const code = line.replace(/;;.*$/, '');
    for (const m of code.matchAll(/\(call\s+\$([A-Za-z0-9_]+)/g)) set.add(m[1]);
  }
  return set;
}

function classify(a, w) {
  const ca = callsOf(a), cw = callsOf(w);
  if (cw.has('handle_' + a.name) || ca.has('handle_' + w.name)) return 'DELEGATES';

  const shared = [...ca].filter(x => cw.has(x) && !BOILERPLATE.test(x));
  // A shared core means both spellings funnel into one implementation. One
  // incidental helper in common does not; require the callee to be doing real
  // work for both, which in practice means it is the only substantial call.
  if (shared.length && (shared.length >= 2 || a.lines <= 12 || w.lines <= 12)) return 'SHARED';

  // A short body is not a stub when it delegates: the lstr* A handlers are
  // four lines each because $guest_strlen and friends do the work, and their
  // W twins are long only because UTF-16 has no such helper. A stub is a
  // fail-fast crash, or a body that returns something without asking anyone.
  const stub = h => callsOf(h).has('crash_unimplemented') ||
    (h.lines <= 8 && [...callsOf(h)].every(c => BOILERPLATE.test(c)));
  if (stub(a) !== stub(w)) return 'STUB';
  if (stub(a) && stub(w)) return 'BOTH_STUB';
  return 'DIVERGENT';
}

const handlers = collectHandlers();
const pairs = [];
for (const [name, h] of handlers) {
  if (!name.endsWith('A')) continue;
  const base = name.slice(0, -1);
  const w = handlers.get(base + 'W');
  if (!w) continue;
  pairs.push({ base, a: h, w, kind: classify(h, w) });
}

const RANK = { STUB: 0, DIVERGENT: 1, BOTH_STUB: 2, SHARED: 3, DELEGATES: 4 };
pairs.sort((x, y) => RANK[x.kind] - RANK[y.kind] ||
  Math.abs(y.a.lines - y.w.lines) - Math.abs(x.a.lines - x.w.lines));

if (argName) {
  const p = pairs.find(p => p.base === argName || p.base.toLowerCase() === argName.toLowerCase());
  if (!p) { console.error(`no A/W pair named ${argName}`); process.exit(1); }
  console.log(`${p.base}A/W  ${p.kind}`);
  for (const h of [p.a, p.w]) {
    console.log(`\n  $handle_${h.name}  ${h.file}:${h.line}  ${h.lines} lines`);
    const c = [...callsOf(h)].filter(x => !BOILERPLATE.test(x));
    console.log(`  calls: ${c.length ? c.join(', ') : '(nothing)'}`);
  }
  process.exit(0);
}

const shown = argKind ? pairs.filter(p => p.kind === argKind) : pairs;
console.log('KIND       A-lines  W-lines  NAME                          A at');
for (const p of shown) {
  console.log(
    p.kind.padEnd(10) +
    String(p.a.lines).padStart(7) +
    String(p.w.lines).padStart(9) + '  ' +
    (p.base + 'A/W').padEnd(30) +
    `${p.a.file}:${p.a.line}`);
}

const counts = {};
for (const p of pairs) counts[p.kind] = (counts[p.kind] || 0) + 1;
console.log('\n' + pairs.length + ' A/W pairs: ' +
  Object.entries(counts).sort((a, b) => RANK[a[0]] - RANK[b[0]])
    .map(([k, n]) => `${k} ${n}`).join(', '));
