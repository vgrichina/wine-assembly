#!/usr/bin/env node
'use strict';

// Focused test for tools/wasm-abi-diff.js — the Milestone 3 differential
// compiler gate from docs/watx-migration-plan.md.
//
// The tool's whole job is to say "these two modules have the same ABI" when
// two different compilers encoded it differently, and "no they do not" when
// one of the plan's invariants moved. Both halves are easy to get wrong in the
// same direction: a comparator that compares raw type INDICES false-fails a
// compiler that deduplicates differently, and a comparator that byte-greps for
// 0x12/0x13 reports tail calls in every module because those bytes occur
// constantly inside LEB immediates.
//
// So this builds tiny synthetic modules by hand and checks:
//
//   * a module against itself is a full MATCH, exit 0;
//   * a module whose type section is REORDERED (every index rewritten) still
//     matches — the positive control for structural signature resolution;
//   * one targeted negative control per ACCEPTANCE section class, each of
//     which must be reported against the right section name and exit 1;
//   * per-body encoding differences are a DIAGNOSTIC: reported, but not
//     fatal, because docs/watx-migration-plan.md says byte equality is not
//     the criterion and a different compiler may legitimately choose a
//     different local grouping or LEB width. --strict-code makes them fatal
//     again for same-compiler determinism checks, and both halves are tested;
//   * the tail-call scan finds a real `return_call` and does NOT fire on a
//     module whose only 0x12/0x13 bytes sit inside immediates and data;
//   * an invalid module is rejected before any comparison, so the structural
//     decoder cannot report MATCH on something no engine would accept;
//   * the vacuous-name-map warning fires exactly when neither module carries
//     a name section.
//
// Runs in milliseconds; no build artifacts required.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { decodeWasm, diffWasmAbi } = require('../tools/wasm-abi-diff');

const TOOL = path.join(__dirname, '..', 'tools', 'wasm-abi-diff.js');

// ---------------------------------------------------------------------------
// A minimal wasm encoder. Only what these fixtures need.
// ---------------------------------------------------------------------------

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    const signBit = b & 0x40;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
}

function str(s) {
  const b = Buffer.from(s, 'utf8');
  return [...uleb(b.length), ...b];
}

function vec(items) {
  return [...uleb(items.length), ...[].concat(...items)];
}

function section(id, body) {
  return [id, ...uleb(body.length), ...body];
}

const I32 = 0x7f;
const FUNCREF = 0x70;

// The base fixture, parameterised so each negative control changes exactly one
// thing. `types` is the declared order; `typeOf` maps a logical signature name
// to its index in that order, so a reordered type section rewrites indices
// without changing any resolved signature.
function buildModule(overrides) {
  const o = Object.assign({
    typeOrder: ['ii_i', 'v_v'],       // logical names, in declaration order
    funcDecls: ['ii_i', 'v_v', 'v_v'],
    memShared: true,
    exportName: 'run',
    globalInit: 42,
    elemEntries: [1, 2, 3],
    dataOffset: 0x100,
    dataBytes: 'hello',
    funcNames: ['imported_log', 'add', 'noop', 'caller'],
    noNameSection: false,
    dropLastBody: false,
    bodyOrder: [0, 1, 2],   // indices into [add, noop, caller]
    tailCall: false,
  }, overrides || {});

  // (i32 i32) -> (i32) and () -> ().
  const SIG_BYTES = {
    ii_i: [0x60, ...uleb(2), I32, I32, ...uleb(1), I32],
    v_v: [0x60, ...uleb(0), ...uleb(0)],
  };

  const typeIndex = name => {
    const i = o.typeOrder.indexOf(name);
    assert.ok(i >= 0, `type ${name} not declared`);
    return i;
  };

  const typeSec = section(1, vec(o.typeOrder.map(n => SIG_BYTES[n])));

  // imports: a shared memory (the plan's single hard memory invariant), one
  // function and one global.
  const importSec = section(2, vec([
    [...str('host'), ...str('memory'), 0x02, o.memShared ? 0x03 : 0x01,
      ...uleb(8192), ...uleb(8192)],
    [...str('host'), ...str('log'), 0x00, ...uleb(typeIndex('v_v'))],
    [...str('host'), ...str('tick'), 0x03, I32, 0x01],
  ]));

  const funcSec = section(3, vec(o.funcDecls.map(n => uleb(typeIndex(n)))));
  const tableSec = section(4, vec([[FUNCREF, 0x01, ...uleb(4), ...uleb(4)]]));
  const globalSec = section(6, vec([
    [I32, 0x01, 0x41, ...sleb(o.globalInit), 0x0b],
    [I32, 0x00, 0x41, ...sleb(7), 0x0b],
  ]));

  // Function index space: #0 is the imported log, #1..#3 the defined ones.
  const exportSec = section(7, vec([
    [...str(o.exportName), 0x00, ...uleb(1)],
    [...str('tbl'), 0x01, ...uleb(0)],
    [...str('gsum'), 0x03, ...uleb(2)],
    [...str('mem'), 0x02, ...uleb(0)],
  ]));

  const elemSec = section(9, vec([
    [...uleb(0), 0x41, ...sleb(0), 0x0b, ...vec(o.elemEntries.map(uleb))],
  ]));

  // body = size(locals-vec + instrs + end). The locals vector is one byte
  // (zero groups) and the terminating 0x0b is one more.
  const body = instrs => [...uleb(instrs.length + 2), ...uleb(0), ...instrs, 0x0b];
  // Bodies chosen so the byte 0x12 appears as an IMMEDIATE (i32.const 0x12 and
  // a br_table label), which is exactly the false positive a byte-grep hits.
  const bodyAdd = body([0x20, 0x00, 0x20, 0x01, 0x6a]);
  const bodyNoop = body([0x41, 0x12, 0x1a, 0x41, 0x13, 0x1a]);
  // Calls the imported `host.log` (#0, () -> ()), so this body typechecks in
  // any function whose signature is v_v — which lets the declaration-order
  // fixture reorder bodies to match and still be a VALID module. An invalid
  // fixture proves nothing, and the CLI now rejects one outright.
  const bodyCaller = o.tailCall
    ? body([0x12, ...uleb(0)])                 // return_call #0
    : body([0x10, ...uleb(0)]);                // call #0
  const allBodies = [bodyAdd, bodyNoop, bodyCaller];
  const bodies = o.dropLastBody
    ? [bodyAdd, bodyNoop]
    : o.bodyOrder.map(i => allBodies[i]);
  const codeSec = section(10, vec(bodies));

  const dataSec = section(11, vec([
    [...uleb(0), 0x41, ...sleb(o.dataOffset), 0x0b, ...str(o.dataBytes)],
  ]));

  // A name section, so the function name-to-index map is a real comparison
  // rather than a vacuous one. Current wine artifacts carry none; a WATX
  // artifact that starts emitting them must not permute them.
  const nameSubsection = [1, ...uleb(vec(o.funcNames.map((n, i) =>
    [...uleb(i), ...str(n)])).length), ...vec(o.funcNames.map((n, i) =>
    [...uleb(i), ...str(n)]))];
  const nameSec = section(0, [...str('name'), ...nameSubsection]);

  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...typeSec, ...importSec, ...funcSec, ...tableSec, ...globalSec,
    ...exportSec, ...elemSec, ...codeSec, ...dataSec,
    ...(o.noNameSection ? [] : nameSec),
  ]);
}

// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasm-abi-diff-'));
let checks = 0;

function write(name, bytes) {
  const file = path.join(tmpDir, `${name}.wasm`);
  fs.writeFileSync(file, bytes);
  return file;
}

// Run the CLI and return { code, out } so exit codes are tested for real, not
// inferred from the library result.
// stderr is piped rather than inherited: several checks here deliberately feed
// the tool a broken module, and letting those rejections print would make a
// passing run look like a failing one.
function runCli(args) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const out = execFileSync('node', [TOOL, ...args], opts);
    return { code: 0, out };
  } catch (error) {
    return { code: error.status, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// Only ACCEPTANCE sections decide a verdict; a diagnostic that differs is
// information, not a failure.
const differingAcceptance = result =>
  result.acceptanceSections.filter(s => s.diffs.length).map(s => s.name);

function expectMatch(label, a, b) {
  const result = diffWasmAbi(a, b);
  const bad = result.acceptanceSections.filter(s => s.diffs.length);
  assert.ok(result.match, `${label}: expected MATCH, got DIFF in ` +
    `${bad.map(s => `${s.name}: ${s.diffs[0]}`).join('; ')}`);
  const cli = runCli([a, b, '--quiet']);
  assert.strictEqual(cli.code, 0, `${label}: expected CLI exit 0, got ${cli.code}`);
  checks++;
  console.log(`  ok  ${label} — MATCH, exit 0`);
}

// A negative control passes only when the diff lands in the SECTION we broke
// and nowhere else: a comparator that reports "everything differs" is no more
// useful than one that reports nothing.
function expectDiffIn(label, a, b, expected) {
  const want = Array.isArray(expected) ? expected : [expected];
  const primary = want[0];
  const result = diffWasmAbi(a, b);
  const differing = differingAcceptance(result);
  assert.ok(!result.match, `${label}: expected a DIFF, got a full MATCH`);
  assert.deepStrictEqual(differing.slice().sort(), want.slice().sort(),
    `${label}: expected exactly [${want.join(', ')}] to differ, ` +
    `got [${differing.join(', ')}]`);
  const cli = runCli([a, b]);
  assert.strictEqual(cli.code, 1, `${label}: expected CLI exit 1, got ${cli.code}`);
  assert.ok(new RegExp(`^DIFF\\s+${primary}`, 'm').test(cli.out),
    `${label}: CLI output did not name section "${primary}"\n${cli.out}`);
  checks++;
  const first = result.acceptanceSections.find(s => s.name === primary).diffs[0];
  console.log(`  ok  ${label} — DIFF ${primary}: ${first}`);
}

const base = write('base', buildModule());

// A fixture that does not validate is not evidence about anything. Tail calls
// are not universally enabled, so only the tail-call-free base is checked.
assert.ok(WebAssembly.validate(fs.readFileSync(base)),
  'base fixture must be a valid wasm module');

console.log('positive controls');

// 1. Identity.
expectMatch('identical modules', base, base);

// 2. Type-section reordering with every index rewritten. This is THE case that
// makes raw index comparison wrong: the two modules have byte-different type
// and function sections and an identical ABI.
const reordered = write('type-reordered', buildModule({ typeOrder: ['v_v', 'ii_i'] }));
assert.notStrictEqual(fs.readFileSync(base).toString('hex'),
  fs.readFileSync(reordered).toString('hex'),
  'type-reorder fixture must actually differ in bytes, or it proves nothing');
expectMatch('type section reordered, indices rewritten', base, reordered);

// 3. A duplicated type entry — the other half of dedup tolerance: one compiler
// emits the same signature twice, the other once.
const duped = write('type-duped', buildModule({ typeOrder: ['ii_i', 'v_v', 'v_v'] }));
expectMatch('type section carries a duplicate signature', base, duped);

console.log('negative controls');

expectDiffIn('export renamed', base,
  write('neg-export', buildModule({ exportName: 'run2' })), 'exports');

// The fixture also EXPORTS that memory, and an export carries the resolved
// type of the thing it names, so the flag change is correctly reported twice —
// once at the import and once at the export. That redundancy is the point: the
// plan's "8192 8192 shared" invariant is checked wherever the memory appears.
expectDiffIn('imported memory loses its shared flag', base,
  write('neg-mem-shared', buildModule({ memShared: false })), ['imports', 'exports']);

expectDiffIn('data segment byte changed', base,
  write('neg-data-bytes', buildModule({ dataBytes: 'hellp' })), 'data');

expectDiffIn('data segment offset moved', base,
  write('neg-data-offset', buildModule({ dataOffset: 0x104 })), 'data');

expectDiffIn('element target swapped', base,
  write('neg-elem', buildModule({ elemEntries: [1, 3, 2] })), 'elements');

expectDiffIn('global initializer changed', base,
  write('neg-global', buildModule({ globalInit: 43 })), 'globals');

// Function #1 is exported, so reordering the declarations moves a signature
// under an existing export name — reported in both places, which is exactly
// what the plan's function-order invariant is there to catch. The bodies move
// with the signatures so the fixture stays a valid module; the resulting body
// difference is only a diagnostic, which is why `expectDiffIn` compares
// acceptance sections and this control is still exactly [functions, exports].
expectDiffIn('function declaration order changed', base,
  write('neg-func-order', buildModule({
    funcDecls: ['v_v', 'ii_i', 'v_v'],
    bodyOrder: [1, 0, 2],
  })),
  ['functions', 'exports']);

expectDiffIn('name-to-index map permuted', base,
  write('neg-func-names', buildModule({
    funcNames: ['imported_log', 'noop', 'add', 'caller'],
  })), 'functions');

console.log('tail calls');

// The false-positive guard: the base module contains 0x12 and 0x13 bytes
// inside i32.const immediates and inside its data segment, and must still
// report zero tail calls.
const baseDecoded = decodeWasm(base);
assert.strictEqual(baseDecoded.tailCalls.length, 0,
  'base module must report no tail calls despite 0x12/0x13 immediate bytes');
assert.ok(fs.readFileSync(base).includes(0x12),
  'fixture must actually contain a 0x12 byte, or the guard proves nothing');
checks++;
console.log('  ok  0x12/0x13 inside immediates are not counted as tail calls');

const tailModule = write('tailcall', buildModule({ tailCall: true }));
const tailDecoded = decodeWasm(tailModule);
assert.strictEqual(tailDecoded.tailCalls.length, 1, 'expected one return_call site');
assert.strictEqual(tailDecoded.tailCalls[0].op, 'return_call');
assert.strictEqual(tailDecoded.tailCalls[0].target, 0);
checks++;
console.log('  ok  a real return_call is found and its target decoded');

// --require-no-tailcalls: the compatibility-artifact gate.
const clean = runCli([base, base, '--require-no-tailcalls']);
assert.strictEqual(clean.code, 0, 'tail-call-free pair must pass --require-no-tailcalls');
assert.ok(/OK\s+--require-no-tailcalls/.test(clean.out), clean.out);
checks++;
console.log('  ok  --require-no-tailcalls passes on a tail-call-free pair');

const dirty = runCli([tailModule, tailModule, '--require-no-tailcalls']);
assert.strictEqual(dirty.code, 1,
  '--require-no-tailcalls must exit 1 when a return_call is present');
assert.ok(/FAIL\s+--require-no-tailcalls/.test(dirty.out), dirty.out);
checks++;
console.log('  ok  --require-no-tailcalls fails when a return_call is present');

console.log('acceptance vs diagnostic');

// A tail-call artifact and its lowered twin: same ABI, different body bytes.
// This is the exact shape of build/wine-assembly.wasm vs
// build/wine-assembly.compat.wasm, and it must PASS by default — the plan says
// byte equality is welcome but is not the criterion.
const lowered = write('lowered', buildModule({ tailCall: false }));
const pair = diffWasmAbi(tailModule, lowered);
assert.deepStrictEqual(differingAcceptance(pair), [],
  'tail-call vs lowered twin must have no acceptance diff, got ' +
  `[${differingAcceptance(pair).join(', ')}]`);
assert.ok(pair.match, 'tail-call vs lowered twin must MATCH by default');
assert.strictEqual(pair.bodyDiffs, 1, 'exactly one body should differ');
const bodySection = pair.sections.find(s => s.name === 'code-bodies');
assert.strictEqual(bodySection.acceptance, false,
  'code-bodies must be a diagnostic by default');
assert.ok(bodySection.diffs.length, 'the body difference must still be REPORTED');
assert.strictEqual(pair.tailCalls.a, 1);
assert.strictEqual(pair.tailCalls.b, 0);
checks++;
console.log('  ok  tail-call vs lowered twin: acceptance MATCH, body diff reported');

const pairCli = runCli([tailModule, lowered]);
assert.strictEqual(pairCli.code, 0, 'default verdict on the lowering pair must be exit 0');
assert.ok(/^NOTE\s+code-bodies/m.test(pairCli.out),
  `expected a NOTE line for code-bodies\n${pairCli.out}`);
assert.ok(/^ABI MATCH \(1 body encodings differ; diagnostic only\)$/m.test(pairCli.out),
  `verdict line must disclose the diagnostic\n${pairCli.out}`);
checks++;
console.log('  ok  CLI reports code-bodies as NOTE and still exits 0');

// --strict-code is the same-compiler determinism check: the same pair must now
// fail, and code-bodies must be an acceptance section.
const strict = diffWasmAbi(tailModule, lowered, { strictCode: true });
assert.ok(!strict.match, '--strict-code must fail on differing body bytes');
assert.deepStrictEqual(differingAcceptance(strict), ['code-bodies']);
const strictCli = runCli([tailModule, lowered, '--strict-code']);
assert.strictEqual(strictCli.code, 1, '--strict-code must exit 1 here');
assert.ok(/^DIFF\s+code-bodies/m.test(strictCli.out), strictCli.out);
checks++;
console.log('  ok  --strict-code promotes code-bodies to fatal (exit 1)');

// ...and must still pass on an identical pair, or it would be useless as a
// determinism check.
assert.strictEqual(runCli([base, base, '--strict-code']).code, 0,
  '--strict-code must pass on identical modules');
checks++;
console.log('  ok  --strict-code passes on identical modules');

// A count difference IS fatal even though bodies are not: a compiler is free
// to encode a body differently, never to emit a different number of functions.
const shortModule = write('short-funcs', buildModule({
  funcDecls: ['ii_i', 'v_v'],
  funcNames: ['imported_log', 'add', 'noop'],
  elemEntries: [1, 2],
  dropLastBody: true,
}));
const countPair = diffWasmAbi(base, shortModule);
assert.ok(differingAcceptance(countPair).includes('code'),
  `a function-count change must be an acceptance diff, got ` +
  `[${differingAcceptance(countPair).join(', ')}]`);
assert.ok(countPair.sections.find(s => s.name === 'code').diffs
  .some(d => /count/.test(d)), 'the code section must name the count');
checks++;
console.log('  ok  function/code COUNT stays an acceptance item');

console.log('validation and name-map warning');

// A structural decoder will happily report MATCH on garbage, so the CLI
// validates first.
const garbage = path.join(tmpDir, 'garbage.wasm');
fs.writeFileSync(garbage, Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0xff, 0xff]));
assert.ok(!WebAssembly.validate(fs.readFileSync(garbage)), 'fixture must be invalid');
const bad = runCli([garbage, garbage]);
assert.strictEqual(bad.code, 2, `invalid input must exit 2, got ${bad.code}`);
assert.ok(/not a valid WebAssembly module/.test(bad.out), bad.out);
assert.ok(/--no-validate/.test(bad.out),
  'the rejection must name the escape hatch');
checks++;
console.log('  ok  an invalid module is rejected before comparison (exit 2)');

// The escape hatch must actually skip validation — here the decoder then hits
// the truncation itself, which is a decode error (2), not a silent MATCH.
const skipped = runCli([garbage, garbage, '--no-validate']);
assert.notStrictEqual(skipped.code, 0,
  '--no-validate must not turn garbage into a MATCH');
assert.ok(!/not a valid WebAssembly module/.test(skipped.out),
  '--no-validate must skip the validate step');
checks++;
console.log('  ok  --no-validate skips validation without faking a MATCH');

// The name map is vacuous when neither module has a name section — the state
// every current wine artifact is in — and the tool must say so out loud.
const noNames = write('no-names', buildModule({ noNameSection: true }));
assert.strictEqual(decodeWasm(noNames).funcNames.size, 0);
const namedResult = diffWasmAbi(base, base);
assert.strictEqual(namedResult.nameMapVacuous, false,
  'a module WITH names must not be flagged vacuous');
const vacuous = diffWasmAbi(noNames, noNames);
assert.strictEqual(vacuous.nameMapVacuous, true);
const vacuousCli = runCli([noNames, noNames]);
assert.strictEqual(vacuousCli.code, 0);
assert.ok(/^WARNING: neither module has a name section/m.test(vacuousCli.out),
  `expected the vacuous-name-map warning\n${vacuousCli.out}`);
assert.ok(!/^WARNING: neither module has a name section/m.test(runCli([base, base]).out),
  'the warning must not fire when a name section is present');
checks++;
console.log('  ok  vacuous name-map warning fires only when no name section exists');

// --sections narrows the comparison, so a caller can gate on the ABI alone.
const abiOnly = diffWasmAbi(tailModule, lowered, {
  sections: ['imports', 'exports', 'data', 'elements', 'globals'],
});
assert.ok(abiOnly.match, '--sections ABI subset must match across the lowering');
checks++;
console.log('  ok  --sections subset narrows the comparison');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\nPASS test-wasm-abi-diff (${checks} checks)`);
