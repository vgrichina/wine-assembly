#!/usr/bin/env node

// End-to-end gameplay gate for the original GeneRally 1.05 freeware package.
// The candidate payload is local/gitignored, so this test skips when it has
// not been fetched and remains outside run-all.sh.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CANDIDATE_ROOT = path.join(__dirname, 'binaries', 'candidates', 'generally');
const EXE = path.join(CANDIDATE_ROOT, 'GeneRally.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function imageStats(filename) {
  const png = PNG.sync.read(fs.readFileSync(filename));
  const colors = new Set();
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const a = png.data[i + 3];
    if (a && (r || g || b)) nonBlack++;
    if (a) colors.add((r << 16) | (g << 8) | b);
  }
  return { png, width: png.width, height: png.height, nonBlack, colors: colors.size };
}

function pixelDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    'cannot compare differently sized GeneRally frames');
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
        a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
      changed++;
    }
  }
  return changed;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log('SKIP GeneRally candidate: fetch with node tools/fetch-candidate-corpus.js --id=generally');
    return;
  }

  for (const relative of [
    'Cars/Cars.car', 'Drivers/Player.drv', 'Tracks/GeneRally/Agari.trk',
    'font.bmp', 'gr.pal',
  ]) {
    assert(fs.existsSync(path.join(CANDIDATE_ROOT, relative)),
      `GeneRally candidate is missing ${relative}`);
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-generally-candidate-'));
  const probePath = process.env.GENERALLY_PROBE || path.join(temp, 'race-probe.png');
  const frameAPath = path.join(temp, 'race-a.png');
  const frameBPath = process.env.GENERALLY_SCREENSHOT || path.join(temp, 'race-b.png');
  const session = startControlSession([
    RUN,
    '--app=generally',
    '--screen=800x600',
    '--control-stdin',
    '--max-seconds=90',
    '--quiet-api',
    '--quiet-blocks',
    '--repaint-every=1000',
  ], { cwd: ROOT, idPrefix: 'g' });
  const { send } = session;

  async function waitFor(description, probe, ms = 85000) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = await probe();
      if (last) return last;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${description}; last=${JSON.stringify(last)}\n${session.output().slice(-5000)}`);
  }

  try {
    await waitFor('GeneRally main window', async () => {
      const snapshot = await send({ action: 'snapshot' });
      return (snapshot.windows || []).some(win => win.visible && /GeneRally/i.test(win.title));
    });

    await waitFor('the initialized main menu', async () => {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      return stats.width === 800 && stats.height === 600 &&
        stats.nonBlack > 450000 && stats.colors > 8 ? stats : null;
    });
    await sleep(500);

    // Screen coordinates at the CLI's stable 800x600 presentation. Select the
    // bundled driver, choose a track in the grid, promote it with Select, then
    // start. Each click is acknowledged after injection; a short host pause
    // lets GeneRally consume its down/up messages before the next command.
    await send('click:550:125');
    await sleep(750);
    await send('click:145:360');
    await sleep(750);
    await send('click:460:530');
    await sleep(750);
    await send('click:700:580');

    const race = await waitFor('a textured race frame', async () => {
      await send(`png:${probePath}`);
      const stats = imageStats(probePath);
      return stats.width === 800 && stats.height === 600 &&
        stats.nonBlack > 400000 && stats.colors > 80 ? stats : null;
    });

    // The default player uses the cursor keys. Hold acceleration, add steering,
    // and compare separated frames so the oracle proves a live race rather
    // than merely accepting the static start-grid presentation.
    await send('keydown:38');
    await sleep(1200);
    await send(`png:${frameAPath}`);
    await send('keydown:39');
    await sleep(1500);
    await send(`png:${frameBPath}`);
    await send('keyup:39');
    await send('keyup:38');

    const a = imageStats(frameAPath);
    const b = imageStats(frameBPath);
    for (const [label, stats] of [['first', a], ['second', b]]) {
      assert(stats.width === 800 && stats.height === 600,
        `GeneRally ${label} frame used ${stats.width}x${stats.height}`);
      assert(stats.nonBlack > 400000 && stats.colors > 80,
        `GeneRally ${label} frame was not textured gameplay: ${JSON.stringify(stats)}`);
    }
    const changed = pixelDiff(a.png, b.png);
    assert(changed > 3000,
      `GeneRally race did not advance after acceleration/steering: ${changed} changed pixels`);
    assert(!/UNIMPLEMENTED API:|\*\*\* CRASH|RuntimeError|LinkError/i.test(session.output()),
      `GeneRally hit a compatibility failure\n${session.output().slice(-8000)}`);

    const code = await session.quit();
    assert(code === 0, `GeneRally CLI exited ${code}\n${session.output().slice(-8000)}`);
    console.log(`PASS GeneRally gameplay: ${race.colors} race colors, ${changed} changed pixels`);
    console.log(`PASS GeneRally screenshot: ${frameBPath}`);
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`FAIL GeneRally candidate: ${error.stack || error.message}`);
  process.exit(1);
});
