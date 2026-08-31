#!/usr/bin/env node
const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const MM_WOM_DONE = 0x03BD;
const WHDR_DONE = 0x01;
const WHDR_PREPARED = 0x02;
const WHDR_INQUEUE = 0x10;

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
  }
}

class FakeNode {
  constructor() {
    this.connections = [];
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
}

class FakeBufferSource extends FakeNode {
  constructor(owner) {
    super();
    this.owner = owner;
    this.playbackRate = new FakeAudioParam(1);
    this.starts = [];
    this.stops = [];
    this.loop = false;
  }
  start(time, offset = 0) {
    this.starts.push(time);
    this.offset = offset;
    this.owner.started.push(this);
  }
  stop(time) {
    this.stops.push(time);
  }
}

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = sampleRate ? length / sampleRate : 0;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) {
    return this.channels[channel];
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 20;
    this.destination = new FakeNode();
    this.state = 'running';
    this.sampleRate = 44100;
    this.started = [];
  }
  createGain() {
    const g = new FakeNode();
    g.gain = new FakeAudioParam(1);
    return g;
  }
  createStereoPanner() {
    const p = new FakeNode();
    p.pan = new FakeAudioParam(0);
    return p;
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createBuffer(channels, length, sampleRate) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  resume() {
    this.state = 'running';
  }
  close() {
    this.state = 'closed';
  }
}

const oldAudioContext = globalThis.AudioContext;
const oldWindow = globalThis.window;
const oldSetTimeout = globalThis.setTimeout;
const oldClearTimeout = globalThis.clearTimeout;
globalThis.AudioContext = FakeAudioContext;

try {
  const mem = new ArrayBuffer(512 * 1024);
  const bytes = new Uint8Array(mem);
  const pcmPtr = 0x1000;
  const rate = 22050;
  const channels = 2;
  const bits = 16;
  const bytesPerSec = rate * channels * (bits / 8);
  const oneSecond = bytesPerSec;
  for (let i = 0; i < oneSecond * 2; i++) bytes[pcmPtr + i] = i & 0xff;

  const ctx = { getMemory: () => mem };
  const imports = createHostImports(ctx);
  const h = imports.host;

  const handle = h.wave_out_open(rate, channels, bits, 0);
  const ac = ctx._voices._ac;

  h.wave_out_write(handle, pcmPtr, oneSecond);
  h.wave_out_write(handle, pcmPtr + oneSecond, oneSecond);

  assert.strictEqual(h.wave_out_get_pos(handle), 0, 'stream position should not jump to submitted bytes');

  ac.currentTime += 0.5;
  assert.strictEqual(h.wave_out_get_pos(handle), bytesPerSec / 2, 'stream position should follow elapsed audio time');

  assert.strictEqual(h.wave_out_pause(handle), 0, 'waveOutPause accepts a live stream');
  const pausedAt = h.wave_out_get_pos(handle);
  assert.strictEqual(pausedAt, bytesPerSec / 2, 'pause captures the current byte cursor');
  assert.strictEqual(ctx._voices._map[handle].sources.size, 0,
    'pause stops every scheduled Web Audio source');
  assert(ac.started.slice(0, 2).every(src => src.stops.length > 0),
    'pause actually stops both queued source nodes');
  ac.currentTime += 2;
  assert.strictEqual(h.wave_out_get_pos(handle), pausedAt,
    'the waveOut byte cursor does not advance while paused');
  assert.strictEqual(h.wave_out_pause(handle), 0, 'pausing twice is harmless');

  assert.strictEqual(h.wave_out_restart(handle), 0, 'waveOutRestart resumes a paused stream');
  const resumed = ac.started.slice(2);
  assert.strictEqual(resumed.length, 2, 'restart schedules the partial and untouched queued buffers');
  assert(Math.abs(resumed[0].offset - 0.5) < 0.000001,
    'restart skips the already-played half of the current buffer');
  assert.strictEqual(resumed[0].starts[0], ac.currentTime,
    'the remaining current buffer resumes immediately');
  assert.strictEqual(resumed[1].starts[0], ac.currentTime + 0.5,
    'the untouched second buffer remains queued after the partial tail');
  ac.currentTime += 0.25;
  assert.strictEqual(h.wave_out_get_pos(handle), bytesPerSec * 0.75,
    'the byte cursor continues from the paused position after restart');

  ac.currentTime += 4;
  assert.strictEqual(h.wave_out_get_pos(handle), oneSecond * 2, 'stream position should clamp to submitted bytes');

  h.voice_stop(handle);
  assert.strictEqual(h.wave_out_get_pos(handle), 0, 'voice_stop should reset stream position');
  assert(ctx._voices._map[handle].sources.size === 0, 'voice_stop should drop queued stream sources');
  assert(ac.started.every(src => src.stops.length > 0), 'voice_stop should stop scheduled stream sources');

  ac.currentTime = 30;
  h.wave_out_write(handle, pcmPtr, oneSecond);
  const restarted = ac.started[ac.started.length - 1];
  assert.strictEqual(restarted.starts[0], 30, 'stream restart should schedule from current audio time');

  h.wave_out_close(handle);
  assert(!ctx._voices._map[handle], 'wave_out_close should release the stream voice');
  assert(restarted.stops.length > 0, 'wave_out_close should stop the restarted stream source');
  assert.strictEqual(h.wave_out_pause(0xBAD), 5,
    'waveOutPause rejects an invalid handle instead of silently succeeding');

  console.log('PASS  waveOut stream position follows the audio clock');
  console.log('PASS  waveOut stop/close cancels queued stream sources');

  globalThis.AudioContext = undefined;
  let clockMs = 0;
  const pacedMem = new ArrayBuffer(512 * 1024);
  const pacedBytes = new Uint8Array(pacedMem);
  for (let i = 0; i < oneSecond; i++) pacedBytes[pcmPtr + i] = i & 0xff;
  const pacedPosted = [];
  const pacedCtx = {
    getMemory: () => pacedMem,
    sharedAudio: { audioClockMs: () => clockMs },
    exports: {
      post_message_q(hwnd, msg, wParam, lParam) {
        pacedPosted.push([hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0]);
        return 1;
      },
    },
  };
  const pacedImports = createHostImports(pacedCtx);
  const pacedHandle = pacedImports.host.wave_out_open(rate, channels, bits, 1);
  const pacedDv = new DataView(pacedMem);
  const pacedHwnd = 0x10002;
  const pacedWaveHdrWA = 0x22000;
  const pacedWaveHdrGA = 0x403000;
  pacedDv.setUint32(0xD164, pacedHwnd, true);
  pacedDv.setUint32(0xD16C, 1, true);
  pacedDv.setUint32(pacedWaveHdrWA + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  pacedImports.host.wave_out_write(pacedHandle, pcmPtr, oneSecond);
  pacedImports.host.wave_out_schedule_done(pacedHandle, pacedWaveHdrWA, pacedWaveHdrGA, oneSecond);
  assert.strictEqual(pacedImports.host.wave_out_get_pos(pacedHandle), 0, 'simulated host position should start at zero');
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 0, 'simulated host should not complete immediately');
  clockMs = 500;
  assert.strictEqual(pacedImports.host.wave_out_get_pos(pacedHandle), bytesPerSec / 2, 'simulated host position should follow host audio clock');
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 0, 'simulated host should wait until buffer duration elapses');
  assert.strictEqual(pacedImports.host.wave_out_pause(pacedHandle), 0);
  clockMs = 1500;
  assert.strictEqual(pacedImports.host.wave_out_get_pos(pacedHandle), bytesPerSec / 2,
    'headless waveOut position also freezes while paused');
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 0,
    'headless WOM_DONE stays pending while paused past its original deadline');
  assert.strictEqual(pacedImports.host.wave_out_restart(pacedHandle), 0);
  clockMs = 2000;
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 1, 'simulated host should complete at buffer duration');
  assert.deepStrictEqual(pacedPosted, [[pacedHwnd, MM_WOM_DONE, pacedHandle, pacedWaveHdrGA]], 'simulated host should post MM_WOM_DONE at due time');
  assert.strictEqual(pacedDv.getUint32(pacedWaveHdrWA + 16, true), WHDR_PREPARED | WHDR_DONE, 'simulated host completion should clear WHDR_INQUEUE');
  pacedImports.host.wave_out_close(pacedHandle);
  console.log('PASS  non-browser waveOut completion follows the simulated audio clock');

  const functionCalls = [];
  pacedCtx.exports.fire_wave_out_callback = (hwo, waveHdr) => {
    functionCalls.push([hwo >>> 0, waveHdr >>> 0]);
    return 1;
  };
  const functionHandle = pacedImports.host.wave_out_open(rate, channels, bits, 3);
  const functionHdrWA = 0x24000;
  const functionHdrGA = 0x405000;
  pacedDv.setUint32(0xD164, 0x651300, true);
  pacedDv.setUint32(0xD168, 0x12345678, true);
  pacedDv.setUint32(0xD16C, 3, true);
  pacedDv.setUint32(functionHdrWA + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  pacedImports.host.wave_out_write(functionHandle, pcmPtr, oneSecond);
  pacedImports.host.wave_out_schedule_done(
    functionHandle, functionHdrWA, functionHdrGA, oneSecond);
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 0,
    'CALLBACK_FUNCTION should wait for the audio clock');
  assert.deepStrictEqual(functionCalls, [],
    'CALLBACK_FUNCTION must not interrupt an in-flight waveOutWrite');
  clockMs = 3000;
  assert.strictEqual(pacedCtx.pumpAudioCompletions(), 1,
    'CALLBACK_FUNCTION should complete at buffer duration');
  assert.deepStrictEqual(functionCalls, [[functionHandle, functionHdrGA]],
    'CALLBACK_FUNCTION WOM_DONE should enter the guest callback at a slice boundary');
  assert.strictEqual(pacedDv.getUint32(functionHdrWA + 16, true),
    WHDR_PREPARED | WHDR_DONE,
    'CALLBACK_FUNCTION completion should clear WHDR_INQUEUE');
  pacedImports.host.wave_out_close(functionHandle);
  console.log('PASS  waveOut CALLBACK_FUNCTION dispatches WOM_DONE between guest slices');

  globalThis.AudioContext = FakeAudioContext;
  const browserMem = new ArrayBuffer(512 * 1024);
  const browserBytes = new Uint8Array(browserMem);
  for (let i = 0; i < oneSecond; i++) browserBytes[pcmPtr + i] = i & 0xff;
  const browserCtx = { getMemory: () => browserMem };
  const queuedTimers = [];
  let nextTimer = 1;
  globalThis.window = { addEventListener() {} };
  globalThis.setTimeout = (fn) => {
    const id = nextTimer++;
    queuedTimers.push({ id, fn });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const idx = queuedTimers.findIndex(t => t.id === id);
    if (idx >= 0) queuedTimers.splice(idx, 1);
  };
  const browserImports = createHostImports(browserCtx);
  let signaled = 0;
  browserImports.host.set_event = () => { signaled++; return 1; };
  const browserHandle = browserImports.host.wave_out_open(rate, channels, bits, 5);
  const browserAc = browserCtx._voices._ac;
  const browserDv = new DataView(browserMem);
  browserDv.setUint32(0xD164, 0xE0001, true);
  browserDv.setUint32(0xD16C, 5, true);
  const waveHdrWA = 0x20000;
  const waveHdrGA = 0x401000;
  browserDv.setUint32(waveHdrWA + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  browserImports.host.wave_out_write(browserHandle, pcmPtr, oneSecond);
  browserImports.host.wave_out_schedule_done(browserHandle, waveHdrWA, waveHdrGA, oneSecond);
  assert.strictEqual(signaled, 0, 'browser WOM_DONE should wait for audio clock');
  assert.strictEqual(browserDv.getUint32(waveHdrWA + 16, true), WHDR_PREPARED | WHDR_INQUEUE, 'browser WHDR_DONE should wait for audio clock');
  queuedTimers.shift().fn();
  assert.strictEqual(signaled, 0, 'early timer poll should not signal before currentTime reaches due time');
  browserAc.currentTime += 0.25;
  assert.strictEqual(browserImports.host.wave_out_pause(browserHandle), 0);
  const browserPausedAt = browserImports.host.wave_out_get_pos(browserHandle);
  browserAc.currentTime += 1;
  queuedTimers.shift().fn();
  assert.strictEqual(signaled, 0, 'paused browser stream must not signal WOM_DONE');
  assert.strictEqual(browserImports.host.wave_out_get_pos(browserHandle), browserPausedAt,
    'browser cursor remains frozen while the AudioContext clock advances');
  assert.strictEqual(browserImports.host.wave_out_restart(browserHandle), 0);
  const resumedBrowserSource = browserAc.started[browserAc.started.length - 1];
  assert(Math.abs(resumedBrowserSource.offset - 0.25) < 0.000001,
    'browser restart resumes inside the partially played AudioBuffer');
  browserAc.currentTime += 0.75;
  queuedTimers.shift().fn();
  assert.strictEqual(signaled, 1, 'browser WOM_DONE should signal at buffer end');
  assert.strictEqual(browserDv.getUint32(waveHdrWA + 16, true), WHDR_PREPARED | WHDR_DONE, 'browser completion should set WHDR_DONE and clear WHDR_INQUEUE');
  assert.strictEqual(browserCtx._voices._map[browserHandle].streamChunks.length, 0,
    'completed WAVEHDR releases its retained decoded PCM');
  browserImports.host.wave_out_close(browserHandle);
  console.log('PASS  browser waveOut completion waits for the AudioContext clock');

  const windowMem = new ArrayBuffer(512 * 1024);
  const windowBytes = new Uint8Array(windowMem);
  for (let i = 0; i < oneSecond; i++) windowBytes[pcmPtr + i] = i & 0xff;
  const posted = [];
  const windowCtx = {
    getMemory: () => windowMem,
    exports: {
      post_message_q(hwnd, msg, wParam, lParam) {
        posted.push([hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0]);
        return 1;
      },
    },
  };
  const windowImports = createHostImports(windowCtx);
  const windowHandle = windowImports.host.wave_out_open(rate, channels, bits, 1);
  const windowAc = windowCtx._voices._ac;
  const windowDv = new DataView(windowMem);
  const hwnd = 0x10001;
  const waveHdrWA2 = 0x21000;
  const waveHdrGA2 = 0x402000;
  windowDv.setUint32(0xD164, hwnd, true);
  windowDv.setUint32(0xD16C, 1, true);
  windowDv.setUint32(waveHdrWA2 + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  windowImports.host.wave_out_write(windowHandle, pcmPtr, oneSecond);
  windowImports.host.wave_out_schedule_done(windowHandle, waveHdrWA2, waveHdrGA2, oneSecond);
  assert.deepStrictEqual(posted, [], 'CALLBACK_WINDOW WOM_DONE should wait for audio clock');
  queuedTimers.shift().fn();
  assert.deepStrictEqual(posted, [], 'early CALLBACK_WINDOW timer poll should not post');
  windowAc.currentTime += 1;
  queuedTimers.shift().fn();
  assert.deepStrictEqual(posted, [[hwnd, MM_WOM_DONE, windowHandle, waveHdrGA2]], 'CALLBACK_WINDOW should post MM_WOM_DONE with the guest WAVEHDR address');
  assert.strictEqual(windowDv.getUint32(waveHdrWA2 + 16, true), WHDR_PREPARED | WHDR_DONE, 'CALLBACK_WINDOW completion should clear WHDR_INQUEUE');
  windowImports.host.wave_out_close(windowHandle);
  console.log('PASS  browser waveOut CALLBACK_WINDOW posts MM_WOM_DONE at buffer end');

  const resetMem = new ArrayBuffer(512 * 1024);
  const resetBytes = new Uint8Array(resetMem);
  for (let i = 0; i < oneSecond * 2; i++) resetBytes[pcmPtr + i] = i & 0xff;
  const resetPosted = [];
  const resetCtx = {
    getMemory: () => resetMem,
    exports: {
      post_message_q(hwnd, msg, wParam, lParam) {
        resetPosted.push([hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0]);
        return 1;
      },
    },
  };
  const resetImports = createHostImports(resetCtx);
  const resetHandle = resetImports.host.wave_out_open(rate, channels, bits, 1);
  const resetAc = resetCtx._voices._ac;
  const resetDv = new DataView(resetMem);
  const resetHwnd = 0x10003;
  const resetHdrWA1 = 0x23000;
  const resetHdrWA2 = 0x23100;
  const resetHdrGA1 = 0x403000;
  const resetHdrGA2 = 0x404000;
  resetDv.setUint32(0xD164, resetHwnd, true);
  resetDv.setUint32(0xD16C, 1, true);
  resetDv.setUint32(resetHdrWA1 + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  resetDv.setUint32(resetHdrWA2 + 16, WHDR_PREPARED | WHDR_INQUEUE, true);
  resetImports.host.wave_out_write(resetHandle, pcmPtr, oneSecond);
  resetImports.host.wave_out_schedule_done(resetHandle, resetHdrWA1, resetHdrGA1, oneSecond);
  resetImports.host.wave_out_write(resetHandle, pcmPtr + oneSecond, oneSecond);
  resetImports.host.wave_out_schedule_done(resetHandle, resetHdrWA2, resetHdrGA2, oneSecond);
  assert.strictEqual(resetCtx._voices._map[resetHandle].sources.size, 2, 'reset setup should queue two Web Audio sources');
  assert.strictEqual(resetCtx._voices._map[resetHandle].timers.size, 2, 'reset setup should arm two completion timers');
  resetImports.host.wave_out_reset(resetHandle);
  assert.deepStrictEqual(resetPosted, [
    [resetHwnd, MM_WOM_DONE, resetHandle, resetHdrGA1],
    [resetHwnd, MM_WOM_DONE, resetHandle, resetHdrGA2],
  ], 'waveOutReset should flush every queued CALLBACK_WINDOW header');
  assert.strictEqual(resetDv.getUint32(resetHdrWA1 + 16, true), WHDR_PREPARED | WHDR_DONE, 'waveOutReset should mark first header done');
  assert.strictEqual(resetDv.getUint32(resetHdrWA2 + 16, true), WHDR_PREPARED | WHDR_DONE, 'waveOutReset should mark second header done');
  assert.strictEqual(resetCtx._voices._map[resetHandle].sources.size, 0, 'waveOutReset should drop queued stream sources');
  assert.strictEqual(resetCtx._voices._map[resetHandle].streamChunks.length, 0,
    'waveOutReset should release decoded PCM for every queued buffer');
  assert.strictEqual(resetCtx._voices._map[resetHandle].timers.size, 0, 'waveOutReset should clear completion timers');
  assert(resetAc.started.slice(-2).every(src => src.stops.length > 0), 'waveOutReset should stop scheduled Web Audio sources');
  assert.strictEqual(resetImports.host.wave_out_get_pos(resetHandle), 0, 'waveOutReset should reset the stream cursor');
  resetImports.host.wave_out_write(resetHandle, pcmPtr, oneSecond);
  assert.strictEqual(resetAc.started[resetAc.started.length - 1].starts[0], resetAc.currentTime, 'waveOutReset should let restarted playback schedule from current time');
  resetImports.host.wave_out_close(resetHandle);
  console.log('PASS  browser waveOutReset cancels queued audio and flushes all callbacks');
} finally {
  if (oldAudioContext === undefined) delete globalThis.AudioContext;
  else globalThis.AudioContext = oldAudioContext;
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
  globalThis.setTimeout = oldSetTimeout;
  globalThis.clearTimeout = oldClearTimeout;
}
