#!/usr/bin/env node
// Worker/plugin popup menus are canvas-painted in JS; they must still honor
// Win32 menu accelerators and tab-separated shortcuts.

const assert = require('assert');
const { Win98Renderer } = require('../lib/renderer');

const textCalls = [];
const ctx = {
  textAlign: 'left',
  save() {},
  restore() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  closePath() {},
  stroke() {},
  fill() {},
  fillText(text, x, y) {
    textCalls.push({ text, x, y, align: this.textAlign || 'left' });
  },
  measureText(text) {
    return { width: String(text).length * 6 };
  },
};

const renderer = new Win98Renderer({ getContext: () => ctx });

assert.deepStrictEqual(renderer._menuFormatText('&Enabled'), {
  text: 'Enabled',
  shortcut: '',
  underline: 0,
});
assert.deepStrictEqual(renderer._menuFormatText('Spectrum &Radar'), {
  text: 'Spectrum Radar',
  shortcut: '',
  underline: 9,
});
assert.deepStrictEqual(renderer._menuFormatText('E&&xit\tCtrl+X'), {
  text: 'E&xit',
  shortcut: 'Ctrl+X',
  underline: -1,
});
assert.deepStrictEqual(renderer._menuFormatText('Close Plug-in\t[Escape]'), {
  text: 'Close Plug-in',
  shortcut: '[Escape]',
  underline: -1,
});

const memory = new WebAssembly.Memory({ initial: 1 });
const bytes = new Uint8Array(memory.buffer);
let nextPtr = 32;
function putAscii(value) {
  const ptr = nextPtr;
  for (let i = 0; i < value.length; i++) bytes[ptr + i] = value.charCodeAt(i) & 0xff;
  nextPtr += value.length + 8;
  return { ptr, len: value.length };
}

const childLabels = [
  putAscii('&Enabled'),
  putAscii('Spectrum &Radar'),
  putAscii('Close Plug-in\t[Escape]'),
];
const subLabels = [
  putAscii('&Left Color'),
  putAscii('&Right Color'),
];

const menuExports = {
  menu_child_count() { return childLabels.length; },
  menu_child_flags() { return 0; },
  menu_child_label_ptr(_hwnd, _top, i) { return childLabels[i].ptr; },
  menu_child_label_len(_hwnd, _top, i) { return childLabels[i].len; },
  menu_child_shortcut_len() { return 0; },
  menu_child_sub_count(_hwnd, _top, i) { return i === 1 ? subLabels.length : 0; },
  menu_subchild_flags() { return 0; },
  menu_subchild_label_ptr(_hwnd, _top, _hover, i) { return subLabels[i].ptr; },
  menu_subchild_label_len(_hwnd, _top, _hover, i) { return subLabels[i].len; },
  menu_open_sub_hover() { return -1; },
};

renderer._menuPaintDropdownJs(ctx, menuExports, memory, 100, 0, 10, 20, 1);

const paintedText = textCalls.map(call => call.text);
assert(paintedText.includes('Enabled'), 'top-level accelerator marker should be hidden');
assert(paintedText.includes('Spectrum Radar'), 'top-level mnemonic marker should be hidden');
assert(paintedText.includes('Left Color'), 'submenu accelerator marker should be hidden');
assert(paintedText.includes('Right Color'), 'submenu accelerator marker should be hidden');
assert(textCalls.some(call => call.text === '[Escape]' && call.align === 'right'),
  'tab-separated shortcut should be right-aligned');
for (const text of paintedText) {
  assert(!/^&|[^&]&[^&]/.test(text), `unexpected raw accelerator marker in "${text}"`);
}

console.log('test-menu-popup-text: ok');
