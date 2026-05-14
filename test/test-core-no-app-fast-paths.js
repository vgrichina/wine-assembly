#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const exportsWat = fs.readFileSync(path.join(ROOT, 'src', '13-exports.wat'), 'utf8');
const decoderWat = fs.readFileSync(path.join(ROOT, 'src', '07-decoder.wat'), 'utf8');

assert(!/\$?is_winamp\b|winamp_/i.test(exportsWat),
  'main run loop should not contain Winamp-specific helpers');

for (const eip of [
  '0x0040503d',
  '0x00402c47',
  '0x00406740',
  '0x00403b9b',
  '0x0040418a',
  '0x004040ff',
  '0x00403f50',
  '0x004073f0',
  '0x00407573',
]) {
  assert(!exportsWat.includes(eip), `main run loop should not trap Winamp guest EIP ${eip}`);
}

for (const marker of ['0xDEC0DE19', '0xDEC0B10C', '0x01009604', '0x010095f0', '0x01009620']) {
  assert(!exportsWat.includes(marker), `exports should not contain stale app debug marker ${marker}`);
  assert(!decoderWat.includes(marker), `decoder should not contain stale app debug marker ${marker}`);
}

console.log('PASS  core has no app-specific run-loop fast paths');
