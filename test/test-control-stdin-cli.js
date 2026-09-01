#!/usr/bin/env node
// The --control-stdin live channel end to end. This keeps the CLI run
// self-bounded with --max-seconds and talks only over stdin/stdout:
// ping, poll snapshot until Notepad is visible, type into the edit control,
// capture a PNG, and quit cleanly.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-stdin-cli-'));
const pngPath = path.join(tmpDir, 'frame.png');

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};

const child = spawn('node', [
  RUN,
  `--exe=${EXE}`,
  '--control-stdin',
  '--max-seconds=45',
  '--quiet-api',
  '--quiet-blocks',
], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let output = '';
let lineBuf = '';
let nextId = 1;
const pending = new Map();
const childExit = new Promise(resolve => child.on('exit', code => resolve(code)));

function onData(data) {
  output += data;
  lineBuf += String(data);
  const lines = lineBuf.split(/\r?\n/);
  lineBuf = lines.pop() || '';
  for (const line of lines) {
    const match = line.match(/^\[ctl\] (.*)$/);
    if (!match) continue;
    let reply;
    try { reply = JSON.parse(match[1]); } catch (_) { continue; }
    const waiter = pending.get(reply.id);
    if (!waiter) continue;
    pending.delete(reply.id);
    reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error || 'control command failed'));
  }
}

child.stdout.on('data', onData);
child.stderr.on('data', d => { output += d; });
child.on('exit', code => {
  for (const [id, waiter] of pending) {
    waiter.reject(new Error(`run.js exited before replying to ${id} (exit ${code})`));
  }
  pending.clear();
});

function send(cmd) {
  const id = `s${nextId++}`;
  const payload = typeof cmd === 'string' ? { id, cmd } : { id, ...cmd };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
      if (error) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

async function typeText(text) {
  for (const ch of text) {
    const vk = /^[a-zA-Z0-9 ]$/.test(ch) ? ch.toUpperCase().charCodeAt(0) : null;
    if (vk !== null) await send(`keydown:${vk}`);
    await send(`keypress:${ch.charCodeAt(0)}`);
    if (vk !== null) await send(`keyup:${vk}`);
  }
}

async function waitFor(what, probe, ms = 45000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}; last=${JSON.stringify(last)}\n--- child output tail ---\n${output.slice(-2000)}`);
}

(async () => {
  const ping = await waitFor('ping', async () => {
    try { return await send({ action: 'ping' }); } catch (_) { return null; }
  });
  check('ping answers over stdin', ping.pong === true && /notepad/i.test(ping.app || ''), JSON.stringify(ping));

  const snap = await waitFor('a visible main window', async () => {
    const s = await send({ action: 'snapshot' });
    const main = (s.windows || []).find(w => !w.isChild && w.visible);
    return main ? s : null;
  });
  const main = snap.windows.find(w => !w.isChild && w.visible);
  check('snapshot streams over stdin', /notepad/i.test(main.title), JSON.stringify(main));

  await typeText('ok');
  const dump = await waitFor('typed text in the edit', async () => {
    const out = await send('dump-main-edit');
    const text = JSON.stringify(out);
    return /text=\\"ok\\"/.test(text) ? out : null;
  });
  check('typed text landed through stdin control', /text=\\"ok\\"/.test(JSON.stringify(dump)), JSON.stringify(dump));

  const pngOut = await send(`png:${pngPath}`);
  const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 1000;
  check('png command wrote a real file', pngOk, `${JSON.stringify(pngOut)} size=${fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0}`);

  await send({ action: 'quit' });
  child.stdin.end();
  const code = await Promise.race([
    childExit,
    new Promise(r => setTimeout(() => r('timeout'), 15000)),
  ]);
  check('quit ends the self-bounded run cleanly', code === 0, `exit=${code}`);
})().catch(error => {
  console.log('FAIL  ' + (error.stack || error.message));
  failed = true;
}).finally(async () => {
  try {
    if (child.exitCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
