#!/usr/bin/env node

// Two copies of Hearts, two OS processes, one room, one hand of cards.
//
//   node test/test-win16-hearts-vlan.js
//
// test-win16-dde-room.js proves the conversation layer with the DDE state
// installed by hand, and test-win16-dde-connect-callback.js proves the server
// asks its application before agreeing. This is the whole thing end to end:
// two real MSHEARTS.EXE processes drive their own dialogs, one chooses to be
// the dealer and the other goes looking for it, and the question is whether a
// hand gets dealt to both of them.
//
// What has to line up, in order, and what each step is evidence of:
//
//   1. The dealer answers the welcome dialog and lands on the table, which is
//      where it calls DdeNameService — until then there is nothing to find.
//   2. The client picks "connect to another game", is asked for a computer
//      name, and any name will do: what it connects to is the NetDDE agent
//      \\NAME\NDDE$ with topic "Hearts$", and the share is what resolves to
//      the local pair (MSHearts, Hearts). No name matching between the two
//      sides could ever have worked -- see the share table in 01-header.wat.
//   3. The dealer's application says yes from its own XTYP_CONNECT callback,
//      pumped from its own message loop.
//   4. The client's seat appears on the dealer's table. That is the first
//      thing on screen that only a delivered conversation can produce.
//   5. The dealer picks New Game, and both screens fill with cards.
//
// NOTHING HERE MAY BE TIMED IN BATCHES. A batch is a per-process clock and the
// two processes do not keep the same time -- idle, Hearts covers about fourteen
// thousand batches a second, and while it is working through a dialog it covers
// a fraction of that. Scheduling the deal at a fixed batch dealt it twenty
// seconds before the player it was waiting for had joined, and the client met
// "The dealer is not ready, or the game is already in progress", which is
// Hearts being right. So each side pauses on `wait-go` and the harness releases
// it when it has seen the other side get somewhere. Three signals, in order:
//
//   dealer at its table  -> client may press OK on "Locate dealer"
//   client's connect answered -> dealer may deal
//   dealer's hand on screen   -> client may photograph its own
//
// Every bug this found let the connect succeed and the game fail afterwards,
// which is the hardest shape to read from the outside -- the wire looks fine
// because it is fine:
//
//   * XTYP_ADVREQ was 0x2020 and is 0x2022 -- it carries XTYPF_NOBLOCK. Hearts
//     dispatches on the exact value, so the dealer was asked for the data it
//     had just announced, matched no case, and returned NULL every time. The
//     dealer dealt and the other player was told nothing.
//   * An advise push carried its bytes and not the name of the item they were
//     for, so every XTYP_ADVDATA said item zero had changed.
//   * A NetDDE share connect handed the server the wire's names
//     (`\\HOST\NDDE$`, `Hearts$`) instead of the pair the share resolves to,
//     and a client's own conversation did not remember its topic at all.
//   * DDE_FBUSY was treated as an answer. It is "ask me again", and Windows
//     does, until the caller's timeout.
//
// A run that fails at the first milestone is usually not about DDE at all --
// check `uptime`. The milestones are overridable:
//
//   node test/test-win16-hearts-vlan.js --timeout=600 --milestone-timeout=240
//
// To see inside a failure: `--dealer-arg=--watch=0xADDR`, `--client-arg=...`
// for anything one-sided, and `--trace-win16=dealer` for the full trace of one
// end. Never trace both ends of a race.

'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { PNG } = require('pngjs');
const { ProcessHub } = require('../lib/vlan-wire');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const RUN = path.join(ROOT, 'test', 'run.js');
const OUT = path.join(ROOT, 'test', 'output', 'win16-hearts-vlan');
const DEALER_IP = '10.77.0.1';
const CLIENT_IP = '10.77.0.2';

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const MILESTONE_MS = arg('milestone-timeout', 120) * 1000;
const BUDGET_MS = arg('timeout', 300) * 1000;
const DEADLINE = Date.now() + BUDGET_MS;
const BATCHES = arg('batches', 5000000);
const TRACE_SIDES = (() => {
  const hit = process.argv.find(a => a === '--trace-win16' || a.startsWith('--trace-win16='));
  if (!hit) return new Set();
  const spec = hit.includes('=') ? hit.split('=')[1] : 'dealer,client';
  return new Set(spec.split(',').map(s => s.trim()).filter(Boolean));
})();
const DEAL_AT = arg('deal-at', 12000);

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

if (!fs.existsSync(EXE)) {
  console.log('SKIP  MSHEARTS.EXE not found');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
// Every wait here is "has this screenshot appeared yet", so a leftover from the
// last run is not merely confusing -- it satisfies the wait instantly and the
// harness races ahead of the processes it is supposed to be following. The
// first run of this test read a hand dealt twenty minutes earlier.
for (const f of fs.readdirSync(OUT)) {
  if (f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
}

// Points on the welcome dialog, and on the "Locate dealer" box behind the
// client's radio button. The same coordinates the single-process Hearts tests
// use; each is the dialog's client origin plus the control's own position.
const NAME_FIELD = '200:122';
const DEALER_RADIO = '55:210';       // "I want to be dealer"
const CONNECT_RADIO = '55:190';      // "I want to connect to another game"
const OK_BUTTON = '319:92';
const LOCATE_FIELD = '80:132';
const LOCATE_OK = '284:90';

const shot = name => path.join(OUT, `${name}.png`);

const DEALER_INPUT = [
  `3000:click:${NAME_FIELD}`, '3500:keypress:68',
  `4500:click:${DEALER_RADIO}`, `6000:click:${OK_BUTTON}`,
  `${DEAL_AT}:png:${shot('dealer-waiting')}`,
  // Hold here until the harness has seen the client's conversation answered.
  // Batch numbers are a per-process clock and the two processes do not keep
  // the same time -- dealing at a fixed batch dealt twenty seconds early, and
  // the client then met "The dealer is not ready, or the game is already in
  // progress", which is Hearts being right.
  `${DEAL_AT + 1}:wait-go`,
  // New Game. Hearts offers this as F2 from the status bar; the command is
  // what its menu sends and it is the same one.
  // What the dealer's table looked like when the player tried to join. The
  // status bar is the whole story if the join was refused.
  `${DEAL_AT + 100}:png:${shot('dealer-at-join')}`,
  `${DEAL_AT + 5000}:post-cmd:102`,
  `${DEAL_AT + 60000}:png:${shot('dealer-dealt')}`,
].join(',');

const CLIENT_INPUT = [
  `3000:click:${NAME_FIELD}`, '3500:keypress:67',
  `4500:click:${CONNECT_RADIO}`, `6000:click:${OK_BUTTON}`,
  `14000:click:${LOCATE_FIELD}`,
  '15000:keypress:68', '15500:keypress:69', '16000:keypress:65', '16500:keypress:76',
  // Hold the "Locate dealer" OK until the dealer is actually sitting at its
  // table. Its service is registered before that, so the connect is answered
  // either way -- and then the join behind it is refused with "The dealer is
  // not ready, or the game is already in progress", which reads exactly like a
  // wire fault and is not one.
  '17000:wait-go',
  `18000:click:${LOCATE_OK}`,
  `25000:png:${shot('client-joined')}`,
  // Its own go, sent once the dealer's hand is on screen: the client cannot
  // photograph a deal that has not happened yet.
  '25001:wait-go',
  `85000:png:${shot('client-dealt')}`,
].join(',');

// Only a bounded tail of each transcript is kept: two processes at tens of
// thousands of batches produce more than is worth holding in a string.
const KEEP_TAIL = 1 << 20;
const T0 = Date.now();

function spawn(label, ip, input, patterns) {
  const child = fork(RUN, [
    // A side parked on `wait-go` keeps running its message loop while it waits
    // -- it has to, or it could not receive what it is waiting for -- and an
    // idle Hearts covers about fourteen thousand batches a second. So the
    // ceiling is a runaway guard and nothing else; the real bound on this test
    // is its wall-clock budget, and both processes are killed when it is done.
    // Set to 200000 it was thirteen seconds, and the dealer dealt on the last
    // one it had.
    `--exe=${EXE}`, `--max-batches=${BATCHES}`, `--input=${input}`,
    `--vlan-ip=${ip}`, '--vlan-wire',
    // Compositing the whole 640x480 canvas after every batch costs more than
    // running the guest does -- 6000 batches of Hearts is 0.9s of emulation
    // and 40s of repainting. Nothing here reads the screen except the `png`
    // action, which forces its own repaint first, so the intermediate
    // composites are pure waste.
    '--repaint-every=200', '--quiet-api',
    // Both sides must agree about what a second is; see --real-ticks.
    '--real-ticks',
    // Off by default: it names every DDEML call and every message the dialog
    // pumps hand on, which is what to reach for when a side is in the room and
    // still not playing, and far too much output to keep otherwise.
    // Always on, and cheap: a dozen lines naming every transaction the two
    // applications were offered and how each answered. This is the difference
    // between "the wire is broken" and "the application said no".
    '--trace-win16=dde',
    // The full trace is opt-in and per side. `--trace-win16` takes both;
    // `--trace-win16=dealer` leaves the other one's timing alone -- which
    // matters, because tracing both ends of a race makes it disappear.
    ...(TRACE_SIDES.has(label) ? ['--trace-win16'] : []),
    // Anything else, one side at a time: --dealer-arg=--trace-sched=2000.
    // Whichever side is losing a race is the side that must not be slowed by
    // the flag used to look at it, so these never apply to both.
    ...process.argv.filter(a => a.startsWith(`--${label}-arg=`))
      .map(a => a.slice(`--${label}-arg=`.length)),
    // Both failure modes this test can hit -- the request never left, and it
    // arrived after the other side had stopped listening -- are invisible
    // without this, and it is cheap: one line per frame.
    '--trace-net',
    // A parked DdeConnect spends its wait in net_wait yields, and run.js stops
    // a run that makes too many in a row. The default assumes a socket that
    // answers promptly; waiting for another emulator to be scheduled takes
    // very many more.
    '--vlan-max-waits=200000',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { out: '', exited: false, label, seen: new Set(), carry: '', at: {},
                  lastNet: 0, net: [] };
  // Streamed rather than kept: with --trace-win16 a side produces hundreds of
  // megabytes, and the interesting part is not always the tail.
  const sink = fs.createWriteStream(path.join(OUT, `${label}.log`));
  const feed = (chunk) => {
    sink.write(chunk);
    if (chunk.includes('[net]')) {
      state.lastNet = Date.now();
      // Timestamped, because the frames alone cannot say whether an answer was
      // late or absent -- and "late" is the failure this test keeps meeting.
      for (const line of chunk.split('\n')) {
        if (line.includes('[net] ') && state.net.length < 60) {
          state.net.push(`${String(Date.now() - T0).padStart(6)}ms ${line.trim()}`);
        }
      }
    }
    const text = state.carry + chunk;
    for (const [name, re] of Object.entries(patterns || {})) {
      if (!state.seen.has(name) && re.test(text)) {
        state.seen.add(name);
        state.at[name] = Date.now() - T0;
      }
    }
    // Keep enough of the boundary that a pattern spanning two chunks still
    // matches; two run-together trace lines are well under this.
    state.carry = text.slice(-4096);
    state.out = (state.out + chunk).slice(-KEEP_TAIL);
  };
  child.stdout.on('data', d => feed(String(d)));
  child.stderr.on('data', d => feed(String(d)));
  child.on('exit', () => { state.exited = true; });
  state.child = child;
  state.tail = () => state.out.split('\n').slice(-25).join('\n');
  return state;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(state, name) {
  const deadline = Math.min(Date.now() + MILESTONE_MS, DEADLINE);
  while (Date.now() < deadline) {
    if (state.seen.has(name)) return true;
    if (state.exited) return state.seen.has(name);
    await sleep(200);
  }
  return false;
}

// Wait until this side has put nothing on the wire for `ms`. "The exchange has
// finished" is not a moment either process announces, and it is the only thing
// the next step can safely follow.
async function quiet(state, ms) {
  const deadline = Math.min(Date.now() + MILESTONE_MS, DEADLINE);
  while (Date.now() < deadline) {
    if (state.lastNet && Date.now() - state.lastNet > ms) return true;
    await sleep(200);
  }
  return false;
}

async function waitForFile(file) {
  const deadline = Math.min(Date.now() + MILESTONE_MS, DEADLINE);
  while (Date.now() < deadline) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      // The writer is not atomic; give the last bytes a moment to land.
      await sleep(300);
      return true;
    }
    await sleep(500);
  }
  return false;
}

// The table is green baize; the cards on it are white, and so are the three
// computer hands' backs. Both fractions together separate "a table with cards"
// from "a table" and from "a dialog still up".
function table(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let green = 0, white = 0, total = 0;
  for (let y = 30; y < 440 && y < png.height; y++) {
    for (let x = 60; x < 580 && x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
      total++;
      if (g > 90 && r < 60 && b < 60) green++;
      else if (r > 230 && g > 230 && b > 230) white++;
    }
  }
  return { green: green / total, white: white / total };
}

(async () => {
  const hub = new ProcessHub();
  // The dealer goes first and is given its head start on purpose: it has to
  // have registered its service before the client asks for it. A client that
  // arrives first simply times out, which is correct behaviour and not what
  // is under test.
  const dealer = spawn('dealer', DEALER_IP, DEALER_INPUT, {
    heardFrame: /\[net\] \.\. arrived/,
    answered: /\[net\] ->/,
  });
  hub.add(dealer.child);
  await sleep(2000);

  const client = spawn('client', CLIENT_IP, CLIENT_INPUT, {
    sent: /\[net\] ->/,
    heardFrame: /\[net\] \.\. arrived/,
    gaveUp: /Unable to connect with dealer/,
    // The conversation opening and the player being seated are two different
    // things, and this is what the second one failing looks like: the connect
    // is answered, and then the dealer will not have you.
    turnedAway: /dealer is not ready/i,
  });
  hub.add(client.child);

  // The dealer's own screenshot is the signal that it has left its dialog and
  // is sitting at a table waiting for players. Only then is the client let
  // through the last step of its own.
  const seated = await waitForFile(shot('dealer-waiting'));
  check('the dealer reached its table', seated, 'no screenshot was written');
  client.child.send({ t: 'go' });

  // 1-3: the room carried the request and something came back. "Nothing was
  // asked", "nobody answered", and "the answer came after we stopped waiting"
  // are three different bugs and look identical without these.
  check('the client put its connect on the wire', await waitFor(client, 'sent'),
    client.tail());
  check('the dealer received it', await waitFor(dealer, 'heardFrame'), dealer.tail());
  check('the client heard an answer', await waitFor(client, 'heardFrame'),
    client.tail());
  check('the client did not give up on finding a dealer',
    !client.seen.has('gaveUp'), 'the connect failed and Hearts ended');

  // 4: on screen. The client is only at a table at all if its connect was
  // answered -- a refused one puts up "Unable to connect with dealer" and ends
  // the app.
  const joined = await waitForFile(shot('client-joined'));
  check('the client reached a table', joined, 'no screenshot was written');

  // 5: the hand. Both sides, because a dealer that deals to itself while the
  // client sits on an empty table is exactly the failure this test exists to
  // catch -- and it is the one that happened, until the deal was gated on this
  // signal rather than on a batch number.
  //
  // Not a pause but a quiet wire. The answered connect is only the
  // conversation opening; seating the player is the poke, the request and the
  // four advise loops that follow it, and dealing in the middle of those gets
  // the rest of them refused with "the game is already in progress". A fixed
  // sleep guessed at this and lost about one run in two.
  await quiet(client, 2000);
  check('the dealer seated the player', !client.seen.has('turnedAway'),
    '"The dealer is not ready, or the game is already in progress"');
  dealer.child.send({ t: 'go' });
  const dealt = await waitForFile(shot('dealer-dealt'));
  check('the dealer drew its table after New Game', dealt, 'no screenshot');
  if (dealt) {
    const t = table(shot('dealer-dealt'));
    check(`the dealer has cards on the table (${(t.white * 100).toFixed(0)}% white)`,
      t.white > 0.1, JSON.stringify(t));
  }
  // The dealer's screen is on disk; the client's hand has still to cross the
  // room and be drawn.
  await sleep(5000);
  client.child.send({ t: 'go' });
  const clientDealt = await waitForFile(shot('client-dealt'));
  check('the client drew its table', clientDealt, 'no screenshot');
  if (clientDealt) {
    const t = table(shot('client-dealt'));
    // Both numbers, and this is the assertion the whole test exists for: the
    // other player is looking at a green table with thirteen cards of its own
    // on it, and the only place those can have come from is the dealer.
    check(`the client was dealt a hand too (${(t.green * 100).toFixed(0)}% baize, ` +
      `${(t.white * 100).toFixed(0)}% cards)`,
      t.green > 0.4 && t.white > 0.1, JSON.stringify(t));
  }

  // Both transcripts are kept whatever happens: with two processes and a wire
  // between them, "which side did not do its part" is the whole question and a
  // tail of one of them cannot answer it. The timings are what tell a lifetime
  // problem from a wire problem -- a frame delivered to a process whose loop
  // has already ended looks exactly like a frame that never crossed.
  const when = s => Object.entries(s.at).map(([k, v]) => `${k}@${v}ms`).join(' ') || 'nothing';
  console.log(`\ndealer: ${when(dealer)}${dealer.exited ? ' EXITED' : ' still running'}`);
  console.log(`client: ${when(client)}${client.exited ? ' EXITED' : ' still running'}`);
  for (const s of [dealer, client]) {
    console.log(`\n${s.label} wire:`);
    for (const line of s.net) console.log(`  ${line}`);
  }
  console.log(`Transcripts and screenshots: ${OUT}`);

  for (const s of [dealer, client]) { try { s.child.kill(); } catch (_) {} }
  await sleep(300);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
