#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function mime(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.js')) return 'text/javascript';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function serve() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(root, relative));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end(); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': mime(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-retina-scale2x-'));
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME,
    userDataDir: profile,
    timeout: 30000,
    args: [
      '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--enable-unsafe-swiftshader',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?debug`, {
      waitUntil: 'load', timeout: 60000,
    });
    await page.waitForFunction('typeof Win98Renderer === "function" && typeof resizeCanvas === "function"');
    await new Promise(resolve => setTimeout(resolve, 500));

    const result = await page.evaluate(() => {
      resizeCanvas();
      const source = document.getElementById('screen');
      const output = document.getElementById('screen-present');
      const retina = {
        dpr: devicePixelRatio,
        logical: [source.width, source.height],
        physical: [output.width, output.height],
        client: [output.clientWidth, output.clientHeight],
      };

      source.width = 3;
      source.height = 3;
      output.width = 6;
      output.height = 6;
      const renderer = new Win98Renderer(source);
      renderer.presentationFilter.resize(6, 6);
      renderer.setPresentationScaleMode('scale-auto');

      const ctx = source.getContext('2d');
      const image = ctx.createImageData(3, 3);
      for (let i = 0; i < 9; i++) {
        image.data[i * 4 + 3] = 255;
      }
      const set = (x, y, r, g, b) => {
        const p = (y * 3 + x) * 4;
        image.data[p] = r; image.data[p + 1] = g; image.data[p + 2] = b;
      };
      set(1, 0, 255, 0, 0); // B
      set(2, 0, 255, 255, 0); // C: differs from E so Scale3x E1 follows B
      set(0, 1, 255, 0, 0); // D: B == D makes E0 red
      set(2, 1, 0, 0, 255); // F
      set(0, 2, 0, 255, 255); // G: differs from E so Scale3x E3 follows D
      set(1, 2, 0, 255, 0); // H
      ctx.putImageData(image, 0, 0);
      renderer._presentDisplayCanvas();
      let pixels = output.getContext('2d').getImageData(0, 0, 6, 6).data;
      const pixel = (data, width, x, y) =>
        Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
      const scale2x = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastPixelScaleMultiplier,
        passes: renderer.presentationFilter.lastPixelScalePasses,
        e0: pixel(pixels, 6, 2, 2),
        e1: pixel(pixels, 6, 3, 2),
        e2: pixel(pixels, 6, 2, 3),
        e3: pixel(pixels, 6, 3, 3),
      };

      output.width = 9;
      output.height = 9;
      renderer.presentationFilter.resize(9, 9);
      renderer.setPresentationScaleMode('scale-auto');
      renderer._presentDisplayCanvas();
      pixels = output.getContext('2d').getImageData(0, 0, 9, 9).data;
      const scale3x = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastPixelScaleMultiplier,
        passes: renderer.presentationFilter.lastPixelScalePasses,
        topLeft: pixel(pixels, 9, 3, 3),
        topMiddle: pixel(pixels, 9, 4, 3),
        middleLeft: pixel(pixels, 9, 3, 4),
        center: pixel(pixels, 9, 4, 4),
        bottomRight: pixel(pixels, 9, 5, 5),
      };

      output.width = 12;
      output.height = 12;
      renderer.presentationFilter.resize(12, 12);
      renderer._presentDisplayCanvas();
      pixels = output.getContext('2d').getImageData(0, 0, 12, 12).data;
      const scale4x = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastPixelScaleMultiplier,
        passes: renderer.presentationFilter.lastPixelScalePasses,
        stage: renderer.presentationFilter.lastPixelScaleStage,
        center: pixel(pixels, 12, 6, 6),
      };

      source.width = 4;
      source.height = 4;
      output.width = 12;
      output.height = 12;
      renderer.presentationFilter.resize(12, 12);
      const uniform = source.getContext('2d');
      uniform.fillStyle = 'rgb(128, 64, 32)';
      uniform.fillRect(0, 0, 4, 4);
      renderer.setPresentationEffects({});
      renderer.setPresentationScaleMode('fsr1');
      renderer._presentDisplayCanvas();
      pixels = output.getContext('2d').getImageData(0, 0, 12, 12).data;
      const fsr1 = {
        backend: renderer.presentationFilter.lastBackend,
        center: pixel(pixels, 12, 6, 6),
      };

      uniform.fillStyle = 'rgb(0, 0, 0)';
      uniform.fillRect(0, 0, 2, 4);
      uniform.fillStyle = 'rgb(255, 255, 255)';
      uniform.fillRect(2, 0, 2, 4);
      renderer._presentDisplayCanvas();
      pixels = output.getContext('2d').getImageData(0, 0, 12, 12).data;
      fsr1.edge = [4, 5, 6, 7].map(x => pixel(pixels, 12, x, 6)[0]);

      uniform.fillStyle = 'rgb(128, 64, 32)';
      uniform.fillRect(0, 0, 4, 4);
      renderer.setPresentationEffects({ scanlines: true, mask: true, glow: true });
      renderer._presentDisplayCanvas();
      const crtPixels = output.getContext('2d').getImageData(0, 0, 12, 12).data;
      const composed = {
        backend: renderer.presentationFilter.lastBackend,
        effects: renderer.presentationFilter.lastEffects,
        triadR: pixel(crtPixels, 12, 3, 5),
        triadG: pixel(crtPixels, 12, 4, 5),
        pixels: Array.from(crtPixels),
      };

      source.width = 2;
      source.height = 2;
      const native = source.getContext('2d');
      const nativeImage = native.createImageData(2, 2);
      const nativeColors = [
        [255, 0, 0], [0, 255, 0],
        [0, 0, 255], [255, 255, 0],
      ];
      nativeColors.forEach((color, i) => {
        nativeImage.data[i * 4] = color[0];
        nativeImage.data[i * 4 + 1] = color[1];
        nativeImage.data[i * 4 + 2] = color[2];
        nativeImage.data[i * 4 + 3] = 255;
      });
      native.putImageData(nativeImage, 0, 0);
      output.width = 9;
      output.height = 6;
      renderer.presentationFilter.resize(9, 6);
      const integerViewport = {
        cropX: 0, cropY: 0, cropW: 2, cropH: 2,
        nativeW: 2, nativeH: 2,
        dstX: 1, dstY: 0, dstW: 6, dstH: 6,
        outputW: 9, outputH: 6, multiplier: 3,
      };
      renderer.presentationFilter.present(source, 'integer', {}, { viewport: integerViewport });
      const integerPixels = output.getContext('2d').getImageData(0, 0, 9, 6).data;
      const integer = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastIntegerMultiplier,
        viewport: integerViewport,
        bar: pixel(integerPixels, 9, 0, 2),
        red0: pixel(integerPixels, 9, 1, 0),
        red2: pixel(integerPixels, 9, 3, 2),
        green0: pixel(integerPixels, 9, 4, 0),
        blue0: pixel(integerPixels, 9, 1, 3),
        yellow2: pixel(integerPixels, 9, 6, 5),
      };

      output.width = 10;
      output.height = 7;
      renderer.presentationFilter.resize(10, 7);
      const sharpViewport = {
        cropX: 0, cropY: 0, cropW: 2, cropH: 2,
        nativeW: 2, nativeH: 2,
        dstX: 1, dstY: 0, dstW: 7, dstH: 7,
        outputW: 10, outputH: 7, multiplier: 3,
      };
      renderer.presentationFilter.present(source, 'scale-auto', {}, { viewport: sharpViewport });
      const scaleFractional = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastPixelScaleMultiplier,
        passes: renderer.presentationFilter.lastPixelScalePasses,
        stage: renderer.presentationFilter.lastPixelScaleStage,
      };
      renderer.presentationFilter.present(source, 'scale-auto',
        { scanlines: true, mask: true, glow: true }, { viewport: sharpViewport });
      const scaleCrt = {
        backend: renderer.presentationFilter.lastBackend,
        effects: renderer.presentationFilter.lastEffects,
      };
      renderer.presentationFilter.present(source, 'sharp-hq', {}, { viewport: sharpViewport });
      const sharp = {
        backend: renderer.presentationFilter.lastBackend,
        multiplier: renderer.presentationFilter.lastIntegerMultiplier,
        stage: [renderer.presentationFilter._sharpStage.width,
          renderer.presentationFilter._sharpStage.height],
        viewport: sharpViewport,
      };

      source.width = 8;
      source.height = 8;
      output.width = 16;
      output.height = 16;
      renderer.presentationFilter.resize(16, 16);
      const ditherCtx = source.getContext('2d');
      const checkerImage = ditherCtx.createImageData(8, 8);
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const p = (y * 8 + x) * 4;
          checkerImage.data[p] = ((x + y) & 1) ? 0 : 255;
          checkerImage.data[p + 2] = ((x + y) & 1) ? 255 : 0;
          checkerImage.data[p + 3] = 255;
        }
      }
      ditherCtx.putImageData(checkerImage, 0, 0);
      renderer.presentationFilter.present(source, 'scale-auto', {},
        { dedither: 'checkerboard' });
      let deditherPixels = output.getContext('2d').getImageData(0, 0, 16, 16).data;
      const checkerboard = {
        backend: renderer.presentationFilter.lastDeditherBackend,
        scale: renderer.presentationFilter.lastPixelScaleMultiplier,
        center: pixel(deditherPixels, 16, 8, 8),
      };

      output.width = 8;
      output.height = 8;
      renderer.presentationFilter.resize(8, 8);
      ditherCtx.fillStyle = 'rgb(255, 0, 0)';
      ditherCtx.fillRect(0, 0, 4, 8);
      ditherCtx.fillStyle = 'rgb(0, 0, 255)';
      ditherCtx.fillRect(4, 0, 4, 8);
      renderer.presentationFilter.present(source, 'nearest', {},
        { dedither: 'checkerboard' });
      deditherPixels = output.getContext('2d').getImageData(0, 0, 8, 8).data;
      checkerboard.edgeLeft = pixel(deditherPixels, 8, 2, 4);
      checkerboard.edgeRight = pixel(deditherPixels, 8, 5, 4);

      source.width = 12;
      source.height = 12;
      output.width = 12;
      output.height = 12;
      renderer.presentationFilter.resize(12, 12);
      const orderedCtx = source.getContext('2d');
      const orderedImage = orderedCtx.createImageData(12, 12);
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
          const p = (y * 12 + x) * 4;
          const bright = (x & 1) === 0 && (y & 1) === 0;
          orderedImage.data[p] = bright ? 255 : 0;
          orderedImage.data[p + 1] = bright ? 255 : 0;
          orderedImage.data[p + 2] = bright ? 255 : 0;
          orderedImage.data[p + 3] = 255;
        }
      }
      orderedCtx.putImageData(orderedImage, 0, 0);
      renderer.presentationFilter.present(source, 'nearest', {},
        { dedither: 'ordered2' });
      deditherPixels = output.getContext('2d').getImageData(0, 0, 12, 12).data;
      const ordered2 = {
        backend: renderer.presentationFilter.lastDeditherBackend,
        quarter: pixel(deditherPixels, 12, 4, 4),
      };
      return {
        retina,
        scale2x,
        scale3x,
        scale4x,
        scaleFractional,
        scaleCrt,
        fsr1,
        composed,
        integer,
        sharp,
        checkerboard,
        ordered2,
        gpuError: String(renderer.presentationFilter.lastError || ''),
      };
    });

    assert.strictEqual(result.retina.dpr, 2);
    assert.strictEqual(result.retina.physical[0], Math.round(result.retina.client[0] * 2));
    assert.strictEqual(result.retina.physical[1], Math.round(result.retina.client[1] * 2));
    assert.notDeepStrictEqual(result.retina.logical, result.retina.physical,
      'logical Win98 canvas should remain distinct from the DPR output');
    assert.strictEqual(result.scale2x.backend, 'webgl-scale2x', result.gpuError);
    assert.strictEqual(result.scale2x.multiplier, 2);
    assert.deepStrictEqual(result.scale2x.passes, ['scale2x']);
    assert.deepStrictEqual(result.scale2x.e0, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.scale2x.e1, [0, 0, 0, 255]);
    assert.deepStrictEqual(result.scale2x.e2, [0, 0, 0, 255]);
    assert.deepStrictEqual(result.scale2x.e3, [0, 0, 0, 255]);

    assert.strictEqual(result.scale3x.backend, 'webgl-scale3x', result.gpuError);
    assert.strictEqual(result.scale3x.multiplier, 3);
    assert.deepStrictEqual(result.scale3x.passes, ['scale3x']);
    assert.deepStrictEqual(result.scale3x.topLeft, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.scale3x.topMiddle, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.scale3x.middleLeft, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.scale3x.center, [0, 0, 0, 255]);
    assert.deepStrictEqual(result.scale3x.bottomRight, [0, 0, 0, 255]);

    assert.strictEqual(result.scale4x.backend, 'webgl-scale4x', result.gpuError);
    assert.strictEqual(result.scale4x.multiplier, 4);
    assert.deepStrictEqual(result.scale4x.passes, ['scale2x', 'scale2x'],
      '4x must be two canonical Scale2x passes, not one virtual 4x evaluation');
    assert.deepStrictEqual(result.scale4x.stage,
      { width: 12, height: 12, targetWidth: 12, targetHeight: 12, corrected: false });
    assert.deepStrictEqual(result.scale4x.center, [0, 0, 0, 255]);

    assert.strictEqual(result.scaleFractional.backend, 'webgl-scale3x+canvas-hq', result.gpuError);
    assert.strictEqual(result.scaleFractional.multiplier, 3);
    assert.deepStrictEqual(result.scaleFractional.passes, ['scale3x']);
    assert.deepStrictEqual(result.scaleFractional.stage,
      { width: 6, height: 6, targetWidth: 7, targetHeight: 7, corrected: true },
      'browser HQ should only correct the canonical stage into the exact aspect-fit viewport');
    assert.strictEqual(result.scaleCrt.backend,
      'webgl-scale3x+canvas-hq+crt', result.gpuError);
    assert.deepStrictEqual(result.scaleCrt.effects,
      { scanlines: true, mask: true, glow: true },
      'CRT should run after the canonical scale and browser-HQ correction');

    assert.strictEqual(result.checkerboard.backend, 'webgl-checkerboard', result.gpuError);
    assert.strictEqual(result.checkerboard.scale, 2,
      'dedither should run at native resolution before the selected scaler');
    assert(Math.abs(result.checkerboard.center[0] - 128) <= 1 &&
      Math.abs(result.checkerboard.center[2] - 128) <= 1,
    `checkerboard should reconstruct the red/blue midpoint: ${result.checkerboard.center}`);
    assert.deepStrictEqual(result.checkerboard.edgeLeft, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.checkerboard.edgeRight, [0, 0, 255, 255],
      'checkerboard detection must leave an ordinary solid edge intact');
    assert.strictEqual(result.ordered2.backend, 'webgl-ordered2', result.gpuError);
    assert(result.ordered2.quarter.slice(0, 3).every(channel => Math.abs(channel - 64) <= 1),
      `ordered 25% tile should reconstruct its average: ${result.ordered2.quarter}`);

    assert.strictEqual(result.fsr1.backend, 'webgl-fsr1', result.gpuError);
    assert(Math.abs(result.fsr1.center[0] - 128) <= 2);
    assert(Math.abs(result.fsr1.center[1] - 64) <= 2);
    assert(Math.abs(result.fsr1.center[2] - 32) <= 2);
    assert.strictEqual(result.fsr1.center[3], 255);
    assert(result.fsr1.edge[0] < 32 && result.fsr1.edge[1] < 96,
      `EASU should keep the dark side of a vertical edge crisp: ${result.fsr1.edge}`);
    assert(result.fsr1.edge[2] > 159 && result.fsr1.edge[3] > 223,
      `EASU should keep the bright side of a vertical edge crisp: ${result.fsr1.edge}`);

    assert.strictEqual(result.composed.backend, 'webgl-fsr1+crt', result.gpuError);
    assert.deepStrictEqual(result.composed.effects,
      { scanlines: true, mask: true, glow: true });
    assert(result.composed.triadR[0] > result.composed.triadG[0],
      'red phosphor column should preserve more red than the green column');
    assert(result.composed.triadG[1] > result.composed.triadR[1],
      'green phosphor column should preserve more green than the red column');
    assert.notDeepStrictEqual(result.composed.triadR, result.fsr1.center,
      'CRT effects should alter FSR1 output without becoming a scaling mode');

    assert.strictEqual(result.integer.backend, 'canvas-nearest');
    assert.strictEqual(result.integer.multiplier, 3);
    assert.strictEqual(result.integer.viewport.dstW * result.integer.viewport.nativeH,
      result.integer.viewport.dstH * result.integer.viewport.nativeW,
      'physical integer viewport must preserve native aspect ratio exactly');
    assert.deepStrictEqual(result.integer.bar, [0, 0, 0, 255]);
    assert.deepStrictEqual(result.integer.red0, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.integer.red2, [255, 0, 0, 255]);
    assert.deepStrictEqual(result.integer.green0, [0, 255, 0, 255]);
    assert.deepStrictEqual(result.integer.blue0, [0, 0, 255, 255]);
    assert.deepStrictEqual(result.integer.yellow2, [255, 255, 0, 255]);

    assert.strictEqual(result.sharp.backend, 'canvas-sharp-hq');
    assert.strictEqual(result.sharp.multiplier, 3);
    assert.deepStrictEqual(result.sharp.stage, [6, 6],
      'Sharp HQ should build its integer stage from the physical multiplier');
    assert.strictEqual(result.sharp.viewport.dstW * result.sharp.viewport.nativeH,
      result.sharp.viewport.dstH * result.sharp.viewport.nativeW,
      'sharp physical destination must preserve native aspect ratio');
    console.log('PASS  native dedither, auto 2x/3x/4x, HQ correction, Retina staging, aspect ratio, and CRT');
  } finally {
    await browser.close();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
