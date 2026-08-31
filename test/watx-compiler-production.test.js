'use strict';

const assert = require('assert');
const path = require('path');
const { compile, parseSource } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

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
assert.match(badBulk.error, /memory\.copy: expected 3 args/);

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

console.log('watx-compiler-production: PASS');
