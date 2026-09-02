#!/usr/bin/env node

// Gameplay gate for the original Jazz Jackrabbit 2 shareware 1.23s package.
// This stock build does not honor official level names as an interactive CLI
// launch, so its animated Darn Ratz/Frog Stomp attraction is the acceptance
// route documented in docs/re-notes/jazz2-demo.md.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLED = path.join(__dirname, 'binaries', 'candidates',
  'jazz-jackrabbit-2-demo-installer', 'installed');
const EXE = path.join(INSTALLED, 'jazz2.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2], a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
  }
  return { png, width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized Jazz 2 frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) changed++;
  }
  return changed;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log('SKIP Jazz 2 candidate: fetch with node tools/fetch-candidate-corpus.js --id=jazz-jackrabbit-2-demo-installer');
    return;
  }
  for (const relative of ['share1.j2l', 'share1.j2m', 'animssw.j2a', 'data.j2d']) {
    assert(fs.existsSync(path.join(INSTALLED, relative)), `Jazz 2 candidate is missing ${relative}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jazz2-gameplay-'));
  const probePath = process.env.JAZZ2_PROBE || path.join(temp, 'probe.png');
  const frameAPath = path.join(temp, 'gameplay-a.png');
  const frameBProbePath = path.join(temp, 'gameplay-b-probe.png');
  const frameBPath = process.env.JAZZ2_SCREENSHOT || path.join(temp, 'gameplay-b.png');
  const child = spawn('node', [
    RUN,
    '--app=jazz2_demo',
    '--screen=800x600',
    '--batch-size=100000',
    '--control-stdin',
    '--max-seconds=180',
    '--quiet-api',
    '--quiet-blocks',
    '--repaint-every=2000',
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
      reply.ok ? waiter.resolve(reply.value) : waiter.reject(new Error(reply.error));
    }
  }

  child.stdout.on('data', onData);
  child.stderr.on('data', data => { output += data; });
  child.on('exit', code => {
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`run.js exited before replying to ${id} (exit ${code})`));
    }
    pending.clear();
  });

  function send(command) {
    const id = `j${nextId++}`;
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

  async function pulseEscape() {
    await send('keydown:27');
    await sleep(120);
    await send('keyup:27');
  }

  try {
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
      const snapshot = await send({ action: 'snapshot' });
      if ((snapshot.windows || []).some(win => /Jazz Jackrabbit 2/i.test(win.title))) break;
      await sleep(500);
    }

    let gameplay = null;
    const gameplayDeadline = Date.now() + 165000;
    while (Date.now() < gameplayDeadline) {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      const bytes = fs.statSync(probePath).size;
      if (stats.width === 800 && stats.height === 600 && bytes > 300000 &&
          stats.nonBlack > 300000 && stats.colors > 120) {
        gameplay = stats;
        break;
      }
      await pulseEscape();
      await sleep(1200);
    }
    assert(gameplay, `Jazz 2 did not reach textured gameplay\n${output.slice(-8000)}`);
    fs.copyFileSync(probePath, frameAPath);

    const a = imageStats(frameAPath);
    let b = null;
    let changed = 0;
    const secondFrameDeadline = Date.now() + 30000;
    while (Date.now() < secondFrameDeadline) {
      await sleep(500);
      await send(`png:${frameBProbePath}`);
      const candidate = imageStats(frameBProbePath);
      const bytes = fs.statSync(frameBProbePath).size;
      const candidateChanged = pixelDiff(a.png, candidate.png);
      if (bytes > 300000 && candidate.nonBlack > 300000 &&
          candidate.colors > 120 && candidateChanged > 50000) {
        b = candidate;
        changed = candidateChanged;
        fs.copyFileSync(frameBProbePath, frameBPath);
        break;
      }
    }
    assert(b, 'Jazz 2 did not produce a second distinct textured gameplay frame');
    assert(/Jazz Jackrabbit 2 Shareware - (?:Darn Ratz|Retro Rabbit|Frog Stomp)/.test(output),
      `Jazz 2 never named a playable shareware level\n${output.slice(-8000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `Jazz 2 hit a compatibility failure\n${output.slice(-8000)}`);

    await send({ action: 'quit' });
    child.stdin.end();
    const code = await childExit;
    assert(code === 0, `Jazz 2 CLI exited ${code}\n${output.slice(-8000)}`);
    console.log(`PASS Jazz 2 gameplay: ${a.colors}/${b.colors} colors, ${changed} changed pixels`);
    console.log(`PASS Jazz 2 screenshot: ${frameBPath}`);
  } catch (error) {
    if (child.exitCode === null) {
      try { await send({ action: 'quit' }); } catch (_) {}
      child.stdin.end();
      await childExit;
    }
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Jazz 2 candidate: ${error.stack || error.message}`);
  process.exit(1);
});
