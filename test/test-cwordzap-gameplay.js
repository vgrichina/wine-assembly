#!/usr/bin/env node
// CLI gameplay coverage for CWordZap. Uses deterministic EasyZap coordinates in
// test/run.js's 640x480 renderer, avoiding the browser harness entirely.

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'wep32-community', 'Wordzap', 'CWordZap.exe');

const START = [
  '20:post-cmd:40003',
  '60:click:282:358',
];

const INVALID_NHR = [
  '100:click:96:190',
  '110:click:289:256',
  '120:click:226:256',
  '135:click:281:367',
];

const VALID_HUG = [
  '100:click:289:256',
  '110:click:226:190',
  '120:click:160:256',
  '135:click:281:367',
];

function runScenario(name, input, maxBatches = 520) {
  let out = '';
  let status = 0;
  try {
    out = execFileSync('node', [
      RUN,
      `--exe=${EXE}`,
      `--max-batches=${maxBatches}`,
      '--batch-size=100000',
      '--no-close',
      '--quiet-api',
      '--quiet-blocks',
      `--input=${input.join(',')}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    status = e.status ?? 1;
  }
  return { name, out, status };
}

function assertNoCrash(result) {
  assert.strictEqual(result.status, 0, `${result.name}: runner should exit cleanly\n${result.out}`);
  assert(!/STUCK|CRASH|RuntimeError|LinkError|UNIMPLEMENTED API:/i.test(result.out),
    `${result.name}: should not report crash markers\n${result.out}`);
  assert(!/\[ExitProcess\]|--- Program exited ---/.test(result.out),
    `${result.name}: guest should not exit during gameplay\n${result.out}`);
}

function assertMainWindow(result) {
  assert(/window:.*visible=true .*dialog=false .*title="C L A S S I C  W O R D Z A P \/ EasyZap/.test(result.out),
    `${result.name}: main EasyZap window should remain visible\n${result.out}`);
}

const scenarios = [
  {
    name: 'invalid word opens tip and stays alive',
    input: [
      ...START,
      ...INVALID_NHR,
      '190:dump-windows:invalid-tip',
      '260:stop',
    ],
    check(result) {
      assert(/Classic WordZap Tip Number 1/.test(result.out), 'invalid word should open the word-list tip');
      assert(/not in the word list/.test(result.out), 'invalid word tip text should be shown');
      assertMainWindow(result);
    },
  },
  {
    name: 'invalid word can be dismissed and repeated',
    input: [
      ...START,
      ...INVALID_NHR,
      '170:dlg-click:1',
      '210:click:398:443',
      '250:click:96:190',
      '260:click:289:256',
      '270:click:226:256',
      '285:click:281:367',
      '330:dlg-click:1',
      '430:dump-windows:repeat-invalid',
      '500:stop',
    ],
    check(result) {
      assert((result.out.match(/Classic WordZap Tip Number 1/g) || []).length >= 2,
        'repeat invalid word should show the tip again');
      assertMainWindow(result);
    },
  },
  {
    name: 'valid word submits without invalid-word tip',
    input: [
      ...START,
      ...VALID_HUG,
      '220:dump-windows:valid-hug',
      '300:stop',
    ],
    check(result) {
      assert(!/not in the word list/.test(result.out), 'valid HUG should not show invalid-word tip');
      assertMainWindow(result);
    },
  },
  {
    name: 'valid word then invalid word recovers',
    input: [
      ...START,
      ...VALID_HUG,
      '200:click:96:190',
      '210:click:289:256',
      '220:click:226:256',
      '235:click:281:367',
      '270:dlg-click:1',
      '430:dump-windows:valid-then-invalid',
      '500:stop',
    ],
    check(result) {
      assert(/Classic WordZap Tip Number 1/.test(result.out), 'invalid word after valid word should show the tip');
      assertMainWindow(result);
    },
  },
  {
    name: 'do-not-show invalid tip path stays alive',
    input: [
      ...START,
      ...INVALID_NHR,
      '170:dlg-click:2',
      '230:click:398:443',
      '270:click:96:190',
      '280:click:289:256',
      '290:click:226:256',
      '305:click:281:367',
      '420:dump-windows:noshow-invalid',
      '600:stop',
    ],
    maxBatches: 620,
    check(result) {
      assertMainWindow(result);
    },
  },
];

let failed = 0;
for (const scenario of scenarios) {
  const result = runScenario(scenario.name, scenario.input, scenario.maxBatches || 520);
  try {
    assertNoCrash(result);
    scenario.check(result);
    console.log(`PASS  CWordZap ${scenario.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  CWordZap ${scenario.name}`);
    console.log(e.message);
  }
}

process.exit(failed ? 1 : 0);
