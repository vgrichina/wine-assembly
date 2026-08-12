#!/usr/bin/env node
'use strict';

// Application-neutral assembler and verifier for the static WAT stack-packet
// executor. Validation happens when a packet is emitted, not in its hot loop.

const REGS = Object.freeze(['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']);
const CC = Object.freeze(['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g']);
const OP = Object.freeze({
  END: 0,
  PUSH_I32: 17,
  LOAD8_U: 18,
  LOAD32: 19,
  STORE32: 20,
  ADD: 21,
  ADD_FLAGS: 22,
  SUB: 23,
  SUB_FLAGS: 24,
  AND_FLAGS: 25,
  SHL: 26,
  SHR_U_FLAGS: 27,
  JMP: 28,
  JCC: 29,
  CMP_JCC: 30,
  CMP_RM32_JCC: 31,
});

const EFFECT = Object.freeze({
  LOAD8_U: [1, 1],
  LOAD32: [1, 1],
  STORE32: [2, 0],
  ADD: [2, 1],
  ADD_FLAGS: [2, 1],
  SUB: [2, 1],
  SUB_FLAGS: [2, 1],
  AND_FLAGS: [2, 1],
  SHL: [2, 1],
  SHR_U_FLAGS: [2, 1],
  JMP: [1, 0],
  JCC: [0, 0],
  CMP_JCC: [2, 0],
  CMP_RM32_JCC: [0, 0],
  END: [0, 0],
});

function enumIndex(values, value, label) {
  const index = Number.isInteger(value) ? value : values.indexOf(value);
  if (index < 0 || index >= values.length) throw new Error(`invalid ${label}: ${value}`);
  return index;
}

function word(value, label) {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value >>> 0;
}

function assemble(items, options = {}) {
  const maxAllowedDepth = options.maxStackDepth === undefined ? 4 : options.maxStackDepth;
  const words = [];
  let depth = 0;
  let maxStackDepth = 0;
  let terminal = false;

  for (let index = 0; index < items.length; index++) {
    if (terminal) throw new Error(`operation after terminal at item ${index}`);
    const item = items[index];
    const name = typeof item === 'string' ? item : item.op;

    if (name === 'PUSH_REG' || name === 'POP_REG') {
      const reg = enumIndex(REGS, item.reg, 'register');
      words.push((name === 'PUSH_REG' ? 1 : 9) + reg);
      if (name === 'PUSH_REG') depth++;
      else {
        if (depth < 1) throw new Error(`stack underflow at item ${index} (${name})`);
        depth--;
      }
    } else if (name === 'PUSH_I32') {
      words.push(OP.PUSH_I32, word(item.value, 'immediate'));
      depth++;
    } else {
      const opcode = OP[name];
      const effect = EFFECT[name];
      if (opcode === undefined || !effect) throw new Error(`unknown packet operation: ${name}`);
      if (depth < effect[0]) throw new Error(`stack underflow at item ${index} (${name})`);
      depth += effect[1] - effect[0];
      words.push(opcode);

      if (name === 'JCC' || name === 'CMP_JCC') {
        words.push(enumIndex(CC, item.cc, 'condition code'));
        words.push(word(item.target, 'target'), word(item.fall, 'fallthrough'));
      } else if (name === 'CMP_RM32_JCC') {
        words.push(enumIndex(REGS, item.lhs, 'lhs register'));
        words.push(enumIndex(REGS, item.base, 'base register'));
        words.push(word(item.disp || 0, 'displacement'));
        words.push(enumIndex(CC, item.cc, 'condition code'));
        words.push(word(item.target, 'target'), word(item.fall, 'fallthrough'));
      }
      terminal = name === 'END' || name === 'JMP' || name === 'JCC' ||
        name === 'CMP_JCC' || name === 'CMP_RM32_JCC';
    }

    maxStackDepth = Math.max(maxStackDepth, depth);
    if (maxStackDepth > maxAllowedDepth) {
      throw new Error(`packet stack depth ${maxStackDepth} exceeds ${maxAllowedDepth}`);
    }
  }

  if (!terminal) throw new Error('packet has no terminal operation');
  return { words, maxStackDepth, finalStackDepth: depth };
}

module.exports = { CC, OP, REGS, assemble };
