#!/usr/bin/env node

// What GetCurrentPosition reports is not cosmetic: a DirectSound streamer
// steers its writes with it. RollerCoaster Tycoon's music pump (0x40bb20)
// polls the play cursor, takes the delta since its last poll, and rewrites
// exactly that many bytes at its own write pointer -- i.e. it refills the span
// the cursor just crossed. Two things have to be true for that to sound right:
//
//   1. the play cursor must not run ahead of the speakers. Our snapshot cursor
//      comes from elapsed time, but a WebAudio source is not audible until the
//      render quantum and the device buffer have gone by, so an uncorrected
//      cursor makes the guest overwrite audio still in flight -- a seam on
//      every refill, which is what "the menu music glitches now and then"
//      sounded like.
//   2. the write cursor must lead the play cursor. DirectSound defines the
//      bytes between them as the region already handed to the hardware and
//      unsafe to touch; we used to report one value for both, which told an
//      app that region was free.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

class FakeNode {
  connect(node) { return node; }
  disconnect() {}
}

class FakeParam {
  constructor(value = 0) { this.value = value; }
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
  }
  start() { this.owner.started.push(this); }
  stop() { if (this.onended) this.onended(); }
}

// The latency a browser reports is a property of the output device, so it is
// fixed per context; each case installs a context class carrying its own.
function audioContextClass(baseLatency, outputLatency) {
  return class FakeAudioContext {
    constructor() {
      this.currentTime = 3;
      this.destination = new FakeNode();
      this.state = 'running';
      this.started = [];
      this.baseLatency = baseLatency;
      this.outputLatency = outputLatency;
    }
    createGain() { const n = new FakeNode(); n.gain = new FakeParam(1); return n; }
    createStereoPanner() { const n = new FakeNode(); n.pan = new FakeParam(0); return n; }
    createBufferSource() { return new FakeSource(this); }
    createBuffer(channels, length, rate) { return new FakeBuffer(channels, length, rate); }
    resume() {}
  };
}

// One second of 22050Hz mono 8-bit, looping, so a byte is a byte of elapsed
// audio and the arithmetic below stays readable.
const RATE = 22050;
const RING = RATE;

// A looping ring voice, plus the clock that drives its cursor.
function ringVoice(baseLatency, outputLatency) {
  const memory = new ArrayBuffer(128 * 1024);
  const ctx = { getMemory: () => memory };
  const { host } = createHostImports(ctx);
  const id = host.voice_open(RATE, 1, 8);
  host.voice_play_ring(id, 0x1000, RING, 0, 1);
  return { host, id, ac: ctx._voices._ac };
}

const oldAudioContext = globalThis.AudioContext;
try {
  // 1. With a device that is 100ms behind, the reported cursor is 100ms behind
  //    too -- the guest may rewrite what has been heard, not what is queued.
  globalThis.AudioContext = audioContextClass(0.02, 0.08);
  {
    const { host, id, ac } = ringVoice();
    assert(ac, 'the voice should have taken an AudioContext');
    ac.currentTime += 0.5;
    assert.strictEqual(host.voice_get_pos(id), Math.floor(0.4 * RATE),
      'the play cursor must trail elapsed time by baseLatency + outputLatency');

    // Never negative: right after Play, less time has passed than the device
    // is behind, and a cursor that wrapped to the end of the ring would send a
    // streamer off to refill the whole buffer.
    ac.currentTime -= 0.45;
    assert.strictEqual(host.voice_get_pos(id), 0,
      'before the first sample is audible the cursor stays at the start');
  }

  // 2. A context that reports no latency (older engines omit outputLatency)
  //    is left exactly as it was -- the correction is a subtraction, not a
  //    guess at some default.
  globalThis.AudioContext = audioContextClass(undefined, undefined);
  {
    const { host, id, ac } = ringVoice();
    ac.currentTime += 0.5;
    assert.strictEqual(host.voice_get_pos(id), Math.floor(0.5 * RATE),
      'an unreported latency must not be invented');
  }
} finally {
  globalThis.AudioContext = oldAudioContext;
}

// 3. The WAT side: the write cursor is a different number from the play
//    cursor, derived from the buffer's own format, and stays inside the ring.
{
  const wat = fs.readFileSync(
    path.join(__dirname, '..', 'src', '09a8-handlers-directx.wat'), 'utf8');
  const fn = wat.split('(func $handle_IDirectSoundBuffer_GetCurrentPosition')[1];
  assert(fn, 'GetCurrentPosition handler not found');
  const body = fn.split('\n  (func ')[0];
  assert(/local\.get \$lead/.test(body),
    'the write cursor must be offset from the play cursor by a lead');
  assert(/i32\.rem_u/.test(body),
    'the write cursor must wrap inside the ring rather than run past its end');
  assert(/i32\.const 15/.test(body),
    'the lead should be the ~15ms a Win98 driver keeps committed');
}

console.log('PASS  DirectSound cursors: play trails the device, write leads play');
