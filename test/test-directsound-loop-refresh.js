#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

class FakeParam {
  constructor(value = 0) { this.value = value; }
}

class FakeNode {
  connect(node) { return node; }
  disconnect() {}
}

class FakeBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.data[channel]; }
}

class FakeSource extends FakeNode {
  constructor(owner) {
    super();
    this.owner = owner;
    this.playbackRate = new FakeParam(1);
    this.loop = false;
    this.starts = [];
    this.stops = [];
  }
  start(time) { this.starts.push(time); this.owner.started.push(this); }
  stop(time) { this.stops.push(time); if (this.onended) this.onended(); }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 3;
    this.destination = new FakeNode();
    this.state = 'running';
    this.started = [];
  }
  createGain() { const n = new FakeNode(); n.gain = new FakeParam(1); return n; }
  createStereoPanner() { const n = new FakeNode(); n.pan = new FakeParam(0); return n; }
  createAnalyser() { throw new Error('analyser not needed'); }
  createBufferSource() { return new FakeSource(this); }
  createBuffer(channels, length, rate) { return new FakeBuffer(channels, length, rate); }
  resume() {}
}

const oldAudioContext = globalThis.AudioContext;
globalThis.AudioContext = FakeAudioContext;

try {
  const memory = new ArrayBuffer(64 * 1024);
  const pcm = new Uint8Array(memory);
  const ptr = 0x1000;
  pcm.set([0, 64, 128, 255], ptr);

  const ctx = { getMemory: () => memory };
  const { host } = createHostImports(ctx);
  const voice = host.voice_open(22050, 1, 8);
  host.voice_play_ring(voice, ptr, 4, 0, 1);

  const ac = ctx._voices._ac;
  const source = ac.started[0];
  assert(source && source.loop, 'DSBPLAY_LOOPING should start one looping source');
  assert.deepStrictEqual(
    Array.from(source.buffer.getChannelData(0)),
    [-1, -0.5, 0, 127 / 128],
    'initial Play should snapshot the canonical DirectSound PCM');

  pcm.set([128, 255, 0, 64], ptr);
  host.voice_play_ring(voice, ptr, 4, 0, 2);

  assert.strictEqual(ac.started.length, 1,
    'Unlock refresh must not create or restart a WebAudio source');
  assert.strictEqual(ctx._voices._map[voice].currentSrc, source,
    'Unlock refresh must preserve the live ring play cursor');
  assert.deepStrictEqual(
    Array.from(source.buffer.getChannelData(0)),
    [0, 127 / 128, -1, -0.5],
    'Unlock refresh must replace the samples heard by the looping source');

  host.voice_stop(voice);
  assert.strictEqual(ctx._voices._map[voice].currentSrc, null,
    'DirectSound Stop should still terminate the refreshed ring source');

  const directSoundWat = fs.readFileSync(
    path.join(__dirname, '..', 'src', '09a8-handlers-directx.wat'), 'utf8');
  assert(/\$handle_IDirectSoundBuffer_Unlock[\s\S]*?\$host_voice_play_ring[\s\S]*?\(i32\.const 2\)/.test(directSoundWat),
    'IDirectSoundBuffer::Unlock must request an in-place host ring refresh');

  console.log('PASS  looping DirectSound buffers refresh in place after Unlock');
} finally {
  globalThis.AudioContext = oldAudioContext;
}
