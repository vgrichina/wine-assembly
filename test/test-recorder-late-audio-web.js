#!/usr/bin/env node
'use strict';

// Exercise the real encoder with no guest audio at Record, then two guest
// contexts created later. Closing the first guest must not end the audio track.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', message => console.log('page:', message.text()));
    page.on('pageerror', error => console.error('page:', error));
    await page.setContent('<canvas id="screen" width="320" height="240"></canvas>');
    await page.evaluate(() => {
      window.wineShell = { runningApps: [] };
      const NativeRecorder = MediaRecorder;
      window.MediaRecorder = class extends NativeRecorder {
        constructor(stream, options) { super(stream, options); window.capturedStream = stream; }
      };
      URL.createObjectURL = blob => { window.recordedBlob = blob; return 'blob:test'; };
      HTMLAnchorElement.prototype.click = function () {};
      const c = document.getElementById('screen').getContext('2d');
      setInterval(() => { c.fillStyle = Date.now() % 2 ? '#f00' : '#0f0'; c.fillRect(0, 0, 320, 240); }, 33);
      window.addGuestTone = async frequency => {
        const ac = new AudioContext();
        await ac.resume();
        ac._wineMaster = ac.createGain();
        ac._wineMaster.gain.value = 0.15;
        ac._wineMaster.connect(ac.destination);
        const oscillator = ac.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(ac._wineMaster);
        oscillator.start();
        wineShell.runningApps.push({ wine: { _audioCtx: ac } });
      };
      window.recordedPeak = async () => {
        const ac = new AudioContext();
        await ac.resume();
        const source = ac.createMediaStreamSource(new MediaStream(capturedStream.getAudioTracks()));
        const analyser = ac.createAnalyser();
        source.connect(analyser);
        const data = new Float32Array(analyser.fftSize);
        let peak = 0;
        for (let i = 0; i < 40; i++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          analyser.getFloatTimeDomainData(data);
          for (const sample of data) peak = Math.max(peak, Math.abs(sample));
        }
        await ac.close();
        return peak;
      };
    });
    await page.addScriptTag({ path: path.join(__dirname, '../lib/recorder.js') });
    await page.evaluate(() => toggleRecording());
    assert.strictEqual(await page.evaluate(() => capturedStream.getAudioTracks().length), 1,
      'audio track must exist before any guest has an AudioContext');
    assert(await page.evaluate(() => recordedPeak()) < 0.001, 'initial track is silent');
    await page.evaluate(() => addGuestTone(440));
    assert(await page.evaluate(() => recordedPeak()) > 0.05, 'late first guest reaches recording');
    await page.evaluate(() => addGuestTone(880));
    await page.evaluate(() => wineShell.runningApps[0].wine._audioCtx.close());
    assert(await page.evaluate(() => recordedPeak()) > 0.05, 'second guest survives first closing');
    assert.strictEqual(await page.evaluate(() => capturedStream.getAudioTracks().length), 1,
      'no tracks added mid-recording');
    await page.evaluate(() => toggleRecording());
    await page.waitForFunction(() => !!window.recordedBlob);
    assert.strictEqual(await page.evaluate(() => wineShell.runningApps[1].wine._audioCtx.state), 'running',
      'stopping recorder must not close guest audio');
    const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await recordedBlob.arrayBuffer())));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-late-audio-'));
    const file = path.join(dir, 'capture.mp4');
    fs.writeFileSync(file, Buffer.from(bytes));
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
    assert.strictEqual(info.streams.filter(s => s.codec_type === 'audio').length, 1);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-'], {maxBuffer:16*1024*1024});
    let peak = 0;
    for (let i = 0; i + 4 <= pcm.length; i += 4) peak = Math.max(peak, Math.abs(pcm.readFloatLE(i)));
    assert(peak > 0.05, 'encoded and decoded audio contains the late tone');
    console.log(`PASS late guest audio, replacement guest, cleanup, and encoded sound (peak=${peak.toFixed(3)}): ${file}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
