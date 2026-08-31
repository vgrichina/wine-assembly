// test/watx-compiler-literals.test.js -- strict numeric-literal parsing, and the
// positional-else warning.
//
// WHY THIS SUITE EXISTS (codex review, 2026-08-31).
//
// `parseInt` and `parseFloat` do not validate. They scan a prefix, stop at the first
// character they cannot use, and return whatever they managed to read -- so every
// numeric literal position in the WATX compiler used to accept trailing junk and bake a
// plausible-looking WRONG constant into the module, with no error and no warning:
//
//     (i32.const 1_000)              ->  1        (the WAT digit separator split the token)
//     (i32.const 123abc)             ->  123
//     (i64.const 0x10zz)             ->  16n
//     (f32.const 1.25junk)           ->  1.25
//     (f64.const 1_000.5)            ->  1
//     (i32.load offset=16junk ...)   ->  offset=16
//
// A wrong constant is the worst possible failure mode for this compiler: the module
// compiles, validates, runs, and misbehaves somewhere else entirely. The same class of
// bug already cost a session once -- see test/watx-compiler-i64-literal.test.js, where a
// negatively-signed hex i64 compiled to a silent zero and the OLE compound-file magic
// vanished from every container the emulator wrote.
//
// THE UNDERSCORE DECISION. The WAT text format allows `_` BETWEEN digits: `1_000` is
// 1000 and `0xFFFF_FFFF` is 0xFFFFFFFF. Of the three possible outcomes for `1_000`
// -- parse it as 1000, reject it, or silently produce 1 -- only the last is unacceptable,
// and the spec answer is the first. WATX's tokenizer now carries `_` through a number
// token and the validators accept it only in the spec position (between two digits of the
// same run: never leading, trailing or doubled). Every literal that was already valid
// keeps its exact previous value and encoding.
//
// NOT SUPPORTED and now rejected loudly rather than truncated: hex floats (`0x1p4`),
// `inf`/`nan`, and a `+`-signed exponent (`1e+10`). None of them occur in the
// Wine-Assembly closure. A NEGATIVE exponent does tokenize and still works -- there is
// one in the tree, `(f64.const 2.2250738585072014e-308)` at src/06-fpu.wat:193, and it is
// asserted below.
//
// The assertions read the value back out of a RUNNING module wherever a value exists, so
// they are about emitted bytes and not about a compile that merely returned success.
//
// Run: node test/watx-compiler-literals.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}

function build(src, options = {}) {
  return compile(src, new Map(), { runtimeBuiltins: false, standardWat: true, tailCalls: false, ...options });
}

// Compile one expression and read its value back out of an instantiated module.
// Returns { value } or { error }.
function evalWat(src, fn = 'm', args = []) {
  let r;
  try { r = build(src); } catch (e) { return { error: String(e.message || e) }; }
  if (!r || !r.success) return { error: String((r && (r.error || r.message)) || 'compile failed') };
  try {
    const X = new WebAssembly.Instance(new WebAssembly.Module(r.wasmBinary), {}).exports;
    return { value: X[fn](...args) };
  } catch (e) { return { error: String(e.message || e) }; }
}

const constFn = (type, literal) =>
  `(memory 1 1)\n(func $m (export "m") (result ${type}) (${type}.const ${literal}))`;

function constValue(type, literal) { return evalWat(constFn(type, literal)); }

// ═══════════════════════════════════════════════════════════════════════════
// 1. The six reproduced shapes. Each must now either hard-error or produce the
//    spec value -- never the silently truncated one.
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = constValue('i32', '1_000');
  ck('(i32.const 1_000) is the spec value 1000, not the truncated 1',
    r.value === 1000, r.error || r.value);

  const junk32 = constValue('i32', '123abc');
  ck('(i32.const 123abc) is a hard error, not 123', !!junk32.error, junk32.value);
  ck('...and the message names the offending token',
    /123abc/.test(junk32.error || ''), junk32.error);

  const junk64 = constValue('i64', '0x10zz');
  ck('(i64.const 0x10zz) is a hard error, not 16n', !!junk64.error, junk64.value);

  const junkF32 = constValue('f32', '1.25junk');
  ck('(f32.const 1.25junk) is a hard error, not 1.25', !!junkF32.error, junkF32.value);

  const sep64 = constValue('f64', '1_000.5');
  ck('(f64.const 1_000.5) is the spec value 1000.5, not 1',
    sep64.value === 1000.5, sep64.error || sep64.value);

  const memarg = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.load offset=16junk (i32.const 0)))');
  ck('(i32.load offset=16junk ...) is a hard error, not offset=16', !!memarg.error, memarg.value);
  ck('...and the memarg message names the key and the op',
    /offset/.test(memarg.error || '') && /i32\.load/.test(memarg.error || ''), memarg.error);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Junk in every other literal position too -- one rejection is not a fix if
//    the neighbouring position still truncates.
// ═══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    ['i32.const trailing dot-junk', constValue('i32', '10.5x')],
    ['i64.const trailing junk', constValue('i64', '99bogus')],
    ['f32.const bare junk', constValue('f32', 'wat')],
    ['f64.const double dot', constValue('f64', '1.2.3')],
    ['f64.const trailing exponent', constValue('f64', '1e')],
    ['i32.const leading underscore', constValue('i32', '_5')],
    ['i32.const trailing underscore', constValue('i32', '5_')],
    ['i32.const doubled underscore', constValue('i32', '1__0')],
    ['i32.const bare 0x with no digits', constValue('i32', '0x')],
    ['i32.const double sign', constValue('i32', '--5')],
  ];
  for (const [name, r] of cases) ck(`${name} is rejected`, !!r.error, r.value);

  const alignJunk = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.load align=4x (i32.const 0)))');
  ck('align=4x is rejected', !!alignJunk.error, alignJunk.value);

  const twoEq = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.load offset=1=2 (i32.const 0)))');
  ck('offset=1=2 is rejected rather than read as offset=1', !!twoEq.error, twoEq.value);

  // An extra token after the literal is the other half of the same bug: the
  // tokenizer splits `0x10zz` into a number and a stray symbol, so arity has to
  // be checked or the junk is simply dropped on the floor.
  const extra = constValue('i32', '5 6');
  ck('a const with two operands is rejected', !!extra.error, extra.value);
  const none = evalWat('(memory 1 1)\n(func $m (export "m") (result i32) (i32.const))');
  ck('a const with no operand is rejected (it used to default to 0)', !!none.error, none.value);
  const subexpr = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.const (i32.const 5)))');
  ck('a const whose operand is a sub-expression is rejected', !!subexpr.error, subexpr.value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Unsupported-but-plausible float spellings fail loudly instead of quietly.
// ═══════════════════════════════════════════════════════════════════════════
{
  for (const lit of ['0x1p4', 'inf', '-inf', 'nan', 'nan:0x400000', '1e+10']) {
    const r = constValue('f64', lit);
    ck(`(f64.const ${lit}) is rejected rather than silently truncated`, !!r.error, r.value);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Everything that was already valid still is, and still has the same value.
//    This is the no-regression half: a stricter validator that rejects real
//    source is worse than the bug it fixes.
// ═══════════════════════════════════════════════════════════════════════════
{
  const i32 = [
    ['0', 0], ['42', 42], ['-42', -42], ['+42', 42],
    ['0x2a', 42], ['0X2A', 42], ['0xdeadbeef', -559038737 | 0],
    ['-0x2a', -42],                       // the 3fdae908 shape, i32 side
    ['2147483647', 2147483647], ['-2147483648', -2147483648],
    ['1_000', 1000], ['0xFFFF_FFFF', -1], ['1_000_000', 1000000],
  ];
  for (const [lit, want] of i32) {
    const r = constValue('i32', lit);
    ck(`(i32.const ${lit}) == ${want}`, r.value === want, r.error || r.value);
  }

  const i64 = [
    ['0', 0n], ['42', 42n], ['-42', -42n],
    ['0x7FFFFFFFFFFFFFFF', 0x7FFFFFFFFFFFFFFFn],
    // The commit-3fdae908 regression: a negatively-signed hex i64 (the OLE CFB magic).
    ['-0x1EE54E5E1FEE3030', -0x1EE54E5E1FEE3030n],
    ['1_000', 1000n], ['0xFFF8_0000_0000_0000', -2251799813685248n],
  ];
  for (const [lit, want] of i64) {
    const r = constValue('i64', lit);
    ck(`(i64.const ${lit}) == ${want}`, r.value === want, r.error || String(r.value));
  }

  const f64 = [
    ['0', 0], ['1.5', 1.5], ['-1.5', -1.5], ['3', 3],
    // The one exponent form the Wine tree actually contains (src/06-fpu.wat:193).
    ['2.2250738585072014e-308', 2.2250738585072014e-308],
    ['1e10', 1e10], ['1E10', 1e10], ['1.', 1],
  ];
  for (const [lit, want] of f64) {
    const r = constValue('f64', lit);
    ck(`(f64.const ${lit}) == ${want}`, r.value === want, r.error || r.value);
  }

  const f32 = constValue('f32', '1.25');
  ck('(f32.const 1.25) == 1.25', f32.value === 1.25, f32.error || f32.value);

  // A BARE atom in operand position is a WATX spelling (standard WAT always
  // writes the .const form), and it has its own literal path. The tokenizer
  // starts a number only on a digit or a '-', so `+42` arrives as a SYMBOL and
  // used to be rejected as an unknown one while `(i32.const +42)` compiled --
  // an inconsistency with no rationale, now closed in both directions.
  const bare = [
    ['42', 42], ['-42', -42], ['+42', 42], ['0x2a', 42], ['+0x2a', 42], ['-0x2a', -42],
    ['1_000', 1000], ['+1_000', 1000],
  ];
  for (const [lit, want] of bare) {
    const r = evalWat(`(memory 1 1)\n(func $m (export "m") (result i32) (i32.add ${lit} (i32.const 0)))`);
    ck(`a bare ${lit} atom == ${want}`, r.value === want, r.error || r.value);
  }
  // ...and a bare hex atom containing E is an INTEGER, not the float branch,
  // where parseFloat('0xE1') would have been a silent 0.
  const bareHexE = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.add 0xE1 (i32.const 0)))');
  ck('a bare 0xE1 atom is 225, not a silent 0', bareHexE.value === 225, bareHexE.error || bareHexE.value);
  // A bare float atom still takes the float branch, plus sign or not.
  const bareFloat = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result f32) (f32.add +1.5 (f32.const 0)))');
  ck('a bare +1.5 atom is a float, not an integer-literal error',
    bareFloat.value === 1.5, bareFloat.error || bareFloat.value);
  const bareJunk = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32) (i32.add +4zz (i32.const 0)))');
  ck('a bare +4zz atom is rejected', !!bareJunk.error, bareJunk.value);

  // Memarg, both keys, including a separator inside the offset.
  const mem = evalWat(
    '(memory 1 1)\n' +
    '(func $m (export "m") (result i32)\n' +
    '  (i32.store offset=16 align=4 (i32.const 0) (i32.const 7))\n' +
    '  (i32.load offset=16 align=4 (i32.const 0)))');
  ck('offset=/align= memargs still round-trip a stored value', mem.value === 7, mem.error || mem.value);
  const memSep = evalWat(
    '(memory 1 1)\n' +
    '(func $m (export "m") (result i32)\n' +
    '  (i32.store offset=1_6 (i32.const 0) (i32.const 9))\n' +
    '  (i32.load offset=16 (i32.const 0)))');
  ck('a digit separator inside a memarg offset is the spec value', memSep.value === 9, memSep.error || memSep.value);

  // Global initializers and an active data-segment offset are literal positions too.
  const glob = evalWat(
    '(memory 1 1)\n(global $g i32 (i32.const 0x1_000))\n' +
    '(func $m (export "m") (result i32) (global.get $g))');
  ck('a global i32 initializer takes a separator literal', glob.value === 0x1000, glob.error || glob.value);
  const globF = evalWat(
    '(memory 1 1)\n(global $g f64 (f64.const 2.5))\n' +
    '(func $m (export "m") (result f64) (global.get $g))');
  ck('a global f64 initializer still works', globF.value === 2.5, globF.error || globF.value);
  const globJunk = evalWat(
    '(memory 1 1)\n(global $g i32 (i32.const 5oops))\n' +
    '(func $m (export "m") (result i32) (global.get $g))');
  ck('junk in a global initializer is rejected', !!globJunk.error, globJunk.value);

  const data = evalWat(
    '(memory 1 1)\n(data (i32.const 16) "\\07")\n' +
    '(func $m (export "m") (result i32) (i32.load8_u offset=16 (i32.const 0)))');
  ck('an active data segment at a plain offset still lands', data.value === 7, data.error || data.value);
  const dataJunk = evalWat(
    '(memory 1 1)\n(data (i32.const 16zz) "\\07")\n' +
    '(func $m (export "m") (result i32) (i32.load8_u offset=16 (i32.const 0)))');
  ck('junk in a data-segment offset is rejected', !!dataJunk.error, dataJunk.value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. SIMD lane immediates are literal positions as well (they already
//    range-check, which hides junk whose prefix happens to be in range).
// ═══════════════════════════════════════════════════════════════════════════
{
  // What the lane INDEX means (which end of a (v128.const i32x4 ...) is lane 0)
  // is watx-compiler-lanes.test.js's subject, not this suite's. All that is
  // asserted here is that a well-formed lane immediate still reaches the encoder
  // and that different immediates select different lanes.
  const lane0 = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32)\n' +
    '  (i32x4.extract_lane 0 (v128.const i32x4 10 20 30 40)))');
  const lane1 = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32)\n' +
    '  (i32x4.extract_lane 1 (v128.const i32x4 10 20 30 40)))');
  ck('a valid lane immediate still compiles', !lane0.error && !lane1.error,
    lane0.error || lane1.error);
  ck('...and different lane immediates select different lanes',
    lane0.value !== lane1.value, `${lane0.value} vs ${lane1.value}`);
  const junk = evalWat(
    '(memory 1 1)\n(func $m (export "m") (result i32)\n' +
    '  (i32x4.extract_lane 1zz (v128.const i32x4 10 20 30 40)))');
  ck('a lane immediate with trailing junk is rejected', !!junk.error, junk.value);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. FINDING 3 -- the positional else.
//
// Standard WAT spells the else arm `(else ...)`. WATX also accepts a BARE
// fourth child of `(if COND (then ...) EXPR)` as the else, which is not
// standard and, worse, is a shape the two compilers read DIFFERENTLY:
// lib/compile-wat.js silently discards that expression, WATX compiles it as the
// else arm. One such site is still in the tree at src/09a5-handlers-window.wat:225
// (peer-owned), so this is a WARNING for now, not an error -- promotion to a
// hard error is planned for when the closure has zero such sites.
// ═══════════════════════════════════════════════════════════════════════════
// tools/watx.js runs the vendored stages inside a vm context whose `console` is
// a shim writing to process.stderr, so patching this process's console.warn sees
// nothing. Intercept the stream instead — that is where the warning really goes.
function warningsFrom(src) {
  const lines = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => {
    const s = String(chunk);
    for (const line of s.split('\n')) if (/WATX WARNING/.test(line)) lines.push(line);
    return true;
  };
  let r;
  try { r = build(src); } finally { process.stderr.write = realWrite; }
  return { warnings: lines, result: r };
}

{
  const positional =
    '(memory 1 1)\n' +
    '(func $m (export "m") (param $c i32) (result i32)\n' +
    '  (if (result i32) (local.get $c) (then (i32.const 1)) (i32.const 2)))';
  const w = warningsFrom(positional);
  ck('the positional-else shape still compiles', !!(w.result && w.result.success),
    w.result && w.result.error);
  ck('...and warns exactly once', w.warnings.length === 1, w.warnings.length);
  ck('...with a message naming the shape',
    /else slot of \(if COND \(then \.\.\.\) EXPR\)/.test(w.warnings[0] || ''), w.warnings[0]);
  ck('...that says WATX is compiling it AS the else arm',
    /compiling it AS the else arm/.test(w.warnings[0] || ''), w.warnings[0]);
  ck('...that says the legacy compiler discards it',
    /compile-wat\.js silently DISCARDS it/.test(w.warnings[0] || ''), w.warnings[0]);
  ck('...and that it will become a hard error',
    /will become a hard error/.test(w.warnings[0] || ''), w.warnings[0]);

  // The behaviour itself is unchanged: the bare tail IS the else arm.
  const taken = evalWat(positional, 'm', [1]);
  const notTaken = evalWat(positional, 'm', [0]);
  ck('the bare tail is compiled as the else arm (cond true -> then)', taken.value === 1, taken.error || taken.value);
  ck('the bare tail is compiled as the else arm (cond false -> tail)', notTaken.value === 2, notTaken.error || notTaken.value);
}

{
  const proper =
    '(memory 1 1)\n' +
    '(func $m (export "m") (param $c i32) (result i32)\n' +
    '  (if (result i32) (local.get $c) (then (i32.const 1)) (else (i32.const 2))))';
  const w = warningsFrom(proper);
  ck('a proper (else ...) does NOT warn', w.warnings.length === 0, w.warnings.join(' | '));
  ck('a proper (else ...) still compiles', !!(w.result && w.result.success));
}

{
  // An if with no else at all must not warn either.
  const noElse =
    '(memory 1 1)\n' +
    '(func $m (export "m") (param $c i32)\n' +
    '  (if (local.get $c) (then (nop))))';
  ck('an else-less if does not warn', warningsFrom(noElse).warnings.length === 0);
}

{
  // WATX's own `(if COND A B)` shorthand has no (then ...) either. It is a
  // documented WATX spelling, not a mistake, so it must stay quiet -- otherwise
  // every watjs tree drowns in warnings and the real sites are invisible.
  const shorthand =
    '(memory 1 1)\n' +
    '(func $m (export "m") (param $c i32) (result i32)\n' +
    '  (if (result i32) (local.get $c) (i32.const 1) (i32.const 2)))';
  const w = warningsFrom(shorthand);
  ck('the WATX (if COND A B) shorthand does not warn', w.warnings.length === 0, w.warnings.join(' | '));
  ck('...and still compiles', !!(w.result && w.result.success), w.result && w.result.error);
}

{
  // One line per SITE: two distinct sites warn twice, and neither is repeated.
  const twoSites =
    '(memory 1 1)\n' +
    '(func $a (export "a") (param $c i32) (result i32)\n' +
    '  (if (result i32) (local.get $c) (then (i32.const 1)) (i32.const 2)))\n' +
    '(func $b (export "b") (param $c i32) (result i32)\n' +
    '  (if (result i32) (local.get $c) (then (i32.const 3)) (i32.const 4)))';
  const w = warningsFrom(twoSites);
  ck('two distinct positional-else sites warn twice', w.warnings.length === 2, w.warnings.length);
  ck('...on two different lines',
    new Set(w.warnings.map(s => (s.match(/:(\d+):/) || [])[1])).size === 2,
    w.warnings.join(' | '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
