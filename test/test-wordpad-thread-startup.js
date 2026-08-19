#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found');
  process.exit(0);
}

const result = spawnSync(process.execPath, [
  RUN,
  `--exe=${EXE}`,
  '--max-batches=120',
  '--batch-size=50000',
  '--quiet-api',
  '--quiet-blocks',
  '--no-close',
  '--no-build',
  '--trace-thread',
  '--input=110:stop',
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 90000,
  maxBuffer: 32 * 1024 * 1024,
});

const output = `${result.stdout || ''}${result.stderr || ''}`;
const events = [];
for (const line of output.split('\n')) {
  const match = line.match(/^\[thread-event\] (\{.*\})$/);
  if (!match) continue;
  try { events.push(JSON.parse(match[1])); } catch (_) {}
}

const create = events.find(event => event.type === 'create' && (event.creationFlags & 0x4));
const matching = create ? events.filter(event => event.handle === create.handle) : [];
const resume = matching.find(event => event.type === 'resume');
const spawn = matching.find(event => event.type === 'spawn');
const firstRun = matching.find(event => event.type === 'first_run');
const betweenCreateAndResume = create && resume
  ? matching.filter(event => event.sequence > create.sequence && event.sequence < resume.sequence)
  : [];

const checks = [
  ['emulator completed inside 90 seconds', result.status === 0 && !result.signal && !result.error],
  ['WordPad created its top-level window', /\[CreateWindow\].*title="WordPad"/.test(output)],
  ['WordPad created a worker with CREATE_SUSPENDED', !!create && create.suspendCount === 1],
  ['the initial ResumeThread returned the previous suspend count',
    !!resume && resume.previousSuspendCount === 1 && resume.suspendCount === 0],
  ['the suspended worker did not run before ResumeThread',
    betweenCreateAndResume.every(event => event.type !== 'first_run')],
  ['the worker instance spawned only after becoming runnable',
    !!resume && !!spawn && resume.sequence < spawn.sequence && spawn.suspendCount === 0],
  ['the worker first ran after ResumeThread with the original entry point',
    !!spawn && !!firstRun && spawn.sequence < firstRun.sequence &&
      firstRun.startAddr === create.startAddr && firstRun.eip === create.startAddr &&
      firstRun.suspendCount === 0],
  ['no unimplemented API or runtime crash',
    !/UNIMPLEMENTED|CRASH|RuntimeError|Unreachable code/.test(output)],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
  if (!pass) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);

if (failed) {
  console.log('\nThread events:');
  for (const event of events) console.log(JSON.stringify(event));
  if (result.error) console.log(result.error.stack || result.error.message);
}
process.exit(failed ? 1 : 0);
