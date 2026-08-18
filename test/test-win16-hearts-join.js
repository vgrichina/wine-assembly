#!/usr/bin/env node

// Two real copies of Hearts, in two operating-system processes, one room.
//
//   node test/test-win16-hearts-join.js
//
// test-win16-dde-room.js proves the conversation layer with two instances
// driven directly. This drives the actual MSHEARTS.EXE on both ends, through
// its own dialogs, and asks the only question that matters: does the client's
// DdeConnect come back with a conversation instead of "Unable to connect with
// dealer. Hearts will end."
//
// The answer depends on the NetDDE share database, which is the part that is
// easy to get wrong by assuming. The two sides never name the same thing:
//
//   dealer registers   service "MSHearts"       topic "Hearts"
//   client asks for    service "\\NAME\NDDE$"   topic "Hearts$"
//
// The client is not naming the dealer's application at all. It is connecting
// to the NetDDE *agent* on the machine it was given and passing a DDE *share*
// as the topic; the trailing `$` is the share marker. The machine resolves the
// share to the application that serves it. On a real Win98 box that entry is
// written at install time and belongs to the machine — Hearts never creates
// it, importing no NDDEAPI entry point and only loading it for NDdeGetWindow.
//
// STATUS: this does not pass yet, and it is deliberately NOT in run-all.sh.
// It is a diagnostic harness for the last gap, and it reports enough to say
// exactly where that gap is. What it has established, on a quiet box:
//
//   client sent@552139ms   dealer heardFrame@552171ms   client gaveUp@552644ms
//
// The request crosses in 32 milliseconds. The client then waits half a second
// and gives up before the answer comes back. So the wire, the framing, the
// share resolution and the park are all doing their jobs, and what is left is
// that the waiting side's patience is counted in passes rather than in time —
// each pass is only an event-loop turn, so the whole budget can burn while the
// peer that has to answer has not been scheduled. See $DDE_CONNECT_TRIES.
//
// Do not read a failure here as a protocol fault without checking `uptime`
// first: at load 88 the dealer needed 344 seconds merely to register, and
// nothing about the emulator is being measured at that point.
//
// What it does NOT assert even once it passes, because it is not built: that a
// hand is dealt across the wire. DdeClientTransaction still fails, truthfully,
// with DMLERR_NOTPROCESSED, because the data a transaction asks for lives in
// the server application and reaching it needs the XTYP_CONNECT/XTYP_REQUEST
// callback.

'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { ProcessHub } = require('../lib/vlan-wire');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const RUN = path.join(ROOT, 'test', 'run.js');
const DEALER_IP = '10.77.0.1';
const CLIENT_IP = '10.77.0.2';
// Per-milestone wait, and a hard ceiling on the whole test. Two real emulator
// processes driving a real binary have no natural bound, and on a loaded box a
// run that is simply never going to succeed will otherwise sit there for as
// long as anyone lets it. Both are overridable for a slow machine:
//   node test/test-win16-hearts-join.js --timeout=600
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const TIMEOUT_MS = arg('milestone-timeout', 120) * 1000;
const BUDGET_MS = arg('timeout', 300) * 1000;
const DEADLINE = Date.now() + BUDGET_MS;

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

// Points on the startup dialog, and on the "Locate dealer" dialog behind the
// client's radio button. Same coordinates the single-process Hearts tests use.
const NAME_FIELD = '200:122';
const DEALER_RADIO = '55:210';       // "I want to be dealer"
const CONNECT_RADIO = '55:190';      // "I want to connect to another game"
const OK_BUTTON = '319:92';
const LOCATE_FIELD = '80:132';
const LOCATE_OK = '284:90';

// The dealer answers its dialog, becomes dealer, and deals — which is the
// point at which it has called DdeNameService and is listening.
const DEALER_INPUT = [
  `3000:click:${NAME_FIELD}`, '3500:keypress:68',
  `4500:click:${DEALER_RADIO}`, `6000:click:${OK_BUTTON}`,
  '30000:post-cmd:102',
].join(',');

// The client answers its dialog, picks "connect", and types a machine name.
// Any name will do: the share is what is resolved, not the machine.
const CLIENT_INPUT = [
  `3000:click:${NAME_FIELD}`, '3500:keypress:67',
  `4500:click:${CONNECT_RADIO}`, `6000:click:${OK_BUTTON}`,
  `14000:click:${LOCATE_FIELD}`,
  '15000:keypress:68', '15500:keypress:69', '16000:keypress:65', '16500:keypress:76',
  `18000:click:${LOCATE_OK}`,
].join(',');

// Patterns are matched as the output streams past, and only a bounded tail is
// kept. The dealer has to stay alive far longer than the client — it is the
// one being connected to — and at half a million traced batches its transcript
// is hundreds of megabytes, which is not something to hold in a string.
const KEEP_TAIL = 1 << 20;
const T0 = Date.now();

function spawn(label, ip, input, batches, patterns) {
  const child = fork(RUN, [
    `--exe=${EXE}`, `--max-batches=${batches}`, `--input=${input}`,
    // --trace-net is not optional here. Both failure modes this test can hit
    // -- the request never left, and it arrived after the other side had
    // stopped listening -- are invisible from the API trace alone.
    `--vlan-ip=${ip}`, '--vlan-wire', '--trace-win16', '--trace-net',
    // A parked DdeConnect spends its wait in net_wait yields, and run.js stops
    // a run that makes too many in a row. The default assumes a socket that
    // answers promptly; waiting for another emulator to notice takes more.
    '--vlan-max-waits=200000',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = { out: '', exited: false, label, seen: new Set(), carry: '', at: {} };
  const feed = (chunk) => {
    const text = state.carry + chunk;
    for (const [name, re] of Object.entries(patterns || {})) {
      if (!state.seen.has(name) && re.test(text)) {
        state.seen.add(name);
        state.at[name] = Date.now() - T0;
      }
    }
    // Keep enough of the boundary that a pattern spanning two chunks still
    // matches; a run-together of two trace lines is well under this.
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
  const deadline = Math.min(Date.now() + TIMEOUT_MS, DEADLINE);
  while (Date.now() < deadline) {
    if (state.seen.has(name)) return true;
    if (state.exited) return state.seen.has(name);
    await sleep(100);
  }
  return false;
}

(async () => {
  const hub = new ProcessHub();
  // The dealer goes first and is given a head start, so it has registered its
  // service before the client asks for it. A client that arrives first would
  // simply time out, which is the correct behaviour and not what is under
  // test here.
  // The dealer must outlive the client's whole attempt: it is the side being
  // connected to, and a dealer that has already run out of batches is simply
  // not in the room. Getting this wrong looks exactly like a broken wire --
  // the client's frame was delivered to a process whose loop had ended, and
  // arrived after its own "Stats:" line.
  const dealer = spawn('dealer', DEALER_IP, DEALER_INPUT, 600000, {
    registered: /DDEML\.27 DDENAMESERVICE/,
    // Whether the request ever reached the dealer at all, and when. Without
    // this the two failure modes -- "the frame never crossed" and "it crossed
    // after the client had given up" -- look identical from the client side.
    heardFrame: /\[net\] \.\. arrived/,
  });
  hub.add(dealer.child);

  const registered = await waitFor(dealer, 'registered');
  check('the dealer registered its DDE service', registered, dealer.tail());

  const client = spawn('client', CLIENT_IP, CLIENT_INPUT, 90000, {
    asked: /DDEML\.7 DDECONNECT/,
    // Did the request ever leave this process, and did anything come back?
    // These separate "nobody answered", "nothing was asked", and "the answer
    // arrived after we had stopped waiting" -- which look identical otherwise.
    sent: /\[net\] ->/,
    heardFrame: /\[net\] \.\. arrived/,
    // The return line is the NEXT line, and it has to be pinned to that:
    // `[\s\S]*?` between the two matched some later unrelated API's return
    // and reported a connection that never happened. A conversation handle
    // is non-zero in AX; the failure this replaces returned zero.
    answered: /DDEML\.7 DDECONNECT[^\n]*\n\[win16\] +-> AX=0x0000000[1-9]/,
    gaveUp: /Unable to connect with dealer/,
  });
  hub.add(client.child);

  check('the client asked the room for a conversation',
    await waitFor(client, 'asked'), client.tail());
  check('the client\'s DdeConnect was answered with a conversation',
    await waitFor(client, 'answered'), client.tail());
  check('the client did not give up on finding a dealer',
    !client.seen.has('gaveUp'), 'the connect failed and Hearts ended');

  // Both transcripts are kept whatever happens: with two processes and a wire
  // between them, "which side did not do its part" is the whole question, and
  // a tail of one of them cannot answer it.
  // Both sides have to be in the room AT THE SAME TIME, and every failure so
  // far has been a lifetime problem rather than a wire problem: a frame
  // delivered to a process whose loop had already ended looks exactly like a
  // frame that never crossed. These are the numbers that tell them apart.
  const when = s => Object.entries(s.at).map(([k, v]) => `${k}@${v}ms`).join(' ') || 'nothing';
  console.log(`\ndealer: ${when(dealer)}${dealer.exited ? ' EXITED' : ' still running'}`);
  console.log(`client: ${when(client)}${client.exited ? ' EXITED' : ' still running'}`);

  const out = path.join(ROOT, 'test', 'output', 'win16-hearts-join');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'dealer.log'), dealer.out);
  fs.writeFileSync(path.join(out, 'client.log'), client.out);
  console.log(`Transcripts: ${out}`);

  for (const s of [dealer, client]) { try { s.child.kill(); } catch (_) {} }
  await sleep(200);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
