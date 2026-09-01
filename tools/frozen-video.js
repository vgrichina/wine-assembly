#!/usr/bin/env node
// Assemble a frozen-session recording into an mp4 that plays as continuous
// realtime gameplay.  (docs/design-frozen-recording.md)
//
//   node tools/frozen-video.js recordings/<session> [--out=clip.mp4]
//   node tools/frozen-video.js recordings/<session> --wav-only   # audio only
//
// The input is what tools/dev-server.js's /api/record sink wrote while an
// agent stepped a frozen browser session: JPEG frames tagged with the guest
// time that produced them, and guest PCM chunks tagged with the guest time at
// which they started sounding. BOTH timelines are the emulated machine's, not
// the wall clock, so the 30-90 second pauses while the agent thought about its
// next move occupy exactly zero seconds here. What comes out is a video of the
// session as a person would have experienced it.
//
// Two things this deliberately does NOT do:
//
//   * round the frame rate. tickMs=16 sampled every 2nd step is 31.25fps, and
//     an mp4 written at 31 drifts a second and a half out of sync with its
//     audio over a five-minute clip. ffmpeg takes a rational -r, so the exact
//     ratio goes in as a ratio.
//   * re-time the audio. Each chunk is laid down at its own guestStartMs and
//     the gaps between them are silence, which is what the guest actually
//     produced. Nothing is stretched to fit the video.
//
// ffmpeg discipline is tools/twitter-clip.js's: ffmpeg writes its diagnostics
// to stderr and exits 0 on plenty of things that are not success, so every
// invocation checks the status AND keeps the stderr to quote.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const OUT_RATE = 44100;   // the mix rate; everything resamples to this

function fail(message, code = 2) {
  console.error(`frozen-video: ${message}`);
  process.exit(code);
}

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
}

function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter(line => line.trim())
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

function run(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error && result.error.code === 'ENOENT') {
    fail(`${bin} not found on PATH — brew install ffmpeg`, 3);
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function ffmpeg(args, what) {
  const result = run('ffmpeg', ['-hide_banner', '-nostdin', ...args]);
  if (result.status !== 0) {
    // The message is always in stderr and ffmpeg's stdout is the media, so a
    // caller that reads only stdout gets a silent failure. Quote the tail.
    const tail = result.stderr.trim().split('\n').slice(-12).join('\n');
    fail(`${what} failed (ffmpeg exit ${result.status}):\n${tail}`, 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Audio: lay every tapped PCM chunk onto the guest timeline, then mix
// ---------------------------------------------------------------------------

// Decode one guest PCM chunk to per-channel float arrays at its own rate.
// 8-bit PCM is unsigned with 0x80 as silence (the WAVE_FORMAT_PCM rule);
// 16-bit is signed little-endian. Anything else the guest never submits.
function decodeChunk(chunk) {
  const bytes = Buffer.from(chunk.pcm, 'base64');
  const channels = Math.max(1, chunk.channels | 0);
  const bits = chunk.bits | 0;
  const bps = bits === 8 ? 1 : 2;
  const frames = Math.floor(bytes.length / (bps * channels));
  if (frames <= 0) return null;
  const out = [];
  for (let ch = 0; ch < channels; ch++) out.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      const at = (i * channels + ch) * bps;
      out[ch][i] = bits === 8
        ? (bytes[at] - 128) / 128
        : bytes.readInt16LE(at) / 32768;
    }
  }
  return { data: out, frames, rate: Math.max(1, chunk.sampleRate | 0) };
}

// Linear resampling. The guest's rates are 8000/11025/22050/44100 and the
// material is game effects and tracker music, so the interpolation error sits
// far below the 8-bit quantization most of it arrives with; a windowed-sinc
// would be measuring something the source does not have.
function mixChunk(left, right, chunk) {
  const decoded = decodeChunk(chunk);
  if (!decoded) return 0;
  const gainL = Number.isFinite(chunk.gainL) ? chunk.gainL : 1;
  const gainR = Number.isFinite(chunk.gainR) ? chunk.gainR : 1;
  const ratio = decoded.rate / OUT_RATE;
  const outFrames = Math.floor(decoded.frames / ratio);
  const base = Math.round((chunk.guestStartMs / 1000) * OUT_RATE);
  const srcL = decoded.data[0];
  const srcR = decoded.data.length > 1 ? decoded.data[1] : decoded.data[0];
  let wrote = 0;
  for (let i = 0; i < outFrames; i++) {
    const at = base + i;
    if (at < 0) continue;
    if (at >= left.length) break;
    const pos = i * ratio;
    const i0 = pos | 0;
    const i1 = Math.min(decoded.frames - 1, i0 + 1);
    const frac = pos - i0;
    left[at] += (srcL[i0] + (srcL[i1] - srcL[i0]) * frac) * gainL;
    right[at] += (srcR[i0] + (srcR[i1] - srcR[i0]) * frac) * gainR;
    wrote++;
  }
  return wrote;
}

function writeWav(file, left, right) {
  const frames = left.length;
  const dataBytes = frames * 2 * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(2, 22);            // stereo
  buf.writeUInt32LE(OUT_RATE, 24);
  buf.writeUInt32LE(OUT_RATE * 4, 28); // byte rate
  buf.writeUInt16LE(4, 32);            // block align
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  // Summed float, clamped, then TPDF-dithered on the way to s16: several
  // voices adding into one bus routinely exceed 1.0, and a wrapped sample is
  // a click that reads as a decoder bug.
  let clipped = 0;
  let sumSq = 0;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      let v = ch === 0 ? left[i] : right[i];
      if (v > 1 || v < -1) { clipped++; v = Math.max(-1, Math.min(1, v)); }
      sumSq += v * v;
      const dither = (Math.random() + Math.random() - 1) / 32768;
      let s = Math.round((v + dither) * 32767);
      s = Math.max(-32768, Math.min(32767, s));
      buf.writeInt16LE(s, 44 + (i * 2 + ch) * 2);
    }
  }
  fs.writeFileSync(file, buf);
  return { clipped, rms: frames ? Math.sqrt(sumSq / (frames * 2)) : 0 };
}

// ---------------------------------------------------------------------------

function main() {
  const dir = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!dir) {
    console.log('usage: node tools/frozen-video.js <recording-dir> [--out=clip.mp4] [--crf=N] [--wav-only]');
    console.log('  <recording-dir> is what tools/dev-server.js wrote under recordings/');
    process.exit(2);
  }
  const root = path.resolve(dir);
  if (!fs.existsSync(root)) fail(`no recording at ${root}`);

  const metaFile = path.join(root, 'meta.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const frames = readNdjson(path.join(root, 'frames.ndjson'))
    .filter(f => fs.existsSync(path.join(root, f.file)));
  if (!frames.length) fail(`no frames in ${root} (frames.ndjson is empty — did the page reach the sink?)`);
  frames.sort((a, b) => (a.guestMs - b.guestMs) || (a.stepIndex - b.stepIndex));

  // The nominal output rate, exactly. tickMs is the guest ms one step is
  // worth and k the sampling interval, so one frame is tickMs*k of guest
  // time — expressed to ffmpeg as the rational 1000/(tickMs*k) rather than
  // its decimal, because the decimal is where long-clip A/V drift comes from.
  const tickMs = Number(frames[0].tickMs) || Number(meta.tickMs) || 16;
  const k = Number(frames[0].k) || Number(meta.everyNSteps) || 2;
  const frameMs = Math.max(1, tickMs * k);
  const rate = `1000/${frameMs}`;
  const varied = frames.some(f => (Number(f.tickMs) || tickMs) !== tickMs
    || (Number(f.k) || k) !== k);

  const startMs = frames[0].guestMs;
  // Per-frame durations from the RECORDED guest times, not from the nominal
  // rate: a step call may change tickMs mid-recording, and a dropped frame
  // (the sink fell behind) must hold the previous picture for its own length
  // rather than shortening the clip.
  const concatLines = ['ffconcat version 1.0'];
  let videoMs = 0;
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].guestMs : frames[i].guestMs + frameMs;
    const durMs = Math.max(1, next - frames[i].guestMs);
    videoMs += durMs;
    concatLines.push(`file '${path.join(root, frames[i].file).replace(/'/g, "'\\''")}'`);
    concatLines.push(`duration ${(durMs / 1000).toFixed(6)}`);
  }
  // The concat demuxer ignores the last entry's duration unless the file is
  // repeated, which otherwise loses the final frame entirely.
  concatLines.push(`file '${path.join(root, frames[frames.length - 1].file).replace(/'/g, "'\\''")}'`);
  const concatFile = path.join(root, 'frames.concat');
  fs.writeFileSync(concatFile, concatLines.join('\n') + '\n');

  // Audio on the same timeline. Guest time 0 for this recording is the first
  // frame's guestMs, so every chunk is placed relative to that.
  const audio = readNdjson(path.join(root, 'audio.ndjson'));
  let audioEndMs = 0;
  for (const chunk of audio) {
    const decoded = decodeChunk(chunk);
    if (!decoded) continue;
    audioEndMs = Math.max(audioEndMs,
      (chunk.guestStartMs - startMs) + (decoded.frames / decoded.rate) * 1000);
  }
  const totalMs = Math.max(videoMs, audioEndMs, frameMs);
  const totalFrames = Math.ceil((totalMs / 1000) * OUT_RATE) + OUT_RATE / 10;
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  let mixed = 0;
  for (const chunk of audio) {
    mixed += mixChunk(left, right,
      Object.assign({}, chunk, { guestStartMs: chunk.guestStartMs - startMs }));
  }
  const wavFile = path.join(root, 'audio.wav');
  const wavStats = writeWav(wavFile, left, right);

  console.log(`frames    ${frames.length}  ${frames[0].w}x${frames[0].h}`);
  console.log(`timeline  ${(videoMs / 1000).toFixed(2)}s of GUEST time at ${rate} fps`
    + ` (${tickMs}ms/step x ${k} steps/frame)${varied ? '  [tickMs varied — durations are per-frame]' : ''}`);
  console.log(`audio     ${audio.length} guest PCM chunks, ${mixed} samples mixed,`
    + ` rms ${wavStats.rms.toFixed(4)}${wavStats.clipped ? `, ${wavStats.clipped} clipped` : ''}`);
  if (!audio.length) console.log('          (none — the clip gets a silent track so it still muxes)');

  if (process.argv.includes('--wav-only')) {
    console.log(`wrote     ${wavFile}`);
    return;
  }

  const out = path.resolve(arg('out', path.join(root, 'clip.mp4')));
  const crf = arg('crf', '20');
  ffmpeg([
    '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', concatFile,
    '-i', wavFile,
    '-map', '0:v:0', '-map', '1:a:0',
    // -r resamples the variable concat timeline onto the exact nominal rate,
    // so the output is CFR and its timestamps are rational.
    '-r', rate,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(OUT_RATE), '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    out,
  ], 'encode');

  const probe = run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate',
    '-of', 'default=noprint_wrappers=1', out]);
  console.log(`wrote     ${out}`);
  if (probe.status === 0) {
    const get = (key) => (new RegExp(`^${key}=(.*)$`, 'm').exec(probe.stdout) || [])[1];
    console.log(`ffprobe   ${get('codec_name') || '?'} ${get('width')}x${get('height')}`
      + ` @ ${get('r_frame_rate')}  ${Number(get('duration') || 0).toFixed(2)}s`
      + `  ${((Number(get('size') || 0)) / 1e6).toFixed(2)}MB`);
  }
}

if (require.main === module) main();

module.exports = { decodeChunk, mixChunk, writeWav, OUT_RATE };
