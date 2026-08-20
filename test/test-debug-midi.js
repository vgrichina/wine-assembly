// The debug toolbar's MIDI player, which plays an asset through the real MCI
// host path with no guest running. Its whole value is as a discriminator —
// "the synth is broken" vs "the app never asked for music" — so what these
// checks care about is that it fails in a way that says which, and that it
// still drives the same host imports the guest would.
//
// It was inline in index.html until 2026-08-19 and could not be tested at all
// from there.

const assert = require('assert');
const { createDebugMidi } = require('../lib/debug-midi');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

// A minimal Standard MIDI File: MThd, one track, one note.
function smfBytes() {
  const b = Buffer.concat([
    Buffer.from('MThd'), Buffer.from([0, 0, 0, 6, 0, 0, 0, 1, 0, 96]),
    Buffer.from('MTrk'), Buffer.from([0, 0, 0, 8]),
    Buffer.from([0x00, 0x90, 0x3c, 0x40, 0x60, 0x80, 0x3c, 0x00]),
  ]);
  return new Uint8Array(b);
}

const APPS = {
  sol: { files: ['assets/cards.mid', 'assets/sol.exe'] },
  pinball: { files: ['assets/pinball.mid', 'assets/pinball.wav'] },
  dup: { files: ['assets/cards.mid'] },
};

function makePlayer(overrides) {
  const status = [];
  const calls = [];
  const player = createDebugMidi(Object.assign({
    apps: APPS,
    appFileUrl: (f) => f,
    debugMode: true,
    setStatus: (t) => status.push(t),
    newHost: () => ({ primeAudio: () => ({ sampleRate: 44100 }) }),
    createHostImports: (ctx) => {
      ctx._mci = { devices: new Map() };
      return {
        host: {
          mci_open: (ptr) => {
            const mem = new Uint8Array(ctx.getMemory());
            let name = '';
            for (let i = ptr; mem[i]; i++) name += String.fromCharCode(mem[i]);
            calls.push(['mci_open', name]);
            // The file has to be reachable by the name MCI was handed.
            const data = ctx.readFile(name);
            ctx._mci.devices.set(1, { smf: { notes: data ? [{}, {}] : [] } });
            return 1;
          },
          mci_command: (id, cmd) => { calls.push(['mci_command', id, cmd]); return 0; },
        },
      };
    },
  }, overrides || {}));
  return { player, status, calls };
}

console.log('=== debug-midi ===');

check('only MIDI assets are offered, once each', () => {
  const { player } = makePlayer();
  const assets = player.midiAssets();
  assert.deepStrictEqual(assets.map(a => a.url),
    ['assets/cards.mid', 'assets/pinball.mid'], 'the .exe and .wav are not MIDI, and cards.mid is listed twice');
  assert.strictEqual(assets[0].label, 'sol: cards.mid', 'the label names the app it came from');
});

check('a container that is not MIDI is named as such', () => {
  const { player } = makePlayer();
  assert.strictEqual(player.containerKind(smfBytes()), 'SMF');
  const rmid = new Uint8Array(32);
  Buffer.from('RIFF').copy(rmid, 0);
  Buffer.from('RMID').copy(rmid, 8);
  assert.strictEqual(player.containerKind(rmid), 'RMID');
  assert.strictEqual(player.containerKind(new Uint8Array(64)), '', 'zeros are not MIDI');
  assert.strictEqual(player.containerKind(null), '', 'no bytes is not a throw');
});

check('the filename is written where a host import can read it', () => {
  const { player } = makePlayer();
  const memory = new WebAssembly.Memory({ initial: 1 });
  player.writeString(memory, 0x100, 'CANYON.MID');
  const mem = new Uint8Array(memory.buffer);
  let out = '';
  for (let i = 0x100; mem[i]; i++) out += String.fromCharCode(mem[i]);
  assert.strictEqual(out, 'CANYON.MID');
  assert.strictEqual(mem[0x100 + 10], 0, 'MCI reads a C string, so it must be terminated');
});

(async () => {
  await checkAsync('a real file reaches mci_open and mci_command', async () => {
    const { player, status, calls } = makePlayer({
      fetchImpl: null,
    });
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => smfBytes().buffer });
    const result = await player.play('assets/canyon.mid');
    assert.ok(result, 'play returned nothing');
    assert.deepStrictEqual(calls[0], ['mci_open', 'canyon.mid']);
    assert.strictEqual(calls[1][2], 0x0806, 'MCI_PLAY');
    assert.ok(status.some(s => /Playing MIDI: canyon.mid \(2 notes\)/.test(s)),
      `status never said it was playing: ${JSON.stringify(status)}`);
    assert.strictEqual(player.isPlaying(), true);

    player.stop();
    assert.strictEqual(calls[2][2], 0x0804, 'MCI_STOP');
    assert.strictEqual(player.isPlaying(), false);
  });

  await checkAsync('a non-MIDI file is refused before MCI sees it', async () => {
    const { player, status, calls } = makePlayer();
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array(64).buffer });
    const result = await player.play('assets/notes.txt');
    assert.strictEqual(result, null);
    assert.strictEqual(calls.length, 0, 'MCI must not be handed something that is not MIDI');
    assert.ok(status.some(s => /is not SMF\/RMID/.test(s)), JSON.stringify(status));
  });

  await checkAsync('parsed-with-no-notes is distinguished from silence', async () => {
    // The whole point of the tool: a file that opens and yields nothing is a
    // different bug from one that never opened, and both are different from a
    // guest that never asked.
    const { player, status } = makePlayer({
      createHostImports: (ctx) => {
        ctx._mci = { devices: new Map([[1, { smf: { notes: [] } }]]) };
        return { host: { mci_open: () => 1, mci_command: () => 0 } };
      },
    });
    global.fetch = async () => ({ ok: true, arrayBuffer: async () => smfBytes().buffer });
    assert.strictEqual(await player.play('assets/empty.mid'), null);
    assert.ok(status.some(s => /parsed with no notes/.test(s)), JSON.stringify(status));
  });

  await checkAsync('a failed fetch reports the status code, not a stack', async () => {
    const { player, status } = makePlayer();
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.strictEqual(await player.play('assets/missing.mid'), null);
    assert.ok(status.some(s => /HTTP 404/.test(s)), JSON.stringify(status));
  });

  console.log(failures === 0 ? '\nAll debug-midi checks passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
