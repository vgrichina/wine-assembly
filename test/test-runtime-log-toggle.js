#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { hasPageScript } = require('./browser-runtime-scripts');

const ROOT = path.join(__dirname, '..');
const hostSource = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const consoleLines = [];
const logNodes = [];
const logElement = {
  childNodes: logNodes,
  appendChild(node) { logNodes.push(node); },
  removeChild(node) { logNodes.splice(logNodes.indexOf(node), 1); },
  scrollHeight: 12,
  scrollTop: 0,
};
const context = {
  console: { log: message => consoleLines.push(message) },
  window: { WINE_RUNTIME_LOGGING: true },
  document: {
    getElementById: id => id === 'log' ? logElement : null,
    createTextNode: text => ({ text }),
  },
};
vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);

const wine = new context.WineAssembly();
wine.logToUI('enabled');
assert.deepStrictEqual(consoleLines, ['enabled'], 'enabled runtime logging reaches the console');
assert.strictEqual(logNodes.length, 1, 'enabled runtime logging reaches the debug log pane');
assert.strictEqual(logNodes[0].text, 'enabled\n', 'the debug log preserves line boundaries');

context.window.WINE_RUNTIME_LOGGING = false;
wine.logToUI('disabled');
assert.deepStrictEqual(consoleLines, ['enabled'], 'disabled runtime logging skips the console immediately');
assert.strictEqual(logNodes.length, 1, 'disabled runtime logging skips DOM writes immediately');

context.window.WINE_RUNTIME_LOGGING = true;
wine.logToUI('restored');
assert.deepStrictEqual(consoleLines, ['enabled', 'restored'], 'runtime logging can be restored without relaunching');
assert.strictEqual(logNodes.length, 2, 'restored runtime logging resumes DOM writes');

assert(indexSource.includes('id="runtime-log-toggle"'), 'the debug toolbar exposes the runtime log checkbox');
assert(indexSource.includes('onchange="setRuntimeLogging(this.checked)"'), 'the checkbox updates logging immediately');
assert(indexSource.includes("const RUNTIME_LOG_KEY = 'wine-assembly:runtime-log'"), 'the runtime log preference has a stable storage key');
assert(indexSource.includes("localStorage.setItem(RUNTIME_LOG_KEY, on ? '1' : '0')"), 'the runtime log preference persists');
assert(indexSource.includes('window.WINE_RUNTIME_LOGGING = initialRuntimeLogging'), 'future app instances inherit the saved logging preference');
assert(hasPageScript('host.js'), 'the browser graph centrally versions host.js');
assert(indexSource.includes("window.WINE_SOURCE_VERSION = String(window.WINE_BUILD || 'dev')") &&
  hostSource.includes("static SOURCE_VERSION = String(globalThis.WINE_SOURCE_VERSION || 'dev')"),
  'the page and browser host consume the same build-info cache identity');

console.log('PASS  runtime logging checkbox gates console and DOM output immediately');
