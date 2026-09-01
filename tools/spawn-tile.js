#!/usr/bin/env node
// spawn-tile.js — open a private headless emulator tile on the live hub so
// seq.js features can be tested without touching any driver's session.
//
//   node spawn-tile.js 'http://127.0.0.1:8080/?app=sol&frozen=1' SECONDS
//
// Prints the page's own session id (asked via the module, not guessed from
// the hub listing), then holds the tab open for SECONDS and exits.

'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer'));

const [url, seconds] = process.argv.slice(2);
if (!url) { console.error('usage: node spawn-tile.js URL [SECONDS=120]'); process.exit(2); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const id = await page.waitForFunction(
    () => window.__agentRemote && window.__agentRemote.session, { timeout: 20000 })
    .then(h => h.jsonValue());
  console.log(`session ${id}`);
  await new Promise(r => setTimeout(r, (parseInt(seconds, 10) || 120) * 1000));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
