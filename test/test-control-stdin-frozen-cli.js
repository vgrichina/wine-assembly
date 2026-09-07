#!/usr/bin/env node
'use strict';

// A frozen CLI must consume no guest batches between commands. Input queues
// immediately, step owns the exact execution budget, and inspection does not
// resume the machine.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlSession } = require('./control-session');

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
const session = startControlSession([
  RUN,
  '--exe=' + EXE,
  '--control-stdin',
  '--frozen',
  '--max-seconds=20',
  '--quiet-api',
  '--quiet-blocks',
  '--no-build',
], { cwd: ROOT, idPrefix: 'f' });
const { child, exited, send } = session;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const before = await send({ action: 'snapshot' });
  assert.strictEqual(before.frozen.frozen, true);
  assert.strictEqual(before.batch, 0);
  await sleep(400);
  const still = await send({ action: 'snapshot' });
  assert.strictEqual(still.batch, before.batch, 'a frozen CLI advanced batches while idle');
  assert.strictEqual(still.eip, before.eip, 'a frozen CLI changed EIP while idle');

  const queued = await send('keypress:65');
  assert.strictEqual(queued.queued, true);
  const injected = await send({
    action: 'input-message', hwnd: 0, msg: 0, wParam: 0, lParam: 0,
  });
  assert.strictEqual(injected.queued, true);
  assert.strictEqual(injected.msg, 0);
  const injectedAgain = await send({
    action: 'input-message', hwnd: 0, msg: 0, wParam: 1, lParam: 2,
  });
  assert.strictEqual(injectedAgain.queued, true,
    'stdio messages should post independently without a pending-input stall');
  const stepped = await send('step 8');
  assert.strictEqual(stepped.frozen, true);
  assert.strictEqual(stepped.ran, 8);
  assert.strictEqual(stepped.steps, 8);

  const streamedA = send({ action: 'step', n: 2 });
  const streamedB = send({ action: 'step', n: 2 });
  const streamed = await Promise.all([streamedA, streamedB]);
  assert.deepStrictEqual(streamed.map(result => result.ran), [2, 2],
    'stdio commands arriving together must execute in stream order');

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
  assert.strictEqual(code, 0,
    'frozen CLI exited ' + code + '\n' + session.output().slice(-3000));
  assert(/Stats: \d+ API calls, 12 batches/.test(session.output()),
    'frozen CLI did not report exactly twelve batches\n' + session.output().slice(-3000));

  const bounded = startControlSession([
    RUN,
    '--exe=' + EXE,
    '--control-stdin',
    '--frozen',
    '--max-seconds=0.25',
    '--quiet-api',
    '--quiet-blocks',
    '--no-build',
  ], { cwd: ROOT, idPrefix: 'b' });
  await sleep(400);
  const boundedStill = await bounded.send({ action: 'snapshot' });
  assert.strictEqual(boundedStill.batch, 0,
    'idle frozen CLI advanced while its active-time guard was paused');
  await bounded.send({ action: 'quit' });
  bounded.child.stdin.end();
  const boundedCode = await bounded.exited;
  assert.strictEqual(boundedCode, 0, 'self-bounded frozen CLI exited ' + boundedCode);
  assert(!/\[max-seconds\]/.test(bounded.output()),
    'max-seconds counted frozen wait time\n' + bounded.output().slice(-2000));
  assert(/Stats: \d+ API calls, 0 batches/.test(bounded.output()),
    'idle frozen CLI unexpectedly executed a batch\n' + bounded.output().slice(-2000));
  console.log('PASS  CLI frozen stdin control pauses and steps exactly');
})().catch(async error => {
  console.error(error.stack || error);
  try {
    await session.quit();
  } catch (_) {}
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
