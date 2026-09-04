#!/usr/bin/env node
'use strict';

// Launch a dropped disc/archive through the headless runner. Analysis and the
// eventual guest mount both go through lib/media-import.js, matching the web
// picker; only the selected executable is materialized to a temporary host
// file because the PE/NE loader still accepts a host path.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { VirtualFS } = require('../lib/filesystem');
const { analyzeMediaPaths, closeMedia } = require('../lib/media-cli');

function usage() {
  return 'usage: node tools/run-media.js <media file-or-directory> [more files] ' +
    '[--media-exe=NAME] [test/run.js options]';
}

function splitArgs(argv) {
  const mediaPaths = argv.filter(value => !value.startsWith('--'));
  const runnerArgs = argv.filter(value => value.startsWith('--') &&
    !value.startsWith('--media-exe='));
  const requestedExe = (argv.find(value => value.startsWith('--media-exe=')) || '')
    .slice('--media-exe='.length) || null;
  return { mediaPaths, runnerArgs, requestedExe };
}

function guestDirectory(guestPath) {
  const at = guestPath.lastIndexOf('\\');
  return at >= 2 ? guestPath.slice(0, at) : guestPath.slice(0, 3);
}

async function prepareLaunch(mediaPaths, requestedExe) {
  const media = await analyzeMediaPaths(mediaPaths, { exePath: requestedExe });
  const vfs = new VirtualFS();
  await media.plan.mount(vfs);
  const exeBytes = await vfs.materialize(media.candidate.path);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-media-'));
  const exePath = path.join(tempDir, media.candidate.name);
  fs.writeFileSync(exePath, exeBytes);
  return { ...media, exeBytes, exePath, tempDir };
}

function runnerArgsFor(prepared, forwarded) {
  return [
    path.join(__dirname, '..', 'test', 'run.js'),
    `--exe=${prepared.exePath}`,
    ...prepared.paths.map(hostPath => `--media-mount=${hostPath}`),
    `--media-exe=${prepared.candidate.path}`,
    ...forwarded,
  ];
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const { mediaPaths, runnerArgs, requestedExe } = splitArgs(argv);
  if (!mediaPaths.length) throw new Error(usage());
  let prepared;
  try {
    prepared = await prepareLaunch(mediaPaths, requestedExe);
    console.log(`[media] ${prepared.plan.label}; label="${prepared.plan.volumeLabel || ''}"; ` +
      `${prepared.plan.entryCount} entries`);
    console.log(`[media] launching ${prepared.candidate.path}` +
      `${prepared.candidate.autorun ? ' (AUTORUN.INF)' : ''}`);
    const child = spawnSync(process.execPath, runnerArgsFor(prepared, runnerArgs), {
      stdio: 'inherit',
    });
    if (child.error) throw child.error;
    return child.status === null ? 1 : child.status;
  } finally {
    if (prepared) {
      closeMedia(prepared);
      fs.rmSync(prepared.tempDir, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(`run-media: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { usage, splitArgs, guestDirectory, prepareLaunch, runnerArgsFor, main };
