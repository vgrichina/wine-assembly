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
].join(',');

const CLIENT_INPUT = [
  '1200:click:319:284',            // dismiss the first-run dialog
  '1600:click:57:455',             // toolbar: the connect screen
  '1750:click:455:186',            // the server address field
  ...typed(1800, HOST_IP, 10),
  '1900:click:455:213',            // the nickname field
  ...typed(1920, 'ann', 10),
  '2000:click:437:279',            // Connect
].join(',');

// A run of this length emits far too much to hold in memory, so the full log
// goes to a file and only a short rolling window is kept. Patterns are
// registered before the child starts and tested as the output streams past,
// because by the time anyone waits on one the line may already have scrolled.
const WINDOW_BYTES = 64 * 1024;

function spawn(name, args, logEnvVar, watch) {
  const child = fork(path.join(ROOT, 'test', 'run.js'), args,
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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

async function waitFor(state, pattern, what, timeoutMs = 600000) {
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
};
const CLIENT_SIGNS = {
  connect: /connect\(s=/,
  recv: /recv\(/,
};

const COMMON = [
  '--vlan-wire',
  '--quiet-api',
  '--batch-size=25000',
  // Both ends spend most of their life idle in their message pump waiting on
  // the other, which is exactly what the default stuck-run guard is built to
  // stop. Here it is the expected shape of a working session.
  '--vlan-max-waits=100000000',
  '--max-batches=200000',
  ...NET_TRACE,
];

async function main() {
  const server = spawn('server', [
    `--exe=${EXE}`, `--vlan-ip=${HOST_IP}`, `--input=${SERVER_INPUT}`,
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
  } finally {
    for (const s of [server, client]) if (s && !s.exited) s.child.kill('SIGKILL');
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
