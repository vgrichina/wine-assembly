#!/usr/bin/env node
// Pinball Options > Select Players regression.
//
// Select Players is a cascading submenu under Options. The menu loader
// must expose its player-count commands to the keyboard menu path.

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

const TMP = path.join(ROOT, 'scratch');
fs.mkdirSync(TMP, { recursive: true });
const snapPng = path.join(TMP, 'pinball_select_players.png');
try { fs.unlinkSync(snapPng); } catch (_) {}

const VK_RETURN = 13;
const VK_DOWN   = 40;
const VK_MENU   = 18; // Alt
const VK_O      = 79;

const inputSpec = [
  `300:keydown:${VK_MENU}`,
  `301:keydown:${VK_O}`,      // Alt+O opens Options.
  `302:keyup:${VK_O}`,
  `303:keyup:${VK_MENU}`,
  `320:keydown:${VK_DOWN}`,   // Full Screen
  `321:keyup:${VK_DOWN}`,
  `330:keydown:${VK_DOWN}`,   // Select Table
  `331:keyup:${VK_DOWN}`,
  `340:keydown:${VK_DOWN}`,   // 1 Player
  `341:keyup:${VK_DOWN}`,
  `350:keydown:${VK_DOWN}`,   // 2 Players
  `351:keyup:${VK_DOWN}`,
  `360:keydown:${VK_RETURN}`,
  `361:keyup:${VK_RETURN}`,
  `500:png:${snapPng}`,
].join(',');

const cmd = `node "${RUN}" --exe="${EXE}" --args=-quick --batch-size=200000 --max-batches=520 --input='${inputSpec}' --trace-api=CheckMenuItem --quiet-api --no-close`;
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
checks.push({ name: '2 Players checked via menu', pass: /CheckMenuItem\([^)]*0x00000199,\s*0x00000008\)/.test(out) });
checks.push({ name: 'snapshot written', pass: fs.existsSync(snapPng) && fs.statSync(snapPng).size > 1000 });

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
console.log(`Snapshot: ${snapPng}`);
process.exit(failed > 0 ? 1 : 0);
