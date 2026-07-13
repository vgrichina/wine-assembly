#!/usr/bin/env node
// WEP games attach menus after CreateWindowExA. SetMenu must update the
// non-client/client geometry before they paint, otherwise the game surface
// starts under the menu bar by one menu height.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CASES = [
  { name: 'snake', title: 'Snake', exe: 'snake.exe' },
  { name: 'tictac', title: 'TicTactics', exe: 'tictac.exe' },
  { name: 'mine', title: 'Minesweeper', exe: 'winmine.exe' },
];

function runCase(c) {
  const exe = path.join(__dirname, 'binaries', 'entertainment-pack', c.exe);
  if (!fs.existsSync(exe)) return { skip: true, checks: [] };
  const inputSpec = `120:dump-windows:${c.name},130:stop`;
  const cmd = [
    `node "${RUN}"`,
    `--exe="${exe}"`,
    '--no-close',
    '--screen=640x480',
    '--quiet-api',
    '--quiet-blocks',
    `--input=${inputSpec}`,
    '--max-batches=160',
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

  const line = out.split('\n').find(l => l.includes(`[input] window:${c.name} hwnd=65537`)) || '';
  const m = line.match(/pos=(-?\d+),(-?\d+) size=(\d+)x(\d+) client=(\{[^}]+\})/);
  let win = null;
  if (m) {
    let client = null;
    try { client = JSON.parse(m[5]); } catch (_) {}
    win = { x: +m[1], y: +m[2], w: +m[3], h: +m[4], client, line };
  }
  const clientTop = win && win.client ? win.client.y - win.y : null;
  return {
    checks: [
      { name: `${c.title}: run.js exited cleanly`, pass: exitCode === 0 },
      { name: `${c.title}: main window dumped`, pass: !!win },
      { name: `${c.title}: menu is outside client area`, pass: clientTop === 41 },
    ],
    win,
    clientTop,
  };
}

let failed = 0;
let total = 0;
for (const c of CASES) {
  const result = runCase(c);
  if (result.skip) {
    console.log(`SKIP  ${c.exe} not found`);
    continue;
  }
  for (const check of result.checks) {
    total++;
    console.log((check.pass ? 'PASS  ' : 'FAIL  ') + check.name);
    if (!check.pass) failed++;
  }
  console.log(`${c.name}: clientTop=${result.clientTop} ${result.win ? result.win.line : '(missing)'}`);
}
console.log(`${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
