#!/usr/bin/env node
// Browser fullscreen is optional: a guest fullscreen window owns the page,
// while only the visible approval button may invoke the browser fullscreen API.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'lib', 'renderer.js'), 'utf8');

assert(html.includes('id="browser-fullscreen-consent"'), 'exclusive page should expose a fullscreen consent control');
assert(html.includes('App is using the full page'), 'control should explain the current dedicated-page mode');
assert(html.includes('onclick="approveBrowserFullscreen(event)"'), 'browser fullscreen should require an explicit button action');
assert(html.includes('async function approveBrowserFullscreen(event)'), 'approval action should own the fullscreen request');
assert(html.includes('const request = target.requestFullscreen || target.webkitRequestFullscreen'), 'approval should support the browser fullscreen API');
assert(html.includes('body.exclusive-fullscreen #browser-fullscreen-consent { display: flex; }'), 'approval control should appear only for guest fullscreen');
assert(html.includes('#screen-wrap:fullscreen #browser-fullscreen-consent'), 'approval control should disappear after entering browser fullscreen');
assert(html.includes('order: -1;'), 'consent banner should be laid out above the canvas');
assert(html.includes('flex: 0 0 34px;'), 'consent banner should reserve its own gameplay-free row');
assert(html.includes('flex: 1 1 0;'), 'dedicated-page canvas should consume only the space below the banner');
assert(html.includes('dedicatedPage ? canvas.clientHeight : wrap.clientHeight'), 'canvas backing height should exclude the banner row');
assert(!html.includes('if (renderer._exclusiveFullscreen) requestBrowserFullscreen()'), 'canvas clicks and touches must not retry browser fullscreen');
assert(!html.includes("app.args === '/s' && !document.fullscreenElement"), 'screensavers must not force browser fullscreen at launch');
assert(!rendererSource.includes('target.requestFullscreen()'), 'renderer repaint must not request browser fullscreen');

const { Win98Renderer } = require('../lib/renderer');
const toggles = [];
let resizeCount = 0;
let requestCount = 0;
const target = { requestFullscreen() { requestCount++; } };
const previousDocument = global.document;
const previousWindow = global.window;
global.document = {
  body: { classList: { toggle(name, active) { toggles.push([name, active]); } } },
  getElementById() { return target; },
  fullscreenElement: null,
};
global.window = { resizeCanvas() { resizeCount++; } };

try {
  const renderer = new Win98Renderer({ getContext() { return {}; } });
  renderer._setExclusiveFullscreen(true);
  assert.deepStrictEqual(toggles, [['exclusive-fullscreen', true]], 'guest fullscreen should enter dedicated-page mode');
  assert.strictEqual(resizeCount, 1, 'dedicated-page mode should resize to the browser viewport');
  assert.strictEqual(requestCount, 0, 'guest fullscreen must not invoke browser fullscreen');
  assert.strictEqual(renderer._requestedBrowserFullscreen, false, 'browser fullscreen should remain unapproved');
} finally {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
  if (previousWindow === undefined) delete global.window;
  else global.window = previousWindow;
}

console.log('PASS  browser fullscreen requires explicit user consent');
