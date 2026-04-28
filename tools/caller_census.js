#!/usr/bin/env node
// Caller census: count runtime hits for every static call site of a given callee.
//
// Uses the WASM-native --count infrastructure (set_count/get_count, up to 16
// slots) so the run executes at full speed — no BATCH_SIZE=1 forced by JS-side
// trace-at fan-out. The probe address is `callsite + 5` (the post-call landing
// of a 5-byte e8 call), reliably a basic-block entry that hit_count counts.
//
// Usage:
//   node tools/caller_census.js --exe=PATH --module=NAME --callee=0xVA [run.js args...]
//
//   --exe=PATH       main exe path passed to run.js
//   --module=NAME    module that contains the callee + callers (e.g. d3drm).
//   --callee=0xVA    static VA of callee (in <module>'s preferred image base)
//   --pe=PATH        override PE path used for static xref scan (default:
//                    test/binaries/dlls/<module>.dll, or --exe if module=exe)
//   --max-callers=N  cap N static call sites traced (default 16, hard limit of WASM)
//
// All other args are forwarded to test/run.js (e.g. --args=, --max-batches=, --no-close).

const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
function getArg(name, def = null) {
  const pre = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(pre)) {
      const v = args[i].slice(pre.length);
      args.splice(i, 1);
      return v;
    }
  }
  return def;
}

const EXE = getArg('exe');
const MODULE = getArg('module');
const CALLEE = getArg('callee');
const PE_OVERRIDE = getArg('pe');
const MAX_CALLERS = Math.min(parseInt(getArg('max-callers', '16')), 16);

if (!EXE || !MODULE || !CALLEE) {
  console.error('Usage: node tools/caller_census.js --exe=PATH --module=NAME --callee=0xVA [run.js args...]');
  process.exit(1);
}

const peFile = PE_OVERRIDE
  || (MODULE.toLowerCase() === 'exe' ? EXE : path.join('test/binaries/dlls', `${MODULE}.dll`));

// 1. Static scan: who calls the callee?
const xrefsRun = spawnSync('node', ['tools/xrefs.js', peFile, CALLEE, '--code']);
if (xrefsRun.status !== 0) {
  console.error(xrefsRun.stderr.toString());
  process.exit(1);
}
const callerVAs = [];
for (const line of xrefsRun.stdout.toString().split('\n')) {
  const m = line.match(/^\s+(0x[0-9a-fA-F]+)\s+\[.+?\]\s+branch/);
  if (m) callerVAs.push(m[1].toLowerCase());
}
if (callerVAs.length === 0) {
  console.error(`no static callers found for ${CALLEE} in ${peFile}`);
  process.exit(1);
}
const callers = callerVAs.slice(0, MAX_CALLERS);
const truncated = callerVAs.length > MAX_CALLERS;
console.log(`[census] ${callerVAs.length} static call sites${truncated ? ` (counting first ${MAX_CALLERS})` : ''}`);

// 2. Probe address = callsite + 5 (post-call landing — reliable block entry).
const probeVAs = callers.map(va => '0x' + ((parseInt(va, 16) + 5) >>> 0).toString(16));
const countSpec = probeVAs.map(va => `${MODULE}+${va}`).join(',');

// 3. Run with --count (no batch-size penalty).
const runArgs = [
  'test/run.js',
  `--exe=${EXE}`,
  `--count=${countSpec}`,
  ...args,
];
const runResult = spawnSync('node', runArgs, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
if (runResult.status !== 0) console.error(`[census] WARN: run.js exited with status ${runResult.status}`);
if (runResult.error) console.error(`[census] WARN: spawn error: ${runResult.error.message}`);
const out = (runResult.stdout || Buffer.from('')).toString() + (runResult.stderr || Buffer.from('')).toString();

// 4. Parse the [count] readout from run.js (lines like "  0xADDR = N").
const counts = {};
let inCountBlock = false;
for (const line of out.split('\n')) {
  if (/\[count\]/i.test(line) || /^Hit counts:/i.test(line)) { inCountBlock = true; continue; }
  if (inCountBlock) {
    const m = line.match(/^\s+(0x[0-9a-fA-F]+)\s*=\s*(\d+)/);
    if (m) counts[m[1].toLowerCase()] = parseInt(m[2], 10);
    else if (line.trim() === '') inCountBlock = false;
  }
}

// 5. Resolve runtime VAs and report.
const dllLine = out.split('\n').find(l => new RegExp(`DLL: ${MODULE}\\.dll`, 'i').test(l));
let delta = 0;
if (dllLine) {
  const m = dllLine.match(/at 0x([0-9a-fA-F]+).*origBase=0x([0-9a-fA-F]+)/);
  if (m) delta = (parseInt(m[1], 16) - parseInt(m[2], 16)) >>> 0;
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`[census] total caller hits: ${total} (delta=0x${delta.toString(16)})`);
console.log('callsite_va       probe_va          runtime_probe     hits');
for (const callsite of callers) {
  const probe = (parseInt(callsite, 16) + 5) >>> 0;
  const rt = ((probe + delta) >>> 0).toString(16).padStart(8, '0');
  const hits = counts['0x' + rt] || 0;
  console.log(`${callsite.padEnd(18)}0x${probe.toString(16).padEnd(16)}0x${rt.padEnd(16)}${hits}`);
}
