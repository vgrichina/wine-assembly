#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// Milestone 3 of docs/watx-migration-plan.md — the four-artifact differential
// matrix.
//
// Builds the same source closure with BOTH compilers, in both the tail-call
// and the compatibility configuration:
//
//   build/legacy/wine-assembly.wasm         build/watx/wine-assembly.wasm
//   build/legacy/wine-assembly.compat.wasm  build/watx/wine-assembly.compat.wasm
//
// then runs two gates over them:
//
//   ABI    tools/wasm-abi-diff.js on legacy-tail vs watx-tail and on
//          legacy-compat vs watx-compat, plus the plan's no-tail-call
//          requirement on both compatibility artifacts.
//   TESTS  one curated fast list of real test files, run twice — once with
//          each TAIL artifact pinned through $WINE_ASSEMBLY_WASM. Same test,
//          same inputs, two compilers.
//
// The canonical build/wine-assembly*.wasm are NEVER written here. Legacy and
// WATX outputs live in separate directories for the whole migration, exactly
// as tools/watx-baseline.sh established for the legacy half.
//
// WHY THE TESTS ARE SPAWNED AND NOT IMPORTED. A test that pins an artifact is
// the only kind that can answer "does this compiler's module behave". Tests
// built on test/render-helper.js append WAT and recompile from source, so they
// are structurally unable to test a prebuilt module and are excluded by
// construction — FAST_TESTS holds only files that reach test/run.js with
// --no-build. run.js reads $WINE_ASSEMBLY_WASM as the default for --wasm (and
// implies --no-build), which is what lets one unmodified test file be pointed
// at two artifacts.
//
// THE WATX HALF IS EXPECTED TO BE RED while Milestone 2 is in flight. A WATX
// compile failure is a first-class reported outcome: the legacy half still
// runs and still reports, the failure prints its stage/file/line, and the exit
// code is nonzero. That is the intended state of this gate until the compiler
// and source gaps close.
//
// SELF-CHECK. --self replaces the WATX side with a SECOND legacy build. Every
// section must then come out green (ABI MATCH, identical test verdicts) — it
// proves the harness itself, and is how this tool was validated while the real
// WATX side could not compile.
//
// Usage:
//   node tools/watx-matrix.js                 # build all four, ABI + tests
//   node tools/watx-matrix.js --self          # legacy-vs-legacy proof run
//   node tools/watx-matrix.js --skip-build    # reuse artifacts on disk
//   node tools/watx-matrix.js --only=abi      # ABI gate only
//   node tools/watx-matrix.js --only=tests    # test matrix only
//   node tools/watx-matrix.js --json          # machine-readable report
//
// Options:
//   --tests=a.js,b.js   replace the curated list
//   --allow-baseline-fail=a.js,b.js
//                       tests that are KNOWN red on legacy and whose baseline
//                       failure must not turn the matrix red (a printed note
//                       records each one that was excused)
//   --timeout=N         per-test SIGKILL bound in seconds (default 120)
//   --max=N             ABI diff lines per section (default 10)
//   --a-dir=D --b-dir=D artifact directories (default build/legacy and
//                       build/watx, or build/legacy-self under --self)
//
// Exit: 0 all gates green; 1 a gate failed (WATX build, ABI acceptance diff,
// a tail call in a compatibility artifact, a test that passes on legacy and
// fails on WATX, or a test that fails on LEGACY); 2 usage or an internal error.
//
// BASELINE FAILURES ARE ALSO RED. Attributing a pre-existing legacy failure to
// the new compiler would be wrong, so the regression gate compares the two
// columns rather than reading the WATX column alone — but that on its own let a
// test which crashed SYMMETRICALLY (red on legacy AND red on WATX) print MATRIX
// GREEN and exit 0, because neither column was better than the other. A pinned
// test that cannot pass on the legacy artifact is measuring nothing at all, so
// the gate now requires the legacy column green as well and names the test:
//
//   MATRIX RED — baseline failure: test-foo.js fails on legacy
//
// --allow-baseline-fail=test-foo.js is the deliberate escape hatch for a test
// that is knowingly red at HEAD for an unrelated reason; each excused test is
// printed, so the exemption is visible in the report rather than silent.
//
// The flag CANNOT excuse an asymmetric row. "Knowingly red at HEAD for an
// unrelated reason" means red on BOTH artifacts; a test that fails on legacy and
// PASSES on WATX is a divergence between the compilers — the same finding as a
// regression, pointing the other way — so the excusal requires the second column
// to have failed too, and an asymmetric row stays red in either direction.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const { compileWat } = require(path.join(ROOT, 'lib', 'compile-wat.js'));
const { diffWasmAbi } = require(path.join(__dirname, 'wasm-abi-diff.js'));
const { watxSourceClosure, compileClosure } = require(path.join(__dirname, 'watx-closure.js'));

// ---------------------------------------------------------------------------
// The curated fast list.
//
// Every entry must (a) reach test/run.js with --no-build and no hard-coded
// --wasm=, so $WINE_ASSEMBLY_WASM decides which module it exercises, and (b)
// finish in seconds. checkTestIsPinnable() enforces (a) at run time rather
// than trusting this comment, because a test that quietly rebuilds would score
// the SAME module twice and print a green matrix that measured nothing.
// ---------------------------------------------------------------------------
const FAST_TESTS = [
  'test-cli-vfs-include.js',            // VFS mount + CLI plumbing
  'test-tapi-line-init.js',             // Win32 API state round trip
  'test-class-menu-from-dll.js',        // window class + menu resources from a DLL
  'test-winhelp-reference.js',          // help engine + GDI text
  'test-wordpad-thread-startup.js',     // guest thread startup
  'test-win16-pipe-about.js',           // Win16 window/dialog/control paint
  'test-win16-pipe-help.js',            // Win16 help window
  'test-win16-idlewild-handle-map.js',  // Win16 handle mapping
  'test-les-flat.js',                   // DirectDraw-backed full app frame
];

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const hasFlag = name => argv.includes(`--${name}`);

const JSON_OUT = hasFlag('json');
const SKIP_BUILD = hasFlag('skip-build');
const SELF = hasFlag('self');
const ONLY = getArg('only', 'all');
const TIMEOUT_S = Number(getArg('timeout', '120'));
const MAX_DIFF = Number(getArg('max', '10'));
const TEST_LIST = (() => {
  const raw = getArg('tests', '');
  return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : FAST_TESTS;
})();
const ALLOW_BASELINE_FAIL = new Set(
  getArg('allow-baseline-fail', '').split(',').map(s => s.trim()).filter(Boolean));

if (!['all', 'abi', 'tests'].includes(ONLY)) {
  console.error(`watx-matrix: --only must be abi, tests or all (got ${ONLY})`);
  process.exit(2);
}
for (const a of argv) {
  if (a.startsWith('--') && !/^--(json|skip-build|self|only|timeout|max|tests|a-dir|b-dir|allow-baseline-fail)(=|$)/.test(a)) {
    console.error(`watx-matrix: unknown argument ${a}`);
    process.exit(2);
  }
}

const DO_ABI = ONLY === 'all' || ONLY === 'abi';
const DO_TESTS = ONLY === 'all' || ONLY === 'tests';

// The "B" side is WATX normally and a second legacy build under --self.
const B_LABEL = SELF ? 'legacy2' : 'watx';
// --a-dir/--b-dir exist so test/test-watx-matrix.js can exercise this tool's
// plumbing against scratch artifacts without touching a real build directory.
const B_DIR = path.resolve(ROOT, getArg('b-dir', path.join('build', SELF ? 'legacy-self' : 'watx')));
const A_DIR = path.resolve(ROOT, getArg('a-dir', path.join('build', 'legacy')));

const artifactPath = (dir, compat) =>
  path.join(dir, compat ? 'wine-assembly.compat.wasm' : 'wine-assembly.wasm');

// stdout is the report; progress chatter goes to stderr so --json stays clean.
const note = msg => process.stderr.write(`[watx-matrix] ${msg}\n`);
const out = [];
const say = line => { out.push(line); if (!JSON_OUT) console.log(line); };

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// ---------------------------------------------------------------------------
// Section 1 — build the four artifacts
// ---------------------------------------------------------------------------

async function buildLegacy(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const read = file => fs.promises.readFile(path.join(SRC, file), 'utf8');
  const results = {};
  for (const compat of [false, true]) {
    const bytes = await compileWat(read, compat ? { tailCalls: false } : {});
    const file = artifactPath(dir, compat);
    fs.writeFileSync(file, bytes);
    results[compat ? 'compat' : 'tail'] = { ok: true, file, bytes: bytes.length, sha256: sha256(bytes) };
  }
  return results;
}

// The closure and the compile options both live in tools/watx-closure.js so the
// canonical build (tools/build-compile-wat.js under WINE_WAT_COMPILER=watx)
// compiles the identical thing this gate certifies. See that file for why.

function buildWatx(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const results = {};
  let closure;
  try {
    closure = watxSourceClosure();
  } catch (e) {
    const fail = { ok: false, error: String(e.message || e), stage: 'SOURCE' };
    return { tail: fail, compat: { ...fail }, entry: null };
  }
  results.entry = closure.entry;
  for (const compat of [false, true]) {
    const key = compat ? 'compat' : 'tail';
    let r;
    try {
      r = compileClosure(closure, { tailCalls: !compat });
    } catch (e) {
      results[key] = { ok: false, error: String(e.message || e), stage: 'THROW' };
      continue;
    }
    if (!r || !r.success || !r.wasmBinary) {
      const stage = (r && r.stages || []).filter(s => s.success).map(s => s.name).pop() || '?';
      results[key] = {
        ok: false,
        stage: (r && r.stage) || `after ${stage}`,
        error: String((r && (r.error || r.message)) || 'compile() returned no binary'),
        file: (r && r.file) || null,
        line: (r && r.line) || null,
        col: (r && r.col) || null,
      };
      continue;
    }
    const bytes = Buffer.from(r.wasmBinary);
    const file = artifactPath(dir, compat);
    fs.writeFileSync(file, bytes);
    results[key] = { ok: true, file, bytes: bytes.length, sha256: sha256(bytes) };
  }
  return results;
}

function adoptExisting(dir) {
  const results = {};
  for (const compat of [false, true]) {
    const file = artifactPath(dir, compat);
    const key = compat ? 'compat' : 'tail';
    if (!fs.existsSync(file)) {
      results[key] = { ok: false, stage: 'SKIP-BUILD', error: `missing artifact ${path.relative(ROOT, file)}` };
      continue;
    }
    const bytes = fs.readFileSync(file);
    results[key] = { ok: true, file, bytes: bytes.length, sha256: sha256(bytes) };
  }
  return results;
}

function reportArtifacts(a, b) {
  say('== artifacts ==');
  const rows = [
    ['legacy tail', a.tail], ['legacy compat', a.compat],
    [`${B_LABEL} tail`, b.tail], [`${B_LABEL} compat`, b.compat],
  ];
  for (const [label, r] of rows) {
    if (r.ok) {
      say(`  OK    ${label.padEnd(14)} ${String(r.bytes).padStart(9)} B  ${r.sha256.slice(0, 16)}  ${path.relative(ROOT, r.file)}`);
    } else {
      const where = r.file ? ` ${r.file}:${r.line || 0}:${r.col || 0}` : (r.line ? ` line ${r.line}` : '');
      say(`  FAIL  ${label.padEnd(14)} ${r.stage || 'BUILD'}${where}: ${r.error}`);
    }
  }
  if (b.entry) say(`  ${B_LABEL} source entry: ${b.entry}`);
  say('');
}

// ---------------------------------------------------------------------------
// Section 2 — the ABI gate
// ---------------------------------------------------------------------------

function abiPair(label, aSide, bSide, requireNoTailcalls) {
  const row = { pair: label, requireNoTailcalls, ok: false, skipped: false, diffs: [], tailCalls: null };
  if (!aSide.ok || !bSide.ok) {
    row.skipped = true;
    row.reason = !aSide.ok ? 'A artifact missing' : 'B artifact missing';
    return row;
  }
  let result;
  try {
    result = diffWasmAbi(aSide.file, bSide.file, { max: MAX_DIFF });
  } catch (e) {
    row.reason = String(e.message || e);
    return row;
  }
  row.tailCalls = result.tailCalls;
  row.bodyDiffs = result.bodyDiffs;
  row.nameMapVacuous = result.nameMapVacuous;
  row.sections = result.sections.map(s => ({
    name: s.name, acceptance: s.acceptance, diffs: s.diffs,
  }));
  row.match = result.match;
  row.ok = result.match;
  if (requireNoTailcalls && (result.tailCalls.a || result.tailCalls.b)) {
    row.ok = false;
    row.tailCallViolation = true;
  }
  return row;
}

function reportAbi(rows) {
  say('== abi ==');
  for (const row of rows) {
    if (row.skipped) { say(`  SKIP  ${row.pair}  (${row.reason})`); continue; }
    if (!row.sections) { say(`  ERROR ${row.pair}  ${row.reason}`); continue; }
    say(`  ${row.ok ? 'PASS ' : 'FAIL '} ${row.pair}  ${row.match ? 'ABI MATCH' : 'ABI DIFF'}` +
      (row.bodyDiffs ? `  (${row.bodyDiffs} body encodings differ; diagnostic)` : ''));
    for (const s of row.sections) {
      if (!s.diffs.length) continue;
      say(`          ${s.acceptance ? 'DIFF' : 'NOTE'} ${s.name}`);
      for (const d of s.diffs.slice(0, MAX_DIFF)) say(`            ${d}`);
    }
    if (row.requireNoTailcalls) {
      say(row.tailCallViolation
        ? `          FAIL no-tail-calls: A=${row.tailCalls.a} sites, B=${row.tailCalls.b} sites`
        : '          OK   no-tail-calls: neither compatibility artifact uses return_call');
    }
    if (row.nameMapVacuous) {
      say('          WARNING: neither module has a name section, so the ' +
        'name-to-index comparison is vacuous (see tools/wasm-abi-diff.js header)');
    }
  }
  say('');
}

// ---------------------------------------------------------------------------
// Section 3 — the test matrix
// ---------------------------------------------------------------------------

// A test that hard-codes --wasm= or never spawns run.js at all ignores the pinned
// artifact and silently scores the same module on both sides. Refusing it is
// the difference between a matrix and a pair of identical columns.
//
// THIS PREDICATE USED TO DEMAND A LITERAL `--no-build` IN THE TEST'S TEXT, and
// that requirement had been obsolete since 4aeb0970: run.js DERIVES --no-build
// from $WINE_ASSEMBLY_WASM (`NO_BUILD = hasFlag('no-build') || !!ENV_WASM`), and
// the environment reaches it however deep the spawn chain is. So the flag was
// never what made a test pinnable — the env var was — and grepping for it
// excluded every test that simply never bothered to type it. Measured over test/
// at the time of this change: 244 files spawn run.js, 10 of them hard-code
// --wasm= without forwarding the environment, and of the 234 that remain only 47
// contain the literal `--no-build`. The gate was drawing from 20% of the eligible
// pool for a reason that had stopped being true. (An earlier measurement of the
// same ratio read 40 of 217; the tree grows, the ratio does not move much.)
//
// What still makes the widened pool safe to trust is 1c3e5104: a pinned artifact
// that is missing or does not compile is now FATAL in run.js rather than a quiet
// fall-back to compiling from src/. Before that, admitting a test which does not
// say --no-build would have risked exactly the failure this predicate exists to
// prevent — a column that compiled its own module and agreed with the other one
// by construction.
//
// Residual limitation, and it is a text grep so it cannot do better: a test that
// spawns run.js with a REPLACED env (rather than {...process.env, ...}) drops the
// pin, and nothing here can see that. Such a test scores the canonical build in
// both columns. If one turns up, exclude it by name from the curated list.
function checkTestIsPinnable(file) {
  const full = path.join(ROOT, 'test', file);
  if (!fs.existsSync(full)) return `no such test file test/${file}`;
  const text = fs.readFileSync(full, 'utf8');
  if (!/run\.js/.test(text)) return 'does not spawn test/run.js, so no artifact can be pinned';
  if (/--wasm=/.test(text) && !/WINE_ASSEMBLY_WASM/.test(text)) {
    return 'hard-codes --wasm=, which overrides $WINE_ASSEMBLY_WASM';
  }
  return null;
}

function runOneTest(file, wasmPath) {
  const started = Date.now();
  try {
    execFileSync('timeout', ['-s', 'KILL', String(TIMEOUT_S), process.execPath,
      path.join(ROOT, 'test', file)], {
      cwd: ROOT,
      stdio: 'pipe',
      env: { ...process.env, WINE_ASSEMBLY_WASM: wasmPath },
    });
    return { pass: true, code: 0, ms: Date.now() - started };
  } catch (e) {
    const code = e.status === undefined || e.status === null ? -1 : e.status;
    const tail = String((e.stdout || '') + (e.stderr || ''))
      .trimEnd().split('\n').slice(-3).join(' | ').slice(0, 300);
    return { pass: false, code, ms: Date.now() - started, tail };
  }
}

function runTestMatrix(a, b) {
  const rows = [];
  for (const file of TEST_LIST) {
    const reason = checkTestIsPinnable(file);
    if (reason) { rows.push({ test: file, unusable: reason }); continue; }
    const row = { test: file };
    note(`test ${file} on legacy`);
    row.a = a.tail.ok ? runOneTest(file, a.tail.file) : { skipped: true };
    note(`test ${file} on ${B_LABEL}`);
    row.b = b.tail.ok ? runOneTest(file, b.tail.file) : { skipped: true };
    // The gate is the REGRESSION, not the absolute verdict: a test that is
    // already red on legacy is somebody else's bug and must not be attributed
    // to the new compiler.
    row.regression = !!(row.a.pass && row.b.skipped !== true && !row.b.pass);
    // ...and the OTHER half of that comparison: a test red on legacy is not
    // evidence about WATX either way, so it cannot be allowed to pass silently.
    // Without this a symmetric crash (red on BOTH columns) scored no regression
    // and printed MATRIX GREEN.
    row.baselineFail = !!(row.a && row.a.skipped !== true && !row.a.pass);
    // A row that fails on legacy and PASSES on watx is not a baseline failure at
    // all — it is a difference between the compilers, in the direction the
    // regression rule does not cover, and it is exactly as interesting as the
    // other direction. Excusing it would let --allow-baseline-fail hide a real
    // divergence: the flag exists for a test that is red at HEAD for an unrelated
    // reason, which means red on BOTH artifacts. So the excusal requires the
    // second column to have failed too.
    row.asymmetric = !!(row.baselineFail && row.b && row.b.skipped !== true && row.b.pass);
    row.baselineExcused = row.baselineFail && !row.asymmetric &&
      row.b && row.b.skipped !== true && !row.b.pass &&
      ALLOW_BASELINE_FAIL.has(file);
    rows.push(row);
  }
  return rows;
}

function verdictOf(r) {
  if (!r) return '-';
  if (r.skipped) return 'skip';
  return r.pass ? 'PASS' : `FAIL(${r.code})`;
}

function reportTests(rows) {
  say('== tests ==');
  say(`  ${'test'.padEnd(38)} ${'legacy'.padEnd(9)} ${B_LABEL.padEnd(9)}`);
  for (const row of rows) {
    if (row.unusable) { say(`  ${row.test.padEnd(38)} UNUSABLE  ${row.unusable}`); continue; }
    const flag = row.regression ? '  <== REGRESSION'
      : row.asymmetric ? `  <== DIVERGENCE (fails on legacy, passes on ${B_LABEL})`
      : row.baselineExcused ? '  <== BASELINE FAIL (excused by --allow-baseline-fail)'
      : row.baselineFail ? '  <== BASELINE FAIL (red on legacy)'
      : '';
    say(`  ${row.test.padEnd(38)} ${verdictOf(row.a).padEnd(9)} ${verdictOf(row.b).padEnd(9)}` +
      ` ${String(Math.round(row.a.ms || 0) / 1000)}s/${String(Math.round(row.b.ms || 0) / 1000)}s${flag}`);
    if (row.a && row.a.tail && !row.a.pass) say(`      legacy: ${row.a.tail}`);
    if (row.b && row.b.tail && !row.b.pass) say(`      ${B_LABEL}: ${row.b.tail}`);
  }
  const excused = rows.filter(r => r.baselineExcused).map(r => r.test);
  if (excused.length) {
    say(`  NOTE  ${excused.length} baseline failure(s) excused by --allow-baseline-fail: ${excused.join(', ')}`);
  }
  say('');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  const report = { self: SELF, only: ONLY, bLabel: B_LABEL, failures: [] };

  note(SKIP_BUILD ? 'reusing artifacts on disk' : 'building four artifacts');
  const a = SKIP_BUILD ? adoptExisting(A_DIR) : await buildLegacy(A_DIR);
  let b;
  if (SKIP_BUILD) b = adoptExisting(B_DIR);
  else if (SELF) b = await buildLegacy(B_DIR);
  else b = buildWatx(B_DIR);
  report.artifacts = { legacy: a, [B_LABEL]: b };
  reportArtifacts(a, b);

  for (const [label, r] of [['legacy tail', a.tail], ['legacy compat', a.compat],
    [`${B_LABEL} tail`, b.tail], [`${B_LABEL} compat`, b.compat]]) {
    if (!r.ok) report.failures.push(`artifact ${label}: ${r.stage || 'BUILD'} ${r.error}`);
  }

  if (DO_ABI) {
    const rows = [
      abiPair(`tail:   legacy vs ${B_LABEL}`, a.tail, b.tail, false),
      abiPair(`compat: legacy vs ${B_LABEL}`, a.compat, b.compat, true),
    ];
    report.abi = rows;
    reportAbi(rows);
    for (const row of rows) {
      if (row.skipped) { report.failures.push(`abi ${row.pair}: ${row.reason}`); continue; }
      if (!row.ok) {
        report.failures.push(`abi ${row.pair}: ` +
          (row.tailCallViolation ? 'tail-call opcodes in a compatibility artifact' : 'acceptance diff'));
      }
    }
  }

  if (DO_TESTS) {
    const rows = runTestMatrix(a, b);
    report.tests = rows;
    reportTests(rows);
    for (const row of rows) {
      if (row.unusable) report.failures.push(`test ${row.test}: unusable — ${row.unusable}`);
      else if (row.regression) report.failures.push(`test ${row.test}: passes on legacy, fails on ${B_LABEL}`);
      else if (row.asymmetric) {
        report.failures.push(`test ${row.test}: fails on legacy but PASSES on ${B_LABEL}` +
          ` — the two compilers disagree, in the direction the regression rule does not cover;` +
          ` --allow-baseline-fail cannot excuse this, it is for a test red on BOTH artifacts`);
      }
      else if (row.baselineFail && !row.baselineExcused) {
        report.baselineFailures = report.baselineFailures || [];
        report.baselineFailures.push(row.test);
        report.failures.push(`baseline failure: ${row.test} fails on legacy` +
          ` (code ${row.a.code}) — the matrix cannot compare compilers on a test that does not pass` +
          ` on the baseline artifact; re-run with --allow-baseline-fail=${row.test} to excuse it`);
      }
      else if (row.b && row.b.skipped) report.failures.push(`test ${row.test}: not run (${B_LABEL} artifact missing)`);
    }
  }

  say('== verdict ==');
  if (report.failures.length === 0) {
    say(`  MATRIX GREEN — legacy and ${B_LABEL} agree on every checked section`);
  } else if (report.baselineFailures && report.baselineFailures.length) {
    // Name the baseline case distinctly: "the baseline is broken" is a different
    // report from "the new compiler regressed something", and reads as one.
    say(`  MATRIX RED — baseline failure: ${report.baselineFailures.join(', ')} fails on legacy` +
      (report.failures.length > report.baselineFailures.length
        ? ` (+${report.failures.length - report.baselineFailures.length} other failure(s))` : ''));
    for (const f of report.failures) say(`    ${f}`);
  } else {
    say(`  MATRIX RED — ${report.failures.length} failure(s)`);
    for (const f of report.failures) say(`    ${f}`);
  }
  report.ok = report.failures.length === 0;

  report.text = out;
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})().catch(e => {
  console.error(String(e.stack || e.message || e));
  process.exit(2);
});
