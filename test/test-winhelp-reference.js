#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'test', 'binaries', 'help');
const sourceViewer = path.join(sourceDir, 'winhlp32.exe');
const helpFile = path.join(root, 'test', 'binaries', 'help', 'freecell.hlp');
const screenshot = path.join(root, 'build', 'winhelp-reference.png');
const contentsScreenshot = path.join(root, 'build', 'winhelp-reference-contents.png');

if (!fs.existsSync(sourceViewer)) {
  console.log('WinHelp reference: SKIP (test/binaries/help/winhlp32.exe absent)');
  process.exit(0);
}

const bytes = fs.readFileSync(sourceViewer);
if (bytes.length !== 319488) throw new Error(`unexpected winhlp32.exe size: ${bytes.length}`);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
if (sha256 !== 'd18e766a5dec37a21775eb1933b67fd211e82cd4f8f83ca0824d9d443838fb0a') {
  throw new Error(`unexpected winhlp32.exe SHA-256: ${sha256}`);
}
if (!fs.existsSync(helpFile)) throw new Error('tracked Notepad HLP fixture is missing');
const cntHashes = {
  'calc.cnt': 'a8430a1738581d2c93f5fa143ccea136d1389dc3326baf7f80c80eae901ecb0f',
  'freecell.cnt': '762d191a211539d674eb417ef53cb987c3c075f74496d5f79969aed7a39bf3d6',
  'mspaint.cnt': '5f3dbd584fde1d084c7f905bd304f559e0caae21d20335993a607369c2bb411c',
  'notepad.cnt': '6813af47113136ec8e051829a1c385484fa791353e46fd07263cd1e1fe7d63ac',
  'wordpad.cnt': 'b2d877987272f1ca03704b9613022dbe181390bcab34e8f2187533a15163eba2',
};
for (const [name, expected] of Object.entries(cntHashes)) {
  const fixture = path.join(root, 'test', 'binaries', 'help', name);
  if (!fs.existsSync(fixture)) throw new Error(`Win98 Contents fixture is missing: ${name}`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
  if (actual !== expected) throw new Error(`unexpected ${name} SHA-256: ${actual}`);
}

// GID is WinHelp's generated browse/index cache. Build it in an isolated
// writable fixture directory so neither the Windows viewer nor its cache is
// shipped through a product path, and so clean test runs do not depend on a
// machine-local pre-generated GID.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-winhelp-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-winhelp-content-'));
process.on('exit', () => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(contentDir, { recursive: true, force: true });
});
for (const name of fs.readdirSync(sourceDir)) {
  const src = path.join(sourceDir, name);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(fixtureDir, name));
}
const commonControls = path.join(root, 'test', 'binaries', 'dlls', 'comctl32.dll');
if (!fs.existsSync(commonControls)) throw new Error('Win98 comctl32.dll fixture is missing');
fs.copyFileSync(commonControls, path.join(fixtureDir, 'comctl32.dll'));
const viewer = path.join(fixtureDir, 'winhlp32.exe');
for (const name of ['winhlp32.exe', 'freecell.hlp']) {
  fs.copyFileSync(path.join(sourceDir, name), path.join(contentDir, name));
}
fs.copyFileSync(commonControls, path.join(contentDir, 'comctl32.dll'));
const contentViewer = path.join(contentDir, 'winhlp32.exe');
for (const stem of ['notepad', 'freecell']) {
  const gid = path.join(fixtureDir, `${stem}.gid`);
  if (fs.existsSync(gid)) continue;
  const bootstrap = spawnSync(process.execPath, [
    path.join(root, 'test', 'run.js'),
    `--exe=${viewer}`,
    `--args=${stem}.hlp`,
    '--max-batches=500',
    '--no-build',
    '--quiet-api',
    '--quiet-blocks',
    `--save-vfs=${fixtureDir}`,
    '--save-vfs-suffix=.gid',
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 45000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (!fs.existsSync(gid) || fs.statSync(gid).size < 1000) {
    throw new Error(`WinHelp did not generate ${stem}.gid: ${bootstrap.stderr || bootstrap.stdout}`);
  }
}

fs.mkdirSync(path.dirname(screenshot), { recursive: true });
const run = spawnSync(process.execPath, [
  path.join(root, 'test', 'run.js'),
  `--exe=${contentViewer}`,
  '--args=freecell.hlp',
  '--screen=800x600',
  '--max-batches=500',
  '--no-build',
  '--quiet-api',
  '--quiet-blocks',
  '--input=300:dump-windows:winhelp',
  `--png=${screenshot}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 45000,
  env: { ...process.env, NODE_OPTIONS: '' },
});

const output = (run.stdout || '') + (run.stderr || '');
const failures = [];
if (!output.includes('[SetWindowText] "Free Cell"')) failures.push('viewer never loaded the embedded FreeCell topic');
if (output.includes('Help Topics: FreeCell Help')) failures.push('standalone HLP unexpectedly resolved through the mismatched CNT');
if (!fs.existsSync(screenshot) || fs.statSync(screenshot).size < 1000) failures.push('rendered screenshot is missing');
if (!/window:winhelp[^\n]*class="MS_WINTOPIC"[^\n]*size=\d+x([1-9]\d{2,})[^\n]*visible=true/.test(output)) {
  failures.push('Help topic child is not visible with a usable height');
}
if (!/window:winhelp[^\n]*class="MS_WINICON"[^\n]*size=\d+x([1-9]\d*)[^\n]*visible=true/.test(output)) {
  failures.push('WinHelp command-button bar is not visible');
}
for (const caption of ['Help &Topics', '&Back', '&Options']) {
  const line = output.split('\n').find(entry =>
    entry.includes('window:winhelp') && /class="button"/i.test(entry) &&
    entry.includes(`title="${caption}"`) && entry.includes('visible=true'));
  if (!line) {
    failures.push(`WinHelp command button is not visible: ${caption}`);
  }
}
if (fs.existsSync(screenshot)) {
  const png = PNG.sync.read(fs.readFileSync(screenshot));
  let darkTopicPixels = 0;
  let darkCommandBarPixels = 0;
  // The archived viewer restores this reference window at (115,18), placing
  // its 21px command bar at screen y=59. A hidden MS_WINICON parent leaves
  // this whole strip flat gray (zero dark pixels); the three rendered Button
  // borders and captions provide a stable visual assertion.
  for (let y = 59; y < Math.min(80, png.height); y++) {
    for (let x = 118; x < Math.min(313, png.width); x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] < 100 && png.data[offset + 1] < 100 &&
          png.data[offset + 2] < 100 && png.data[offset + 3] !== 0) {
        darkCommandBarPixels++;
      }
    }
  }
  if (darkCommandBarPixels < 400) {
    failures.push(`WinHelp command buttons were not rendered (${darkCommandBarPixels} dark pixels)`);
  }
  // The standalone HLP opens its one real embedded topic. Restrict the count
  // to that topic surface so window chrome cannot satisfy the assertion.
  for (let y = 84; y < Math.min(130, png.height); y++) {
    for (let x = 126; x < Math.min(440, png.width); x++) {
      const offset = (y * png.width + x) * 4;
      if (png.data[offset] < 100 && png.data[offset + 1] < 100 &&
          png.data[offset + 2] < 100 && png.data[offset + 3] !== 0) {
        darkTopicPixels++;
      }
    }
  }
  if (darkTopicPixels < 700) failures.push(`Help topic text was not rendered (${darkTopicPixels} dark pixels)`);
}
if (/UNIMPLEMENTED API|R6018|\*\*\* CRASH|FATAL:/.test(output)) failures.push('viewer hit a fatal compatibility path');
if (run.error && run.error.code !== 'ETIMEDOUT') failures.push(run.error.message);

const contentsRun = spawnSync(process.execPath, [
  path.join(root, 'test', 'run.js'),
  `--exe=${viewer}`,
  '--args=freecell.hlp',
  '--max-batches=320',
  '--no-build',
  '--quiet-api',
  '--quiet-blocks',
  '--input=80:click:145:68,180:dump-windows:contents,181:dump-tree:contents,210:stop',
  `--png=${contentsScreenshot}`,
], {
  cwd: root,
  encoding: 'utf8',
  timeout: 45000,
  env: { ...process.env, NODE_OPTIONS: '' },
});
const contentsOutput = (contentsRun.stdout || '') + (contentsRun.stderr || '');
if (!contentsOutput.includes('Help Topics: FreeCell Help')) {
  failures.push('authentic viewer did not open the FreeCell Contents dialog');
}
if (!/dump-tree:contents:[^\n]*state=0x22[^\n]*text="The object of FreeCell"[^\n]*text="Playing FreeCell"[^\n]*text="Strategies and tips"/.test(contentsOutput)) {
  failures.push('FreeCell Contents did not retain its selected three-topic TreeView');
}
if (!fs.existsSync(contentsScreenshot) || fs.statSync(contentsScreenshot).size < 1000) {
  failures.push('rendered FreeCell Contents screenshot is missing');
}
if (/UNIMPLEMENTED API|R6018|\*\*\* CRASH|FATAL:/.test(contentsOutput)) {
  failures.push('Contents dialog hit a fatal compatibility path');
}
if (contentsRun.error && contentsRun.error.code !== 'ETIMEDOUT') failures.push(contentsRun.error.message);

if (failures.length) {
  console.error((output + contentsOutput).slice(-16000));
  throw new Error(failures.join('; '));
}

console.log(`WinHelp reference: PASS (${path.relative(root, screenshot)}, ${path.relative(root, contentsScreenshot)})`);
