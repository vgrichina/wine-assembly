#!/usr/bin/env node

// End-to-end gameplay gate for Pixel's original Cave Story 1.0.0.6 package.
// The Japanese freeware payload is local/gitignored, so this candidate-only
// test skips when the corpus has not been fetched and stays outside run-all.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'cave-story');
const EXE = path.join(CANDIDATE_ROOT, 'doukutsu', 'Doukutsu.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    if (!png.data[i + 3]) continue;
    colors.add((png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2]);
  }
  return { png, width: png.width, height: png.height, colors: colors.size };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized Cave Story frames');
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
    console.log('SKIP Cave Story candidate: fetch with node tools/fetch-candidate-corpus.js --id=cave-story');
    return;
  }
  for (const relative of ['data/Title.pbm', 'data/MyChar.pbm', 'data/Stage/Cave.pxm']) {
    assert(fs.existsSync(path.join(CANDIDATE_ROOT, 'doukutsu', relative)),
      `Cave Story candidate is missing ${relative}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cave-story-candidate-'));
  const probePath = process.env.CAVE_STORY_PROBE || path.join(temp, 'probe.png');
  const frameAPath = path.join(temp, 'gameplay-a.png');
  const frameBPath = process.env.CAVE_STORY_SCREENSHOT || path.join(temp, 'gameplay-b.png');
  const child = spawn('node', [
    RUN,
    '--app=cave_story',
    '--screen=800x600',
    '--batch-size=100000',
    '--control-stdin',
    '--max-seconds=240',
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
    const id = `c${nextId++}`;
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

  async function waitFor(description, probe, ms) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = await probe();
      if (last) return last;
      await sleep(1000);
    }
    throw new Error(`timed out waiting for ${description}; last=${JSON.stringify(last)}\n${output.slice(-6000)}`);
  }

  async function pulse(vk, gap = 300) {
    await send(`keydown:${vk}`);
    await sleep(120);
    await send(`keyup:${vk}`);
    await sleep(gap);
  }

  try {
    // Cave Story synthesizes its Organya samples during startup. The process is
    // live while LOADING is displayed; wait on the richer title palette rather
    // than guessing how many interpreter batches synthesis will take.
    const title = await waitFor('the Cave Story title screen', async () => {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      const bytes = fs.statSync(probePath).size;
      return stats.width === 800 && stats.height === 600 && stats.colors >= 10 &&
        bytes >= 7000 && bytes <= 10000 ? stats : null;
    }, 210000);

    await pulse(90, 1000); // Z selects the highlighted New Game entry.
    await pulse(90, 700);
    await pulse(90, 700);
    await waitFor('the opening in-engine scene', async () => {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      return stats.colors >= 20 ? stats : null;
    }, 20000);

    // Z advances dialogue as well as jumping. Extra pulses are harmless once
    // control is returned and avoid depending on Japanese typewriter timing.
    for (let i = 0; i < 16; i++) await pulse(90, 300);

    const room = await waitFor('the playable First Cave room', async () => {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      return fs.statSync(probePath).size > 60000 && stats.colors >= 25 ? stats : null;
    }, 30000);

    await send(`png:${frameAPath}`);
    await send('keydown:39'); // right
    await sleep(300);
    await send('keydown:90'); // jump
    await sleep(500);
    await send('keyup:90');
    await sleep(1200);
    await send(`png:${frameBPath}`);
    await send('keyup:39');

    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    assert(a.colors >= 25 && b.colors >= 25,
      `Cave Story gameplay palette regressed: ${a.colors}/${b.colors} colors`);
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 1000,
      `Cave Story did not move after right+jump input: ${changed} changed pixels`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(output),
      `Cave Story hit a compatibility failure\n${output.slice(-8000)}`);

    await send({ action: 'quit' });
    child.stdin.end();
    const code = await childExit;
    assert(code === 0, `Cave Story CLI exited ${code}\n${output.slice(-8000)}`);
    console.log(`PASS Cave Story gameplay: ${title.colors}/${room.colors} title/room colors, ${changed} changed pixels`);
    console.log(`PASS Cave Story screenshot: ${frameBPath}`);
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
  console.error(`FAIL Cave Story candidate: ${error.stack || error.message}`);
  process.exit(1);
});
