#!/usr/bin/env node
'use strict';
// Plumbing test for tools/watx-matrix.js — the Milestone 3 differential matrix.
//
// It deliberately does NOT build anything. A full four-artifact run takes
// minutes and is the tool's own job; what needs a fast regression test is the
// wiring around it, because every one of these behaviours is a way the matrix
// could print green while measuring nothing:
//
//   - an ABI acceptance diff between the two sides must be FATAL;
//   - a missing artifact must SKIP the pair and still fail the run, never pass
//     it by comparing nothing;
//   - a test that hard-codes --wasm= or omits --no-build must be rejected as
//     UNUSABLE, because it would score the SAME module in both columns;
//   - --only= must actually skip the other half; and
//   - --json must carry the same verdict as the text report.
//
//   node test/test-watx-matrix.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'watx-matrix.js');

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}

// --- the smallest real modules that differ only in an ABI acceptance section.
// Hand-encoded rather than compiled: this test must stay fast and must not
// depend on either compiler being healthy.
function tinyModule(exportName) {
  const name = Buffer.from(exportName, 'utf8');
  const sec = (id, body) => Buffer.concat([Buffer.from([id, body.length]), body]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    sec(1, Buffer.from([0x01, 0x60, 0x00, 0x00])),           // type: () -> ()
    sec(3, Buffer.from([0x01, 0x00])),                        // func: one, type 0
    sec(7, Buffer.concat([Buffer.from([0x01, name.length]), name, Buffer.from([0x00, 0x00])])),
    sec(10, Buffer.from([0x01, 0x02, 0x00, 0x0b])),           // code: empty body
  ]);
}
ck('hand-encoded fixture is a valid wasm module', WebAssembly.validate(tinyModule('a')));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watx-matrix-test-'));
const mkSide = (dir, exportName) => {
  const full = path.join(tmp, dir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'wine-assembly.wasm'), tinyModule(exportName));
  fs.writeFileSync(path.join(full, 'wine-assembly.compat.wasm'), tinyModule(exportName));
  return full;
};
const same = mkSide('same', 'a');
const other = mkSide('other', 'b');
const empty = path.join(tmp, 'empty');
fs.mkdirSync(empty, { recursive: true });

function runTool(args) {
  try {
    const stdout = execFileSync('timeout', ['-s', 'KILL', '90', process.execPath, TOOL, ...args],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status === undefined || e.status === null ? -1 : e.status,
      stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
const jsonOf = r => {
  const at = r.stdout.indexOf('{');
  return at < 0 ? null : JSON.parse(r.stdout.slice(at));
};

// --- 1. identical artifacts: ABI MATCH, exit 0.
{
  const r = runTool(['--skip-build', '--only=abi', '--json', `--a-dir=${same}`, `--b-dir=${same}`]);
  const j = jsonOf(r);
  ck('identical artifacts exit 0', r.code === 0, r.code);
  ck('identical artifacts report ok', j && j.ok === true);
  ck('identical artifacts match both pairs', j && j.abi.length === 2 && j.abi.every(p => p.match));
  ck('compat pair carries the no-tail-call requirement',
    j && j.abi[1].requireNoTailcalls === true && !j.abi[1].tailCallViolation);
  ck('--only=abi runs no tests', j && j.tests === undefined);
}

// --- 2. a differing export is an acceptance diff, not a note.
{
  const r = runTool(['--skip-build', '--only=abi', '--json', `--a-dir=${same}`, `--b-dir=${other}`]);
  const j = jsonOf(r);
  ck('ABI acceptance diff exits nonzero', r.code === 1, r.code);
  ck('ABI acceptance diff is reported as not-ok', j && j.ok === false);
  const exports_ = j && j.abi[0].sections.find(s => s.name === 'exports');
  ck('the exports section is the one that diffs', !!exports_ && exports_.diffs.length > 0);
  ck('failures name the diffing pair', j && j.failures.some(f => /^abi tail/.test(f)));
}

// --- 3. a missing B artifact must SKIP the comparison AND fail the run.
//        (Comparing nothing and calling it a match is the failure mode.)
{
  const r = runTool(['--skip-build', '--only=abi', '--json', `--a-dir=${same}`, `--b-dir=${empty}`]);
  const j = jsonOf(r);
  ck('missing artifact exits nonzero', r.code === 1, r.code);
  ck('missing artifact skips the pair rather than matching it',
    j && j.abi.every(p => p.skipped === true && p.ok === false));
  ck('missing artifact is named in failures',
    j && j.failures.some(f => /wine-assembly\.wasm/.test(f)));
}

// --- 4. a test that cannot be pinned to an artifact is UNUSABLE, not a pass.
{
  const r = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${same}`, `--b-dir=${same}`,
    '--tests=test-wm-setcursor-on-show.js,test-watx-matrix-no-such-file.js']);
  const j = jsonOf(r);
  ck('unusable tests exit nonzero', r.code === 1, r.code);
  ck('a hard-coded --wasm= test is refused',
    j && /hard-codes --wasm=/.test(j.tests[0].unusable || ''), j && j.tests[0].unusable);
  ck('a missing test file is refused',
    j && /no such test file/.test(j.tests[1].unusable || ''));
  ck('neither unusable test was executed', j && j.tests.every(t => !t.a && !t.b));
  ck('--only=tests runs no ABI pairs', j && j.abi === undefined);
}

// --- 4b. THE PINNABLE PREDICATE MUST NOT DEMAND A LITERAL `--no-build`.
//         run.js has derived --no-build from $WINE_ASSEMBLY_WASM since 4aeb0970,
//         so the environment is what pins a test, not the flag; grepping for the
//         flag excluded ~80% of the tests that spawn run.js for a reason that had
//         stopped being true. test-about-cancel.js is a real tracked test that
//         spawns run.js and never types --no-build: exactly the shape that used
//         to be refused, and the check is written against a live file rather than
//         a fixture so it stays honest about what the tree contains.
//
//         The two genuine exclusions must survive, and are asserted alongside it.
{
  const r = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${empty}`, `--b-dir=${empty}`,
    '--tests=test-about-cancel.js,test-wm-setcursor-on-show.js,test-watx-matrix-no-such-file.js']);
  const j = jsonOf(r);
  const [envPinned, hardCoded, missingFile] = (j && j.tests) || [];

  ck('the sample env-pinned test really has no literal --no-build',
    !/--no-build/.test(fs.readFileSync(path.join(ROOT, 'test', 'test-about-cancel.js'), 'utf8')));
  ck('a test that spawns run.js without --no-build IS pinnable',
    !!envPinned && !envPinned.unusable, envPinned && envPinned.unusable);
  ck('...and a hard-coded --wasm= is still refused',
    !!hardCoded && /hard-codes --wasm=/.test(hardCoded.unusable || ''), hardCoded && hardCoded.unusable);
  ck('...and a missing file is still refused',
    !!missingFile && /no such test file/.test(missingFile.unusable || ''));
  ck('none of the three ran (both artifact dirs are empty)',
    j && j.tests.every(t => !t.a || t.a.skipped === true));
}

// --- 5. one real curated test, run against both (identical) sides. This is the
//        end-to-end proof that $WINE_ASSEMBLY_WASM reaches test/run.js: the
//        stub module above cannot boot a guest, so both columns must FAIL. If
//        the pin did not work, run.js would fall back to the canonical build
//        and both columns would pass, which is exactly the silent-green bug.
//
//        It is also the fabricated SYMMETRIC failure: red on legacy AND red on
//        WATX. The regression rule alone scores that as "no regression" — which
//        is correct as far as it goes, and used to be the whole gate, so this
//        run printed MATRIX GREEN and exited 0 while a pinned test was crashing
//        on both artifacts. The baseline rule is what makes it red.
{
  const r = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${same}`, `--b-dir=${same}`, '--timeout=60',
    '--tests=test-cli-vfs-include.js']);
  const j = jsonOf(r);
  const row = j && j.tests[0];
  ck('a curated test is accepted as pinnable', !!row && !row.unusable, row && row.unusable);
  ck('the pinned stub artifact reaches run.js (both sides fail on it)',
    !!row && row.a.pass === false && row.b.pass === false);
  ck('identical artifacts produce no regression', !!row && row.regression === false);
  ck('a symmetric failure IS flagged as a baseline failure',
    !!row && row.baselineFail === true && row.baselineExcused === false);
  ck('a symmetric failure turns the verdict red', j && j.ok === false && r.code === 1, r.code);
  ck('the baseline failure names the test', j && j.baselineFailures &&
    j.baselineFailures.join(',') === 'test-cli-vfs-include.js', j && JSON.stringify(j.baselineFailures));
  ck('the failure line says it fails on legacy',
    j && j.failures.some(f => /^baseline failure: test-cli-vfs-include\.js fails on legacy/.test(f)),
    j && JSON.stringify(j.failures));
  ck('the verdict line is the distinct baseline wording, not a bare count',
    j && j.text.some(l => /MATRIX RED — baseline failure: test-cli-vfs-include\.js fails on legacy/.test(l)),
    j && j.text.filter(l => /MATRIX/.test(l)).join(' | '));
}

// --- 5b. the same run with the test allow-listed: green again, exit 0, and the
//         exemption is PRINTED rather than silently applied.
{
  const r = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${same}`, `--b-dir=${same}`, '--timeout=60',
    '--tests=test-cli-vfs-include.js',
    '--allow-baseline-fail=test-cli-vfs-include.js']);
  const j = jsonOf(r);
  const row = j && j.tests[0];
  ck('--allow-baseline-fail restores exit 0', r.code === 0 && j && j.ok === true, r.code);
  ck('the row is still marked as a baseline failure, just excused',
    !!row && row.baselineFail === true && row.baselineExcused === true);
  ck('no baseline failure is recorded when excused', j && j.baselineFailures === undefined);
  ck('the excusal is printed in the report',
    j && j.text.some(l => /baseline failure\(s\) excused by --allow-baseline-fail: test-cli-vfs-include\.js/.test(l)),
    j && j.text.filter(l => /excused/.test(l)).join(' | '));
  ck('an allow-listed test that is not run is not silently a pass',
    j && j.text.some(l => /BASELINE FAIL \(excused/.test(l)));
}

// --- 5b2. ASYMMETRY IS NOT A BASELINE FAILURE, and the allow-list cannot excuse
//          it. `--allow-baseline-fail` exists for a test knowingly red at HEAD
//          for an unrelated reason -- which means red on BOTH artifacts. A row
//          that fails on legacy and PASSES on the other column is a divergence
//          between the compilers, the same finding as a regression pointing the
//          other way, and excusing it would hide exactly what this gate is for.
//
//          test/watx-matrix-fixture-side-sensitive.js is the only test here whose
//          verdict depends on WHICH artifact was pinned (it fails under a
//          directory named fail-side), so it is what makes an asymmetric row
//          reachable at all -- every real curated test passes on both stub
//          artifacts or fails on both.
{
  const failSide = mkSide('fail-side', 'a');
  const passSide = mkSide('pass-side', 'a');
  const FIX = 'watx-matrix-fixture-side-sensitive.js';

  // legacy FAIL / B PASS, no flag.
  const bare = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${failSide}`, `--b-dir=${passSide}`, '--timeout=60', `--tests=${FIX}`]);
  const jb = jsonOf(bare);
  const rb = jb && jb.tests[0];
  ck('the side-sensitive fixture really is side-sensitive',
    !!rb && rb.a.pass === false && rb.b.pass === true,
    rb && `${rb.unusable || ''} a=${rb.a && rb.a.pass} b=${rb.b && rb.b.pass}`);
  ck('legacy-FAIL / B-PASS is flagged asymmetric, not a baseline failure',
    !!rb && rb.asymmetric === true && rb.baselineExcused === false);
  ck('legacy-FAIL / B-PASS is red', bare.code === 1 && jb && jb.ok === false, bare.code);

  // ...and the same row WITH the flag must stay red.
  const excused = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${failSide}`, `--b-dir=${passSide}`, '--timeout=60', `--tests=${FIX}`,
    `--allow-baseline-fail=${FIX}`]);
  const je = jsonOf(excused);
  const re = je && je.tests[0];
  ck('--allow-baseline-fail CANNOT excuse an asymmetric row',
    excused.code === 1 && je && je.ok === false, excused.code);
  ck('...and the row is still not marked excused', !!re && re.baselineExcused === false);
  ck('...with a failure line naming the disagreement',
    je && je.failures.some(f => /fails on legacy but PASSES on/.test(f)),
    je && JSON.stringify(je.failures));
  ck('...and no baseline-failure verdict is claimed for it',
    je && je.baselineFailures === undefined, je && JSON.stringify(je.baselineFailures));

  // The opposite direction is the ordinary regression, red with or without the flag.
  const reg = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${passSide}`, `--b-dir=${failSide}`, '--timeout=60', `--tests=${FIX}`,
    `--allow-baseline-fail=${FIX}`]);
  const jr = jsonOf(reg);
  ck('legacy-PASS / B-FAIL stays a REGRESSION even when allow-listed',
    reg.code === 1 && jr && jr.ok === false && jr.tests[0].regression === true, reg.code);

  // And a genuinely symmetric failure on the same fixture is still excusable,
  // so the tightening did not simply disable the flag.
  const sym = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${failSide}`, `--b-dir=${failSide}`, '--timeout=60', `--tests=${FIX}`,
    `--allow-baseline-fail=${FIX}`]);
  const js = jsonOf(sym);
  ck('a genuinely symmetric failure is still excusable',
    sym.code === 0 && js && js.ok === true && js.tests[0].baselineExcused === true, sym.code);
}

// --- 5c. the allow-list is per test name, not a global off switch.
{
  const r = runTool(['--skip-build', '--only=tests', '--json',
    `--a-dir=${same}`, `--b-dir=${same}`, '--timeout=60',
    '--tests=test-cli-vfs-include.js',
    '--allow-baseline-fail=test-some-other-test.js']);
  const j = jsonOf(r);
  ck('allow-listing a DIFFERENT test leaves the run red', r.code === 1 && j && j.ok === false, r.code);
}

// --- 6. argument hygiene.
{
  const r = runTool(['--only=bogus']);
  ck('an invalid --only exits 2', r.code === 2, r.code);
  const u = runTool(['--not-a-flag']);
  ck('an unknown flag exits 2', u.code === 2, u.code);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
