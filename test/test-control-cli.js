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
const { spawn, execFile } = require('child_process');

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
// One wall-clock owns the whole test. The guest is independently bounded at
// 45 seconds below; this margin covers startup and orderly quit without the old
// combination of a 120-second poll deadline plus a separate 40-second ctl()
// timeout plus another 20-second quit timer.
const deadline = Date.now() + 60000;

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};

const child = spawn('node', [
  RUN,
  `--exe=${EXE}`,
  `--control=${PORT}`,
  '--max-seconds=45',
  '--quiet-api',
  '--quiet-blocks',
],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
child.stdout.on('data', d => { childOut += d; });
child.stderr.on('data', d => { childOut += d; });
let childDone = false;
let childCode;
const childExit = new Promise(resolve => child.on('exit', code => {
  childDone = true;
  childCode = code;
  resolve(code);
}));

const remainingMs = () => Math.max(1, deadline - Date.now());
const outputTail = () => childOut.slice(-2000);
const childEndedError = what => new Error(
  `child exited with ${childCode} while waiting for ${what}\n` +
  `--- child output tail ---\n${outputTail()}`);

// Async on purpose: waitFor races every ctl probe against childExit. The old
// execFileSync call hid a terminal child for up to 40 seconds at a time.
const ctl = (...args) => new Promise((resolve, reject) => {
  const probe = execFile('node', [CTL, `--port=${PORT}`, ...args], {
    encoding: 'utf-8',
    timeout: Math.min(10000, remainingMs()),
    cwd: ROOT,
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
  // Do not leave a ctl child waiting on a server that has already vanished.
  childExit.then(() => {
    if (probe.exitCode === null && !probe.killed) probe.kill('SIGTERM');
  });
});

const waitFor = async (what, probe) => {
  while (Date.now() < deadline) {
    if (childDone) throw childEndedError(what);
    const value = await Promise.race([
      Promise.resolve().then(probe),
      childExit.then(() => { throw childEndedError(what); }),
    ]);
    if (value !== undefined) return value;
    await Promise.race([
      new Promise(resolve => setTimeout(resolve, Math.min(300, remainingMs()))),
      childExit.then(() => { throw childEndedError(what); }),
    ]);
  }
  throw new Error(`timed out waiting for ${what}\n--- child output tail ---\n${outputTail()}`);
};

(async () => {
  await waitFor('control server ready line', () =>
    (childOut.includes('[control] listening') ? true : undefined));

  // The server is up before the first batch; ping proves the loop yields.
  const ping = await waitFor('ping', async () => {
    try { return JSON.parse(await ctl('ping')); } catch (_) { return undefined; }
  });
  check('ping answers', ping.pong === true && /notepad/i.test(ping.app || ''), JSON.stringify(ping));

  // Notepad needs a few batches to create its window; poll snapshot for it.
  const snap = await waitFor('a visible main window', async () => {
    const s = JSON.parse(await ctl('snapshot'));
    const main = (s.windows || []).find(w => !w.isChild && w.visible);
    return main ? s : undefined;
  });
  const main = snap.windows.find(w => !w.isChild && w.visible);
  check('snapshot shows the main window', /notepad/i.test(main.title), JSON.stringify(main));

  await ctl('type', 'hi');
  const dump = await waitFor('typed text in the edit', async () => {
    const out = await ctl('cmd', 'dump-main-edit');
    return /text="hi"/.test(out) ? out : undefined;
  });
  check('typed text landed in the edit', /text="hi"/.test(dump), dump.trim());

  const pngOut = await ctl('png', pngPath);
  const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;
  check('png written where asked', pngOk, `${pngOut.trim()} size=${fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0}`);

  const badExit = await (async () => {
    try { await ctl('cmd', 'bogus-action:1'); return 'no error'; }
    catch (e) { return e.code; }
  })();
  check('unknown action is rejected with exit 1', badExit === 1, `exit=${badExit}`);

  await ctl('quit');
  const code = await Promise.race([
    childExit,
    new Promise(resolve => setTimeout(() => resolve('timeout'), remainingMs())),
  ]);
  check('quit ends the run cleanly', code === 0, `exit=${code}`);
})().catch(error => {
  console.log('FAIL  ' + error.message);
  failed = true;
}).finally(() => {
  try { if (child.exitCode === null) child.kill('SIGTERM'); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
