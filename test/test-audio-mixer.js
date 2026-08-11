#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

class FakeAudioParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeNode {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeOscillator extends FakeNode {
  constructor() {
    super();
    this.frequency = new FakeAudioParam(440);
    this.detune = new FakeAudioParam(0);
  }
  start() {}
  stop() {}
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeNode();
  }
  createGain() {
    const node = new FakeNode();
    node.gain = new FakeAudioParam(1);
    return node;
  }
  createStereoPanner() {
    const node = new FakeNode();
    node.pan = new FakeAudioParam(0);
    return node;
  }
  createOscillator() { return new FakeOscillator(); }
  resume() {}
}

const oldAudioContext = globalThis.AudioContext;
globalThis.AudioContext = FakeAudioContext;

try {
  const memory = new ArrayBuffer(256 * 1024);
  const sharedAudio = {};
  const ctx = { getMemory: () => memory, sharedAudio, midiBackend: 'oscillator' };
  const h = createHostImports(ctx).host;

  h.audio_mixer_set_volume(1, 0x40004000);
  h.audio_mixer_set_volume(2, 0x80008000);
  const waveHandle = h.wave_out_open(22050, 2, 16, 0);
  const ac = ctx._voices._ac;

  assert(ac._wineMaster, 'master bus should exist');
  assert(ac._wineWaveBus, 'opening waveOut should create the wave bus');
  assert.strictEqual(ac._wineWaveBus.connections[0], ac._wineMaster, 'wave bus should feed master');
  assert(Math.abs(ac._wineWaveBus.gain.value - 0x4000 / 0xFFFF) < 1e-6);
  assert.strictEqual(ac._wineMaster.gain.value, 1, 'wave volume must not change master');

  const midiHandle = h.midi_out_open(0, 0, 0, 0);
  assert(midiHandle);
  assert.strictEqual(h.midi_out_short_msg(midiHandle, 0x00643C90), 0);
  assert(ac._wineMidiBus, 'MIDI note should create the MIDI bus');
  assert.strictEqual(ac._wineMidiBus.connections[0], ac._wineMaster, 'MIDI bus should feed master');
  assert(Math.abs(ac._wineMidiBus.gain.value - 0x8000 / 0xFFFF) < 1e-6);

  h.audio_mixer_set_volume(0, 0xC000C000);
  assert(Math.abs(ac._wineMaster.gain.value - 0xC000 / 0xFFFF) < 1e-6);
  assert(Math.abs(ac._wineWaveBus.gain.value - 0x4000 / 0xFFFF) < 1e-6);
  assert(Math.abs(ac._wineMidiBus.gain.value - 0x8000 / 0xFFFF) < 1e-6);

  h.audio_mixer_set_mute(1, 1);
  assert.strictEqual(ac._wineWaveBus.gain.value, 0, 'wave mute should silence only wave');
  assert.notStrictEqual(ac._wineMidiBus.gain.value, 0, 'wave mute should not silence MIDI');
  assert.strictEqual(h.audio_mixer_get_volume(1) >>> 0, 0x40004000, 'mute should preserve volume');
  h.audio_mixer_set_mute(1, 0);
  assert(Math.abs(ac._wineWaveBus.gain.value - 0x4000 / 0xFFFF) < 1e-6, 'unmute should restore volume');

  const second = createHostImports({ getMemory: () => memory, sharedAudio }).host;
  assert.strictEqual(second.audio_mixer_get_volume(0) >>> 0, 0xC000C000, 'master state should be shared');
  assert.strictEqual(second.audio_mixer_get_volume(1) >>> 0, 0x40004000, 'wave state should be shared');
  assert.strictEqual(second.audio_mixer_get_volume(2) >>> 0, 0x80008000, 'MIDI state should be shared');

  h.wave_out_close(waveHandle);
  h.midi_out_close(midiHandle);
  console.log('PASS  mixer routes wave and MIDI through independent gain buses');
  console.log('PASS  master volume composes with source volumes');
  console.log('PASS  mute preserves volume and mixer state is shared');
} finally {
  globalThis.AudioContext = oldAudioContext;
}
