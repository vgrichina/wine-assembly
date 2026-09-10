#!/usr/bin/env node
// The Record button has to record the sound as well as the picture.
//
// WHY: lib/recorder.js builds its output stream from the canvas and then
// bolts an audio track onto it by tapping the emulator's master gain node.
// Every part of that is invisible from the outside -- the button still turns
// red, the timer still counts, the file still downloads and still plays. The
// only thing missing is the sound, and you find that out after the recording
// is over.
//
// Three separate things have to hold, and each has its own failure:
//   - an audio track is attached at all (a missing AudioContext at start time
//     silently drops it, and the recorder only ever looks once);
//   - the tap hears the bus the guest actually plays into, not an empty gain
//     node the recorder made for itself;
//   - the container the recorder wrote really carries an audio stream.
//
// A test tone stands in for the guest here on purpose: this is about the
// recorder's plumbing, and a real app that happens to be silent in the three
// seconds we watch would fail for a reason that is not the recorder's.

'use strict';

const assert = require('assert');
const fs = require('fs');
const { startStaticServer: startSharedStaticServer } = require('./static-server');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Two apps, because each one owns its own AudioContext and the recorder used
// to tap only the first. The sound goes on the SECOND one.
const APPS = ['notepad', 'calc'];

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for recorder audio test');
  process.exit(0);
}

function startStaticServer() {
  return startSharedStaticServer({ root: ROOT });
}

async function main() {
  const server = process.env.BASE_URL ? null : await startStaticServer();
  const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--disable-gpu', '--no-sandbox', '--no-first-run',
      // Without this the AudioContext starts suspended and the tap records
      // silence for a reason that has nothing to do with the recorder.
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  // The recorder's onstop synthesizes an <a download> and clicks it. Left
  // alone that writes a real MP4 into the user's ~/Downloads on every run,
  // and Chrome will not shut down while it is still bookkeeping one -- the
  // test then hangs in browser.close() long after it has printed PASS.
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-audio-dl-'));
  try {
    const page = await browser.newPage();
    await page.createCDPSession().then(session => session.send(
      'Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }));
    const logs = [];
    page.on('console', message => logs.push(message.text()));
    page.on('pageerror', error => logs.push(`PAGEERROR ${error.message}`));
    await page.goto(`${base}/index.html?record-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    for (const app of APPS) {
      // Two clicks: off single-app the desktop keeps the mouse convention and
      // the first click only selects.
      await page.evaluate(name => {
        const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === name);
        if (!icon) throw new Error(`no ${name} icon on the desktop`);
        icon.click();
        icon.click();
      }, app);
      try {
        await page.waitForFunction(name => {
          const entry = runningApps.find(item => item && item.name === name);
          return !!(entry && entry.wine && entry.wine.running && entry.wine._audioCtx);
        }, { timeout: 120000 }, app);
      } catch (error) {
        console.error(logs.slice(-40).join('\n'));
        throw error;
      }
    }

    // The download is a click on a generated <a>, which headless would either
    // drop or write somewhere we would then have to clean up. Keep the blob.
    await page.evaluate(() => {
      window.__recorded = null;
      const realCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob && /^video\//.test(blob.type || '')) window.__recorded = blob;
        return realCreate(blob);
      };
      // The stream is module-private, so take it where it is handed over.
      const RealRecorder = window.MediaRecorder;
      window.MediaRecorder = function (stream, options) {
        window.__recStream = stream;
        return new RealRecorder(stream, options);
      };
      window.MediaRecorder.isTypeSupported = RealRecorder.isTypeSupported.bind(RealRecorder);
      window.MediaRecorder.prototype = RealRecorder.prototype;
    });

    // A tone on the master bus: exactly where every guest voice and the MIDI
    // synth end up, so this measures the tap and nothing else.
    const primed = await page.evaluate(async last => {
      const entry = runningApps.find(item => item && item.name === last && item.wine && item.wine._audioCtx);
      if (!entry) return `no AudioContext on ${last}`;
      const first = runningApps.find(item => item && item.wine && item.wine._audioCtx);
      if (first === entry) return 'the two apps share one AudioContext; this test cannot see the bug';
      const ac = entry.wine._audioCtx;
      if (ac.state === 'suspended') { try { await ac.resume(); } catch (_) {} }
      // Guest audio lands on _wineMaster; lib/host-audio.js makes it on first
      // sound and the recorder makes it if nobody has yet. Either way the tone
      // has to go on that same node, so make it here if it is not there.
      if (!ac._wineMaster) {
        const m = ac.createGain();
        m.connect(ac.destination);
        ac._wineMaster = m;
      }
      const master = ac._wineMaster;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      gain.gain.value = 0.3;
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(master);
      osc.start();
      window.__tone = osc;
      return `ok state=${ac.state}`;
    }, APPS[APPS.length - 1]);
    assert(primed.startsWith('ok'), `could not prime audio: ${primed}`);

    await page.evaluate(() => toggleRecording());
    await new Promise(resolve => setTimeout(resolve, 3000));

    // What the recorder is actually about to encode.
    const tracks = await page.evaluate(() => {
      const stream = window.__recStream;
      if (!stream) return null;
      return stream.getAudioTracks().map(track => ({
        kind: track.kind, enabled: track.enabled, muted: track.muted,
        readyState: track.readyState,
      }));
    });
    assert(tracks, 'the recorder never constructed a MediaRecorder');
    assert.strictEqual(tracks.length, 1,
      `the output stream carries ${tracks.length} audio tracks; the recording will be silent. ` +
      `console said: ${JSON.stringify(logs.filter(line => line.includes('[record]')))}`);
    assert.strictEqual(tracks[0].readyState, 'live', 'the audio track is not live');
    assert.strictEqual(tracks[0].enabled, true, 'the audio track is disabled');
    assert.strictEqual(tracks[0].muted, false, 'the audio track is muted');
    const videoCount = await page.evaluate(() => window.__recStream.getVideoTracks().length);
    assert.strictEqual(videoCount, 1, 'rebuilding the stream lost the canvas video track');

    // A live track proves nothing about what is on it -- a tap on the wrong
    // AudioContext is live and silent. Listen to the track the recorder is
    // encoding and check the tone is really in it.
    const rms = await page.evaluate(async () => {
      const ac = new AudioContext();
      if (ac.state === 'suspended') { try { await ac.resume(); } catch (_) {} }
      const source = ac.createMediaStreamSource(
        new MediaStream(window.__recStream.getAudioTracks()));
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        analyser.getFloatTimeDomainData(buffer);
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
      }
      try { ac.close(); } catch (_) {}
      return peak;
    });
    assert(rms > 0.01,
      `the recorded audio track is silent (peak ${rms.toFixed(4)}); the tap is on the wrong ` +
      `AudioContext. console said: ${JSON.stringify(logs.filter(line => line.includes('[record]')))}`);

    await page.evaluate(() => toggleRecording());
    await page.waitForFunction(() => !!window.__recorded, { timeout: 30000 });

    // And what it wrote. A container with no audio codec in it is the same
    // failure one layer down -- the track was there and never got encoded.
    const written = await page.evaluate(async () => {
      const blob = window.__recorded;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let text = '';
      for (let i = 0; i < Math.min(bytes.length, 65536); i++) text += String.fromCharCode(bytes[i]);
      return { type: blob.type, size: blob.size, head: text };
    });
    assert(written.size > 1024, `the recording is ${written.size} bytes`);
    const audioCodec = /A_OPUS|A_VORBIS|OpusHead|mp4a/.test(written.head);
    assert(audioCodec,
      `no audio codec in the ${written.type} the recorder wrote (${written.size} bytes)`);

    console.log(`PASS  the recorder captures the audio bus (${written.type}, ${written.size} bytes)`);
  } finally {
    await browser.close();
    if (server) server.close();
    try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch(error => { console.error(error); process.exit(1); });
