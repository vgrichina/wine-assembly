#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const WHDR_DONE = 0x01;
const WHDR_PREPARED = 0x02;
const WHDR_INQUEUE = 0x10;
const MM_WIM_CLOSE = 0x03BF;
const MM_WIM_DATA = 0x03C0;

const memory = new ArrayBuffer(512 * 1024);
const posted = [];
const ctx = {
  getMemory: () => memory,
  sharedAudio: {},
  exports: {
    post_message_q(hwnd, msg, wParam, lParam) {
      posted.push([hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0]);
      return 1;
    },
  },
};
const { host } = createHostImports(ctx);
const dv = new DataView(memory);
const hwnd = 0x10001;
const handle = host.wave_in_open(8000, 1, 16, hwnd, 0, 1);

function queueHeader(headerWA, headerGA, dataWA, length) {
  dv.setUint32(headerWA, dataWA, true);
  dv.setUint32(headerWA + 4, length, true);
  dv.setUint32(headerWA + 8, 0, true);
  dv.setUint32(headerWA + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  assert.strictEqual(host.wave_in_add_buffer(handle, headerWA, headerGA, dataWA, length), 0);
}

const hdr1 = 0x2000;
const hdr2 = 0x2040;
const hdr3 = 0x2080;
const ga1 = 0x402000;
const ga2 = 0x402040;
const ga3 = 0x402080;
queueHeader(hdr1, ga1, 0x3000, 16);
queueHeader(hdr2, ga2, 0x3040, 16);
assert.strictEqual(host.wave_in_start(handle), 0);

// Source is 16kHz; nearest-neighbor resampling should write eight 8kHz frames
// into the first 16-byte mono buffer and leave four frames in the second.
const source = new Float32Array(24);
for (let i = 0; i < source.length; i++) source[i] = (i - 12) / 12;
assert.strictEqual(host.wave_in_feed_pcm(handle, [source], 16000), 12);
assert.strictEqual(dv.getUint32(hdr1 + 8, true), 16, 'full buffer records its byte count');
assert.strictEqual(dv.getUint32(hdr1 + 16, true), WHDR_PREPARED | WHDR_DONE,
  'full buffer becomes DONE and leaves the input queue');
assert.deepStrictEqual(posted.shift(), [hwnd, MM_WIM_DATA, handle, ga1],
  'full input buffer posts MM_WIM_DATA');
assert.notStrictEqual(dv.getInt16(0x3000, true), 0, 'captured PCM is written into guest memory');
assert.strictEqual(dv.getUint32(hdr2 + 8, true), 0, 'partial buffer is not complete while recording');

assert.strictEqual(host.wave_in_stop(handle), 0);
assert.strictEqual(dv.getUint32(hdr2 + 8, true), 8, 'stop returns the partial buffer byte count');
assert.strictEqual(dv.getUint32(hdr2 + 16, true), WHDR_PREPARED | WHDR_DONE,
  'stop completes the partial buffer');
assert.deepStrictEqual(posted.shift(), [hwnd, MM_WIM_DATA, handle, ga2],
  'stop posts data callback for the partial buffer');

queueHeader(hdr3, ga3, 0x3080, 16);
assert.strictEqual(host.wave_in_reset(handle), 0);
assert.strictEqual(dv.getUint32(hdr3 + 8, true), 0, 'reset returns an empty queued buffer');
assert.strictEqual(dv.getUint32(hdr3 + 16, true), WHDR_PREPARED | WHDR_DONE,
  'reset marks every queued buffer done');
assert.deepStrictEqual(posted.shift(), [hwnd, MM_WIM_DATA, handle, ga3],
  'reset posts the returned buffer callback');

assert.strictEqual(host.wave_in_close(handle), 0);
assert.deepStrictEqual(posted.shift(), [hwnd, MM_WIM_CLOSE, handle, 0],
  'close posts MM_WIM_CLOSE');
assert.strictEqual(posted.length, 0);

console.log('PASS  waveIn converts/resamples PCM into queued guest WAVEHDR buffers');
console.log('PASS  waveIn stop/reset complete partial and queued buffers');
console.log('PASS  waveIn CALLBACK_WINDOW posts MM_WIM_DATA and MM_WIM_CLOSE');

(async () => {
  let reportedError = '';
  const rejectedSharedAudio = {};
  const rejected = createHostImports({
    getMemory: () => memory,
    sharedAudio: rejectedSharedAudio,
    getUserMedia: () => Promise.reject(new Error('permission denied by test')),
    onAudioCaptureError: message => { reportedError = message; },
  }).host;
  const rejectedHandle = rejected.wave_in_open(22050, 1, 16, 0, 0, 0);
  assert.strictEqual(rejected.wave_in_start(rejectedHandle), 0,
    'asynchronous permission request should begin normally');
  await new Promise(resolve => setImmediate(resolve));
  const rejectedDevice = rejectedSharedAudio.waveIn.devices.get(rejectedHandle);
  assert.strictEqual(rejectedDevice.running, false, 'permission rejection should stop the capture device');
  assert.match(reportedError, /permission denied by test/, 'permission rejection should reach the browser error hook');
  rejected.wave_in_close(rejectedHandle);

  const previousWindow = global.window;
  let unavailableError = '';
  try {
    global.window = { addEventListener() {}, removeEventListener() {} };
    const unavailable = createHostImports({
      getMemory: () => memory,
      sharedAudio: {},
      onAudioCaptureError: message => { unavailableError = message; },
    }).host;
    const unavailableHandle = unavailable.wave_in_open(22050, 1, 16, 0, 0, 0);
    assert.strictEqual(unavailable.wave_in_start(unavailableHandle), 8,
      'browser without getUserMedia should reject capture synchronously');
    assert.match(unavailableError, /secure connection/, 'unavailable capture should explain the secure-origin requirement');
    unavailable.wave_in_close(unavailableHandle);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }

  console.log('PASS  browser waveIn reports permission and secure-context failures');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
