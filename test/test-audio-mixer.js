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

class FakeAnalyser extends FakeNode {
  constructor() {
    super();
    this.fftSize = 256;
  }
  getFloatTimeDomainData(samples) { samples.fill(0); }
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
  createAnalyser() { return new FakeAnalyser(); }
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
  assert.strictEqual(ac._wineWaveBus.connections[0], ac._wineWaveAnalyser,
    'wave bus should feed its analyser');
  assert.strictEqual(ac._wineWaveAnalyser.connections[0], ac._wineMaster,
    'wave analyser should feed master');
  assert(Math.abs(ac._wineWaveBus.gain.value - 0x4000 / 0xFFFF) < 1e-6);
  assert.strictEqual(ac._wineMaster.gain.value, 1, 'wave volume must not change master');

  const midiHandle = h.midi_out_open(0, 0, 0, 0);
  assert(midiHandle);
  assert.strictEqual(h.midi_out_short_msg(midiHandle, 0x00643C90), 0);
  assert(ac._wineMidiBus, 'MIDI note should create the MIDI bus');
  assert.strictEqual(ac._wineMidiBus.connections[0], ac._wineMidiAnalyser,
    'MIDI bus should feed its analyser');
  assert.strictEqual(ac._wineMidiAnalyser.connections[0], ac._wineMaster,
    'MIDI analyser should feed master');
  assert(Math.abs(ac._wineMidiBus.gain.value - 0x8000 / 0xFFFF) < 1e-6);

  const pcm = new Int16Array(memory, 0x1000, 4);
  pcm.set([0, 32767, -32768, 0]);
  h.wave_out_write(waveHandle, 0x1000, pcm.byteLength);
  const wavePeak = h.audio_mixer_get_peak(1);
  const masterBefore = h.audio_mixer_get_peak(0);
  assert(wavePeak > 8000 && wavePeak < 8300, 'Wave peak should include the Wave bus gain');

  const midiPeak = h.audio_mixer_get_peak(2);
  assert(midiPeak > 12500 && midiPeak < 13200, 'MIDI peak should reflect note velocity and MIDI gain');
  assert(masterBefore >= midiPeak - 1 && masterBefore <= midiPeak + 1,
    'master peak should follow the loudest active bus');

  h.audio_mixer_set_volume(0, 0xC000C000);
  assert(Math.abs(ac._wineMaster.gain.value - 0xC000 / 0xFFFF) < 1e-6);
  assert(Math.abs(ac._wineWaveBus.gain.value - 0x4000 / 0xFFFF) < 1e-6);
  assert(Math.abs(ac._wineMidiBus.gain.value - 0x8000 / 0xFFFF) < 1e-6);
  const attenuatedMasterPeak = h.audio_mixer_get_peak(0);
  assert(attenuatedMasterPeak > 9400 && attenuatedMasterPeak < 10000,
    'master peak should include the master gain');

  h.audio_mixer_set_mute(1, 1);
  assert.strictEqual(ac._wineWaveBus.gain.value, 0, 'wave mute should silence only wave');
  assert.notStrictEqual(ac._wineMidiBus.gain.value, 0, 'wave mute should not silence MIDI');
  assert.strictEqual(h.audio_mixer_get_volume(1) >>> 0, 0x40004000, 'mute should preserve volume');
  assert.strictEqual(h.audio_mixer_get_peak(1), 0, 'wave mute should suppress its peak meter');
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
  console.log('PASS  PCM and MIDI activity drive gain-aware peak meters');
} finally {
  globalThis.AudioContext = oldAudioContext;
}
