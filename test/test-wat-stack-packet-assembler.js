#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { assemble } = require('../tools/wat-stack-packet');

const packet = assemble([
  { op: 'PUSH_REG', reg: 'edi' },
  { op: 'POP_REG', reg: 'edx' },
  { op: 'PUSH_REG', reg: 'edx' },
  { op: 'PUSH_REG', reg: 'ecx' },
  { op: 'ADD' },
  { op: 'POP_REG', reg: 'edx' },
  {
    op: 'CMP_RM32_JCC', lhs: 'edx', base: 'ebx', disp: 8, cc: 'l',
    target: 0x00535e7c, fall: 0x00535e12,
  },
]);

assert.deepStrictEqual(packet, {
  words: [8, 11, 3, 2, 21, 11, 31, 2, 3, 8, 12, 0x00535e7c, 0x00535e12],
  maxStackDepth: 2,
  finalStackDepth: 0,
});

assert.throws(() => assemble([{ op: 'ADD' }, { op: 'END' }]), /underflow/);
assert.throws(() => assemble([
  { op: 'PUSH_I32', value: 1 }, { op: 'PUSH_I32', value: 2 },
  { op: 'PUSH_I32', value: 3 }, { op: 'END' },
], { maxStackDepth: 2 }), /exceeds 2/);
assert.throws(() => assemble([{ op: 'PUSH_REG', reg: 'r8' }, { op: 'END' }]), /invalid register/);
assert.throws(() => assemble([{ op: 'PUSH_I32', value: 1 }]), /no terminal/);

console.log('PASS  generic WAT stack-packet assembler validates and encodes packets');
