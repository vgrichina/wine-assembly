#!/usr/bin/env node
// Winamp NSIS installer regression.
//
// Runs both installer EXEs in silent mode and verifies the durable result:
// the installed Winamp tree appears in the VFS. Also drives the normal NSIS
// wizard path far enough to complete the install worker and return from the
// modal installer.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');

const CASES = [
  {
    name: 'Winamp 2.91 installer',
    exe: path.join(__dirname, 'binaries', 'installers', 'winamp291.exe'),
    expected: [
      'c:\\program files\\winamp\\winamp.exe (846848 bytes)',
      'c:\\program files\\winamp\\plugins\\in_mp3.dll (141312 bytes)',
      'c:\\program files\\winamp\\plugins\\out_wave.dll (13824 bytes)',
    ],
  },
  {
    name: 'Winamp 2.95 installer',
    exe: path.join(__dirname, 'binaries', 'installers', 'winamp295.exe'),
    expected: [
      'c:\\program files\\winamp\\winamp.exe (854016 bytes)',
      'c:\\program files\\winamp\\plugins\\in_mp3.dll (274944 bytes)',
      'c:\\program files\\winamp\\plugins\\out_wave.dll (13824 bytes)',
    ],
  },
];

let failed = 0;

for (const tc of CASES) {
  if (!fs.existsSync(tc.exe)) {
    console.log(`SKIP  ${tc.name}: missing ${tc.exe}`);
    continue;
  }

  const cmd = [
    `node "${RUN}"`,
    `--exe="${tc.exe}"`,
    '--args=/S',
    '--max-batches=8000',
    '--batch-size=5000',
    '--dump-vfs',
    '--no-build',
  ].join(' ');

  console.log('$', cmd);

  let out = '';
  try {
    out = execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 80 * 1024 * 1024,
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
  }

  const checks = [
    { name: 'no crash', pass: !/\*\*\* CRASH|RuntimeError|UNIMPLEMENTED API/.test(out) },
    { name: 'CreateProcessA reached', pass: /\[API\] CreateProcessA/.test(out) },
    ...tc.expected.map(p => ({ name: `VFS has ${p}`, pass: out.includes(p) })),
  ];

  console.log(tc.name);
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');

  const interactiveCmd = [
    `node "${RUN}"`,
    `--exe="${tc.exe}"`,
    '--max-batches=800000',
    '--batch-size=5000',
    '--input=590:0x111:1,610:0x111:1,630:0x111:1',
    '--no-build',
    '--quiet-api',
  ].join(' ');

  console.log('$', interactiveCmd);

  let interactiveOut = '';
  try {
    interactiveOut = execSync(interactiveCmd, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 80 * 1024 * 1024,
    });
  } catch (e) {
    interactiveOut = (e.stdout || '').toString() + (e.stderr || '').toString();
  }

  const interactiveChecks = [
    { name: 'interactive no crash', pass: !/\*\*\* CRASH|RuntimeError|UNIMPLEMENTED API|STUCK at EIP/.test(interactiveOut) },
    { name: 'interactive reached Installing Files', pass: /Winamp Setup: Installing Files/.test(interactiveOut) },
    { name: 'interactive worker started', pass: /CreateThread handle=/.test(interactiveOut) },
    { name: 'interactive returned from installer', pass: /\[Exit\] code=/.test(interactiveOut) },
  ];

  console.log(`${tc.name} interactive`);
  for (const c of interactiveChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
}

process.exit(failed ? 1 : 0);
