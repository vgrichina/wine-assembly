'use strict';

const assert = require('assert');
const path = require('path');
const { compile, compileAsync, parseSource, sourceTextFromBytes, watxNodeFile, watxNodeLine } =
  require(path.join(__dirname, '..', 'tools', 'watx.js'));

// ── The byte → text boundary ────────────────────────────────────────────────
// A source whose only non-ASCII bytes sit in `;;` comments must decode to one
// JavaScript character per source BYTE, so V8 stores it one byte per character.
// Decoding it as UTF-8 instead costs 9.7 MB of live heap on the Wine closure,
// for 21 KB of banner decoration.
const bannerBytes = Buffer.from(
  ';; ══ banner ══\n(func $f (export "f") (result i32) (effects) (i32.const 7))\n', 'utf8');
const bannerText = sourceTextFromBytes(bannerBytes);
assert.strictEqual(bannerText.length, bannerBytes.length,
  'a comment-only non-ASCII source must decode one character per byte');
assert.strictEqual(/[^\x00-\x7f]/.test(bannerText), false,
  'the high bytes inside the comment must not survive into the text');
assert.strictEqual(
  bannerText.slice(bannerText.indexOf('(func')),
  bannerBytes.toString('utf8').slice(bannerBytes.toString('utf8').indexOf('(func')),
  'nothing outside the comment may change');
const bannerBuilt = compile(bannerText, new Map(), { mode: 'production' });
const bannerUtf8 = compile(bannerBytes.toString('utf8'), new Map(), { mode: 'production' });
assert.strictEqual(bannerBuilt.success, true, bannerBuilt.error);
assert.deepStrictEqual(Buffer.from(bannerBuilt.wasmBinary), Buffer.from(bannerUtf8.wasmBinary),
  'asciifying comment bytes must not change one emitted byte');

// A high byte ANYWHERE else — here inside a data string — is real content, so
// the boundary bails out and hands back exactly what UTF-8 decoding gives.
// Getting this wrong would silently rewrite a data segment.
const literalBytes = Buffer.from('(data (i32.const 0) "café")\n;; ══\n', 'utf8');
assert.strictEqual(sourceTextFromBytes(literalBytes), literalBytes.toString('utf8'),
  'a high byte outside a comment must fall back to UTF-8 decoding, untouched');
// A string is not a comment even when it contains one, and vice versa: the `;;`
// here opens nothing, so the `é` after it is still string content and must
// survive. Reading it as a comment would asciify a live data byte.
const commentInString = Buffer.from('(data (i32.const 0) ";; é")\n', 'utf8');
assert.strictEqual(sourceTextFromBytes(commentInString), commentInString.toString('utf8'),
  '`;;` inside a string literal must not open a comment');
// ...and a quote inside a comment opens no string: the run of non-ASCII after
// it is still comment text and must still be asciified.
const quoteInComment = Buffer.from(';; a " quote ══\n(func $g (export "g") (effects))\n', 'utf8');
assert.strictEqual(sourceTextFromBytes(quoteInComment).length, quoteInComment.length,
  'a quote inside a comment must not open a string literal');
assert.strictEqual(sourceTextFromBytes('already text'), 'already text');

// The production AST is a dense array: packed location, head, then operands.
// Atoms are internable primitive strings rather than per-occurrence objects.
const compactAst = parseSource('(i32.add (local.get $a) (i32.const 1))', 'compact-test.watx');
assert.strictEqual(compactAst.length, 1);
assert.strictEqual(Number.isInteger(compactAst[0][0]), true);
assert.strictEqual(compactAst[0][0] >= 0 && compactAst[0][0] < 0x40000000, true);
assert.strictEqual(compactAst[0][1], 'i32.add');
assert.strictEqual(typeof compactAst[0][1], 'string');
assert.deepStrictEqual(Array.from(compactAst[0][2].slice(1)), ['local.get', '$a']);
assert.deepStrictEqual(Array.from(compactAst[0][3].slice(1)), ['i32.const', '1']);

// ── Location packing has room for the tree to grow ──────────────────────────
// A source location is one Smi: a file id and a byte offset into that file.
// With six file bits the Wine closure (62 sources plus <main>) sat ONE file
// from "supports at most 64 source files", a build failure that names no
// culprit. Assert real headroom in the dimension that runs out first, and that
// a location from a high file id still round-trips to the right file.
{
  const names = [];
  for (let i = 0; i < 100; i++) names.push(`headroom-${i}.watx`);
  for (const name of names) parseSource('(nop)\n(nop)', name);
  const late = parseSource('\n\n(func $z (effects))', names[names.length - 1] + '-last');
  assert.strictEqual(watxNodeFile(late[0]), 'headroom-99.watx-last');
  assert.strictEqual(watxNodeLine(late[0]), 3, 'line must survive a high file id');
}

const source = `
(func $answer (export "answer") (result i32) (effects heap)
  (i32.add (i32.const 20) (i32.const 22)))
`;

const debug = compile(source);
const production = compile(source, new Map(), { mode: 'production' });

assert.strictEqual(debug.success, true);
assert.strictEqual(production.success, true);
assert.deepStrictEqual(Buffer.from(production.wasmBinary), Buffer.from(debug.wasmBinary));
assert.strictEqual(typeof debug.wasmText, 'string');
assert.strictEqual(typeof debug.expanded, 'string');
assert.strictEqual(typeof debug.lowered, 'string');
assert.match(debug.expanded, /^\(func\b/);
assert.strictEqual(Object.hasOwn(production, 'wasmText'), false);
assert.strictEqual(Object.hasOwn(production, 'expanded'), false);
assert.strictEqual(Object.hasOwn(production, 'lowered'), false);
assert.strictEqual(production.diagnostics.length, 0);
assert.strictEqual(new WebAssembly.Instance(new WebAssembly.Module(production.wasmBinary)).exports.answer(), 42);

// Production's two-pass path keeps WAT whole-module name scope and WATX's
// existing forward-macro behavior. It must remain byte-identical to the
// full-tree implementation retained behind streaming:false.
const forwardSource = `
(func $target (param $x i32) (result i32) (effects) (LATE_VALUE $x))
(table $handlers 1 1 funcref)
(elem (i32.const 0) $target)
(func $forward (export "forward") (result i32) (effects)
  (call_indirect (type $later_type) (i32.const 0) (i32.const 21)))
(type $later_type (func (param i32) (result i32)))
(defmacro (LATE_VALUE $x) (i32.add $x $x))
`;
const forwardStreaming = compile(forwardSource, new Map(), { mode: 'production', runtimeBuiltins: false });
const forwardFullTree = compile(forwardSource, new Map(), { mode: 'production', runtimeBuiltins: false, streaming: false });
assert.strictEqual(forwardStreaming.success, true, forwardStreaming.error);
assert.strictEqual(forwardFullTree.success, true, forwardFullTree.error);
assert.deepStrictEqual(Buffer.from(forwardStreaming.wasmBinary), Buffer.from(forwardFullTree.wasmBinary));
assert.strictEqual(new WebAssembly.Instance(new WebAssembly.Module(forwardStreaming.wasmBinary)).exports.forward(), 42);

// The streaming body parser retains its repeated symbol vocabulary while
// recycling each function tree. Exercise enough bodies to cross that path and
// keep its output pinned to the full-tree parser.
const repeatedSymbolSource = Array.from({ length: 128 }, (_, i) =>
  `(func $repeat_${i} (param $x i32) (result i32) (effects) ` +
  `(i32.add (local.get $x) (i32.const 1)))`).join('\n') +
  `\n(func $repeat_export (export "repeat") (result i32) (effects) ` +
  `(call $repeat_127 (i32.const 41)))\n`;
const repeatedSymbolStreaming = compile(
  repeatedSymbolSource, new Map(), { mode: 'production', runtimeBuiltins: false });
const repeatedSymbolFullTree = compile(
  repeatedSymbolSource, new Map(), { mode: 'production', runtimeBuiltins: false, streaming: false });
assert.strictEqual(repeatedSymbolStreaming.success, true, repeatedSymbolStreaming.error);
assert.deepStrictEqual(
  Buffer.from(repeatedSymbolStreaming.wasmBinary), Buffer.from(repeatedSymbolFullTree.wasmBinary));
assert.strictEqual(
  new WebAssembly.Instance(new WebAssembly.Module(repeatedSymbolStreaming.wasmBinary)).exports.repeat(), 42);

// Merely defining a macro with an indirect-call signature must not change the
// type section. Pass 1 follows only macros actually referenced by a function.
const unusedMacroSource = `
(func $answer (export "answer") (result i32) (effects) (i32.const 42))
(defmacro (UNUSED_INDIRECT $index)
  (call_indirect (type (func (param i32) (result i32))) $index (i32.const 1)))
`;
const unusedMacroStreaming = compile(unusedMacroSource, new Map(), { mode: 'production', runtimeBuiltins: false });
const unusedMacroFullTree = compile(unusedMacroSource, new Map(), { mode: 'production', runtimeBuiltins: false, streaming: false });
assert.strictEqual(unusedMacroStreaming.success, true, unusedMacroStreaming.error);
assert.deepStrictEqual(Buffer.from(unusedMacroStreaming.wasmBinary), Buffer.from(unusedMacroFullTree.wasmBinary));

const macroHeaderSource = `
(func $answer (export "answer") (RET_I32) (effects) (i32.const 42))
(defmacro (RET_I32) (result i32))
`;
const macroHeaderStreaming = compile(macroHeaderSource, new Map(), { mode: 'production', runtimeBuiltins: false });
const macroHeaderFullTree = compile(macroHeaderSource, new Map(), { mode: 'production', runtimeBuiltins: false, streaming: false });
assert.strictEqual(macroHeaderStreaming.success, true, macroHeaderStreaming.error);
assert.deepStrictEqual(Buffer.from(macroHeaderStreaming.wasmBinary), Buffer.from(macroHeaderFullTree.wasmBinary));
assert.strictEqual(new WebAssembly.Instance(new WebAssembly.Module(macroHeaderStreaming.wasmBinary)).exports.answer(), 42);

// Production skips advisory type inference, but hard structural diagnostics
// remain enforced by emission.
const rejectsProduction = sourceText => compile(sourceText, new Map(), { mode: 'production' });
const badCall = rejectsProduction(`
  (func $callee (param $x i32) (effects) (drop (local.get $x)))
  (func $caller (effects) (call $callee))
`);
assert.strictEqual(badCall.success, false);
assert.match(badCall.error, /call \$callee: expected 1 args, got 0/);

const badBulk = rejectsProduction(`
  (func $bad (effects) (memory.copy (i32.const 0) (i32.const 4)))
`);
assert.strictEqual(badBulk.success, false);
assert.match(badBulk.error,
  /memory\.copy in function \$bad: expected exactly 3 operand\(s\), got 2/);

const standardTable = rejectsProduction(`
  (func $bad (param $i i32) (effects)
    (block $done (br_table $done $done (local.get $i))))
`);
assert.strictEqual(standardTable.success, true, standardTable.error);
assert.doesNotThrow(() => new WebAssembly.Module(standardTable.wasmBinary));

const badSymbol = rejectsProduction(`
(func $bad (effects)
  (drop $missing))
`);
assert.strictEqual(badSymbol.success, false);
assert.strictEqual(badSymbol.errorLine, 3);
assert.strictEqual(badSymbol.errorCol, 9);

// Macro arity, both directions. It was unchecked both ways and silently: a
// surplus argument was dropped by `params.forEach` (which iterates the
// PARAMETERS, so it never looks at an argument past the last one), and a
// missing one bound `undefined`, which substitute spliced into the body as a
// hole. Either way the module compiled and computed as if the extra argument
// had never been written — the exact failure an edit that reorders or renames a
// macro's parameters leaves behind at every call site. A macro invocation is a
// call, and `call $callee: expected 1 args, got 0` above is the standard this
// now meets.
const macroTooMany = rejectsProduction(`
(defmacro (DOUBLE $x) (i32.add $x $x))
(func $f (result i32) (effects) (DOUBLE (i32.const 1) (i32.const 2)))
`);
assert.strictEqual(macroTooMany.success, false, 'a macro given too MANY arguments must be rejected');
assert.match(macroTooMany.error, /macro DOUBLE takes 1 argument\(s\).*got 2/);

const macroTooFew = rejectsProduction(`
(defmacro (ADD3 $a $b $c) (i32.add $a (i32.add $b $c)))
(func $f (result i32) (effects) (ADD3 (i32.const 1) (i32.const 2)))
`);
assert.strictEqual(macroTooFew.success, false, 'a macro given too FEW arguments must be rejected');
assert.match(macroTooFew.error, /macro ADD3 takes 3 argument\(s\).*got 2/);

// The error names the line it was written on, not the expansion's.
assert.strictEqual(macroTooFew.errorLine, 3, `errorLine was ${macroTooFew.errorLine}`);

// A zero-parameter macro is still a macro: it must take zero arguments, and
// invoking it correctly must keep working.
const macroNullaryExtra = rejectsProduction(`
(defmacro (ONE) (i32.const 1))
(func $f (result i32) (effects) (ONE (i32.const 9)))
`);
assert.strictEqual(macroNullaryExtra.success, false);

const macroOk = rejectsProduction(`
(defmacro (DOUBLE $x) (i32.add $x $x))
(defmacro (ONE) (i32.const 1))
(func $f (export "f") (result i32) (effects) (DOUBLE (ONE)))
`);
assert.strictEqual(macroOk.success, true, macroOk.error);
assert.strictEqual(
  new WebAssembly.Instance(new WebAssembly.Module(macroOk.wasmBinary), {}).exports.f(), 2);

async function checkCooperativeCompiler() {
  const checkpoints = [];
  let eventLoopTurns = 0;
  const cooperative = await compileAsync(repeatedSymbolSource, new Map(), {
    mode: 'production',
    runtimeBuiltins: false,
    // Force every compiler checkpoint to yield so this small fixture proves
    // the scheduling contract without relying on machine-dependent timings.
    yieldIntervalMs: 0,
    yieldControl: checkpoint => new Promise(resolve => setImmediate(() => {
      checkpoints.push(checkpoint);
      eventLoopTurns++;
      resolve();
    })),
  });
  assert.strictEqual(cooperative.success, true, cooperative.error);
  assert.deepStrictEqual(
    Buffer.from(cooperative.wasmBinary), Buffer.from(repeatedSymbolStreaming.wasmBinary),
    'cooperative and synchronous compilation must emit byte-identical modules');
  assert.strictEqual(checkpoints[0].stage, 'START');
  assert(checkpoints.some(p => p.stage === 'CHECK'));
  assert(checkpoints.some(p => p.stage === 'LOWER'));
  const emitted = checkpoints.filter(p => p.stage === 'EMIT');
  assert.strictEqual(emitted.length, 129,
    'the cooperative path must expose one scheduling boundary per emitted function');
  assert.strictEqual(emitted[emitted.length - 1].completed, emitted[emitted.length - 1].total);
  assert(eventLoopTurns >= 133, 'Node must regain event-loop turns throughout compilation');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    compileAsync(source, new Map(), { signal: controller.signal }),
    error => error && error.name === 'AbortError');
}

checkCooperativeCompiler().then(() => {
  console.log('watx-compiler-production: PASS');
}, error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
