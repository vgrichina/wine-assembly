#!/usr/bin/env node
// Regression coverage for generic MIDI playback.
//
// This does not launch a Win32 app. It verifies the host import layer can:
//   - open an explicit .mid file through the MCI "sequencer" path
//   - parse Standard MIDI File note events
//   - schedule notes through Web Audio primitives
//   - avoid inventing a default song when an app opens sequencer with no file
//   - play direct midiOutShortMsg note-on/note-off messages
//   - handle the common mciSendStringA sequencer commands

const assert = require('assert');
const { createHostImports } = require('../lib/host-imports');

const mem = new WebAssembly.Memory({ initial: 2 });
const u8 = new Uint8Array(mem.buffer);

function writeStr(ptr, s) {
  for (let i = 0; i < s.length; i++) u8[ptr + i] = s.charCodeAt(i);
  u8[ptr + s.length] = 0;
}

function writeStrW(ptr, s) {
  const dv = new DataView(mem.buffer);
  for (let i = 0; i < s.length; i++) dv.setUint16(ptr + i * 2, s.charCodeAt(i), true);
  dv.setUint16(ptr + s.length * 2, 0, true);
}

// Format 0, one track, 96 ticks/quarter:
// note-on middle C at tick 0, note-off at tick 96, end-of-track.
const oneNoteMidi = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0d,
  0x00, 0x90, 0x3c, 0x64,
  0x60, 0x80, 0x3c, 0x00,
  0x00, 0xff, 0x2f, 0x00,
]);

function makeRmid(smf) {
  const out = new Uint8Array(12 + 8 + smf.length + (smf.length & 1));
  out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  const riffSize = out.length - 8;
  out[4] = riffSize & 0xFF;
  out[5] = (riffSize >>> 8) & 0xFF;
  out[6] = (riffSize >>> 16) & 0xFF;
  out[7] = (riffSize >>> 24) & 0xFF;
  out.set([0x52, 0x4D, 0x49, 0x44], 8); // RMID
  out.set([0x64, 0x61, 0x74, 0x61], 12); // data
  out[16] = smf.length & 0xFF;
  out[17] = (smf.length >>> 8) & 0xFF;
  out[18] = (smf.length >>> 16) & 0xFF;
  out[19] = (smf.length >>> 24) & 0xFF;
  out.set(smf, 20);
  return out;
}

const oneNoteRmid = makeRmid(oneNoteMidi);
const delayedOneNoteMidi = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0e,
  0x83, 0x60, 0x90, 0x3c, 0x64,
  0x60, 0x80, 0x3c, 0x00,
  0x00, 0xff, 0x2f, 0x00,
]);

const midiEventStream = Uint8Array.from([
  0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
  0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x22,
  0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
  0x00, 0xc0, 0x18,
  0x00, 0xb0, 0x07, 0x64,
  0x00, 0xe0, 0x00, 0x40,
  0x00, 0xd0, 0x20,
  0x00, 0xa0, 0x3c, 0x10,
  0x00, 0x90, 0x3c, 0x64,
  0x60, 0x80, 0x3c, 0x00,
  0x00, 0xff, 0x2f, 0x00,
]);

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push(['set', value, time]);
  }
  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push(['ramp', value, time]);
  }
}

class FakeNode {
  constructor() {
    this.connections = [];
    this.disconnected = false;
  }
  connect(node) {
    this.connections.push(node);
    return node;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeOscillator extends FakeNode {
  constructor(owner) {
    super();
    this.owner = owner;
    this.type = '';
    this.frequency = new FakeAudioParam();
    this.starts = [];
    this.stops = [];
  }
  start(time) {
    this.starts.push(time);
    this.owner.started.push(this);
  }
  stop(time) {
    this.stops.push(time);
  }
}

class FakeAudioContext {
  constructor() {
    this.currentTime = 10;
    this.destination = new FakeNode();
    this.state = 'running';
    this.started = [];
  }
  createGain() {
    const g = new FakeNode();
    g.gain = new FakeAudioParam(1);
    return g;
  }
  createOscillator() {
    return new FakeOscillator(this);
  }
  resume() {
    this.state = 'running';
  }
}

const oldAudioContext = globalThis.AudioContext;
const oldWindow = globalThis.window;
const windowListeners = {};
globalThis.AudioContext = FakeAudioContext;
globalThis.window = {
  addEventListener(type, fn) {
    if (!windowListeners[type]) windowListeners[type] = [];
    windowListeners[type].push(fn);
  },
};

try {
  writeStr(0x100, 'sequencer');
  writeStr(0x120, 'song.mid');

  const ctx = {
    getMemory: () => mem.buffer,
    readFile: (p) => {
      const lower = p.toLowerCase();
      if (lower === 'song.mid') return oneNoteMidi;
      if (lower === 'song.rmi') return oneNoteRmid;
      if (lower === 'delayed.mid') return delayedOneNoteMidi;
      if (lower === 'events.mid') return midiEventStream;
      return null;
    },
  };
  const imports = createHostImports(ctx);
  assert(windowListeners.pointerdown && windowListeners.pointerdown.length, 'audio unlock listener should be installed immediately');
  windowListeners.pointerdown[0]();
  assert(ctx._voices._ac, 'first browser pointerdown should create the shared AudioContext');
  assert.strictEqual(ctx._voices._ac.state, 'running');

  const id = imports.host.mci_open(0x100, 0x120, 0x2000);
  const dev = ctx._mci.devices.get(id);
  assert(dev, 'MCI device should be registered');
  assert.strictEqual(dev.type, 'sequencer');
  assert.strictEqual(dev.element, 'song.mid');
  assert(dev.smf, 'explicit MIDI file should parse');
  assert.strictEqual(dev.smf.notes.length, 1);
  assert(Math.abs(dev.smf.duration - 0.5) < 0.0001, `expected 0.5s duration, got ${dev.smf.duration}`);
  assert.strictEqual(dev.smf.division, 96);
  assert.strictEqual(dev.smf.events.length, 2, 'parsed SMF should expose timed MIDI events');
  assert.deepStrictEqual(dev.smf.events.map(ev => ev.raw), [[0x90, 0x3c, 0x64], [0x80, 0x3c, 0x00]]);
  assert.strictEqual(dev.smf.events[0].time, 0);
  assert.strictEqual(dev.smf.events[1].time, 0.5);

  assert.strictEqual(imports.host.mci_command(id, 0x0806, 0, 0), 0, 'MCI_PLAY should succeed');
  assert.strictEqual(dev.state, 'playing');
  assert.strictEqual(ctx._voices._ac.started.length, 1, 'one oscillator note should be scheduled');

  const osc = ctx._voices._ac.started[0];
  assert.strictEqual(osc.type, 'triangle');
  assert(Math.abs(osc.frequency.value - 261.625565) < 0.001, `expected middle C frequency, got ${osc.frequency.value}`);
  assert(osc.starts[0] >= 10.04, 'note should be scheduled just after current audio time');
  assert(osc.stops[0] > osc.starts[0], 'note stop should be after note start');

  const statusPtr = 0x200;
  new DataView(mem.buffer).setUint32(statusPtr + 8, 1, true); // MCI_STATUS_LENGTH
  assert.strictEqual(imports.host.mci_command(id, 0x0814, 0, statusPtr), 0);
  assert.strictEqual(new DataView(mem.buffer).getUint32(statusPtr + 4, true), 500);

  assert.strictEqual(imports.host.mci_command(id, 0x0804, 0, 0), 0, 'MCI_CLOSE should succeed');
  assert(!ctx._mci.devices.has(id), 'MCI_CLOSE should release the device');

  writeStrW(0x180, 'sequencer');
  writeStrW(0x1a0, 'song.mid');
  const wideId = imports.host.mci_open_w(0x180, 0x1a0, 0x2000);
  const wideDev = ctx._mci.devices.get(wideId);
  assert(wideDev && wideDev.smf, 'wide MCI open should parse explicit MIDI file');
  assert.strictEqual(wideDev.smf.notes.length, 1);
  assert.strictEqual(imports.host.mci_command(wideId, 0x0804, 0, 0), 0);

  writeStr(0x1c0, 'song.rmi');
  const rmidId = imports.host.mci_open(0x100, 0x1c0, 0x2000);
  const rmidDev = ctx._mci.devices.get(rmidId);
  assert(rmidDev && rmidDev.smf, 'RIFF RMID files should unwrap to embedded SMF data');
  assert.strictEqual(rmidDev.smf.notes.length, 1);
  assert.strictEqual(imports.host.mci_command(rmidId, 0x0804, 0, 0), 0);

  writeStr(0x1d0, 'delayed.mid');
  const delayedCtx = {
    getMemory: () => mem.buffer,
    _audioCtx: new FakeAudioContext(),
    trimMidiLeadIn: true,
    readFile: (p) => p.toLowerCase() === 'delayed.mid' ? delayedOneNoteMidi : null,
  };
  const delayedImports = createHostImports(delayedCtx);
  const delayedId = delayedImports.host.mci_open(0x100, 0x1d0, 0x2000);
  const delayedDev = delayedCtx._mci.devices.get(delayedId);
  assert(delayedDev && delayedDev.smf && delayedDev.smf.notes[0].start > 2, 'delayed MIDI fixture should have leading silence');
  assert.strictEqual(delayedImports.host.mci_command(delayedId, 0x0806, 0, 0), 0);
  assert.strictEqual(delayedCtx._audioCtx.started.length, 1, 'debug MIDI playback should trim leading silence and schedule immediately');
  assert.strictEqual(delayedImports.host.mci_command(delayedId, 0x0804, 0, 0), 0);

  writeStr(0x1b0, 'events.mid');
  const eventsId = imports.host.mci_open(0x100, 0x1b0, 0x2000);
  const eventsDev = ctx._mci.devices.get(eventsId);
  assert(eventsDev && eventsDev.smf, 'event stream fixture should parse');
  assert.deepStrictEqual(eventsDev.smf.tempos, [{ tick: 0, time: 0, usPerQn: 500000 }]);
  assert.deepStrictEqual(
    eventsDev.smf.events.map(ev => ev.type),
    ['program', 'cc', 'pitch', 'pressure', 'polyPressure', 'on', 'off']
  );
  assert.deepStrictEqual(eventsDev.smf.events.map(ev => ev.raw), [
    [0xc0, 0x18],
    [0xb0, 0x07, 0x64],
    [0xe0, 0x00, 0x40],
    [0xd0, 0x20],
    [0xa0, 0x3c, 0x10],
    [0x90, 0x3c, 0x64],
    [0x80, 0x3c, 0x00],
  ]);
  assert.strictEqual(eventsDev.smf.events[2].value, 0);
  assert.strictEqual(eventsDev.smf.notes.length, 1);
  assert.strictEqual(eventsDev.smf.duration, 0.5);
  assert.strictEqual(imports.host.mci_command(eventsId, 0x0804, 0, 0), 0);

  writeStr(0x1e0, 'song.mid');
  const typeFilenameId = imports.host.mci_open(0x1e0, 0, 0x2002);
  const typeFilenameDev = ctx._mci.devices.get(typeFilenameId);
  assert(typeFilenameDev && typeFilenameDev.smf, 'MCI_OPEN_TYPE filename should parse as a sequencer file');
  assert.strictEqual(typeFilenameDev.type, 'sequencer');
  assert.strictEqual(typeFilenameDev.element, 'song.mid');
  assert.strictEqual(imports.host.mci_command(typeFilenameId, 0x0806, 0, 0), 0);
  assert.strictEqual(imports.host.mci_command(typeFilenameId, 0x0804, 0, 0), 0);

  const hmo = imports.host.midi_out_open(0, 0, 0, 0);
  assert(hmo, 'midiOutOpen should return a real host handle');
  assert.strictEqual(imports.host.midi_out_set_volume(hmo, 0x80008000), 0);
  assert.strictEqual(imports.host.midi_out_get_volume(hmo, 0x240), 0);
  assert.strictEqual(new DataView(mem.buffer).getUint32(0x240, true), 0x80008000);

  const beforeDirect = ctx._voices._ac.started.length;
  assert.strictEqual(imports.host.midi_out_short_msg(hmo, 0x00643C90), 0, 'note-on should succeed');
  assert.strictEqual(ctx._voices._ac.started.length, beforeDirect + 1, 'direct MIDI note-on should schedule an oscillator');
  assert.strictEqual(imports.host.midi_out_short_msg(hmo, 0x00003C80), 0, 'note-off should succeed');
  assert.strictEqual(imports.host.midi_out_reset(hmo), 0);
  assert.strictEqual(imports.host.midi_out_close(hmo), 0);
  assert.strictEqual(imports.host.midi_out_short_msg(hmo, 0x00643C90), 5, 'closed MIDI handle should be invalid');

  writeStr(0x300, 'open song.mid type sequencer alias song');
  assert.strictEqual(imports.host.mci_string(0x300, 0, 0), 0);
  assert(ctx._mci.aliases.has('song'), 'mciSendString open should register alias');
  const beforeStringPlay = ctx._voices._ac.started.length;
  writeStr(0x340, 'play song');
  assert.strictEqual(imports.host.mci_string(0x340, 0, 0), 0);
  assert.strictEqual(ctx._voices._ac.started.length, beforeStringPlay + 1, 'mciSendString play should schedule MIDI notes');
  writeStr(0x360, 'status song length');
  assert.strictEqual(imports.host.mci_string(0x360, 0x380, 32), 0);
  assert.strictEqual(readCString(0x380), '500');
  writeStr(0x3a0, 'close song');
  assert.strictEqual(imports.host.mci_string(0x3a0, 0, 0), 0);
  assert(!ctx._mci.aliases.has('song'), 'mciSendString close should release alias');

  const emptyId = imports.host.mci_open(0x100, 0, 0x2000);
  const emptyDev = ctx._mci.devices.get(emptyId);
  assert(emptyDev, 'empty sequencer open should still create a device');
  assert.strictEqual(emptyDev.type, 'sequencer');
  assert.strictEqual(emptyDev.smf, null, 'sequencer open without an element must not auto-select a MIDI file');

  const before = ctx._voices._ac.started.length;
  assert.strictEqual(imports.host.mci_command(emptyId, 0x0806, 0, 0), 0);
  assert.strictEqual(ctx._voices._ac.started.length, before, 'empty sequencer playback should schedule no notes');
  assert.strictEqual(imports.host.mci_command(emptyId, 0x0804, 0, 0), 0);

  const primedCtx = new FakeAudioContext();
  const primedHost = createHostImports({
    getMemory: () => mem.buffer,
    _audioCtx: primedCtx,
    readFile: (p) => p.toLowerCase() === 'song.mid' ? oneNoteMidi : null,
  });
  assert.strictEqual(primedHost.host.midi_num_devs(), 1);
  assert.strictEqual(primedHost.host.midi_out_set_volume(0, 0xFFFFFFFF), 0);
  const primedHandle = primedHost.host.midi_out_open(0, 0, 0, 0);
  assert.strictEqual(primedHost.host.midi_out_short_msg(primedHandle, 0x00643C90), 0);
  assert.strictEqual(primedHost.host.midi_out_close(primedHandle), 0);
  assert.strictEqual(primedCtx.started.length, 1, 'host should reuse pre-unlocked browser AudioContext');

  console.log('PASS  MCI sequencer opens explicit MIDI files and schedules Web Audio notes');
  console.log('PASS  SMF parser exposes timed MIDI events for synth backends');
  console.log('PASS  MCI wide-command open uses the same sequencer backend');
  console.log('PASS  RIFF RMID files unwrap to the same SMF parser');
  console.log('PASS  debug MIDI playback can trim leading silence');
  console.log('PASS  MCI_OPEN_TYPE accepts .mid filenames used by Pinball');
  console.log('PASS  direct midiOutShortMsg schedules and releases Web Audio notes');
  console.log('PASS  mciSendStringA sequencer commands use the same MIDI backend');
  console.log('PASS  browser audio unlock creates the shared AudioContext on user input');
  console.log('PASS  host reuses a launch-primed browser AudioContext');
  console.log('PASS  empty sequencer open does not invent default MIDI playback');
} finally {
  if (oldAudioContext === undefined) delete globalThis.AudioContext;
  else globalThis.AudioContext = oldAudioContext;
  if (oldWindow === undefined) delete globalThis.window;
  else globalThis.window = oldWindow;
}

function readCString(ptr) {
  let s = '';
  for (let p = ptr; u8[p]; p++) s += String.fromCharCode(u8[p]);
  return s;
}
