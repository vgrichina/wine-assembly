#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveMediaPaths,
  chooseCandidate,
  closeMedia,
} = require('../lib/media-cli');
const { splitArgs, prepareLaunch, runnerArgsFor } = require('../tools/run-media');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-media-cli-test-'));
  let prepared;
  try {
    const cuePath = path.join(dir, 'disc.cue');
    const binPath = path.join(dir, 'track 01.bin');
    fs.writeFileSync(cuePath,
      'FILE "track 01.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    fs.writeFileSync(binPath, Buffer.alloc(2352));
    assert.deepStrictEqual(resolveMediaPaths([cuePath]).sort(), [cuePath, binPath].sort(),
      'a CUE argument should automatically include every referenced track file');

    const plan = { exeCandidates: [
      { path: 'D:\\setup.EXE', name: 'setup.EXE', autorun: true },
      { path: 'D:\\setup_de.EXE', name: 'setup_de.EXE' },
    ] };
    assert.strictEqual(chooseCandidate(plan).path, 'D:\\setup.EXE');
    assert.strictEqual(chooseCandidate(plan, 'setup_de.exe').path, 'D:\\setup_de.EXE');
    assert.throws(() => chooseCandidate(plan, 'missing.exe'), /not an executable candidate/);

    const parsed = splitArgs(['/disc', '--media-exe=setup.exe', '--max-batches=4']);
    assert.deepStrictEqual(parsed.mediaPaths, ['/disc']);
    assert.strictEqual(parsed.requestedExe, 'setup.exe');
    assert.deepStrictEqual(parsed.runnerArgs, ['--max-batches=4']);

    const notepad = path.join(__dirname, 'binaries', 'notepad.exe');
    prepared = await prepareLaunch([notepad], null);
    assert.strictEqual(prepared.candidate.path, 'C:\\NOTEPAD.EXE');
    assert.deepStrictEqual(fs.readFileSync(prepared.exePath), fs.readFileSync(notepad),
      'the loader copy should be the selected mounted executable byte-for-byte');
    const runner = runnerArgsFor(prepared, ['--max-batches=1']);
    assert(runner.includes(`--media-mount=${path.resolve(notepad)}`));
    assert(runner.includes('--media-exe=C:\\NOTEPAD.EXE'));
    assert.strictEqual(runner[runner.length - 1], '--max-batches=1');

    const runSource = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    assert.match(runSource, /analyzeMediaPaths\(MEDIA_MOUNTS/,
      'the headless runner should mount the original media with the shared importer');
    assert.match(runSource, /residentWin16Module\(ctx\.vfs, name\)/,
      'runtime Win16 helpers extracted by an installer should stage from the mounted VFS');
    console.log('test-media-cli: PASS');
  } finally {
    if (prepared) {
      closeMedia(prepared);
      fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
