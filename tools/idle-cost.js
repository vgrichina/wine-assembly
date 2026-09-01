#!/usr/bin/env node
// What does a page cost when it is doing nothing, and what is keeping it busy?
//
// tl;dr: "the idle desktop burns CPU" is two questions -- how much, and who --
// and neither is answerable from the outside. This launches a REAL (headful)
// Chrome, wraps setTimeout/setInterval/requestAnimationFrame *before any page
// script runs* so every scheduled callback is attributed to the line that
// registered it, samples for a while, and prints callbacks/s and the wall time
// each registration site actually spends. Alongside that it samples the CPU of
// the browser's own processes and then navigates the same tab to about:blank
// and samples again, so the number has a floor under it.
//
//   node tools/idle-cost.js --url=http://127.0.0.1:8080/ --seconds=15
//   node tools/idle-cost.js --settle=0            # measure page BOOT instead
//   node tools/idle-cost.js --headless            # only for pass/fail checks
//   node tools/idle-cost.js --app=sol             # launch an app first, then
//                                                 # measure it sitting idle
//
// With --app the report adds guestCounters: repaint composites and guest run
// slices over the sample window, which answers "is the app one timer tick per
// second or a 60fps blit loop" directly instead of by inference.
//
// HEADFUL IS THE DEFAULT ON PURPOSE. Headless Chrome has no compositor
// surface and no display refresh to pace rAF against, so a free-running rAF
// chain can cost almost nothing there and 13% of a core in the browser the
// user is actually looking at. That difference is exactly the class of bug
// this tool exists to find, so measuring it headless would hide it.
//
// Output: one JSON object -- cpu.page / cpu.blank (percent of one core, per
// process) and schedule[] (one row per registration site, sorted by the wall
// time its callbacks consumed).

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = name => process.argv.includes(`--${name}`);

const URL = arg('url', 'http://127.0.0.1:8080/');
const APP = arg('app', '');
const SECONDS = Number(arg('seconds', '15'));
const TOP = Number(arg('top', '12'));
const SETTLE = Number(arg('settle', '6'));
const HEADLESS = flag('headless');
const CHROME = arg('chrome', process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

// Every callback the page schedules, attributed to where it was registered.
// This runs before the page's own scripts, which is the only way to see the
// timers a library installs at import time -- wrapping afterwards catches the
// registrations that have not happened yet and none of the ones that have.
function installProbe() {
  const sites = new Map();
  const siteOf = (kind, delay) => {
    let line = '(unknown)';
    try {
      const st = (new Error().stack || '').split('\n');
      // [0] "Error", [1] siteOf, [2] the setTimeout/setInterval wrapper,
      // [3] the page code that actually registered the callback. Reading [2]
      // names this file at every site, which looks like attribution and is
      // not.
      line = (st[3] || st[2] || st[1] || '').trim().replace(/^at\s+/, '').slice(0, 90);
    } catch (_) {}
    return `${kind}${delay === undefined ? '' : '(' + delay + 'ms)'} ${line}`;
  };
  const bump = (key, ms) => {
    let row = sites.get(key);
    if (!row) { row = { fires: 0, ms: 0 }; sites.set(key, row); }
    row.fires++;
    row.ms += ms;
  };
  const wrap = (key, fn) => function () {
    const t0 = performance.now();
    try { return fn.apply(this, arguments); }
    finally { bump(key, performance.now() - t0); }
  };

  const oSetTimeout = window.setTimeout;
  const oSetInterval = window.setInterval;
  const oRaf = window.requestAnimationFrame;
  window.setTimeout = function (fn, delay, ...rest) {
    if (typeof fn !== 'function') return oSetTimeout.call(window, fn, delay, ...rest);
    return oSetTimeout.call(window, wrap(siteOf('setTimeout', delay | 0), fn), delay, ...rest);
  };
  window.setInterval = function (fn, delay, ...rest) {
    if (typeof fn !== 'function') return oSetInterval.call(window, fn, delay, ...rest);
    return oSetInterval.call(window, wrap(siteOf('setInterval', delay | 0), fn), delay, ...rest);
  };
  window.requestAnimationFrame = function (fn) {
    return oRaf.call(window, wrap(siteOf('rAF'), fn));
  };
  // MessageChannel is the emulator's own zero-delay step primitive and is not
  // a timer, so it would be invisible to the three wrappers above -- and it is
  // precisely the loop that ran at 100k/s before the park-sleep landed.
  const nativeOnMessage = window.MessagePort
    && Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
  if (nativeOnMessage && nativeOnMessage.set) {
    Object.defineProperty(MessagePort.prototype, 'onmessage', {
      configurable: true,
      get: nativeOnMessage.get,
      set(fn) {
        if (typeof fn !== 'function') return nativeOnMessage.set.call(this, fn);
        return nativeOnMessage.set.call(this, wrap(siteOf('MessagePort'), fn));
      },
    });
  }

  window.__idleCost = {
    reset() { sites.clear(); this.t0 = performance.now(); },
    read() {
      const dt = Math.max(1, performance.now() - this.t0) / 1000;
      const rows = [];
      for (const [key, row] of sites) {
        rows.push({
          site: key,
          firesPerSec: +(row.fires / dt).toFixed(1),
          msPerSec: +(row.ms / dt).toFixed(2),
        });
      }
      rows.sort((a, b) => b.msPerSec - a.msPerSec || b.firesPerSec - a.firesPerSec);
      return { seconds: +dt.toFixed(2), rows };
    },
  };
  window.__idleCost.reset();
}

function procSnapshot(profileDir) {
  const text = execFileSync('ps', ['-Ao', 'pid=,cputime=,command='], { encoding: 'utf8' });
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d:.]+)\s+(.*)$/);
    if (!m || !m[3].includes(profileDir)) continue;
    const parts = m[2].split(':').map(Number);
    if (parts.some(Number.isNaN)) continue;
    const type = (m[3].match(/--type=([a-z-]+)/) || [, 'browser'])[1];
    map.set(Number(m[1]), { cpu: parts.reduce((a, v) => a * 60 + v, 0), type });
  }
  return map;
}

async function sampleCpu(profileDir, seconds) {
  const t0 = Date.now();
  const a = procSnapshot(profileDir);
  await new Promise(r => setTimeout(r, seconds * 1000));
  const b = procSnapshot(profileDir);
  const wall = (Date.now() - t0) / 1000;
  const rows = [];
  let total = 0;
  for (const [pid, after] of b) {
    const before = a.get(pid);
    const delta = after.cpu - (before ? before.cpu : after.cpu);
    if (delta <= 0.01) continue;
    total += delta;
    rows.push({ pid, type: after.type, percentOfOneCore: +((delta / wall) * 100).toFixed(1) });
  }
  rows.sort((x, y) => y.percentOfOneCore - x.percentOfOneCore);
  return { totalPercentOfOneCore: +((total / wall) * 100).toFixed(1), procs: rows.slice(0, 6) };
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-idle-'));
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    executablePath: CHROME,
    userDataDir: profile,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check']
      .concat(HEADLESS ? ['--disable-gpu'] : []),
  });
  const out = { url: URL, headful: !HEADLESS, seconds: SECONDS, settleSeconds: SETTLE };
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.evaluateOnNewDocument(installProbe);
    await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    if (APP) {
      out.app = APP;
      await page.waitForFunction(() => window.wineShell && window.wineShell.launchApp,
        { timeout: 60000 });
      await page.evaluate(id => window.wineShell.launchApp(id), APP);
      // The window is created by the guest mid-run-slice, long after
      // launchApp returns, so poll for a visible top-level it owns.
      await page.waitForFunction(id => {
        const entry = runningApps.find(item => item && item.name === id);
        if (!entry || !entry.wine || !entry.wine.running) return false;
        const lo = entry.wine._hwndBase || 0;
        return Object.keys(sharedRenderer.windows)
          .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
      }, { timeout: 120000 }, APP);
      // Count the two things a sleeping app should not be doing: full
      // composites and guest run slices. Wrapped here, not in lib/, so the
      // page under test stays the shipped page.
      await page.evaluate(() => {
        window.__guestCounters = { composites: 0, slices: 0 };
        const paint = sharedRenderer._repaintOnce.bind(sharedRenderer);
        sharedRenderer._repaintOnce = (...a) => {
          window.__guestCounters.composites++; return paint(...a);
        };
        // The drive loop calls this._scheduleStep(step, delayMs), so an
        // instance-method wrap sees every iteration and the sleep it chose
        // (the same seam lib/phone-diag.js uses). exports.run cannot be
        // wrapped this way: the host captured its reference at init.
        const wine = runningApps[0] && runningApps[0].wine;
        if (wine && wine._scheduleStep) {
          window.__guestCounters.sleeps = {};
          const sched = wine._scheduleStep.bind(wine);
          wine._scheduleStep = (fn, delayMs) => {
            window.__guestCounters.slices++;
            const key = String(Math.min(50, Math.round(delayMs || 0)));
            window.__guestCounters.sleeps[key] =
              (window.__guestCounters.sleeps[key] || 0) + 1;
            return sched(fn, delayMs);
          };
        }
      });
    }
    // Let boot settle: first paint, icon extraction and any one-shot timers
    // are startup cost, not idle cost, and counting them would answer a
    // different question than the one asked. --settle=0 asks the OTHER
    // question deliberately -- "what does opening this page cost" -- which is
    // what a user reporting a spinning fan a few seconds in actually feels.
    await new Promise(r => setTimeout(r, SETTLE * 1000));
    await page.evaluate(() => window.__idleCost.reset());
    if (APP) {
      await page.evaluate(() => {
        window.__guestCounters.composites = 0;
        window.__guestCounters.slices = 0;
        window.__guestCounters.sleeps = {};
        window.__guestCounters.t0 = performance.now();
      });
    }
    out.cpuPage = await sampleCpu(profile, SECONDS);
    if (APP) {
      out.guestCounters = await page.evaluate(() => {
        const c = window.__guestCounters;
        const dt = Math.max(1, performance.now() - c.t0) / 1000;
        return {
          compositesPerSec: +(c.composites / dt).toFixed(1),
          slicesPerSec: +(c.slices / dt).toFixed(1),
          sleepHistogram: c.sleeps,
        };
      });
    }
    const sched = await page.evaluate(() => window.__idleCost.read());
    out.scheduleSeconds = sched.seconds;
    out.schedule = sched.rows.slice(0, TOP);
    out.scheduleTotalMsPerSec = +sched.rows.reduce((a, r) => a + r.msPerSec, 0).toFixed(2);

    await page.goto('about:blank', { waitUntil: 'load' });
    await new Promise(r => setTimeout(r, 2000));
    out.cpuBlank = await sampleCpu(profile, Math.min(SECONDS, 10));
  } finally {
    await browser.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(JSON.stringify(out, null, 1));
}

main().catch(err => { console.error(err); process.exit(1); });
