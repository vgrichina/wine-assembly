#!/usr/bin/env node
'use strict';

const assert = require('assert');
const puppeteer = require('puppeteer');

const url = process.argv[2] || 'http://127.0.0.1:8765/';
const screenshot = process.argv[3] || '/private/tmp/undither-testbed.png';
const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('completed'),
      { timeout: 30000 });

    const initial = await page.evaluate(() => ({
      samples: document.querySelector('#sample').options.length,
      algorithms: document.querySelector('#algorithm').options.length,
      selectedAlgorithm: document.querySelector('#algorithm').value,
      original: [document.querySelector('#original-full').width, document.querySelector('#original-full').height],
      output: [document.querySelector('#output-full').width, document.querySelector('#output-full').height],
      palette: document.querySelectorAll('#palette .swatch').length,
      stats: document.querySelector('#stats').textContent,
    }));
    assert.strictEqual(initial.samples, 6);
    assert.strictEqual(initial.algorithms, 12);
    assert.strictEqual(initial.selectedAlgorithm, 'adaptiveFir');
    assert.deepStrictEqual(initial.original, [356, 239]);
    assert.deepStrictEqual(initial.output, [356, 239]);
    assert.strictEqual(initial.palette, 256, 'expected the complete author-example palette');
    assert(/Changed pixels/.test(initial.stats));
    assert(/Output \|Δ\| vs author/.test(initial.stats));

    const timings = {};
    for (const algorithm of ['original', 'paletteMix', 'orderedCell', 'bilateral', 'anisotropic',
      'kornelski', 'sgenpt', 'waMdapt', 'waJinc2']) {
      await page.select('#algorithm', algorithm);
      await page.waitForFunction(name => {
        const status = document.querySelector('#status').textContent;
        const label = document.querySelector(`#algorithm option[value="${name}"]`).textContent;
        return status.startsWith(label) && status.includes('completed');
      }, { timeout: 30000 }, algorithm);
      timings[algorithm] = await page.$eval('#status', element => element.textContent);
    }

    await page.select('#sample', 'diablo');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('completed') &&
      document.querySelector('#sample').value === 'diablo', { timeout: 30000 });
    await page.select('#algorithm', 'paletteMix');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Palette-pair mixer') &&
      document.querySelector('#status').textContent.includes('completed'), { timeout: 30000 });
    await page.select('#sample', 'kornelski-bears');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('completed') &&
      document.querySelector('#sample').value === 'kornelski-bears', { timeout: 30000 });
    await page.select('#algorithm', 'kornelski');
    await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Kornelski undither') &&
      document.querySelector('#status').textContent.includes('completed'), { timeout: 30000 });
    await page.screenshot({ path: screenshot, fullPage: true });

    assert.deepStrictEqual(errors, [], errors.join('\n'));
    console.log(JSON.stringify({ initial, timings, screenshot }, null, 2));
    console.log('PASS  standalone browser UI, corpus, selectors, algorithms, canvases, palette, stats, and screenshot');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
