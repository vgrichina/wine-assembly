#!/usr/bin/env node
// Winamp NSIS installer regression.
//
// Runs both installer EXEs in silent mode and verifies the durable result:
// the installed Winamp tree appears in the VFS. Also drives the normal NSIS
// wizard path with real canvas mouse clicks until the install worker completes,
// the modal installer exits, and the installed files appear in the VFS.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createCanvas, loadImage } = require('../lib/canvas-compat');

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

async function countNearBlackPixels(pngPath, rect) {
  const img = await loadImage(pngPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      if (data[i] < 35 && data[i + 1] < 35 && data[i + 2] < 35) count++;
    }
  }
  return count;
}

async function countNonBtnFacePixels(pngPath, rect) {
  const img = await loadImage(pngPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      const delta = Math.abs(data[i] - 192) + Math.abs(data[i + 1] - 192) + Math.abs(data[i + 2] - 192);
      if (delta > 30) count++;
    }
  }
  return count;
}

async function countHighlightPixels(pngPath, rect) {
  const img = await loadImage(pngPath);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * img.width + x) * 4;
      if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] >= 80 && data[i + 2] <= 170) count++;
    }
  }
  return count;
}

async function diffPixelsInRect(aPath, bPath, rect) {
  const a = await loadImage(aPath);
  const b = await loadImage(bPath);
  const ca = createCanvas(a.width, a.height);
  const cb = createCanvas(b.width, b.height);
  const xa = ca.getContext('2d');
  const xb = cb.getContext('2d');
  xa.drawImage(a, 0, 0);
  xb.drawImage(b, 0, 0);
  const da = xa.getImageData(0, 0, a.width, a.height).data;
  const db = xb.getImageData(0, 0, b.width, b.height).data;
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * a.width + x) * 4;
      const delta = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      if (delta > 30) count++;
    }
  }
  return count;
}

async function main() {
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
      '--max-batches=700',
      '--batch-size=5000',
      '--input=600:dlg-dump:license',
      `--png="${pngPath}"`,
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
    const wizardButtonInk = pngOk
      ? await countNonBtnFacePixels(pngPath, { x: 8, y: 268, w: 412, h: 40 })
      : 0;
    const licenseChecks = [
      { name: 'license RichEdit mapped to native edit', pass: /id=1000 cls=2 style=0x50a00804/.test(licenseOut) },
      { name: 'license text uses word-wrapped DrawText', pass: /gdi_draw_text\(0x5000d, 0x[0-9a-f]+, 0x[0-9a-f]+, 0x[0-9a-f]+, 16, 0\) \u2192 0x[1-9][0-9a-f]+/.test(licenseOut) },
      { name: 'license page PNG captured', pass: pngOk },
      { name: 'license wizard buttons are visible', pass: wizardButtonInk > 700 },
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
      {
        name: 'canvas scrollbar down arrow scrolls license text',
        input: '600:click:400:250,620:dlg-send:1000:206:0:0',
        pattern: /dlg-send: id=1000 .* msg=0xce .* firstVisible=1/,
      },
      {
        name: 'canvas scrollbar thumb drag scrolls license text',
        input: '600:mousedown:403:99,610:mousemove:403:165,620:mouseup:403:165,640:dlg-send:1000:206:0:0',
        pattern: /dlg-send: id=1000 .* msg=0xce .* firstVisible=[1-9][0-9]*/,
        png: path.join(__dirname, 'output', 'winamp295-license-scrolled.png'),
      },
    ];

    for (const probe of scrollProbes) {
      if (probe.png) {
        try { fs.unlinkSync(probe.png); } catch (_) {}
      }
      const scrollCmd = [
        `node "${RUN}"`,
        `--exe="${tc.exe}"`,
        '--max-batches=680',
        '--batch-size=5000',
        `--input=${probe.input}${probe.png ? `,660:png:${probe.png}` : ''}`,
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

      if (probe.png) {
        const pngCaptured = fs.existsSync(probe.png) && fs.statSync(probe.png).size > 10000;
        let strayInk = Number.POSITIVE_INFINITY;
        if (pngCaptured) {
          strayInk = await countNearBlackPixels(probe.png, { x: 8, y: 22, w: 412, h: 50 });
        }
        const clipPass = pngCaptured && strayInk < 500;
        console.log((clipPass ? 'PASS  ' : 'FAIL  ') +
          `scrolled license text stays clipped above RichEdit (${strayInk} stray dark pixels)`);
        if (!clipPass) failed++;
      }
    }
    console.log('');

    const pressedBase = path.join(__dirname, 'output', 'winamp295-scrollbar-base.png');
    const pressedHeld = path.join(__dirname, 'output', 'winamp295-scrollbar-held.png');
    const pressedCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=650',
      '--batch-size=5000',
      `--input=600:png:${pressedBase},610:mousedown:400:250,620:png:${pressedHeld},630:mouseup:400:250`,
      '--quiet-api',
    ].join(' ');

    console.log('$', pressedCmd);

    try {
      execSync(pressedCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (_) {}

    const pressedPngsOk =
      fs.existsSync(pressedBase) && fs.statSync(pressedBase).size > 10000 &&
      fs.existsSync(pressedHeld) && fs.statSync(pressedHeld).size > 10000;
    const downArrowDiff = pressedPngsOk
      ? await diffPixelsInRect(pressedBase, pressedHeld, { x: 397, y: 241, w: 16, h: 16 })
      : 0;
    const pressedChecks = [
      { name: 'scrollbar down arrow shows pressed state while held', pass: downArrowDiff > 20 },
    ];

    console.log(`${tc.name} scrollbar visuals`);
    for (const c of pressedChecks) {
      console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name + ` (${downArrowDiff} px)`);
      if (!c.pass) failed++;
    }
    console.log('');

    const clickCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=760',
      '--batch-size=5000',
      '--input=600:mousedown:373:283,620:mouseup:373:283',
      '--quiet-api',
    ].join(' ');

    console.log('$', clickCmd);

    let clickOut = '';
    try {
      clickOut = execSync(clickCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (e) {
      clickOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    }

    const clickChecks = [
      { name: 'canvas I Agree single-click advances installer', pass: /Winamp Setup: Installation Options/.test(clickOut) },
      { name: 'canvas I Agree single-click does not crash', pass: !/\*\*\* CRASH|RuntimeError|UNIMPLEMENTED API/.test(clickOut) },
    ];

    console.log(`${tc.name} canvas button input`);
    for (const c of clickChecks) {
      console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
      if (!c.pass) failed++;
    }
    console.log('');

    const stagePngs = [
      { name: 'license', path: path.join(__dirname, 'output', 'winamp295-stage-01-license.png') },
      { name: 'options', path: path.join(__dirname, 'output', 'winamp295-stage-02-options.png') },
      { name: 'folder', path: path.join(__dirname, 'output', 'winamp295-stage-03-folder.png') },
      { name: 'installing files', path: path.join(__dirname, 'output', 'winamp295-stage-04-installing-files.png') },
    ];
    for (const stage of stagePngs) {
      try { fs.unlinkSync(stage.path); } catch (_) {}
    }

    const stageCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=1100',
      '--batch-size=5000',
      [
        `--input=580:png:${stagePngs[0].path}`,
        '600:mousedown:373:283',
        '620:mouseup:373:283',
        `760:png:${stagePngs[1].path}`,
        '800:mousedown:373:283',
        '820:mouseup:373:283',
        `900:png:${stagePngs[2].path}`,
        '1000:mousedown:373:283',
        '1020:mouseup:373:283',
        `1022:png:${stagePngs[3].path}`,
      ].join(','),
      '--quiet-api',
    ].join(' ');

    console.log('$', stageCmd);

    try {
      execSync(stageCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (_) {}

    console.log(`${tc.name} wizard stage PNG sequence`);
    for (const stage of stagePngs) {
      const minBytes = stage.name === 'installing files' ? 1000 : 10000;
      const ok = fs.existsSync(stage.path) && fs.statSync(stage.path).size > minBytes;
      console.log((ok ? 'PASS  ' : 'FAIL  ') + `${stage.name} stage PNG captured`);
      if (!ok) failed++;
    }
    for (const stage of stagePngs.slice(1)) {
      const staleInk = fs.existsSync(stage.path)
        ? await countNearBlackPixels(stage.path, { x: 45, y: 20, w: 180, h: 12 })
        : Number.POSITIVE_INFINITY;
      const clean = staleInk < 10;
      console.log((clean ? 'PASS  ' : 'FAIL  ') +
        `${stage.name} stage has no stale upper-page text (${staleInk} dark pixels)`);
      if (!clean) failed++;
    }
    const stage4StatusInk = fs.existsSync(stagePngs[3].path)
      ? await countNonBtnFacePixels(stagePngs[3].path, { x: 48, y: 35, w: 130, h: 12 })
      : 0;
    const stage4HiddenDetailsInk = fs.existsSync(stagePngs[3].path)
      ? await countNonBtnFacePixels(stagePngs[3].path, { x: 2, y: 70, w: 18, h: 40 })
      : Number.POSITIVE_INFINITY;
    const stage4StatusOk = stage4StatusInk > 120;
    const stage4HiddenDetailsOk = stage4HiddenDetailsInk < 10;
    console.log((stage4StatusOk ? 'PASS  ' : 'FAIL  ') +
      `installing stage paints status label (${stage4StatusInk} ink pixels)`);
    console.log((stage4HiddenDetailsOk ? 'PASS  ' : 'FAIL  ') +
      `installing stage does not paint hidden details button fragments (${stage4HiddenDetailsInk} ink pixels)`);
    if (!stage4StatusOk) failed++;
    if (!stage4HiddenDetailsOk) failed++;
    console.log('');

    const optionsPng = path.join(__dirname, 'output', 'winamp295-options-page.png');
    const optionsCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=760',
      '--batch-size=5000',
      '--input=600:mousedown:373:283,620:mouseup:373:283,700:png:' + optionsPng,
      '--quiet-api',
    ].join(' ');

    console.log('$', optionsCmd);

    try {
      execSync(optionsCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (_) {}

    const optionsPngOk = fs.existsSync(optionsPng) && fs.statSync(optionsPng).size > 10000;
    console.log(`${tc.name} options page`);
    console.log((optionsPngOk ? 'PASS  ' : 'FAIL  ') + 'options page PNG captured');
    if (!optionsPngOk) failed++;
    console.log('');

    const folderPng = path.join(__dirname, 'output', 'winamp295-folder-page.png');
    const folderCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=900',
      '--batch-size=5000',
      '--input=600:mousedown:373:283,620:mouseup:373:283,800:mousedown:373:283,820:mouseup:373:283,821:png:' + folderPng,
      '--quiet-api',
    ].join(' ');

    console.log('$', folderCmd);

    try {
      execSync(folderCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (_) {}

    const folderPngOk = fs.existsSync(folderPng) && fs.statSync(folderPng).size > 10000;
    const hiddenCheckboxInk = folderPngOk
      ? await countNonBtnFacePixels(folderPng, { x: 24, y: 164, w: 24, h: 24 })
      : Number.POSITIVE_INFINITY;
    const backButtonInk = folderPngOk
      ? await countNonBtnFacePixels(folderPng, { x: 259, y: 271, w: 75, h: 24 })
      : 0;
    const installButtonInk = folderPngOk
      ? await countNonBtnFacePixels(folderPng, { x: 337, y: 271, w: 75, h: 24 })
      : 0;
    const folderChecks = [
      { name: 'folder page PNG captured', pass: folderPngOk },
      { name: 'hidden checkbox remains unpainted', pass: hiddenCheckboxInk < 10 },
      { name: 'folder Back button is not overdrawn by page controls', pass: backButtonInk > 350 },
      { name: 'folder Install button is not overdrawn by page controls', pass: installButtonInk > 500 },
    ];

    console.log(`${tc.name} folder page`);
    for (const c of folderChecks) {
      console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
      if (!c.pass) failed++;
    }
    console.log('');

    const installingPng = path.join(__dirname, 'output', 'winamp295-installing-files.png');
    const installingCmd = [
      `node "${RUN}"`,
      `--exe="${tc.exe}"`,
      '--max-batches=1040',
      '--batch-size=5000',
      '--input=600:mousedown:373:283,620:mouseup:373:283,800:mousedown:373:283,820:mouseup:373:283,1000:mousedown:373:283,1020:mouseup:373:283,1021:dlg-dump:all,1022:dlg-send:1004:1025:0:6553600,1023:dlg-send:1004:1026:60:0,1024:png:' + installingPng,
      '--quiet-api',
    ].join(' ');

    console.log('$', installingCmd);

    let installingOut = '';
    try {
      installingOut = execSync(installingCmd, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 80 * 1024 * 1024,
      });
    } catch (e) {
      installingOut = (e.stdout || '').toString() + (e.stderr || '').toString();
    }

    const installingPngOk = fs.existsSync(installingPng) && fs.statSync(installingPng).size > 1000;
    const installingStatusInk = installingPngOk
      ? await countNonBtnFacePixels(installingPng, { x: 48, y: 35, w: 130, h: 12 })
      : 0;
    const installingHiddenDetailsInk = installingPngOk
      ? await countNonBtnFacePixels(installingPng, { x: 2, y: 70, w: 18, h: 40 })
      : Number.POSITIVE_INFINITY;
    const installingProgressFill = installingPngOk
      ? await countHighlightPixels(installingPng, { x: 50, y: 52, w: 358, h: 14 })
      : 0;
    const installingChecks = [
      { name: 'installing page dialog has WAT child geometry', pass: /hwnd=0x10021 id=0 cls=0 style=0x50000448 xy=10,10 wh=399,227/.test(installingOut) },
      { name: 'installing page maps progress controls to native ProgressBar', pass: /id=1004 cls=17/.test(installingOut) && /id=1005 cls=17/.test(installingOut) },
      { name: 'installing page maps details pane to native ListView', pass: /id=1016 cls=18/.test(installingOut) },
      { name: 'installing page PNG captured', pass: installingPngOk },
      { name: `installing page paints status label (${installingStatusInk} ink pixels)`, pass: installingStatusInk > 120 },
      { name: `installing page paints progress fill (${installingProgressFill} highlight pixels)`, pass: installingProgressFill > 1000 },
      { name: `installing page does not paint hidden details fragments (${installingHiddenDetailsInk} ink pixels)`, pass: installingHiddenDetailsInk < 10 },
    ];

    console.log(`${tc.name} installing page`);
    for (const c of installingChecks) {
      console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
      if (!c.pass) failed++;
    }
    console.log('');
  }

  const interactiveCmd = [
    `node "${RUN}"`,
    `--exe="${tc.exe}"`,
    '--max-batches=800000',
    '--batch-size=5000',
    '--input=600:mousedown:373:283,620:mouseup:373:283,800:mousedown:373:283,820:mouseup:373:283,1000:mousedown:373:283,1020:mouseup:373:283',
    '--dump-vfs',
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
    { name: 'interactive real click accepted license', pass: /Winamp Setup: Installation Options/.test(interactiveOut) },
    { name: 'interactive real click reached install folder', pass: /Winamp Setup: Installation Folder/.test(interactiveOut) },
    { name: 'interactive reached Installing Files', pass: /Winamp Setup: Installing Files/.test(interactiveOut) },
    { name: 'interactive worker started', pass: /CreateThread handle=/.test(interactiveOut) },
    { name: 'interactive returned from installer', pass: /\[Exit\] code=/.test(interactiveOut) },
    ...tc.expected.map(p => ({ name: `interactive VFS has ${p}`, pass: interactiveOut.includes(p) })),
  ];

  console.log(`${tc.name} interactive`);
  for (const c of interactiveChecks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
    if (!c.pass) failed++;
  }
  console.log('');
}

process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
