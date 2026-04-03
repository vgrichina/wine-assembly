#!/usr/bin/env node
// Automated smoke tests for all EXE binaries
// Runs each EXE with limited batches, checks for crashes vs clean exit

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RUN_JS = path.join(__dirname, 'run.js');

// All test binaries with their expected behavior
const TEST_CASES = [
  { exe: 'test/binaries/notepad.exe', name: 'Notepad' },
  { exe: 'test/binaries/calc.exe', name: 'Calculator' },
  { exe: 'test/binaries/entertainment-pack/ski32.exe', name: 'SkiFree' },
  { exe: 'test/binaries/entertainment-pack/freecell.exe', name: 'FreeCell' },
  { exe: 'test/binaries/entertainment-pack/sol.exe', name: 'Solitaire' },
  { exe: 'test/binaries/mspaint.exe', name: 'MSPaint (Win98)' },
  { exe: 'test/binaries/nt/mspaint.exe', name: 'MSPaint (NT)' },
  { exe: 'test/binaries/entertainment-pack/cruel.exe', name: 'Cruel' },
  { exe: 'test/binaries/entertainment-pack/golf.exe', name: 'Golf' },
  { exe: 'test/binaries/entertainment-pack/pegged.exe', name: 'Pegged' },
  { exe: 'test/binaries/entertainment-pack/snake.exe', name: 'Rattler Race' },
  { exe: 'test/binaries/entertainment-pack/taipei.exe', name: 'Taipei' },
  { exe: 'test/binaries/entertainment-pack/tictac.exe', name: 'TicTacToe' },
  { exe: 'test/binaries/xp/winmine.exe', name: 'Minesweeper (XP)' },
  // Entertainment Pack additions
  { exe: 'test/binaries/entertainment-pack/reversi.exe', name: 'Reversi' },
  { exe: 'test/binaries/entertainment-pack/winmine.exe', name: 'Minesweeper (WEP)' },
  // Win98 accessories
  { exe: 'test/binaries/win98-apps/wordpad.exe', name: 'WordPad' },
  { exe: 'test/binaries/win98-apps/write.exe', name: 'Write' },
  { exe: 'test/binaries/win98-apps/cdplayer.exe', name: 'CD Player' },
  { exe: 'test/binaries/win98-apps/mplayer.exe', name: 'Media Player' },
  { exe: 'test/binaries/win98-apps/mplay32.exe', name: 'Media Player 32' },
  { exe: 'test/binaries/win98-apps/fontview.exe', name: 'Font Viewer' },
  { exe: 'test/binaries/win98-apps/kodakimg.exe', name: 'Kodak Imaging' },
  { exe: 'test/binaries/win98-apps/kodakprv.exe', name: 'Kodak Preview' },
  { exe: 'test/binaries/win98-apps/hypertrm.exe', name: 'HyperTerminal' },
  { exe: 'test/binaries/win98-apps/sndvol32.exe', name: 'Volume Control' },
  { exe: 'test/binaries/win98-apps/sndrec32.exe', name: 'Sound Recorder' },
  { exe: 'test/binaries/win98-apps/explorer.exe', name: 'Explorer (98)' },
  { exe: 'test/binaries/win98-apps/regedit.exe', name: 'RegEdit' },
  { exe: 'test/binaries/win98-apps/taskman.exe', name: 'Task Manager' },
  { exe: 'test/binaries/win98-apps/welcome.exe', name: 'Welcome (98)' },
  { exe: 'test/binaries/win98-apps/tour98.exe', name: 'Win98 Tour' },
  { exe: 'test/binaries/win98-apps/sysmon.exe', name: 'System Monitor' },
  { exe: 'test/binaries/win98-apps/rsrcmtr.exe', name: 'Resource Meter' },
  { exe: 'test/binaries/win98-apps/winipcfg.exe', name: 'IP Config' },
  { exe: 'test/binaries/win98-apps/cleanmgr.exe', name: 'Disk Cleanup' },
  { exe: 'test/binaries/win98-apps/notepad98.exe', name: 'Notepad (98)' },
  { exe: 'test/binaries/win98-apps/vol98.exe', name: 'Volume (98)' },
  { exe: 'test/binaries/win98-apps/telnet.exe', name: 'Telnet' },
  // XP apps
  { exe: 'test/binaries/xp/claass.exe', name: 'Calculator (XP)' },
  { exe: 'test/binaries/xp/sndrec32.exe', name: 'Sound Recorder (XP)' },
  { exe: 'test/binaries/xp/xp_eos.exe', name: 'XP End of Life' },
  // Pinball
  { exe: 'test/binaries/pinball/pinball.exe', name: 'Space Cadet Pinball' },
  // Installers (NSIS etc.)
  { exe: 'test/binaries/installers/winamp291.exe', name: 'WinAmp Installer' },
  { exe: 'test/binaries/installers/mirc59.exe', name: 'mIRC Installer' },
];

const MAX_BATCHES = 50;
const BATCH_SIZE = 1000;

function runExe(testCase) {
  const exePath = path.join(ROOT, testCase.exe);
  if (!fs.existsSync(exePath)) {
    return { name: testCase.name, status: 'SKIP', reason: 'file not found' };
  }

  const args = [
    RUN_JS,
    `--exe=${exePath}`,
    `--max-batches=${MAX_BATCHES}`,
    `--batch-size=${BATCH_SIZE}`,
    '--no-build',
    '--verbose',
  ];

  const result = spawnSync('node', args, {
    cwd: ROOT,
    timeout: 30000,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,  // 50MB — MFC apps with DLLs generate lots of API trace output
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  const output = (result.stdout || '') + (result.stderr || '');
  const lines = output.split('\n');

  // Check for crash_unimplemented (missing API)
  const unimplMatch = output.match(/crash_unimplemented|unreachable|RuntimeError/);

  // Find all unique API calls — handles both --verbose ([API] Name) and --trace-api ([API #N] Name(...))
  const apiCalls = new Set();
  const apiPattern = /\[API[^\]]*\]\s*(\S+)/g;
  let m;
  while ((m = apiPattern.exec(output)) !== null) {
    const name = m[1].replace(/\(.*/, '');
    if (name) apiCalls.add(name);
  }

  // Check for window creation (sign of successful init)
  const hasWindow = output.includes('[CreateWindow]') || output.includes('[CreateDialog]');
  const hasShowWindow = output.includes('[ShowWindow]');
  const hasMessageLoop = /GetMessageA|GetMessageW|DispatchMessageA|DispatchMessageW/.test(output);
  const hasWmClose = output.includes('WM_CLOSE') || output.includes('0x10');
  const exitClean = output.includes('[Exit]');

  if (result.status !== 0 || unimplMatch) {
    // Find the specific unimplemented API
    const crashLines = lines.filter(l => /unreachable|unimplemented|RuntimeError/.test(l));
    // Last API before crash is likely the unimplemented one
    const apiLines = lines.filter(l => /\[API/.test(l));
    const crashApi = apiLines.length > 0 ? apiLines[apiLines.length - 1].trim() : '';

    return {
      name: testCase.name,
      status: 'CRASH',
      reason: crashApi || (crashLines[0] || 'unknown crash').trim(),
      apiCount: apiCalls.size,
      hasWindow,
    };
  }

  // Reached max batches without crash = likely working
  const windowOrLoop = hasWindow || hasMessageLoop;
  return {
    name: testCase.name,
    status: windowOrLoop ? 'OK' : 'WARN',
    reason: windowOrLoop
      ? `${apiCalls.size} APIs, ${hasWindow ? 'window created' : 'message loop running'}`
      : `${apiCalls.size} APIs, no window`,
    apiCount: apiCalls.size,
    hasWindow,
    hasShowWindow,
  };
}

// Build first (skip with --no-build)
const noBuild = process.argv.includes('--no-build');
if (!noBuild) {
  console.log('Building WASM...');
  execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  console.log('');
}

// Run all tests
console.log('=== Wine-Assembly EXE Smoke Tests ===\n');

const results = [];
for (const tc of TEST_CASES) {
  process.stdout.write(`  ${tc.name.padEnd(22)} ... `);
  const r = runExe(tc);
  results.push(r);

  const icon = r.status === 'OK' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : r.status === 'WARN' ? 'WARN' : 'FAIL';
  console.log(`${icon}  ${r.reason}`);
}

// Summary
console.log('\n=== Summary ===');
const pass = results.filter(r => r.status === 'OK').length;
const fail = results.filter(r => r.status === 'CRASH').length;
const warn = results.filter(r => r.status === 'WARN').length;
const skip = results.filter(r => r.status === 'SKIP').length;
console.log(`  PASS: ${pass}  FAIL: ${fail}  WARN: ${warn}  SKIP: ${skip}  Total: ${results.length}`);

if (fail > 0) {
  console.log('\nCrashed EXEs (need API implementations):');
  for (const r of results.filter(r => r.status === 'CRASH')) {
    console.log(`  ${r.name}: ${r.reason}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
