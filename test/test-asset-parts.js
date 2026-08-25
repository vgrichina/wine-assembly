#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const {
  ASSET_PART_SIZE,
  SERVER_MAX_FILE_SIZE,
  encodeBinaryBytes,
} = require('../tools/deploy-berrry');

assert.strictEqual(SERVER_MAX_FILE_SIZE, 20 * 1024 * 1024);
assert.strictEqual(ASSET_PART_SIZE, 10 * 1024 * 1024);

function decoded(files) {
  return Buffer.concat(files.map(file => Buffer.from(file.content, 'base64')));
}

const boundary = Buffer.alloc(SERVER_MAX_FILE_SIZE, 0x5a);
const unsplit = encodeBinaryBytes('binaries/boundary.dat', boundary);
assert.deepStrictEqual(unsplit.map(file => file.name), ['binaries/boundary.dat']);
assert.deepStrictEqual(decoded(unsplit), boundary);

const large = Buffer.alloc(SERVER_MAX_FILE_SIZE + ASSET_PART_SIZE + 17);
for (let i = 0; i < large.length; i++) large[i] = i & 0xff;
const split = encodeBinaryBytes('binaries/large.dat', large);
assert.deepStrictEqual(split.map(file => file.name), [
  'binaries/large.dat.part000',
  'binaries/large.dat.part001',
  'binaries/large.dat.part002',
  'binaries/large.dat.part003',
]);
assert(split.every(file => Buffer.from(file.content, 'base64').length <= ASSET_PART_SIZE));
assert.deepStrictEqual(decoded(split), large);

const exactParts = encodeBinaryBytes(
  'binaries/exact.dat', Buffer.alloc(ASSET_PART_SIZE * 3, 0x33));
assert.strictEqual(Buffer.from(exactParts.at(-1).content, 'base64').length, 0,
  'an exact multiple needs an empty terminal part');

const hostSource = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
const calls = [];
let routes = new Map();
const response = (status, bytes = []) => ({
  status,
  ok: status >= 200 && status < 300,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});
const context = {
  console,
  URLSearchParams,
  Uint8Array,
  fetch: async url => {
    calls.push(String(url));
    return routes.get(String(url)) || response(404);
  },
};
vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);
context.WineAssembly.ASSET_PART_SIZE = 2;

async function run() {
  routes = new Map([['plain.bin', response(200, [1, 2, 3])]]);
  calls.length = 0;
  assert.deepStrictEqual(Array.from(await context.WineAssembly.fetchAssetBytes('plain.bin')), [1, 2, 3]);
  assert.deepStrictEqual(calls, ['plain.bin']);

  routes = new Map([
    ['large.bin?v=7', response(404)],
    ['large.bin.part000?v=7', response(200, [4, 5])],
    ['large.bin.part001?v=7', response(200, [6])],
  ]);
  calls.length = 0;
  assert.deepStrictEqual(
    Array.from(await context.WineAssembly.fetchAssetBytes('large.bin?v=7')),
    [4, 5, 6]);
  assert.deepStrictEqual(calls, [
    'large.bin?v=7',
    'large.bin.part000?v=7',
    'large.bin.part001?v=7',
  ]);

  routes = new Map([['broken.bin', response(500)]]);
  calls.length = 0;
  await assert.rejects(
    context.WineAssembly.fetchAssetBytes('broken.bin'),
    /broken\.bin: HTTP 500/);
  assert.deepStrictEqual(calls, ['broken.bin'], 'non-404 failures must not try parts');

  routes = new Map([
    ['missing.bin', response(404)],
    ['missing.bin.part000', response(404)],
  ]);
  await assert.rejects(
    context.WineAssembly.fetchAssetBytes('missing.bin'),
    /missing\.bin: HTTP 404/);

  routes = new Map([
    ['truncated.bin', response(404)],
    ['truncated.bin.part000', response(200, [7, 8])],
    ['truncated.bin.part001', response(404)],
  ]);
  await assert.rejects(
    context.WineAssembly.fetchAssetBytes('truncated.bin'),
    /missing truncated\.bin\.part001/);

  // berrry cannot serve a name containing a space, so the deployer publishes
  // those as name_with_underscores. A dev server that serves the real name
  // must never take that path.
  routes = new Map([['Big Twister.TD4', response(200, [1, 2])]]);
  calls.length = 0;
  assert.deepStrictEqual(
    Array.from(await context.WineAssembly.fetchAssetBytes('Big Twister.TD4')),
    [1, 2]);
  assert.deepStrictEqual(calls, ['Big Twister.TD4'],
    'a served spaced name must not fall back');

  routes = new Map([
    ['Big Twister.TD4', response(404)],
    ['Big Twister.TD4.part000', response(404)],
    ['Big_Twister.TD4', response(200, [3, 4])],
  ]);
  calls.length = 0;
  assert.deepStrictEqual(
    Array.from(await context.WineAssembly.fetchAssetBytes('Big Twister.TD4')),
    [3, 4]);
  assert.deepStrictEqual(calls, [
    'Big Twister.TD4',
    'Big Twister.TD4.part000',
    'Big_Twister.TD4',
  ]);

  // The URL the page builds is percent-encoded, and the query string survives.
  routes = new Map([
    ['Saved%20Games/001?v=9', response(404)],
    ['Saved%20Games/001.part000?v=9', response(404)],
    ['Saved_Games/001?v=9', response(200, [5])],
  ]);
  assert.deepStrictEqual(
    Array.from(await context.WineAssembly.fetchAssetBytes('Saved%20Games/001?v=9')),
    [5]);

  console.log('asset part tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
