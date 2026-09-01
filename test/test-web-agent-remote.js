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
  // opens a visible box holding the handoff text (a silent clipboard write
  // looks identical to a broken button).
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
  check('handoff box shows ctl.js line with the tab URL',
    boxShown && boxText.includes('tools/ctl.js') && boxText.includes(wantLink), boxText);

  const title = ctl('-s', sessionId, 'eval', 'document.title');
  check('eval answers from page scope', title.trim().length > 0, JSON.stringify(title));

  const pngOut = ctl('-s', sessionId, 'png', pngPath);
  const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 500
    && fs.readFileSync(pngPath).subarray(1, 4).toString() === 'PNG';
  check('png written from the page canvas', pngOk, pngOut.trim());

  const clicked = ctl('-s', sessionId, 'click', '100,100');
  check('click executes page-side', clicked.includes('click:100:100'), clicked.trim());

  const badExit = (() => {
    try { ctl('-s', sessionId, 'cmd', 'dlg-cmd:1'); return 'no error'; }
    catch (e) { return e.status; }
  })();
  check('unsupported browser entry is rejected with exit 1', badExit === 1, `exit=${badExit}`);
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
