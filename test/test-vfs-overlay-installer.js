#!/usr/bin/env node
// The writable C:\ overlay, end to end through a real installer.
//
// docs/design-byo-media.md ⑤ exists so that "run the installer, keep the
// result" is true. The only honest proof of that is two processes: one runs
// the Winamp NSIS installer with --overlay-dir and exits, a second one starts
// with an unrelated executable and finds the installed tree already mounted.
// Nothing here matches a persistFiles glob — an arbitrary installer has none —
// and the tree is several megabytes, well past what the localStorage path caps
// at, which is the whole point of the phase.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const INSTALLER = path.join(__dirname, 'binaries', 'installers', 'winamp291.exe');
const CARRIER = path.join(__dirname, 'binaries', 'notepad.exe');

// Byte-exact expectations, taken from test/test-winamp-installers.js so the two
// tests cannot disagree about what a correct install contains.
const EXPECTED = [
  ['program files/winamp/winamp.exe', 846848],
  ['program files/winamp/plugins/in_mp3.dll', 141312],
  ['program files/winamp/plugins/out_wave.dll', 13824],
];

if (!fs.existsSync(INSTALLER) || !fs.existsSync(CARRIER)) {
  console.log(`SKIP  overlay installer round trip: missing ${
    fs.existsSync(INSTALLER) ? CARRIER : INSTALLER}`);
  process.exit(0);
}

function run(args, label) {
  try {
    return execFileSync('node', [RUN, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    const out = (error.stdout || '') + (error.stderr || '');
    console.log(`FAIL  ${label} did not complete: ${error.message}`);
    console.log(out.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-overlay-e2e-'));
const overlayDir = path.join(work, 'overlay');
const exportOne = path.join(work, 'export-install');
const exportTwo = path.join(work, 'export-hydrated');

let failures = 0;
function check(name, pass, detail) {
  console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass || !detail ? '' : `\n      ${detail}`));
  if (!pass) failures++;
}

// --- process 1: install ------------------------------------------------------

const install = run([
  `--exe=${INSTALLER}`, '--args=/S',
  '--max-batches=8000', '--batch-size=5000', '--quiet-api',
  '--overlay-flush-ms=1',
  `--overlay-dir=${overlayDir}`, `--save-vfs=${exportOne}`,
], 'installer run');

check('installer run did not crash',
  !/\*\*\* CRASH|RuntimeError|UNIMPLEMENTED API/.test(install));
const checkpoints = [...install.matchAll(/\[overlay\] checkpointed (\d+) record\(s\)/g)]
  .map(match => Number(match[1]));
const flushed = /\[overlay\] flushed (\d+) record\(s\)/.exec(install);
const persisted = checkpoints.reduce((sum, count) => sum + count, 0) +
  (flushed ? Number(flushed[1]) : 0);
check('the installer checkpointed before normal exit',
  checkpoints.some(count => count > 0),
  checkpoints.length ? `checkpoint counts: ${checkpoints.join(', ')}` : 'no checkpoint line');
check('the final overlay flush completed', !!flushed,
  'no final flush line in the run output');
check('the overlay persisted the installed tree across all checkpoints', persisted > 100,
  `only ${persisted} records across checkpoint + final flush`);
check('the flush reported no failures', !/\[overlay\] (?:checkpointed|flushed) .*failed/.test(install));

const index = JSON.parse(fs.readFileSync(path.join(overlayDir, 'index.json'), 'utf8'));
check('the store index is a version 1 record list',
  index.version === 1 && Array.isArray(index.records));
check('the journal holds whiteouts as well as files',
  index.records.some(r => r.kind === 'whiteout'),
  'the installer deletes its temporary files; those must be whiteouts');
const totalBytes = index.records.reduce((sum, r) => sum + (r.size | 0), 0);
check('the kept tree is past the localStorage per-file cap', totalBytes > 2 * 1024 * 1024,
  `${totalBytes} bytes journalled`);

// --- process 2: a different executable, same overlay -------------------------

const hydrate = run([
  `--exe=${CARRIER}`, '--max-batches=200', '--quiet-api',
  `--overlay-dir=${overlayDir}`, `--save-vfs=${exportTwo}`,
], 'hydration run');

const hydrated = /\[overlay\] .*hydrated (\d+) file\(s\), (\d+) dir\(s\), (\d+) whiteout\(s\)/
  .exec(hydrate);
check('the second process hydrated the overlay', !!hydrated && Number(hydrated[1]) > 100,
  hydrated ? `only ${hydrated[1]} files` : 'no hydrate line in the run output');
check('hydration reported no errors', !/\[overlay\] overlay: cannot hydrate/.test(hydrate));

for (const [rel, size] of EXPECTED) {
  const installed = path.join(exportOne, ...rel.split('/'));
  const revived = path.join(exportTwo, ...rel.split('/'));
  if (!fs.existsSync(installed) || !fs.existsSync(revived)) {
    check(`${rel} came back`, false,
      `installed=${fs.existsSync(installed)} hydrated=${fs.existsSync(revived)}`);
    continue;
  }
  const a = fs.readFileSync(installed);
  const b = fs.readFileSync(revived);
  check(`${rel} is byte-exact across the restart`,
    a.equals(b) && b.length === size, `${a.length} vs ${b.length} bytes, expected ${size}`);
}

// --- process 3: catchable termination flushes before exit -----------------

function signalFlush() {
  const signalDir = path.join(work, 'signal-overlay');
  const child = spawn('node', [RUN,
    `--exe=${INSTALLER}`, '--args=/S',
    '--max-batches=1000000', '--batch-size=5000', '--quiet-api',
    '--control-stdin', '--overlay-flush-ms=0',
    `--overlay-dir=${signalDir}`,
  ], {
    cwd: ROOT,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', chunk => { out += chunk.toString(); });
  child.stderr.on('data', chunk => { out += chunk.toString(); });
  const signal = setTimeout(() => child.kill('SIGTERM'), 1000);
  const hardStop = setTimeout(() => child.kill('SIGKILL'), 30000);
  return new Promise(resolve => {
    child.on('exit', code => {
      clearTimeout(signal);
      clearTimeout(hardStop);
      const line = /\[overlay\] SIGTERM flushed (\d+) record\(s\)/.exec(out);
      check('SIGTERM awaits an overlay flush before exit', !!line && code === 0,
        line ? `exit=${code}, records=${line[1]}` :
          `exit=${code}; tail=${out.split('\n').slice(-8).join(' | ')}`);
      let records = [];
      try {
        records = JSON.parse(fs.readFileSync(path.join(signalDir, 'index.json'), 'utf8')).records;
      } catch (_) { /* failed by the assertion below */ }
      check('the signal flush persisted progress made before termination', records.length > 0,
        `${records.length} records in the signal-time index`);
      resolve();
    });
  });
}

signalFlush().then(() => {
  fs.rmSync(work, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failing` : '\nOverlay installer round trip passes');
  process.exit(failures ? 1 : 0);
});
