#!/usr/bin/env node
// Winamp 2.91 audio playback regression.
//
// Drives Winamp through survey-dismiss → IPC_PLAYFILE → IPC_STARTPLAY and
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
//   - PCM file exists and is >= 8KB (at least ~3 waveOutWrites)
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

if (!fs.existsSync(EXE))  { console.log('SKIP  winamp.exe not found');  process.exit(0); }
if (!fs.existsSync(MP3))  { console.log('SKIP  demo.mp3 not found');    process.exit(0); }

fs.mkdirSync(OUTDIR, { recursive: true });
if (fs.existsSync(PCM)) fs.unlinkSync(PCM);

const cmd = [
  `node "${RUN}"`,
  `--exe="${EXE}"`,
  '--max-batches=200',
  '--batch-size=5000',
  '--buttons=1,1,1,1,1,1,1,1,1,1',
  '--no-close',
  '--input="10:273:2,50:poke:0x45caa4:1,60:winamp-play:C:\\demo.mp3,100:winamp-start"',
  `--audio-out="${PCM}"`,
].join(' ');
console.log('$', cmd);

let out = '';
const t0 = Date.now();
try {
  out = execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = (e.stdout || '').toString() + (e.stderr || '').toString();
  if (e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
    console.log('(run.js timed out after 30s — output so far captured)');
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
  { name: 'ran within 30s',                    pass: elapsedMs < 30000 },
  { name: 'no UNIMPLEMENTED API crash',        pass: !/UNIMPLEMENTED API:/.test(out) },
  { name: 'no unreachable trap',               pass: !/RuntimeError:\s*unreachable/.test(out) },
  { name: 'reached message loop',              pass: apiCount > 5000 },
  { name: 'PCM file exists',                   pass: fs.existsSync(PCM) },
  { name: 'PCM >= 8KB (≥3 buffers written)',   pass: pcmBytes >= 8192 },
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
