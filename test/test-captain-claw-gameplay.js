#!/usr/bin/env node
// Captain Claw from the original installer output into moving La Roca gameplay.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const INSTALLED = path.join(ROOT, 'test/binaries/candidates/captain-claw-demo/installed');
const PAYLOAD = new Map([
  ['clawdemo.exe', '16021c5b6c5566650af364edd6468f1384e19de5d0941346858d564c7a361376'],
  ['clawdemo.rez', '7e9da15bfbeca783f638e2162d2f1184046d6ef0d9c2546f811f3c65089af97c'],
  ['mss32.dll', 'cc7e8d381b21049175ff25f2f628347718df7c8070661dfb31ec4c71fc47ab85'],
]);

function hash(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function pixelStats(png) {
  let visible = 0;
  let gold = 0;
  let blue = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (r + g + b > 45) visible++;
    if (r > 145 && g > 85 && b < 70) gold++;
    if (b > r * 1.25 && b > g * 1.15 && b > 70) blue++;
  }
  return { visible, gold, blue };
}

function pixelDiff(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2]) changed++;
  }
  return changed;
}

async function main() {
  if (![...PAYLOAD.keys()].every(name => fs.existsSync(path.join(INSTALLED, name)))) {
    console.log('SKIP  Captain Claw installer-produced demo payload is missing');
    return;
  }
  for (const [name, expected] of PAYLOAD) {
    assert.strictEqual(hash(path.join(INSTALLED, name)), expected,
      `${name} is not the payload produced by the documented original installer`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-captain-claw-'));
  const beforePath = process.env.CLAW_BEFORE_SCREENSHOT || path.join(temp, 'before.png');
  const afterPath = process.env.CLAW_SCREENSHOT || path.join(temp, 'after.png');
  const child = spawn(process.execPath, [
    'test/run.js', '--app=captain_claw_demo', '--screen=640x480',
    '--batch-size=10000', '--control-stdin', '--frozen', '--max-seconds=90',
    '--max-batches=1000000', '--quiet-api', '--quiet-blocks', '--no-close',
    '--no-build', '--repaint-every=1000000',
  ], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

  let output = '';
  let lineBuffer = '';
  let serial = 0;
  const pending = new Map();
  const exited = new Promise(resolve => child.on('exit', resolve));

  child.stdout.on('data', data => {
    output += data;
    lineBuffer += data;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^\[ctl\] (.*)$/);
      if (!match) continue;
      let reply;
      try { reply = JSON.parse(match[1]); } catch (_) { continue; }
      const waiter = pending.get(reply.id);
      if (!waiter) continue;
      pending.delete(reply.id);
      reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error));
    }
  });
  child.stderr.on('data', data => { output += data; });
  child.on('exit', code => {
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`run.js exited before replying to ${id} (exit ${code})`));
    }
    pending.clear();
  });

  function send(command) {
    const id = `claw-${++serial}`;
    const payload = typeof command === 'string' ? { id, cmd: command } : { id, ...command };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  const step = n => send({ action: 'step', n });
  try {
    await send({ action: 'ping' });
    await step(500);
    await send('click:320:233'); // Single Player
    await step(500);
    await send(`png:${beforePath}`);
    await send('di-keydown:39');
    await step(180);
    await send('di-keyup:39');
    await step(20);
    await send(`png:${afterPath}`);

    const before = PNG.sync.read(fs.readFileSync(beforePath));
    const after = PNG.sync.read(fs.readFileSync(afterPath));
    assert.strictEqual(before.width, 640, 'Captain Claw must present its 640x480 mode');
    assert.strictEqual(before.height, 480);
    assert.strictEqual(after.width, 640);
    assert.strictEqual(after.height, 480);
    const stats = pixelStats(after);
    const changed = pixelDiff(before, after);
    assert(stats.visible > 120000, `La Roca scene is missing (${stats.visible} visible pixels)`);
    assert(stats.gold > 1500, `treasure and HUD are missing (${stats.gold} gold pixels)`);
    assert(stats.blue > 1000, `Claw/water scene detail is missing (${stats.blue} blue pixels)`);
    assert(changed > 30000,
      `holding DirectInput Right did not move Claw and the camera (${changed} changed pixels)`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `Captain Claw hit a compatibility failure\n${output.slice(-6000)}`);

    await send({ action: 'quit' });
    child.stdin.end();
    const code = await exited;
    assert.strictEqual(code, 0, `Captain Claw CLI exited ${code}\n${output.slice(-6000)}`);
    console.log(`PASS  Captain Claw La Roca gameplay: visible=${stats.visible}, ` +
      `gold=${stats.gold}, blue=${stats.blue}, inputPixels=${changed}`);
    console.log(`PASS  Captain Claw screenshot: ${afterPath}`);
  } catch (error) {
    if (child.exitCode === null) {
      try { await send({ action: 'quit' }); } catch (_) {}
      child.stdin.end();
      await exited;
    }
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Captain Claw gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
