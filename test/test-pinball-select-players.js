#!/usr/bin/env node
// Pinball Options > Select Players regression.
//
// Select Players is a cascading submenu under Options. The menu loader
// must expose its player-count commands to the keyboard menu path, and
// the mouse path must keep the cascade open long enough to click a
// nested player-count command.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'pinball', 'pinball.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  pinball.exe not found at', EXE);
  process.exit(0);
}

const VK_MENU   = 18; // Alt
const VK_O      = 79;

const inputSpec = [
  `300:keydown:${VK_MENU}`,
  `301:keydown:${VK_O}`,      // Alt+O opens Options.
  `302:keyup:${VK_O}`,
  `303:keyup:${VK_MENU}`,
  `315:menu-dump:open`,
  `320:mousemove:90:92`,      // Hover Select Players.
  `321:menu-dump:hover-parent`,
  `330:mousemove:228:114`,    // Cross the small gap into the cascade.
  `331:menu-dump:hover-gap`,
  `340:mousemove:250:114`,    // Hover 2 Players.
  `341:menu-dump:hover-sub`,
  `350:click:250:114`,
  `380:keydown:${VK_MENU}`,
  `381:keydown:${VK_O}`,      // Reopen Options to inspect check state.
  `382:keyup:${VK_O}`,
  `383:keyup:${VK_MENU}`,
  `390:menu-dump:after-select`,
  `410:stop`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --args=-quick --batch-size=200000 --max-batches=520 --input='${inputSpec}' --quiet-api --quiet-blocks --no-close`;
console.log('$', cmd);

let out = '';
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 180000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
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
checks.push({ name: '2 Players checked in cascaded menu state', pass: /menu-dump:after-select:[^\n]*1:409:"&2 Players":flags=0x4/.test(out) });

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
