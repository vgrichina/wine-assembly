#!/usr/bin/env node
// Measure the toyvm trace JIT across the core ten and write a report that is
// tracked in the repo.
//
//   node tools/toyvm/report-core10.js [--passes=2] [--reps=7] [--iters=20000]
//                                     [--set=FILE] [--out=DIR] [--no-run]
//
// Writes docs/toyvm-core10/data.json and docs/toyvm-core10/index.html, then
// print where to open it. Serve the repo with `node tools/dev-server.js` and
// the page is at http://127.0.0.1:8080/docs/toyvm-core10/.
//
// The page is GENERATED rather than written by hand, and that is the point: a
// tracked report with hand-typed numbers stops matching the code the first time
// anyone changes a pass, and there is nothing in the file to say it has. Every
// figure below comes out of the same jitTiers() the CLI calls.
//
// `--passes=2` runs the whole set twice as two independent passes. It is not
// redundancy: this box routinely sits at load 6-40, and the second pass is the
// only thing that says which ratios survived it. The report prints both.
'use strict';

const fs = require('fs');
const path = require('path');
const { jitTiers } = require('./trace-jit');

const ROOT = path.resolve(__dirname, '../..');
const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`));
  return hit === undefined ? d : hit.slice(n.length + 3);
};
const flag = (n) => process.argv.includes(`--${n}`);

const geomean = (xs) => (xs.length
  ? Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length) : 0);

// What one trace is worth to the whole program if the JIT compiled that trace
// and nothing else. Amdahl over the trace's share of samples.
const programBound = (share, ratio) => 1 / ((1 - share) + share / ratio);

async function measure(set, { passes, reps, iters }) {
  const runs = [];
  for (let p = 0; p < passes; p++) {
    const pass = [];
    for (const exe of set) {
      const name = path.basename(exe).replace(/\.exe$/i, '');
      process.stderr.write(`pass ${p + 1}/${passes}  ${name}\n`);
      let res;
      try {
        res = await jitTiers(exe, {
          bench: true, minOps: 6, sampleFrom: 0.5, reps, iters, log: () => {},
        });
      } catch (e) {
        res = { ok: false, reason: 'error', detail: e.message };
      }
      pass.push({ name, exe, ...res });
    }
    runs.push(pass);
  }
  return runs;
}

// One row per program, pass A's numbers with pass B alongside so the spread is
// visible in the table rather than asserted in the prose.
function rows(runs) {
  const [a, ...rest] = runs;
  return a.map((r, i) => {
    if (!r.ok) {
      return { name: r.name, ok: false, reason: r.reason, why: r.why || null };
    }
    const share = r.trace.share / 100;
    const other = rest.map(p => p[i]).filter(x => x && x.ok).map(x => x.speedup.t03);
    return {
      name: r.name,
      ok: true,
      ops: r.trace.ops,
      share,
      t01: r.speedup.t01,
      t12: r.speedup.t12,
      t23: r.speedup.t23,
      t03: r.speedup.t03,
      others: other,
      bound: programBound(share, r.speedup.t03),
    };
  });
}

const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const x2 = (n) => n.toFixed(2);

// The share gauge: a dot whose fill diameter is the trace's share of the run.
// It exists because the share column is the whole caveat of this report and a
// number in a dense table is skimmed past.
function gauge(share) {
  const d = Math.max(2, Math.round(2 + share * 10));
  return `<span class="gauge"><i style="width:${d}px;height:${d}px"></i></span>`;
}

function tableHtml(rs) {
  const ok = rs.filter(r => r.ok).sort((p, q) => q.t03 - p.t03);
  const max = Math.max(...ok.map(r => r.t03), 1);
  const body = ok.map(r => {
    const dim = (v, lo) => (v < lo ? ' class="mut"' : '');
    const bar = Math.round(100 * r.t03 / max);
    const alt = r.others.length ? r.others.map(x2).join(' / ') : '&mdash;';
    return `      <tr>
        <td class="name">${esc(r.name)}</td>
        <td>${r.ops} ops</td>
        <td>${gauge(r.share)}${(r.share * 100).toFixed(1)}%</td>
        <td${dim(r.t01, 1.2)}>${x2(r.t01)}</td>
        <td${dim(r.t12, 1.05)}>${x2(r.t12)}</td>
        <td${dim(r.t23, 1.05)}>${x2(r.t23)}</td>
        <td class="barcell big"><span>${x2(r.t03)}&times;</span><span class="bar"><i style="width:${bar}%"></i></span></td>
        <td class="mut">${alt}</td>
        <td${r.bound < 1.02 ? ' class="mut"' : ''}>${x2(r.bound)}&times;</td>
      </tr>`;
  }).join('\n');
  const g = (k) => x2(geomean(ok.map(r => r[k])));
  const altGeo = ok[0] && ok[0].others.length
    ? ok.map(r => r.others[0]).filter(Boolean)
    : [];
  return `${body}
      <tr class="total">
        <td class="name">geomean</td><td></td><td></td>
        <td>${g('t01')}</td><td>${g('t12')}</td><td>${g('t23')}</td>
        <td class="hot">${g('t03')}&times;</td>
        <td>${altGeo.length ? `${x2(geomean(altGeo))}&times;` : '&mdash;'}</td>
        <td>${g('bound')}&times;</td>
      </tr>`;
}

function declinedHtml(rs) {
  const bad = rs.filter(r => !r.ok);
  if (!bad.length) return '<p>Every program in the set produced a measurement.</p>';
  return bad.map((r) => {
    const w = r.why
      ? ` &mdash; <span class="num">${r.why.samples}</span> sample(s), `
        + `<span class="num">${r.why.heads}</span> live block(s) at exit`
      : '';
    return `<p><strong>${esc(r.name)}</strong> declined as <code>${esc(r.reason)}</code>${w}.</p>`;
  }).join('\n');
}

function page(rs, meta) {
  const ok = rs.filter(r => r.ok);
  const trace = geomean(ok.map(r => r.t03));
  const bound = geomean(ok.map(r => r.bound));
  const best = ok.slice().sort((a, b) => b.t03 - a.t03)[0];
  const css = fs.readFileSync(path.join(__dirname, 'report-core10.css'), 'utf8');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nine Traces, Four Tiers &mdash; toyvm trace JIT</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bitter:wght@500;700&family=JetBrains+Mono:wght@400;500;700&family=Source+Sans+3:wght@400;600&display=swap">
<style>
${css}</style>
</head>
<body>
<div class="wrap">

<header>
  <p class="eyebrow">toyvm &middot; trace jit &middot; core ten</p>
  <h1>Nine Traces, Four Tiers</h1>
  <p class="lede">A trace JIT over threaded code, measured on ten DOS demos from
  1993&ndash;95. Compiling the hottest trace is worth
  <strong>${x2(trace)}&times; on that trace</strong> and
  <strong>${x2(bound)}&times; on the program</strong>. The gap between those two
  numbers is the entire result &mdash; it says the next work is coverage, not code
  quality.</p>
</header>

<div class="thesis">
  <div class="fig">
    <p class="k">Hottest trace</p>
    <p class="v hot">${x2(trace)}&times;</p>
    <p class="n">Geometric mean over ${ok.length} programs, tier&nbsp;3 against the
    shipped interpreter running the same ops.</p>
  </div>
  <div class="fig">
    <p class="k">Whole program</p>
    <p class="v cool">${x2(bound)}&times;</p>
    <p class="n">The same ${ok.length}, weighted by how much of each program that
    trace actually is. Amdahl, not pessimism.</p>
  </div>
  <div class="fig">
    <p class="k">Measurable at all</p>
    <p class="v">${ok.length}<em> / ${rs.length}</em></p>
    <p class="n">Every decline below is a named reason, never a silent zero.</p>
  </div>
</div>

<p class="thesis-note">${meta.passes} independent pass(es), ${meta.reps} interleaved
reps each, min of reps. Absolute nanoseconds are deliberately not shown: this box
runs loaded, which the ratios survive and the timings do not. Generated
${esc(meta.when)} by <code>tools/toyvm/report-core10.js</code>.</p>

<section>
  <h2>What each tier removes</h2>
  <p class="sub">and what it is worth</p>

  <p>The interpreter is Forth-style threaded code: an arena of
  <code>[handler][operands&hellip;]</code> words dispatched through a table. Each tier
  strips one layer of that machinery from a hot trace and compiles what is left into a
  standalone wasm function.</p>

  <div class="ladder">
    <div class="rung">
      <div class="t">0</div>
      <div><h3>Interpreter</h3>
      <p>The shipped VM running the same ops from the same register file and the same
      megabyte of guest memory. The baseline every ratio is against.</p></div>
      <div class="gain">&mdash;</div>
    </div>
    <div class="rung pays">
      <div class="t">1</div>
      <div><h3>Bodies stitched, operands folded</h3>
      <p>Handler bodies concatenated into one function; every operand becomes an
      <code>i32.const</code>. Removes a dispatch, an operand load and an
      <code>$ip</code> advance per op.</p></div>
      <div class="gain">${x2(geomean(ok.map(r => r.t01)))}&times;</div>
    </div>
    <div class="rung free">
      <div class="t">2</div>
      <div><h3>Register folding, dead flags</h3>
      <p>Register-file calls resolved to direct globals; flag computations nothing reads
      are dropped. The pass that looks most like a classical optimizer, and the one that
      buys least.</p></div>
      <div class="gain">${x2(geomean(ok.map(r => r.t12)))}&times;</div>
    </div>
    <div class="rung pays">
      <div class="t">3</div>
      <div><h3>Micro-ops</h3>
      <p>Address <code>br_table</code> folded to arithmetic, segment lookup folded to its
      shadow base, constant expressions evaluated, registers promoted into wasm
      locals.</p></div>
      <div class="gain">${x2(geomean(ok.map(r => r.t23)))}&times;</div>
    </div>
  </div>
</section>

<section>
  <h2>Program by program</h2>
  <p class="sub">--bench --min-ops=6 --sample-from=0.5 &middot; ${meta.reps} interleaved reps &middot; min of reps</p>

  <div class="scroll">
  <table>
    <thead>
      <tr>
        <th>Program</th><th>Trace</th><th>Share of run</th>
        <th>0&rarr;1</th><th>1&rarr;2</th><th>2&rarr;3</th>
        <th>Tier 3 total</th><th>Other pass</th><th>Program bound</th>
      </tr>
    </thead>
    <tbody>
${tableHtml(rs)}
    </tbody>
  </table>
  </div>

  <p>The <em>share</em> column is the whole caveat, drawn as a gauge so it cannot be
  skimmed past. A trace holding a couple of percent of its program's samples proves the
  compiler is correct on that shape and says nothing about that program.</p>

  <div class="callout">
    <h3>${esc(best.name)} is the report in one row</h3>
    <p>Its ${best.ops}-op body is the biggest trace win in the set at
    <strong>${x2(best.t03)}&times;</strong> &mdash; and it is worth
    <strong>${x2(best.bound)}&times;</strong> to the program, because
    ${((1 - best.share) * 100).toFixed(0)}% of its samples are somewhere else.</p>
    <p>The lesson is not that the compiler needs another pass. It is that one trace is not
    a program.</p>
  </div>
</section>

<section>
  <h2>Declined</h2>
  <p class="sub">a named reason, never a silent zero</p>
  ${declinedHtml(rs)}
  <p>A program whose compiled code is thrown away faster than samples can land in it has
  no stable hot trace to compile. That is not a gap in the tool &mdash; it is the shape a
  trace JIT is structurally worst at.</p>
</section>

<section>
  <h2>What this says to build next</h2>
  <p class="sub">coverage, not another pass</p>

  <p>${x2(trace)}&times; on the trace and ${x2(bound)}&times; on the program is a statement
  about <em>coverage</em>. The compiled code is already fast; it does not run often enough,
  and a fifth tier would move the first number and barely touch the second.</p>

  <p>What moves the second number is compiling more than one trace &mdash; and the
  interpreter's own shape makes that unusually cheap. A handler is a <code>(func)</code>
  with no parameters and no results that ends in <code>(return_call $next)</code>. A
  compiled trace has exactly that signature, so it can be installed into a free slot of the
  handler table and reached by ordinary dispatch, by patching one word at the trace
  head:</p>

<pre>arena:  [ <span class="del">th_cmp_ri8_jz</span> ][ operands&hellip; ]
                 &darr;
        [ <span class="ins">th_compiled_0417</span> ][ operands&hellip; ]</pre>

  <p>No new dispatch mechanism, no separate entry path, no change to how blocks are found.
  What it still needs is an entry guard, side exits, and invalidation when the guest writes
  over compiled bytes.</p>
</section>

<footer>
  <p>Generated by <code>node tools/toyvm/report-core10.js</code> from
  <code>${esc(meta.set)}</code>. Raw measurements in
  <code>data.json</code> beside this file.</p>
  <p>Correctness gate: every arm must land on identical registers, identical segment bases
  and an identical hash of the full first megabyte of guest memory before it is timed at
  all. An arm that computes something else is not faster.</p>
</footer>

</div>
</body>
</html>
`;
}

async function main() {
  const setFile = arg('set', path.join(__dirname, 'bench-set-core10.txt'));
  const outDir = path.resolve(ROOT, arg('out', 'docs/toyvm-core10'));
  const passes = Number(arg('passes', 2));
  const reps = Number(arg('reps', 7));
  const iters = Number(arg('iters', 20000));
  const set = fs.readFileSync(setFile, 'utf8').split('\n')
    .map(s => s.trim()).filter(s => s && !s.startsWith('#'));

  fs.mkdirSync(outDir, { recursive: true });
  const dataFile = path.join(outDir, 'data.json');

  let data;
  if (flag('no-run')) {
    // Re-render the page from the last measurement. The page is a template over
    // data.json, so a wording change does not need an hour of benchmarking --
    // and must not silently produce different numbers either.
    data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } else {
    const runs = await measure(set, { passes, reps, iters });
    data = {
      when: new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z',
      set: path.relative(ROOT, setFile),
      passes, reps, iters,
      rows: rows(runs),
    };
    fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
  }

  const html = page(data.rows, data);
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  const rel = path.relative(ROOT, outDir);
  console.log(`wrote ${rel}/index.html and ${rel}/data.json`);
  console.log(`serve it: node tools/dev-server.js`);
  console.log(`then open: http://127.0.0.1:8080/${rel}/`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { programBound, geomean, rows, page };
