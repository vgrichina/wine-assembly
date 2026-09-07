#!/usr/bin/env node
// Caesar III all the way into a running city, including a real governor name.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test/binaries/candidates/caesar-3-demo/installed/c3.exe');
const ANALYZE_ONLY = process.argv[2];

function stats(png, x0, y0, x1, y1) {
  let green = 0;
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i];
      const g = png.data[i + 1];
      const b = png.data[i + 2];
      if (g > r + 8 && g > b + 8) green++;
      if (r < 90 && g < 90 && b < 90) dark++;
      total++;
    }
  }
  return { green: green / total, dark: dark / total };
}

function verifyCity(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  assert.strictEqual(png.width, 800, 'Caesar III must present its 800x600 mode');
  assert.strictEqual(png.height, 600);
  const map = stats(png, 0, 30, 590, 590);
  const sidebar = stats(png, 610, 60, 790, 470);
  const topBar = stats(png, 0, 2, 800, 16);
  console.log(`map green ${(map.green * 100).toFixed(1)}%  ` +
    `sidebar green ${(sidebar.green * 100).toFixed(1)}%  ` +
    `top bar dark ${(topBar.dark * 100).toFixed(1)}%`);
  assert(map.green > 0.35,
    `the city map should be mostly green terrain, saw ${(map.green * 100).toFixed(1)}%`);
  assert(sidebar.green < 0.20,
    `the stone control panel should not be terrain, saw ${(sidebar.green * 100).toFixed(1)}% green`);
  assert(map.green - sidebar.green > 0.3,
    'the city map and control panel should be visually distinct');
}

async function main() {
  if (ANALYZE_ONLY) {
    verifyCity(ANALYZE_ONLY);
    console.log('PASS  Caesar III capture is a playable city view');
    return;
  }
  if (!fs.existsSync(EXE)) {
    console.log('SKIP  Caesar III installer-produced demo payload is missing');
    return;
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-caesar3-gameplay-'));
  const namePath = process.env.CAESAR3_NAME_SCREENSHOT || path.join(temp, 'name.png');
  const cityPath = process.env.CAESAR3_SCREENSHOT || path.join(temp, 'city.png');
  const args = [
    'test/run.js', '--app=caesar3_demo', '--screen=800x600', '--batch-size=50000',
    '--control-stdin', '--frozen', '--max-seconds=90', '--max-batches=1000000',
    '--quiet-api', '--quiet-blocks', '--no-close', '--repaint-every=1000000',
  ];
  if (fs.existsSync(path.join(ROOT, 'build/wine-assembly.wasm'))) args.push('--no-build');
  const session = startControlSession(args, { cwd: ROOT, idPrefix: 'c3-' });
  const { send, step } = session;
  async function pressAt(x, y, moveGap = 40, holdGap = 40) {
    await send(`mousemove:${x}:${y}`);
    await step(moveGap);
    await send(`mousedown:${x}:${y}`);
    await step(holdGap);
    await send(`mouseup:${x}:${y}`);
  }
  async function typeText(text) {
    for (const ch of text) {
      const vk = ch.toUpperCase().charCodeAt(0);
      await send(`keydown:${vk}`);
      await send(`keypress:${ch.charCodeAt(0)}`);
      await send(`keyup:${vk}`);
      await step(10);
    }
  }
  const readGovernorName = () => send({
    action: 'eval',
    code: `(() => { const m=new Uint8Array(memory.buffer), p=g2w(0x57eb3c); let s=''; for(let i=0;i<32&&m[p+i];i++)s+=String.fromCharCode(m[p+i]); return s; })()`,
  });

  try {
    await send({ action: 'ping' });
    await step(700);
    await pressAt(400, 300, 60, 40); // dismiss title; now batch 800
    await step(200);
    await pressAt(400, 172);         // Start new game; now batch 1080
    await step(370);

    assert.strictEqual(await readGovernorName(), '',
      'new-career name buffer must not retain the default governor text');
    await typeText('Codex');         // now batch 1500
    assert.strictEqual(await readGovernorName(), 'Codex',
      'typing a short name must not retain a suffix from the default text');
    await send(`png:${namePath}`);

    await pressAt(548, 320);         // Continue; now batch 1580
    await step(1020);
    await pressAt(613, 502);         // To the city; now batch 2680
    await step(720);
    await send(`png:${cityPath}`);

    verifyCity(cityPath);
    assert(session.output().includes('patched Caesar III new-career name buffer starts empty'),
      `Caesar III compatibility patch was not reported\n${session.output().slice(-5000)}`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `Caesar III hit a compatibility failure\n${session.output().slice(-5000)}`);

    const code = await session.quit();
    assert.strictEqual(code, 0,
      `Caesar III CLI exited ${code}\n${session.output().slice(-5000)}`);
    console.log(`PASS  Caesar III typed-name screenshot: ${namePath}`);
    console.log(`PASS  Caesar III playable-city screenshot: ${cityPath}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL Caesar III gameplay: ${error.stack || error.message}`);
  process.exit(1);
});
