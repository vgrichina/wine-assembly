#!/usr/bin/env node
'use strict';

// A frozen CLI must consume no guest batches between commands. Input queues
// immediately, step owns the exact execution budget, and inspection does not
// resume the machine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'xp', 'winmine.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winmine.exe not found at ' + EXE);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'control-stdin-frozen-'));
const pngA = path.join(tmp, 'paused-a.png');
const pngB = path.join(tmp, 'paused-b.png');
const child = spawn('node', [
  RUN,
  '--exe=' + EXE,
  '--control-stdin',
  '--frozen',
  '--max-seconds=20',
  '--quiet-api',
  '--quiet-blocks',
  '--no-build',
], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let output = '';
let lineBuf = '';
let nextId = 1;
const pending = new Map();
const exited = new Promise(resolve => child.on('exit', code => resolve(code)));

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
    if (reply.ok) waiter.resolve(reply.value);
    else waiter.reject(new Error(reply.error || 'control command failed'));
  }
}

child.stdout.on('data', onData);
child.stderr.on('data', data => { output += data; });
child.on('exit', code => {
  for (const [id, waiter] of pending) {
    waiter.reject(new Error('run.js exited before replying to ' + id + ' (exit ' + code + ')'));
  }
  pending.clear();
});

function send(command) {
  const id = 'f' + nextId++;
  const payload = typeof command === 'string' ? { id, cmd: command } : Object.assign({ id }, command);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify(payload) + '\n', error => {
      if (!error) return;
      pending.delete(id);
      reject(error);
    });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const before = await send({ action: 'snapshot' });
  assert.strictEqual(before.frozen, true);
  assert.strictEqual(before.batch, 0);
  await sleep(400);
  const still = await send({ action: 'snapshot' });
  assert.strictEqual(still.batch, before.batch, 'a frozen CLI advanced batches while idle');
  assert.strictEqual(still.eip, before.eip, 'a frozen CLI changed EIP while idle');

  const queued = await send('keypress:65');
  assert.strictEqual(queued.frozen, true);
  assert.strictEqual(queued.queued, 1);
  const stepped = await send('step 8');
  assert.strictEqual(stepped.frozen, true);
  assert.strictEqual(stepped.ran, 8);
  assert.strictEqual(stepped.steps, 8);

  const after = await send({ action: 'snapshot' });
  await sleep(400);
  const paused = await send({ action: 'snapshot' });
  assert.strictEqual(paused.batch, after.batch, 'CLI did not pause after exhausting step budget');
  assert.strictEqual(paused.eip, after.eip, 'EIP changed after exhausting step budget');

  const firstPng = await send('png:' + pngA);
  await sleep(250);
  const secondPng = await send({ action: 'png', path: pngB });
  assert(firstPng.bytes > 100 && secondPng.bytes > 100, 'paused PNG capture returned no image');
  assert(fs.readFileSync(pngA).equals(fs.readFileSync(pngB)),
    'paused PNG changed without a guest step');

  const quit = await send({ action: 'quit' });
  assert.strictEqual(quit.quitting, true);
  child.stdin.end();
  const code = await exited;
  assert.strictEqual(code, 0, 'frozen CLI exited ' + code + '\n' + output.slice(-3000));
  assert(/Stats: \d+ API calls, 8 batches/.test(output),
    'frozen CLI did not report exactly eight batches\n' + output.slice(-3000));

  const bounded = spawn('node', [
    RUN,
    '--exe=' + EXE,
    '--control-stdin',
    '--frozen',
    '--max-seconds=0.25',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let boundedOutput = '';
  bounded.stdout.on('data', data => { boundedOutput += data; });
  bounded.stderr.on('data', data => { boundedOutput += data; });
  const boundedCode = await new Promise(resolve => bounded.on('exit', resolve));
  assert.strictEqual(boundedCode, 0, 'self-bounded frozen CLI exited ' + boundedCode);
  assert(/\[max-seconds\].*batch 0/.test(boundedOutput),
    'max-seconds did not wake a frozen CLI\n' + boundedOutput.slice(-2000));
  assert(/Stats: \d+ API calls, 0 batches/.test(boundedOutput),
    'idle frozen CLI unexpectedly executed a batch\n' + boundedOutput.slice(-2000));
  console.log('PASS  CLI frozen stdin control pauses and steps exactly');
})().catch(async error => {
  console.error(error.stack || error);
  try {
    if (child.exitCode === null) {
      await send({ action: 'quit' });
      child.stdin.end();
      await exited;
    }
  } catch (_) {}
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
