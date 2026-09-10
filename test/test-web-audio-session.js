#!/usr/bin/env node
// The two things that have to be true before a phone can make any sound.
//
// WHY: "no audio on iOS" has two causes that are indistinguishable from the
// outside, and only one of them is the famous one.
//
//   1. The context never started. iOS creates every AudioContext suspended
//      and only resumes one inside a real user gesture, so audio opened after
//      the last tap is silent forever.
//   2. The context is running, samples are scheduled into it, currentTime
//      advances -- and iOS throws the sound away anyway, because a page whose
//      only audio is WebAudio sits in the ambient-style session the ringer
//      switch mutes. Nothing errors. Every meter reads healthy.
//
// (2) is fixed by declaring the session 'playback' (claimAudioSession in
// host.js, Safari 16.4+). Chrome has no audioSession property, so the test
// installs a stub that records writes -- what is being checked here is that
// the shell asks, at launch and again on each unlock, not that Safari obeys.
// (1) is checked for real: after the launch gesture the context must be
// running, not suspended.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { startStaticServer: startSharedStaticServer } = require('./static-server');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'notepad';

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for audio-session test');
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
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 664, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // Stand in for Safari 16.4+. Records every write so the assertion can be
    // "the shell asked for playback", which is the part we control.
    await page.evaluateOnNewDocument(() => {
      window.__sessionWrites = [];
      let type = 'auto';
      Object.defineProperty(navigator, 'audioSession', {
        configurable: true,
        value: {
          get type() { return type; },
          set type(value) { type = value; window.__sessionWrites.push(value); },
        },
      });
    });
    // ?diag=1 as well, because the phone beacon's audio probe is the only
    // instrument that will exist on the device -- if it reads "no-ctx" on a
    // page that is demonstrably making sound, it will send the next
    // investigation off in the wrong direction.
    await page.goto(`${base}/index.html?single-app=1&diag=1&audio-test=${Date.now()}`,
      { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('.desktop-icon'), { timeout: 60000 });

    const before = await page.evaluate(() => window.__sessionWrites.slice());
    assert.deepStrictEqual(before, [],
      'nothing should touch the audio session before there is any audio to play');

    await page.evaluate(app => {
      const icon = [...document.querySelectorAll('.desktop-icon')].find(el => el.dataset.app === app);
      if (!icon) throw new Error(`no ${app} icon on the desktop`);
      icon.click();
    }, APP);

    await page.waitForFunction(app => {
      const entry = runningApps.find(item => item && item.name === app);
      return !!(entry && entry.wine && entry.wine.running);
    }, { timeout: 120000 }, APP);

    const state = await page.evaluate(() => {
      const entry = runningApps.find(item => item && item.wine && item.wine._audioCtx);
      const ac = entry && entry.wine._audioCtx;
      return {
        writes: window.__sessionWrites.slice(),
        session: navigator.audioSession.type,
        hasCtx: !!ac,
        ctxState: ac ? ac.state : null,
        rate: ac ? ac.sampleRate : null,
      };
    });

    assert(state.hasCtx, 'launching an app must prime an AudioContext inside the tap gesture');
    assert(state.writes.includes('playback'),
      `the shell never claimed the playback audio session (writes: ${JSON.stringify(state.writes)}) -- ` +
      'on iOS that means the ringer switch mutes the emulator with everything else reading healthy');
    assert.strictEqual(state.session, 'playback', 'the session must end up as playback');
    // The gesture half. A context still suspended after the launch tap is the
    // other silence, and it is the one that never recovers on iOS.
    assert.strictEqual(state.ctxState, 'running',
      `the primed context is ${state.ctxState}; a suspended context after the launch gesture is silence`);
    assert(state.rate > 0, 'the context should report a sample rate');

    // And it is re-claimed on later gestures: iOS drops the session when the
    // page is backgrounded, and the tap that comes back is the only chance to
    // set it again.
    const again = await page.evaluate(async () => {
      navigator.audioSession.type = 'auto';
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 200));
      return navigator.audioSession.type;
    });
    assert.strictEqual(again, 'playback', 'a later gesture must re-claim the playback session');

    const diag = await page.evaluate(() => window.PhoneDiag && window.PhoneDiag.snapshot().audio);
    assert(diag && /running@\d+/.test(diag) && /session=/.test(diag),
      `the phone beacon must see the live context; it reported ${JSON.stringify(diag)}`);

    console.log('PASS  audio session claimed for playback and the context runs after the launch tap');
  } finally {
    await browser.close();
    if (server) server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
