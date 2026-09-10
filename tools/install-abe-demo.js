#!/usr/bin/env node
'use strict';

// Only the original guest WinZip self-extractor decompresses the payload.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlSession } = require('../test/control-session');

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'test/binaries/shareware/abe');
const INSTALLER_HASH = '179a2d7c0bab674cb28167d0a37ec74570fd2d6b589094d045a400633f2a33ab';
const GUEST_DIR = "c:\\program files\\abe's oddysee demo";
const HASHES = {
  'abedemo.exe': '21a5a8ddd021293f091c9bcee41cb729c52c73f6b79bfed0ecf18cce6176c343',
  'c1.lvl': 'e8395b7e8c3610d2cdf36635700f9155942fb8ad3a9e0be1a40758456dba7c64',
  'demoopen.ddv': '87b9ab111da48a2d128baca3d621787cf0351c0e54c9244d69cf5376944c6601',
  'gamebgn.ddv': 'a6451f2a63ace6ac13eba37d88f3c1cba48c7adb5d61929a6d72c5840a2339fc',
  'r1.lvl': 'c908097351c4e0aa688453d98d709ecc1c50b56477b653a7ebf6df9d8743b034',
  'r1p18p19.ddv': '5bfc292e2daada44318474ce805eb754e0f6302264ebbcafbd7209ffebc287f0',
  'r1p19p18.ddv': 'd2da3201848b5fab25d8b03be39af33a25523e12e1f5f68e481c41b8bc233492',
  'readme.txt': 'a1aa89fc64a4be9f55f336e0ce8e7293bf2541f5dedbe23f392bbea729740dfc',
  's1.lvl': '74249ff3841325b91f412090ac9aa04bae63ced82b9bf752ddb442111d6293ed',
};

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyCapture(capture) {
  const launch = JSON.parse(fs.readFileSync(path.join(capture, 'launch.json'), 'utf8'));
  assert.strictEqual(launch.schemaVersion, 1);
  assert.strictEqual(launch.guestExe, `${GUEST_DIR}\\abedemo.exe`);
  assert.strictEqual(launch.directory, GUEST_DIR);
  assert.strictEqual(launch.args, '');
  assert.strictEqual(launch.exe, "program files/abe's oddysee demo/abedemo.exe");
  const installed = path.join(capture, 'program files', "abe's oddysee demo");
  assert.deepStrictEqual(fs.readdirSync(installed).sort(), Object.keys(HASHES).sort());
  let bytes = 0;
  for (const [name, expected] of Object.entries(HASHES)) {
    const file = path.join(installed, name);
    assert(fs.lstatSync(file).isFile(), `installer output is not a file: ${name}`);
    assert.strictEqual(hash(file), expected, `installer output mismatch: ${name}`);
    bytes += fs.statSync(file).size;
  }
  assert.strictEqual(bytes, 54625942);
  return installed;
}

async function install({ installer, output, screenshot }) {
  assert(!fs.existsSync(output), `refusing to replace existing output: ${output}`);
  assert.strictEqual(hash(installer), INSTALLER_HASH, 'not the pinned original ABEODD.EXE');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-abe-installer-'));
  const capture = path.join(temp, 'capture');
  const session = startControlSession([
    path.join(ROOT, 'test/run.js'), `--exe=${installer}`,
    '--no-build', '--no-threads', '--quiet-api', '--quiet-blocks', '--no-close',
    '--max-seconds=180', '--batch-size=100000', '--control-stdin', '--frozen',
    `--capture-launch=${capture}`,
  ], { cwd: ROOT, idPrefix: 'abe-install-' });
  async function step(n) {
    const reply = await session.step(n);
    assert.strictEqual(reply.ran, n, 'installer stopped before the requested boundary');
    assert.strictEqual(reply.frozen, true);
  }
  try {
    try {
      await step(30);
      assert(session.output().includes('The demo will automatically run when unzipped.'),
        'original startup notice did not appear');
      await session.send('dlg-cmd:1');
      await step(50);
      // Deliver the button notification through host input. The modal pump
      // retains its guest callback stack while the long extraction yields.
      await session.send('dlg-input-click:1');
      for (let i = 0; i < 5; i++) {
        await step(1000);
        console.log(`Abe installer: ${(i + 1) * 1000} extraction steps`);
      }
      assert(session.output().includes('9 file(s) unzipped successfully'),
        'original installer did not report successful extraction');
      if (screenshot) {
        fs.mkdirSync(path.dirname(screenshot), { recursive: true });
        await session.send({ action: 'png', path: screenshot });
      }
      await session.send('dlg-cmd:1');
      await step(50);
    } finally {
      const code = await session.quit({ ignoreReplyError: true });
      fs.writeFileSync(path.join(temp, 'installer.log'), session.output());
      assert.strictEqual(code, 0, 'installer CLI failed');
    }
    assert(!/\[max-seconds\]|ABANDONED|UNIMPLEMENTED API|RuntimeError|\*\*\* CRASH/.test(session.output()),
      'installer hit a deadline or compatibility failure');
    const installed = verifyCapture(capture);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.cpSync(installed, output, { recursive: true, errorOnExist: true, force: false });
    console.log(`PASS  original Abe installer: 9 verified files (54625942 bytes) at ${output}`);
    fs.rmSync(temp, { recursive: true });
  } catch (error) {
    throw new Error(`${error.message}\nInstaller diagnostics retained at ${temp}`);
  }
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find(item => item.startsWith(prefix));
  return value ? path.resolve(value.slice(prefix.length)) : fallback;
}

if (require.main === module) {
  install({
    installer: arg('installer', path.join(PACKAGE, 'Abes_Oddysee_demo/ABEODD.EXE')),
    output: arg('output', path.join(PACKAGE, 'installed')),
    screenshot: arg('screenshot'),
  }).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { install, verifyCapture };
