#!/usr/bin/env node
//
// A file the launch never mounted used to be read with a *synchronous*
// XMLHttpRequest on the page's main thread: the tab froze for a whole network
// round trip, and the perf HUD could not even see it because the stall
// happened inside a host import rather than in a phase it marks.
//
// The two callers that can reach that miss are a wallpaper set and an MCI
// open, and neither needs the bytes in the same turn — a wallpaper may appear
// a beat late, and real MCI is allowed to still be preparing a device when
// `open` returns. So the miss now starts an off-thread read and the caller
// applies what lands. This checks both, plus the two facts the design rests
// on: the page no longer contains a synchronous request, and a host with no
// async reader at all (the CLI, whose VFS is a real directory) still treats a
// miss as final.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');

const ROOT = path.join(__dirname, '..');

function makeBmp() {
  const bmp = new Uint8Array(70);
  const dv = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4D;
  dv.setUint32(2, bmp.length, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, 2, true);
  dv.setInt32(22, 2, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, 16, true);
  bmp.set([255, 0, 0, 255, 255, 255, 0, 0], 54);
  bmp.set([0, 0, 255, 0, 255, 0, 0, 0], 62);
  return bmp;
}

// A one-track SMF with a single note, enough for _parseSmf to report notes.
function makeMid() {
  const track = Uint8Array.from([
    0x00, 0x90, 0x3C, 0x40,        // note on
    0x60, 0x80, 0x3C, 0x00,        // note off
    0x00, 0xFF, 0x2F, 0x00,        // end of track
  ]);
  const out = new Uint8Array(14 + 8 + track.length);
  const dv = new DataView(out.buffer);
  out.set([0x4D, 0x54, 0x68, 0x64], 0);   // MThd
  dv.setUint32(4, 6);
  dv.setUint16(8, 0);                      // format 0
  dv.setUint16(10, 1);                     // one track
  dv.setUint16(12, 96);                    // ticks per quarter
  out.set([0x4D, 0x54, 0x72, 0x6B], 14);  // MTrk
  dv.setUint32(18, track.length);
  out.set(track, 22);
  return out;
}

function writeStr(memory, at, str) {
  new Uint8Array(memory, at, str.length + 1).set(
    Uint8Array.from([...str].map(c => c.charCodeAt(0)).concat(0)));
}

const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (e) { results.push([false, `${name}: ${e.message}`]); }
}

async function main() {
  // --- wallpaper: a miss the page can still fetch ---
  {
    const memory = new ArrayBuffer(1024);
    writeStr(memory, 64, 'wall.bmp');
    const bmp = makeBmp();
    let applied = null;
    const asked = [];
    const hostCtx = {
      getMemory: () => memory,
      renderer: {
        canvas: { width: 8, height: 6 },
        setDesktopWallpaper: (dib, tiled) => { applied = { dib, tiled }; return true; },
      },
      readFileAsync: (name) => { asked.push(name); return Promise.resolve(bmp); },
    };
    const { host } = createHostImports(hostCtx);
    const ret = host.set_wallpaper(64, 0);
    check('an unmounted wallpaper returns TRUE without blocking',
      () => assert.strictEqual(ret, 1));
    check('nothing is on the desktop yet in the same turn',
      () => assert.strictEqual(applied, null));
    await new Promise(r => setImmediate(r));
    check('the fetched wallpaper reaches the renderer once it lands',
      () => assert(applied && applied.dib && applied.dib.w === 2));
    check('the fetch asked for the path the guest named',
      () => assert.deepStrictEqual(asked, ['wall.bmp']));
  }

  // --- wallpaper: a miss with no async reader is simply absent ---
  {
    const memory = new ArrayBuffer(1024);
    writeStr(memory, 64, 'nope.bmp');
    const hostCtx = { getMemory: () => memory, renderer: null };
    const { host } = createHostImports(hostCtx);
    check('without an async reader a missing wallpaper still fails',
      () => assert.strictEqual(host.set_wallpaper(64, 0), 0));
  }

  // --- MCI: a sequencer opened on a file that is not mounted yet ---
  {
    const memory = new ArrayBuffer(1024);
    writeStr(memory, 64, 'open sound.mid type sequencer alias bgm');
    writeStr(memory, 256, 'play bgm');
    const mid = makeMid();
    let resolveFetch = null;
    const hostCtx = {
      getMemory: () => memory,
      renderer: null,
      readFileAsync: () => new Promise(r => { resolveFetch = r; }),
    };
    const { host } = createHostImports(hostCtx);
    check('MCI open of an unmounted sequencer succeeds',
      () => assert.strictEqual(host.mci_string(64, 0, 0, 0), 0));
    // A play issued while the bytes are still in flight must not be dropped.
    host.mci_string(256, 0, 0, 0);
    resolveFetch(mid);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    check('the late bytes are parsed onto the open device', () => {
      writeStr(memory, 512, 'status bgm length');
      const out = 700;
      host.mci_string(512, out, 32, 0);
      const buf = new Uint8Array(memory, out, 32);
      const text = Array.from(buf.subarray(0, buf.indexOf(0))).map(c => String.fromCharCode(c)).join('');
      assert(Number(text) > 0, `length after late attach was "${text}"`);
    });
  }

  // --- the page no longer holds a synchronous request ---
  {
    const hostJs = fs.readFileSync(path.join(ROOT, 'host.js'), 'utf8');
    check('host.js issues no XMLHttpRequest at all',
      () => assert(!/new XMLHttpRequest/.test(hostJs)));
    check('host.js fetches a missing file off the main thread',
      () => assert(/_fetchMissingFile/.test(hostJs) && /readFileAsync/.test(hostJs)));
  }

  let failed = 0;
  for (const [ok, name] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  process.exit(failed ? 1 : 0);
}

main();
