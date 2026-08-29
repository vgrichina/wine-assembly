#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

class FakeParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
}

class FakeNode {
  constructor() { this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.connections.length = 0; }
}

class FakePanner extends FakeNode {
  constructor() {
    super();
    this.positionX = new FakeParam();
    this.positionY = new FakeParam();
    this.positionZ = new FakeParam();
    this.orientationX = new FakeParam();
    this.orientationY = new FakeParam();
    this.orientationZ = new FakeParam();
    this.refDistance = 1;
    this.maxDistance = 10000;
    this.rolloffFactor = 1;
    this.coneInnerAngle = 360;
    this.coneOuterAngle = 360;
    this.coneOuterGain = 0;
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = new FakeNode();
    this.state = 'running';
    this.panners = [];
    this.listener = {
      positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam(),
      forwardX: new FakeParam(), forwardY: new FakeParam(), forwardZ: new FakeParam(-1),
      upX: new FakeParam(), upY: new FakeParam(1), upZ: new FakeParam(),
    };
  }
  createGain() { const node = new FakeNode(); node.gain = new FakeParam(1); return node; }
  createStereoPanner() { const node = new FakeNode(); node.pan = new FakeParam(0); return node; }
  createPanner() { const node = new FakePanner(); this.panners.push(node); return node; }
  createAnalyser() { throw new Error('analyser not needed'); }
  resume() {}
}

const floatBits = (value) => {
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = value;
  return new Int32Array(buffer)[0];
};
const bitsFloat = (value) => {
  const buffer = new ArrayBuffer(4);
  new Int32Array(buffer)[0] = value;
  return new Float32Array(buffer)[0];
};

const oldAudioContext = globalThis.AudioContext;
globalThis.AudioContext = FakeAudioContext;

try {
  const ctx = { getMemory: () => new ArrayBuffer(64 * 1024) };
  const { host } = createHostImports(ctx);
  const voice = host.voice_open(22050, 1, 16);
  const state = ctx._voices._map[voice];

  host.voice_3d_set(voice, 15, 0, 0, 0);
  assert(state.spatialPanner, 'acquiring the 3D interface should create a Web Audio PannerNode');
  assert.strictEqual(state.spatialPanner.panningModel, 'HRTF');
  assert.strictEqual(state.spatialPanner.distanceModel, 'inverse');
  assert.deepStrictEqual(state.gain.connections, [state.spatialPanner],
    'the DirectSound voice should route through the 3D panner');

  host.voice_3d_set(voice, 0, floatBits(4), floatBits(-2), floatBits(8));
  assert.strictEqual(state.spatialPanner.positionX.value, 4);
  assert.strictEqual(state.spatialPanner.positionY.value, -2);
  assert.strictEqual(state.spatialPanner.positionZ.value, -8,
    'DirectSound +Z should be mirrored to Web Audio -Z');
  assert.strictEqual(bitsFloat(host.voice_3d_get(voice, 0)), 4);
  assert.strictEqual(bitsFloat(host.voice_3d_get(voice, 2)), 8,
    'guest-visible state should retain DirectSound coordinates');

  host.voice_3d_set(voice, 12, floatBits(3.5), 0, 0);
  host.voice_3d_set(voice, 13, floatBits(80), 0, 0);
  assert.strictEqual(state.spatialPanner.refDistance, 3.5);
  assert.strictEqual(state.spatialPanner.maxDistance, 80);
  assert.strictEqual(bitsFloat(host.voice_3d_get(voice, 12)), 3.5);
  assert.strictEqual(bitsFloat(host.voice_3d_get(voice, 13)), 80);

  host.voice_3d_set(voice, 14, 2, 0, 0); // DS3DMODE_DISABLE
  assert.deepStrictEqual(state.gain.connections, [state.pan],
    'DS3DMODE_DISABLE should bypass HRTF and restore the ordinary stereo path');
  host.voice_3d_set(voice, 14, 0, 0, 0);
  assert.deepStrictEqual(state.gain.connections, [state.spatialPanner]);

  host.voice_3d_set(0, 0, floatBits(2), floatBits(3), floatBits(4));
  host.voice_3d_set(0, 6, floatBits(0), floatBits(0), floatBits(1));
  host.voice_3d_set(0, 9, floatBits(0), floatBits(1), floatBits(0));
  host.voice_3d_set(0, 12, floatBits(0.5), 0, 0);
  host.voice_3d_set(0, 13, floatBits(1.75), 0, 0);
  assert.strictEqual(ctx._voices._ac.listener.positionX.value, 1,
    'DirectSound listener positions should use the configured distance factor');
  assert.strictEqual(ctx._voices._ac.listener.positionZ.value, -2,
    'listener Z should mirror from DirectSound to Web Audio coordinates');
  assert.strictEqual(state.spatialPanner.positionX.value, 2,
    'distance factor should also rescale existing source positions');
  assert.strictEqual(state.spatialPanner.rolloffFactor, 1.75);
  assert.strictEqual(bitsFloat(host.voice_3d_get(0, 12)), 0.5,
    'listener state should round-trip through the existing 3D voice bridge');

  const root = path.join(__dirname, '..');
  const apis = JSON.parse(fs.readFileSync(path.join(root, 'src', 'api_table.json'), 'utf8'));
  const methods = apis.filter(api => api.name.startsWith('IDirectSound3DBuffer_'));
  assert.strictEqual(methods.length, 21, 'IDirectSound3DBuffer must expose its complete 21-slot vtable');
  assert.deepStrictEqual(methods.map(api => api.id), Array.from({ length: 21 }, (_, i) => 2612 + i),
    'the 3D vtable must remain one contiguous append-only API block');

  const wat = fs.readFileSync(path.join(root, 'src', '09a8-handlers-directx.wat'), 'utf8');
  assert(/IID_IDirectSound3DBuffer = \{279AFA86-4981-11CE-A521-0020AF0BE560\}/.test(wat));
  assert(/\$handle_IDirectSoundBuffer_QueryInterface[\s\S]*?\$DX_VTBL_DS3DBUF/.test(wat),
    'IDirectSoundBuffer::QueryInterface should return the 3D auxiliary wrapper');
  assert(/\$handle_IDirectSound3DBuffer_SetPosition[\s\S]*?\$host_voice_3d_set[\s\S]*?\(i32\.const 24\)/.test(wat),
    'SetPosition should forward all coordinates and pop its five-argument COM frame');
  const registryCount = wat.match(/\$DX_VTBL_REGISTRY_COUNT i32 \(i32\.const (\d+)\)/);
  assert(registryCount && Number(registryCount[1]) > 55,
    'the registry must include the DirectSound3DBuffer vtable at slot 55');
  assert(/\$DX_VTBL_DS3DBUF \(i32\.load offset=220/.test(wat),
    'worker instances should restore the appended 3D vtable');

  console.log('PASS  DirectSound3D maps to Web Audio HRTF positioning and distance');
} finally {
  globalThis.AudioContext = oldAudioContext;
}
