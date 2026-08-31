// test/test-run-pinned-wasm.js — a pinned wasm artifact is a promise about WHICH
// module is under test, and test/run.js now refuses to break that promise
// quietly.
//
// `--wasm=PATH` and `$WINE_ASSEMBLY_WASM` exist so one unmodified test file can
// be run twice against two different artifacts — that is the whole basis of the
// legacy-vs-WATX differential in tools/watx-matrix.js. Two ways the pin used to
// be honoured in name only, both verified against the real tool:
//
//   1. A path that does not exist fell through to compiling from src/. So a
//      typo'd path, or a stale $WINE_ASSEMBLY_WASM, ran the CANONICAL build and
//      reported a perfectly ordinary verdict about a module nobody asked for.
//      In the matrix both columns then compile the same source and agree with
//      each other by construction: a green differential that measured one
//      compiler twice.
//
//   2. A corrupt artifact reached WebAssembly.compile(), whose rejection lands
//      in run.js's `main().catch` — which prints the error and deliberately
//      leaves the exit code at 0 so guest threads still get stopped. Right for a
//      guest fault mid-run; wrong here, because a caller that pinned an artifact
//      and got exit 0 has been told the artifact works.
//
// Both are now fatal, and only when a pin was actually given: with no --wasm= and
// no $WINE_ASSEMBLY_WASM, a missing build/wine-assembly.wasm still falls back to
// compiling from src/, which is what --no-build's ordinary users rely on.
//
// Run: node test/test-run-pinned-wasm.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(ROOT, 'test', 'run.js');
const EXE = path.join(ROOT, 'test', 'binaries', 'notepad.exe');

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got === undefined ? '' : ` (${got})`}`); }
}

// Run run.js and capture code + output. Everything here is expected to die long
// before a guest boots, so the batch budget is tiny and the timeout short.
function runIt(extraArgs, env) {
  try {
    const stdout = execFileSync('timeout', ['-s', 'KILL', '90', process.execPath, RUN,
      `--exe=${EXE}`, '--no-build', '--max-batches=1', '--quiet-api', ...extraArgs], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return {
      code: e.status === undefined || e.status === null ? -1 : e.status,
      out: String(e.stdout || '') + String(e.stderr || ''),
    };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-pinned-'));
const missing = path.join(tmp, 'no-such-artifact.wasm');
const corrupt = path.join(tmp, 'corrupt.wasm');
// A file that exists, is nonempty, and is not a wasm module: right magic number,
// then garbage, so it is read and reaches WebAssembly.compile() rather than being
// rejected as an empty read.
fs.writeFileSync(corrupt, Buffer.concat([
  Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  Buffer.from('this is not a section'.repeat(8)),
]));
ck('the corrupt fixture really is invalid wasm', !WebAssembly.validate(fs.readFileSync(corrupt)));

// --- 1. A missing pinned path, both spellings. -------------------------------
{
  const viaFlag = runIt([`--wasm=${missing}`], {});
  ck('--wasm= at a missing path exits nonzero', viaFlag.code !== 0, viaFlag.code);
  ck('...and names the path it could not find',
    viaFlag.out.includes(missing), viaFlag.out.split('\n')[0]);
  ck('...and says it refused to compile from src/ instead',
    /refusing to silently compile from src\//.test(viaFlag.out));
  ck('...and names --wasm= as the pin', /--wasm=/.test(viaFlag.out));

  const viaEnv = runIt([], { WINE_ASSEMBLY_WASM: missing });
  ck('$WINE_ASSEMBLY_WASM at a missing path exits nonzero', viaEnv.code !== 0, viaEnv.code);
  ck('...and names the path', viaEnv.out.includes(missing));
  ck('...and names the environment variable as the pin',
    /\$WINE_ASSEMBLY_WASM/.test(viaEnv.out), viaEnv.out.split('\n').slice(0, 2).join(' | '));
}

// --- 2. A corrupt pinned artifact. -------------------------------------------
{
  const r = runIt([`--wasm=${corrupt}`], {});
  ck('a corrupt pinned artifact exits nonzero', r.code !== 0, r.code);
  ck('...and says the pinned artifact failed to compile',
    /pinned wasm artifact failed to compile/.test(r.out), r.out.split('\n')[0]);
  ck('...and names the artifact', r.out.includes(corrupt));

  const viaEnv = runIt([], { WINE_ASSEMBLY_WASM: corrupt });
  ck('a corrupt artifact pinned through the environment also exits nonzero',
    viaEnv.code !== 0, viaEnv.code);
}

// --- 3. NO pin: unchanged. ----------------------------------------------------
// The canonical build path is not required to exist for --no-build to work; that
// case compiles from src/ and always did. Asserting it here is what stops the fix
// above from being over-applied — this is the ordinary use of --no-build and it
// must not have become fatal.
{
  const canonical = path.join(ROOT, 'build', 'wine-assembly.wasm');
  ck('no pin + no --wasm= does not take the fatal path',
    !/pinned wasm artifact/.test(runIt([], {}).out),
    fs.existsSync(canonical) ? 'canonical build present' : 'canonical build absent');
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
