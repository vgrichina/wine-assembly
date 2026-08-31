#!/usr/bin/env node

'use strict';

// Constants on the WAT/JavaScript seam are part of one ABI even though the
// languages cannot import them from each other. A stale copy still compiles;
// it just reads another fixed table, translates guest pointers to the wrong
// bytes, or encodes a GPU command with the wrong payload length. Keep the WAT
// declarations authoritative and make every JavaScript copy prove it agrees.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function number(text) {
  return Number.parseInt(text.trim(), /^-?0x/i.test(text.trim()) ? 16 : 10) >>> 0;
}

function one(text, re, label) {
  const match = text.match(re);
  assert(match, `cannot find ${label}`);
  return number(match[1]);
}

function all(text, re, label) {
  const values = [...text.matchAll(re)].map(match => number(match[1]));
  assert(values.length, `cannot find ${label}`);
  return values;
}

// The WAT side of the seam, read through tools/wat-globals.js so that a mirror
// spelled `(region.addr $R 0)` resolves to the same number a literal one did.
// Since wave 3 most of these mirrors are symbolic — a literal mirror pins its
// region — and a regex for `i32.const` would simply stop finding them.
const watGlobals = require('./wat-globals.js').collect();
function watGlobal(relative, name) {
  const g = watGlobals.get(name);
  assert(g, `$${name} (expected in ${relative})`);
  assert(g.file === path.basename(relative),
    `$${name} moved to src/${g.file}; this gate expected ${relative}`);
  return g.value >>> 0;
}

function jsConst(relative, name) {
  return one(source(relative),
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*(0x[0-9a-f]+|[0-9]+)`, 'i'),
    `${name} in ${relative}`);
}

function equal(actual, expected, label) {
  assert.strictEqual(actual >>> 0, expected >>> 0,
    `${label}: JS 0x${(actual >>> 0).toString(16)} != WAT 0x${(expected >>> 0).toString(16)}`);
}

function everyEqual(values, expected, label) {
  for (const [index, value] of values.entries()) equal(value, expected, `${label} #${index + 1}`);
}

const header = 'src/01-header.wat';
const directx = 'src/09a8-handlers-directx.wat';
const win16 = 'src/08c-ne-loader.wat';

const guestBase = watGlobal(header, 'GUEST_BASE');
const syncTable = watGlobal(header, 'SYNC_TABLE');
const threadRpc = watGlobal(header, 'THREAD_RPC');
const dxBase = watGlobal(directx, 'DX_OBJECTS');
const dxSize = watGlobal(directx, 'DX_OBJECTS_SIZE');
const dxSlots = watGlobal(directx, 'DX_MAX');
const win16DynamicBase = watGlobal(win16, 'WIN16_DYNAMIC_BASE');

assert.strictEqual(dxSize % dxSlots, 0, '$DX_OBJECTS_SIZE must divide evenly into $DX_MAX slots');
const dxStride = dxSize / dxSlots;

const memUtils = require('../lib/mem-utils');
const guestRpc = require('../lib/guest-rpc');
equal(memUtils.GUEST_BASE, guestBase, 'lib/mem-utils.js GUEST_BASE');
equal(guestRpc.RPC_BASE, threadRpc, 'lib/guest-rpc.js RPC_BASE');
equal(guestRpc.SYNC_TABLE, syncTable, 'lib/guest-rpc.js SYNC_TABLE');

equal(jsConst('lib/host-imports.js', 'DX_OBJECTS_WA'), dxBase,
  'lib/host-imports.js DX_OBJECTS_WA');
equal(jsConst('lib/host-imports.js', 'DX_ENTRY_SIZE'), dxStride,
  'lib/host-imports.js DX_ENTRY_SIZE');
equal(jsConst('lib/host-imports.js', 'DX_SLOT_COUNT'), dxSlots,
  'lib/host-imports.js DX_SLOT_COUNT');

// test/run.js's copy of $DX_OBJECTS is GONE: d28979b2 pointed it at
// lib/region-map.generated.js, which is generated from src/00-regions.wat, so
// there is nothing left for a regex to police (docs/watx-region-safety-design.md
// §6 — a conversion deletes its clause). What is still hand-typed there is the
// SLOT COUNT and the entry STRIDE, neither of which the mirror carries, so
// those two are what this checks. The `RegionMap.BASE.DX_OBJECTS` requirement
// is asserted positively so a future edit cannot quietly retype the address.
const runSource = source('test/run.js');
assert(/RegionMap\.BASE\.DX_OBJECTS/.test(runSource),
  'test/run.js no longer reads $DX_OBJECTS from lib/region-map.generated.js; ' +
  'it must not retype the base');
assert(!/\bconst\s+DX_BASE\s*=\s*(?:0x[0-9a-f]+|[0-9]+)/i.test(runSource),
  'test/run.js has grown a literal DX_BASE again; read RegionMap.BASE.DX_OBJECTS');
everyEqual(all(runSource, /\bconst\s+DX_SLOTS\s*=\s*(0x[0-9a-f]+|[0-9]+)/gi,
  'DX_SLOTS copies in test/run.js'), dxSlots, 'test/run.js DX_SLOTS');
equal(one(runSource, /\bif\s*\(slot\s*>=\s*(0x[0-9a-f]+|[0-9]+)\)/i,
  'dxLookupThis slot bound in test/run.js'), dxSlots, 'test/run.js dxLookupThis slot bound');
const runDxEntry = runSource.match(
  /\bconst\s+entry\s*=\s*RegionMap\.BASE\.DX_OBJECTS\s*\+\s*slot\s*\*\s*(0x[0-9a-f]+|[0-9]+)/i);
assert(runDxEntry, 'cannot find dxLookupThis entry calculation in test/run.js');
equal(number(runDxEntry[1]), dxStride, 'test/run.js dxLookupThis stride');

equal(jsConst('lib/dll-loader.js', 'WIN16_DYNAMIC_BASE'), win16DynamicBase,
  'lib/dll-loader.js WIN16_DYNAMIC_BASE');

// The Worker and cooperative scheduler each translate saved guest addresses.
// These patterns deliberately name every copy: if the surrounding code moves,
// the gate asks the editor to re-establish the invariant instead of silently
// dropping coverage.
const guestWorker = source('lib/guest-worker.js');
equal(one(guestWorker, /msg\.imageBase\s*\|\s*0\)\s*\+\s*(0x[0-9a-f]+|[0-9]+)/i,
  'message g2w offset in lib/guest-worker.js'), guestBase,
  'lib/guest-worker.js message g2w offset');
equal(one(guestWorker, /prev\s*-\s*imageBase\s*\+\s*(0x[0-9a-f]+|[0-9]+)/i,
  'stack g2w offset in lib/guest-worker.js'), guestBase,
  'lib/guest-worker.js stack g2w offset');

const threadManager = source('lib/thread-manager.js');
equal(one(threadManager, /prev\s*-\s*imageBase\s*\+\s*(0x[0-9a-f]+|[0-9]+)/i,
  'stack g2w offset in lib/thread-manager.js'), guestBase,
  'lib/thread-manager.js stack g2w offset');
equal(one(threadManager, /\bconst\s+g2wOff\s*=\s*(0x[0-9a-f]+|[0-9]+)\s*-\s*e\.get_image_base/i,
  'g2wOff in lib/thread-manager.js'), guestBase, 'lib/thread-manager.js g2wOff');
equal(one(threadManager, /csWa\s*-\s*(0x[0-9a-f]+|[0-9]+)\s*\+\s*\(e\.get_image_base/i,
  'critical-section guest offset in lib/thread-manager.js'), guestBase,
  'lib/thread-manager.js critical-section guest offset');

// OpenProcess handles are produced in WAT and interpreted by the scheduler.
// They are not a memory-map global, so derive the tag from the producer body.
const handlers = source('src/09a-handlers.wat');
const openProcessBody = handlers.slice(
  handlers.indexOf('(func $handle_OpenProcess'), handlers.indexOf('(func $handle_GetTickCount'));
assert(openProcessBody.length > 0, 'cannot isolate $handle_OpenProcess');
const processTag = one(openProcessBody, /i32\.or\s+\(i32\.const\s+(0x[0-9a-f]+|[0-9]+)\)/i,
  '$handle_OpenProcess handle tag');
equal(one(threadManager,
  /&\s*0x[f]+000\)\s*===\s*(0x[0-9a-f]+|[0-9]+)/i,
  'OpenProcess handle tag in lib/thread-manager.js'), processTag,
  'lib/thread-manager.js OpenProcess handle tag');

// The generator assigns GPU opcodes in Map insertion order; the stream
// encoder indexes ARG_WORDS by that opcode. Compare the whole ordered ABI so
// an append, insertion, or corrected nargs cannot desynchronize the pair.
const generator = source('tools/gen_dispatch.js');
const mapBody = generator.slice(generator.indexOf('const gpuApis = new Map(['),
  generator.indexOf('const gpuApiOrder'));
const gpuWords = [...mapBody.matchAll(/\['[^']+'\s*,\s*([0-9]+)\]/g)]
  .map(match => number(match[1]));
assert(gpuWords.length, 'cannot parse gpuApis from tools/gen_dispatch.js');

const stream = source('lib/gl-command-stream.js');
const wordsBody = stream.slice(stream.indexOf('const ARG_WORDS = ['),
  stream.indexOf('const BARRIERS'));
const argWords = [...wordsBody.matchAll(/\b([0-9]+)\b/g)].map(match => number(match[1]));
assert.deepStrictEqual(argWords, gpuWords,
  'lib/gl-command-stream.js ARG_WORDS must match tools/gen_dispatch.js gpuApis order and word counts');

console.log(`check-wat-js-constants: OK (${dxSlots} DX slots, ${gpuWords.length} GPU opcodes)`);
