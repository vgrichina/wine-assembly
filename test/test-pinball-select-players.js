#!/usr/bin/env node
// Pinball Options > Select Players regression.
//
// Select Players is a cascading submenu under Options. The menu loader
// must expose its player-count commands to the menu path, keep the cascade
// open across the gap, and actually paint the nested dropdown.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');
const LOG  = path.join(ROOT, 'scratch', 'pinball_select_players.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}

const VK_O      = 79;

const inputSpec = [
  `0:wait-title-menu-open:3D_Pinball_for_Windows_-_Space_Cadet:2000:${VK_O}:options`,
  `0:menu-dump:open`,
  `0:mousemove:90:92`,      // Hover Select Players.
  `0:menu-dump:hover-parent`,
  `0:mousemove:228:114`,    // Cross the small gap into the cascade.
  `0:menu-dump:hover-gap`,
  `0:mousemove:250:114`,    // Hover 2 Players.
  `0:menu-dump:hover-sub`,
  `0:pixel:260:104:submenu-hover`,
  `0:stop`,
].join(',');

const runArgs = [
  RUN,
  `--exe=${EXE}`,
  '--args=-quick',
  '--batch-size=200000',
  '--max-batches=520',
  `--input=${inputSpec}`,
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
];
console.log('$', [process.execPath, ...runArgs].map(s => /\s/.test(s) ? JSON.stringify(s) : s).join(' '));

let out = '';
let status = 0;
try {
  const fd = fs.openSync(LOG, 'w');
  try {
    const r = spawnSync(process.execPath, runArgs, {
      cwd: ROOT,
      stdio: ['ignore', fd, fd],
      timeout: 360000,
      maxBuffer: 64 * 1024 * 1024,
    });
    status = r.status === null ? 1 : r.status;
    if (r.error) status = 1;
  } finally {
    fs.closeSync(fd);
  }
  out = fs.readFileSync(LOG, 'utf8');
} catch (e) {
  out = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : String(e && e.stack || e);
  status = 1;
}
if (status !== 0) {
  console.log('(run.js exited non-zero -- output captured)');
}

for (const l of out.split('\n')) {
  if (l.includes('[input]') || l.includes('CheckMenuItem') ||
      l.includes('UNIMPLEMENTED') || l.includes('CRASH') || l.includes('RuntimeError')) {
    console.log('  ' + l);
  }
}

const checks = [];
checks.push({ name: 'no UNIMPLEMENTED API crash', pass: !/UNIMPLEMENTED API:/.test(out) });
checks.push({ name: 'no unreachable trap', pass: !/RuntimeError: unreachable|\*\*\* CRASH/.test(out) });
checks.push({ name: 'Select Players parent hovered', pass: /menu-dump:hover-parent:[^\n]*hover=2/.test(out) });
checks.push({ name: 'Select Players hover survives cascade gap', pass: /menu-dump:hover-gap:[^\n]*hover=2/.test(out) });
checks.push({ name: '2 Players submenu item hovered', pass: /menu-dump:hover-sub:[^\n]*hover=2 subhover=1/.test(out) });
let submenuPixelPass = false;
const pixelMatch = /pixel:submenu-hover: 260,104 rgba=(\d+),(\d+),(\d+),(\d+)/.exec(out);
if (pixelMatch) {
  const [, rs, gs, bs, as] = pixelMatch;
  const r = parseInt(rs, 10), g = parseInt(gs, 10), b = parseInt(bs, 10), a = parseInt(as, 10);
  submenuPixelPass = a > 0 && r < 40 && g < 40 && b > 80;
}
checks.push({ name: '2 Players submenu visibly painted', pass: submenuPixelPass });

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
