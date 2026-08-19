#!/usr/bin/env node
// Winamp web About/Credits tab-switch rendering regression.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = path.join(ROOT, 'tools', 'profile-winamp-web.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WINAMP = path.join(ROOT, 'binaries', 'winamp.exe');

if (!fs.existsSync(CHROME)) { console.log('SKIP  Google Chrome not found'); process.exit(0); }
if (!fs.existsSync(WINAMP)) { console.log('SKIP  winamp.exe not found'); process.exit(0); }

const args = [
  PROFILE,
  '--credit-tab-wait-ms=6000',
  '--return-tab-wait-ms=3000',
];
console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));
const run = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 60000,
  maxBuffer: 64 * 1024 * 1024,
});
const output = (run.stdout || '') + (run.stderr || '');
if (run.error && run.error.code === 'ETIMEDOUT') {
  throw new Error('profile-winamp-web timed out\n' + output.slice(-4000));
}
assert.strictEqual(run.status, 0,
  'profile-winamp-web should exit cleanly\n' + output.slice(-4000));

const jsonStart = output.indexOf('{');
assert(jsonStart >= 0, 'profile output should include JSON\n' + output.slice(-4000));
const result = JSON.parse(output.slice(jsonStart));

function findActivePage(windows) {
  const outer = (windows || []).find(w => w && w.title === 'About Winamp');
  assert(outer, 'Winamp should keep its About dialog visible');
  const page = (windows || []).find(w =>
    w && w.isDialog && w.isChild && w.parentHwnd === outer.hwnd &&
    !w.title && w.w >= 400 && w.h >= 300 && w.screen);
  assert(page, 'Winamp should create a visible child page for the selected tab');
  return page;
}

const credits = findActivePage(result.creditsSnapshot);
assert(credits.screen.sampledColors > 32,
  `Credits should render to the composited screen, got ${credits.screen.sampledColors} colors`);
assert(credits.screen.sampledInk > 1000,
  `Credits should render non-background pixels, got ${credits.screen.sampledInk}`);
assert(result.workerHandlesAtCredits, 'profile should capture worker ownership on Credits');
assert.strictEqual(result.workerHandlesAtCredits.about, 0,
  'switching to Credits should join and clear the old Winamp page worker');
assert.notStrictEqual(result.workerHandlesAtCredits.credits, 0,
  'Credits should own a live rendering worker');

const about = findActivePage(result.state && result.state.visibleWindows);
assert(about.screen.sampledColors > 32,
  `Winamp should render after switching back, got ${about.screen.sampledColors} colors`);
assert(about.screen.sampledInk > 1000,
  `Winamp should render non-background pixels after switching back, got ${about.screen.sampledInk}`);
assert(result.state && result.state.workerHandles, 'profile should capture final worker ownership');
assert.notStrictEqual(result.state.workerHandles.about, 0,
  'Winamp should start a new rendering worker after switching back');
assert.strictEqual(result.state.workerHandles.credits, 0,
  'switching back should join and clear the Credits worker');

console.log(
  `PASS  Winamp About → Credits → About rendered on the composited screen ` +
  `(Credits ${credits.screen.sampledColors} colors, returned About ${about.screen.sampledColors} colors)`
);
