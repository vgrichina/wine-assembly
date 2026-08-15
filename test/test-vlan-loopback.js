#!/usr/bin/env node

// Slice 2 gate: two operating-system processes, one room.
//
// The original Liquid War server binary runs in its own emulator process at
// 10.77.0.1 and never learns that it is not on a real network. A second
// process at 10.77.0.2 opens a TCP connection to it over the frame wire.
// The connection has to be accepted by the *guest's* own accept() call, not
// merely completed inside the switch, which is why this test reads the
// server's API trace rather than only its own return codes.
//
// What this does not yet cover is the game itself: driving lwwin.exe through
// its Net game menu is the remaining half of the Slice 2 exit gate.

'use strict';

const assert = require('assert');
const path = require('path');
const { fork } = require('child_process');
const { ProcessWire } = require('../lib/vlan-wire');
const { compile, makeNode, AF_INET, SOCK_STREAM, INVALID_SOCKET } = require('./vlan-node');

const SERVER_EXE = 'test/binaries/candidates/liquid-war/LW5/lwwinsrv.exe';
const HOST_IP = '10.77.0.1';
const PEER_IP = '10.77.0.2';
const GAME_PORT = 8035;
const TIMEOUT_MS = 120000;

let passed = 0;
function check(name) { passed++; console.log(`PASS  ${name}`); }

const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait for the child's own trace to show something, so the assertion is
// about what the guest did rather than about what we hoped it did.
function waitFor(state, pattern, what) {
  const deadline = Date.now() + TIMEOUT_MS;
  return (async () => {
    while (Date.now() < deadline) {
      if (pattern.test(state.out)) return true;
      if (state.exited) throw new Error(`server exited before ${what}\n${state.tail()}`);
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}\n${state.tail()}`);
  })();
}

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compile();

  const child = fork(path.join(root, 'test', 'run.js'), [
    `--exe=${SERVER_EXE}`,
    '--args=-private -6 -nobeep',
    '--vlan-wire',
    `--vlan-ip=${HOST_IP}`,
    '--trace-api=socket,bind,listen,accept,recv,send,closesocket',
    '--max-batches=200000',
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });

  // VLAN_LOG=path keeps the server's whole trace, which is where a failure
  // on the guest's side of the wire is actually explained.
  const logFd = process.env.VLAN_LOG
    ? require('fs').openSync(process.env.VLAN_LOG, 'w') : null;
  const state = { out: '', exited: false, tail: () => state.out.split('\n').slice(-25).join('\n') };
  const collect = d => {
    if (logFd !== null) require('fs').writeSync(logFd, d);
    state.out += d.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('exit', () => { state.exited = true; });

  const wire = new ProcessWire(child);
  const peer = await makeNode(wasm, wire, PEER_IP);

  try {
    await waitFor(state, /listen\(s=0x[0-9a-f]+, backlog=/, 'the server to listen');
    check('the server binary reaches listen() in its own process');

    const cli = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.notStrictEqual(cli, INVALID_SOCKET);
    peer.nonblocking(cli);

    const target = peer.sockaddr(HOST_IP, GAME_PORT);
    let connected = false;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const r = peer.wat.test_call_connect(cli, target, 16) | 0;
      if (r === 0) { connected = true; break; }
      const err = peer.err();
      assert(err === 10035 || err === 10037,
        `connect must be in progress, got WSA error ${err}\n${state.tail()}`);
      await tick();
      await sleep(10);
      peer.pump();
    }
    assert(connected, `connect never completed\n${state.tail()}`);
    check('a connection opens from another process to 10.77.0.1:8035');

    await waitFor(state, /accept\(s=0x[0-9a-f]+/, "the server's own accept() call");
    check('the server guest accepts the connection with accept()');

    // The server should now be reading from the new socket. Send it
    // something so its recv path runs against real wire bytes.
    const hello = Array.from(Buffer.from('\x00\x00\x00\x00wine-assembly\n'));
    const sent = peer.wat.test_call_send(cli, peer.buf(hello), hello.length, 0) | 0;
    assert.strictEqual(sent, hello.length);
    await waitFor(state, /recv\(s=0x[0-9a-f]+/, "the server's recv() on the accepted socket");
    check('bytes written by the peer process reach the server guest');

    peer.wat.test_call_closesocket(cli);
    for (let i = 0; i < 20; i++) { await tick(); await sleep(10); peer.pump(); }
    check('the peer closes without disturbing the server');
    assert.strictEqual(state.exited, false, 'the server must still be running');

    console.log(`\n${passed}/${passed} virtual LAN loopback checks passed`);
  } finally {
    child.kill('SIGKILL');
  }
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
