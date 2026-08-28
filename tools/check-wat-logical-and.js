#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const BOOL_OPS = new Set([
  'i32.eq', 'i32.eqz', 'i32.ne',
  'i32.lt_s', 'i32.lt_u', 'i32.le_s', 'i32.le_u',
  'i32.gt_s', 'i32.gt_u', 'i32.ge_s', 'i32.ge_u',
]);

function stripComments(source) {
  source = source.replace(/;;[^\n]*/g, match => ' '.repeat(match.length));
  let depth = 0;
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith('(;', i)) {
      depth++;
      out += '  ';
      i++;
    } else if (depth && source.startsWith(';)', i)) {
      depth--;
      out += '  ';
      i++;
    } else if (depth) {
      out += source[i] === '\n' ? '\n' : ' ';
    } else {
      out += source[i];
    }
  }
  return out;
}

function parse(source) {
  const clean = stripComments(source);
  const roots = [];
  const stack = [];
  let line = 1;
  for (let i = 0; i < clean.length;) {
    const ch = clean[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(') {
      const node = { items: [], line, parent: stack.at(-1) || null };
      if (node.parent) node.parent.items.push(node); else roots.push(node);
      stack.push(node);
      i++;
      continue;
    }
    if (ch === ')') { stack.pop(); i++; continue; }
    if (ch === '"') {
      let value = ch;
      i++;
      while (i < clean.length) {
        value += clean[i];
        if (clean[i] === '\\') {
          if (i + 1 < clean.length) value += clean[++i];
        } else if (clean[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      if (stack.length) stack.at(-1).items.push(value);
      continue;
    }
    let end = i + 1;
    while (end < clean.length && !/[\s()]/.test(clean[end])) end++;
    if (stack.length) stack.at(-1).items.push(clean.slice(i, end));
    i = end;
  }
  return roots;
}

const op = node => node && typeof node !== 'string' ? node.items[0] : '';
const args = node => node.items.slice(1).filter(item =>
  typeof item !== 'string' || !item.startsWith('$'));

function isBoolean(node) {
  if (!node || typeof node === 'string') return false;
  const name = op(node);
  if (BOOL_OPS.has(name)) return true;
  if (name === 'i32.and' || name === 'i32.or' || name === 'i32.xor') {
    const operands = args(node);
    return operands.length === 2 && operands.every(isBoolean);
  }
  return false;
}

function isConstOperand(node) {
  return node && typeof node !== 'string' && op(node) === 'i32.const';
}

function isNormalizedByParent(node) {
  const parent = node.parent;
  if (!parent) return false;
  const name = op(parent);
  if (name === 'i32.eqz') return true;
  if (name === 'i32.eq' || name === 'i32.ne') {
    return args(parent).some(item => isConstOperand(item) && item.items[1] === '0');
  }
  return false;
}

function isCondition(node) {
  const parent = node.parent;
  if (!parent) return false;
  const name = op(parent);
  if (name === 'if' || name === 'br_if') return true;
  if (name === 'select') return args(parent).at(-1) === node;
  return false;
}

// A few values are deliberately stored as canonical 0/1 booleans before the
// conjunction. Keeping this list short is preferable to pretending WAT has a
// boolean type: every raw pointer/count/mask must be normalized at its use.
const CANONICAL_BOOL_LOCALS = new Set([
  '$before31', '$handled', '$has_alpha', '$include_save', '$input_guest',
  '$is_child', '$is_paint', '$is_storage', '$moved', '$numeric', '$ok', '$popup', '$take',
  '$windowed', '$wide', '$write',
]);

const RAW_NAME = /(?:ptr|(?:^|_)p$|wa$|ga$|hwnd|entry|record|rec$|data|bmi|points|pixels|buffer|formats|requested|buttons|count|size|class|parent|child|runs|list|iface|old|out|focus)/;

function isCanonicalBoolLocal(node) {
  return node && typeof node !== 'string' && op(node) === 'local.get' &&
    CANONICAL_BOOL_LOCALS.has(node.items[1]);
}

function isCanonicalBoolCall(node) {
  return node && typeof node !== 'string' && op(node) === 'call' &&
    /(?:_is_|_has_|_contains|_descendant|_outline$|_button_rect$)/.test(node.items[1] || '');
}

function looksRaw(node) {
  if (!node || typeof node === 'string') return false;
  const name = op(node);
  if (name === 'local.get' || name === 'global.get' || name === 'call') {
    return RAW_NAME.test(node.items[1] || '');
  }
  if (name === 'i32.load' || name.startsWith('i32.load')) return true;
  if (name === 'i32.and' && args(node).some(isConstOperand)) {
    const constant = args(node).find(isConstOperand);
    return Number(constant.items[1]) !== 1;
  }
  return false;
}

// These generic arg names carry no type information, so retain explicit
// signatures for the reviewed bugs that would otherwise evade the heuristic.
const REVIEWED_RAW_ANDS = [
  ['09a-handlers.wat', '(local.set $long (i32.and (local.get $arg1) (i32.const 2)))'],
  ['09b-dispatch.wat', '(i32.and (local.get $arg0) (i32.load offset=4'],
  ['09a8-handlers-directx.wat', '(i32.and (local.get $entry) (local.get $arg1))'],
  ['09a6-handlers-crt.wat', '(i32.and (local.get $arg0) (local.get $arg1))'],
  ['09a7b-ole.wat', '(i32.and (local.get $arg4) (local.get $out))'],
];

const violations = [];
for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.wat')).sort()) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  const flat = stripComments(source).replace(/\s+/g, ' ');
  for (const [target, signature] of REVIEWED_RAW_ANDS) {
    if (file === target && flat.includes(signature)) violations.push(`${file}:reviewed-signature`);
  }
  const visit = node => {
    if (!node || typeof node === 'string') return;
    if (op(node) === 'i32.and' && !isNormalizedByParent(node)) {
      const operands = args(node);
      if (operands.length === 2 && !operands.some(isConstOperand)) {
        const bools = operands.map(item =>
          isBoolean(item) || isCanonicalBoolLocal(item) || isCanonicalBoolCall(item));
        const mixed = bools[0] !== bools[1];
        const rawCondition = isCondition(node) && !bools[0] && !bools[1];
        const rawMixed = mixed && operands.some((item, index) => !bools[index] && looksRaw(item));
        const rawPair = rawCondition && operands.every(looksRaw);
        if (rawMixed || rawPair) violations.push(`${file}:${node.line}`);
      }
    }
    for (const child of node.items) visit(child);
  };
  for (const root of parse(source)) visit(root);
}

if (violations.length) {
  console.error('Raw-value logical i32.and operands must be normalized to 0/1:');
  for (const where of violations) console.error(`  ${where}`);
  process.exit(1);
}

console.log('PASS  WAT logical i32.and operands are boolean-normalized');
