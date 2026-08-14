#!/usr/bin/env node

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

const TABLE_COLUMNS = [
  { key: 'status', label: 'Status', max: 7 },
  { key: 'candidate', label: 'Candidate', max: 32 },
  { key: 'detail', label: 'Detail', max: 64 },
];

function printableCell(value, maximum) {
  const clean = String(value || '').replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 3)}...`;
}

function printStatusTable(rows) {
  const widths = TABLE_COLUMNS.map(column => Math.min(column.max, Math.max(
    column.label.length,
    ...rows.map(row => printableCell(row[column.key], column.max).length),
  )));
  const border = `+${widths.map(width => '-'.repeat(width + 2)).join('+')}+`;
  const render = row => `|${TABLE_COLUMNS.map((column, index) => (
    ` ${printableCell(row[column.key], column.max).padEnd(widths[index])} `
  )).join('|')}|`;
  console.log(border);
  console.log(render(Object.fromEntries(TABLE_COLUMNS.map(column => [column.key, column.label]))));
  console.log(border);
  for (const row of rows) console.log(render(row));
  console.log(border);
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

function isPe32X86(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(descriptor, dos, 0, dos.length, 0) !== dos.length) return false;
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) return false;
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > fs.fstatSync(descriptor).size - 26) return false;
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
    if (exact && isPe32X86(exact)) return exact;
    const basename = path.basename(normalized);
    const byName = files.find(filename => path.basename(filename).toLowerCase() === basename && isPe32X86(filename));
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
  const result = spawnSync('node', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: cli.timeoutMs || 20000,
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
  if (selectedIds) {
    const unknown = [...selectedIds].filter(id => !ids.includes(id));
    if (unknown.length) usage(`unknown candidate IDs: ${unknown.join(', ')}`);
  }

  const candidates = manifest.candidates.filter(candidate => !selectedIds || selectedIds.has(candidate.id));
  if (listOnly) {
    const rows = [];
    for (const candidate of candidates) {
      const executable = resolveExecutable(candidate);
      rows.push({
        status: executable ? 'LOCAL' : 'MISSING',
        candidate: candidate.id,
        detail: executable
          ? path.relative(ROOT, executable)
          : candidate.manual || `fetch fixture ${fixtureId(candidate)}`,
      });
    }
    printStatusTable(rows);
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
  const rows = [];
  try {
    for (const candidate of candidates) {
      const executable = resolveExecutable(candidate);
      if (!executable) {
        skipped++;
        const note = candidate.manual || `run tools/fetch-candidate-corpus.js --id=${fixtureId(candidate)}`;
        rows.push({
          status: 'SKIP',
          candidate: candidate.id,
          detail: note,
        });
        continue;
      }
      if (dryRun) {
        ready++;
        rows.push({
          status: 'LOCAL',
          candidate: candidate.id,
          detail: path.relative(ROOT, executable),
        });
        continue;
      }
      const result = runCandidate(candidate, executable, wasmPath);
      rows.push({
        status: result.status,
        candidate: candidate.id,
        detail: result.reason,
      });
      if (result.status === 'READY') ready++;
      else if (result.status === 'BLOCKED') blocked++;
      else harness++;
    }
  } finally {
    if (wasmDirectory) fs.rmSync(wasmDirectory, { recursive: true, force: true });
  }

  printStatusTable(rows);
  console.log(`candidate CLI corpus: ${ready} ready/local, ${blocked} blocked, ${skipped} skipped, ${harness} harness failures`);
  return harness || (strict && blocked) ? 1 : 0;
}

main().then(code => process.exit(code)).catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
