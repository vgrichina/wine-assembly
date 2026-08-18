#!/usr/bin/env node
// Winamp 2.91 audio playback regression.
//
// Drives Winamp through survey-dismiss, clicks the real Play button, and
// captures the raw PCM that out_wave.dll hands to waveOutWrite via
// --audio-out. If the pipeline (decode thread T3 + buffer thread T4 +
// deferred WHDR_DONE) is intact, in_mp3 decodes demo.mp3 and we get a few
// frames of stereo-interleaved 16-bit PCM @ 22050Hz out.
//
// Known CLI ceiling (see apps/winamp.md §SESSION 17): ~17 waveOutWrites
// (~39KB / 0.44s) before T4 deadlocks on WOM_DONE — so we only assert a
// lower bound. Anything > a couple of buffers proves audio is flowing.
//
// PASS criteria:
//   - Run exits within 30s (no hang)
//   - No UNIMPLEMENTED / unreachable / CRASH in output
//   - PCM file exists and is >= 8KB (at least one waveOutWrite)
//   - PCM is not all zero (decode actually produced samples)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const RUN    = path.join(__dirname, 'run.js');
const EXE    = path.join(__dirname, 'binaries', 'winamp.exe');
const MP3    = path.join(__dirname, 'binaries', 'demo.mp3');
const OUTDIR = path.join(__dirname, 'output');
const PCM    = path.join(OUTDIR, 'winamp-audio.pcm');
const MIN_PCM_BYTES = 8192;
const MAX_BATCHES = 1200;

if (!fs.existsSync(EXE))  { console.log('SKIP  winamp.exe not found');  process.exit(0); }
if (!fs.existsSync(MP3))  { console.log('SKIP  demo.mp3 not found');    process.exit(0); }

fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(PCM)) fs.unlinkSync(PCM);

// Worker mode pays a message round trip per blocking host import, and the
// output thread makes ~20k of them before the buffer fills, so the same guest
// progress takes longer in wall clock. The assertion here is about audio, not
// about speed, so the budget scales with the execution model rather than quietly
// failing it. Cooperative stays at 30s, which is where it was.
const THREADS_MODE = process.argv.slice(2).includes('--threads');
const TIME_BUDGET_MS = THREADS_MODE ? 120000 : 30000;
// Winamp primes its output with silence and the decode thread fills in behind
// it. Under real threads that lead is longer — measured: the first non-zero
// sample can land past 16KB where cooperatively it lands at byte 4350 — so
// stopping at 8KB captures the priming and nothing else. Capture further in
// threads mode, so "is it silence?" is asked of audio that has had a chance to
// exist; the check itself is unchanged, and cooperative keeps its old 8KB.
const EXIT_BYTES = THREADS_MODE ? 65536 : MIN_PCM_BYTES;

const cmd = [
  `node "${RUN}"`,
  `--exe="${EXE}"`,
  `--max-batches=${MAX_BATCHES}`,
  '--batch-size=100',
  '--quiet-api',
  '--quiet-blocks',
  '--buttons=1,1,1,1,1,1,1,1,1,1',
  '--no-close',
  '--stuck-after=5000',
  '--input="10:273:2,20:wait-title:Winamp:1000,300:click:66:129"',
  `--audio-out="${PCM}"`,
  `--audio-exit-bytes=${EXIT_BYTES}`,
  // Pass `--threads` to this test to check the same playback against the
  // real-OS-thread backend: the decode thread, the buffer thread and the UI
  // thread each get their own OS thread instead of a slice of this one. Audio
  // either comes out or it does not, which makes this the strictest check of
  // that backend we have — it was worth 0 bytes until worker slices stopped
  // being sized like main-thread batches.
  ...process.argv.slice(2).filter(arg => arg === '--threads'),
].join(' ');

console.log('$', cmd);

let out = '';
const t0 = Date.now();
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: TIME_BUDGET_MS, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
    console.log(`(run.js timed out after ${TIME_BUDGET_MS / 1000}s — output so far captured)`);
  } else {
    console.log('(run.js exited non-zero — output captured)');
  }
}
const elapsedMs = Date.now() - t0;

const apiMatch = out.match(/Stats:\s+(\d+)\s+API calls,\s+(\d+)\s+batches/);
const apiCount = apiMatch ? parseInt(apiMatch[1], 10) : 0;
const batches  = apiMatch ? parseInt(apiMatch[2], 10) : 0;

let pcmBytes = 0, nonZero = 0;
if (fs.existsSync(PCM)) {
  const buf = fs.readFileSync(PCM);
  pcmBytes = buf.length;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) { nonZero++; if (nonZero > 64) break; }
}
const durationMs = Math.round((pcmBytes / 4) / 22.050); // 22050 Hz stereo s16

const checks = [
  { name: `ran within ${TIME_BUDGET_MS / 1000}s`, pass: elapsedMs < TIME_BUDGET_MS },
  { name: 'no UNIMPLEMENTED API crash',        pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no unreachable trap',               pass: !/RuntimeError:\s*unreachable/.test(out) },
  { name: 'reached message loop',              pass: apiCount > 1000 },
  { name: 'PCM file exists',                   pass: fs.existsSync(PCM) },
  { name: 'PCM >= 8KB (audio buffer written)',  pass: pcmBytes >= MIN_PCM_BYTES },
  { name: 'PCM is not silence',                pass: nonZero > 64 },
];

console.log('');
console.log(`  elapsed=${elapsedMs}ms apiCount=${apiCount} batches=${batches} pcmBytes=${pcmBytes} (~${durationMs}ms audio)`);
console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
