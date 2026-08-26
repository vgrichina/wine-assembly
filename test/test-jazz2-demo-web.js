#!/usr/bin/env node
'use strict';

// Fast production-path smoke plus an opt-in diagnostic for Jazz's striped J2V.
//
// J2V has already released its startup DirectDraw surfaces by the time the
// bad frame is visible.  The video decoder writes an 8-bpp CreateDIBSection,
// and StretchBlt converts that canonical source into the window's GDI surface.
// Capture raw indices, palette-expanded source, and StretchBlt target from the
// same synchronous upload so corruption can be assigned to one exact layer.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXE = path.join(ROOT,
  'test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/jazz2.exe');
const OUT = path.join(ROOT, 'scratch', 'jazz2-demo-web');

if (!fs.existsSync(CHROME) || !fs.existsSync(EXE)) {
  console.log('SKIP Chrome or local Jazz Jackrabbit 2 payload is absent');
  process.exit(0);
}

function mimeType(file) {
  return ({
    '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.wasm': 'application/wasm',
  })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function startServer() {
  return new Promise((resolve, reject) => {
    const root = fs.realpathSync(ROOT);
    const server = http.createServer((request, response) => {
      let pathname;
      try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
      catch (_) { response.writeHead(400); response.end(); return; }
      if (pathname === '/') pathname = '/index.html';
      const file = path.normalize(path.join(root, pathname));
      if (file !== root && !file.startsWith(root + path.sep)) {
        response.writeHead(403); response.end(); return;
      }
      fs.readFile(file, (error, bytes) => {
        if (error) { response.writeHead(404); response.end(); return; }
        response.writeHead(200, {
          'Content-Type': mimeType(file),
          'Cache-Control': 'no-store',
        });
        response.end(bytes);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function installLayerProbe(page) {
  return page.evaluate(() => {
    if (window.__waJazzLayerProbeInstalled) return false;
    window.__waJazzLayerProbeInstalled = true;
    const originalCreateHostImports = window.createHostImports;
    if (typeof originalCreateHostImports !== 'function') {
      throw new Error('createHostImports is unavailable before Jazz launch');
    }

    const rounded = value => Number(value.toFixed(4));
    const spread = values => Math.max(...values) - Math.min(...values);

    // Sample every fourth row but every column. The reported corruption is a
    // full-height period-eight column, so this retains the discriminating axis
    // while keeping the synchronous import hook cheap enough for every frame.
    function colorPhases(surface) {
      const phase = Array.from({ length: 8 }, () => ({ luma: 0, black: 0, n: 0 }));
      const yStep = Math.max(1, Math.floor(surface.height / 64));
      for (let y = 0; y < surface.height; y += yStep) {
        for (let x = 0; x < surface.width; x++) {
          const color = surface.readPixel(x, y) >>> 0;
          const r = color & 255, g = (color >>> 8) & 255, b = (color >>> 16) & 255;
          const p = phase[x & 7];
          p.luma += (r * 3 + g * 6 + b) / 10;
          if (r + g + b < 12) p.black++;
          p.n++;
        }
      }
      const result = phase.map((p, index) => ({
        phase: index,
        luma: Number((p.luma / Math.max(1, p.n)).toFixed(2)),
        black: rounded(p.black / Math.max(1, p.n)),
      }));
      return {
        phase: result,
        blackSpread: rounded(spread(result.map(item => item.black))),
        lumaSpread: Number(spread(result.map(item => item.luma)).toFixed(2)),
      };
    }

    function indexPhases(presentation) {
      const surface = presentation.surface;
      const phase = Array.from({ length: 8 }, () => ({
        counts: new Uint32Array(256), total: 0, n: 0,
      }));
      const yStep = Math.max(1, Math.floor(surface.height / 64));
      for (let y = 0; y < surface.height; y += yStep) {
        const storedY = surface.topDown ? y : surface.height - 1 - y;
        const row = surface.storageOffset + storedY * surface.stride;
        for (let x = 0; x < surface.width; x++) {
          const value = surface.storage[row + x];
          const p = phase[x & 7];
          p.counts[value]++;
          p.total += value;
          p.n++;
        }
      }
      const result = phase.map((p, index) => {
        let mode = 0;
        for (let i = 1; i < 256; i++) if (p.counts[i] > p.counts[mode]) mode = i;
        return {
          phase: index,
          mode,
          mean: Number((p.total / Math.max(1, p.n)).toFixed(2)),
          zero: rounded(p.counts[0] / Math.max(1, p.n)),
          concentration: rounded(p.counts[mode] / Math.max(1, p.n)),
          modeRgb: surface.palette && surface.palette[mode] || null,
        };
      });
      return {
        phase: result,
        zeroSpread: rounded(spread(result.map(item => item.zero))),
        meanSpread: Number(spread(result.map(item => item.mean)).toFixed(2)),
      };
    }

    window.createHostImports = function jazzProbeCreateHostImports(ctx) {
      const base = originalCreateHostImports(ctx);
      // Worker instances can share the presentation map. Only the main
      // instance owns Jazz's window GDI path and should emit observations.
      if ((ctx.threadId | 0) !== 0) return base;
      const presentations = base.gdi.surfacePresentations;
      const rawUpload = base.host.gdi_surface_upload;
      let ordinal = 0;
      base.host.gdi_surface_upload = function jazzProbeUpload(id, ...rect) {
        const result = rawUpload(id, ...rect);
        if (!result) return result;
        const target = presentations.get(id >>> 0);
        if (!target || target.directDraw || !target.targetHwnd ||
            !target.surface || target.surface.bpp !== 32 || !target.uploaded ||
            target.width < 160 || target.height < 100) return result;
        const sources = [...presentations.values()].filter(item => item &&
          !item.directDraw && !item.targetHwnd && item.surface &&
          item.surface.bpp === 8 && item.paletteWa && item.paletteCount > 0 &&
          item.width >= 160 && item.height >= 100).sort((a, b) =>
            (b.width * b.height - a.width * a.height) ||
            ((b.version | 0) - (a.version | 0)));
        if (!sources.length) return result;
        ordinal++;
        const source = sources[0];
        if (source.refreshPalette) source.refreshPalette();
        const raw = indexPhases(source);
        const sourceRgba = colorPhases(source.surface);
        const targetRgba = colorPhases(target.surface);
        const observation = {
          ordinal,
          rect,
          target: {
            id: target.id, width: target.width, height: target.height,
            stride: target.surface.stride, topDown: target.surface.topDown,
            version: target.version | 0, metrics: targetRgba,
          },
          source: {
            id: source.id, width: source.width, height: source.height,
            stride: source.surface.stride, topDown: source.surface.topDown,
            bitsWa: source.bitsWa, paletteWa: source.paletteWa,
            paletteCount: source.paletteCount, version: source.version | 0,
            raw, rgba: sourceRgba,
          },
          catalog: [...presentations.values()].map(item => ({
            id: item.id, width: item.width, height: item.height,
            bpp: item.surface && item.surface.bpp,
            version: item.version | 0, targetHwnd: item.targetHwnd || 0,
            directDraw: !!item.directDraw,
          })),
        };
        // Console events escape without a follow-up Runtime.evaluate. That is
        // essential here: one Jazz image block can keep the renderer main
        // thread occupied until after the browser test's hard deadline.
        console.log('[jazz-layer] ' + JSON.stringify(observation));
        return result;
      };
      return base;
    };
    return true;
  });
}

function installCliLayerHook() {
  const { PNG } = require('pngjs');
  const hostImports = require('../lib/host-imports');
  const originalCreateHostImports = hostImports.createHostImports;
  const outDir = process.env.WA_JAZZ_LAYER_OUT || OUT;
  const captureOrdinal = parseInt(process.env.WA_JAZZ_CAPTURE_ORDINAL || '0', 10) || 0;
  fs.mkdirSync(outDir, { recursive: true });

  const spread = values => Math.max(...values) - Math.min(...values);
  function colorPhases(surface, rect) {
    const x0 = rect ? Math.max(0, rect[0] | 0) : 0;
    const y0 = rect ? Math.max(0, rect[1] | 0) : 0;
    const x1 = rect ? Math.min(surface.width, rect[2] | 0) : surface.width;
    const y1 = rect ? Math.min(surface.height, rect[3] | 0) : surface.height;
    const phase = Array.from({ length: 8 }, () => ({ luma: 0, black: 0, n: 0 }));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const color = surface.readPixel(x, y) >>> 0;
        const r = color & 255, g = (color >>> 8) & 255, b = (color >>> 16) & 255;
        const p = phase[x & 7];
        p.luma += (r * 3 + g * 6 + b) / 10;
        if (r + g + b < 12) p.black++;
        p.n++;
      }
    }
    const result = phase.map((p, index) => ({
      phase: index,
      luma: Number((p.luma / Math.max(1, p.n)).toFixed(2)),
      black: Number((p.black / Math.max(1, p.n)).toFixed(4)),
    }));
    return {
      phase: result,
      blackSpread: Number(spread(result.map(item => item.black)).toFixed(4)),
      lumaSpread: Number(spread(result.map(item => item.luma)).toFixed(2)),
    };
  }
  function indexPhases(presentation) {
    const { surface } = presentation;
    const phase = Array.from({ length: 8 }, () => ({
      counts: new Uint32Array(256), total: 0, n: 0,
    }));
    for (let y = 0; y < surface.height; y++) {
      const storedY = surface.topDown ? y : surface.height - 1 - y;
      const row = surface.storageOffset + storedY * surface.stride;
      for (let x = 0; x < surface.width; x++) {
        const value = surface.storage[row + x];
        const p = phase[x & 7];
        p.counts[value]++;
        p.total += value;
        p.n++;
      }
    }
    const result = phase.map((p, index) => {
      let mode = 0;
      for (let i = 1; i < 256; i++) if (p.counts[i] > p.counts[mode]) mode = i;
      return {
        phase: index, mode,
        mean: Number((p.total / Math.max(1, p.n)).toFixed(2)),
        zero: Number((p.counts[0] / Math.max(1, p.n)).toFixed(4)),
        concentration: Number((p.counts[mode] / Math.max(1, p.n)).toFixed(4)),
        modeRgb: surface.palette && surface.palette[mode] || null,
      };
    });
    return {
      phase: result,
      zeroSpread: Number(spread(result.map(item => item.zero)).toFixed(4)),
      meanSpread: Number(spread(result.map(item => item.mean)).toFixed(2)),
    };
  }
  function saveSurface(surface, file) {
    const png = new PNG({ width: surface.width, height: surface.height });
    png.data.set(surface.rgbaRect(0, 0, surface.width, surface.height));
    fs.writeFileSync(file, PNG.sync.write(png));
  }
  function saveIndices(presentation, file) {
    const { surface } = presentation;
    const png = new PNG({ width: surface.width, height: surface.height });
    for (let y = 0; y < surface.height; y++) {
      const storedY = surface.topDown ? y : surface.height - 1 - y;
      const row = surface.storageOffset + storedY * surface.stride;
      for (let x = 0; x < surface.width; x++) {
        const value = surface.storage[row + x];
        const p = (y * surface.width + x) * 4;
        png.data[p] = value; png.data[p + 1] = value; png.data[p + 2] = value;
        png.data[p + 3] = 255;
      }
    }
    fs.writeFileSync(file, PNG.sync.write(png));
  }

  hostImports.createHostImports = ctx => {
    const base = originalCreateHostImports(ctx);
    if ((ctx.threadId | 0) !== 0) return base;
    const presentations = base.gdi.surfacePresentations;
    const rawUpload = base.host.gdi_surface_upload;
    let ordinal = 0;
    let saved = false;
    base.host.gdi_surface_upload = (id, ...rect) => {
      const result = rawUpload(id, ...rect);
      if (!result || saved) return result;
      const target = presentations.get(id >>> 0);
      if (!target || target.directDraw || !target.targetHwnd || !target.surface ||
          target.surface.bpp !== 32 || target.width < 160 || target.height < 100) return result;
      // The logo J2V is always StretchBlt'd as 320x200 -> 320x218. Ignore the
      // unrelated 600x120 loading splash entirely; measuring every splash
      // upload made the diagnostic itself dominate startup.
      if ((rect[2] | 0) - (rect[0] | 0) !== 320 ||
          (rect[3] | 0) - (rect[1] | 0) !== 218) return result;
      const sources = [...presentations.values()].filter(item => item &&
        !item.directDraw && !item.targetHwnd && item.surface && item.surface.bpp === 8 &&
        item.paletteWa && item.paletteCount > 0 && item.width === 320 && item.height === 200)
        .sort((a, b) => ((b.version | 0) - (a.version | 0)));
      if (!sources.length) return result;
      ordinal++;
      const source = sources[0];
      if (source.refreshPalette) source.refreshPalette();
      const metrics = {
        ordinal, rect,
        target: { id: target.id, width: target.width, height: target.height,
          version: target.version | 0, rgba: colorPhases(target.surface, rect) },
        source: { id: source.id, width: source.width, height: source.height,
          stride: source.surface.stride, topDown: source.surface.topDown,
          raw: indexPhases(source), rgba: colorPhases(source.surface) },
      };
      const corrupt = metrics.target.rgba.blackSpread >= 0.35 ||
        metrics.target.rgba.lumaSpread >= 35;
      if (!corrupt && ordinal !== captureOrdinal) return result;
      saved = true;
      saveIndices(source, path.join(outDir, 'indices.png'));
      saveSurface(source.surface, path.join(outDir, 'source.png'));
      saveSurface(target.surface, path.join(outDir, 'target.png'));
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(metrics, null, 2));
      console.log('[jazz-layer-cli] ' + JSON.stringify(metrics));
      return result;
    };
    return base;
  };
}

async function runBrowserProbe() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-jazz-video-'));
  let browser = null;
  let watchdog = null;
  const errors = [];
  const captures = [];
  let resolveMatched;
  const matched = new Promise(resolve => { resolveMatched = resolve; });
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROME,
      userDataDir: profile,
      protocolTimeout: 210000,
      args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
    });
    const hardDeadline = new Promise((_, reject) => {
      watchdog = setTimeout(() => {
        const child = browser && browser.process();
        if (child && child.pid) {
          try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
        }
        reject(new Error('Jazz layer probe exceeded its internal 45s deadline'));
      }, 45000);
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.stack || String(error)));
    page.on('console', message => {
      const text = message.text();
      if (text.startsWith('[jazz-layer] ')) {
        try {
          const capture = JSON.parse(text.slice('[jazz-layer] '.length));
          captures.push(capture);
          fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(captures, null, 2));
          console.log(`[jazz-layer] ordinal=${capture.ordinal} ` +
            `raw.zeroSpread=${capture.source.raw.zeroSpread} ` +
            `source.blackSpread=${capture.source.rgba.blackSpread} ` +
            `target.blackSpread=${capture.target.metrics.blackSpread}`);
          // Production intentionally jumps straight to Share1.j2l. Its only
          // J2V/GDI work is the loading splash, whose third upload contains
          // the copied image rather than the target's initial black backing.
          if (capture.ordinal >= 3) resolveMatched(capture);
        } catch (error) {
          errors.push(`invalid jazz-layer payload: ${error.message}`);
        }
        return;
      }
      if (/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(text)) {
        errors.push(text);
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug&no-log`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => typeof launchApp === 'function' && apps.jazz2_demo,
      { timeout: 30000 });
    await page.select('#app-select', 'jazz2_demo');
    assert.strictEqual(await page.evaluate(() => apps.jazz2_demo.args),
      'Share1.j2l -nonetwork');
    assert.strictEqual(await installLayerProbe(page), true,
      'Jazz layer hook was not installed before launch');
    // Production's app-scoped auto slice is 1000. A measured Jazz image loop
    // held even a 100-block browser call past the former outer timeout,
    // preventing a post-launch CDP probe from arming.
    // A one-block slice preserves guest/renderer semantics while yielding
    // often enough for the observer to run. The production value remains
    // asserted below.
    const slices = await page.evaluate(() => {
      const select = document.getElementById('slice-size-select');
      const production = wineShell.selectedRunSlice('jazz2_demo');
      const option = document.createElement('option');
      option.value = '1';
      option.textContent = '1 (diagnostic)';
      select.appendChild(option);
      select.value = '1';
      return {
        production,
        diagnostic: parseInt(select.value, 10),
      };
    });
    assert.deepStrictEqual(slices, { production: 1000, diagnostic: 1 });
    // Queue launch in the page and return from Runtime.evaluate first. The
    // already-wrapped host imports emit exact synchronous observations even
    // while the guest is occupying the renderer thread.
    await page.evaluate(() => setTimeout(() => launchApp(), 0));
    const clean = await Promise.race([matched, hardDeadline]);
    assert(clean.source.raw.zeroSpread < 0.05,
      `production splash raw indices are unexpectedly periodic: ${clean.source.raw.zeroSpread}`);
    assert(clean.source.rgba.blackSpread < 0.05,
      `production splash palette expansion is unexpectedly periodic: ${clean.source.rgba.blackSpread}`);
    assert(clean.target.metrics.blackSpread < 0.05,
      `production splash StretchBlt target is unexpectedly periodic: ${clean.target.metrics.blackSpread}`);
    const result = { classification: 'clean-production-splash', clean,
      captures: captures.length };
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
    assert.strictEqual(errors.length, 0, errors.join('\n'));
    console.log('PASS Jazz production direct-level splash is matched and clean through GDI');
    console.log(`Artifacts: ${OUT}`);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (browser) {
      const child = browser.process();
      await Promise.race([
        browser.close().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
      if (child && child.pid && child.exitCode === null) {
        try { process.kill(child.pid, 'SIGKILL'); } catch (_) {}
      }
    }
    await Promise.race([
      new Promise(resolve => server.close(resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function runLogoDiagnostic() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const child = spawnSync(process.execPath, [
    '-r', __filename,
    path.join(ROOT, 'test', 'run.js'),
    '--app=jazz2_demo', '--args=', '--quiet-api', '--batch-size=1000',
    '--max-batches=1230',
  ], {
    cwd: ROOT,
    env: { ...process.env, WA_JAZZ_CLI_HOOK: '1', WA_JAZZ_LAYER_OUT: OUT,
      WA_JAZZ_CAPTURE_ORDINAL: '148' },
    encoding: 'utf8',
    timeout: 70000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(OUT, 'cli.log'), (child.stdout || '') + (child.stderr || ''));
  assert.strictEqual(child.error, undefined, child.error && child.error.message);
  assert.strictEqual(child.status, 0,
    `Jazz logo CLI exited ${child.status}; see ${path.join(OUT, 'cli.log')}`);
  const resultFile = path.join(OUT, 'result.json');
  assert(fs.existsSync(resultFile), 'Jazz logo did not reach matched GDI ordinal 148');
  const matched = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.strictEqual(matched.ordinal, 148,
    `Jazz exposed periodic corruption before ordinal 148 (ordinal ${matched.ordinal})`);
  const rawPeriodic = matched.source.raw.zeroSpread >= 0.35 ||
    matched.source.raw.meanSpread >= 35;
  const sourcePeriodic = matched.source.rgba.blackSpread >= 0.35 ||
    matched.source.rgba.lumaSpread >= 35;
  const targetPeriodic = matched.target.rgba.blackSpread >= 0.35 ||
    matched.target.rgba.lumaSpread >= 35;
  assert(!rawPeriodic, 'Jazz ordinal 148 raw indices retain period-eight corruption');
  assert(!sourcePeriodic, 'Jazz ordinal 148 palette expansion retains period-eight corruption');
  assert(!targetPeriodic, 'Jazz ordinal 148 StretchBlt target retains period-eight corruption');
  const classification = 'clean-after-fxch-raw64';
  fs.writeFileSync(path.join(OUT, 'classification.json'), JSON.stringify({
    classification, matched,
  }, null, 2));
  console.log('PASS Jazz logo ordinal 148 is clean through raw indices, palette, and StretchBlt');
  console.log(`Artifacts: ${OUT}`);
}

if (process.env.WA_JAZZ_CLI_HOOK === '1') {
  installCliLayerHook();
} else if (process.env.JAZZ_STRIPE_DIAGNOSTIC === '1') {
  runLogoDiagnostic().catch(error => { console.error(error.stack || error); process.exit(1); });
} else {
  runBrowserProbe().catch(error => { console.error(error.stack || error); process.exit(1); });
}
