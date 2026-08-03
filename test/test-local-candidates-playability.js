#!/usr/bin/env node
// Focused smoke coverage for local desktop candidate apps. These tests go a
// step past window creation: close first-run/about UI where needed, issue a
// stable app command or click, then assert rendered pixels and app-specific
// windows/dialogs.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const SCRATCH = path.join(ROOT, 'scratch', 'local-candidates');
fs.mkdirSync(SCRATCH, { recursive: true });

function exePath(...parts) {
  return path.join(__dirname, 'binaries', ...parts);
}

function clean(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function readPng(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size <= 0) return null;
  return PNG.sync.read(fs.readFileSync(file));
}

function diffPixels(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return -1;
  let diff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i]) +
      Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 40) diff++;
  }
  return diff;
}

function stats(png) {
  if (!png) return { colors: 0, saturated: 0, white: 0, total: 0 };
  const colors = new Set();
  let saturated = 0;
  let white = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    colors.add((r << 16) | (g << 8) | b);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 140 && max - min > 80) saturated++;
    if (r > 235 && g > 235 && b > 235) white++;
  }
  return { colors: colors.size, saturated, white, total: png.width * png.height };
}

function runApp(test) {
  if (!fs.existsSync(test.exe)) {
    return { skipped: true, reason: `${path.basename(test.exe)} missing` };
  }
  clean(test.pngs);
  const args = [
    RUN,
    `--exe=${test.exe}`,
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    `--batch-size=${test.batchSize || 50000}`,
    `--max-batches=${test.maxBatches || 240}`,
    `--input=${test.input}`,
  ];
  if (test.dlls) args.splice(2, 0, `--dlls=${test.dlls}`);
  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', args, {
      cwd: ROOT,
      env: { ...process.env, ...(test.env || {}) },
      encoding: 'utf8',
      timeout: test.timeout || 120000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    exitCode = e.status ?? 1;
  }
  return { out, exitCode };
}

function reportChecks(name, checks, extra) {
  let failed = 0;
  for (const check of checks) {
    console.log((check.pass ? 'PASS  ' : 'FAIL  ') + `${name}: ${check.name}`);
    if (!check.pass) failed++;
  }
  if (extra) console.log(`  ${name}: ${extra}`);
  return failed;
}

function hasNoCrash(out) {
  return !/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/i.test(out);
}

function fullPath(id, name) {
  return path.join(SCRATCH, `${id}_${name}.png`);
}

const tests = [
  {
    id: 'peaks',
    name: 'Peaks',
    exe: exePath('wep32-community', 'Funpack', 'Peaks.exe'),
    dlls: exePath('wep32-community', 'Funpack', 'FunPack.dll'),
    maxBatches: 240,
    before: fullPath('peaks', 'ready'),
    after: fullPath('peaks', 'move'),
    input: null,
    check(result, before, after, metricBefore, metricAfter, diff) {
      return [
        { name: 'run exited cleanly', pass: result.exitCode === 0 },
        { name: 'about dialog was dismissed', pass: /dlg-click: id=1/.test(result.out) },
        { name: 'main window is visible', pass: /window:peaks .*visible=true .*dialog=false .*title="Peaks"/.test(result.out) },
        { name: 'valid card move visibly changes tableau', pass: diff > 5000 },
        { name: 'rendered board has rich color content', pass: metricAfter.colors > 100 && metricAfter.saturated > 10000 },
        { name: 'no crash marker', pass: hasNoCrash(result.out) },
      ];
    },
  },
  {
    id: 'fourstones',
    name: 'FourStones',
    exe: exePath('wep32-community', 'Funpack', 'FourStones.exe'),
    dlls: exePath('wep32-community', 'Funpack', 'FunPack.dll'),
    maxBatches: 500,
    before: fullPath('fourstones', 'ready'),
    after: fullPath('fourstones', 'hint'),
    input: null,
    check(result, before, after, metricBefore, metricAfter, diff) {
      return [
        { name: 'run exited cleanly', pass: result.exitCode === 0 },
        { name: 'about dialog was dismissed', pass: /dlg-click: id=1/.test(result.out) },
        { name: 'main board window is visible', pass: /window:four .*visible=true .*dialog=false .*title="Four Stones"/.test(result.out) },
        { name: 'hint command was delivered', pass: /post-cmd wParam=0x9c42/.test(result.out) },
        { name: 'piece interaction visibly changes board', pass: diff > 1000 },
        { name: 'rendered board has rich color content', pass: metricAfter.colors > 100 && metricAfter.saturated > 10000 },
        { name: 'no crash marker', pass: hasNoCrash(result.out) },
      ];
    },
  },
  {
    id: 'qblackjack',
    name: 'QuickBlackjack',
    exe: exePath('wep32-community', 'QBlackjack', 'QuickBlackjack.exe'),
    maxBatches: 500,
    timeout: 180000,
    env: {
      QBLACKJACK_PURSE: '500',
      QBLACKJACK_CHANGE: '0',
      QBLACKJACK_ANIMATION: '0',
    },
    before: fullPath('qblackjack', 'table'),
    after: fullPath('qblackjack', 'hand'),
    input: null,
    check(result, before, after, metricBefore, metricAfter, diff) {
      return [
        { name: 'run exited cleanly', pass: result.exitCode === 0 },
        { name: 'startup dialog was dismissed', pass: /dlg-click: id=1/.test(result.out) },
        { name: 'table reached betting state', pass: /Place your Bets \(minimum 5\)/.test(result.out) },
        { name: 'minimum bet command was delivered', pass: /post-cmd wParam=0x137/.test(result.out) },
        { name: 'stand action command was delivered', pass: /post-cmd wParam=0x12f/.test(result.out) },
        { name: 'normal purse avoids borrow prompt', pass: !/You can't afford that!/.test(result.out) },
        { name: 'house-limit modal is not shown', pass: !/Congratulations!/.test(result.out) },
        { name: 'minimum bet deals a playable hand', pass: /window:qbj-hand .*ctrlId=303 .*enabled=true .*title="Stand"/.test(result.out) },
        { name: 'strategy helper opens for the dealt hand', pass: /window:qbj-hand .*visible=true .*title="(Draw & Stand|Doubling Down|Splitting)/.test(result.out) },
        { name: 'stand returns to betting state', pass: /window:qbj-stand .*ctrlId=172 .*visible=true .*title="Place your Bets \(minimum 5\)"/.test(result.out) },
        { name: 'betting controls re-enable after hand', pass: /window:qbj-stand .*ctrlId=311 .*enabled=true .*title="Min"/.test(result.out) },
        { name: 'dealt hand visibly changes the table', pass: diff > 5000 },
        { name: 'dealt hand keeps rich color content', pass: metricAfter.colors > 100 && metricAfter.saturated > 10000 },
        { name: 'no crash marker', pass: hasNoCrash(result.out) },
      ];
    },
  },
  {
    id: 'cwordzap',
    name: 'CWordZap',
    exe: exePath('wep32-community', 'Wordzap', 'CWordZap.exe'),
    maxBatches: 240,
    batchSize: 100000,
    before: fullPath('cwordzap', 'splash'),
    after: fullPath('cwordzap', 'game'),
    input: null,
    check(result, before, after, metricBefore, metricAfter, diff) {
      return [
        { name: 'run exited cleanly', pass: result.exitCode === 0 },
        { name: 'title initialized', pass: /C L A S S I C  W O R D Z A P -- An Addictionary Game/.test(result.out) },
        { name: 'Start command enters game surface', pass: diff > 100000 && metricAfter.white < metricBefore.white * 0.2 },
        { name: 'main window remains visible', pass: /window:cwordzap .*visible=true .*dialog=false .*title="C L A S S I C  W O R D Z A P/.test(result.out) },
        { name: 'no crash marker', pass: hasNoCrash(result.out) },
      ];
    },
  },
  {
    id: 'marbles',
    name: 'Marbles',
    exe: exePath('plus98', 'MARBLES.EXE'),
    maxBatches: 220,
    batchSize: 50000,
    timeout: 90000,
    before: fullPath('marbles', 'before'),
    after: fullPath('marbles', 'after'),
    input: null,
    check(result, before, after, metricBefore, metricAfter, diff) {
      return [
        { name: 'run exited cleanly', pass: result.exitCode === 0 },
        { name: 'main window remains visible', pass: /window:marbles .*visible=true .*dialog=false .*title="Marbles"/.test(result.out) },
        { name: 'click visibly changes the intro surface', pass: diff > 50000 },
        { name: 'renderer retains color content after click', pass: metricAfter.colors > 100 && metricAfter.saturated > 5000 },
        { name: 'no crash marker', pass: hasNoCrash(result.out) },
      ];
    },
  },
];

for (const test of tests) {
  test.pngs = [test.before, test.after];
}

tests.find(t => t.id === 'peaks').input = [
  '20:wait-dlg-control:1:1000',
  '21:dlg-click:1',
  '60:post-cmd:40005',
  `100:png:${tests.find(t => t.id === 'peaks').before}`,
  '120:mousedown:329:240',
  '122:mouseup:329:240',
  `180:png:${tests.find(t => t.id === 'peaks').after}`,
  '200:dump-windows:peaks',
  '220:stop',
].join(',');

tests.find(t => t.id === 'fourstones').input = [
  '20:wait-dlg-control:1:1000',
  '21:dlg-click:1',
  '80:post-cmd:40005',
  `130:png:${tests.find(t => t.id === 'fourstones').before}`,
  '170:mousemove:126:84',
  '210:mousedown:126:84',
  '212:mouseup:126:84',
  '330:post-cmd:40002',
  `390:png:${tests.find(t => t.id === 'fourstones').after}`,
  '430:dump-windows:four',
  '470:stop',
].join(',');

tests.find(t => t.id === 'qblackjack').input = [
  '20:wait-dlg-control:1:1000',
  '21:dlg-click:1',
  `80:png:${tests.find(t => t.id === 'qblackjack').before}`,
  '100:post-cmd:311',
  `180:png:${tests.find(t => t.id === 'qblackjack').after}`,
  '200:dump-windows:qbj-hand',
  '220:post-cmd:303',
  '430:dump-windows:qbj-stand',
  '450:stop',
].join(',');

tests.find(t => t.id === 'cwordzap').input = [
  `40:png:${tests.find(t => t.id === 'cwordzap').before}`,
  '60:post-cmd:40003',
  `180:png:${tests.find(t => t.id === 'cwordzap').after}`,
  '200:dump-windows:cwordzap',
  '210:stop',
].join(',');

tests.find(t => t.id === 'marbles').input = [
  `80:png:${tests.find(t => t.id === 'marbles').before}`,
  '100:mousedown:320:240',
  '120:mouseup:320:240',
  `180:png:${tests.find(t => t.id === 'marbles').after}`,
  '200:dump-windows:marbles',
  '210:stop',
].join(',');

(async () => {
  let failed = 0;
  let skipped = 0;
  for (const test of tests) {
    const result = runApp(test);
    if (result.skipped) {
      skipped++;
      console.log(`SKIP  ${test.name}: ${result.reason}`);
      continue;
    }
    const before = readPng(test.before);
    const after = readPng(test.after);
    const metricBefore = stats(before);
    const metricAfter = stats(after);
    const diff = diffPixels(before, after);
    const checks = [
      { name: 'before PNG written', pass: !!before },
      { name: 'after PNG written', pass: !!after },
      ...test.check(result, before, after, metricBefore, metricAfter, diff),
    ];
    failed += reportChecks(test.name, checks,
      `diff=${diff} beforeColors=${metricBefore.colors} afterColors=${metricAfter.colors}`);
  }
  console.log(`${tests.length - skipped} local candidate playability tests run, ${skipped} skipped, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
