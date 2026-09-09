#!/usr/bin/env node

'use strict';

// Run the original DOS PKSFX package and export only the files it creates.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runDos } = require('./toyvm/run-dos');

const ROOT = path.join(__dirname, '..');
const PACKAGE = path.join(ROOT, 'test/binaries/win98-games-a-d',
  'Dungeon Keeper Demo-SWonly');
const DEFAULT_INSTALLER = path.join(PACKAGE, 'KDDATA.EXE');
const DEFAULT_OUTPUT = path.join(PACKAGE, 'installed');
const INSTALLER_SHA256 = 'f121c2f77583e35a258617308f609aefbd73ca249974e3cdbac7520c4cdda92a';
const PAYLOAD_FILES = 166;
const PAYLOAD_BYTES = 19754866;
const PAYLOAD_HASHES = new Map([
  ['KEEPER95.EXE', '4d3cd6a7866520f360288b08440e0f20379b4b39216a9576c388e42fcdf72c84'],
  ['MSS32.DLL', 'fe46a580452a42796461cf98a66f79c65ef8494e0977d4665ac7a81305ee9644'],
  ['LEVELS/MAP00001.DAT', '57f068b16b43b42e268bcf03794a966debb1bf0524f6a4ce2d1f875cb60c7fa9'],
  ['SOUND/SOUND.DAT', '13e17c1ea44edb6b9bb5894e6c314ae2bc138fe6d864bf1d91aa972b3c4d7e8e'],
]);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function count(value) {
  const match = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(value).trim());
  if (!match) throw new Error(`invalid dispatch count: ${value}`);
  return Math.round(Number(match[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[
    match[2].toLowerCase()]);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filename) {
  return sha256Bytes(fs.readFileSync(filename));
}

function guestRelative(name) {
  const raw = String(name).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  const directory = raw.endsWith('/');
  const parts = raw.split('/').filter(Boolean);
  assert(parts.length && !parts.some(part => part === '.' || part === '..'),
    `unsafe installer output path: ${name}`);
  return { path: parts.join('/'), directory };
}

function recordFor(machine, relative) {
  const lower = relative.toLowerCase();
  const basename = path.posix.basename(lower);
  return machine.tempFiles.get(lower) || machine.tempFiles.get(basename) || null;
}

function manifestFor(directory) {
  const files = [];
  function walk(relative = '') {
    const entries = fs.readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && entry.name !== '.wine-assembly-browser.json' &&
               name.toLowerCase() !== 'keeper95.exe') {
        const portable = name.split(path.sep).join('/');
        files.push({ url: portable, vfsPath: `c:\\${portable.replace(/\//g, '\\')}` });
      }
    }
  }
  walk();
  return { schemaVersion: 1, files };
}

async function install({ installer, output, budget }) {
  assert(fs.existsSync(installer), `Dungeon Keeper installer is missing: ${installer}`);
  assert.strictEqual(sha256File(installer), INSTALLER_SHA256,
    'Dungeon Keeper installer does not match the pinned original package');

  const result = await runDos({
    exe: installer,
    guestArgs: '-d',
    budget,
    slice: 500000,
    stuckLimit: 0,
    sound: 'none',
    log: () => {},
  });
  assert(result.machine.exited,
    `KDDATA.EXE did not finish within ${budget} dispatches`);
  assert.strictEqual(result.machine.exitCode, 0, 'KDDATA.EXE reported extraction failure');

  const outputs = new Map();
  const directories = new Set();
  for (const name of result.machine.filesCreated) {
    const item = guestRelative(name);
    if (item.directory) {
      directories.add(item.path);
      continue;
    }
    outputs.set(item.path, recordFor(result.machine, item.path));
  }
  assert.strictEqual(outputs.size, PAYLOAD_FILES,
    `KDDATA.EXE emitted ${outputs.size} files, expected ${PAYLOAD_FILES}`);
  for (const [name, record] of outputs) {
    assert(record && record.len > 0, `KDDATA.EXE emitted an empty file: ${name}`);
  }
  const totalBytes = [...outputs.values()].reduce((sum, record) => sum + record.len, 0);
  assert.strictEqual(totalBytes, PAYLOAD_BYTES,
    `KDDATA.EXE emitted ${totalBytes} bytes, expected ${PAYLOAD_BYTES}`);

  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.dungeon-keeper-install-'));
  try {
    for (const directory of directories) {
      fs.mkdirSync(path.join(staging, ...directory.split('/')), { recursive: true });
    }
    for (const [name, record] of outputs) {
      const destination = path.join(staging, ...name.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(record.data.subarray(0, record.len)));
    }
    for (const [name, expected] of PAYLOAD_HASHES) {
      assert.strictEqual(sha256File(path.join(staging, ...name.split('/'))), expected,
        `installer output hash mismatch: ${name}`);
    }

    const manifest = manifestFor(staging);
    assert.strictEqual(manifest.files.length, PAYLOAD_FILES - 1,
      'browser manifest must contain every installer payload except KEEPER95.EXE');
    fs.writeFileSync(path.join(staging, '.wine-assembly-browser.json'),
      `${JSON.stringify(manifest, null, 2)}\n`);

    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(staging, output);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { files: outputs.size, bytes: totalBytes };
}

async function main() {
  const installer = path.resolve(arg('installer', DEFAULT_INSTALLER));
  const output = path.resolve(arg('output', DEFAULT_OUTPUT));
  const budget = count(arg('dispatches', '1b'));
  const result = await install({ installer, output, budget });
  console.log(`PASS  original Dungeon Keeper installer emitted ${result.files} files `
    + `(${result.bytes} bytes) to ${output}`);
}

module.exports = { install, guestRelative, manifestFor, recordFor };

if (require.main === module) {
  main().catch(error => {
    console.error(`FAIL  Dungeon Keeper installer: ${error.stack || error.message}`);
    process.exit(1);
  });
}
