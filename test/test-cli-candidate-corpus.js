#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { compileWatSnapshot } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const MANIFEST_PATH = path.join(__dirname, 'candidate-corpus', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const ASSET_ROOT = path.resolve(ROOT, manifest.assetRoot);
const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const dryRun = argv.includes('--dry-run');
const strict = argv.includes('--strict');
const idArg = argv.find(arg => arg.startsWith('--id='));
const selectedIds = idArg
  ? new Set(idArg.slice('--id='.length).split(',').map(value => value.trim()).filter(Boolean))
  : null;

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node test/test-cli-candidate-corpus.js [--id=a,b] [--list] [--dry-run] [--strict]');
  process.exit(2);
}

function fixtureId(candidate) {
  return candidate.fixture || candidate.id;
}

function walkFiles(directory, output = []) {
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(filename, output);
    else if (entry.isFile() && fs.statSync(filename).size > 0) output.push(filename);
  }
  return output;
}

function isRunnableX86(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(descriptor, dos, 0, dos.length, 0) !== dos.length) return false;
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return false;
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > fs.fstatSync(descriptor).size - 2) return false;
    const signature = Buffer.alloc(2);
    if (fs.readSync(descriptor, signature, 0, signature.length, peOffset) !== signature.length) return false;
    if (signature.toString('binary') === 'NE') return true;
    if (peOffset > fs.fstatSync(descriptor).size - 26) return false;
    const pe = Buffer.alloc(26);
    if (fs.readSync(descriptor, pe, 0, pe.length, peOffset) !== pe.length) return false;
    return pe.toString('binary', 0, 4) === 'PE\0\0'
      && pe.readUInt16LE(4) === 0x14c
      && pe.readUInt16LE(24) === 0x10b;
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveExecutable(candidate) {
  const fixtureRoot = path.join(ASSET_ROOT, fixtureId(candidate));
  const files = walkFiles(fixtureRoot);
  for (const requested of candidate.executables) {
    const normalized = requested.replace(/\\/g, '/').toLowerCase();
    const exact = files.find(filename => path.relative(fixtureRoot, filename).replace(/\\/g, '/').toLowerCase() === normalized);
    if (exact && isRunnableX86(exact)) return exact;
    const basename = path.basename(normalized);
    const byName = files.find(filename => path.basename(filename).toLowerCase() === basename && isRunnableX86(filename));
    if (byName) return byName;
  }
  return null;
}

function classify(output, status, signal, error) {
  if (/compile-wat:|\[CompileError|WebAssembly\.compile|unknown func:|unknown op:/i.test(output)) {
    return { status: 'HARNESS', reason: 'WAT build/compile failure' };
  }
  const unimplemented = output.match(/UNIMPLEMENTED API:\s*([^\r\n]+)/i);
  if (unimplemented) return { status: 'BLOCKED', reason: `unimplemented API ${unimplemented[1].trim()}` };
  if (error && error.code === 'ETIMEDOUT') return { status: 'BLOCKED', reason: 'timeout' };
  const missingDll = output.match(/(?:cannot|failed to) (?:load|resolve)[^\r\n]*\.dll[^\r\n]*/i);
  if (missingDll) return { status: 'BLOCKED', reason: missingDll[0].trim() };
  const marker = output.match(/(?:RuntimeError|LinkError|CRASH|STUCK)[^\r\n]*/i);
  if (marker) return { status: 'BLOCKED', reason: marker[0].trim().slice(0, 180) };
  if (signal) return { status: 'BLOCKED', reason: `terminated by ${signal}` };
  if (status !== 0) return { status: 'BLOCKED', reason: `runner exit ${status}` };
  return { status: 'READY', reason: 'bounded CLI smoke completed without a crash marker' };
}

function runCandidate(candidate, executable, wasmPath) {
  const cli = candidate.cli || {};
  const args = [
    RUN,
    `--exe=${executable}`,
    `--wasm=${wasmPath}`,
    '--no-build',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
    '--stuck-after=50',
    `--max-batches=${cli.maxBatches || 80}`,
    `--batch-size=${cli.batchSize || 10000}`,
  ];
  if (cli.args) args.push(`--args=${cli.args}`);
  if (cli.cue) {
    const cue = path.join(ASSET_ROOT, fixtureId(candidate), cli.cue);
    if (!fs.existsSync(cue)) throw new Error(`${candidate.id}.cli.cue is missing: ${cue}`);
    args.push(`--cue=${cue}`);
  }
  if (cli.dlls !== undefined) {
    if (!Array.isArray(cli.dlls) || !cli.dlls.length ||
        cli.dlls.some(filename => typeof filename !== 'string' || !filename.trim())) {
      throw new Error(`${candidate.id}.cli.dlls must be a non-empty string array`);
    }
    for (const filename of cli.dlls) {
      const dll = path.join(ASSET_ROOT, fixtureId(candidate), filename);
      if (!fs.existsSync(dll)) throw new Error(`${candidate.id}.cli.dlls is missing: ${dll}`);
      args.push(`--dll-seed=${dll}`);
    }
  }
  if (cli.vfsInclude !== undefined) {
    if (!Array.isArray(cli.vfsInclude) || !cli.vfsInclude.length ||
        cli.vfsInclude.some(pattern => typeof pattern !== 'string' || !pattern.trim())) {
      throw new Error(`${candidate.id}.cli.vfsInclude must be a non-empty string array`);
    }
    for (const pattern of cli.vfsInclude) args.push(`--vfs-include=${pattern}`);
  }
  const result = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: cli.timeoutMs || 120000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return classify(output, result.status, result.signal, result.error);
}

async function main() {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.candidates)) usage('unsupported candidate manifest');
  const ids = manifest.candidates.map(candidate => candidate.id);
  if (new Set(ids).size !== ids.length) usage('candidate IDs must be unique');
  const baldursGateSources = new Map([
    ['baldurs-gate-noninteractive-demo', [
      'https://archive.org/download/BALDUR/BALDUR.EXE',
      'e7caae4255e8ed570cef3a29642432c8d28ecdb9',
    ]],
    ['baldurs-gate-interactive-demo', [
      'https://archive.org/download/bg-demo/BG%20Demo.iso',
      '3796defce51a3e867aa216bc27f0be0689fdadf0',
    ]],
    ['baldurs-gate-chapters-1-2-demo', [
      'https://archive.org/download/20230723_20230723_0858/Baldur%27s%20Gate%20-%20Chapters%20I%20%26%20II%20%28USA%29%20%28Demo%29.zip',
      '2e5256bc8c418aec51ea39ef1a5bf8640dd3317a',
    ]],
  ]);
  for (const [id, [url, sha1]] of baldursGateSources) {
    const candidate = manifest.candidates.find(item => item.id === id);
    assert(candidate && candidate.localOnly, `${id} remains an ignored local-only fixture`);
    assert.deepStrictEqual(candidate.packages.map(pkg => [pkg.url, pkg.sha1]), [[url, sha1]],
      `${id} keeps its exact Archive.org artifact and SHA-1`);
    assert.deepStrictEqual(candidate.cli.vfsInclude, ['**/*'],
      `${id} mounts the complete extracted companion-file tree`);
  }
  const chapters = manifest.candidates.find(candidate =>
    candidate.id === 'baldurs-gate-chapters-1-2-demo');
  assert(chapters.postExtract.some(step => step.type === 'extractRawMode1Cd'),
    'Chapters I & II prepares its preserved MODE1/2352 BIN before InstallShield extraction');
  const civWin16 = manifest.candidates.find(candidate => candidate.id === 'civilization-2-win16');
  const civMge = manifest.candidates.find(candidate => candidate.id === 'civilization-2-mge-win32');
  assert(civWin16 && civMge && civWin16.localOnly && civMge.localOnly,
    'both Civilization II retail editions remain ignored local-only fixtures');
  assert(civWin16.executables.includes('cd/CIV2/CIV2.EXE'),
    'original Civilization II launches its Win16 NE executable from the extracted data track');
  assert(civWin16.postExtract.some(step => step.type === 'expandSzdd' &&
    step.from === 'cd/WING/WING.DL_' && step.into === 'cd/CIV2/WING.DLL'),
  'original Civilization II expands the retail WinG runtime beside its executable');
  assert(civMge.executables.includes('installed/civ2.exe'),
    'MGE launches the installed Win32 executable rather than the incomplete CD copy');
  assert.deepStrictEqual(civMge.cli.dlls, ['installed/XDaemon.dll'],
    'MGE preloads the installer-supplied XDaemon DLL required by civ2.exe');
  for (const candidate of [civWin16, civMge]) {
    assert(candidate.postExtract.some(step => step.type === 'extractRawMode1Cd'),
      `${candidate.id} prepares the MODE1/2352 data track`);
    assert(candidate.cli.cue && candidate.cli.vfsInclude.includes('**/*'),
      `${candidate.id} mounts its full local tree and mixed-mode CUE`);
  }
  if (selectedIds) {
    const unknown = [...selectedIds].filter(id => !ids.includes(id));
    if (unknown.length) usage(`unknown candidate IDs: ${unknown.join(', ')}`);
  }

  const candidates = manifest.candidates.filter(candidate => !selectedIds || selectedIds.has(candidate.id));
  if (listOnly) {
    for (const candidate of candidates) {
      const executable = resolveExecutable(candidate);
      console.log(`${executable ? 'LOCAL ' : 'MISSING'} ${candidate.id}\t${candidate.kind}\t${candidate.name} ${candidate.version}`);
    }
    return 0;
  }

  let wasmDirectory = null;
  let wasmPath = null;
  if (!dryRun) {
    try {
      const bytes = await compileWatSnapshot(file => fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
      await WebAssembly.compile(bytes);
      wasmDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-candidate-wasm-'));
      wasmPath = path.join(wasmDirectory, 'candidate-corpus.wasm');
      fs.writeFileSync(wasmPath, bytes);
    } catch (error) {
      console.error(`HARNESS candidate snapshot: ${error.message}`);
      return 1;
    }
  }

  let ready = 0;
  let blocked = 0;
  let skipped = 0;
  let harness = 0;
  try {
    for (const candidate of candidates) {
      const executable = resolveExecutable(candidate);
      if (!executable) {
        skipped++;
        const note = candidate.manual || `run tools/fetch-candidate-corpus.js --id=${fixtureId(candidate)}`;
        console.log(`SKIP    ${candidate.id}: ${note}`);
        continue;
      }
      if (dryRun) {
        ready++;
        console.log(`LOCAL   ${candidate.id}: ${path.relative(ROOT, executable)}`);
        continue;
      }
      const result = runCandidate(candidate, executable, wasmPath);
      console.log(`${result.status.padEnd(7)} ${candidate.id}: ${result.reason}`);
      if (result.status === 'READY') ready++;
      else if (result.status === 'BLOCKED') blocked++;
      else harness++;
    }
  } finally {
    if (wasmDirectory) fs.rmSync(wasmDirectory, { recursive: true, force: true });
  }

  console.log(`candidate CLI corpus: ${ready} ready/local, ${blocked} blocked, ${skipped} skipped, ${harness} harness failures`);
  return harness || (strict && blocked) ? 1 : 0;
}

main().then(code => process.exit(code)).catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
