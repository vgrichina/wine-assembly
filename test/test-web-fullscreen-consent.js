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
// iPhone Safari has no element Fullscreen API at all, so the approval button
// had nothing to call and did nothing. The page itself stands in for it there.
assert(html.includes('if (!request) return enterPageFullscreen();'),
  'a browser without the fullscreen API should fall back to the whole page');
assert(html.includes('function enterPageFullscreen()') && html.includes('function exitPageFullscreen(event)'),
  'the page-fullscreen fallback should be enterable and exitable');
assert(html.includes('window.exitPageFullscreen = exitPageFullscreen;'),
  'the renderer needs a way to release the page when the app leaves fullscreen');
// Only a person declines. exitPageFullscreen has two callers: the leave-full-
// screen chip, which passes its click event, and lib/renderer.js when the
// guest drops exclusive mode, which passes nothing. Latching the decline on
// the second one denies fullscreen forever to any app that releases the
// display and takes it back.
assert(html.includes('if (event) renderer._fullscreenDeclined = true;'),
  'only a user-initiated exit should latch a fullscreen decline');
assert(!/\n\s*renderer\._fullscreenDeclined = true;/.test(html),
  'the decline latch must not be reachable without a user event');
assert(html.includes('body.page-fullscreen #browser-fullscreen-consent { display: none !important; }'),
  'the consent bar is chrome and should go away in page fullscreen');
assert(html.includes('id="page-fullscreen-exit"'),
  'a phone has no Escape key, so page fullscreen needs its own exit control');
assert(html.includes('height: 100dvh;'),
  'page fullscreen must size to the visible viewport, not the taller iOS 100vh one');
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

  // Leaving guest fullscreen on a browser with no Fullscreen API: there is no
  // fullscreen element to exit, so the page-fullscreen stand-in is what has to
  // be taken down. Without this the app shrinks back into a page that is still
  // showing nothing but a canvas and an exit button.
  let released = 0;
  const releaseArgs = [];
  global.window.exitPageFullscreen = (...args) => { released++; releaseArgs.push(args); };
  renderer._requestedBrowserFullscreen = true;
  renderer._setExclusiveFullscreen(false);
  assert.deepStrictEqual(toggles, [['exclusive-fullscreen', true], ['exclusive-fullscreen', false]],
    'leaving guest fullscreen should leave dedicated-page mode');
  assert.strictEqual(released, 1, 'the page-fullscreen fallback should be released with it');
  assert.strictEqual(renderer._requestedBrowserFullscreen, false, 'the approval should not survive the exit');
  // The guest letting go of the display is not the visitor declining it, and
  // index.html tells the two apart by whether it was handed a click event. So
  // the renderer must call it with none -- passing anything here would latch
  // _fullscreenDeclined and permanently deny fullscreen to any app that drops
  // exclusive mode and takes it back (RollerCoaster Tycoon does exactly that:
  // exclusive title screen, DDSCL_NORMAL for one dialog, exclusive again for
  // the game, which then presented unscaled in the corner of the canvas).
  assert.deepStrictEqual(releaseArgs, [[]],
    'the renderer-driven release must pass no event, so it does not read as a decline');
} finally {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
  if (previousWindow === undefined) delete global.window;
  else global.window = previousWindow;
}

console.log('PASS  browser fullscreen requires explicit user consent');
