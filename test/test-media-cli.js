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
const { hasPageScript } = require('./browser-runtime-scripts');

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
    const mediaHarnessSource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'run-media.js'), 'utf8');
    assert(hasPageScript('lib/media-import.js'),
      'the browser must load the media importer through the central source version');
    assert.match(runSource, /analyzeMediaPaths\(MEDIA_MOUNTS/,
      'the headless runner should mount the original media with the shared importer');
    assert.match(runSource, /residentWin16Module\(ctx\.vfs, name\)/,
      'runtime Win16 helpers extracted by an installer should stage from the mounted VFS');
    assert.match(runSource, /\(\(b\.zOrder \|\| 0\) - \(a\.zOrder \|\| 0\)\) \|\| \(\(b\.hwnd \|\| 0\) - \(a\.hwnd \|\| 0\)\)/,
      'dialog automation should prefer the newest wizard page when z-order values tie');
    assert.match(runSource, /action: 'set-win16-trace'/,
      'long CLI installer runs should be able to enable Win16 tracing only near a failure');
    assert.match(runSource, /setExeDrive\(instance\.exports, EXE_GUEST_PATH \|\| MEDIA_EXE\)/,
      'mounted-media processes should prefer an explicit executable path, then the selected media drive');
    assert.match(runSource, /ctx\.vfs\.materialize\(guestExe\)[\s\S]*?await capturedLaunch\.materialize/,
      'a provider-backed ShellExecute child must be resident before CLI capture exports it');
    const browserShellSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-shell.js'), 'utf8');
    assert.match(browserShellSource, /case 'cue:speed-demons':[\s\S]*?return compatDispatch \? 500 : 500000/,
      'the browser should give the measured Win16 installer copy loop a non-stalling quantum');
    assert.match(mediaHarnessSource, /const \{ spawn \} = require\('child_process'\)/);
    assert.doesNotMatch(mediaHarnessSource, /spawnSync/,
      'the media parent must keep its event loop live for --control-stdin commands');
    console.log('test-media-cli: PASS');
  } finally {
    if (prepared) {
      closeMedia(prepared);
      fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
