#!/usr/bin/env node
// Liquid War over the virtual LAN: the real client and the real server, each
// in its own OS process, joined by the vln/1 frame wire.
//
// test-vlan-loopback.js proves the wire with a synthetic peer. This drives the
// original lwwin.exe through its own menus with keystrokes — Net game, then
// the server address field, then Start game — so nothing about the connection
// is staged on the client side either.
//
// The client needs roughly 400k batches to reach its menu; every keystroke
// batch below is offset from that.

'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { ProcessHub } = require('../lib/vlan-wire');

const ROOT = path.join(__dirname, '..');
const LW = path.join(ROOT, 'test', 'binaries', 'candidates', 'liquid-war', 'LW5');
const CLIENT_EXE = path.join(LW, 'lwwin.exe');
const SERVER_EXE = path.join(LW, 'lwwinsrv.exe');
const HOST_IP = '10.77.0.1';
const PEER_IP = '10.77.0.2';

let failures = 0;
function check(what, ok = true) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

if (!fs.existsSync(CLIENT_EXE) || !fs.existsSync(SERVER_EXE)) {
  console.log(`test-vlan-match: SKIP (Liquid War not present at ${LW})`);
  process.exit(0);
}

// The menu keystrokes. VK codes; each key is held for 300 batches so the
// guest's DirectInput poll sees both edges.
const MENU_ENTER_NET = 400000;   // main menu: Down to "Net game", then Enter
const FIELD_FOCUS = 420000;      // net screen: Down to the "Server addr" field
const TYPE_START = 425000;       // clear 127.0.0.1, type the room address
const START_GAME = 436000;       // Up back to "Start game", then Enter

function keystrokes() {
  const events = [];
  const tap = (batch, vk, hold = 300) => {
    events.push(`${batch}:keydown:${vk}`, `${batch + hold}:keyup:${vk}`);
  };
  tap(MENU_ENTER_NET, 40);          // Down -> Net game
  tap(MENU_ENTER_NET + 10000, 13);  // Enter
  tap(FIELD_FOCUS, 40);             // Down -> Server addr field
  let batch = TYPE_START;
  for (let i = 0; i < 9; i++) { tap(batch, 8, 200); batch += 600; }  // erase 127.0.0.1
  // 10.77.0.1 — digits are their own VK, '.' is VK_OEM_PERIOD.
  for (const vk of [0x31, 0x30, 0xBE, 0x37, 0x37, 0xBE, 0x30, 0xBE, 0x31]) {
    tap(batch, vk, 200);
    batch += 600;
  }
  tap(START_GAME, 38, 200);         // Up -> Start game
  tap(START_GAME + 2000, 13, 200);  // Enter
  return events.join(',');
}

// A traced run of this length emits millions of lines, so nothing may hold the
// whole stream in memory — an earlier version accumulated it in a string and
// the client died of heap exhaustion before the match started. Two rules keep
// this bounded: the full log goes straight to a file, and the only thing kept
// in memory is a short rolling window.
const WINDOW_BYTES = 64 * 1024;

// Because the window scrolls, a pattern cannot be searched for after the fact:
// the line may already be gone. Every pattern is therefore registered before
// the child starts and tested as the output streams past, so a match is
// recorded whether or not anyone is waiting on it yet.
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
    // Keep the window's tail as the new head so a pattern that straddles a
    // chunk boundary is still seen whole.
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

// Frame-level tracing is off by default because it is loud, but a failure here
// is almost always "the frame never left" or "it left addressed to nobody", so
// keep it one env var away on both ends at once.
const NET_TRACE = process.env.VLAN_TRACE_NET ? ['--trace-net'] : [];

// Extra flags for one end only. Most debugging here is asymmetric — the
// question is nearly always about one side's threads or yields — and the two
// children are otherwise fixed, so this saves editing the file to probe.
const extra = v => (v ? v.split(' ').filter(Boolean) : []);
const SERVER_ARGS = extra(process.env.VLAN_SERVER_ARGS);
const CLIENT_ARGS = extra(process.env.VLAN_CLIENT_ARGS);

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

// The evidence each end is expected to produce, in the order it should appear.
const SERVER_SIGNS = {
  listen: /listen\(s=0x[0-9a-f]+, backlog=/,
  accept: /accept\(/,
  recv: /recv\(/,
};

async function main() {
  const server = spawn('server', [
    `--exe=${SERVER_EXE}`,
    '--args=-private -2 -nobeep',
    '--vlan-wire',
    `--vlan-ip=${HOST_IP}`,
    '--trace-api=socket,bind,listen,accept,recv,send,closesocket',
    // The plain one-line [API] log is separate from --trace-api and is on by
    // default; over a multi-million-batch run it is the whole log. The typed
    // socket traces this gate reads survive --quiet-api.
    '--quiet-api',
    ...NET_TRACE,
    // The server is up before the client has even reached its own main menu,
    // so it sits in select() for the whole of the client's ~400k-batch boot.
    // The default stuck-run guard is far below that and would stop a server
    // that is doing exactly what a server should do.
    '--vlan-max-waits=100000000',
    '--max-batches=3000000',
    ...SERVER_ARGS,
  ], 'VLAN_SERVER_LOG', SERVER_SIGNS);

  const client = spawn('client', [
    `--exe=${CLIENT_EXE}`,
    '--vlan-wire',
    `--vlan-ip=${PEER_IP}`,
    `--input=${keystrokes()}`,
    '--trace-api=socket,bind,connect,send,recv,select,closesocket',
    '--quiet-api',
    ...NET_TRACE,
    '--vlan-max-waits=100000000',
    // Start game lands near batch 440k; the rest is the match itself.
    '--max-batches=3000000',
    ...CLIENT_ARGS,
  ], 'VLAN_CLIENT_LOG', {});

  // One broadcast segment. Each process keeps only what is addressed to it.
  const hub = new ProcessHub();
  hub.add(server.child);
  hub.add(client.child);

  try {
    await waitFor(server, SERVER_SIGNS.listen, 'the server to listen');
    check('lwwinsrv.exe listens on the room address');

    // The client opens its socket on a worker thread, whose API calls carry no
    // name for ordinal-only imports, so the client's own trace cannot name
    // them. The server's accept is the honest evidence that the client
    // connected — it is the far end of the same connection.
    await waitFor(server, SERVER_SIGNS.accept, 'the server to accept', 600000);
    check('lwwinsrv.exe accepts the client across the wire');

    await waitFor(server, SERVER_SIGNS.recv, 'the server to read the client', 600000);
    check('the server reads the client protocol stream');
  } finally {
    for (const s of [server, client]) if (!s.exited) s.child.kill('SIGKILL');
  }

  console.log(failures ? `test-vlan-match: ${failures} FAILED` : 'test-vlan-match: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
