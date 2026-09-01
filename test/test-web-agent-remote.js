#!/usr/bin/env node
// The browser half of the agent control channel (docs/design-agent-control.md):
// a real dev-server, a real Chrome tab, zero paste — the dev-server injects
// the auto-connect into the page it serves, and the copied tab URL is the
// session selector. Then the session is driven from the shell through
// tools/ctl.js like an agent would. This covers the injection, the hub
// routes, lib/agent-remote.js's poll loop, and ctl.js's hub + link modes.
//
// PASS criteria:
//   - the served page registers a session by itself (no console paste)
//   - the copied page URL resolves to that session and pings kind:browser
//   - the documented paste line still works and lands on the SAME session
//     (same module instance — a second connect() must not fork one)
//   - eval answers with a page-side value
//   - png hands back a data URL that ctl.js writes as a real PNG file
//   - a click command executes page-side (transport check; app-level input
//     routing has its own tests)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8098;

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for agent-remote test');
  process.exit(0);
}
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) {
  console.log('SKIP  puppeteer not installed');
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-remote-'));
const pngPath = path.join(tmpDir, 'page.png');

const ctl = (...args) => execFileSync('node', [CTL, `--hub=http://127.0.0.1:${PORT}`, ...args],
  { encoding: 'utf-8', timeout: 40000, cwd: ROOT });

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};

const server = spawn('node', [path.join(ROOT, 'tools', 'dev-server.js'), `--port=${PORT}`, '--quiet'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

let browser = null;
(async () => {
  const deadline = Date.now() + 60000;
  while (!serverOut.includes('dev server:') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (!serverOut.includes('dev server:')) throw new Error(`dev-server never came up:\n${serverOut}`);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  // ?debug so the toolbar (and its Agent handoff button) is up; the copied
  // link below deliberately omits the query, which exercises ctl.js's
  // origin+pathname match.
  await page.goto(`http://127.0.0.1:${PORT}/?debug`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#screen', { timeout: 15000 });

  // No paste: the dev-server injected the auto-connect into the page it
  // served. Wait for the session to show up on the hub by itself.
  let sessionId = null;
  const connectDeadline = Date.now() + 15000;
  while (!sessionId && Date.now() < connectDeadline) {
    const m = /^([0-9a-f]{8})\s/m.exec(ctl('sessions'));
    if (m) sessionId = m[1];
    else await new Promise(r => setTimeout(r, 300));
  }
  check('served page auto-connected (no paste)', /^[0-9a-f]{8}$/.test(sessionId || ''), ctl('sessions').trim());

  // The user's whole handoff is the tab URL: ctl resolves it to the session.
  const pageLink = `http://127.0.0.1:${PORT}/`;
  const ping = JSON.parse(ctl('-s', pageLink, 'ping'));
  check('copied page link drives the session', ping.pong === true && ping.kind === 'browser', JSON.stringify(ping));

  // The documented paste line must still work for pages served elsewhere —
  // and on this page it must land on the same module instance, not fork a
  // second session.
  const pastedId = await page.evaluate(port =>
    import(`http://127.0.0.1:${port}/lib/agent-remote.js`).then(m => m.connect()), PORT);
  check('paste line joins the same session', pastedId === sessionId, `${pastedId} vs ${sessionId}`);

  // The in-page way to get the link: the debug toolbar's Agent handoff
  // button. It is hidden until the hub session is live, and clicking it
  // reveals the inline readonly field in the toolbar holding the handoff text
  // (a silent clipboard write looks identical to a broken button).
  const revealed = await page.waitForFunction(() =>
    !document.getElementById('agent-handoff').hidden, { timeout: 10000 })
    .then(() => true).catch(() => false);
  check('Agent handoff control appears once connected', revealed, 'still hidden');
  await page.click('#agent-handoff-btn');
  const boxShown = await page.waitForFunction(() => {
    const box = document.getElementById('agent-handoff-text');
    return !box.hidden && box.value.length > 0;
  }, { timeout: 10000 }).then(() => true).catch(() => false);
  const boxText = await page.evaluate(() =>
    document.getElementById('agent-handoff-text').value);
  const wantLink = `-s 'http://127.0.0.1:${PORT}/?debug'`;
  // Embedded in the toolbar flow, not a floating box: an <input> in the
  // handoff span, so it must be one line and must sit inside #agent-handoff.
  const inline = await page.evaluate(() => {
    const box = document.getElementById('agent-handoff-text');
    return {
      tag: box.tagName, inSpan: document.getElementById('agent-handoff').contains(box),
      fixed: getComputedStyle(box).position === 'fixed',
    };
  });
  check('handoff field shows ctl.js line with the tab URL',
    boxShown && boxText.includes('tools/ctl.js') && boxText.includes(wantLink), boxText);
  check('handoff field is embedded in the toolbar, not a floating box',
    inline.tag === 'INPUT' && inline.inSpan && !inline.fixed, JSON.stringify(inline));

  // A fragment is the one URL component whose serialized form may retain a
  // literal apostrophe. The handoff is paste-ready shell, so prove a crafted
  // fragment is recovered as exactly one argv value rather than executing the
  // text between its quotes. Running only `set -- QUOTED; printf "$1"` keeps
  // this a parser probe; a broken quote makes `id` run and the comparison fail.
  await page.evaluate(() => { location.hash = "#';id;'"; });
  const crafted = await page.evaluate(() => import('./lib/agent-remote.js').then(m => ({
    href: location.href,
    handoff: m.handoffText(),
  })));
  const commandLine = crafted.handoff.split('\n').find(line => line.includes('tools/ctl.js -s '));
  const quotedArg = commandLine && /^  node tools\/ctl\.js -s (.+) snapshot$/.exec(commandLine);
  let shellValue = '';
  try {
    shellValue = quotedArg && execFileSync('/bin/sh', ['-c',
      `set -- ${quotedArg[1]}; printf '%s' "$1"`], { encoding: 'utf8' });
  } catch (error) {
    shellValue = `shell failed: ${error.message}`;
  }
  check('handoff shell-quotes apostrophes in a crafted URL fragment',
    shellValue === crafted.href, `${JSON.stringify(commandLine)} -> ${JSON.stringify(shellValue)}`);

  const title = ctl('-s', sessionId, 'eval', 'document.title');
  check('eval answers from page scope', title.trim().length > 0, JSON.stringify(title));

  const pngOut = ctl('-s', sessionId, 'png', pngPath);
  const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500
    && fs.readFileSync(pngPath).subarray(1, 4).toString() === 'PNG';
  check('png written from the page canvas', pngOk, pngOut.trim());

  const clicked = ctl('-s', sessionId, 'click', '100,100');
  check('click executes page-side', clicked.includes('click:100:100'), clicked.trim());

  // Synthetic keys used to be dispatched on `window`, whose non-Node target
  // reached shouldIgnorePageKey()'s toolbar.contains(e.target) and threw on
  // every keystroke — so browser-side type never reached the guest. Keys now
  // target the canvas; any uncaught page error here is a regression.
  const errorsBeforeType = pageErrors.length;
  ctl('-s', sessionId, 'type', 'hi');
  await new Promise(r => setTimeout(r, 500));
  check('type raises no uncaught page errors (keys target the canvas)',
    pageErrors.length === errorsBeforeType,
    pageErrors.slice(errorsBeforeType).join(' | '));

  // The agent's first input command takes the page's input away from the
  // person watching (a stray mousemove edge-scrolled Heroes II out from under
  // an agent's clicks). The toolbar checkbox mirrors it.
  const blockedState = await page.evaluate(() => ({
    blocked: !!(window.__agentRemote && window.__agentRemote.inputBlocked),
    flag: !!window.__agentInputExclusive,
    checked: document.getElementById('agent-input-toggle').checked,
  }));
  check('agent input auto-engages the user-input block',
    blockedState.blocked && blockedState.flag && blockedState.checked, JSON.stringify(blockedState));

  // A real (trusted) click from the user must not reach the canvas handlers
  // while the block is on. Puppeteer's CDP input is trusted, so this is the
  // actual condition, not a proxy for it.
  const hitPoint = await page.evaluate(() => {
    window.__testTrustedClicks = 0;
    const canvas = document.getElementById('screen');
    canvas.addEventListener('mousedown', () => { window.__testTrustedClicks++; });
    const r = canvas.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, onCanvas: top === canvas || canvas.contains(top) };
  });
  await page.mouse.click(hitPoint.x, hitPoint.y);
  const leaked = await page.evaluate(() => window.__testTrustedClicks);
  check('a trusted user click is blocked while the agent owns input',
    hitPoint.onCanvas && leaked === 0, `${leaked} reached the canvas at ${JSON.stringify(hitPoint)}`);

  const released = ctl('-s', sessionId, 'user-input', 'on');
  // Positive control: the same trusted click lands once input is handed back
  // (without it, "blocked" could just mean the click missed the canvas).
  await page.mouse.click(hitPoint.x, hitPoint.y);
  const landed = await page.evaluate(() => window.__testTrustedClicks);
  check('the same trusted click lands once input is handed back', landed > 0, `${landed} clicks seen`);
  const releasedState = await page.evaluate(() => ({
    blocked: !!(window.__agentRemote && window.__agentRemote.inputBlocked),
    flag: !!window.__agentInputExclusive,
    checked: document.getElementById('agent-input-toggle').checked,
  }));
  check('ctl user-input on hands input back to the user',
    !releasedState.blocked && !releasedState.flag && !releasedState.checked,
    `${released.trim()} ${JSON.stringify(releasedState)}`);

  const badExit = (() => {
    try { ctl('-s', sessionId, 'cmd', 'dlg-cmd:1'); return 'no error'; }
    catch (e) { return e.status; }
  })();
  check('unsupported browser entry is rejected with exit 1', badExit === 1, `exit=${badExit}`);

  // The connection URL explains itself: GET the hub root, get the protocol.
  const instructions = await new Promise((resolve, reject) => {
    require('http').get(`http://127.0.0.1:${PORT}/api/agent`, r => {
      let t = ''; r.on('data', c => { t += c; }); r.on('end', () => resolve(t));
    }).on('error', reject);
  });
  check('GET /api/agent returns protocol instructions',
    instructions.includes('tools/ctl.js') && instructions.includes('/api/agent/ctl'),
    instructions.slice(0, 120));

  // launch/apps: the shell's registry over the protocol.
  const apps = ctl('-s', sessionId, 'apps');
  check('apps lists the registry', apps.includes('sol') && apps.includes('winmine'), apps.slice(0, 120));
  const badLaunch = (() => {
    try { ctl('-s', sessionId, 'launch', 'no-such-app-zzz'); return 'no error'; }
    catch (e) { return e.status; }
  })();
  check('launch rejects an unknown app id with exit 1', badLaunch === 1, `exit=${badLaunch}`);
  const launched = ctl('-s', sessionId, 'launch', 'sol');
  const appUp = await page.waitForFunction(() =>
    window.wineShell && window.wineShell.runningApps
    && window.wineShell.runningApps.some(r => r && r.name === 'sol'), { timeout: 30000 })
    .then(() => true).catch(() => false);
  check('launch sol brings the app up', appUp, launched.trim());
})().catch(error => {
  console.log('FAIL  ' + error.message);
  failed = true;
}).finally(async () => {
  try { if (browser) await browser.close(); } catch (_) {}
  try { server.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
