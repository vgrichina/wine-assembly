#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createCanvas } = require('../lib/canvas-compat');
const { Win98Renderer } = require('../lib/renderer');

const renderer = new Win98Renderer(createCanvas(640, 480));
renderer.createWindow(0x20001, 0x92000000, -2, 452, 644, 30, '', 0);
renderer.setWindowClass(0x20001, 'Shell_TrayWnd');
renderer.createWindow(0x1000f, 0x92000000, 0, 0, 640, 480,
  'Program Manager', 0);
renderer.setWindowClass(0x1000f, 'Progman');

renderer.showWindow(0x20001, 5);
renderer.showWindow(0x1000f, 5);
assert(renderer.windows[0x1000f].zOrder < renderer.windows[0x20001].zOrder,
  'showing Progman after the tray must leave the desktop behind the tray');

renderer.createWindow(0x30001, 0x10c00000, 20, 20, 320, 240,
  'Application', 0);
renderer.setWindowClass(0x30001, 'OrdinaryWindow');
renderer.showWindow(0x30001, 5);
assert(renderer.windows[0x30001].zOrder > renderer.windows[0x20001].zOrder,
  'ordinary top-level windows should still raise above the shell chrome');

// Guest foreground calls may still mutate the stored number. Both visual
// composition and input routing must preserve Progman's desktop-plane role.
renderer.windows[0x1000f].zOrder = 999;
const composited = [renderer.windows[0x20001], renderer.windows[0x1000f]]
  .sort((a, b) => renderer._compareTopLevelZ(a, b));
assert.strictEqual(composited[0].hwnd, 0x1000f,
  'Progman must composite below the tray despite a newer numeric z-order');
const trayWasm = { name: 'tray' };
const desktopWasm = { name: 'desktop' };
renderer.windows[0x20001].wasm = trayWasm;
renderer.windows[0x1000f].wasm = desktopWasm;
assert.strictEqual(renderer._inputWasmAtPoint(25, 468), trayWasm,
  'taskbar coordinates must route to Shell_TrayWnd instead of Progman');

console.log('PASS  Progman remains the bottom desktop owner in renderer z-order');
