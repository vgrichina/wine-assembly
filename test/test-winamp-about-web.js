#!/usr/bin/env node
// Winamp web About/Credits rendering regression.
//
// Both pages are initialized on guest worker threads. Worker WebAssembly
// instances must recover the executable's resource-directory RVA so bitmap
// resources load instead of falling back to opaque black surfaces.

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

function profileTab(tab, waitMs) {
  const args = [
    PROFILE,
    '--about-menu',
    `--about-tab=${tab}`,
    `--about-wait-ms=${waitMs}`,
  ];
  console.log('$ node', args.map(a => a.replace(ROOT, '.')).join(' '));

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = (run.stdout || '') + (run.stderr || '');
  if (run.error && run.error.code === 'ETIMEDOUT') {
    throw new Error(`profile-winamp-web timed out for ${tab}\n` + output.slice(-4000));
  }
  assert.strictEqual(run.status, 0,
    `profile-winamp-web should exit cleanly for ${tab}\n` + output.slice(-4000));

  const jsonStart = output.indexOf('{');
  assert(jsonStart >= 0, `profile output should include JSON for ${tab}\n` + output.slice(-4000));
  return JSON.parse(output.slice(jsonStart));
}

function findAboutPage(windows) {
  return (windows || []).find(w =>
    w && w.isDialog && !w.title && w.w >= 400 && w.h >= 300 && w.back);
}

const aboutResult = profileTab('winamp', 2500);
const about = findAboutPage(aboutResult.visibleWindows);
assert(about, 'Winamp should create a visible About child page');
assert(about.back.sampledColors > 32,
  `About should render the Winamp bitmap, got ${about.back.sampledColors} colors`);
assert(about.back.sampledInk > 1000,
  `About should render non-background pixels, got ${about.back.sampledInk}`);

const creditsResult = profileTab('credits', 8000);
const credits = findAboutPage(creditsResult.visibleWindows);
assert(credits, 'Credits should create a visible child page');
assert(credits.back.sampledColors > 32,
  `Credits should render a textured frame, got ${credits.back.sampledColors} colors`);
assert(credits.back.sampledInk > 1000,
  `Credits should render non-background pixels, got ${credits.back.sampledInk}`);

console.log(
  `PASS  Winamp About/Credits rendered ` +
  `(About ${about.back.sampledColors} colors, Credits ${credits.back.sampledColors} colors)`
);
