#!/usr/bin/env node
// The --control live channel end to end (docs/design-agent-control.md):
// spawn run.js --control, then drive it through tools/ctl.js the way an
// agent does — ping, snapshot, type, read the text back, capture a PNG —
// and finally quit and expect a clean exit. Every command goes through the
// shipped client, so this covers ctl.js's verb mapping too.
//
// PASS criteria:
//   - ping answers {pong:true} with the app name
//   - snapshot shows a visible main window
//   - typed keypresses land in the edit control (dump-main-edit echoes them)
//   - png writes a real file where the client asked
//   - quit ends the run with exit code 0

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');
const PORT = 8199;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-cli-'));
const pngPath = path.join(tmpDir, 'frame.png');

const ctl = (...args) => execFileSync('node', [CTL, `--port=${PORT}`, ...args],
  { encoding: 'utf-8', timeout: 40000, cwd: ROOT });

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};

const child = spawn('node', [RUN, `--exe=${EXE}`, `--control=${PORT}`, '--quiet-api', '--quiet-blocks'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
child.stdout.on('data', d => { childOut += d; });
child.stderr.on('data', d => { childOut += d; });
const childExit = new Promise(resolve => child.on('exit', code => resolve(code)));

const deadline = Date.now() + 120000;
const waitFor = async (what, probe) => {
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}\n--- child output tail ---\n${childOut.slice(-2000)}`);
};

(async () => {
  await waitFor('control server ready line', () =>
    (childOut.includes('[control] listening') ? true : undefined));

  // The server is up before the first batch; ping proves the loop yields.
  const ping = await waitFor('ping', () => {
    try { return JSON.parse(ctl('ping')); } catch (_) { return undefined; }
  });
  check('ping answers', ping.pong === true && /notepad/i.test(ping.app || ''), JSON.stringify(ping));

  // Notepad needs a few batches to create its window; poll snapshot for it.
  const snap = await waitFor('a visible main window', () => {
    const s = JSON.parse(ctl('snapshot'));
    const main = (s.windows || []).find(w => !w.isChild && w.visible);
    return main ? s : undefined;
  });
  const main = snap.windows.find(w => !w.isChild && w.visible);
  check('snapshot shows the main window', /notepad/i.test(main.title), JSON.stringify(main));

  ctl('type', 'hi');
  const dump = await waitFor('typed text in the edit', () => {
    const out = ctl('cmd', 'dump-main-edit');
    return /text="hi"/.test(out) ? out : undefined;
  });
  check('typed text landed in the edit', /text="hi"/.test(dump), dump.trim());

  const pngOut = ctl('png', pngPath);
  const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;
  check('png written where asked', pngOk, `${pngOut.trim()} size=${fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0}`);

  const badExit = (() => {
    try { ctl('cmd', 'bogus-action:1'); return 'no error'; }
    catch (e) { return e.status; }
  })();
  check('unknown action is rejected with exit 1', badExit === 1, `exit=${badExit}`);

  ctl('quit');
  const code = await Promise.race([
    childExit,
    new Promise(r => setTimeout(() => r('timeout'), 20000)),
  ]);
  check('quit ends the run cleanly', code === 0, `exit=${code}`);
})().catch(error => {
  console.log('FAIL  ' + error.message);
  failed = true;
}).finally(() => {
  try { child.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
