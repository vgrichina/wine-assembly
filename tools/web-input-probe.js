#!/usr/bin/env node
// Drive an app in the real browser with scripted mouse input and read state back.
//
//   node tools/web-input-probe.js --app=mspaint98 \
//        --steps='wait:4000;move:180,200;move:180,331' [--eval='expr']
//
// WHY THIS EXISTS: test/run.js shares lib/renderer-input.js and the wasm with
// the browser, so it can answer "does WAT pick the right cursor". It cannot
// answer "does the *page* show it" — the CLI has no canvas.style.cursor, no
// pointer, and no CSS. tools/profile-web-frames.js does drive the real page,
// but only launches and samples frame timing; it has no mouse scripting.
// Anything of the form "WAT looks right, the browser looks wrong" needs this.
//
// Coordinates are GUEST canvas pixels (the same numbers test/run.js takes for
// --input=B:mousemove:X:Y). They are converted to page coordinates through the
// canvas bounding rect, so the CSS scaling of #screen-wrap is accounted for.
//
// Steps (semicolon separated, left to right):
//   move:X,Y      move the pointer to guest pixel X,Y
//   click:X,Y     move, then press and release the left button
//   down:X,Y      / up:X,Y   — the halves of a drag
//   key:Name      keyboard press (puppeteer key name, e.g. Enter, KeyA)
//   wait:MS       idle, letting the guest run
//   eval:EXPR     evaluate EXPR in the page and print its result
//   shot:PATH     screenshot to PATH
//
// After every step the CSS cursor of the canvas is printed, since that is the
// pixel-visible answer to "what does the user see under the pointer".

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const a = argv.find(x => x.startsWith(`--${name}=`));
  return a === undefined ? dflt : a.slice(name.length + 3);
};

const APP = opt('app', 'mspaint98');
const QUERY = opt('query', '');
const STEPS = (opt('steps', '') || '').split(';').map(s => s.trim()).filter(Boolean);
const READY_MS = Number(opt('ready', 6000));
const FINAL_EVAL = opt('eval', '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

// Guest canvas pixel -> page coordinate, through the live bounding rect.
async function toPage(page, gx, gy) {
  return page.evaluate(([x, y]) => {
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return {
      x: r.left + (x + 0.5) * (r.width / c.width),
      y: r.top + (y + 0.5) * (r.height / c.height),
    };
  }, [gx, gy]);
}

const readCursor = page => page.evaluate(() => {
  const c = document.querySelector('canvas');
  const inline = c.style.cursor;
  const computed = getComputedStyle(c).cursor;
  // A custom cursor is a long data: URL; name it rather than printing 30KB.
  const shorten = v => (v && v.startsWith('url(')
    ? `custom(${v.length} chars)${v.includes('),') ? ' fallback=' + v.slice(v.lastIndexOf('), ') + 3) : ''}`
    : v);
  return { inline: shorten(inline), computed: shorten(computed) };
});

async function main() {
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-input-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', e => problems.push(String(e)));
    page.on('console', m => {
      const t = m.text();
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|crashed|FATAL:/i.test(t)) problems.push(t);
    });
    await page.goto(`${base}/index.html${QUERY}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction('typeof launchApp === "function"', { timeout: 60000 });

    console.log(`launching ${APP} ...`);
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
    await wait(READY_MS);
    console.log(`ready  cursor=${JSON.stringify(await readCursor(page))}`);

    for (const step of STEPS) {
      const colon = step.indexOf(':');
      const kind = colon < 0 ? step : step.slice(0, colon);
      const rest = colon < 0 ? '' : step.slice(colon + 1);
      if (kind === 'wait') {
        await wait(Number(rest) || 0);
      } else if (kind === 'eval') {
        const v = await page.evaluate(expr => {
          try { return JSON.stringify(eval(expr)); } catch (e) { return 'ERROR: ' + e.message; }
        }, rest);
        console.log(`eval ${rest} => ${v}`);
        continue;
      } else if (kind === 'shot') {
        await page.screenshot({ path: rest });
        console.log(`shot ${rest}`);
        continue;
      } else if (kind === 'key') {
        await page.keyboard.press(rest);
      } else if (kind === 'move' || kind === 'click' || kind === 'down' || kind === 'up') {
        const [gx, gy] = rest.split(',').map(Number);
        const p = await toPage(page, gx, gy);
        await page.mouse.move(p.x, p.y);
        if (kind === 'click') { await page.mouse.down(); await wait(60); await page.mouse.up(); }
        else if (kind === 'down') await page.mouse.down();
        else if (kind === 'up') await page.mouse.up();
      } else {
        throw new Error(`unknown step "${step}"`);
      }
      // Give the guest pump a few slices to consume the input before reading.
      await wait(400);
      const cur = await readCursor(page);
      console.log(`${step.padEnd(18)} cursor inline=${cur.inline || '(unset)'} computed=${cur.computed}`);
    }

    if (FINAL_EVAL) {
      const v = await page.evaluate(expr => {
        try { return JSON.stringify(eval(expr)); } catch (e) { return 'ERROR: ' + e.message; }
      }, FINAL_EVAL);
      console.log(`eval => ${v}`);
    }
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('\npage problems:');
    for (const p of problems.slice(0, 20)) console.log('  ' + p);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
