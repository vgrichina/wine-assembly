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

// Three cards in the hand along the bottom of the table, and the button in the
// middle that passes them. A dealt hand is thirteen cards about twenty pixels
// apart starting near x=170; any three will do, and the leftmost three are the
// ones furthest from the overlapping fan.
const CARDS = ['250:380', '320:380', '390:380'];
const PASS_BUTTON = '320:298';
// Hearts opens with the two of clubs and refuses anything else -- "You must
// lead the two of clubs" -- and the hand is sorted, so it is the leftmost card.
const LOWEST_CARD = '200:380';

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
  // Play it. Passing three cards is the first move of a hand and the first
  // thing either player does that is not a dialog: it selects, it redraws the
  // table under the cards it lifts, and it renames the button to OK -- which
  // is why it found both a crash (SetFocus on that button could not return
  // across the 16-bit bridge) and a paint bug (the baize went white the first
  // time anything invalidated the window).
  // Held until the harness has both hands on screen. Passing is timed like
  // everything else here -- from the other side's progress, never from a batch
  // count -- because the two processes do not share a clock.
  `${DEAL_AT + 61000}:wait-go`,
  ...CARDS.map((c, i) => `${DEAL_AT + 62000 + i * 2000}:click:${c}`),
  `${DEAL_AT + 70000}:click:${PASS_BUTTON}`,
  // And held again until the client's pass has actually arrived here. The
  // first version of this photographed the table before the other player had
  // even clicked, and read the dealer's perfectly correct "Waiting for other
  // players to pass" as a lost pass.
  `${DEAL_AT + 71000}:wait-go`,
  // Again, now that the exchange has settled. Hearts greys "Pass Left" while
  // it is taking the other player's cards, and a click that lands in that
  // window is simply lost -- the three cards stay selected and the game sits
  // there looking like it refused the move.
  // The same button becomes "OK" when the other players' cards arrive, so a
  // few spaced clicks carry the seat through pass -> accept without the test
  // having to know which of the two it is looking at.
  `${DEAL_AT + 73000}:click:${PASS_BUTTON}`,
  `${DEAL_AT + 78000}:click:${PASS_BUTTON}`,
  `${DEAL_AT + 83000}:click:${PASS_BUTTON}`,
  `${DEAL_AT + 88000}:png:${shot('dealer-passed')}`,
  // And the trick. The dealer plays nothing here -- the lead is the other
  // player's -- so this only has to be looking at the table when the card
  // arrives.
  `${DEAL_AT + 89000}:wait-go`,
  `${DEAL_AT + 90000}:click:${PASS_BUTTON}`,
  `${DEAL_AT + 100000}:png:${shot('dealer-trick')}`,
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
  '85500:wait-go',
  ...CARDS.map((c, i) => `${87000 + i * 2000}:click:${c}`),
  `95000:click:${PASS_BUTTON}`,
  '96000:wait-go',
  `97000:click:${PASS_BUTTON}`,
  `102000:click:${PASS_BUTTON}`,
  `107000:click:${PASS_BUTTON}`,
  `112000:png:${shot('client-passed')}`,
  // Hearts opens with the two of clubs, and whoever holds it leads -- so this
  // is the leftmost card in the hand, and the one the game will accept.
  '113000:wait-go',
  // The three cards passed to you have to be accepted before the hand starts,
  // and the button that passed is the button that accepts.
  `114000:click:${PASS_BUTTON}`,
  `119000:click:${LOWEST_CARD}`,
  `130000:png:${shot('client-trick')}`,
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
                  lastNet: 0, net: [], pokes: 0 };
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
        // Counted, not flagged: a poke is how a player's move reaches the
        // other side, and seating the joining player is one too -- so "a poke
        // arrived" is true long before anybody plays a card. What the pass
        // step waits on is one MORE than it had.
        if (line.includes('.. arrived type6')) state.pokes++;
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

// Release one side's next held step. A game that has already ended is not a
// reason to end the run with an IPC error on top of whatever really happened,
// so a closed channel is reported and stepped over.
function go(state) {
  if (state.exited || !state.child.connected) {
    console.log(`  [go] ${state.label} has already exited`);
    return false;
  }
  state.child.send({ t: 'go' });
  return true;
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
function table(file, x0 = 60, y0 = 30, x1 = 580, y1 = 440) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let green = 0, white = 0, total = 0;
  for (let y = y0; y < y1 && y < png.height; y++) {
    for (let x = x0; x < x1 && x < png.width; x++) {
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
    // Hearts renames its "Pass Left" button to "OK" once three cards are on
    // their way, so this line is the move having been made -- and it is a
    // better witness than the screen, which cannot distinguish three cards
    // passed from three cards merely selected.
    passed: /\[SetWindowText\] "OK"/,
    crashed: /\*\*\* CRASH/,
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
    passed: /\[SetWindowText\] "OK"/,
    crashed: /\*\*\* CRASH/,
  });
  hub.add(client.child);

  // The dealer's own screenshot is the signal that it has left its dialog and
  // is sitting at a table waiting for players. Only then is the client let
  // through the last step of its own.
  const seated = await waitForFile(shot('dealer-waiting'));
  check('the dealer reached its table', seated, 'no screenshot was written');
  go(client);

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
  go(dealer);
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
  go(client);
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

  // 6: the first move of the hand, on both sides. Everything above is still
  // only setting the table -- this is the two applications playing.
  //
  // Both are released together: in Hearts everyone passes at once, and the
  // button is only live while three cards are up, so a side held back until
  // the other had finished would be clicking a greyed button.
  const pokesBefore = dealer.pokes;
  go(client);
  await sleep(8000);
  go(dealer);

  // The move crossing the room, in one line: the client's three cards leave as
  // a DDE poke and this is the dealer receiving it. Waiting for this rather
  // than for a batch count is the whole difference between a test that reads
  // "the pass never arrived" and one that had simply photographed the table
  // before the other player clicked.
  const crossed = await (async () => {
    const limit = Math.min(Date.now() + MILESTONE_MS, DEADLINE);
    while (Date.now() < limit) {
      if (dealer.pokes > pokesBefore) return true;
      if (dealer.exited || client.exited) return dealer.pokes > pokesBefore;
      await sleep(200);
    }
    return false;
  })();
  check('the client\'s pass reached the dealer', crossed,
    'no poke arrived after the cards were selected');

  // Let both sides settle the exchange before photographing them: the poke is
  // answered with an ack and the advise loops that redraw both tables.
  await quiet(dealer, 2000);
  go(dealer);
  go(client);
  const passedShots = await Promise.all([
    waitForFile(shot('dealer-passed')), waitForFile(shot('client-passed')),
  ]);
  for (const [side, name, drawn] of [
    [dealer, 'dealer', passedShots[0]], [client, 'client', passedShots[1]]]) {
    check(`the ${name} survived passing three cards`, !side.seen.has('crashed'),
      'it trapped -- see the transcript');
    if (!drawn) { check(`the ${name} drew its table after passing`, false, 'no screenshot'); continue; }
    const t = table(shot(`${name}-passed`));
    // The baize is the point of this one. Passing invalidates the window, and
    // an invalidation used to hand the background to BeginPaint's class brush
    // -- WHITE_BRUSH, for this app -- so the table turned white mid-game.
    check(`the ${name} still has a green table after passing ` +
      `(${(t.green * 100).toFixed(0)}% baize, ${(t.white * 100).toFixed(0)}% cards)`,
      t.green > 0.4 && t.white > 0.1, JSON.stringify(t));
  }
  // Hearts renames the button to "OK" when three cards arrive *for* you, so
  // this is the round of passes having come all the way round to a seat: your
  // three cards left, three others arrived, and the game is asking you to take
  // them. It is the furthest into a hand this test goes.
  check('the pass came round and cards were offered to a player',
    dealer.seen.has('passed') || client.seen.has('passed'),
    'neither side was ever offered cards to accept');

  // 7: a card. Passing is still setup of a kind -- this is the hand being
  // played, one seat leading and the other watching it happen from the other
  // side of the wire.
  const pokesBeforePlay = dealer.pokes;
  go(client);
  const played = await (async () => {
    const limit = Math.min(Date.now() + MILESTONE_MS, DEADLINE);
    while (Date.now() < limit) {
      if (dealer.pokes > pokesBeforePlay) return true;
      if (dealer.exited || client.exited) return dealer.pokes > pokesBeforePlay;
      await sleep(200);
    }
    return false;
  })();
  check('the played card reached the dealer', played, 'no poke followed the click');
  await quiet(dealer, 2000);
  go(dealer);
  const trickShots = await Promise.all([
    waitForFile(shot('dealer-trick')), waitForFile(shot('client-trick')),
  ]);
  for (const [name, drawn] of [['dealer', trickShots[0]], ['client', trickShots[1]]]) {
    if (!drawn) { check(`the ${name} drew the trick`, false, 'no screenshot'); continue; }
    // The middle of the table is empty baize until somebody leads; a card
    // there is the trick in progress, and it is the same card on both screens.
    const t = table(shot(`${name}-trick`), 250, 150, 400, 300);
    check(`the ${name} has a card on the table (${(t.white * 100).toFixed(0)}% of the middle)`,
      t.white > 0.05, JSON.stringify(t));
  }
  // Not a failure, and not hidden either. The dealer's own seat does not
  // finish the round: it receives the client's "Pass" poke, reads it with
  // DdeGetData, posts an advise and acknowledges with DDE_FACK -- and its
  // status bar still reads "Waiting for other players to pass" while the
  // client has moved on to play. Run with --linger=30 and look at the two
  // final screenshots to see it. The next thing to look at is
  // DdeClientTransaction's TIMEOUT_ASYNC: Hearts asks for asynchronous
  // transactions and this DDEML does them synchronously and never sends the
  // XTYP_XACT_COMPLETE that ends one.
  if (!dealer.seen.has('passed')) {
    console.log('KNOWN GAP  the dealer\'s seat did not finish the passing round');
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

  // --linger=SECONDS keeps both games alive after the checks, which is how to
  // watch what a seat does with more time than the test gives it.
  const linger = arg('linger', 0) * 1000;
  if (linger) { console.log(`lingering ${linger}ms`); await sleep(linger); }
  for (const s of [dealer, client]) { try { s.child.kill(); } catch (_) {} }
  await sleep(300);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
