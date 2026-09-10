#!/usr/bin/env node

// PlaySoundA / PlaySoundW / sndPlaySoundA name a WAV in one of three ways —
// a file on the VFS (SND_FILENAME, and the no-flag default), a memory image
// the caller owns (SND_MEMORY), or a WAVE resource in the module
// (SND_RESOURCE) — and every one of them has to end at the host wave path or
// report FALSE. Before this test the file form set eax=1 and played nothing:
// a silent success, which leaves an app believing its sound is playing and
// gives a debugger nothing to find.
//
// The handlers are called directly (the $handle_* entry points, through a
// small exported wrapper) rather than through a guest binary, so each flag
// combination is one assertion instead of a whole app run. What we observe is
// the host side: `play_sound(wasmPtr, length)` is the single seam every form
// funnels into, so "did samples reach the host" is literally "was play_sound
// called, with how many bytes, and do those bytes start RIFF/WAVE".

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (global $ps_eax (mut i32) (i32.const 0))
  (global $ps_esp_delta (mut i32) (i32.const 0))

  (func $ps_record (param $saved_esp i32)
    (global.set $ps_eax (global.get $eax))
    (global.set $ps_esp_delta (i32.sub (global.get $esp) (local.get $saved_esp)))
    (global.set $esp (local.get $saved_esp)))

  (func (export "ps_last_eax") (result i32) (global.get $ps_eax))
  (func (export "ps_last_esp_delta") (result i32) (global.get $ps_esp_delta))

  ;; Guest-visible scratch for the path strings and WAV images the test builds.
  (func (export "ps_alloc") (param $n i32) (result i32)
    (call $heap_alloc (local.get $n)))
  (func (export "ps_g2w") (param $g i32) (result i32)
    (call $g2w (local.get $g)))

  (func (export "ps_play_sound_a") (param $name i32) (param $flags i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_PlaySoundA (local.get $name) (i32.const 0) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $ps_record (local.get $saved_esp)))

  (func (export "ps_play_sound_w") (param $name i32) (param $flags i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_PlaySoundW (local.get $name) (i32.const 0) (local.get $flags)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $ps_record (local.get $saved_esp)))

  (func (export "ps_snd_play_sound_a") (param $name i32) (param $flags i32)
    (local $saved_esp i32)
    (local.set $saved_esp (global.get $esp))
    (call $handle_sndPlaySoundA (local.get $name) (local.get $flags) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (call $ps_record (local.get $saved_esp)))
`;

// SND_* from mmsystem.h.
const SND_SYNC = 0x0000;
const SND_ASYNC = 0x0001;
const SND_NODEFAULT = 0x0002;
const SND_MEMORY = 0x0004;
const SND_LOOP = 0x0008;
const SND_NOSTOP = 0x0010;
const SND_PURGE = 0x0040;
const SND_ALIAS = 0x00010000;
const SND_FILENAME = 0x00020000;

// A minimal but genuinely well-formed 8-bit mono PCM WAV, so the validator in
// $sound_wav_is_valid is being satisfied by a real container and not by a
// 44-byte run of anything.
function makeWav(sampleCount) {
  const data = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) data[i] = 0x80 + (i % 32);
  const wav = Buffer.alloc(44 + sampleCount);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + sampleCount, 4);   // RIFF chunk size: everything after +8
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);                 // PCM
  wav.writeUInt16LE(1, 22);                 // mono
  wav.writeUInt32LE(11025, 24);
  wav.writeUInt32LE(11025, 28);             // byte rate
  wav.writeUInt16LE(1, 32);                 // block align
  wav.writeUInt16LE(8, 34);                 // bits per sample
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(sampleCount, 40);
  data.copy(wav, 44);
  return new Uint8Array(wav);
}

const checks = [];
function check(label, pass, info = '') {
  checks.push(pass);
  console.log(`${pass ? 'PASS  ' : 'FAIL  '}${label}${info ? `  (${info})` : ''}`);
}

async function main() {
  // Every host play_sound lands here with the bytes it was handed, so a test
  // can assert on content rather than on the fact a call happened.
  const played = [];
  const loops = [];
  // Stopping is observed on the same seam: the host now hands back a voice id
  // for the sound it started, and the WAT policy aims voice_close at it. A
  // fake voice manager here is enough to see which id got stopped and when.
  const stopped = [];
  let nextVoice = 0x0B9000;
  let liveVoice = 0;
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      play_sound: (wasmPtr, length, loop) => {
        played.push(new Uint8Array(harness.memory.buffer, wasmPtr >>> 0, length >>> 0).slice());
        loops.push(loop >>> 0);
        liveVoice = ++nextVoice;
        return liveVoice;
      },
      voice_close: (id) => {
        stopped.push(id >>> 0);
        if ((id >>> 0) === liveVoice) liveVoice = 0;
        return 0;
      },
      voice_is_playing: (id) => (((id >>> 0) === liveVoice) ? 1 : 0),
    },
  });
  const e = harness.exports;
  const vfs = harness.hostCtx.vfs;
  assert.ok(vfs && vfs.files, 'harness host context has a VFS');

  const bytes = new Uint8Array(harness.memory.buffer);
  const putString = (text) => {
    const guest = e.ps_alloc(text.length + 1);
    assert.ok(guest, 'heap_alloc returned a guest pointer');
    const wa = e.ps_g2w(guest);
    for (let i = 0; i < text.length; i++) bytes[wa + i] = text.charCodeAt(i) & 0xFF;
    bytes[wa + text.length] = 0;
    return guest;
  };
  const putStringW = (text) => {
    const guest = e.ps_alloc((text.length + 1) * 2);
    const wa = e.ps_g2w(guest);
    for (let i = 0; i < text.length; i++) {
      bytes[wa + i * 2] = text.charCodeAt(i) & 0xFF;
      bytes[wa + i * 2 + 1] = (text.charCodeAt(i) >> 8) & 0xFF;
    }
    bytes[wa + text.length * 2] = 0;
    bytes[wa + text.length * 2 + 1] = 0;
    return guest;
  };
  const putBlob = (blob) => {
    const guest = e.ps_alloc(blob.length);
    bytes.set(blob, e.ps_g2w(guest));
    return guest;
  };

  const wav = makeWav(512);
  vfs.dirs.add('c:\\windows');
  vfs.dirs.add('c:\\windows\\media');
  vfs.files.set('c:\\windows\\media\\ding.wav', { data: wav, attrs: 0x20 });
  // A file that exists but is not a WAV at all: the length check passes and
  // the container check has to be the thing that refuses it.
  vfs.files.set('c:\\windows\\media\\notawav.wav', {
    data: new Uint8Array(Buffer.alloc(4096, 0x41)), attrs: 0x20,
  });

  const isWav = (buf) => buf.length >= 44 &&
    String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) === 'RIFF' &&
    String.fromCharCode(buf[8], buf[9], buf[10], buf[11]) === 'WAVE';

  // --- SND_FILENAME through PlaySoundA -------------------------------------
  played.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\ding.wav'), SND_FILENAME | SND_ASYNC);
  check('PlaySoundA(SND_FILENAME) returns TRUE', e.ps_last_eax() === 1,
    `eax=${e.ps_last_eax()}`);
  check('PlaySoundA(SND_FILENAME) reached the host wave path', played.length === 1,
    `${played.length} play_sound call(s)`);
  check('PlaySoundA(SND_FILENAME) delivered the whole file',
    played.length === 1 && played[0].length === wav.length,
    `${played.length === 1 ? played[0].length : '-'} of ${wav.length} bytes`);
  check('PlaySoundA(SND_FILENAME) delivered a RIFF/WAVE image',
    played.length === 1 && isWav(played[0]));
  check('PlaySoundA pops its three stdcall arguments', e.ps_last_esp_delta() === 16,
    `esp += ${e.ps_last_esp_delta()}`);

  // A relative name resolves through the same VFS every other file API uses.
  played.length = 0;
  const cwd = vfs.cwd;
  vfs.cwd = 'c:\\windows\\media';
  e.ps_play_sound_a(putString('ding.wav'), SND_FILENAME);
  vfs.cwd = cwd;
  check('PlaySoundA(SND_FILENAME) resolves a relative path through the VFS',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- a missing file is FALSE, not a silent TRUE ---------------------------
  played.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\nosuch.wav'), SND_FILENAME);
  check('PlaySoundA(SND_FILENAME) on a missing file returns FALSE',
    e.ps_last_eax() === 0, `eax=${e.ps_last_eax()}`);
  check('PlaySoundA(SND_FILENAME) on a missing file plays nothing',
    played.length === 0, `${played.length} play_sound call(s)`);

  // --- a file that is not a WAV is FALSE too --------------------------------
  played.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\notawav.wav'), SND_FILENAME);
  check('PlaySoundA(SND_FILENAME) on a non-RIFF file returns FALSE',
    e.ps_last_eax() === 0 && played.length === 0,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- no flags at all still means "this is a filename" ---------------------
  played.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\ding.wav'), SND_SYNC | SND_NODEFAULT);
  check('PlaySoundA with no form flag treats pszSound as a filename',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- SND_MEMORY through PlaySoundA (it used to handle only resources) -----
  played.length = 0;
  e.ps_play_sound_a(putBlob(wav), SND_MEMORY | SND_ASYNC);
  check('PlaySoundA(SND_MEMORY) returns TRUE and reaches the host',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);
  check('PlaySoundA(SND_MEMORY) sizes the image from its RIFF chunk',
    played.length === 1 && played[0].length === wav.length,
    `${played.length === 1 ? played[0].length : '-'} of ${wav.length} bytes`);

  // A memory block that is not a WAV must not be handed to the decoder.
  played.length = 0;
  e.ps_play_sound_a(putBlob(new Uint8Array(Buffer.alloc(256, 0x41))), SND_MEMORY);
  check('PlaySoundA(SND_MEMORY) on a non-RIFF block returns FALSE',
    e.ps_last_eax() === 0 && played.length === 0,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- sndPlaySoundA gets the same forms ------------------------------------
  played.length = 0;
  e.ps_snd_play_sound_a(putString('c:\\windows\\media\\ding.wav'), SND_ASYNC);
  check('sndPlaySoundA(filename) returns TRUE and reaches the host',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);
  check('sndPlaySoundA pops its two stdcall arguments', e.ps_last_esp_delta() === 12,
    `esp += ${e.ps_last_esp_delta()}`);

  played.length = 0;
  e.ps_snd_play_sound_a(putString('c:\\windows\\media\\nosuch.wav'), SND_FILENAME);
  check('sndPlaySoundA on a missing file returns FALSE',
    e.ps_last_eax() === 0 && played.length === 0,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  played.length = 0;
  e.ps_snd_play_sound_a(putBlob(wav), SND_MEMORY);
  check('sndPlaySoundA(SND_MEMORY) still reaches the host',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- PlaySoundW takes a UTF-16 path ---------------------------------------
  played.length = 0;
  e.ps_play_sound_w(putStringW('c:\\windows\\media\\ding.wav'), SND_FILENAME);
  check('PlaySoundW(SND_FILENAME) reads the wide path through the VFS',
    e.ps_last_eax() === 1 && played.length === 1,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- SND_LOOP reaches the host voice as a loop, not as a one-shot ---------
  played.length = 0;
  loops.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\ding.wav'), SND_FILENAME | SND_LOOP);
  check('PlaySoundA(SND_LOOP) plays the sound looping',
    e.ps_last_eax() === 1 && played.length === 1 && loops[0] === 1,
    `eax=${e.ps_last_eax()} calls=${played.length} loop=${loops[0]}`);
  played.length = 0;
  loops.length = 0;
  e.ps_play_sound_a(putString('c:\\windows\\media\\ding.wav'), SND_FILENAME);
  check('PlaySoundA without SND_LOOP asks the host for a one-shot',
    played.length === 1 && loops[0] === 0, `loop=${loops[0]}`);

  // --- forms that must NOT claim success ------------------------------------
  played.length = 0;
  e.ps_play_sound_a(putString('SystemStart'), SND_ALIAS);
  check('PlaySoundA(SND_ALIAS) returns FALSE with no sound scheme installed',
    e.ps_last_eax() === 0 && played.length === 0,
    `eax=${e.ps_last_eax()} calls=${played.length}`);

  // --- stop requests -------------------------------------------------------
  // PlaySound owns one sound per process: starting a second one stops the
  // first. Before the host handed back a voice this could only be claimed.
  const ding = putString('c:\\windows\\media\\ding.wav');
  played.length = 0; stopped.length = 0;
  e.ps_play_sound_a(ding, SND_FILENAME | SND_ASYNC);
  const firstVoice = liveVoice;
  stopped.length = 0;
  e.ps_play_sound_a(ding, SND_FILENAME | SND_ASYNC);
  check('a second PlaySound stops the sound the first one started',
    played.length === 2 && stopped.length === 1 && stopped[0] === firstVoice,
    `plays=${played.length} stops=[${stopped.join(',')}] first=${firstVoice}`);

  // SND_NOSTOP is the caller saying it would rather have nothing than
  // interrupt: Windows returns FALSE and plays nothing while the device is
  // busy with a sound this process started.
  played.length = 0; stopped.length = 0;
  e.ps_play_sound_a(ding, SND_FILENAME | SND_NOSTOP);
  check('PlaySoundA(SND_NOSTOP) refuses rather than stopping the live sound',
    e.ps_last_eax() === 0 && played.length === 0 && stopped.length === 0,
    `eax=${e.ps_last_eax()} plays=${played.length} stops=${stopped.length}`);

  // PlaySound(NULL, 0, 0): the documented "stop everything" call.
  played.length = 0; stopped.length = 0;
  const beforeNull = liveVoice;
  e.ps_play_sound_a(0, SND_SYNC);
  check('PlaySoundA(NULL) stops the sound that was playing',
    e.ps_last_eax() === 1 && played.length === 0 &&
      stopped.length === 1 && stopped[0] === beforeNull && liveVoice === 0,
    `eax=${e.ps_last_eax()} stops=[${stopped.join(',')}] before=${beforeNull}`);

  // Nothing playing: still TRUE, but with nothing to aim a stop at the host
  // must not be asked to close a voice that is already gone.
  played.length = 0; stopped.length = 0;
  e.ps_play_sound_a(0, SND_SYNC);
  check('PlaySoundA(NULL) with nothing playing succeeds without a host stop',
    e.ps_last_eax() === 1 && stopped.length === 0,
    `eax=${e.ps_last_eax()} stops=${stopped.length}`);

  // SND_PURGE names the same stop, with a sound name that must be ignored.
  played.length = 0; stopped.length = 0;
  e.ps_play_sound_a(ding, SND_FILENAME | SND_ASYNC);
  const beforePurge = liveVoice;
  stopped.length = 0;
  e.ps_play_sound_a(ding, SND_PURGE);
  check('PlaySoundA(SND_PURGE) stops the live sound and plays nothing',
    e.ps_last_eax() === 1 && played.length === 1 &&
      stopped.length === 1 && stopped[0] === beforePurge,
    `eax=${e.ps_last_eax()} plays=${played.length} stops=[${stopped.join(',')}]`);

  // sndPlaySound(NULL, 0) is the 16-bit spelling of the same stop.
  played.length = 0; stopped.length = 0;
  e.ps_snd_play_sound_a(ding, SND_ASYNC);
  const beforeSnd = liveVoice;
  stopped.length = 0;
  e.ps_snd_play_sound_a(0, 0);
  check('sndPlaySoundA(NULL, 0) stops the sound it started',
    e.ps_last_eax() === 1 && stopped.length === 1 && stopped[0] === beforeSnd,
    `eax=${e.ps_last_eax()} stops=[${stopped.join(',')}] before=${beforeSnd}`);

  console.log('');
  const failed = checks.filter(p => !p).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
