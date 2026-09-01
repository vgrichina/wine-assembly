#!/usr/bin/env node
// The browser half of the agent control channel (docs/design-agent-control.md):
// a real dev-server, a real Chrome tab, and the exact copy-paste connect line
// from the doc — then the session is driven from the shell through tools/ctl.js
// like an agent would. This covers the hub routes, lib/agent-remote.js's poll
// loop, and ctl.js's hub mode in one pass.
//
// PASS criteria:
//   - the pasted import()+connect() registers a session the hub lists
//   - ping round-trips through hub -> page -> hub with kind:browser
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
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#screen', { timeout: 15000 });

  // The exact copy pasta from the doc, verbatim shape.
  const sessionId = await page.evaluate(port =>
    import(`http://127.0.0.1:${port}/lib/agent-remote.js`).then(m => m.connect()), PORT);
  check('connect() registered a session', /^[0-9a-f]{8}$/.test(sessionId || ''), String(sessionId));

  const listed = ctl('sessions');
  check('hub lists the session', listed.includes(sessionId), listed.trim());

  const ping = JSON.parse(ctl('-s', sessionId, 'ping'));
  check('ping round-trips through the page', ping.pong === true && ping.kind === 'browser', JSON.stringify(ping));

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
