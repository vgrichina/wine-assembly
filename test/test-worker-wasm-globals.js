#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { ThreadManager } = require('../lib/thread-manager');
const {
  INHERITED_WASM_GLOBALS,
  THREAD_PRIMITIVE_IMPORTS,
  adoptThreadPrimitives,
  createInheritedWasmGlobals,
  recordInheritedWasmGlobal,
  inheritedWasmCalls,
  applyInheritedWasmGlobals,
} = require('../lib/worker-imports');

const ROOT = path.join(__dirname, '..');
const setters = INHERITED_WASM_GLOBALS.map(rule => rule.setter);
assert.strictEqual(new Set(setters).size, setters.length,
  'the inherited-global table must not contain duplicate setters');

assert(THREAD_PRIMITIVE_IMPORTS.includes('terminate_thread'),
  'CreateThread worker imports must adopt TerminateThread from the process host');
{
  const memory = new ArrayBuffer(64 * 1024);
  const baseHost = createHostImports({ getMemory: () => memory, renderer: null, resourceJson: {} }).host;
  assert.strictEqual(typeof baseHost.terminate_thread, 'function',
    'base host imports must expose TerminateThread before ThreadManager is installed');

  const workerHost = {};
  const mainHost = Object.fromEntries(THREAD_PRIMITIVE_IMPORTS.map(name => [
    name, () => name,
  ]));
  adoptThreadPrimitives(workerHost, mainHost);
  assert.strictEqual(workerHost.terminate_thread(), 'terminate_thread',
    'TerminateThread must be callable from spawned WASM instances');
}

for (const setter of [
  'set_cpu_mmx', 'set_winver', 'set_bp', 'set_watchpoint_size', 'set_watchpoint',
  'set_cs_steal_after', 'set_fault_unmapped', 'set_callstack_enabled',
  'set_trace_eip_range', 'set_count', 'set_loop_trace', 'set_loop_emit',
  'set_loop_lut_emit', 'set_loop_copy_emit', 'set_loop_aoe_fill_emit',
  'set_loop_aoe_span_emit', 'set_sib_fusion', 'set_store_span_fusion',
  'set_x87_pipeline4_fusion', 'set_rect_run',
  'set_case_chain', 'set_rle_run',
]) {
  assert(setters.includes(setter), `${setter} is missing from inherited WASM globals`);
}

const configured = createInheritedWasmGlobals();
const record = (setter, ...args) =>
  assert(recordInheritedWasmGlobal(configured, setter, args), `${setter} must be inheritable`);
record('set_loop_trace', 1, 0x401000);
record('set_loop_emit', 0);              // zero is meaningful: disable default
record('set_loop_lut_emit', 1);
record('set_loop_copy_emit', 1);
record('set_loop_aoe_fill_emit', 0);
record('set_loop_aoe_span_emit', 0);
record('set_sib_fusion', 0);
record('set_store_span_fusion', 0);
record('set_x87_pipeline4_fusion', 0);
record('set_rect_run', 0);
record('set_case_chain', 0);
record('set_rle_run', 0);
record('set_cs_steal_after', 37);
record('set_fault_unmapped', 2);
record('set_callstack_enabled', 1);
record('set_trace_eip_range', 1, 0x402000, 0x403000);
assert.strictEqual(recordInheritedWasmGlobal(configured, 'set_eip', [0x1234]), false,
  'thread-local registers must not enter the process-global table');

const manager = Object.create(ThreadManager.prototype);
manager._inheritedWasmGlobals = configured;
manager._countAddrs = [0x404000, NaN, 0x406000];
const state = manager._workerWasmGlobals({
  get_cpu_mmx: () => 0,                 // zero must survive (the --no-mmx bug)
  get_winver: () => 0xC0000A04,
  get_bp_addr: () => 0x407000,
  get_watch_size: () => 2,
  get_watch_addr: () => 0x408000,
});
const calls = inheritedWasmCalls(state);
const bySetter = new Map(calls.map(call => [call.setter, call.args]));
assert.deepStrictEqual(bySetter.get('set_cpu_mmx'), [0]);
assert.deepStrictEqual(bySetter.get('set_winver'), [0xC0000A04]);
assert.deepStrictEqual(bySetter.get('set_bp'), [0x407000]);
assert.deepStrictEqual(bySetter.get('set_watchpoint_size'), [2]);
assert.deepStrictEqual(bySetter.get('set_watchpoint'), [0x408000]);
assert.deepStrictEqual(calls.filter(call => call.setter === 'set_count'), [
  { setter: 'set_count', args: [0, 0x404000] },
  { setter: 'set_count', args: [2, 0x406000] },
], 'resolved count slots must be inherited without turning NaN into address zero');

const runOn = () => {
  const seen = [];
  const exports = Object.fromEntries(setters.map(setter => [setter,
    (...args) => seen.push({ setter, args })]));
  applyInheritedWasmGlobals(exports, state);
  return seen;
};
assert.deepStrictEqual(runOn(), runOn(),
  'cooperative and real Worker targets must receive the same ordered setter calls');
assert.deepStrictEqual(runOn(), calls,
  'the applicator must execute every table call exactly once and in table order');

const threadManagerSource = fs.readFileSync(path.join(ROOT, 'lib', 'thread-manager.js'), 'utf8');
const guestWorkerSource = fs.readFileSync(path.join(ROOT, 'lib', 'guest-worker.js'), 'utf8');
const cliSource = fs.readFileSync(path.join(ROOT, 'test', 'run.js'), 'utf8');
const browserSource = fs.readFileSync(path.join(ROOT, 'lib', 'browser-shell.js'), 'utf8');
assert(threadManagerSource.includes(
  '_applyInheritedWasmGlobals(instance.exports, this._workerWasmGlobals(main))'),
  'cooperative spawn must consume the shared inherited-global applicator');
assert(threadManagerSource.includes('wasmGlobals: this._workerWasmGlobals(main)'),
  'real Worker spawn must send the same inherited-global state');
assert(guestWorkerSource.includes(
  'workerImports.applyInheritedWasmGlobals(ex, msg.wasmGlobals)'),
  'guest Worker init must consume the shared inherited-global applicator');
assert(!/msg\.(?:bp|watch|watchSize|callstack)\b/.test(guestWorkerSource),
  'guest Worker must not retain a hand-written debug-setter subset');
assert(!cliSource.includes('_loopFlagsArmed'),
  'CLI must not patch only cooperative instances after spawn');
assert(browserSource.includes(
  "recordInheritedWasmGlobal('set_loop_copy_emit', 1)"),
  'browser app decoder configuration must be recorded for future threads');
assert(browserSource.includes("recordInheritedWasmGlobal('set_winver', app.winver)"),
  'browser version overrides must be recorded for future threads');

console.log(`PASS  ${setters.length} inherited WASM-global setters are identical across Worker backends`);
