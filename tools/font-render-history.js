#!/usr/bin/env node

'use strict';

// Replays wine-assembly's handwritten TrueType renderer against a serial
// GGO_BITMAP capture made by the local Windows 98 oracle. The proprietary font
// and capture stay ignored; only this reproducible comparison driver is kept.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function usage() {
  console.error('usage: node tools/font-render-history.js ' +
    '[--repo=PATH] [--font=ARIAL.TTF] [--oracle=CAPTURE.serial] ' +
    '[--ppem=10] [--commit=REV] [--history=FILE] [--dense-report=FILE]');
  process.exit(2);
}

function parseArgs(argv, scriptRepo = path.join(__dirname, '..')) {
  const options = {
    repo: scriptRepo,
    ppem: 10,
    history: path.join(scriptRepo, '.cache', 'v86-reference',
      'font-render-history.json'),
  };
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) usage();
    const [, name, value] = match;
    if (name === 'repo') options.repo = path.resolve(value);
    else if (name === 'font') options.font = path.resolve(value);
    else if (name === 'oracle') options.oracle = path.resolve(value);
    else if (name === 'history') options.history = path.resolve(value);
    else if (name === 'dense-report') options.denseReport = path.resolve(value);
    else if (name === 'commit' && value) options.commit = value;
    else if (name === 'ppem' && /^\d+$/.test(value)) options.ppem = Number(value);
    else usage();
  }
  options.font ||= path.join(options.repo, '.cache', 'v86-reference',
    'native-fonts', 'arial.ttf');
  options.oracle ||= path.join(options.repo, '.cache', 'v86-reference',
    `arial-${options.ppem}ppem-printable.serial`);
  return options;
}

function parseOracle(text) {
  const glyphs = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^G code=(\d+) format=1 needed=(\d+) metrics=([^ ]+) hex=([0-9A-F]*)$/i
      .exec(line);
    if (!match) continue;
    const code = Number(match[1]);
    const metrics = match[3].split(',').map(Number);
    assert.ok(metrics.length >= 4 && metrics.every(Number.isFinite),
      `invalid metrics for code ${code}`);
    glyphs.set(code, {
      needed: Number(match[2]),
      metrics,
      bitmap: Buffer.from(match[4], 'hex'),
    });
  }
  return glyphs;
}

function referencePixels(reference) {
  const [width, height, left, top] = reference.metrics;
  const strideBytes = ((width + 31) & ~31) >>> 3;
  const pixels = new Set();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = reference.bitmap[y * strideBytes + (x >>> 3)] || 0;
      if (byte & (0x80 >>> (x & 7))) pixels.add(`${left + x},${top - 1 - y}`);
    }
  }
  return pixels;
}

function comparePixelSets(ours, reference) {
  let intersection = 0;
  for (const point of ours) if (reference.has(point)) intersection += 1;
  const union = ours.size + reference.size - intersection;
  return {
    oursInk: ours.size,
    referenceInk: reference.size,
    intersection,
    union,
    inkIoU: union ? intersection / union : 1,
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_error) {
    return null;
  }
}

function runtimeHash(repo) {
  const hash = crypto.createHash('sha256');
  for (const filename of ['src/10c-truetype.wat', 'src/10c1-truetype-hint.wat']) {
    hash.update(filename).update('\0');
    hash.update(fs.readFileSync(path.join(repo, filename))).update('\0');
  }
  return hash.digest('hex');
}

function readHistory(filename) {
  if (!fs.existsSync(filename)) return { schemaVersion: 1, runs: [] };
  const history = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.strictEqual(history.schemaVersion, 1, 'unsupported history schema');
  assert.ok(Array.isArray(history.runs), 'history runs must be an array');
  return history;
}

function writeHistory(filename, result) {
  const history = readHistory(filename);
  const key = `${result.commit}:${result.runtimeSha256}:${result.ppem}`;
  const index = history.runs.findIndex(run =>
    `${run.commit}:${run.runtimeSha256}:${run.ppem}` === key);
  if (index < 0) history.runs.push(result);
  else history.runs[index] = result;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(history, null, 2)}\n`);
}

async function benchmark(options) {
  assert.ok(options.ppem > 0 && options.ppem <= 4096, 'ppem out of range');
  assert.ok(fs.existsSync(options.font), `font not found: ${options.font}`);
  assert.ok(fs.existsSync(options.oracle), `oracle not found: ${options.oracle}`);
  const expected = parseOracle(fs.readFileSync(options.oracle, 'utf8'));
  const codes = Array.from({ length: 94 }, (_unused, index) => index + 33);
  for (const code of codes) assert.ok(expected.has(code),
    `oracle is missing printable code ${code}`);

  const { bootRenderHarness } = require(path.join(options.repo,
    'test', 'render-helper'));
  const { exports: wat, memory } = await bootRenderHarness();
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const fontBytes = fs.readFileSync(options.font);
  const fontGuest = wat.guest_alloc(fontBytes.length) >>> 0;
  const font = wa(fontGuest);
  new Uint8Array(memory.buffer).set(fontBytes, font);
  const bitmap = wa(wat.guest_alloc(4096) >>> 0);
  const scratch = wa(wat.guest_alloc(65536) >>> 0);
  const glyphs = [];
  const totals = { oursInk: 0, referenceInk: 0, intersection: 0, union: 0 };

  for (const code of codes) {
    const reference = expected.get(code);
    const gid = wat.test_tt_glyph_index(font, fontBytes.length, code) >>> 0;
    const metrics = [
      wat.test_tt_glyph_box_width(font, fontBytes.length, gid, options.ppem),
      wat.test_tt_glyph_box_height(font, fontBytes.length, gid, options.ppem),
      wat.test_tt_glyph_box_left(font, fontBytes.length, gid, options.ppem),
      wat.test_tt_glyph_box_top(font, fontBytes.length, gid, options.ppem),
    ];
    const [width, height, left, top] = metrics;
    new Uint8Array(memory.buffer).fill(0, bitmap, bitmap + 4096);
    if (width && height) {
      const scratchBytes = wat.test_tt_raster_scratch_bytes(width) >>> 0;
      assert.ok(scratchBytes <= 65536, `scratch overflow for code ${code}`);
      assert.strictEqual(wat.test_tt_rasterize_glyph(
        font, fontBytes.length, gid, options.ppem, bitmap, width, height,
        left * 64, top * 64, scratch, scratchBytes), 1,
      `rasterization failed for code ${code}`);
    }
    const ours = new Set();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (wat.test_tt_bitmap_pixel(bitmap, height, x, y))
          ours.add(`${left + x},${top - 1 - y}`);
      }
    }
    const native = referencePixels(reference);
    const pixels = comparePixelSets(ours, native);
    const metricExact = metrics.every((value, index) =>
      value === reference.metrics[index]);
    const bitmapExact = metricExact && pixels.oursInk === pixels.intersection &&
      pixels.referenceInk === pixels.intersection;
    for (const key of Object.keys(totals)) totals[key] += pixels[key];
    glyphs.push({
      code,
      character: String.fromCharCode(code),
      gid,
      metricExact,
      bitmapExact,
      metrics,
      referenceMetrics: reference.metrics.slice(0, 4),
      ...pixels,
    });
  }

  const commit = options.commit ||
    git(options.repo, ['rev-parse', '--short=12', 'HEAD']) || 'unknown';
  const result = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    commit,
    ppem: options.ppem,
    runtimeSha256: runtimeHash(options.repo),
    fontSha256: sha256(fontBytes),
    oracleSha256: sha256(fs.readFileSync(options.oracle)),
    fontRuntimeDirty: Boolean(git(options.repo, ['status', '--porcelain', '--',
      'src/10c-truetype.wat', 'src/10c1-truetype-hint.wat'])),
    exactGlyphs: glyphs.filter(glyph => glyph.metricExact && glyph.bitmapExact).length,
    totalGlyphs: glyphs.length,
    metricExactGlyphs: glyphs.filter(glyph => glyph.metricExact).length,
    bitmapExactGlyphs: glyphs.filter(glyph => glyph.bitmapExact).length,
    inkIoU: totals.union ? totals.intersection / totals.union : 1,
    totals,
    mismatches: glyphs.filter(glyph => !glyph.metricExact || !glyph.bitmapExact),
  };
  if (options.denseReport) {
    const dense = JSON.parse(fs.readFileSync(options.denseReport, 'utf8'));
    result.dense = {
      source: options.denseReport,
      inkIoU: dense.totals?.iou ?? dense.sampleInkIoU ?? null,
    };
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await benchmark(options);
  writeHistory(options.history, result);
  console.log(`${result.commit} Arial ${result.ppem}ppem: ` +
    `${result.exactGlyphs}/${result.totalGlyphs} exact, ` +
    `ink IoU ${(result.inkIoU * 100).toFixed(3)}%`);
  console.log(`mismatches: ${result.mismatches.map(entry => entry.character).join(' ') || 'none'}`);
  console.log(`history: ${options.history}`);
}

module.exports = {
  comparePixelSets,
  parseArgs,
  parseOracle,
  readHistory,
  referencePixels,
  runtimeHash,
  writeHistory,
};

if (require.main === module) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
