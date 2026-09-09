'use strict';

// What a corpus sweep is allowed to spend, and what it calls what it finds.
//
// Two claims, and they broke together once: a sweep budget quoted in
// DISPATCHES stopped meaning a fixed amount of the guest's own time the moment
// aadf7ec4 requoted the VGA frame period against real time, and the rows that
// lost their picture to that were then filed under a bucket -- `art` -- that
// counts as a pass. The corpus read as healthy while eighteen programs had
// stopped drawing.
//
// 1. THE BUDGET IS GUEST TIME. `sweepBudget` converts seconds of guest time
//    into dispatches through the clock the run will use (dispatchesPerTick,
//    tickScale) and is the exact inverse of DosSession.guestSeconds(), which
//    is what every real-time cadence in the machine is quoted against. A
//    `--dispatches=` override still wins, because an A/B of the interpreter
//    against itself wants fixed WORK and asking for that in seconds would give
//    the two arms different amounts of it.
//
// 2. `art` NEEDS THE RUN'S OWN EVIDENCE, not a cell count. A .NFO viewer and a
//    demo parked on its sound-card menu are both "a few hundred non-blank
//    cells". What separates them is whether the program ever put the adapter
//    in a graphics mode -- if it did, the console holds furniture and the
//    program's own output is a frame it has not finished -- and whether the
//    run was still alive behind the screen that was photographed. STHINTRO.EXE
//    was counted as text art with its loader spinning at 0000:0000.
//
// The screens below are synthetic and deliberately so: two rows differing in
// the evidence and not in the picture must land in different buckets, which is
// the whole property, and no real program is needed to state it.

const assert = require('assert');

const { sweepBudget, showSeconds, SWEEP_CLOCK } = require('../tools/toyvm/sweep-budget');
const { guestSeconds, dispatchesForGuestSeconds } = require('../tools/toyvm/dos-loop');
const { classify, sawGraphics } = require('../tools/toyvm/demo-status');

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// --- 1. the budget ----------------------------------------------------------

// A guest second on the default clock is dispatchesPerTick / (65536/1193182)
// dispatches: 550,000 * 18.2065 = 10.01M. Quoted here as the arithmetic rather
// than as the constant, so a change to the clock moves both sides.
const PER_SECOND = 550e3 * (1193182 / 65536);

function budget() {
  const one = dispatchesForGuestSeconds(1, SWEEP_CLOCK);
  check(Math.abs(one - PER_SECOND) < 1,
    `one guest second is ${one} dispatches on the sweep clock (want ${PER_SECOND.toFixed(0)})`);

  // The round trip is the property that matters: whatever the clock, the
  // dispatches a budget converts to have to convert back to the seconds asked
  // for. A sweep whose two directions disagree photographs a budget nobody
  // asked for.
  for (const clock of [SWEEP_CLOCK,
    { dispatchesPerTick: 550e3, tickScale: 16 },      // clock-probe.js's fast arm
    { dispatchesPerTick: 1.1e6, tickScale: 1 },       // a slower guest
    { dispatchesPerTick: 65536, tickScale: 1 }]) {    // live.js at 1.19MHz
    for (const sec of [0.8, 4.4, 16.5, 165]) {
      const n = dispatchesForGuestSeconds(sec, clock);
      const back = guestSeconds(n, clock);
      check(Math.abs(back - sec) < 1e-6,
        `${sec}s at dispatchesPerTick=${clock.dispatchesPerTick} tickScale=${clock.tickScale}`
        + ` is ${n} dispatches and converts back to ${back.toFixed(6)}s`);
    }
  }

  // tickScale is a speed, so a faster guest clock buys the same guest second
  // in fewer dispatches. Checked separately because getting this the wrong way
  // round is invisible in a round trip.
  check(dispatchesForGuestSeconds(1, { dispatchesPerTick: 550e3, tickScale: 16 })
    === Math.round(dispatchesForGuestSeconds(1, SWEEP_CLOCK) / 16),
    'a 16x guest clock buys a guest second in a sixteenth of the dispatches');

  // The defaults each sweep ships. They are the guest time the tool's old
  // dispatch default bought of a paced show BEFORE the retiming -- 8M -> 4.4s
  // for sweep-dos.js, 30M -> 16.5s for shot-sweep.js, 300M -> 164.8s for
  // capture-one.sh -- so the corpus keeps the pictures it already has.
  check(showSeconds(8e6) === 4.4, `8M pre-retiming dispatches is ${showSeconds(8e6)} guest seconds`);
  check(showSeconds(30e6) === 16.5, `30M is ${showSeconds(30e6)} guest seconds`);
  check(showSeconds(300e6) === 164.8, `300M is ${showSeconds(300e6)} guest seconds`);

  // ...and the ratio those encode: a retrace-paced show that used to cost B
  // dispatches now costs 5.5x B, because the frame period went from 26,009
  // dispatches to 143,051 on this clock.
  const ratio = dispatchesForGuestSeconds(showSeconds(8e6), SWEEP_CLOCK) / 8e6;
  check(Math.abs(ratio - 5.5) < 0.02,
    `the same show costs x${ratio.toFixed(2)} the dispatches it used to`);

  // The flags. `--dispatches=` wins when it is named, in the counted form
  // every other tool in the directory accepts; otherwise guest seconds decide,
  // and an unnamed sweep gets its default.
  check(sweepBudget({ dispatches: '8m', guestSeconds: 4.4, defaultGuestSeconds: 16.5 }) === 8e6,
    '--dispatches= overrides a guest-second budget');
  check(sweepBudget({ dispatches: '1.65b' }) === 1.65e9, '--dispatches=1.65b is 1,650,000,000');
  check(sweepBudget({ guestSeconds: '4.4', defaultGuestSeconds: 16.5 })
    === dispatchesForGuestSeconds(4.4, SWEEP_CLOCK),
    '--guest-seconds= is converted on the sweep clock');
  check(sweepBudget({ defaultGuestSeconds: 16.5 }) === dispatchesForGuestSeconds(16.5, SWEEP_CLOCK),
    'an unnamed budget is the tool default, in guest seconds');
  // An empty string is what `arg()` hands back for a flag that was not given
  // in some of these tools, and it must not read as "zero dispatches".
  check(sweepBudget({ dispatches: '', guestSeconds: '', defaultGuestSeconds: 4.4 })
    === dispatchesForGuestSeconds(4.4, SWEEP_CLOCK),
    'an empty flag is not a budget of zero');
  assert.throws(() => sweepBudget({ defaultGuestSeconds: 0 }), /guest-second budget/);
  check(true, 'a budget of no guest time is refused rather than run');
}

// --- 2. art vs a menu -------------------------------------------------------

// A BBS advertisement drawn in block graphics. This IS the program: it never
// asks for anything but the text mode it was started in.
const ART = {
  name: 'A-NOTE.EXE',
  pixels: 0,
  cells: 1580,
  modes: [3],
  // Nine lines, and the apology is in the middle of them on purpose: a note
  // file that says "sorry about using MOD-OBJ" halfway through is still a note
  // file, and complaint() only reads a screen's last four lines for exactly
  // this reason. A five-line fixture would be all tail and would test the
  // opposite thing by accident.
  screen: [
    '        ###   ALPHA PACIFIC   ###',
    '     a note from the crew, and greetings to everyone',
    '',
    '   we sat on this one for months. sorry about using MOD-OBJ,',
    '   it was the only player that fit in the last two blocks.',
    '',
    '   greets to everyone we met at the party this summer, and',
    '   to the people running the boards. see you in the next one.',
    '                    -- the crew, 1993',
    '   [ this file is the whole production. there is nothing else ]',
  ].join('\n'),
};

// A sound-card setup menu. Same shape of screen, same order of cells, and the
// run behind it has already asked the BIOS for mode 13h -- so what is on the
// console is furniture and the program's own output is a frame it has not
// drawn yet.
const MENU = {
  name: 'STHINTRO.EXE',
  pixels: 0,
  cells: 248,
  modes: [3, 0x13],
  screen: [
    '        Stairway To Heaven BBS-Dentro by bLaSM',
    '',
    '        1. Sound Blaster',
    '        2. Sound Blaster Pro',
    '        3. Gravis UltraSound',
    '        4. No sound',
    '',
    '        Your choice ?',
  ].join('\n'),
};

function art() {
  check(sawGraphics(MENU) === true, 'the menu row went to a graphics mode');
  check(sawGraphics(ART) === false, 'the art row never left text mode');
  // The power-on 3 is a fact about the BIOS and not about the program: a row
  // whose whole history is [3] must not read as "has been in mode 3".
  check(sawGraphics({ modes: [3, 3] }) === false, 'the power-on mode is not evidence');
  check(sawGraphics({}) === false, 'a row too old to carry a mode history claims nothing');

  check(classify(ART) === 'art', `a full text screen with no graphics behind it is art`);
  check(classify(MENU) === 'prompt',
    `the same shape of screen from a program that asked for mode 13h is a prompt,`
    + ` not art (got ${classify(MENU)})`);

  // The two rows differ ONLY in the evidence. Swap the histories and the
  // buckets swap with them -- which is the property, and the reason a cell
  // count cannot stand in for it.
  check(classify({ ...ART, modes: [3, 0x13] }) === 'prompt'
    && classify({ ...MENU, modes: [3] }) === 'art',
  'the bucket follows the mode history and not the size of the screen');

  // A run that wedged behind its own screen is not showing anything on
  // purpose, however full the screen is.
  check(classify({ ...ART, stuckAt: '0:0' }) === 'failed',
    'a text screen with the run stuck behind it is a failure, not art');

  // Two things this must NOT have broken. A graphics frame with content is the
  // answer whatever the console holds, and a refusal is still a refusal.
  check(classify({ ...MENU, pixels: 46912 }) === 'demo',
    'a drawn graphics frame is a demo whatever else the row says');
  check(classify({ name: 'rage.exe', pixels: 0, cells: 36, modes: [3],
    screen: 'GUS not found!\nrequires GUS; buy one or miss this thing..' }) === 'error',
  'a complaint is still an error and not art');
}

budget();
art();
console.log(fail.length ? `\n${fail.length} FAILED` : '\nall sweep-budget checks passed');
process.exit(fail.length ? 1 : 0);
