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
    probeLicensePage: true,
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

  if (tc.probeLicensePage) {
    const pngPath = path.join(__dirname, 'output', 'winamp295-license.png');
    const licenseCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=620',
      '--batch-size=5000',
      '--input=600:dlg-dump:license',
      `--png="${pngPath}"`,
      '--no-build',
      '--quiet-api',
      '--trace-host=gdi_draw_text',
    ].join(' ');

    console.log('$', licenseCmd);

    let licenseOut = '';
    try {
      licenseOut = execSync(licenseCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (e) {
      licenseOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    }

    const pngOk = fs.existsSync(pngPath) && fs.statSync(pngPath).size > 10000;
    const licenseChecks = [
      { name: 'license RichEdit mapped to native edit', pass: /id=1000 cls=2 style=0x50a00804/.test(licenseOut) },
      { name: 'license text uses word-wrapped DrawText', pass: /gdi_draw_text\(0x5000d, 0x[0-9a-f]+, 0x[0-9a-f]+, 0x[0-9a-f]+, 16, 0\) \u2192 0x[1-9][0-9a-f]+/.test(licenseOut) },
      { name: 'license page PNG captured', pass: pngOk },
    ];

    console.log(`${tc.name} license page`);
    for (const c of licenseChecks) {
      console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
      if (!c.pass) failed++;
    }
    console.log('');

    const scrollProbes = [
      {
        name: 'mouse wheel scrolls license text',
        input: '600:dlg-send:1000:522:-7864320:0',
        pattern: /dlg-send: id=1000 .* msg=0x20a .* firstVisible=3/,
      },
      {
        name: 'scrollbar down arrow scrolls license text',
        input: '600:dlg-send:1000:513:1:11469190,610:dlg-send:1000:514:0:11469190',
        pattern: /dlg-send: id=1000 .* msg=0x201 .* firstVisible=1/,
      },
      {
        name: 'scrollbar thumb drag scrolls license text',
        input: '600:dlg-send:1000:513:1:1573254,610:dlg-send:1000:512:1:5898630,620:dlg-send:1000:514:0:5898630',
        pattern: /dlg-send: id=1000 .* msg=0x200 .* firstVisible=54/,
      },
    ];

    for (const probe of scrollProbes) {
      const scrollCmd = [
        `node "${RUN}"`,
        `--exe="${tc.exe}"`,
        '--max-batches=680',
        '--batch-size=5000',
        `--input=${probe.input}`,
        '--no-build',
        '--quiet-api',
      ].join(' ');

      console.log('$', scrollCmd);

      let scrollOut = '';
      try {
        scrollOut = execSync(scrollCmd, {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 180000,
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 80 * 1024 * 1024,
        });
      } catch (e) {
        scrollOut = (e.stdout || '').toString() + (e.stderr || '').toString();
      }

      const pass = probe.pattern.test(scrollOut);
      console.log((pass ? 'PASS  ' : 'FAIL  ') + probe.name);
      if (!pass) failed++;
    }
    console.log('');
  }

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
