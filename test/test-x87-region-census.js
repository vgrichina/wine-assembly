#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeX87 } = require('../lib/x87-semantics');
const { decodeLinear, collectRegions, aggregate, expandInputs } = require('../tools/x87-region-census');

function x(hex, bits = 32) { return decodeX87(Buffer.from(hex, 'hex'), 0, { bits }); }

// Normalized value, stack and memory effects.
let op = x('d900'); // fld dword [eax]
assert.strictEqual(op.name, 'fld');
assert.deepStrictEqual(op.stack, { reads: [], writes: [0], pushes: 1, pops: 0, delta: 1 });
assert.deepStrictEqual([op.memory.access, op.memory.width, op.memory.format, op.memory.shape], ['read', 4, 'float32', 'base']);
assert.strictEqual(op.dependencies.rawWrite, true);
assert.strictEqual(op.barrier, null);

op = x('dec1'); // faddp st(1), st
assert.strictEqual(op.name, 'faddp');
assert.deepStrictEqual(op.stack, { reads: [0, 1], writes: [1], pushes: 0, pops: 1, delta: -1 });
assert.strictEqual(op.dependencies.controlRead, true);
assert.strictEqual(op.dependencies.statusWrite, true);
assert.strictEqual(x('dce1').name, 'fsubr');
assert.strictEqual(x('dee1').name, 'fsubrp');
assert.strictEqual(x('da20').name, 'fisub');
assert.strictEqual(x('df28').memory.format, 'int64');

// Every primary opcode/ModRM combination produces the same normalized schema,
// including forms deliberately marked unsupported by the scalar emulator.
for (let opcode = 0xd8; opcode <= 0xdf; opcode++) {
  for (let modrm = 0; modrm <= 0xff; modrm++) {
    const tail = (modrm >>> 6) === 3 ? [] : (modrm & 7) === 4 ? [0x24, 0, 0, 0, 0] : [0, 0, 0, 0];
    const decoded = decodeX87(Buffer.from([opcode, modrm, ...tail]));
    assert(decoded && decoded.length >= 2);
    assert.strictEqual(typeof decoded.name, 'string');
    assert.strictEqual(typeof decoded.supported, 'boolean');
    assert.strictEqual(typeof decoded.stack.delta, 'number');
    assert.strictEqual(typeof decoded.memory.shape, 'string');
    assert.strictEqual(typeof decoded.dependencies.statusWrite, 'boolean');
    assert(decoded.barrier === null || typeof decoded.barrier === 'string');
  }
}

// All important address forms have stable, relocation-independent shapes.
assert.strictEqual(x('d90578563412').memory.shape, 'absolute32');
assert.strictEqual(x('d944887f').memory.shape, 'sib_disp8');
assert.strictEqual(x('67d9063412').memory.shape, 'absolute16');

// Status/control/environment observations are explicit barriers, not silently
// presented to a future fusion pass as ordinary value operations.
assert.strictEqual(x('dbe3').barrier, 'environment-reset'); // fninit
assert.strictEqual(x('d92d78563412').barrier, 'control-write'); // fldcw
assert.strictEqual(x('dfe0').barrier, 'status-observe'); // fnstsw ax
assert.strictEqual(x('d9d7').barrier, 'unsupported-form');
assert.strictEqual(x('d9d7').supported, false);

// A mixed integer/x87 region is discovered at real instruction boundaries.
// fld + imul + fstp is balanced, needs no incoming x87 values and exposes its
// backwards direct branch as a visible loop edge.
const bytes = Buffer.from('d9000fafc1d91c24ebf6', 'hex');
const instructions = decodeLinear(bytes, 0, bytes.length, 0x1000);
const regions = collectRegions(instructions, { trace: true });
assert.strictEqual(regions.length, 1);
const region = regions[0];
assert.deepStrictEqual([region.x87Count, region.mixedCount, region.accepted], [2, 1, true]);
assert.deepStrictEqual(region.stack, { netDelta: 0, requiredInitialDepth: 0, maxLiveDepth: 1, balanced: true });
assert.deepStrictEqual(region.loopBackedges, [{ from: 0x1008, to: 0x1000, kind: 'direct-jump' }]);
assert.strictEqual(region.terminalBarrier, 'direct-jump');
assert.strictEqual(region.memoryShapes['read:float32:base'], 1);
assert.strictEqual(region.memoryShapes['write:float32:sib'], 1);

// Stack imbalance and an x87 semantic barrier retain specific rejection data.
let rejected = collectRegions(decodeLinear(Buffer.from('d900c3', 'hex'), 0, 3, 0x2000), { minX87: 1 });
assert.deepStrictEqual(rejected[0].rejectionReasons, ['unbalanced-stack']);
rejected = collectRegions(decodeLinear(Buffer.from('dbe3c3', 'hex'), 0, 3, 0x3000), { minX87: 1 });
assert.deepStrictEqual(rejected[0].rejectionReasons, ['x87-barrier:environment-reset']);

const summary = aggregate([{ bytes: bytes.length, instructionCount: instructions.length, regions }]);
assert.strictEqual(summary.accepted, 1);
assert.strictEqual(summary.distributions.loopBackedges, 1);
assert.strictEqual(summary.distributions.maxLiveDepth['1'], 1);
assert.deepStrictEqual(summary.acceptedShapes, [{ shape: 'fld;fstp', count: 1 }]);

// Corpus convenience links must not recurse forever or make a checkout depend
// on an optional external target.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'x87-census-'));
try {
  const fixture = path.join(temp, 'fixture.exe');
  fs.writeFileSync(fixture, Buffer.alloc(0));
  fs.symlinkSync(temp, path.join(temp, 'self'));
  fs.symlinkSync(path.join(temp, 'missing'), path.join(temp, 'optional'));
  assert.deepStrictEqual(expandInputs([temp]), [fixture]);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('x87 semantic metadata and decode-only region census tests passed');
