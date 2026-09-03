#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mountCue, parseCue, SECTOR_BYTES } = require('../lib/cdrom');
const { createAudioHost } = require('../lib/host-audio');

const cue = `
FILE "data.bin" BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
FILE "music 02.bin" BINARY
  TRACK 02 AUDIO
    INDEX 00 00:00:00
    INDEX 01 00:00:01
FILE "music 03.bin" BINARY
  TRACK 03 AUDIO
    INDEX 01 00:00:00
`;

assert.throws(() => parseCue('TRACK 01 AUDIO\n INDEX 01 00:00:00'), /TRACK before FILE/);
assert.throws(() => parseCue('FILE "../escape.bin" BINARY\n TRACK 01 AUDIO\n INDEX 01 00:00:00'), /unsafe/);
assert.throws(() => parseCue('FILE "x.bin" BINARY\n TRACK 01 AUDIO'), /no INDEX 01/);

const sharedCue = parseCue(`
FILE "whole.bin" BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    INDEX 01 00:00:02
`);
assert.strictEqual(sharedCue.files.length, 1);
assert.strictEqual(sharedCue.tracks[1].fileIndex, 0);
const sharedLoads = [];
const sharedDisc = mountCue({}, `
FILE "whole.bin" BINARY
  TRACK 01 MODE1/2352
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    INDEX 01 00:00:02
`, {
  trackSize: () => SECTOR_BYTES * 77,
  loadTrack: name => { sharedLoads.push(name); return new Uint8Array(SECTOR_BYTES * 77); },
});
assert.strictEqual(sharedDisc.track(1).playableSectors, 2);
assert.strictEqual(sharedDisc.track(2).discStartSector, 2);
assert.strictEqual(sharedDisc.track(2).playableSectors, 75);
assert.deepStrictEqual(sharedLoads, [], 'shared BIN should remain lazy while reading its TOC');

const root = path.join(__dirname, '..');
const browserShellSource = fs.readFileSync(path.join(root, 'lib/browser-shell.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert(browserShellSource.includes('if (app.cdAudio)'));
assert(browserShellSource.includes('loadTrack: name => WineAssembly.fetchAssetBytes'));
assert(/<script src="lib\/cdrom\.js\?v=\d+"><\/script>/.test(indexSource));
assert(/<script src="lib\/browser-shell\.js\?v=\d+"><\/script>/.test(indexSource));
assert(/<script src="lib\/host-audio\.js\?v=\d+"><\/script>/.test(indexSource));

const sizes = {
  'data.bin': SECTOR_BYTES,
  'music 02.bin': SECTOR_BYTES * 76,
  'music 03.bin': SECTOR_BYTES * 75,
};
const raw = new Map();
for (const [name, size] of Object.entries(sizes)) raw.set(name, new Uint8Array(size));
for (const name of ['music 02.bin', 'music 03.bin']) {
  const bytes = raw.get(name);
  const dv = new DataView(bytes.buffer);
  for (let off = 0; off < bytes.length; off += 4) {
    dv.setInt16(off, 16384, true);
    dv.setInt16(off + 2, -16384, true);
  }
}

const vfs = { dirs: new Set(), driveTypes: new Map(), volumeLabels: new Map() };
const loaded = [];
const disc = mountCue(vfs, cue, {
  drive: 'D',
  volumeLabel: 'CIV2',
  trackSize: name => sizes[name],
  loadTrack: name => {
    loaded.push(name);
    return raw.get(name);
  },
});
assert.strictEqual(disc.firstTrack, 1);
assert.strictEqual(disc.lastTrack, 3);
assert.strictEqual(disc.track(2).discStartSector, 2, 'INDEX 01 pregap should precede track start');
assert.strictEqual(disc.track(2).playableSectors, 75);
assert.strictEqual(disc.track(3).discStartSector, 77);
assert.strictEqual(vfs.driveTypes.get('d'), 5);
assert.strictEqual(vfs.volumeLabels.get('d'), 'CIV2');
assert.deepStrictEqual(loaded, [], 'mounting a CUE must not read audio bytes');

class FakeNode {
  constructor() { this.connections = []; this.gain = { value: 1 }; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}

class FakeBufferSource extends FakeNode {
  constructor(ac) { super(); this.ac = ac; this.starts = []; this.stops = []; this.buffer = null; }
  start(...args) { this.starts.push(args); this.ac.started.push(this); }
  stop(...args) { this.stops.push(args); }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 10;
    this.state = 'running';
    this.destination = new FakeNode();
    this.started = [];
  }
  createGain() { return new FakeNode(); }
  createAnalyser() {
    const node = new FakeNode();
    node.fftSize = 256;
    node.getFloatTimeDomainData = out => out.fill(0);
    return node;
  }
  createBuffer(channels, frames, rate) {
    const data = Array.from({ length: channels }, () => new Float32Array(frames));
    return {
      numberOfChannels: channels,
      length: frames,
      sampleRate: rate,
      duration: frames / rate,
      getChannelData: channel => data[channel],
    };
  }
  createBufferSource() { return new FakeBufferSource(this); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

const memory = new ArrayBuffer(0x4000);
const mem = new Uint8Array(memory);
const dv = new DataView(memory);
const writeStr = (ptr, value) => {
  for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i);
  mem[ptr + value.length] = 0;
};
const readStr = ptr => {
  let value = '';
  while (ptr && mem[ptr]) value += String.fromCharCode(mem[ptr++]);
  return value;
};
const posted = [];
const ac = new FakeAudioContext();
const ctx = {
  vfs,
  _audioCtx: ac,
  getMemory: () => memory,
  sharedAudio: {},
  sharedMixer: {},
};
let imports;
const audio = createAudioHost(ctx, {
  readStr,
  readStrW: readStr,
  readVfsFile: () => null,
  readVfsFileAsync: () => Promise.resolve(null),
  profileNow: () => 0,
  profileEvent: () => {},
  getHost: () => imports,
});
imports = {
  ...audio.imports,
  post_window_message: (...args) => { posted.push(args); return 1; },
};

const id = imports.mci_open(516, 0, 0x1000); // MCI_OPEN_TYPE_ID
assert(id, 'numeric MCI_DEVTYPE_CD_AUDIO should open the mounted disc');
const dev = ctx._mci.devices.get(id);
assert.strictEqual(dev.type, 'cdaudio');
assert.strictEqual(imports.mci_get_device_id((writeStr(0x40, 'cdaudio'), 0x40)), id);

const set = 0x100;
dv.setUint32(set + 4, 10, true); // MCI_FORMAT_TMSF
assert.strictEqual(imports.mci_command(id, 0x080D, 0x400, set), 0);
assert.strictEqual(dev.timeFormat, 10);

const status = 0x180;
dv.setUint32(status + 8, 3, true); // MCI_STATUS_NUMBER_OF_TRACKS
assert.strictEqual(imports.mci_command(id, 0x0814, 0x100, status), 0);
assert.strictEqual(dv.getUint32(status + 4, true), 3);
dv.setUint32(status + 8, 0x4001, true); // MCI_CDA_STATUS_TYPE_TRACK
dv.setUint32(status + 12, 1, true);
assert.strictEqual(imports.mci_command(id, 0x0814, 0x110, status), 0);
assert.strictEqual(dv.getUint32(status + 4, true), 0x441, 'track 1 should be data');
dv.setUint32(status + 12, 2, true);
imports.mci_command(id, 0x0814, 0x110, status);
assert.strictEqual(dv.getUint32(status + 4, true), 0x440, 'track 2 should be audio');

const tmsf = (track, minute = 0, second = 0, frame = 0) =>
  track | (minute << 8) | (second << 16) | (frame << 24);
const play = 0x200;
dv.setUint32(play, 0x1234, true);
dv.setUint32(play + 4, tmsf(2), true);
dv.setUint32(play + 8, tmsf(3), true);
assert.strictEqual(imports.mci_command(id, 0x0806, 0x0D, play), 0);
assert.strictEqual(dev.state, 'playing');
assert(ctx.sharedAudio.cdAudioHotUntilMs > 0,
  'active CD-DA publishes an audio-hot lease for the browser idle watcher');
assert.deepStrictEqual(loaded, ['music 02.bin'], 'play should fetch only the requested audio track');

setImmediate(() => {
  assert.strictEqual(ac.started.length, 1);
  const source = ac.started[0];
  assert.strictEqual(source.buffer.numberOfChannels, 2);
  assert.strictEqual(source.buffer.sampleRate, 44100);
  assert.strictEqual(source.buffer.length, 44100);
  assert(Math.abs(source.buffer.getChannelData(0)[0] - 0.5) < 0.0001);
  assert(Math.abs(source.buffer.getChannelData(1)[0] + 0.5) < 0.0001);
  assert(source.connections.includes(ac._wineWaveBus), 'CD-DA should use the Wave mixer bus');

  ac.currentTime = 10.5;
  dv.setUint32(status + 8, 2, true); // MCI_STATUS_POSITION
  imports.mci_command(id, 0x0814, 0x100, status);
  const position = dv.getUint32(status + 4, true);
  assert.strictEqual(position & 0xFF, 2);
  const frame = position >>> 24;
  assert(frame >= 36 && frame <= 38, `half-second TMSF position should be around frame 37, got ${frame}`);

  ac.currentTime = 11.2;
  dv.setUint32(status + 8, 4, true); // MCI_STATUS_MODE
  imports.mci_command(id, 0x0814, 0x100, status);
  assert.strictEqual(dv.getUint32(status + 4, true), 525);
  assert.strictEqual(ctx.sharedAudio.cdAudioHotUntilMs, 0,
    'natural CD completion releases the audio-hot lease');
  assert.deepStrictEqual(posted, [[0x1234, 0x03B9, 1, id]], 'MCI_NOTIFY should post successful completion');

  assert.strictEqual(imports.mci_command(id, 0x0804, 0, 0), 0);
  assert.strictEqual(imports.mci_get_device_id(0x40), 0, 'closing should remove the cdaudio name');

  // Win98 CD Player opens the drive on a short-lived probe thread, then sends
  // status and play commands from its UI thread. MCI handles are process-wide,
  // so both HostImports closures must resolve the same device table.
  const probeCtx = {
    vfs,
    _audioCtx: ac,
    getMemory: () => memory,
    sharedAudio: ctx.sharedAudio,
    sharedMixer: ctx.sharedMixer,
  };
  let probeImports;
  const probeAudio = createAudioHost(probeCtx, {
    readStr,
    readStrW: readStr,
    readVfsFile: () => null,
    readVfsFileAsync: () => Promise.resolve(null),
    profileNow: () => 0,
    profileEvent: () => {},
    getHost: () => probeImports,
  });
  probeImports = probeAudio.imports;
  const probeId = probeImports.mci_open(516, 0, 0x1000);
  assert(probeId, 'the probe thread should open cdaudio');
  assert.strictEqual(ctx._mci.devices, probeCtx._mci.devices,
    'UI and probe threads should share one process MCI table');
  dv.setUint32(status + 8, 5, true); // MCI_STATUS_MEDIA_PRESENT
  assert.strictEqual(imports.mci_command(probeId, 0x0814, 0x100, status), 0,
    'the UI thread should query a device opened by the probe thread');
  assert.strictEqual(dv.getUint32(status + 4, true), 1);
  assert.strictEqual(imports.mci_command(probeId, 0x0804, 0, 0), 0);
  audio.pumpWaveOutCompletions();
  console.log('PASS CUE/BIN CD-DA mounts lazily and MCI plays TMSF tracks with status + notify');
});
