#!/usr/bin/env node
// True frozen CLI control + recording, end to end. The child starts before its
// first batch, advances only on `ctl step`, stays byte/time stable while this
// driver waits, and streams the stepped renderer frames to a real MP4.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const CTL = path.join(ROOT, 'tools', 'ctl.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');
const PORT = 8207;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found');
  process.exit(0);
}
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.log('SKIP  ffmpeg not found');
  process.exit(0);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-frozen-recording-'));
const video = path.join(tmpDir, 'stepped.mp4');
const signalVideo = path.join(tmpDir, 'signal-finalized.mp4');
const png = path.join(tmpDir, 'frozen.png');
const deadline = Date.now() + 60000;
let failed = false;
let signalChild = null;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  if (!ok) failed = true;
};

const child = spawn(process.execPath, [
  RUN, `--exe=${EXE}`, `--control=${PORT}`, '--frozen',
  '--tick-ms-per-batch=20', '--batch-size=50000', '--max-seconds=45',
  '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
child.stdout.on('data', d => { childOut += d; });
child.stderr.on('data', d => { childOut += d; });
let childCode = null;
const childExit = new Promise(resolve => child.on('exit', code => {
  childCode = code;
  resolve(code);
}));

const ctl = (...args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [CTL, `--port=${PORT}`, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
const waitFor = async (label, probe) => {
  while (Date.now() < deadline) {
    if (childCode !== null) throw new Error(`child exited ${childCode} waiting for ${label}\n${childOut.slice(-3000)}`);
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}\n${childOut.slice(-3000)}`);
};

(async () => {
  await waitFor('control server', async () => childOut.includes('[control] listening') || undefined);
  const before = JSON.parse(await ctl('snapshot'));
  check('CLI starts frozen before its first batch',
    before.frozen && before.frozen.frozen === true && before.batch === 0,
    JSON.stringify(before.frozen));

  await new Promise(resolve => setTimeout(resolve, 350));
  const idle = JSON.parse(await ctl('snapshot'));
  check('wall-clock idle advances no guest batches', idle.batch === before.batch,
    `${before.batch} -> ${idle.batch}`);

  const armed = JSON.parse(await ctl('record', 'on', video, '--every=2'));
  check('direct ctl arms an MP4 recording', armed.recording === true && armed.path === video,
    JSON.stringify(armed));

  // Exercise the same recorder sink host-audio uses, without making this
  // control/recorder regression depend on a particular game's sound timing.
  await ctl('eval', `(() => {
    const frames = Math.round(44100 * 0.48);
    const bytes = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const sample = Math.round(Math.sin(i * Math.PI * 2 * 440 / 44100) * 12000);
      bytes.writeInt16LE(sample, i * 4);
      bytes.writeInt16LE(sample, i * 4 + 2);
    }
    ctx.audioTap().pcm({ guestStartMs: 0, sampleRate: 44100, channels: 2,
      bits: 16, gainL: 1, gainR: 1, bytes });
    return bytes.length;
  })()`);

  const stepped = JSON.parse(await ctl('step', '24'));
  check('step waits for the requested work', stepped.steps === 24 && stepped.frozen === true,
    JSON.stringify(stepped));
  const after = JSON.parse(await ctl('snapshot'));
  await new Promise(resolve => setTimeout(resolve, 350));
  const afterIdle = JSON.parse(await ctl('snapshot'));
  check('CLI freezes again after step completes', afterIdle.batch === after.batch,
    `${after.batch} -> ${afterIdle.batch}`);
  await ctl('png', png);
  check('png captures immediately at a frozen boundary',
    fs.existsSync(png) && fs.statSync(png).size > 1000,
    fs.existsSync(png) ? `${fs.statSync(png).size} bytes` : 'missing');

  const stopped = JSON.parse(await ctl('record', 'off'));
  check('record off finalized sampled frames',
    stopped.recording === false && stopped.frames === 12 && stopped.everyNSteps === 2
      && stopped.audioChunks === 1 && stopped.audioPeak > 0.1,
    JSON.stringify(stopped));
  check('recorded MP4 exists', fs.existsSync(video) && fs.statSync(video).size > 1000,
    fs.existsSync(video) ? `${fs.statSync(video).size} bytes` : 'missing');
  const streams = spawnSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name', '-of', 'json', video], { encoding: 'utf8' });
  const streamJson = streams.status === 0 ? JSON.parse(streams.stdout) : { streams: [] };
  check('recorded MP4 contains video and audio streams',
    streamJson.streams.some(s => s.codec_type === 'video' && s.codec_name === 'h264')
      && streamJson.streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac'),
    streams.stderr || streams.stdout);
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', video, '-map', '0:a:0',
    '-f', 's16le', '-ac', '2', '-ar', '44100', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
  let peak = 0;
  if (decoded.status === 0) {
    for (let i = 0; i + 1 < decoded.stdout.length; i += 2) {
      peak = Math.max(peak, Math.abs(decoded.stdout.readInt16LE(i)));
    }
  }
  check('recorded audio stream is non-silent', decoded.status === 0 && peak > 1000,
    `ffmpeg=${decoded.status} peak=${peak}`);

  await ctl('quit');
  const code = await Promise.race([
    childExit,
    new Promise(resolve => setTimeout(() => resolve('timeout'), 10000)),
  ]);
  check('quit wakes and closes a frozen CLI', code === 0, `exit=${code}`);

  // A process audit or terminal close sends SIGTERM rather than `ctl quit`.
  // That used to call process.exit() from the signal handler, orphaning the
  // encoder's hidden video-only temporary file and dropping the requested
  // MP4. Exercise the actual HTTP/frozen/ffmpeg path so this cannot regress.
  const signalPort = PORT + 1;
  signalChild = spawn(process.execPath, [
    RUN, `--exe=${EXE}`, `--control=${signalPort}`, '--frozen',
    '--tick-ms-per-batch=20', '--batch-size=50000', '--max-seconds=45',
    '--quiet-api', '--quiet-blocks', '--no-close', '--no-build',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let signalOut = '';
  signalChild.stdout.on('data', d => { signalOut += d; });
  signalChild.stderr.on('data', d => { signalOut += d; });
  let signalCode = null;
  const signalExit = new Promise(resolve => signalChild.on('exit', code => {
    signalCode = code;
    resolve(code);
  }));
  const signalCtl = (...args) => new Promise((resolve, reject) => {
    execFile(process.execPath, [CTL, `--port=${signalPort}`, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 20000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  while (!signalOut.includes('[control] listening')) {
    if (signalCode !== null) throw new Error(`signal child exited ${signalCode}\n${signalOut.slice(-3000)}`);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for signal-run control server\n${signalOut.slice(-3000)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await signalCtl('record', 'on', signalVideo);
  // Keep a long step request in flight: the Quake incident was terminated
  // while a combat slice was active, not while the runner was already parked.
  const interruptedStep = signalCtl('step', '100000').catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 250));
  signalChild.kill('SIGTERM');
  const gracefulCode = await Promise.race([
    signalExit,
    new Promise(resolve => setTimeout(() => resolve('timeout'), 10000)),
  ]);
  check('SIGTERM takes the orderly frozen-run cleanup path',
    gracefulCode === 0 && /\[signal\] SIGTERM requested orderly shutdown/.test(signalOut),
    `exit=${gracefulCode} output=${signalOut.slice(-1000)}`);
  check('SIGTERM finalizes the requested MP4',
    fs.existsSync(signalVideo) && fs.statSync(signalVideo).size > 1000
      && /\[video\] wrote .*signal-finalized\.mp4/.test(signalOut),
    fs.existsSync(signalVideo) ? `${fs.statSync(signalVideo).size} bytes` : 'missing');
  await interruptedStep;
})().catch(error => {
  console.log(`FAIL  ${error.message}`);
  failed = true;
}).finally(() => {
  try { if (child.exitCode === null) child.kill('SIGTERM'); } catch (_) {}
  try { if (signalChild && signalChild.exitCode === null) signalChild.kill('SIGKILL'); } catch (_) {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(failed ? 'TEST FAILED' : 'TEST PASSED');
  process.exit(failed ? 1 : 0);
});
