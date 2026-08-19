#!/usr/bin/env node

// Two copies of Hearts in one browser tab, on the tab's own virtual LAN.
//
//   node test/test-web-hearts-lan.js [--timeout=300] [--headful] [--keep]
//
// test-win16-hearts-vlan.js proves the game across two OS processes and
// test-web-hearts-rtc.js proves it between two browsers. This is the third
// segment the same game can run on: a LoopbackSegment inside one page, which
// is what "Both players here" in the lobby gives someone who has no second
// player handy and no account. It shares no code with the other two above the
// wire -- the page has its own lobby, its own address allocation and its own
// run loop.
//
// WHY A BROWSER TEST AND NOT A CLI ONE: what is under test only exists in a
// page. test/run.js and tools/headless-run.js are the same host without a DOM,
// so neither can reach launchApp(), the lobby, or a second instance sharing
// one renderer.
//
// The two instances land on top of each other -- same guest, same window
// coordinates -- so every assertion reads the per-window back-canvas rather
// than the composited screen. A person can drag the top window aside or use
// the taskbar; a script cannot click a window that is completely covered, so
// input goes to whichever instance was launched last and the dealer's New Game
// is posted to its own message queue directly.
//
// A failure here that also fails in test-win16-hearts-vlan.js is a DDE bug and
// belongs to that test. A failure here alone is the page's: the wire it handed
// the guest, the address it claimed, or the run loop that never pumped it.

'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');
const H = require('./hearts-web-helper');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const OUT = path.join(ROOT, 'test', 'output', 'web-hearts-lan');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const flag = name => process.argv.includes(`--${name}`);
const MILESTONE_MS = arg('milestone-timeout', 90) * 1000;

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

const CHROME = H.findChrome();
if (!fs.existsSync(EXE)) {
  console.log('SKIP  MSHEARTS.EXE not found');
  process.exit(0);
}
if (!CHROME) {
  console.log('SKIP  no Chrome (set CHROME=)');
  process.exit(0);
}
H.budget(arg('timeout', 300) * 1000);
H.clearPngs(OUT);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
  '.wat': 'text/plain', '.exe': 'application/octet-stream',
};

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500);
        res.end(error.code || 'read error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launchLocal(page, label) {
  const before = await page.evaluate(() => runningApps.length);
  await page.evaluate(() => {
    document.getElementById('app-select').value = 'mshearts16';
    launchApp();
  });
  const lobby = await H.until(page, `${label}: lobby did not open`, () =>
    [...document.querySelectorAll('.vln-lobby button')]
      .some(b => b.textContent === 'Both players here'), null, MILESTONE_MS);
  if (!lobby) return null;
  await page.evaluate(() => {
    [...document.querySelectorAll('.vln-lobby button')]
      .find(b => b.textContent === 'Both players here').click();
  });
  const started = await H.until(page, `${label}: instance never started`,
    n => runningApps.length > n, before, MILESTONE_MS);
  if (!started) return null;
  const index = before;
  const up = await H.until(page, `${label}: welcome dialog never appeared`,
    i => hasDialog(i), index, MILESTONE_MS);
  return up ? index : null;
}

(async () => {
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'web-hearts-lan-'));
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', e => problems.push(String(e)));
    page.on('console', m => {
      const t = m.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|crashed|FATAL:/i.test(t)) {
        problems.push(t.slice(0, 300));
      }
    });
    await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('typeof launchApp === "function"', { timeout: 60000 });
    await H.installHelpers(page);

    // initDesktop() drops every <option> it does not also put on the desktop,
    // so an app can be fully wired in `apps` and unreachable from the page.
    // Hearts spent its whole life in that state.
    const reachable = await page.evaluate(() => ({
      option: [...document.getElementById('app-select').options].some(o => o.value === 'mshearts16'),
      icon: !!document.querySelector('.desktop-icon[data-app="mshearts16"]'),
    }));
    check('Hearts is reachable from the page (list and desktop)',
      reachable.option && reachable.icon, JSON.stringify(reachable));

    // The desktop shows each app's own icon, read out of the executable. For a
    // 16-bit NE that means the flat resource table -- until it was read, Hearts
    // sat there as the fallback emoji.
    const drawn = await H.until(page, 'the Hearts desktop icon stayed a fallback glyph', () => {
      const img = document.querySelector('.desktop-icon[data-app="mshearts16"] .icon-img img');
      return img && img.src.startsWith('data:image/png') ? img.src.length : null;
    }, null, 20000);
    check('the desktop shows Hearts\' own icon from the NE resources', !!drawn,
      'still the emoji fallback');

    // ---- the dealer ------------------------------------------------------
    const dealer = await launchLocal(page, 'dealer');
    check('the dealer launched onto the tab segment', dealer !== null, 'no welcome dialog');
    if (dealer === null) throw new Error('dealer never started');

    await H.answerWelcome(page, { name: 'D', role: 'dealer' });

    // Leaving the dialog is what puts the dealer at a table, and the table is
    // where it registers its DDE service. Until then there is nothing for the
    // other player to find.
    const seated = await H.until(page, 'the dealer never reached its table',
      i => atTable(i), dealer, MILESTONE_MS);
    check('the dealer left its welcome dialog', !!seated, 'dialog still up');

    // ---- the client ------------------------------------------------------
    const client = await launchLocal(page, 'client');
    check('a second Hearts started without stopping the first', client !== null
      && await page.evaluate(() => runningApps.length) === 2,
      'the relaunch cleanup took the dealer down');
    if (client === null) throw new Error('client never started');

    const addresses = await page.evaluate(() => wireStats());
    check(`the two instances hold different room addresses (${addresses.map(a =>
      [24, 16, 8, 0].map(s => (a.ip >>> s) & 255).join('.')).join(', ')})`,
      addresses.length === 2 && addresses[0].ip !== addresses[1].ip
      && addresses[0].ip !== 0 && addresses[1].ip !== 0,
      JSON.stringify(addresses));

    await H.answerWelcome(page, { name: 'C', role: 'connect' });

    const locate = await H.until(page, 'the "Locate dealer" box never appeared',
      i => hasDialog(i), client, MILESTONE_MS);
    check('the client was asked which computer to find', !!locate, 'no dialog');
    await H.answerLocate(page);

    // The wire is the evidence that the two instances are on one segment at
    // all. "Nothing was asked" and "nobody answered" are different bugs.
    const crossed = await H.until(page, 'no frames crossed the tab segment', () => {
      const s = runningApps.map(a => a.wine.vlanWire);
      return s.length === 2 && s.every(w => w && w.sentFrames > 0 && w.recvFrames > 0);
    }, null, MILESTONE_MS);
    check('DDE frames crossed the tab segment both ways', !!crossed,
      JSON.stringify(await page.evaluate(() => wireStats())));

    const joined = await H.until(page, 'the client never reached a table',
      i => atTable(i), client, MILESTONE_MS);
    check('the client reached a table', !!joined,
      'a refused connect leaves "Unable to connect with dealer"');

    // Seating the player is a poke, a request and the advise loops that follow
    // it; dealing in the middle of those gets the rest refused with "the game
    // is already in progress". Wait for the wire to go quiet instead of
    // guessing at a delay.
    await H.until(page, 'the wire never settled', () => {
      const now = runningApps.map(a => a.wine.vlanWire.recvFrames).join(',');
      const settled = now === window.__lastWire;
      window.__lastWire = now;
      return settled;
    }, null, 30000);
    const atDeal = await page.evaluate(() => wireStats());

    // ---- the deal --------------------------------------------------------
    const dealt = await page.evaluate(o => postCommand(o), { index: dealer, id: 102 });
    check('New Game reached the dealer', dealt, 'post queue was full');

    const dealerTable = await H.until(page, 'the dealer never drew a hand',
      i => { const t = tallyWindow({ index: i, wantTitle: 'Hearts' }); return t && t.white > 0.1 ? t : null; },
      dealer, MILESTONE_MS);
    check(`the dealer has cards on its table (${dealerTable
      ? (dealerTable.white * 100).toFixed(0) : '0'}% white)`, !!dealerTable, 'nothing drawn');
    H.savePng(OUT, 'dealer-dealt', dealerTable && dealerTable.png);

    // The assertion the whole test exists for: the other instance is looking at
    // a table with thirteen cards of its own on it, and the only place those can
    // have come from is the dealer, across the tab's segment.
    const clientTable = await H.until(page, 'the client never drew a hand',
      i => { const t = tallyWindow({ index: i, wantTitle: 'Hearts' }); return t && t.white > 0.1 ? t : null; },
      client, MILESTONE_MS);
    check(`the client was dealt a hand too (${clientTable
      ? `${(clientTable.green * 100).toFixed(0)}% baize, ${(clientTable.white * 100).toFixed(0)}% cards`
      : 'nothing drawn'})`,
      !!clientTable && clientTable.green > 0.2, 'nothing drawn');
    H.savePng(OUT, 'client-dealt', clientTable && clientTable.png);

    // Both tables are stacked at the same coordinates, so switching between
    // them is how one person actually plays this. The taskbar is the way --
    // there is no exposed edge of the covered window to click.
    const raised = await page.evaluate(index => {
      const app = runningApps[index];
      const base = (app.wine._hwndBase >>> 0) & 0xFFFF0000;
      const buttons = [...document.querySelectorAll('#task-buttons .task-btn')];
      if (buttons.length < 2) return null;
      buttons[index].click();
      const mine = Object.values(sharedRenderer.windows)
        .filter(w => w.visible && !w.isChild && ((w.hwnd >>> 0) & 0xFFFF0000) === base);
      const others = Object.values(sharedRenderer.windows)
        .filter(w => w.visible && !w.isChild && ((w.hwnd >>> 0) & 0xFFFF0000) !== base);
      const top = a => a.reduce((m, w) => Math.max(m, w.zOrder || 0), -1);
      return { buttons: buttons.length, mine: top(mine), others: top(others) };
    }, dealer);
    check('the taskbar brings the covered player to the front',
      !!raised && raised.buttons >= 2 && raised.mine > raised.others,
      JSON.stringify(raised));

    await page.screenshot({ path: path.join(OUT, 'page.png') });
    check('the page reported no errors', problems.length === 0, problems.join(' | '));

    console.log(`\nwire at the deal: ${JSON.stringify(atDeal)}`);
    console.log(`final: ${JSON.stringify(await page.evaluate(() => wireStats()))}`);
    console.log(`Screenshots: ${OUT}`);
  } finally {
    if (!flag('keep')) await browser.close();
    server.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
