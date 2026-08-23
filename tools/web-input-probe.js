#!/usr/bin/env node
// Drive an app in the real browser with scripted mouse input and read state back.
//
//   node tools/web-input-probe.js --app=mspaint98 \
//        --steps='wait:4000;move:180,200;move:180,331' [--eval='expr'] [--cpu=2]
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
// --viewport=WxH[@DPR] and --touch emulate a device; a phone-sized viewport
// puts index.html into single-app mode (add `single-app=1` to --query to force
// it regardless of the emulated screen size).
//
// --gpu runs the page on SwiftShader instead of Chrome's default --disable-gpu,
// so the WebGL presentation paths (scale-auto, fsr1, dedither, CRT) actually
// run. Without it every presentation falls back to 2D canvas and a GPU-only
// bug looks fixed.
//
// --url=https://host drives that origin instead of this working tree, which is
// how a "works locally, broken on the deployed site" report gets checked.
//
// --cpu=N applies Chrome's CPU throttling while preserving real browser audio
// timing, which is useful for scheduler-sensitive game/audio failures.

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
// The launch controls are intentionally hidden in the normal desktop view.
// This is a diagnostic driver, so default to the debug shell that exposes the
// Program selector and trusted Launch button.
const QUERY = opt('query', '?debug');
const STEPS = (opt('steps', '') || '').split(';').map(s => s.trim()).filter(Boolean);
const READY_MS = Number(opt('ready', 6000));
const CPU_RATE = Number(opt('cpu', 1));
// Headless Chrome runs with --disable-gpu by default, which sends presentation
// down the 2D canvas paths. A real phone browser has WebGL and takes the GPU
// paths instead, so bugs that only exist there (a viewport crop the shaders
// ignore) are invisible without --gpu, which swaps in SwiftShader.
const GPU = argv.includes('--gpu');
// Base origin to drive. Empty = serve this working tree over a temp server.
const URL_BASE = (opt('url', '') || '').replace(/\/+$/, '');
// A phone is a different page, not a smaller one: single-app mode, no taskbar,
// a phone-sized emulated screen. --viewport=390x844 (optionally with a
// device-pixel ratio, 390x844@3) and --touch reproduce one.
const VIEWPORT = (() => {
  const m = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(opt('viewport', '1280x900'));
  if (!m) throw new Error('--viewport must look like 390x844 or 390x844@3');
  return {
    width: Number(m[1]),
    height: Number(m[2]),
    deviceScaleFactor: m[3] ? Number(m[3]) : 1,
    hasTouch: argv.includes('--touch'),
    isMobile: argv.includes('--touch'),
  };
})();
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
    // Exclusive fullscreen and single-app mode present a crop of the desktop
    // canvas scaled to the display, so guest pixels are not canvas pixels.
    // Invert that viewport the same way renderer-input maps a tap back.
    const v = typeof sharedRenderer !== 'undefined' && sharedRenderer &&
      sharedRenderer._exclusivePresentationViewport;
    let cx = x + 0.5;
    let cy = y + 0.5;
    if (v && v.nativeW > 0 && v.nativeH > 0 && v.outputW > 0 && v.outputH > 0) {
      cx = (v.dstX + (x + 0.5 - v.nativeX) * v.dstW / v.nativeW) * c.width / v.outputW;
      cy = (v.dstY + (y + 0.5 - v.nativeY) * v.dstH / v.nativeH) * c.height / v.outputH;
    }
    return {
      x: r.left + cx * (r.width / c.width),
      y: r.top + cy * (r.height / c.height),
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
  // --url points the probe at an already-running origin (the deployed site, or
  // a dev server) instead of serving the working tree. "It works here but not
  // on wine-assembly.berrry.app" is otherwise unanswerable from this tool.
  const server = URL_BASE ? null : await startStaticServer();
  const base = URL_BASE || `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-input-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'].concat(
      GPU
        ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--disable-gpu']),
  });
  const problems = [];
  try {
    const page = await browser.newPage();
    if (CPU_RATE > 1) {
      const cdp = await page.target().createCDPSession();
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    }
    await page.setViewport(VIEWPORT);
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
    }, APP);
    // Use a trusted browser gesture for launch. AudioContext.resume() is
    // gated on user activation, so calling launchApp() through evaluate()
    // silently exercises a suspended-audio path that real users never take.
    // Without ?debug there is no Launch button — the shipping desktop starts
    // an app by double-clicking its icon, which is also the only launch path a
    // phone has. Fall back to it so the real page can be driven too.
    const launchPoint = await page.evaluate(app => {
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 &&
          getComputedStyle(el).visibility !== 'hidden';
      };
      const centre = el => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      const button = [...document.querySelectorAll('button[onclick="launchApp()"]')].find(visible);
      if (button) return { ...centre(button), icon: false };
      const icon = document.querySelector(`.desktop-icon[data-app="${app}"]`);
      if (visible(icon)) return { ...centre(icon), icon: true };
      throw new Error(`no visible Launch button and no desktop icon for ${app}`);
    }, APP);
    await page.mouse.click(launchPoint.x, launchPoint.y);
    // Icons launch on the second click of a double-click.
    if (launchPoint.icon) {
      await wait(80);
      await page.mouse.click(launchPoint.x, launchPoint.y);
    }
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
    if (server) server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log('\npage problems:');
    for (const p of problems.slice(0, 20)) console.log('  ' + p);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
