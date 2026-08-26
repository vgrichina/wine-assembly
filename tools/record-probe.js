#!/usr/bin/env node
// Record a real app through the browser recorder, then read back what the
// encoder actually produced.
//
//   node tools/record-probe.js --app=jazz2_demo --seconds=20
//
// Every quality knob in lib/recorder.js is a REQUEST. MediaRecorder takes a
// codec string and a bitrate and is free to ignore both: ask for High profile
// and a real-time encoder may hand back Constrained Baseline anyway, ask for
// 8 Mbps on a still screen and it will spend 1.5. The only way to know is to
// record a file and look at it, which is what this does -- resolution, real
// bitrate, profile, I/P/B census and keyframe spacing, in one pass.
//
// Needs ffprobe on PATH for the analysis half; without it the .mp4 is still
// written and the tool says so.

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const APP = arg('app', 'jazz2_demo');
const SECONDS = Number(arg('seconds', '20'));
const TARGET = arg('target', 'screen');
const VIEW_W = Number(arg('width', '1280'));
const VIEW_H = Number(arg('height', '800'));
const OUT = arg('out', path.join(os.tmpdir(), `record-probe-${APP}.mp4`));

const MIME_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.css': 'text/css', '.png': 'image/png',
  '.wat': 'text/plain', '.exe': 'application/octet-stream',
};

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    const target = path.join(root, pathname === '/' ? '/index.html' : pathname);
    const real = path.resolve(target);
    if (!real.startsWith(root)) { response.writeHead(403); response.end(); return; }
    fs.readFile(real, (error, data) => {
      if (error) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(real)] || 'application/octet-stream' });
      response.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function ffprobe(args) {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();
}

function analyse(file) {
  try { execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); }
  catch (_) { console.log(`\n(ffprobe not on PATH -- wrote ${file}, cannot analyse)`); return; }

  const fields = ffprobe(['-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,profile,width,height,avg_frame_rate,bit_rate',
    '-of', 'default=noprint_wrappers=1', file]);
  const overall = ffprobe(['-show_entries', 'format=duration,size,bit_rate',
    '-of', 'default=noprint_wrappers=1', file]);
  const get = (text, key) => (text.match(new RegExp(`^${key}=(.*)$`, 'm')) || [, '?'])[1];

  const w = Number(get(fields, 'width'));
  const h = Number(get(fields, 'height'));
  const rate = get(fields, 'avg_frame_rate').split('/');
  const fps = Number(rate[0]) / Number(rate[1] || 1);
  const videoBits = Number(get(fields, 'bit_rate'));

  const types = ffprobe(['-select_streams', 'v:0', '-show_entries', 'frame=pict_type',
    '-of', 'csv=p=0', '-read_intervals', '%+30', file])
    .split('\n').filter(Boolean)
    .reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {});

  const keys = ffprobe(['-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0',
    '-read_intervals', '%+40', file])
    .split('\n').map(Number).filter(n => !Number.isNaN(n));
  const gaps = keys.slice(1).map((t, i) => t - keys[i]);
  const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;

  const bpp = (w && h && fps && videoBits) ? videoBits / (w * h * fps) : 0;

  console.log(`
  file        ${file}  (${(Number(get(overall, 'size')) / 1e6).toFixed(1)} MB, ${Number(get(overall, 'duration')).toFixed(1)}s)
  codec       ${get(fields, 'codec_name')}  profile=${get(fields, 'profile')}
  frame       ${w}x${h} @ ${fps.toFixed(1)} fps
  bitrate     ${(videoBits / 1e6).toFixed(2)} Mbps video
  bits/pixel  ${bpp.toFixed(3)}   (H.264 wants 0.10-0.15 for clean motion)
  frames/30s  ${Object.entries(types).map(([t, n]) => `${n} ${t}`).join('  ')}
  keyframes   every ${meanGap.toFixed(2)}s mean over ${gaps.length} gaps`);
}

async function main() {
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-probe-dl-'));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    defaultViewport: { width: VIEW_W, height: VIEW_H },
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run',
           '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    await page.createCDPSession().then(s => s.send(
      'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }));
    const logs = [];
    page.on('console', m => logs.push(m.text()));
    await page.goto(`${base}/index.html?record-probe=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    await page.evaluate(name => {
      const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === name);
      if (!icon) {
        const ids = [...document.querySelectorAll('.desktop-icon')].map(el => el.dataset.app);
        throw new Error(`no ${name} icon. have: ${ids.join(', ')}`);
      }
      icon.click(); icon.click();
    }, APP);
    await page.waitForFunction(name => {
      const entry = runningApps.find(item => item && item.name === name);
      return !!(entry && entry.wine && entry.wine.running);
    }, { timeout: 120000 }, APP);

    // Keep the blob instead of chasing the download.
    await page.evaluate(() => {
      window.__recorded = null;
      const realCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob && /^video\//.test(blob.type || '')) window.__recorded = blob;
        return realCreate(blob);
      };
    });

    console.log(`recording ${APP} for ${SECONDS}s (viewport ${VIEW_W}x${VIEW_H}, target ${TARGET}) ...`);
    await page.evaluate(target => toggleRecording({ target }), TARGET);
    await new Promise(resolve => setTimeout(resolve, SECONDS * 1000));
    await page.evaluate(() => toggleRecording());
    await page.waitForFunction(() => !!window.__recorded, { timeout: 60000 });

    const b64 = await page.evaluate(async () => {
      const bytes = new Uint8Array(await window.__recorded.arrayBuffer());
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(binary);
    });
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));

    for (const line of logs.filter(l => l.includes('[record]'))) console.log(`  page: ${line}`);
    analyse(OUT);
  } finally {
    await browser.close();
    server.close();
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(error => { console.error(error); process.exit(1); });
