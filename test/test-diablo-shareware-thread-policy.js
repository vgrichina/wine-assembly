#!/usr/bin/env node
'use strict';

// Diablo Shareware's menu art is healthy in the cooperative browser backend
// but permanently gray in the experimental guest-Worker backend. The browser
// must make that exception local to this boot and preserve the user's global
// Threads preference for every other app, including when initialization fails.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  appRequiresCooperativeBackend,
  initWineForApp,
} = require('../lib/browser-shell.js');

async function main() {
  const pageHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert(pageHtml.includes('lib/browser-shell.js?v=7'),
    'the page should cache-bust the launcher compatibility policy');
  assert.match(pageHtml, /cooperativeCompatibilityReason[\s\S]*isolated · cooperative compatibility/,
    'the Threads status should distinguish intentional compatibility mode from startup failure');
  assert.strictEqual(appRequiresCooperativeBackend('diablo_shareware'), true,
    'Diablo Shareware should select the known-good cooperative backend');
  assert.strictEqual(appRequiresCooperativeBackend('diablo_demo'), false,
    'the earlier Diablo demo should retain the requested backend');
  assert.strictEqual(appRequiresCooperativeBackend('jazz2_demo'), false,
    'the compatibility policy must remain app-scoped');

  global.window = { WINE_THREADS: true };
  const notices = [];
  const wine = {
    init: async canvas => {
      assert.strictEqual(canvas, 'canvas');
      assert.strictEqual(window.WINE_THREADS, false,
        'Diablo init must observe cooperative execution');
    },
  };
  await initWineForApp(wine, 'canvas', 'diablo_shareware', text => notices.push(text));
  assert.strictEqual(window.WINE_THREADS, true,
    'a successful Diablo init must restore the global Threads preference');
  assert.match(wine.cooperativeCompatibilityReason, /menu artwork/i,
    'the launched instance should explain why it is cooperative');
  assert.strictEqual(notices.length, 1,
    'the launcher should surface the compatibility fallback once');

  const ordinary = {
    init: async () => assert.strictEqual(window.WINE_THREADS, true,
      'an unrelated app must retain guest-Worker execution'),
  };
  await initWineForApp(ordinary, null, 'jazz2_demo');
  assert.strictEqual(window.WINE_THREADS, true,
    'an unrelated launch must leave the preference untouched');

  const failed = { init: async () => { throw new Error('expected init failure'); } };
  await assert.rejects(
    initWineForApp(failed, null, 'diablo_shareware'),
    /expected init failure/);
  assert.strictEqual(window.WINE_THREADS, true,
    'a failed Diablo init must still restore the global Threads preference');

  console.log('PASS Diablo Shareware selects cooperative artwork compatibility without changing the Threads preference');
}

main().catch(error => { console.error(error); process.exit(1); });
