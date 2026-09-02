#!/usr/bin/env node
'use strict';

// The control state pointer is a discriminated union whose tag is the control
// class, not a word in the allocation. The build gate therefore has to prove
// both halves of the migration: every access names the variant chosen for its
// function, and every named layout still matches the allocation that wndproc
// really makes. These plants exercise the structural cases that a line regex
// silently missed: multiline forms and hexadecimal memarg offsets.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyzeSource } = require('../tools/control-variant-gate');

const rel = 'src/09c3-controls.wat';
const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
let checks = 0;

function check(cond, message) {
  assert.ok(cond, message);
  checks++;
}

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  check(first >= 0, `${label}: fixture exists`);
  check(text.indexOf(before, first + before.length) < 0, `${label}: fixture is unique`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function expectError(label, planted, pattern) {
  const result = analyzeSource(planted, `${label}.wat`);
  check(result.errors.some((error) => pattern.test(error)),
    `${label}: expected ${pattern}, got:\n${result.errors.join('\n')}`);
}

const baseline = analyzeSource(source, rel);
check(baseline.errors.length === 0, `live source passes: ${baseline.errors.join('\n')}`);
check(baseline.total > 500, `live source has a substantive attributed-site set (got ${baseline.total})`);

const buttonInitMatch = /        ;; Allocate ButtonState\n(        \(local\.set \$state \(call \$heap_alloc \(i32\.const (\d+)\)\)\)\n        \(local\.set \$state_w \(call \$g2w \(local\.get \$state\)\)\))/.exec(source);
check(buttonInitMatch !== null, 'found the ButtonState allocation block');
const buttonStateInit = buttonInitMatch[1];
const allocSize = Number(buttonInitMatch[2]);
const driftSize = allocSize + 4;
expectError('allocator-drift',
  replaceOnce(source, buttonStateInit,
    buttonStateInit.replace(`(i32.const ${allocSize})`, `(i32.const ${driftSize})`),
    'ButtonState allocation block'),
  new RegExp(`ButtonState allocator \\$button_wndproc requests ${driftSize} bytes.*` +
    `layout is ${allocSize} bytes`));

expectError('multiline-raw',
  replaceOnce(source, buttonStateInit, `${buttonStateInit}\n` +
    '        (drop (i32.load offset=8\n' +
    '          (local.get $state_w)))', 'ButtonState allocation block'),
  /\$button_wndproc: hand-spelled offset off a control-state base/);

expectError('hex-raw',
  replaceOnce(source, buttonStateInit, `${buttonStateInit}\n` +
    '        (drop (i32.load offset=0x8 (local.get $state_w)))',
    'ButtonState allocation block'),
  /\$button_wndproc: hand-spelled offset off a control-state base/);

const imageStore =
  '    (store.field.memarg ButtonState image_type (local.get $sw) (local.get $type))';
expectError('multiline-wrong-variant',
  replaceOnce(source, imageStore,
    '    (store.field.memarg\n' +
    '      ListBoxState\n' +
    '      count (local.get $sw) (local.get $type))', 'button image store'),
  /\$btn_set_image is attributed to ButtonState but reaches ListBoxState/);

const buttonLayoutStart = source.indexOf('  (layout ButtonState\n');
const staticComment = source.indexOf('\n\n  ;; Static (ctrl_class 3)', buttonLayoutStart);
check(buttonLayoutStart >= 0 && staticComment > buttonLayoutStart, 'found the ButtonState layout');
const buttonLayout = source.slice(buttonLayoutStart, staticComment);
const buttonLayoutClose = buttonLayout.lastIndexOf('))');
check(buttonLayoutClose >= 0, 'found the ButtonState layout closing field');
const expandedButtonLayout = buttonLayout.slice(0, buttonLayoutClose) + ')\n' +
  '    (field accidental i32))' + buttonLayout.slice(buttonLayoutClose + 2);
expectError('layout-drift',
  replaceOnce(source, buttonLayout, expandedButtonLayout, 'ButtonState layout'),
  new RegExp(`ButtonState allocator \\$button_wndproc requests ${allocSize} bytes.*` +
    `layout is ${driftSize} bytes`));

const textView =
  '  (layout ControlTextState\n' +
  '    (field text_buf_ptr i32)       ;; +0   guest ptr\n' +
  '    (field text_len     i32))      ;; +4   chars, no NUL; ends at +8';
expectError('partial-view-drift',
  replaceOnce(source, textView,
    '  (layout ControlTextState\n' +
    '    (field text_buf_ptr i32)       ;; +0   guest ptr\n' +
    '    (field text_len     u16))', 'ControlTextState layout'),
  /view ControlTextState\.text_len is not the same field at \+4 in ButtonState/);

console.log(`PASS  control variant gate (${checks} checks, ${baseline.total} live sites)`);
