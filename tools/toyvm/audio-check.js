#!/usr/bin/env node

'use strict';

// What is in a rendered WAV, in terms that can be checked against a second
// render or a datasheet: pitch, tempo and continuity.
//
//   node tools/toyvm/audio-check.js out.wav
//   node tools/toyvm/audio-check.js gus.wav sb.wav       # the second is the reference
//   node tools/toyvm/audio-check.js out.wav --tick=0.0224 # a timer period to test the beat against
//
// One file prints, per second, the three strongest spectral peaks; then the
// long-term spectrum's strongest semitones, the beat period found by the
// autocorrelation of the onset envelope, and every gap or click after the
// first sound. Two files add the pitch offset between them in cents (the
// peak of the cross-correlation of the two semitone spectra: 0 means the same
// tuning, +-1200 an octave error, +-702 a fifth) and the ratio of their beat
// periods.
//
// This is what the sound census cannot say. A peak above 0.01 proves a run
// made a sound; only a spectrum can say the sound is at the right pitch, and
// only the onset rhythm can say it runs at the right speed. The reference for
// the Gravis emulation is a program that plays the same tune through its own
// Sound Blaster mixer -- ALCHMSB.EXE does -- rendered with `--no-gus`.
//
// Continuity is the headless half of the "is it lagging" question. A render
// is driven by guest time, so it cannot underrun on a slow host; a gap here
// is the emulated card or the driver going quiet. The page can underrun --
// its audio ring reports `underruns` through LiveRun.audioStats() -- and that
// is measured in the browser, not here.

const fs = require('fs');

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const arg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const json = args.includes('--json');

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${file}: not a WAV`);
  let off = 12, rate = 0, ch = 0, bits = 0, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(off + 10); rate = b.readUInt32LE(off + 12); bits = b.readUInt16LE(off + 22); }
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; }
    off += 8 + len + (len & 1);
  }
  if (!data || bits !== 16) throw new Error(`${file}: need 16-bit PCM`);
  const n = Math.floor(data.length / 2 / ch);
  const mono = new Float32Array(n);
  let pinned = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const v = data.readInt16LE((i * ch + c) * 2);
      if (v >= 32767 || v <= -32768) pinned++;
      s += v;
    }
    mono[i] = s / ch / 32768;
  }
  return { rate, mono, pinned, samples: n * ch };
}

// In-place radix-2 FFT on (re, im).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const N = 4096;                        // 186ms at 22050: ~5Hz bins
const HOP = N / 4;
const A4 = 440;
const LO_HZ = 40, HI_HZ = 8000;
const semitoneOf = (hz) => 12 * Math.log2(hz / A4) + 57;   // 57 = A4 in MIDI numbering
const nameOf = (st) => {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const r = Math.round(st);
  return `${names[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
};

function analyse(file) {
  const { rate, mono, pinned, samples } = readWav(file);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N);
  const binHz = rate / N;
  const loBin = Math.max(1, Math.floor(LO_HZ / binHz)), hiBin = Math.min(N / 2, Math.ceil(HI_HZ / binHz));
  // Long-term spectrum in 10-cent bins from MIDI 24 (C1) to 120, and the
  // onset envelope: the positive spectral flux per hop.
  const CENTS = 10, ST_LO = 24, ST_HI = 120;
  const ltas = new Float64Array((ST_HI - ST_LO) * 100 / CENTS);
  const frames = Math.floor((mono.length - N) / HOP);
  const flux = new Float64Array(Math.max(0, frames));
  // A 12-bin pitch-class profile per hop: the tune's timeline, which is what
  // two renders are aligned on to compare their tempo.
  const chroma = [];
  let prev = null;
  const perSecond = [];
  let secAcc = null, secFrames = 0, sec = 0;
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) { re[i] = mono[f * HOP + i] * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(hiBin);
    const pc = new Float64Array(12);
    let sum = 0;
    for (let k = loBin; k < hiBin; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      sum += mag[k];
      const st = semitoneOf(k * binHz);
      const idx = Math.round((st - ST_LO) * 100 / CENTS);
      if (idx >= 0 && idx < ltas.length) ltas[idx] += mag[k];
      pc[((Math.round(st) % 12) + 12) % 12] += mag[k];
    }
    chroma.push(pc);
    if (prev) { let d = 0; for (let k = loBin; k < hiBin; k++) d += Math.max(0, mag[k] - prev[k]); flux[f] = d; }
    prev = mag;
    if (!secAcc) secAcc = new Float64Array(hiBin);
    for (let k = loBin; k < hiBin; k++) secAcc[k] += mag[k];
    secFrames++;
    if ((f + 1) * HOP >= (sec + 1) * rate || f === frames - 1) {
      // The three strongest local maxima this second, with their level.
      const peaks = [];
      for (let k = loBin + 1; k < hiBin - 1; k++) {
        if (secAcc[k] > secAcc[k - 1] && secAcc[k] >= secAcc[k + 1]) peaks.push([k, secAcc[k] / secFrames]);
      }
      peaks.sort((a, b) => b[1] - a[1]);
      perSecond.push({
        t: sec, level: sum / (hiBin - loBin),
        peaks: peaks.slice(0, 3).map(([k, v]) => ({ hz: Math.round(k * binHz), note: nameOf(semitoneOf(k * binHz)), v })),
      });
      sec++; secAcc = null; secFrames = 0;
    }
  }
  // Beat: the autocorrelation of the onset envelope over 0.1-2s lags.
  const hopS = HOP / rate;
  const lagLo = Math.round(0.1 / hopS), lagHi = Math.min(flux.length >> 1, Math.round(2 / hopS));
  let mean = 0; for (const v of flux) mean += v; mean /= flux.length || 1;
  let bestLag = 0, best = -Infinity;
  const ac = [];
  for (let lag = lagLo; lag < lagHi; lag++) {
    let s = 0, n = 0;
    for (let i = lag; i < flux.length; i++) { s += (flux[i] - mean) * (flux[i - lag] - mean); n++; }
    const v = n ? s / n : 0;
    ac.push([lag, v]);
    if (v > best) { best = v; bestLag = lag; }
  }
  // Refine by parabolic interpolation on the autocorrelation peak.
  let beat = bestLag * hopS;
  const i0 = ac.findIndex(([l]) => l === bestLag);
  if (i0 > 0 && i0 < ac.length - 1) {
    const [a, b, c] = [ac[i0 - 1][1], ac[i0][1], ac[i0 + 1][1]];
    const d = (a - c) / (2 * (a - 2 * b + c) || 1);
    beat = (bestLag + d) * hopS;
  }
  // Continuity after the first sound: gaps of near-silence, and jumps.
  let first = -1;
  for (let i = 0; i < mono.length; i++) if (Math.abs(mono[i]) > 0.01) { first = i; break; }
  const gaps = [], clicks = [];
  if (first >= 0) {
    let quiet = 0;
    for (let i = first; i < mono.length; i++) {
      if (Math.abs(mono[i]) < 0.002) { quiet++; } else {
        if (quiet >= rate * 0.015) gaps.push({ at: (i - quiet) / rate, ms: Math.round(quiet / rate * 1000) });
        quiet = 0;
      }
      // A click is an ISOLATED jump: a step much larger than the steps around
      // it. A loud drum hit swings by a third of full scale sample after
      // sample and is not one.
      const d = i > first ? Math.abs(mono[i] - mono[i - 1]) : 0;
      if (d > 0.3) {
        let s = 0, n = 0;
        for (let k = Math.max(1, i - 40); k < Math.min(mono.length, i + 40); k++) {
          if (k === i) continue;
          s += Math.abs(mono[k] - mono[k - 1]); n++;
        }
        if (d > 8 * (s / n)) clicks.push(i / rate);
      }
    }
    if (quiet >= rate * 0.015) gaps.push({ at: (mono.length - quiet) / rate, ms: Math.round(quiet / rate * 1000), toEnd: true });
  }
  // The strongest semitones of the long-term spectrum.
  const top = [];
  for (let i = 1; i < ltas.length - 1; i++) {
    if (ltas[i] > ltas[i - 1] && ltas[i] >= ltas[i + 1]) top.push([i, ltas[i]]);
  }
  top.sort((a, b) => b[1] - a[1]);
  return {
    file, rate, seconds: mono.length / rate, first: first < 0 ? null : first / rate,
    perSecond, ltas, ltasCents: CENTS, ltasLo: ST_LO,
    top: top.slice(0, 8).map(([i, v]) => ({ st: ST_LO + i * CENTS / 100, note: nameOf(ST_LO + i * CENTS / 100), v })),
    beat, gaps, clicks, pinned, pinnedShare: pinned / samples, chroma, hopS,
  };
}

// The time scale that maps one tune's chroma timeline onto the other's:
// the (scale, offset) pair with the highest mean cosine similarity between
// A's frames and B's frames at scale*t + offset. A scale of 1.0 is the same
// tempo; 2.0 means B is running twice as fast as A.
function timeAlign(a, b) {
  const cos = (x, y) => {
    let d = 0, nx = 0, ny = 0;
    for (let i = 0; i < 12; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
    return nx && ny ? d / Math.sqrt(nx * ny) : 0;
  };
  const start = (r) => Math.max(0, Math.round((r.first || 0) / r.hopS));
  const a0 = start(a), b0 = start(b);
  let best = { scale: 1, offset: 0, sim: -1 };
  const offsets = Math.round(1.5 / a.hopS);
  for (let scale = 0.5; scale <= 2.0001; scale += 0.01) {
    for (let off = -offsets; off <= offsets; off++) {
      let s = 0, n = 0;
      for (let i = a0; i < a.chroma.length; i += 2) {
        const j = Math.round(b0 + (i - a0) * scale + off);
        if (j < 0 || j >= b.chroma.length) continue;
        s += cos(a.chroma[i], b.chroma[j]); n++;
      }
      if (n < 20) continue;
      const sim = s / n;
      if (sim > best.sim) best = { scale, offset: off * a.hopS, sim, frames: n };
    }
  }
  // The similarity at exactly 1.0 and the best offset there, for contrast.
  let at1 = -1;
  for (let off = -offsets; off <= offsets; off++) {
    let s = 0, n = 0;
    for (let i = a0; i < a.chroma.length; i += 2) {
      const j = b0 + (i - a0) + off;
      if (j < 0 || j >= b.chroma.length) continue;
      s += cos(a.chroma[i], b.chroma[j]); n++;
    }
    if (n >= 20) at1 = Math.max(at1, s / n);
  }
  return { ...best, simAt1: at1 };
}

// The pitch offset between two long-term spectra: the lag, in cents, at
// which their normalised cross-correlation peaks, within +-1500.
function pitchOffset(a, b) {
  const step = a.ltasCents;
  const norm = (x) => { let s = 0; for (const v of x) s += v * v; s = Math.sqrt(s) || 1; return Array.from(x, (v) => v / s); };
  const A = norm(a.ltas), B = norm(b.ltas);
  const span = Math.round(1500 / step);
  let best = -Infinity, bestLag = 0;
  const curve = [];
  for (let lag = -span; lag <= span; lag++) {
    let s = 0;
    for (let i = 0; i < A.length; i++) { const j = i + lag; if (j >= 0 && j < B.length) s += A[i] * B[j]; }
    curve.push([lag * step, s]);
    if (s > best) { best = s; bestLag = lag; }
  }
  const at0 = curve.find(([c]) => c === 0)[1];
  return { cents: bestLag * step, corr: best, corrAt0: at0 };
}

function report(r) {
  console.log(`${r.file}: ${r.seconds.toFixed(2)}s at ${r.rate}Hz, first sound ${r.first === null ? 'never' : r.first.toFixed(2) + 's'}`
    + `, ${r.pinned} sample(s) at full scale (${(r.pinnedShare * 100).toFixed(2)}%)`);
  for (const s of r.perSecond) {
    console.log(`  ${String(s.t).padStart(3)}s  level ${s.level.toFixed(2).padStart(6)}  `
      + s.peaks.map((p) => `${String(p.hz).padStart(5)}Hz ${p.note.padEnd(3)}`).join('  '));
  }
  console.log(`  strongest semitones: ${r.top.map((t) => `${t.note}(${t.st.toFixed(1)})`).join(' ')}`);
  console.log(`  beat: ${(r.beat * 1000).toFixed(1)}ms period (${(60 / r.beat).toFixed(1)} per minute)`);
  console.log(`  continuity: ${r.gaps.length} gap(s) >= 15ms, ${r.clicks.length} isolated jump(s) > 0.3 full scale`);
  for (const g of r.gaps.slice(0, 10)) console.log(`    gap at ${g.at.toFixed(2)}s, ${g.ms}ms${g.toEnd ? ' (to the end)' : ''}`);
  if (r.clicks.length) console.log(`    jumps at ${r.clicks.slice(0, 10).map((c) => c.toFixed(2) + 's').join(' ')}${r.clicks.length > 10 ? ' ...' : ''}`);
}

if (!files.length) {
  console.error('usage: audio-check.js out.wav [reference.wav] [--tick=SECONDS] [--json]');
  process.exit(2);
}
const dumpAt = arg('dump', '');
if (dumpAt) {
  // The raw samples around a moment, to see what a jump or a gap looks like.
  const { rate, mono } = readWav(files[0]);
  for (const t of dumpAt.split(',').map(Number)) {
    const c = Math.round(t * rate);
    const from = Math.max(0, c - 24), to = Math.min(mono.length, c + 24);
    console.log(`${files[0]} around ${t}s (sample ${c}):`);
    let line = '';
    for (let i = from; i < to; i++) {
      line += (i === c ? '[' : ' ') + mono[i].toFixed(3).padStart(6) + (i === c ? ']' : ' ');
      if ((i - from) % 8 === 7) { console.log('  ' + line); line = ''; }
    }
    if (line) console.log('  ' + line);
  }
  process.exit(0);
}
const results = files.map(analyse);
if (json) { console.log(JSON.stringify(results.map((r) => ({ ...r, ltas: undefined, perSecond: undefined, chroma: undefined })), null, 1)); process.exit(0); }
for (const r of results) report(r);
const tick = Number(arg('tick', 0));
if (tick > 0) {
  const r = results[0];
  const ratio = r.beat / tick;
  console.log(`beat / tick: ${ratio.toFixed(2)} ticks per beat (${Math.abs(ratio - Math.round(ratio)) < 0.08 ? 'a whole number: the beat sits on the timer' : 'not a whole number of ticks'})`);
}
if (results.length === 2) {
  const [a, b] = results;
  const p = pitchOffset(a, b);
  console.log(`\n${a.file} against ${b.file}:`);
  console.log(`  pitch offset ${p.cents > 0 ? '+' : ''}${p.cents} cents (correlation ${p.corr.toFixed(3)}, at zero ${p.corrAt0.toFixed(3)})`
    + ` -- ${Math.abs(p.cents) <= 20 ? 'same tuning' : Math.abs(Math.abs(p.cents) - 1200) <= 20 ? 'AN OCTAVE APART' : 'DIFFERENT TUNING'}`);
  const t = timeAlign(a, b);
  console.log(`  time scale ${t.scale.toFixed(2)} (offset ${t.offset > 0 ? '+' : ''}${t.offset.toFixed(2)}s, chroma similarity ${t.sim.toFixed(3)}`
    + ` over ${t.frames} frames; at scale 1.00 the best is ${t.simAt1.toFixed(3)})`
    + ` -- ${Math.abs(t.scale - 1) <= 0.03 ? 'same tempo' : 'DIFFERENT TEMPO'}`);
  console.log(`  beat autocorrelation ${(a.beat * 1000).toFixed(1)}ms vs ${(b.beat * 1000).toFixed(1)}ms (a coarser check: it can pick different multiples)`);
}
