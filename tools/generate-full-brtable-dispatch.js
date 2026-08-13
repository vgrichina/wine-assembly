#!/usr/bin/env node
'use strict';

// Generate one br_table dispatcher by cloning the existing threaded-handler
// WAT bodies. The original handler functions remain the semantic source of
// truth; this file performs only control-flow and local-name transformation.

const fs = require('fs');
const path = require('path');
const { parseFuncSig } = require('../lib/compile-wat');
const {
  analyzeThreadedWat,
  findHandlerNames,
  loadModule,
  walk,
} = require('./analyze-threaded-wat');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'src', '05a-full-brtable.generated.wat');
const CORE_NAMES = new Set(['$auto_thread', '$auto_fn', '$auto_op']);

function watString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function print(node) {
  if (Array.isArray(node)) return `(${node.map(print).join(' ')})`;
  if (node && typeof node === 'object' && node.str !== undefined) return watString(node.str);
  return String(node);
}

function collectLabels(body, id) {
  const labels = new Map();
  for (const expression of body) walk(expression, node => {
    if ((node[0] === 'block' || node[0] === 'loop' || node[0] === 'if') &&
        typeof node[1] === 'string' && node[1].startsWith('$')) {
      if (!labels.has(node[1])) labels.set(node[1], `$auto_h${id}_${node[1].slice(1)}`);
    }
  });
  return labels;
}

function localMappings(sig, id) {
  if (sig.params.length !== 1 || sig.params[0] !== 'i32' || !sig.paramNames[0]) {
    throw new Error(`handler ${id} must have one named i32 parameter`);
  }
  const map = new Map([[sig.paramNames[0], '$auto_op']]);
  const counts = {};
  const resets = [];
  for (let i = 0; i < sig.locals.length; i++) {
    const type = sig.locals[i];
    const name = sig.localNames[i];
    if (!name) throw new Error(`handler ${id} has unnamed local ${i}`);
    const slot = counts[type] || 0;
    counts[type] = slot + 1;
    const target = `$auto_${type}_${slot}`;
    if (CORE_NAMES.has(target)) throw new Error(`reserved generated local ${target}`);
    map.set(name, target);
    const zero = type === 'i64' ? ['i64.const', '0'] : [`${type}.const`, '0'];
    resets.push(['local.set', target, zero]);
  }
  return { map, counts, resets };
}

function transformNode(node, names) {
  if (!Array.isArray(node)) {
    if (typeof node === 'string' && names.has(node)) return names.get(node);
    return node;
  }
  if (node[0] === 'return_call' && node[1] === '$next') {
    return ['br', '$auto_dispatch'];
  }
  if (node[0] === 'return') {
    if (node.length !== 1) throw new Error('threaded handler returns a value');
    return ['br', '$auto_done'];
  }
  return node.map(child => transformNode(child, names));
}

function prepareHandler(id, name, entry) {
  const bodyItems = entry.item.slice(2);
  const sig = parseFuncSig(bodyItems);
  const body = bodyItems.slice(sig.bodyStart);
  const locals = localMappings(sig, id);
  const names = new Map([...locals.map, ...collectLabels(body, id)]);
  const transformed = body.map(expression => transformNode(expression, names));
  // Falling out of a threaded handler returns through the tail-call chain and
  // ends the current block/slice. The branch is unreachable for the common
  // return_call-$next shape but required for terminal and mixed handlers.
  transformed.push(['br', '$auto_done']);
  return { id, name, ...locals, body: [...locals.resets, ...transformed] };
}

function generate() {
  const analysis = analyzeThreadedWat();
  if (analysis.blockedCount || analysis.missingCount ||
      analysis.convertibleCount !== analysis.handlerCount) {
    throw new Error(`not all handlers are structurally convertible: ${analysis.convertibleCount}/${analysis.handlerCount}`);
  }
  const module = loadModule();
  const names = findHandlerNames(module.elements);
  const handlers = names.map((name, id) => prepareHandler(id, name, module.functions.get(name)));

  const maxima = {};
  for (const handler of handlers) {
    for (const [type, count] of Object.entries(handler.counts)) {
      maxima[type] = Math.max(maxima[type] || 0, count);
    }
  }

  const out = [];
  const p = (line = '') => out.push(line);
  p('  ;; GENERATED from the canonical $th_* handler functions.');
  p('  ;; See tools/generate-full-brtable-dispatch.js.');
  p('  (func $run_x86_full_brtable_packet (param $auto_thread i32)');
  p('    (local $auto_fn i32) (local $auto_op i32)');
  for (const type of Object.keys(maxima).sort()) {
    for (let i = 0; i < maxima[type]; i++) p(`    (local $auto_${type}_${i} ${type})`);
  }
  p('    (global.set $ip (local.get $auto_thread))');
  p('    (global.set $steps (i32.const 1000))');
  p('    (block $auto_done (loop $auto_dispatch');
  p('      (global.set $steps (i32.sub (global.get $steps) (i32.const 1)))');
  p('      (br_if $auto_done (i32.le_s (global.get $steps) (i32.const 0)))');
  p('      (local.set $auto_fn (i32.load (global.get $ip)))');
  p('      (local.set $auto_op (i32.load offset=4 (global.get $ip)))');
  p('      (global.set $ip (i32.add (global.get $ip) (i32.const 8)))');
  p('      (block $auto_corrupt');
  for (let id = handlers.length - 1; id >= 0; id--) p(`        (block $auto_case_${id}`);
  const targets = handlers.map(handler => `$auto_case_${handler.id}`);
  p(`          (br_table ${targets.join(' ')} $auto_corrupt (local.get $auto_fn))`);
  for (const handler of handlers) {
    p(`        ) ;; ${handler.id}: ${handler.name}`);
    for (const expression of handler.body) p(`        ${print(expression)}`);
  }
  p('      ) ;; corrupt handler ID');
  p('      (call $host_log_i32 (i32.const 0xCAC4BAD0))');
  p('      (call $host_log_i32 (local.get $auto_fn))');
  p('      (call $host_log_i32 (global.get $eip))');
  p('      (global.set $thread_alloc (global.get $THREAD_BASE))');
  p('      (call $clear_cache)');
  p('      (br $auto_done)');
  p('    ))');
  p('  )');

  fs.writeFileSync(OUTPUT, `${out.join('\n')}\n`);
  return { handlers: handlers.length, maxima, bytes: fs.statSync(OUTPUT).size };
}

if (require.main === module) {
  const result = generate();
  console.log(`generated ${path.relative(ROOT, OUTPUT)}: ${result.handlers} handlers, ` +
    `${result.bytes} bytes, scratch=${JSON.stringify(result.maxima)}`);
}

module.exports = { generate, prepareHandler, print, transformNode };
