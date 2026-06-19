#!/usr/bin/env node
// SkiFree exits during startup if first ShowWindow does not deliver the
// Win98-style activation/focus/size sequence before its init branch returns.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'entertainment-pack', 'ski32.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  ski32.exe not found');
  process.exit(0);
}

function runCase(name, screen, expectWide) {
  const inputSpec = '80:dump-windows:' + name + ',100:dump-focus:' + name + ',120:stop';
  const cmd = [
    `node "${RUN}"`,
    `--exe="${EXE}"`,
    '--no-close',
    `--screen=${screen}`,
    '--quiet-api',
    '--quiet-blocks',
    '--count=0x00405800,0x0040485e',
    `--input=${inputSpec}`,
    '--max-batches=180',
    '--batch-size=25000',
  ].join(' ');
  console.log('$', cmd.replace(ROOT, '.'));

  let out = '';
  let exitCode = 0;
  try {
    out = execSync(cmd, {
      encoding: 'utf-8', timeout: 120000, cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    exitCode = e.status ?? 1;
    console.log(`(run.js exited non-zero status=${exitCode} - output captured)`);
  }

  function parseWindow(hwnd) {
    const line = out.split('\n').find(l => l.includes(`[input] window:${name} hwnd=${hwnd}`)) || '';
    const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+) client=(\{[^}]+\})/);
    if (!m) return null;
    let client = null;
    try { client = JSON.parse(m[5]); } catch (_) {}
    return { x: +m[1], y: +m[2], w: +m[3], h: +m[4], client, line };
  }

  function hit(addr) {
    const m = out.match(new RegExp(addr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' = (\\d+)'));
    return m ? +m[1] : 0;
  }

  const main = parseWindow(65537);
  const status = parseWindow(65538);
  const focusOk = out.includes(`[input] dump-focus ${name}: hwnd=0x10001`);
  const mainProcHits = hit('0x00405800');
  const loopHits = hit('0x0040485e');
  const childRightAligned = !!main && !!status && !!main.client &&
    status.w === 140 && status.h === 68 &&
    status.x >= Math.max(1, main.client.w - 180);

  const checks = [
    { name: `${name}: run.js exited cleanly`, pass: exitCode === 0 },
    { name: `${name}: message loop reached`, pass: loopHits >= 1 },
    { name: `${name}: WndProc got startup messages`, pass: mainProcHits >= 5 },
    { name: `${name}: focus is main window`, pass: focusOk },
    { name: `${name}: status child laid out`, pass: childRightAligned },
    { name: `${name}: large desktop size is retained`, pass: !expectWide || (!!main && main.w >= 1000 && main.h >= 1000) },
  ];

  return { checks, main, status, mainProcHits, loopHits };
}

const cases = [
  runCase('skifree640', '640x480', false),
  runCase('skifree1600', '1600x1200', true),
];

let failed = 0;
for (const c of cases) {
  for (const check of c.checks) {
    console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.name);
    if (!check.pass) failed++;
  }
  console.log(`main: ${c.main ? c.main.line : '(missing)'}`);
  console.log(`status: ${c.status ? c.status.line : '(missing)'}`);
  console.log(`hits: wndproc=${c.mainProcHits} loop=${c.loopHits}`);
}

const total = cases.reduce((n, c) => n + c.checks.length, 0);
console.log(`${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
