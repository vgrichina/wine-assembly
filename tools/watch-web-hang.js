#!/usr/bin/env node
// Watch a browser run for a GUEST hang, and dump the guest state that caused it.
//
//   node tools/watch-web-hang.js --app=rct --seconds=180 \
//        --dump=0x59f4cc:0x400,0x5706c4:0x10 --mouse=sweep
//
// WHY THIS EXISTS: some hangs only happen in the browser. test/run.js is
// deterministic -- same batches, same input timing, same result every run --
// so an app that spins forever in a page can be perfectly healthy headlessly,
// and none of the CLI debugger flags (--break, --watch, --trace-at) exist in
// the page at all. What a user can hand us is a screenshot and a repeating
// "[run] slice=N eip=0x..." line, which names the instruction but not the data
// that made it loop.
//
// So: run the real page, sample get_eip() on a timer, and when the same EIP
// comes back for --stall consecutive samples, declare a stall and hexdump the
// guest regions asked for on the command line. A guest stuck in a linked-list
// walk then tells you which pointer is cyclic, not just that one is.
//
// A stall is reported as exit code 3 so a shell can branch on it. Clean exit 0
// means the EIP kept churning for the whole window (no hang seen).

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
};

const APP = opt('app', 'rct');
const SECONDS = Number(opt('seconds', 120));
const WARMUP = Number(opt('warmup', 10));
const POLL_MS = Number(opt('poll', 250));
// How many identical consecutive EIP samples count as "stuck". The guest is
// sampled between slices, so a legitimately hot loop can repeat a few times;
// tens of samples in a row over seconds cannot.
const STALL = Number(opt('stall', 20));
const QUERY = opt('query', '');
const SHOT = opt('screenshot', '');
const ORIGIN = (opt('origin', '') || '').replace(/\/$/, '');
const MOUSE = opt('mouse', '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// --dump=0xVA:LEN[,0xVA:LEN...] in GUEST virtual addresses.
const DUMPS = (opt('dump', '') || '').split(',').filter(Boolean).map(spec => {
  const [va, len] = spec.split(':');
  return { va: Number(va), len: Number(len || 64) };
});

function mimeType(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code || 'read error'); return; }
      res.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).padStart(w, '0');

function formatDump(va, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.slice(i, i + 16);
    const cols = [];
    for (let j = 0; j < row.length; j += 4) {
      const d = (row[j] | (row[j + 1] << 8) | (row[j + 2] << 16) | (row[j + 3] << 24)) >>> 0;
      cols.push(d.toString(16).padStart(8, '0'));
    }
    lines.push(`  ${hex(va + i)}  ${cols.join(' ')}`);
  }
  return lines.join('\n');
}

// Everything the page knows about the guest, in one round trip.
const SAMPLE = (regions) => {
  const app = (typeof runningApps !== 'undefined' && runningApps[0]) || null;
  const wine = app && app.wine;
  const ex = wine && wine.instance && wine.instance.exports;
  if (!ex || !ex.get_eip) return null;
  const out = {
    eip: ex.get_eip() >>> 0,
    prevEip: ex.get_dbg_prev_eip ? ex.get_dbg_prev_eip() >>> 0 : 0,
    regs: {},
    dumps: [],
  };
  for (const r of ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi']) {
    const fn = ex['get_' + r];
    if (fn) out.regs[r] = fn() >>> 0;
  }
  if (regions && regions.length && wine.memory && window.memUtils) {
    const imageBase = ex.get_image_base ? ex.get_image_base() >>> 0 : 0x400000;
    const bytes = new Uint8Array(wine.memory.buffer);
    for (const reg of regions) {
      const wa = window.memUtils.g2w(reg.va >>> 0, imageBase, wine.memory);
      if (!wa || wa + reg.len > bytes.length) { out.dumps.push({ va: reg.va, bad: true }); continue; }
      out.dumps.push({ va: reg.va, wa, bytes: Array.from(bytes.subarray(wa, wa + reg.len)) });
    }
  }
  return out;
};

async function main() {
  const server = ORIGIN ? null : await startStaticServer();
  const base = ORIGIN || `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-hang-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  let stalled = null;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.log(`[pageerror] ${e}`));
    page.on('console', m => {
      const t = m.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|crashed|FATAL:/i.test(t)) console.log(`[page] ${t}`);
    });
    await page.goto(`${base}/index.html${QUERY}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('typeof launchApp === "function"', { timeout: 60000 });
    await page.evaluate(app => {
      const sel = document.getElementById('app-select');
      if (typeof apps === 'undefined' || !apps[app]) throw new Error(`index.html has no app named ${app}`);
      if (![...sel.options].some(o => o.value === app)) {
        const o = document.createElement('option');
        o.value = app; o.textContent = app; sel.appendChild(o);
      }
      stopAllApps();
      localStorage.clear();
      sel.value = app;
      return launchApp();
    }, APP);
    await page.waitForFunction(
      'typeof runningApps !== "undefined" && runningApps.length > 0 && typeof sharedRenderer !== "undefined" && sharedRenderer',
      { timeout: 90000 });
    console.log(`launched ${APP}; warming up ${WARMUP}s`);
    await wait(WARMUP * 1000);

    const canvas = MOUSE ? await page.$('canvas') : null;
    const box = canvas ? await canvas.boundingBox() : null;

    const deadline = Date.now() + SECONDS * 1000;
    let lastEip = -1, repeats = 0, samples = 0;
    const seen = new Set();
    while (Date.now() < deadline) {
      const s = await page.evaluate(SAMPLE, DUMPS);
      if (s) {
        samples++;
        seen.add(s.eip);
        if (s.eip === lastEip) repeats++; else { repeats = 1; lastEip = s.eip; }
        if (repeats >= STALL) { stalled = s; break; }
      }
      // A real pointer sweep over the canvas: guests that only misbehave while
      // the mouse is live (hover redraws, edge scrolling) never get there from
      // a scripted click.
      if (box) {
        const t = samples * 0.37;
        const x = box.x + box.width * (0.5 + 0.45 * Math.sin(t));
        const y = box.y + box.height * (0.5 + 0.45 * Math.cos(t * 0.7));
        await page.mouse.move(x, y);
      }
      await wait(POLL_MS);
    }

    if (stalled) {
      console.log(`\nSTALL: eip stuck at ${hex(stalled.eip)} for ${repeats} consecutive samples ` +
                  `(${(repeats * POLL_MS / 1000).toFixed(1)}s)`);
      console.log(`  prev_eip ${hex(stalled.prevEip)}`);
      console.log('  ' + Object.entries(stalled.regs).map(([k, v]) => `${k.toUpperCase()}=${hex(v)}`).join(' '));
      for (const d of stalled.dumps) {
        if (d.bad) { console.log(`\n  ${hex(d.va)}: not mapped`); continue; }
        console.log(`\n  guest ${hex(d.va)} (wasm ${hex(d.wa)}):`);
        console.log(formatDump(d.va, d.bytes));
      }
    } else {
      console.log(`\nno stall: ${samples} samples, ${seen.size} distinct EIPs, ` +
                  `longest repeat ${repeats} (threshold ${STALL})`);
    }
    if (SHOT) {
      await page.screenshot({ path: SHOT });
      console.log(`\nwrote ${SHOT}`);
    }
  } finally {
    await browser.close().catch(() => {});
    if (server) server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(stalled ? 3 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
