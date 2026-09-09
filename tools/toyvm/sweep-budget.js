#!/usr/bin/env node

'use strict';

// How much of a program a sweep is allowed to run, in the guest's own time.
//
//   const { sweepBudget, showSeconds } = require('./sweep-budget');
//   const budget = sweepBudget({ dispatches: arg('dispatches'),
//                                guestSeconds: arg('guest-seconds'),
//                                defaultGuestSeconds: showSeconds(8e6) });
//
// WHY THE UNIT CHANGED. Every sweep in this directory used to budget in
// DISPATCHES, and a dispatch count is only a fixed amount of the guest's own
// time while the clock derived from it stays put. It did not stay put:
// aadf7ec4 quoted the VGA frame period against `guestSeconds()` instead of
// `tickUnit()`, which is dispatchesPerTick only under --pit-clock, so on the
// default two-clock path a 70Hz mode-13h frame went from 26,009 dispatches to
// 143,051. The card had been running at 385Hz. Fixing it was right and it
// silently rephotographed the corpus: for the same budget every retrace-paced
// demo is now 5.5x earlier in its own show, and 18 programs that drew a frame
// at the sweep's 8M drew nothing at all.
//
// Nothing about those programs changed -- the ruler did. So the budget is
// quoted in the unit the machine's real-time cadences are quoted in, and the
// conversion goes through the clock the run will actually use
// (dispatchesPerTick / tickScale, `dispatchesForGuestSeconds` in dos-loop.js).
// A future retiming then moves no pictures.
//
// `--dispatches=` is kept and still wins when it is named: an A/B of the
// interpreter against itself wants fixed WORK, and asking that question in
// seconds would make the two arms run different amounts of it.

const { dispatchesForGuestSeconds } = require('./dos-loop');

// The clock the sweeps run their programs on: run-dos.js's defaults, named
// here because a budget converted against one clock and run on another is a
// budget for a machine nobody used.
const SWEEP_CLOCK = { dispatchesPerTick: 550e3, tickScale: 1 };

// The VGA frame period, in dispatches, as it was BEFORE aadf7ec4 on the
// default clock: tickUnit() * 18.2065 / 70, with tickUnit() = irqEvery = 100e3.
const OLD_VGA_PERIOD = 100e3 * (1193182 / 65536) / 70;

// The guest seconds it takes to show, at a true 70Hz, as many frames as
// `oldDispatches` used to buy. This is how each sweep's default was picked:
// the corpus keeps its old pictures, taken at the same point in each show.
// 8M -> 4.4s, 30M -> 16.5s, 300M -> 164.8s.
function showSeconds(oldDispatches) {
  return Math.round(oldDispatches / OLD_VGA_PERIOD / 70 * 10) / 10;
}

// The budget one sweep should hand a run, in dispatches. Exactly one of the
// two flags decides it and `dispatches` wins, so a caller can always pin the
// work; `guestSeconds` (or the default) goes through the clock.
function sweepBudget({ dispatches, guestSeconds, defaultGuestSeconds, clock = SWEEP_CLOCK } = {}) {
  if (dispatches !== undefined && dispatches !== null && dispatches !== '') {
    return count(dispatches);
  }
  const sec = guestSeconds === undefined || guestSeconds === null || guestSeconds === ''
    ? defaultGuestSeconds : Number(guestSeconds);
  if (!(sec > 0)) throw new Error(`not a guest-second budget: ${sec}`);
  return dispatchesForGuestSeconds(sec, clock);
}

// `8m`, `300m`, `1.65b`, `44000000`. The same reader every tool in here uses.
function count(s) {
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`not a count: ${s}`);
  return Math.round(Number(m[1]) * ({ '': 1, k: 1e3, m: 1e6, b: 1e9 })[m[2].toLowerCase()]);
}

module.exports = { SWEEP_CLOCK, OLD_VGA_PERIOD, showSeconds, sweepBudget, count };
