#!/usr/bin/env node
// Test the help system: HLP loading via WASM, help window creation
// Uses run.js as subprocess to avoid import stub issues.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN_JS = path.join(__dirname, 'run.js');

// Build first
console.log('Building WASM...');
execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });

const HELP_TESTS = [
  { exe: 'test/binaries/notepad.exe', hlp: 'test/binaries/help/notepad.hlp', name: 'Notepad' },
  { exe: 'test/binaries/calc.exe', hlp: 'test/binaries/help/calc.hlp', name: 'Calculator' },
  { exe: 'test/binaries/entertainment-pack/freecell.exe', hlp: 'test/binaries/help/freecell.hlp', name: 'FreeCell' },
  { exe: 'test/binaries/entertainment-pack/sol.exe', hlp: 'test/binaries/help/sol.hlp', name: 'Solitaire' },
  { exe: 'test/binaries/mspaint.exe', hlp: 'test/binaries/help/mspaint.hlp', name: 'MSPaint' },
];

console.log('\n=== Help System Tests ===\n');
let pass = 0, fail = 0, skip = 0;

for (const tc of HELP_TESTS) {
  const exePath = path.join(ROOT, tc.exe);
  const hlpPath = path.join(ROOT, tc.hlp);
  process.stdout.write(`  ${tc.name.padEnd(20)}`);

  if (!fs.existsSync(exePath)) { console.log('SKIP  exe not found'); skip++; continue; }
  if (!fs.existsSync(hlpPath)) { console.log('SKIP  hlp not found'); skip++; continue; }

  // Verify HLP magic
  const hlpData = fs.readFileSync(hlpPath);
  if (hlpData.readUInt32LE(0) !== 0x00035F3F) {
    console.log('FAIL  bad HLP magic');
    fail++;
    continue;
  }

  // Run exe with trace-api, check it reaches WinHelpA or runs OK
  const result = spawnSync('node', [
    RUN_JS, `--exe=${exePath}`, '--max-batches=100', '--no-build', '--trace-api',
  ], { cwd: ROOT, timeout: 30000, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });

  const output = (result.stdout || '') + (result.stderr || '');
  const hasWindow = output.includes('[CreateWindow]');
  const hasWinHelp = output.includes('WinHelpA');
  const crashed = /UNIMPLEMENTED.*FATAL|unreachable/.test(output) && !output.includes('DllMain trapped');
  const apiCount = (output.match(/\[API #/g) || []).length;

  if (crashed) {
    console.log(`FAIL  crashed (${apiCount} APIs)`);
    fail++;
  } else {
    console.log(`PASS  ${apiCount} APIs, window=${hasWindow}, WinHelpA=${hasWinHelp}, hlp=${hlpData.length}b`);
    pass++;
  }
}

console.log(`\n  Results: ${pass} pass, ${fail} fail, ${skip} skip`);
if (fail > 0) process.exit(1);
