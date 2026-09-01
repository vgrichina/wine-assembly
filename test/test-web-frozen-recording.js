#!/usr/bin/env node
// The frozen session recorder (docs/design-frozen-recording.md), end to end:
// a real Chrome stepping a real frozen guest, a real dev-server sink, and
// tools/frozen-video.js turning what landed on disk into a real mp4.
//
// The claim being tested is that the OUTPUT lives on the guest timeline, not
// the wall clock. So the check that matters is the duration one: the clip must
// be as long as the guest ran (steps x tickMs), and it must stay that length
// even though this test deliberately sits idle in the middle of the recording
// the way an agent thinking about its next move does. A wall-clock recorder
// would put those seconds in the file; this one must not.
//
// PASS criteria:
//   - `ctl record on` is refused on a live session and accepted on a frozen one
//   - stepping a recording session writes frames to the sink's session dir
//   - an idle stretch mid-recording adds NO frames and NO guest time
//   - the assembled mp4 has a video stream at the exact guest frame rate and a
//     duration within 5% of steps*tickMs
//   - the mp4 has an audio stream; if the app submitted any guest PCM at all,
//     that track has nonzero RMS

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Its own port: 8080 is a human's live session, 8094 is test-web-agent-frozen,
// 8098 is test-web-agent-remote.
const PORT = 8095;

// The app: dxball opens a DirectSound buffer and Plays it within the first
// hundred API calls (measured), which is what exercises the ring tap. The
// recording assertions do not depend on it making a sound — a silent app
// still has to produce a muxable audio track — but the RMS check does.
const APP = 'dxball';
const TICK_MS = 16;
const EVERY = 2;
const STEPS = 900;

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for frozen-recording test');
  process.exit(0);
}
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) {
  console.log('SKIP  puppeteer not installed');
  process.exit(0);
}
for (const bin of ['ffmpeg', 'ffprobe']) {
  if (spawnSync('which', [bin]).status !== 0) {
    console.log(`SKIP  ${bin} not on PATH (brew install ffmpeg)`);
    process.exit(0);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-rec-'));
// KEEP_RECORDING=DIR leaves the frames, the PCM and the mp4 behind for
// inspection — "the clip is wrong" is not a question a pass/fail can answer.
const KEEP = process.env.KEEP_RECORDING || '';
const recDir = KEEP ? path.join(KEEP, 'recordings') : path.join(tmpDir, 'recordings');
const ctl = (...args) => execFileSync('node', [CTL, `--hub=http://127.0.0.1:${PORT}`, ...args],
  { encoding: 'utf-8', timeout: 300000, cwd: ROOT });
const ctlFails = (...args) => {
  try { ctl(...args); return null; }
  catch (error) { return String(error.stdout || '') + String(error.stderr || ''); }
};

let failed = false;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${pathname}`, r => {
      let text = '';
      r.on('data', c => { text += c; });
      r.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(new Error(text.slice(0, 200))); } });
    }).on('error', reject);
  });
}

function ffprobeJson(file, extra) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-of', 'json', ...extra, file],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffprobe: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const server = spawn('node', [path.join(ROOT, 'tools', 'dev-server.js'),
  `--port=${PORT}`, `--record-dir=${recDir}`, '--quiet'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d; });
server.stderr.on('data', d => { serverOut += d; });

let browser = null;
(async () => {
  const deadline = Date.now() + 60000;
  while (!serverOut.includes('dev server:') && Date.now() < deadline) await sleep(200);
  if (!serverOut.includes('dev server:')) throw new Error(`dev-server never came up:\n${serverOut}`);

  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PORT}/?debug&app=${APP}&frozen=${TICK_MS}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#screen', { timeout: 15000 });
  const hostUp = await page.waitForFunction(() =>
    window.WineFrozen && window.WineFrozen.status().hosts > 0, { timeout: 90000 })
    .then(() => true).catch(() => false);
  check('frozen page registered a guest', hostUp, 'no host in 90s');

  let sessionId = null;
  const connectDeadline = Date.now() + 20000;
  while (!sessionId && Date.now() < connectDeadline) {
    const { sessions } = await getJson('/api/agent/sessions');
    const mine = sessions.find(s => s.href.includes(`app=${APP}`));
    if (mine) sessionId = mine.id;
    else await sleep(300);
  }
  check('recording page is on the hub', !!sessionId, 'no session found');

  // A live session records with lib/recorder.js and MediaRecorder; this
  // recorder's whole premise is a clock that only steps advance, so it must
  // refuse rather than silently produce a wall-clock clip.
  ctl('-s', sessionId, 'frozen', 'off');
  const refused = ctlFails('-s', sessionId, 'record', 'on');
  ctl('-s', sessionId, 'frozen', 'on');
  check('record is refused on a live (unfrozen) session',
    refused && /frozen/i.test(refused), String(refused).slice(0, 160));

  // Some boot before arming, so the recording is of a machine that is drawing.
  ctl('-s', sessionId, 'step', String(STEPS));

  const armed = JSON.parse(ctl('-s', sessionId, 'record', 'on', 'testclip'));
  check('record on arms the taps', armed.recording === true && !!armed.session,
    JSON.stringify(armed));

  const guestBefore = JSON.parse(ctl('-s', sessionId, 'snapshot')).frozen.guestMs;
  ctl('-s', sessionId, 'step', String(STEPS));

  // The agent-thinking gap. Nothing may run and nothing may be captured; if
  // anything does, the clip is wall-clock after all and the duration check
  // below would drift with the speed of this machine.
  const midway = JSON.parse(ctl('-s', sessionId, 'record', 'status'));
  await sleep(4000);
  const afterIdle = JSON.parse(ctl('-s', sessionId, 'record', 'status'));
  check('four idle seconds add no frames and no guest time',
    midway.frames === afterIdle.frames && midway.guestMs === afterIdle.guestMs,
    `${JSON.stringify(midway)} -> ${JSON.stringify(afterIdle)}`);

  ctl('-s', sessionId, 'click', '320,240');
  ctl('-s', sessionId, 'step', String(STEPS));

  const stopped = JSON.parse(ctl('-s', sessionId, 'record', 'off'));
  const guestAfter = JSON.parse(ctl('-s', sessionId, 'snapshot')).frozen.guestMs;
  const guestRanMs = guestAfter - guestBefore;
  check('recorded frames arrived at the sink',
    stopped.frames > 10 && stopped.recording === false, JSON.stringify(stopped));

  const dir = path.join(recDir, stopped.session || 'testclip');
  const frameLines = fs.existsSync(path.join(dir, 'frames.ndjson'))
    ? fs.readFileSync(path.join(dir, 'frames.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  const onDisk = fs.existsSync(path.join(dir, 'frames'))
    ? fs.readdirSync(path.join(dir, 'frames')).filter(f => f.endsWith('.jpg')) : [];
  check('the sink wrote one jpeg and one ndjson line per frame',
    frameLines.length > 10 && frameLines.length === onDisk.length,
    `${frameLines.length} lines / ${onDisk.length} jpegs in ${dir}`);

  // The guest timeline itself: every frame's guestMs strictly increases and
  // the step spacing is exactly the sampling interval.
  const headers = frameLines.map(l => JSON.parse(l));
  const badTime = headers.findIndex((h, i) => i > 0 && h.guestMs <= headers[i - 1].guestMs);
  const badStep = headers.findIndex((h, i) => i > 0 && h.stepIndex - headers[i - 1].stepIndex !== EVERY);
  check('frames carry a strictly increasing guest clock, k steps apart',
    badTime < 0 && badStep < 0,
    `time break at ${badTime} ${JSON.stringify(headers.slice(Math.max(0, badTime - 1), badTime + 2))},`
    + ` step break at ${badStep} ${JSON.stringify(headers.slice(Math.max(0, badStep - 1), badStep + 2))}`);

  const audioLines = fs.existsSync(path.join(dir, 'audio.ndjson'))
    ? fs.readFileSync(path.join(dir, 'audio.ndjson'), 'utf8').trim().split('\n').filter(Boolean)
    : [];
  console.log(`      ${audioLines.length} guest PCM chunks tapped`
    + (audioLines.length ? ` (first at guestMs=${JSON.parse(audioLines[0]).guestStartMs})` : ''));

  // ------------------------------------------------------------- assemble
  const clip = path.join(KEEP || tmpDir, 'clip.mp4');
  const assembled = spawnSync('node', [path.join(ROOT, 'tools', 'frozen-video.js'), dir, `--out=${clip}`],
    { encoding: 'utf8', cwd: ROOT, timeout: 300000 });
  check('frozen-video.js assembled the recording',
    assembled.status === 0 && fs.existsSync(clip),
    `exit ${assembled.status}: ${(assembled.stderr || '').slice(-400)}`);
  if (!fs.existsSync(clip)) throw new Error('no clip to probe');
  for (const line of String(assembled.stdout || '').trim().split('\n')) console.log(`      ${line}`);

  const probe = ffprobeJson(clip, ['-show_format', '-show_streams']);
  const video = probe.streams.find(s => s.codec_type === 'video');
  const audio = probe.streams.find(s => s.codec_type === 'audio');
  check('the mp4 has an H.264 video stream',
    !!video && video.codec_name === 'h264' && video.width > 0,
    JSON.stringify(video && { c: video.codec_name, w: video.width, h: video.height }));
  check('the mp4 has an AAC audio stream (silence still muxes)',
    !!audio && audio.codec_name === 'aac', JSON.stringify(audio && audio.codec_name));

  // The headline claim. The clip must be as long as the GUEST ran, not as
  // long as this test took — and this test spent four seconds idle plus
  // however long Chrome needed for 2700 steps.
  const expectedSec = guestRanMs / 1000;
  const actualSec = Number(probe.format.duration);
  const drift = Math.abs(actualSec - expectedSec) / expectedSec;
  check('the clip is as long as the guest ran, +/-5%',
    drift <= 0.05, `guest ${expectedSec.toFixed(2)}s vs clip ${actualSec.toFixed(2)}s (${(drift * 100).toFixed(1)}% off)`);

  // The exact rational rate, not a rounded one: 16ms/step every 2nd step is
  // 31.25fps, and 31 would drift a second and a half over five minutes. The
  // container stores the ratio in lowest terms (1000/32 comes back as 125/4),
  // so compare the VALUE and require it to be exact, not merely close.
  const [num, den] = String((video && video.r_frame_rate) || '0/1').split('/').map(Number);
  check('the video runs at the exact guest frame rate',
    num * (TICK_MS * EVERY) === den * 1000,
    `${video && video.r_frame_rate} = ${(num / den).toFixed(4)}fps, wanted ${1000 / (TICK_MS * EVERY)}`);

  if (audioLines.length) {
    const stats = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', clip,
      '-map', '0:a:0', '-af', 'astats=metadata=1', '-f', 'null', '-'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // astats reports on STDERR and ffmpeg exits 0 either way (twitter-clip.js
    // learned this the expensive way), so read stderr and check the status.
    const text = String(stats.stderr || '');
    const rms = [...text.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].map(m => m[1]);
    const audible = rms.some(v => v !== '-inf' && Number(v) > -90);
    check('the tapped guest PCM is audible in the clip',
      stats.status === 0 && audible, `rms levels ${JSON.stringify(rms)}`);
  } else {
    console.log('SKIP  audible-audio check: this run submitted no guest PCM');
  }

  check('the recording raised no uncaught page errors', pageErrors.length === 0,
    pageErrors.join(' | '));
})().catch(error => {
  console.log('FAIL  ' + (error && error.stack || error));
  failed = true;
}).finally(async () => {
  try { if (browser) await browser.close(); } catch (_) {}
  try { server.kill('SIGKILL'); } catch (_) {}
  if (!KEEP) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
  else console.log(`kept  ${KEEP}`);
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
