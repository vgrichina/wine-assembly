#!/usr/bin/env node

'use strict';

// Does the live page keep the audio ring fed while it runs a demo?
//
//   node tools/toyvm/live-audio-probe.js --name=ALCHMSB.EXE [--seconds=15] [--mips=10] [--headful]
//   node tools/toyvm/live-audio-probe.js --names=ALCHMSB.EXE,DOPE.EXE,COPPER.EXE
//
// A headless render (run-dos.js --audio=) is driven by guest time and cannot
// underrun, so "is the sound continuous" has to be asked of the page itself:
// this opens docs/dos-corpus/demos.html in the system Chrome with sound on,
// presses Run on a tile and, once a second, reads LiveRun.audioStats() -- how
// many buffers the browser pulled and how many of those found the ring empty
// -- plus the driver's stall count (frames the host could not keep pace) and
// what the emulated cards have done. One line per second, then a verdict:
// the share of pulls that underran after the first second of sound.
//
// `--wav=out.wav` records what the browser actually pulled off the ring --
// underruns as the silence they are, and nothing the ring dropped -- so the
// page's own playback can go through audio-check.js like a headless render
// and against one (`audio-check.js page.wav headless.wav`). The `dropped`
// column is the other way a paced run loses sound: frames rendered when the
// ring was already full, which no underrun count ever shows. Only one
// name records; the file is what that tile played.
//
// Headless Chrome renders audio into a null sink at real time, so the ring's
// arithmetic is exactly the real page's; what it cannot measure is the load
// of a real machine with a compositor in front of it, so a clean run here on
// a loaded box is a strong result and a dirty one names the pull that failed.

const fs = require('fs');
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const flag = (n) => process.argv.slice(2).includes(`--${n}`);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
  '.json': 'application/json', '.css': 'text/css',
};

function serve(dir) {
  return new Promise((ok) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
      const file = path.join(dir, rel);
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('no'); return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

async function probe(page, name, seconds, wav) {
  const opened = await page.evaluate((n) => {
    const fig = [...document.querySelectorAll('figure[data-live]')].find((f) => f.dataset.live === n);
    if (!fig) return false;
    fig.querySelector('button.open').click();
    return true;
  }, name);
  if (!opened) return { name, error: 'no runnable tile by that name' };
  const has = await page.evaluate(() => { const b = document.getElementById('lb-play'); return !!b && !b.hidden; });
  if (!has) return { name, error: 'the Run button stayed hidden' };
  await page.evaluate(() => document.getElementById('lb-play').click());
  if (wav) {
    // Tap the ring's read: every buffer the audio thread takes is copied
    // aside, left channel only, so the file is exactly the played stream.
    // The ring exists once the Run click has made the context, so poll.
    await page.evaluate(async () => {
      for (let i = 0; i < 100 && !(self.liveRun && self.liveRun.ring); i++) await new Promise((r) => setTimeout(r, 50));
      const ring = self.liveRun && self.liveRun.ring;
      if (!ring) return;
      const chunks = [];
      const read = ring.read.bind(ring);
      const at = [];
      ring.read = (l, r, n) => { read(l, r, n); chunks.push(l.slice(0, n)); at.push(performance.now()); };
      self.__tap = { chunks, at, rate: self.liveRun.audioStats().rate };
    });
  }

  const rows = [];
  const t0 = Date.now();
  let last = null;
  for (let s = 1; s <= seconds; s++) {
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
    const st = await page.evaluate(() => {
      const run = self.liveRun;
      if (!run) return null;
      const a = run.audioStats && run.audioStats();
      const m = run.machine;
      return {
        audio: a, stalls: run.stalls, dispatched: (run.session && run.session.dispatched) || 0,
        dropped: run.ring ? run.ring.dropped : 0,
        gus: m && m.gus ? { irqs: m.gus.stats.irqs, starts: m.gus.stats.starts, playing: m.gus.active() } : null,
        status: (document.getElementById('lb-status') || {}).textContent || '',
      };
    });
    if (!st || !st.audio) { rows.push({ t: s, none: true }); continue; }
    const d = last ? {
      pulls: st.audio.pulls - last.audio.pulls, underruns: st.audio.underruns - last.audio.underruns,
      rendered: st.audio.rendered - last.audio.rendered, stalls: st.stalls - last.stalls,
      dispatched: st.dispatched - last.dispatched, dropped: st.dropped - last.dropped,
    } : { pulls: st.audio.pulls, underruns: st.audio.underruns, rendered: st.audio.rendered, stalls: st.stalls, dispatched: st.dispatched, dropped: st.dropped };
    rows.push({ t: s, ...d, state: st.audio.state, rate: st.audio.rate, sb: st.audio.sb, opl: st.audio.opl,
      speaker: st.audio.speaker, gus: st.gus, total: st.audio });
    last = st;
  }
  let recorded = null;
  if (wav) {
    // Int16 little-endian in base64: a few MB of samples cross the bridge
    // in one string instead of a JSON array of floats.
    const b64 = await page.evaluate(() => {
      const tap = self.__tap;
      if (!tap) return null;
      const n = tap.chunks.reduce((s, c) => s + c.length, 0);
      const pcm = new Int16Array(n);
      let o = 0;
      for (const c of tap.chunks) for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767)));
      let s = '';
      const u8 = new Uint8Array(pcm.buffer);
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      // Pull timing: the ScriptProcessorNode fires on the main thread, so a
      // gap between pulls longer than a buffer is a stall the listener heard
      // as a dropout, whatever the ring held at the time.
      const gaps = [];
      for (let i = 1; i < tap.at.length; i++) gaps.push(tap.at[i] - tap.at[i - 1]);
      const buf = tap.chunks.length ? tap.chunks[0].length / tap.rate * 1000 : 0;
      return { rate: tap.rate, b64: btoa(s), bufMs: buf, maxGap: Math.max(0, ...gaps), late: gaps.filter((g) => g > buf * 1.5).length, pulls: gaps.length + 1 };
    });
    if (b64) {
      const pcm = Buffer.from(b64.b64, 'base64');
      const head = Buffer.alloc(44);
      head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8);
      head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
      head.writeUInt32LE(b64.rate, 24); head.writeUInt32LE(b64.rate * 2, 28); head.writeUInt16LE(2, 32);
      head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
      fs.writeFileSync(wav, Buffer.concat([head, pcm]));
      recorded = { file: wav, rate: b64.rate, seconds: pcm.length / 2 / b64.rate, bufMs: b64.bufMs, maxGap: b64.maxGap, late: b64.late, pulls: b64.pulls };
    }
  }
  await page.evaluate(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); });
  return { name, rows, final: last, recorded };
}

async function main() {
  const dir = path.resolve(arg('dir', path.join(__dirname, '..', '..', 'docs', 'dos-corpus')));
  const names = (arg('names', '') || arg('name', '')).split(',').filter(Boolean);
  if (!names.length) {
    console.error('usage: live-audio-probe.js --name=DEMO.EXE [--seconds=15] [--mips=10] [--headful] [--json=out.json] [--wav=played.wav]');
    process.exit(2);
  }
  const seconds = Number(arg('seconds', 15));
  const mips = String(arg('mips', '10'));
  const server = await serve(dir);
  const port = server.address().port;
  const browser = await puppeteer.launch({
    headless: !flag('headful'),
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // Sound on and the CPU speed pinned, the way the page reads its prefs.
  await page.evaluateOnNewDocument((m) => {
    localStorage.setItem('toyvm-live', JSON.stringify({ cpu: m, sound: true, auto: true }));
  }, mips);
  await page.goto(`http://127.0.0.1:${port}/demos.html`, { waitUntil: 'load' });

  // `--cpu-profile=FILE`: V8's sampling profiler over the first name's run,
  // written as a .cpuprofile for tools/cpuprof-top.js. The underrun share
  // says the page cannot keep pace; this says what the main thread was
  // doing instead -- and it is a different answer from the CLI's profile,
  // because the page's per-slice work (pacing, paint, the ring) is its own.
  const cpuProfile = arg('cpu-profile');
  let cdp = null;
  if (cpuProfile) {
    cdp = await page.target().createCDPSession();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  }

  const out = [];
  for (const name of names) {
    const profiling = cdp && name === names[0];
    if (profiling) await cdp.send('Profiler.start');
    const r = await probe(page, name, seconds, name === names[0] ? arg('wav') : null);
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop');
      fs.writeFileSync(cpuProfile, JSON.stringify(profile));
      console.log(`cpu profile of ${name} written to ${cpuProfile} (node tools/cpuprof-top.js ${cpuProfile})`);
    }
    out.push(r);
    if (r.error) { console.log(`${name}: ${r.error}`); continue; }
    console.log(`${name} at ${mips} MIPS, ${seconds}s:`);
    for (const row of r.rows) {
      if (row.none) { console.log(`  ${String(row.t).padStart(3)}s  (no audio context yet)`); continue; }
      const src = [];
      if (row.sb) src.push(`sb ${row.sb}`);
      if (row.opl) src.push(`fm ${row.opl}`);
      if (row.speaker) src.push(`spk ${row.speaker}`);
      if (row.gus && (row.gus.starts || row.gus.irqs)) src.push(`gus ${row.gus.starts} starts/${row.gus.irqs} irqs${row.gus.playing ? ' playing' : ''}`);
      console.log(`  ${String(row.t).padStart(3)}s  pulls ${String(row.pulls).padStart(4)}  underruns ${String(row.underruns).padStart(3)}`
        + `  rendered ${String(row.rendered).padStart(6)}  dropped ${String(row.dropped).padStart(5)}  stalls ${String(row.stalls).padStart(3)}`
        + `  ${(row.dispatched / 1e6).toFixed(1).padStart(5)}M dispatches`
        + (row.total.budgetMs !== undefined ? `  budget ${row.total.budgetMs.toFixed(1)}ms` : '')
        + `  ${row.state}  ${src.join(', ')}`);
    }
    const a = r.final && r.final.audio;
    if (a) {
      // After the first second: the context starts, the ring primes, and the
      // first pull or two legitimately find nothing.
      const late = r.rows.filter((x) => !x.none && x.t > 1);
      const pulls = late.reduce((s, x) => s + x.pulls, 0), under = late.reduce((s, x) => s + x.underruns, 0);
      const share = pulls ? under / pulls : 0;
      console.log(`  verdict: ${under} of ${pulls} pulls underran after 1s (${(share * 100).toFixed(1)}%), ${r.final.stalls} stall(s)`
        + ` -- ${share < 0.01 ? 'continuous' : share < 0.1 ? 'OCCASIONAL GAPS' : 'GAPPY: the host cannot keep pace'}`);
      r.verdict = { pulls, underruns: under, share, stalls: r.final.stalls, dropped: r.final.dropped };
      if (r.final.dropped) console.log(`  ${r.final.dropped} frame(s) DROPPED: the machine rendered ahead of a full ring`);
      if (r.recorded) console.log(`  recorded ${r.recorded.seconds.toFixed(2)}s at ${r.recorded.rate}Hz to ${r.recorded.file}; pull gaps: ${r.recorded.late} of ${r.recorded.pulls} later than 1.5 buffers (${r.recorded.bufMs.toFixed(1)}ms), longest ${r.recorded.maxGap.toFixed(1)}ms`);
    }
  }
  if (errors.length) console.log(`page errors: ${errors.slice(0, 5).join(' | ')}`);
  await browser.close();
  server.close();
  const jsonOut = arg('json');
  if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(out, null, 1)}\n`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
