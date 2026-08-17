#!/usr/bin/env node
// Measure browser frame pacing for any app in index.html.
//
//   node tools/profile-web-frames.js --app=blobby_volley --seconds=15 \
//        [--guest-click=401:223@6] [--warmup=8]
//
// WHY THIS EXISTS: the CLI harness cannot answer "does it feel janky". It has
// no rAF, no compositor and no main-thread contention -- it just runs batches
// back to back and reports how long each took. Jank is a scheduling property
// of the browser: how evenly frames are delivered, and how long a single task
// blocks the main thread between them. So this measures the two things that
// actually correspond to the complaint:
//
//   frame intervals  - rAF delta distribution. Smooth is ~16.7ms and tight;
//                      jank is a fat tail.
//   long tasks       - PerformanceObserver('longtask'), i.e. main-thread work
//                      over 50ms. Each one is a frame the page could not draw.
//
// It reports the distribution and the worst offenders, plus a burst analysis,
// because "smooth, then a crawl, then fine again" is a clustering question
// that a mean or an average FPS actively hides.

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
const APP = opt('app', 'blobby_volley');
const SECONDS = Number(opt('seconds', 15));
const WARMUP = Number(opt('warmup', 8));
const CLICKS = (opt('guest-click', '') || '').split(',').filter(Boolean);
const SHOT = opt('screenshot', '');
// Query string appended to index.html. "?debug" is a materially different
// page -- it keeps the debug log panel, and that panel is a plausible cost
// centre in its own right -- so profiling without it can miss the report.
const QUERY = opt('query', '');
// JS evaluated once after the instance is up, before sampling. Use it to A/B
// a single page setting against an otherwise identical run.
const AFTER_LAUNCH = opt('after-launch', '');
const CPU_PROFILE = argv.includes('--cpu-profile');
// Use an already-running server (e.g. `node tools/dev-server.js`) instead of
// this file's own static one. Required for anything that talks to a same-
// origin API, since the throwaway server serves files and nothing else.
const ORIGIN = (opt('origin', '') || '').replace(/\/$/, '');
// JS evaluated after sampling; its result is printed. Pairs with
// --after-launch to install a counter and then read it back.
const REPORT_EVAL = opt('report-eval', '');
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

function stats(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const at = p => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length, mean: vals.reduce((a, b) => a + b, 0) / s.length,
    p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s[s.length - 1],
  };
}

async function main() {
  // --origin points the run at a server that is already up (typically
  // tools/dev-server.js, which is the only one with the /api/perf sink), so
  // a relative-URL feature like ?perf-stream can be exercised for real
  // instead of against this file's throwaway static server.
  const server = ORIGIN ? null : await startStaticServer();
  const port = server ? server.address().port : 0;
  const base = ORIGIN || `http://127.0.0.1:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-frames-'));
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
    // initDesktop() removes every <option> not in its desktop app set, so an
    // app can be fully wired in `apps` and still be unreachable from the UI
    // (blobby_volley and dxball are both in that state). Profiling should not
    // depend on that cosmetic list -- re-add the option when it is missing,
    // and say so, because it means a human cannot launch it either.
    const injected = await page.evaluate(app => {
      const sel = document.getElementById('app-select');
      if (typeof apps === 'undefined' || !apps[app]) throw new Error(`index.html has no app named ${app}`);
      if ([...sel.options].some(o => o.value === app)) return false;
      const opt = document.createElement('option');
      opt.value = app;
      opt.textContent = app;
      sel.appendChild(opt);
      return true;
    }, APP);
    if (injected) console.log(`  note: ${APP} is not in the launcher list; option injected for this run`);

    await page.evaluate(app => {
      stopAllApps();
      localStorage.clear();
      document.getElementById('app-select').value = app;
      return launchApp();
    }, APP);

    // launchApp() resolves before the instance is up; wait for a running app
    // AND a renderer, or every measurement below silently reads null.
    try {
      await page.waitForFunction(
        'typeof runningApps !== "undefined" && runningApps.length > 0 && typeof sharedRenderer !== "undefined" && sharedRenderer',
        { timeout: 90000 });
    } catch (e) {
      // The page's own debug log says why far better than a timeout does.
      const state = await page.evaluate(() => {
        const el = document.getElementById('log');
        const sel = document.getElementById('app-select');
        return {
          log: el ? el.textContent.slice(-2000) : '(no #log element)',
          selectValue: sel ? sel.value : '(no #app-select)',
          knownApp: typeof apps !== 'undefined' ? Object.keys(apps).includes(sel && sel.value) : 'apps undefined',
          appKeys: typeof apps !== 'undefined' ? Object.keys(apps).length : 0,
          running: typeof runningApps !== 'undefined' ? runningApps.length : 'undefined',
        };
      }).catch(() => null);
      console.error('app did not come up:\n' + JSON.stringify(state, null, 2));
      throw e;
    }
    if (AFTER_LAUNCH) {
      const r = await page.evaluate(js => String(eval(js)), AFTER_LAUNCH);
      console.log(`  after-launch: ${AFTER_LAUNCH} => ${r}`);
    }
    // The guest needs to be past its loader before pacing means anything.
    await wait(WARMUP * 1000);
    console.log(`slice size: ${await page.evaluate(() => (runningApps[0] || {}).wine ? runningApps[0].wine.stepsPerSlice : null)} steps`);

    // Clicks are given in GUEST coordinates and mapped through the renderer's
    // exclusive transform, the same way the web tests do it.
    for (const spec of CLICKS) {
      const [pt, delaySec] = spec.split('@');
      const [gx, gy] = pt.split(':').map(Number);
      if (delaySec) await wait(Number(delaySec) * 1000);
      // One event per evaluate, with real time in between. Delivering all four
      // synchronously means the guest never runs between them, so it never
      // sees the cursor MOVE -- and a guest that hit-tests against its own
      // tracked cursor (Blobby does) then ignores the click entirely.
      const step = (fn) => page.evaluate((x, y, which) => {
        const t = sharedRenderer && sharedRenderer._exclusiveTransform;
        const cx = t && t.srcW ? Math.round((t.dstX || 0) + ((x - (t.srcX || 0)) * t.dstW / t.srcW)) : x;
        const cy = t && t.srcH ? Math.round((t.dstY || 0) + ((y - (t.srcY || 0)) * t.dstH / t.srcH)) : y;
        if (which === 'move') sharedRenderer.handleMouseMove(cx, cy);
        else if (which === 'down') sharedRenderer.handleMouseDown(cx, cy, 1);
        else if (sharedRenderer.handleMouseUp) sharedRenderer.handleMouseUp(cx, cy, 1);
      }, fn.x, fn.y, fn.which);
      await step({ x: gx, y: gy, which: 'move' });
      await wait(400);
      // Second move one pixel on: some guests only redraw/re-hit-test on a delta.
      await step({ x: gx + 1, y: gy + 1, which: 'move' });
      await wait(400);
      await step({ x: gx + 1, y: gy + 1, which: 'down' });
      await wait(400);
      await step({ x: gx + 1, y: gy + 1, which: 'up' });
      await wait(400);
      console.log(`clicked guest ${gx},${gy}`);
    }

    // Attribute time to the canvas primitives the presentation path uses.
    // putImageData is the interesting one: it is the raw-GDI-surface blit, it
    // runs on the main thread, and Chrome cannot GPU-accelerate it.
    await page.evaluate(() => {
      // BOTH prototypes: GDI surfaces are backed by OffscreenCanvas, whose 2D
      // context does NOT share CanvasRenderingContext2D.prototype. Patching
      // only the visible-canvas prototype reports "putImageData: 0 calls"
      // while every surface blit in the app goes past unmeasured.
      const protos = [CanvasRenderingContext2D.prototype];
      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined') {
        protos.push(OffscreenCanvasRenderingContext2D.prototype);
      }
      window.__canvasStats = { putImageData: { n: 0, ms: 0, px: 0 }, drawImage: { n: 0, ms: 0 }, getImageData: { n: 0, ms: 0 } };
      for (const proto of protos) for (const name of ['putImageData', 'drawImage', 'getImageData']) {
        const orig = proto[name];
        if (!orig) continue;
        proto[name] = function (...args) {
          const t = performance.now();
          const r = orig.apply(this, args);
          const s = window.__canvasStats[name];
          s.ms += performance.now() - t;
          s.n++;
          if (name === 'putImageData' && args[0] && args[0].width) s.px += args[0].width * args[0].height;
          return r;
        };
      }
    });

    // --cpu-profile: V8 sampling profiler over the same window, aggregated by
    // self time. Long tasks tell you a frame was blocked; this tells you by
    // what. Costs a little overhead, so it is opt-in.
    let cdp = null;
    if (CPU_PROFILE) {
      cdp = await page.target().createCDPSession();
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
      await cdp.send('Profiler.start');
    }

    // MACHINE LOAD, printed either side of the sample. This is not a detail:
    // on a busy box the SAME command has produced 48, 19 and 0 long tasks,
    // and reading that spread as a difference between configurations is the
    // easiest wrong conclusion available here. A frame profile taken at load
    // 40 measures the box, not the app.
    const loadBefore = os.loadavg();
    console.log(`load average before: ${loadBefore.map(n => n.toFixed(2)).join(' ')}`);

    console.log(`sampling ${SECONDS}s ...`);
    const result = await page.evaluate(seconds => new Promise(resolve => {
      const frames = [];
      const tasks = [];
      // LIVENESS. A page that is not running the guest at all reports a
      // flawless 60fps and zero long tasks, which is indistinguishable from
      // "smooth" unless something checks that the screen is actually moving.
      // Sample a strip of the canvas once a second and count distinct hashes.
      // Downscale the WHOLE canvas into a thumbnail and hash that. Sampling a
      // crop is how this probe lied on its first outing: a centre crop of a
      // Blobby match is net and sand, which barely move, so a live game read
      // as "idle" while the ball and both players animated just outside it.
      const screen = document.getElementById('screen');
      const thumb = document.createElement('canvas');
      thumb.width = 64; thumb.height = 48;
      const probeCtx = thumb.getContext('2d', { willReadFrequently: true });
      const hashes = [];
      const sizes = [];
      const probe = () => {
        if (!probeCtx || !screen || !screen.width || !screen.height) return;
        try {
          // Track the backing store size too: a canvas whose width/height is
          // reassigned reallocates and drops any GPU acceleration, which makes
          // every canvas op on it slower at once.
          sizes.push(screen.width + 'x' + screen.height);
          probeCtx.drawImage(screen, 0, 0, thumb.width, thumb.height);
          const d = probeCtx.getImageData(0, 0, thumb.width, thumb.height).data;
          let acc = 0;
          for (let i = 0; i < d.length; i += 7) acc = (acc * 31 + d[i]) | 0;
          hashes.push(acc);
        } catch (_) { /* tainted or zero-size canvas */ }
      };
      probe();
      const probeTimer = setInterval(probe, 1000);
      let observer = null;
      try {
        observer = new PerformanceObserver(list => {
          for (const e of list.getEntries()) tasks.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) });
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch (_) { /* longtask unsupported; frame intervals still work */ }
      let prev = performance.now();
      const t0 = prev;
      function tick(now) {
        frames.push(now - prev);
        prev = now;
        if (now - t0 < seconds * 1000) requestAnimationFrame(tick);
        else {
          if (observer) observer.disconnect();
          clearInterval(probeTimer);
          probe();
          resolve({
            frames, tasks, elapsed: now - t0,
            probes: hashes.length, distinct: new Set(hashes).size,
            canvasSizes: [...new Set(sizes)],
          });
        }
      }
      requestAnimationFrame(tick);
    }), SECONDS);

    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop');
      const byId = new Map(profile.nodes.map(n => [n.id, n]));
      const self = new Map();
      // timeDeltas[i] is the time attributed to samples[i].
      for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]);
        if (!n) continue;
        const f = n.callFrame;
        const where = f.url ? `${f.url.replace(/^https?:\/\/[^/]+\//, '')}:${f.lineNumber + 1}` : '';
        const key = `${f.functionName || '(anonymous)'}  ${where}`;
        self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
      }
      const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
      console.log('');
      console.log('CPU self time (top 12):');
      for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`  ${(100 * us / total).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${k}`);
      }
    }

    // The debug log panel grows without bound and appendDebugLog rebuilds its
    // whole textContent then forces a synchronous layout via scrollTop. Its
    // size is therefore a cost, not a curiosity.
    const logChars = await page.evaluate(() => {
      const el = document.getElementById('log');
      return el ? el.textContent.length : -1;
    });
    if (logChars >= 0) console.log(`debug log panel: ${logChars} chars`);

    const canvasStats = await page.evaluate(() => window.__canvasStats);
    console.log('');
    console.log('canvas primitives during the sample:');
    for (const [name, s] of Object.entries(canvasStats)) {
      const per = s.n ? (s.ms / s.n).toFixed(2) : '0.00';
      const px = s.px ? `  ${(s.px / 1e6).toFixed(1)}M px` : '';
      console.log(`  ${name.padEnd(13)} ${String(s.n).padStart(6)} calls  ${s.ms.toFixed(0).padStart(6)}ms total  ${per}ms each${px}`);
    }

    // Is the EMULATOR advancing, independent of what reaches the screen? A
    // guest can be running hard while drawing nothing, and a stopped guest
    // looks identical to a smooth one in frame stats alone.
    const eips = [];
    for (let i = 0; i < 5; i++) {
      eips.push(await page.evaluate(() => {
        const a = (typeof runningApps !== 'undefined' && runningApps[0]) || null;
        const e = a && a.wine && a.wine.instance && a.wine.instance.exports;
        return e && e.get_eip ? '0x' + (e.get_eip() >>> 0).toString(16) : null;
      }));
      await wait(200);
    }
    console.log(`guest eip samples: ${eips.join(' ')}  (${new Set(eips).size} distinct)`);
    if (SHOT) {
      await page.screenshot({ path: SHOT });
      console.log(`screenshot: ${SHOT}`);
    }

    if (REPORT_EVAL) {
      const r = await page.evaluate(js => String(eval(js)), REPORT_EVAL).catch(e => `error: ${e.message}`);
      console.log(`report-eval: ${r}`);
    }

    const loadAfter = os.loadavg();
    console.log(`load average after:  ${loadAfter.map(n => n.toFixed(2)).join(' ')}` +
      (loadAfter[0] > 4 ? '   <-- BUSY: treat the numbers below as a floor, not a measurement of the app' : ''));

    const f = stats(result.frames);
    console.log('');
    // Report liveness FIRST -- every number below is meaningless without it.
    if (result.distinct <= 1) {
      console.log(`WARNING: the screen never changed across ${result.probes} probes.`);
      console.log('The guest is idle or stopped, so the frame numbers below measure an idle page, not gameplay.');
    } else {
      console.log(`screen changed in ${result.distinct} of ${result.probes} probes (guest is live)`);
    }
    if (result.canvasSizes && result.canvasSizes.length > 1) {
      console.log(`WARNING: canvas backing store was resized during the sample: ${result.canvasSizes.join(' -> ')}`);
    } else if (result.canvasSizes) {
      console.log(`canvas: ${result.canvasSizes[0]} (stable)`);
    }
    console.log(`frames: ${f.n} in ${(result.elapsed / 1000).toFixed(1)}s  =>  ${(f.n / (result.elapsed / 1000)).toFixed(1)} fps average`);
    console.log('frame interval (ms)   mean    p50    p90    p99    max');
    console.log(`                   ${f.mean.toFixed(1).padStart(7)}${f.p50.toFixed(1).padStart(7)}` +
      `${f.p90.toFixed(1).padStart(7)}${f.p99.toFixed(1).padStart(7)}${f.max.toFixed(1).padStart(7)}`);

    // 33ms = a dropped frame at 60Hz; 100ms = visible hitch.
    const dropped = result.frames.filter(v => v > 33).length;
    const hitches = result.frames.filter(v => v > 100).length;
    console.log(`over 33ms: ${dropped} (${(100 * dropped / f.n).toFixed(1)}%)   over 100ms: ${hitches}`);

    if (result.tasks.length) {
      const t = stats(result.tasks.map(x => x.ms));
      console.log('');
      console.log(`long tasks (>50ms blocking the main thread): ${t.n}`);
      console.log(`  mean ${t.mean.toFixed(1)}ms  p50 ${t.p50}ms  p90 ${t.p90}ms  max ${t.max}ms`);
      console.log(`  total blocked: ${result.tasks.reduce((a, x) => a + x.ms, 0)}ms of ${Math.round(result.elapsed)}ms ` +
        `(${(100 * result.tasks.reduce((a, x) => a + x.ms, 0) / result.elapsed).toFixed(0)}%)`);
      // WHERE the stalls sit decides what they are: clustered at the start is
      // asset loading, spread across the run is steady-state cost.
      const t0 = result.tasks[0].start;
      console.log('  worst, as seconds into the sample:');
      for (const x of [...result.tasks].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
        console.log(`    +${((x.start - t0) / 1000).toFixed(1)}s  ${x.ms}ms`);
      }
    } else {
      console.log('');
      console.log('long tasks: none observed');
    }

    // Sawtooth check: are the slow frames spread out, or bunched?
    const RAMP = ' .:-=+*#%@';
    const BUCKETS = 60;
    const per = Math.max(1, Math.ceil(result.frames.length / BUCKETS));
    const cells = [];
    for (let i = 0; i < result.frames.length; i += per) {
      const chunk = result.frames.slice(i, i + per);
      cells.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
    }
    const peak = Math.max(...cells, 1);
    console.log('');
    console.log(`timeline (${per} frame(s)/cell, peak ${peak.toFixed(0)}ms):`);
    console.log('  ' + cells.map(v => RAMP[Math.min(9, Math.floor(v / peak * 9))]).join(''));

    if (problems.length) {
      console.log('');
      console.log('page problems:');
      for (const p of problems.slice(0, 5)) console.log('  ' + p);
    }
  } finally {
    await browser.close();
    if (server) server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
