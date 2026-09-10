#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const inspect = require('../tools/png-inspect');

const ROOT = path.join(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-png-inspect-'));
const source = path.join(temp, 'fixture.png');

function run(tool, ...args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

try {
  const legacyTools = ['png-crop.js', 'png-probe.js', 'png-rows.js',
    'png-stats.js', 'png-window.js', 'png-pixel.js', 'png-crop-desktop.js'];
  for (const tool of legacyTools) {
    const sourceText = fs.readFileSync(path.join(ROOT, 'tools', tool), 'utf8');
    assert.match(sourceText, /require\('\.\/png-inspect'\)/,
      `${tool} must delegate to the shared inspector`);
    assert.doesNotMatch(sourceText, /PNG\.sync|readFileSync\(/,
      `${tool} must not grow another decoder or pixel implementation`);
  }

  const image = new PNG({ width: 8, height: 8 });
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = 0;
      image.data[offset + 1] = 128;
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  const set = (x, y, r, g, b, a = 255) => {
    const offset = (y * image.width + x) * 4;
    image.data[offset] = r; image.data[offset + 1] = g;
    image.data[offset + 2] = b; image.data[offset + 3] = a;
  };
  set(1, 1, 0, 0, 0);
  for (let x = 2; x <= 6; x++) set(x, 2, 255, 255, 255);
  for (let y = 2; y <= 6; y++) set(2, y, 255, 255, 255);
  set(4, 4, 192, 192, 192, 0);
  fs.writeFileSync(source, PNG.sync.write(image));

  const loaded = inspect.loadPng(source);
  assert.deepStrictEqual(inspect.pixel(loaded, 1, 1), [0, 0, 0, 255]);
  assert.strictEqual(inspect.pixel(loaded, 20, 20), null);
  assert.strictEqual(inspect.rgbKey(loaded, 2, 2), 0xffffff);
  assert.deepStrictEqual(inspect.contentBox(loaded), { x0: 1, y0: 1, x1: 6, y1: 6 });
  assert.strictEqual(inspect.matchingPixels(loaded, [255, 255, 255]).points.length, 9);
  const hist = inspect.histogram(loaded);
  assert.strictEqual(hist.total, 64);
  assert.strictEqual(hist.transparent, 1);
  assert.strictEqual(inspect.cropImage(loaded, 1, 1, 2, 2, 2).width, 4);

  assert.match(run('png-pixel.js', '1,1;20,20', source),
    /\(1,1\)=000000.*\(20,20\)=out-of-range/);
  assert.match(run('png-pixel.js', '--black', source), /black 1 .*bbox 1,1-1,1/);
  assert.match(run('png-stats.js', source, '--top=2'), /distinct colours: 4/);
  assert.match(run('png-probe.js', source, '--at=1,1'), /rgba\(0,0,0,255\)/);
  assert.match(run('png-window.js', source, '1', '1', '2', '1', '--mode=hex'),
    /000000 008080/);
  assert.match(run('png-rows.js', source, '--hist=2'), /#008080\s+53/);
  assert.match(run('png-crop.js', source, '--boxes', '--min=4'),
    /x=2\s+y=2\s+w=5\s+h=5/);

  const crop = path.join(temp, 'crop.png');
  assert.match(run('png-crop.js', source, '--rect=1,1,2,2', '--scale=2', `--out=${crop}`),
    /2x2 at 1,1 scaled 2x/);
  assert.deepStrictEqual([inspect.loadPng(crop).width, inspect.loadPng(crop).height], [4, 4]);
  assert.match(run('png-crop-desktop.js', source, '--dry-run', '--pad=0'),
    /crop\s+fixture\.png\s+8x8 -> 6x6/);
  assert.match(run('png-inspect.js', 'pixel', '1,1', source), /\(1,1\)=000000/);

  const legacy = require('../tools/png-crop-desktop');
  assert.strictEqual(legacy.cropFile, inspect.cropFile);
  assert.strictEqual(legacy.contentBox, inspect.contentBox);
  console.log('PASS  seven PNG inspector entry points share one implementation');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
