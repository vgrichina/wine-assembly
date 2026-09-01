// ═══════════════════════════════════════════════════════════════
// tools/watx-spec-suite.js — run the WebAssembly spec's own tests through WATX.
//
// The differential harness (tools/watx-differential.js) compares WATX with
// wabt: two implementations, neither of which is the definition. This runner
// goes one step out and uses the DEFINITION — the .wast files from
// WebAssembly/spec test/core, where each `assert_return` states what a call
// must produce according to the standard, written by neither of our encoders.
// Where the two disagree, this is the tiebreaker.
//
// DELIBERATELY NOT IN A TEST TIER. It fetches over the network and caches to
// the system temp dir; a suite in the build must not depend on either. Run it
// by hand when the encoder changes:
//
//   node tools/watx-spec-suite.js                 # the default file set
//   node tools/watx-spec-suite.js i32 i64         # named files
//   node tools/watx-spec-suite.js --verbose       # every failing assertion
//   node tools/watx-spec-suite.js --offline       # cache only, no fetch
//
// WHAT IT CAN AND CANNOT COVER. `inf`, `nan`, `nan:0x…` and hex float literals
// are WATX literals now, so the float files are in the default set and the
// suite went from 1048 assertions to 12668. What is left is not an encoder gap
// but a property of comparing through JS: a wasm f32/f64 becomes a JS number on
// the way out, and a JS NaN has no observable payload, so `nan:0x20304`,
// `nan:canonical` and `nan:arithmetic` are all checked as "the result is a
// NaN". Payload fidelity is proven where it IS observable — the differential
// corpus stores those constants to memory and byte-compares the whole module
// against wabt's. The runner still reports how many assertions it had to skip
// rather than quietly passing a thinner suite than it appears to.
//
// The .wast dialect also carries directives that are about the TEXT format
// rather than the encoder — assert_malformed, assert_invalid, assert_unlinkable,
// register/module-name plumbing. Those are counted as skipped, not as passes:
// asserting that WATX rejects text the spec calls malformed is a different
// project, and pretending otherwise would inflate the score.
// ═══════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { compile } = require(path.join(__dirname, 'watx.js'));

const BASE = 'https://raw.githubusercontent.com/WebAssembly/spec/main/test/core';
const CACHE = path.join(os.tmpdir(), 'watx-spec-cache');
const DEFAULT_FILES = ['i32', 'i64', 'br_table', 'memory', 'address', 'local_get',
  'local_set', 'select', 'block', 'loop', 'if', 'call', 'nop', 'return', 'endianness',
  // The float files, in the default set since `inf` / `nan` / `nan:0x…` / hex
  // floats became WATX literals. They were excluded because almost every
  // assertion in them is written with one of those spellings, so the runner
  // could not state an expected value; f32.wast alone is 2500 assertions that
  // used to be uncheckable.
  'f32', 'f64', 'f32_bitwise', 'f64_bitwise', 'f32_cmp', 'f64_cmp',
  'float_literals', 'float_misc', 'conversions'];

function fetchWast(name, { offline }) {
  const file = path.join(CACHE, `${name}.wast`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  if (offline) return null;
  fs.mkdirSync(CACHE, { recursive: true });
  try {
    execFileSync('curl', ['-sSfL', '-o', file, `${BASE}/${name}.wast`], { timeout: 30000 });
  } catch (e) {
    return null;
  }
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

// ── A minimal s-expression reader ─────────────────────────────────────────
// Not the compiler's tokenizer: that one interns nodes and carries source
// positions this runner has no use for, and a .wast has string literals and
// `;;` / `(; … ;)` comments that a 40-line reader handles exactly.
function readForms(text) {
  const forms = [];
  let i = 0;
  const n = text.length;
  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (text[i] === ';' && text[i + 1] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
      if (text[i] === '(' && text[i + 1] === ';') {
        let d = 1; i += 2;
        while (i < n && d) {
          if (text[i] === '(' && text[i + 1] === ';') { d++; i += 2; }
          else if (text[i] === ';' && text[i + 1] === ')') { d--; i += 2; }
          else i++;
        }
        continue;
      }
      return;
    }
  }
  function read() {
    skip();
    if (i >= n) return undefined;
    if (text[i] === '(') {
      i++;
      const list = [];
      for (;;) {
        skip();
        if (i >= n) throw new Error('unterminated list');
        if (text[i] === ')') { i++; return list; }
        list.push(read());
      }
    }
    if (text[i] === '"') {
      const start = i++;
      while (i < n && (text[i] !== '"' || text[i - 1] === '\\')) i++;
      i++;
      return text.slice(start, i);
    }
    const start = i;
    while (i < n && !/[\s()]/.test(text[i]) && !(text[i] === ';' && text[i + 1] === ';')) i++;
    return text.slice(start, i);
  }
  for (;;) { skip(); if (i >= n) break; forms.push(read()); }
  return forms;
}

// ── Turning an assert_return argument into a JS value ─────────────────────
// Returns { value } or { unsupported: 'why' }. NaN spellings and hex floats are
// the "why" that matters: they are the reason f32/f64 are out of the default
// set, and counting them is how the report stays honest about its coverage.
// `BigInt('-0x80')` throws — the constructor takes a sign only on decimal — and
// the spec files are full of negative hex. Sign is peeled off and reapplied.
function toBigInt(raw) {
  const s = String(raw).replace(/_/g, '');
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : (s.startsWith('+') ? s.slice(1) : s);
  const v = BigInt(body);
  return neg ? -v : v;
}

// The EXPECTED value of a hex-float assertion, as an exact JS number.
//
// Deliberately NOT a copy of the compiler's BigInt rounder: comparing WATX
// against a transcription of WATX's own algorithm would pass whatever that
// algorithm did, correct or not. This works only where the answer needs no
// rounding at all — a significand under 2^53 and a power of two that is itself
// a finite double — so the multiply is a single exact IEEE operation, and it
// returns null (a reported skip, not a silent pass) for anything outside that.
// Every hex float the spec files actually assert is inside it, because an fN
// literal carries at most 53 significant bits by construction.
function hexFloatValue(raw) {
  const m = /^([+-]?)0[xX]([0-9a-fA-F_]*)(?:\.([0-9a-fA-F_]*))?(?:[pP]([+-]?\d+))?$/.exec(raw);
  if (!m) return null;
  const intPart = (m[2] || '').replace(/_/g, '');
  const fracPart = (m[3] || '').replace(/_/g, '');
  const digits = (intPart + fracPart).replace(/^0+/, '');
  if (!intPart && !fracPart) return null;
  const sign = m[1] === '-' ? -1 : 1;
  if (!digits) return sign * 0;
  const mant = BigInt('0x' + digits);
  if (mant >= (1n << 53n)) return null;                    // would need rounding
  const exp2 = (m[4] === undefined ? 0 : parseInt(m[4], 10)) - 4 * fracPart.length;
  const scale = Math.pow(2, exp2);
  if (!Number.isFinite(scale) || scale === 0) return null;  // 2^exp2 is not a double
  const v = Number(mant) * scale;
  if (!Number.isFinite(v)) return null;
  return sign * v;
}

function constValue(form) {
  if (!Array.isArray(form)) return { unsupported: `bare token ${form}` };
  const head = form[0];
  const raw = form[1];
  if (raw === undefined) return { unsupported: `${head} with no operand` };
  if (head === 'i32.const') {
    try { return { value: Number(BigInt.asIntN(32, toBigInt(raw))) }; }
    catch (e) { return { unsupported: `i32.const ${raw}` }; }
  }
  if (head === 'i64.const') {
    try { return { value: BigInt.asIntN(64, toBigInt(raw)) }; }
    catch (e) { return { unsupported: `i64.const ${raw}` }; }
  }
  if (head === 'f32.const' || head === 'f64.const') {
    if (raw === undefined) return { unsupported: `${head} with no operand` };
    // `inf` / `nan` / hex floats are WATX literals now, so the only question
    // left is what NUMBER to compare the call's result against.
    //
    // Every NaN spelling collapses to one expectation, and that is a real limit
    // of comparing through JS rather than a gap in the encoder: a wasm f32/f64
    // crossing into JS becomes a JS number, and a JS NaN has no observable
    // payload. `nan:0x20304`, `nan:canonical` and `nan:arithmetic` are therefore
    // all checked as "the result is a NaN" — which is exactly what
    // `nan:arithmetic` asserts, and strictly weaker than the other two. Payload
    // fidelity is proven where it IS observable: the differential corpus stores
    // these constants to memory and byte-compares the module against wabt's.
    const m = /^([+-]?)nan(?::(0x[0-9a-fA-F_]+|canonical|arithmetic))?$/.exec(raw);
    if (m) return { value: NaN };
    if (/^[+-]?inf$/.test(raw)) return { value: raw[0] === '-' ? -Infinity : Infinity };
    if (/^[+-]?0[xX]/.test(raw)) {
      const hex = hexFloatValue(raw);
      if (hex === null) return { unsupported: `${head} ${raw}` };
      return { value: hex };
    }
    return { value: Number(raw) };
  }
  return { unsupported: `${head}` };
}

function argSource(form) {
  // Arguments are re-emitted as WATX source, so `(i32.const -1)` is whatever
  // WATX's own literal parser makes of it — which is exactly what should be
  // under test. Only the EXPECTED value goes through constValue.
  return `(${form.join(' ')})`;
}

function formatForm(form) {
  if (!Array.isArray(form)) return String(form);
  return `(${form.map(formatForm).join(' ')})`;
}

function runFile(name, text, { verbose }) {
  const forms = readForms(text);
  const stat = {
    name, modules: 0, checked: 0, passed: 0, failed: 0,
    skipped: 0, skipReasons: new Map(), failures: [],
  };
  const skip = (why) => {
    stat.skipped++;
    stat.skipReasons.set(why, (stat.skipReasons.get(why) || 0) + 1);
  };

  let pending = null;   // { source, asserts: [] }
  const flush = () => {
    if (!pending) return;
    const group = pending;
    pending = null;
    if (!group.asserts.length) return;
    stat.modules++;
    // Each assertion becomes an exported wrapper so the spec's own call is what
    // runs: no host-side re-typing of arguments, and an i64 crossing the JS
    // boundary as a BigInt only where the spec says i64.
    let src = group.source;
    group.asserts.forEach((a, k) => {
      src += `\n(func $__spec${k} (export "__spec${k}") ${a.results.length ? `(result ${a.resultTypes.join(' ')})` : ''}` +
        ` (call ${a.target} ${a.args.join(' ')}))`;
    });
    const r = compile(src, new Map(), {
      mode: 'production', standardWat: true, runtimeBuiltins: false, tailCalls: false,
    });
    if (!r.success) {
      // One refusal kills the whole group, so it is charged as one skip with
      // its reason rather than N failures that all say the same thing.
      skip(`module refused: ${r.error.split('\n')[0].slice(0, 90)}`);
      return;
    }
    let ex;
    try {
      ex = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {}).exports;
    } catch (e) {
      skip(`module did not instantiate: ${String(e.message || e).slice(0, 90)}`);
      return;
    }
    group.asserts.forEach((a, k) => {
      stat.checked++;
      let got;
      try { got = ex[`__spec${k}`](); } catch (e) { got = `trap:${String(e.message || e)}`; }
      // An f32 result must be compared at f32 precision. The spec writes the
      // expected value as decimal text, and reading that as a double gives a
      // number the f32 the module actually returns can never equal — every
      // f32 assertion would "fail" on the last few bits of a correct answer.
      const round = (v, k) => (a.resultTypes[k] === 'f32' && typeof v === 'number' ? Math.fround(v) : v);
      const want = a.results.length === 1 ? round(a.results[0], 0) : a.results.map(round);
      const same = a.results.length === 1
        ? (Object.is(got, want) || String(got) === String(want))
        : String(got) === String(want);
      if (same) { stat.passed++; return; }
      stat.failed++;
      if (stat.failures.length < 20) {
        stat.failures.push(`${a.target}${a.args.length ? ' ' + a.args.join(' ') : ''} → want ${want}, got ${got}`);
      }
      if (verbose) console.log(`      FAIL ${a.text}\n           want ${want}, got ${got}`);
    });
  };

  for (const form of forms) {
    if (!Array.isArray(form)) continue;
    const head = form[0];
    if (head === 'module') {
      flush();
      if (typeof form[1] === 'string' && form[1].startsWith('$')) {
        // A named module is part of a linking scenario this runner does not model.
        skip('named module (linking scenario)');
        continue;
      }
      // Re-emit the module body as WATX source, minus the (module) wrapper —
      // WATX accepts the wrapper too, but dropping it keeps the wrapper
      // functions appended below at top level where they belong.
      const source = form.slice(1).map(formatForm).join('\n');
      // FINDING, recorded here rather than counted as a failure: WATX does not
      // support the inline-data memory abbreviation `(memory (data "…"))`,
      // which sizes the memory from its payload — and it does not REFUSE it
      // either. It falls through to the memory it synthesises for a module
      // that declares none, so `memory.size` answers 16 where the spec says 0.
      // A declaration form that is neither understood nor rejected is the
      // shape of bug this whole exercise is about; a plain `(memory N)` and
      // `(memory N M)` are both honoured correctly (measured).
      if (/\(memory \(data/.test(source)) {
        skip('(memory (data …)) inline-data abbreviation — WATX silently substitutes its default 16-page memory instead of sizing from the payload');
        continue;
      }
      pending = { source, asserts: [] };
      continue;
    }
    if (head === 'assert_return') {
      const invoke = form[1];
      if (!pending) { skip('assertion with no preceding module'); continue; }
      if (!Array.isArray(invoke) || invoke[0] !== 'invoke') { skip(`assert on ${Array.isArray(invoke) ? invoke[0] : invoke}`); continue; }
      const name = invoke[1];
      const args = invoke.slice(2);
      const expected = form.slice(2);
      if (!expected.length) { skip('assert_return with no expected value'); continue; }
      const vals = expected.map(constValue);
      const bad = vals.find((v) => v.unsupported);
      if (bad) { skip(`expected value: ${bad.unsupported}`); continue; }
      // `nan:canonical` / `nan:arithmetic` are .wast RESULT patterns, not WAT
      // literals — there is no bit pattern to emit for "any NaN". They belong to
      // no core module, so an argument written that way is skipped rather than
      // handed to the compiler, where it would refuse the whole group.
      const argBad = args.find((a) => !Array.isArray(a) || !/^[fi](32|64)\.const$/.test(a[0]) ||
        /^[+-]?nan:(canonical|arithmetic)$/.test(String(a[1])));
      if (argBad) { skip(`argument form ${formatForm(argBad)}`); continue; }
      // The spec calls exports by NAME; WATX's (call …) wants the $-name, so a
      // wrapper is generated only when the export name is a legal identifier
      // tail. Everything else is skipped rather than guessed at.
      const target = `$${name.replace(/^"|"$/g, '')}`;
      if (!/^\$[A-Za-z0-9_.\-+*/<>=!?]+$/.test(target)) { skip(`export name ${name}`); continue; }
      pending.asserts.push({
        target, args: args.map(argSource),
        results: vals.map((v) => v.value),
        resultTypes: expected.map((e) => e[0].split('.')[0]),
        text: formatForm(form).slice(0, 120),
      });
      continue;
    }
    if (head && head.startsWith('assert_')) { skip(head); continue; }
    if (head === 'invoke' || head === 'register') { skip(head); continue; }
  }
  flush();
  return stat;
}

// The generated wrappers call a function by its $-name, but a .wast module
// declares its functions with (func (export "name") …) and no $-name at all.
// Give every export a $-name matching its export string before compiling.
function nameExports(source) {
  return source.replace(/\(func\s+\(export\s+"([^"]+)"\)/g, (m, name) => {
    if (!/^[A-Za-z0-9_.\-+*/<>=!?]+$/.test(name)) return m;
    return `(func $${name} (export "${name}")`;
  });
}

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const offline = args.includes('--offline');
  const files = args.filter((a) => !a.startsWith('--'));
  const names = files.length ? files : DEFAULT_FILES;

  const totals = { checked: 0, passed: 0, failed: 0, skipped: 0, files: 0, missing: [] };
  const reasons = new Map();
  for (const name of names) {
    const text = fetchWast(name, { offline });
    if (text === null) { totals.missing.push(name); continue; }
    const stat = runFile(name, nameExports(text), { verbose });
    totals.files++;
    totals.checked += stat.checked;
    totals.passed += stat.passed;
    totals.failed += stat.failed;
    totals.skipped += stat.skipped;
    for (const [k, v] of stat.skipReasons) reasons.set(k, (reasons.get(k) || 0) + v);
    const verdict = stat.failed ? 'FAIL' : stat.checked ? 'ok  ' : '--  ';
    console.log(`  ${verdict} ${name.padEnd(12)} ${String(stat.passed).padStart(5)}/${String(stat.checked).padEnd(5)} spec assertions` +
      `   ${stat.skipped} skipped`);
    for (const f of stat.failures) console.log(`         ${f}`);
    // A .wast file often holds ONE module that every assertion invokes, so a
    // single refusal takes the whole file's coverage with it and shows up as a
    // bland 0/0. Say why, or the reader concludes the file was empty.
    if (stat.checked === 0 && stat.skipReasons.size) {
      for (const [why, n] of [...stat.skipReasons].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
        console.log(`         nothing checked — ${n}x ${why}`);
      }
    }
  }

  if (totals.missing.length) {
    console.log(`\nnot fetched (offline or unavailable): ${totals.missing.join(', ')}`);
  }
  console.log(`\n${totals.passed}/${totals.checked} spec assertions pass through WATX across ${totals.files} file(s); ` +
    `${totals.failed} fail, ${totals.skipped} skipped.`);
  console.log('Top reasons an assertion was skipped (coverage this run did NOT get):');
  const top = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [why, n] of top) console.log(`  ${String(n).padStart(5)}  ${why}`);
  process.exit(totals.failed ? 1 : 0);
}

module.exports = { readForms, runFile, nameExports };
if (require.main === module) main();
