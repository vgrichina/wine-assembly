#!/usr/bin/env node
// TetriNET over the virtual LAN: two copies of the same executable, each in
// its own OS process, joined by the vln/1 frame wire.
//
// test-vlan-match.js does this with Liquid War, which ships a separate server
// binary. TetriNET is one exe that is both ends, so this drives the same
// TETRINET.EXE down two different paths through its own UI -- toolbar to the
// server screen and Start Server on one side, toolbar to the connect screen
// and Connect on the other -- and nothing about the connection is staged on
// either side.
//
// The server refuses to start without a nickname: its handler reads that edit
// first and returns early when it is empty, so the three keystrokes below are
// not decoration. Same on the client.
//
// The binary is a gitignored corpus fixture, so this reports SKIP when it has
// not been fetched.

'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { ProcessHub } = require('../lib/vlan-wire');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'candidates', 'tetrinet', 'TETRINET.EXE');
const HOST_IP = '10.77.0.1';
const PEER_IP = '10.77.0.2';
const SERVER_PNG = process.env.VLAN_SERVER_PNG || '';
const CLIENT_PNG = process.env.VLAN_CLIENT_PNG || '';

let failures = 0;
function check(what, ok = true) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

if (!fs.existsSync(EXE)) {
  console.log('test-vlan-tetrinet: SKIP (fetch with '
    + 'node tools/fetch-candidate-corpus.js --id=tetrinet)');
  process.exit(0);
}

const typed = (batch, text, step = 50) =>
  [...text].map((ch, i) => `${batch + i * step}:keypress:${ch.charCodeAt(0)}`);

// Screen coordinates come from the control tree, not from reading pixels:
// `--input=N:dump-windows:label` prints every window with its class, title and
// client rect, which is how the "Start Server" button and the nickname edit
// below were located.
const SERVER_INPUT = [
  '1200:click:319:284',            // dismiss the first-run dialog
  '1700:click:520:455',            // toolbar: the server screen
  '2100:click:253:62',             // the nickname edit
  ...typed(2200, 'bob'),
  '2600:click:407:408',            // Start Server
  '5300000:click:139:455',         // toolbar: Partyline
  '5300050:dump-windows:server-partyline',
  '5300100:click:529:417',         // Start New Game
  ...(SERVER_PNG ? [`5300800:png-pixels:${SERVER_PNG}`] : []),
].join(',');

const CLIENT_INPUT = [
  '1200:click:319:284',            // dismiss the first-run dialog
  '1500:click:57:455',             // initialize the lazy playing-fields form
  '1550:click:606:15',             // close it before editing connection data
  '1600:click:450:455',            // toolbar: Client Settings
  '1750:click:455:186',            // the server address field
  ...typed(1800, HOST_IP, 10),
  '1900:click:455:213',            // the nickname field
  ...typed(1920, 'ann', 10),
  '2000:click:437:279',            // Connect
  '4300:click:139:455',            // toolbar: Partyline
  '4400:dump-windows:partyline',
].join(',');

// A run of this length emits far too much to hold in memory, so the full log
// goes to a file and only a short rolling window is kept. Patterns are
// registered before the child starts and tested as the output streams past,
// because by the time anyone waits on one the line may already have scrolled.
const WINDOW_BYTES = 64 * 1024;

function spawn(name, args, logEnvVar, watch) {
  const child = fork(path.join(ROOT, 'test', 'run.js'), args,
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const logPath = process.env[logEnvVar];
  const fd = logPath ? fs.openSync(logPath, 'w') : null;
  const state = {
    name, child, window: '', exited: false, hits: new Set(),
    watch: Object.values(watch),
    tail: () => state.window.split('\n').slice(-25).join('\n'),
  };
  const collect = d => {
    if (fd !== null) fs.writeSync(fd, d);
    state.window = (state.window + d.toString()).slice(-WINDOW_BYTES);
    for (const re of state.watch) {
      if (!state.hits.has(re) && re.test(state.window)) state.hits.add(re);
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => { state.exited = true; });
  return state;
}

const NET_TRACE = process.env.VLAN_TRACE_NET ? ['--trace-net'] : [];
const extra = v => (v ? v.split(' ').filter(Boolean) : []);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(state, pattern, what, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.hits.has(pattern)) return true;
    if (state.exited) throw new Error(`${state.name} exited before ${what}\n${state.tail()}`);
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} on ${state.name}\n${state.tail()}`);
}

const SERVER_SIGNS = {
  listen: /listen\(s=0x[0-9a-f]+, backlog=/,
  accept: /accept\(/,
  recv: /recv\(/,
  send: /send\(/,
  start: /send\(s=0x[0-9a-f]+, buf=0x[0-9a-f]+, len=229, flags=0\)/,
  png: /\[input\] png-pixels .* at batch /,
};
const CLIENT_SIGNS = {
  connect: /connect\(s=/,
  recv: /recv\(/,
  start: /send\(s=0x[0-9a-f]+, buf=0x[0-9a-f]+, len=5, flags=0\)/,
  fields: /\[input\] click 40,455 at batch /,
  gameplay: /\[input\] window:client-gameplay .*visible=true.*title="TetriNET Playing Fields"/,
  repaint: /\[ctl\] \{"ok":true,"id":"gameplay-repaint"/,
  png: /\[input\] png-pixels .* at batch /,
};

const COMMON = [
  '--vlan-wire',
  '--quiet-api',
  '--quiet-blocks',
  '--batch-size=25000',
  '--repaint-every=1000',
  // Both ends spend most of their life idle in their message pump waiting on
  // the other, which is exactly what the default stuck-run guard is built to
  // stop. Here it is the expected shape of a working session.
  '--vlan-max-waits=100000000',
  '--stuck-after=10000000',
  '--max-batches=100000000',
  ...NET_TRACE,
];

async function main() {
  const server = spawn('server', [
    `--exe=${EXE}`, `--vlan-ip=${HOST_IP}`, `--input=${SERVER_INPUT}`,
    '--max-seconds=300',
    '--trace-api=socket,bind,listen,accept,recv,send,closesocket',
    ...COMMON, ...extra(process.env.VLAN_SERVER_ARGS),
  ], 'VLAN_SERVER_LOG', SERVER_SIGNS);

  const hub = new ProcessHub();
  hub.add(server.child);

  let client = null;
  try {
    // The client is held back until the listener exists. Both ends drive their
    // own UI at their own speed, so starting them together would make the
    // connect land before the accept could answer it -- a race that would look
    // like a wire fault rather than a scheduling accident.
    await waitFor(server, SERVER_SIGNS.listen, 'the server to listen');
    check('TETRINET.EXE listens on the room address');

    client = spawn('client', [
      `--exe=${EXE}`, `--vlan-ip=${PEER_IP}`, `--input=${CLIENT_INPUT}`,
      '--max-seconds=300',
      '--control-stdin',
      '--trace-api=socket,connect,send,recv,closesocket',
      ...COMMON, ...extra(process.env.VLAN_CLIENT_ARGS),
    ], 'VLAN_CLIENT_LOG', CLIENT_SIGNS);
    hub.add(client.child);

    await waitFor(client, CLIENT_SIGNS.connect, 'the client to connect');
    check('the client drives its own UI to a connect');

    await waitFor(server, SERVER_SIGNS.accept, 'the server to accept');
    check('the server accepts the client across the wire');

    await waitFor(server, SERVER_SIGNS.recv, 'the server to read the client');
    check('the server reads the client protocol stream');

    // Bytes crossing the wire once only proves the transport. The session is
    // real when the server acts on what it read and the client hears the
    // answer: TetriNET's server replies to a login with the player number it
    // assigned, then the team and player-join lines that put that player in
    // the room.
    await waitFor(server, SERVER_SIGNS.send, 'the server to answer the login');
    check('the server answers the login it just read');

    await waitFor(client, CLIENT_SIGNS.recv, 'the client to read the answer');
    check('the client reads the answer, closing the round trip');

    await waitFor(server, SERVER_SIGNS.start, 'the server to start a game');
    check('the server emits the TetriNET start-game packet');

    // The two guests run at very different batch rates. A fixed client batch
    // here used to capture its connect screen millions of server batches
    // before the game began. The client answers the start payload with a
    // five-byte protocol acknowledgement after constructing its game view,
    // so use that causal marker and ask the running CLI for a screenshot.
    await waitFor(client, CLIENT_SIGNS.start, 'the client to process the start-game packet');
    check('the client processes the start-game packet');

    client.child.stdin.write('click:40:455\n');
    await waitFor(client, CLIENT_SIGNS.fields, 'the client to raise its playing fields');
    client.child.stdin.write('dump-windows:client-gameplay\n');
    await waitFor(client, CLIENT_SIGNS.gameplay, 'the visible playing-fields window');
    check('the client opens the populated playing-fields window');

    if (CLIENT_PNG) {
      client.child.stdin.write(JSON.stringify({
        id: 'gameplay-repaint', action: 'eval', code: 'renderer.repaint()',
      }) + '\n');
      await waitFor(client, CLIENT_SIGNS.repaint, 'the remote gameplay repaint');
      client.child.stdin.write(`png-pixels:${CLIENT_PNG}\n`);
      await waitFor(client, CLIENT_SIGNS.png, 'the client session screenshot', 120000);
      check('the client gameplay screenshot is captured after game start');
    }
    if (SERVER_PNG) {
      await waitFor(server, SERVER_SIGNS.png, 'the server session screenshot', 120000);
      check('the server session screenshot is captured');
    }
  } finally {
    for (const s of [server, client]) if (s && !s.exited) s.child.kill('SIGTERM');
  }

  console.log(failures
    ? `test-vlan-tetrinet: ${failures} FAILED`
    : 'test-vlan-tetrinet: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
