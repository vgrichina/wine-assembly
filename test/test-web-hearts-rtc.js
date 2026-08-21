#!/usr/bin/env node

// Two browsers, two players, one hand of Hearts over a real DataChannel.
//
//   node test/test-web-hearts-rtc.js [--timeout=420] [--headful]
//
// This is the claim the whole virtual LAN exists to support, and until now
// nothing tested it end to end. The pieces each had their own cover and none
// of them met:
//
//   test-vlan-rtc.js        the crypto and the wire contract, no browser
//   test-vlan-browser.js    two real browsers introduced by the lobby, but it
//                           stops at a hand-made frame -- no game at all
//   test-web-hearts-lan.js  the whole game, on a segment inside one page
//   test-win16-hearts-vlan.js  the whole game, across two OS processes
//
// So "two people in two browsers can play each other" was an inference from
// four tests, none of which ran a game over a peer connection. What only this
// can catch is whatever differs between a synchronous in-process broadcast and
// a real transport: ordering, timing, a frame larger than a message, a peer
// that receives while its own emulator holds the main thread.
//
// The two pages are separate browser contexts, so they carry different cookies
// and are different users to the signaling service -- two tabs in one context
// would be one user talking to itself. Only one side clicks connect: the roles
// are decided by comparing user ids, so the other must join without being
// told, and that is part of what is under test.
//
// Unlike the one-tab test, each page has its own renderer with a single
// Hearts in it, so input goes where it is aimed and nothing is covered.

'use strict';

const fs = require('fs');
const path = require('path');
const { createServer } = require('../tools/dev-server');
const H = require('./hearts-web-helper');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const OUT = path.join(ROOT, 'test', 'output', 'web-hearts-rtc');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const flag = name => process.argv.includes(`--${name}`);
const MILESTONE_MS = arg('milestone-timeout', 120) * 1000;

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch (_) {}
const CHROME = H.findChrome();
if (!fs.existsSync(EXE)) {
  console.log('SKIP  MSHEARTS.EXE not found');
  process.exit(0);
}
if (!puppeteer || !CHROME) {
  console.log('SKIP  no Chrome or no puppeteer (set CHROME=)');
  process.exit(0);
}
H.budget(arg('timeout', 420) * 1000);
H.clearPngs(OUT);

const wireOf = () => {
  const app = runningApps[0];
  const w = app && app.wine.vlanWire;
  return w ? { sent: w.sentFrames, recv: w.recvFrames, pending: w.pending } : null;
};

(async () => {
  // The dev server, not a static one: the lobby needs the signaling and auth
  // endpoints, and they are same-origin.
  const server = createServer({ quiet: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });

  const players = [];
  try {
    const open = async (label) => {
      const ctx = browser.createBrowserContext
        ? await browser.createBrowserContext()
        : await browser.createIncognitoBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 1000, height: 760, deviceScaleFactor: 1 });
      const problems = [];
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
      // Not awaited: launchApp does not resolve until the lobby is answered,
      // and the answer is a peer who has not arrived yet.
      await page.evaluate(() => {
        document.getElementById('app-select').value = 'mshearts16';
        window.__launching = launchApp();
      });
      return { label, page, ctx, problems };
    };

    const dealer = await open('dealer');
    const client = await open('client');
    players.push(dealer, client);

    // ---- the introduction ------------------------------------------------
    const peerRows = ({ page }) => page.evaluate(
      () => document.querySelectorAll('.vln-peer').length);
    for (let i = 0; i < 30 && !(await peerRows(dealer) && await peerRows(client)); i++) {
      await H.sleep(1000);
    }
    check('each browser saw the other on the segment',
      (await peerRows(dealer)) === 1 && (await peerRows(client)) === 1,
      `dealer saw ${await peerRows(dealer)}, client saw ${await peerRows(client)}`);

    const addressOf = ({ page }) => page.evaluate(
      () => (document.querySelector('.vln-addr') || {}).textContent);
    const addrDealer = await addressOf(dealer);
    const addrClient = await addressOf(client);
    check(`each claimed a room address (${addrDealer}, ${addrClient})`,
      /^10\.77\.\d+\.\d+$/.test(addrDealer || '')
      && /^10\.77\.\d+\.\d+$/.test(addrClient || '') && addrDealer !== addrClient,
      `dealer=${addrDealer} client=${addrClient}`);

    // Only the dealer clicks. The other side must connect anyway.
    await dealer.page.evaluate(() => document.querySelector('.vln-peer button').click());

    const booted = async ({ page, label }) => H.until(page,
      `${label}: never booted after the lobby`,
      () => runningApps.length > 0 && !!runningApps[0].wine.vlanWire,
      null, MILESTONE_MS);
    check('the inviting browser connected and booted Hearts', !!(await booted(dealer)),
      'the lobby never resolved');
    check('the invited browser connected without clicking', !!(await booted(client)),
      'roles are decided from user ids; this side should not need a click');

    for (const p of players) {
      const up = await H.until(p.page, `${p.label}: welcome dialog never appeared`,
        () => hasDialog(0), null, MILESTONE_MS);
      check(`${p.label} reached its welcome dialog`, !!up, 'no dialog');
    }

    // ---- the game --------------------------------------------------------
    await H.answerWelcome(dealer.page, { name: 'D', role: 'dealer' });
    const seated = await H.until(dealer.page, 'the dealer never reached its table',
      () => atTable(0), null, MILESTONE_MS);
    check('the dealer reached its table', !!seated, 'dialog still up');

    await H.answerWelcome(client.page, { name: 'C', role: 'connect' });
    const locate = await H.until(client.page, 'the "Locate dealer" box never appeared',
      () => hasDialog(0), null, MILESTONE_MS);
    check('the client was asked which computer to find', !!locate, 'no dialog');
    await H.answerLocate(client.page);

    // Each half separately: a connect that was put on the wire and never
    // answered is a different failure from one that was never sent, and over a
    // real transport either is possible.
    const asked = await H.until(client.page, 'the client never put anything on the wire',
      () => { const w = runningApps[0].wine.vlanWire; return w && w.sentFrames > 0; },
      null, MILESTONE_MS);
    check('the client put its connect on the peer connection', !!asked, 'nothing sent');
    const heard = await H.until(dealer.page, 'the dealer never received the connect',
      () => { const w = runningApps[0].wine.vlanWire; return w && w.recvFrames > 0; },
      null, MILESTONE_MS);
    check('it arrived at the other browser', !!heard, 'nothing received');
    const answered = await H.until(client.page, 'the client never heard an answer',
      () => { const w = runningApps[0].wine.vlanWire; return w && w.recvFrames > 0; },
      null, MILESTONE_MS);
    check('the dealer answered across the DataChannel', !!answered, 'no reply');

    const joined = await H.until(client.page, 'the client never reached a table',
      () => atTable(0), null, MILESTONE_MS);
    check('the client reached a table', !!joined,
      'a refused connect leaves "Unable to connect with dealer"');

    // Seating the player is a poke, a request and the advise loops that follow
    // it. Dealing in the middle of those gets the rest refused with "the game
    // is already in progress", so wait for the wire to go quiet.
    await H.until(client.page, 'the wire never settled', () => {
      const now = String(runningApps[0].wine.vlanWire.recvFrames);
      const settled = now === window.__lastWire;
      window.__lastWire = now;
      return settled;
    }, null, 30000);

    // ---- the deal --------------------------------------------------------
    const posted = await dealer.page.evaluate(
      o => postCommand(o), { index: 0, id: 102 });
    check('New Game reached the dealer', posted, 'post queue was full');

    const table = async ({ page, label }) => H.until(page, `${label}: never drew a hand`,
      () => { const t = tallyWindow({ index: 0, wantTitle: 'Hearts' }); return t && t.white > 0.1 ? t : null; },
      null, MILESTONE_MS);

    const dealerTable = await table(dealer);
    check(`the dealer has cards on its table (${dealerTable
      ? (dealerTable.white * 100).toFixed(0) : '0'}% white)`, !!dealerTable, 'nothing drawn');
    H.savePng(OUT, 'dealer-dealt', dealerTable && dealerTable.png);

    // The assertion the test exists for: a second browser, a second machine as
    // far as anything here can tell, holding thirteen cards that were dealt in
    // the first one and crossed a WebRTC DataChannel to get here.
    const clientTable = await table(client);
    check(`the other browser was dealt a hand too (${clientTable
      ? `${(clientTable.green * 100).toFixed(0)}% baize, ${(clientTable.white * 100).toFixed(0)}% cards`
      : 'nothing drawn'})`,
      !!clientTable && clientTable.green > 0.2, 'nothing drawn');
    H.savePng(OUT, 'client-dealt', clientTable && clientTable.png);

    // ---- the hand --------------------------------------------------------
    //
    // Being dealt to is the far end answering; playing is the far end taking
    // its turn. Each browser has one game in it, so there is nothing to raise
    // and nothing to disambiguate -- the clicks go where they are aimed.
    await H.passThree(dealer.page);
    await H.passThree(client.page);
    await H.sleep(4000);
    await H.click(client.page, H.PASS_BUTTON);    // accept the three passed to me
    await H.click(dealer.page, H.PASS_BUTTON);
    await H.click(client.page, H.LOWEST_CARD);    // the two of clubs opens

    const middle = ({ page, label }) => H.until(page, `${label}: no card in the middle`,
      () => {
        const t = tallyWindow({ index: 0, wantTitle: 'Hearts', box: [250, 150, 400, 300] });
        return t && t.white > 0.05 ? t : null;
      }, null, MILESTONE_MS);
    const leadHere = await middle(client);
    check(`the leading browser put a card down (${leadHere
      ? (leadHere.white * 100).toFixed(0) : '0'}% of the middle)`, !!leadHere, 'nothing led');
    H.savePng(OUT, 'client-trick', leadHere && leadHere.png);
    // The card crossed a peer connection to get here, and this is a different
    // machine as far as either game can tell.
    const leadThere = await middle(dealer);
    check(`the other browser sees the trick (${leadThere
      ? (leadThere.white * 100).toFixed(0) : '0'}% of the middle)`, !!leadThere,
      'the played card never arrived');
    H.savePng(OUT, 'dealer-trick', leadThere && leadThere.png);

    for (const p of players) {
      await p.page.screenshot({ path: path.join(OUT, `${p.label}-page.png`) });
      check(`${p.label} raised no page errors`, p.problems.length === 0,
        p.problems.join(' | '));
      console.log(`  ${p.label} wire: ${JSON.stringify(await p.page.evaluate(wireOf))}`);
    }
    console.log(`Screenshots: ${OUT}`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  console.log(`\n${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
