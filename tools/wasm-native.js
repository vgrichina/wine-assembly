#!/usr/bin/env node

'use strict';

// What does a wasm JIT actually make of one of our handlers?
//
//   node tools/wasm-native.js --func='$th_rle_run'
//   node tools/wasm-native.js --index=914 --limit=80
//   node tools/wasm-native.js --top=20            # biggest functions, named
//
// WHY THIS EXISTS: every performance argument in this project ends at the same
// wall -- "the JIT probably does X". A handler that looks tight in WAT can come
// out of the compiler with a spilled loop, a redundant bounds check per access,
// or a call where a tail call was written, and nothing in a batches/s number
// says which. This prints the machine code.
//
// HOW, and what the number is NOT. Node's V8 is a release build: --print-code
// and --print-wasm-code are compiled out, and attaching a debugger to read the
// JIT pages is refused by macOS. SpiderMonkey's shell, though, exposes
// wasmExtractCode(module, tier), which hands back the native code AND a
// segment table naming each function index -- no debugger, no privileges. So
// the disassembly here is **SpiderMonkey Ion**, not V8 TurboFan. The two are
// different compilers and will differ in register allocation and instruction
// selection. What carries across is everything structural: how many loads a
// handler really performs, whether a bounds check survived, whether the loop
// body stayed in registers, how big the function is. Read it for that, and do
// not quote a cycle count from it as "what Chrome does".
//
// The disassembly is for the HOST architecture (this box is arm64; a run on an
// Intel box disassembles x86-64), because the compiler runs here.
//
// Needs the SpiderMonkey shell and a GNU objdump:
//   npx jsvu@latest --engines=spidermonkey     (installs ~/.jsvu/bin/sm)
//   brew install binutils                      (gobjdump, -b binary)
// Point $SM / $OBJDUMP elsewhere to override.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { scan } = require('./func-index');

const ROOT = path.join(__dirname, '..');
const DEFAULT_WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');
const COMBINED = path.join(ROOT, 'build', 'combined.wat');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
function flag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

// The shells and disassemblers this looks for, in order. Each is a real
// install path on a normal box; none of them is bundled.
function findTool(envVar, candidates, hint) {
  if (process.env[envVar]) return process.env[envVar];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  console.error(`${envVar} not found. Tried:\n  ${candidates.join('\n  ')}\n${hint}`);
  process.exit(1);
}

// Function indices count imports first, then definitions in source order --
// the same walk tools/func-index.js does, so the names cannot drift apart.
// `--wat=` points the name table at some other module's source, so this works
// on anything we compile and not just the shipped build -- e.g. a toyvm module
// with a JIT region in it (tools/toyvm/region-jit.js --emit=).
function nameTable(watPath) {
  if (!fs.existsSync(watPath)) {
    console.error(watPath === COMBINED
      ? `${COMBINED} is missing; run bash tools/build.sh first.`
      : `${watPath} is missing (--wat=)`);
    process.exit(1);
  }
  const { imports, defined } = scan(fs.readFileSync(watPath, 'utf8'));
  const byIndex = new Map();
  imports.forEach((f, i) => byIndex.set(i, f.name));
  defined.forEach((f, i) => byIndex.set(imports.length + i, f.name));
  const byName = new Map();
  for (const [i, n] of byIndex) if (!byName.has(n)) byName.set(n, i);
  return { byIndex, byName, importCount: imports.length };
}

function extract(smPath, wasmPath, tier, outBin) {
  const script = `
const bytes = os.file.readFile(${JSON.stringify(wasmPath)}, 'binary');
const mod = new WebAssembly.Module(bytes);
const c = wasmExtractCode(mod, ${JSON.stringify(tier)});
if (!c) { print('ERR no code for tier ${tier}'); quit(1); }
const segs = c.segments.filter(s => s.funcIndex !== undefined);
os.file.writeTypedArrayToFile(${JSON.stringify(outBin)}, c.code);
print('JSON' + JSON.stringify(segs.map(s =>
  [s.funcIndex, s.funcBodyBegin, s.funcBodyEnd])));
`;
  const tmp = path.join(os.tmpdir(), `wasm-native-${process.pid}.js`);
  fs.writeFileSync(tmp, script);
  try {
    const out = execFileSync(smPath, [`--wasm-compiler=${tier === 'ion' ? 'ion' : 'baseline'}`, tmp],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
    const line = out.split('\n').find(l => l.startsWith('JSON'));
    if (!line) {
      console.error(out.trim() || 'the shell produced no segment table');
      process.exit(1);
    }
    return JSON.parse(line.slice(4));
  } finally {
    fs.unlinkSync(tmp);
  }
}

function disassemble(objdump, bin, begin, end) {
  // GNU objdump's raw-binary mode. Apple's llvm-objdump has no -b binary, which
  // is why this looks for gobjdump specifically.
  const machine = process.arch === 'arm64' ? 'aarch64' : 'i386:x86-64';
  // objdump numbers the blob from its own start; --adjust-vma cannot take a
  // negative, so the rebase to "offset within this function" happens in the
  // caller, on the printed addresses.
  return execFileSync(objdump, [
    '-b', 'binary', '-m', machine, '-D',
    `--start-address=${begin}`, `--stop-address=${end}`, bin,
  ], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function main() {
  const wasmPath = path.resolve(arg('wasm', DEFAULT_WASM));
  const tier = arg('tier', 'ion');
  const limit = parseInt(arg('limit', '120'), 10);
  const top = arg('top', null);
  const keep = arg('out', null);

  const sm = findTool('SM', [
    path.join(os.homedir(), '.jsvu', 'bin', 'sm'),
    '/usr/local/bin/sm', '/opt/homebrew/bin/sm',
  ], 'Install it with:  npx jsvu@latest --engines=spidermonkey');

  const watPath = path.resolve(arg('wat', COMBINED));
  const names = nameTable(watPath);
  const bin = keep ? path.resolve(keep) : path.join(os.tmpdir(), `wasm-native-${process.pid}.bin`);

  const segs = extract(sm, wasmPath, tier, bin);
  const total = segs.reduce((a, s) => a + (s[2] - s[1]), 0);
  console.log(`${path.relative(ROOT, wasmPath)}: ${segs.length} functions, ` +
    `${(total / 1024).toFixed(0)}KB of ${tier} code for ` +
    `${(fs.statSync(wasmPath).size / 1024).toFixed(0)}KB of wasm ` +
    `(${(total / fs.statSync(wasmPath).size).toFixed(2)}x)`);

  try {
    if (top !== null) {
      const n = parseInt(top, 10) || 20;
      const rows = segs.slice().sort((a, b) => (b[2] - b[1]) - (a[2] - a[1])).slice(0, n);
      console.log('');
      console.log('largest functions:');
      for (const [idx, b, e] of rows) {
        console.log(`  ${String(e - b).padStart(7)} bytes  #${String(idx).padStart(5)}  ` +
          (names.byIndex.get(idx) || '(unnamed)'));
      }
      return;
    }

    let index = arg('index', null);
    const wanted = arg('func', null);
    if (index === null && wanted === null) {
      console.error('give --func=$name or --index=N (or --top=N)');
      process.exit(1);
    }
    if (index === null) {
      const key = wanted.startsWith('$') ? wanted : `$${wanted}`;
      if (!names.byName.has(key)) {
        console.error(`${key} is not a function in ${path.relative(ROOT, watPath)}`);
        process.exit(1);
      }
      index = names.byName.get(key);
    }
    index = parseInt(index, 10);

    const seg = segs.find(s => s[0] === index);
    if (!seg) {
      console.error(`#${index} (${names.byIndex.get(index) || '?'}) has no ${tier} code — ` +
        'it may be an import, or the compiler declined to tier it up.');
      process.exit(1);
    }
    const [, begin, end] = seg;
    console.log('');
    console.log(`#${index} ${names.byIndex.get(index) || '(unnamed)'}: ` +
      `${end - begin} bytes of ${tier} code, host arch ${process.arch}`);
    console.log('');

    const objdump = findTool('OBJDUMP', [
      '/opt/homebrew/opt/binutils/bin/objdump',
      '/usr/local/opt/binutils/bin/objdump',
      '/opt/homebrew/bin/gobjdump', '/usr/bin/gobjdump',
    ], 'Install it with:  brew install binutils');

    const text = disassemble(objdump, bin, begin, end);
    const lines = [];
    for (const l of text.split('\n')) {
      const m = l.match(/^\s*([0-9a-f]+):\t(.*)$/);
      if (!m) continue;
      const off = parseInt(m[1], 16) - begin;
      // Name the call targets. A direct call reads as a bare address, and
      // "does this handler still call out, and to what" is most of what this
      // tool is asked -- the answer is in the same segment table that found
      // this function. A target inside no segment is a runtime stub (trap,
      // instance call, GC barrier) and stays unnamed.
      const call = m[2].match(/\b(?:bl|callq?)\s+(?:\*?)0x([0-9a-f]+)/);
      const hit = call && segs.find(s => {
        const t = parseInt(call[1], 16);
        return t >= s[1] && t < s[2];
      });
      lines.push(`  ${off.toString(16).padStart(4, ' ')}:  ${m[2]}`
        + (hit ? `   ; ${names.byIndex.get(hit[0]) || `#${hit[0]}`}` : ''));
    }
    for (const l of lines.slice(0, limit)) console.log(l);
    if (lines.length > limit) {
      console.log(`  ... ${lines.length - limit} more instructions (--limit=${lines.length} for all)`);
    }
  } finally {
    if (!keep && fs.existsSync(bin)) fs.unlinkSync(bin);
  }
}

main();
