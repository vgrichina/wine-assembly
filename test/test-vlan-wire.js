#!/usr/bin/env node

// Slice 2 gate for the virtual LAN wire (docs/virtual-lan-party.md).
//
// Two independent emulator instances — separate memories, separate socket
// tables, separate room addresses — are put on one loopback segment and
// made to complete a TCP conversation through the public Winsock handlers.
// Slice 1 proved the switch behaves like TCP inside one process; this
// proves the same semantics survive being split across the wire, which is
// the property the WebRTC transport will later have to preserve.
//
// No Liquid War binary is involved. The two-process gate that runs the real
// client and server is test/test-vlan-loopback.js.

'use strict';

const assert = require('assert');
const { LoopbackSegment } = require('../lib/vlan-wire');
const { compile, makeNode, ip2int, AF_INET, SOCK_STREAM, INVALID_SOCKET } = require('./vlan-node');

const SD_SEND = 1;

const WSAEWOULDBLOCK = 10035;
const WSAEALREADY = 10037;
const WSAECONNRESET = 10054;
const WSAECONNREFUSED = 10061;

const HOST_IP = '10.77.0.1';
const PEER_IP = '10.77.0.2';
const GAME_PORT = 8035;

const VLN_MAGIC = 0x314e4c56;
const VLN_HDR = 28;
const MAX_PAYLOAD = 4096;

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

// Everything below drives nonblocking sockets and pumps explicitly, so a
// call that cannot make progress fails the assertion instead of hanging.
function settle(...nodes) {
  for (let round = 0; round < 8; round++) {
    let moved = false;
    for (const n of nodes) {
      if (n.wire.pending) { moved = true; }
      n.wat.vlan_pump();
    }
    if (!moved) break;
  }
}

async function main() {
  const wasm = await compile();
  const segment = new LoopbackSegment();
  const host = await makeNode(wasm, segment.attach(), HOST_IP);
  const peer = await makeNode(wasm, segment.attach(), PEER_IP);

  check('each process keeps its own room address', () => {
    assert.strictEqual(host.wat.get_vlan_local_ip() >>> 0, ip2int(HOST_IP));
    assert.strictEqual(peer.wat.get_vlan_local_ip() >>> 0, ip2int(PEER_IP));
  });

  // ---- opening a connection across the wire ---------------------------

  const srv = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
  host.nonblocking(srv);
  assert.strictEqual(host.wat.test_call_bind(srv, host.sockaddr('0.0.0.0', GAME_PORT), 16) | 0, 0);
  assert.strictEqual(host.wat.test_call_listen(srv, 5) | 0, 0);

  const cli = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
  peer.nonblocking(cli);

  check('a nonblocking connect to another process is still in progress', () => {
    const r = peer.wat.test_call_connect(cli, peer.sockaddr(HOST_IP, GAME_PORT), 16) | 0;
    assert.strictEqual(r, -1);
    assert.strictEqual(peer.err(), WSAEWOULDBLOCK);
    // The SYN is on the wire; nothing has reached the host process yet.
    assert.strictEqual(host.wire.pending, 1);
  });

  check('polling an unfinished connect reports it is already under way', () => {
    // The host has not been given a chance to run, so the answer cannot
    // have arrived yet.
    const r = peer.wat.test_call_connect(cli, peer.sockaddr(HOST_IP, GAME_PORT), 16) | 0;
    assert.strictEqual(r, -1);
    assert.strictEqual(peer.err(), WSAEALREADY);
  });

  let acc = INVALID_SOCKET;
  check('the listener becomes readable once the SYN is delivered', () => {
    host.wat.vlan_pump();
    const set = host.fdset([srv]);
    const n = host.wat.test_call_select(0, set, 0, 0, host.timeval(0, 0)) | 0;
    assert.strictEqual(n, 1);
    assert.deepStrictEqual(host.fdsetList(set), [srv]);
  });

  check('accept reports the address of the process on the other side', () => {
    const sa = host.alloc(16);
    const len = host.alloc(4);
    new DataView(host.memory.buffer, host.wa(len), 4).setUint32(0, 16, true);
    acc = host.wat.test_call_accept(srv, sa, len) | 0;
    assert.notStrictEqual(acc, INVALID_SOCKET);
    host.nonblocking(acc);
    assert.strictEqual(host.readSockaddr(sa).ip, PEER_IP);
  });

  check('the connecting side completes once the answer comes back', () => {
    settle(host, peer);
    const r = peer.wat.test_call_connect(cli, peer.sockaddr(HOST_IP, GAME_PORT), 16) | 0;
    assert.strictEqual(r, 0);
  });

  // ---- bytes ----------------------------------------------------------

  check('bytes cross the wire in both directions', () => {
    const msg = Array.from(Buffer.from('LWSRV/hello'));
    assert.strictEqual(peer.wat.test_call_send(cli, peer.buf(msg), msg.length, 0) | 0, msg.length);
    settle(host, peer);
    const rx = host.buf(64);
    assert.strictEqual(host.wat.test_call_recv(acc, rx, 64, 0) | 0, msg.length);
    assert.deepStrictEqual(host.readBuf(rx, msg.length), msg);

    const back = Array.from(Buffer.from('LWCLI/ok'));
    assert.strictEqual(host.wat.test_call_send(acc, host.buf(back), back.length, 0) | 0, back.length);
    settle(host, peer);
    const rx2 = peer.buf(64);
    assert.strictEqual(peer.wat.test_call_recv(cli, rx2, 64, 0) | 0, back.length);
    assert.deepStrictEqual(peer.readBuf(rx2, back.length), back);
  });

  check('the wire preserves stream order across many small writes', () => {
    const expected = [];
    for (let i = 0; i < 40; i++) {
      const chunk = [i & 0xff, (i * 7) & 0xff, (i * 13) & 0xff];
      expected.push(...chunk);
      assert.strictEqual(peer.wat.test_call_send(cli, peer.buf(chunk), 3, 0) | 0, 3);
    }
    settle(host, peer);
    const rx = host.buf(256);
    const got = [];
    for (;;) {
      const n = host.wat.test_call_recv(acc, rx, 256, 0) | 0;
      if (n <= 0) break;
      got.push(...host.readBuf(rx, n));
      if (got.length >= expected.length) break;
    }
    assert.deepStrictEqual(got, expected, 'stream order must survive framing');
  });

  check('a write larger than one frame reports a partial count', () => {
    const big = new Array(MAX_PAYLOAD + 500).fill(0x5a);
    const n = peer.wat.test_call_send(cli, peer.buf(big), big.length, 0) | 0;
    assert.strictEqual(n, MAX_PAYLOAD, 'one send produces at most one frame');
    settle(host, peer);
    let drained = 0;
    const rx = host.buf(MAX_PAYLOAD);
    for (;;) {
      const got = host.wat.test_call_recv(acc, rx, MAX_PAYLOAD, 0) | 0;
      if (got <= 0) break;
      drained += got;
    }
    assert.strictEqual(drained, MAX_PAYLOAD);
  });

  // ---- addressing and malformed input ---------------------------------

  check('a frame addressed to another member is ignored', () => {
    const f = new Uint8Array(VLN_HDR);
    const v = new DataView(f.buffer);
    v.setUint32(0, VLN_MAGIC, true);
    v.setUint32(4, 5, true);                    // RST
    v.setUint32(8, ip2int('10.77.0.9'), true);
    v.setUint32(12, 1234, true);
    v.setUint32(16, ip2int('10.77.0.7'), true); // not this process
    v.setUint32(20, GAME_PORT, true);
    v.setUint32(24, 0, true);
    host.wire.deliver(f);
    host.wat.vlan_pump();
    assert.strictEqual(host.wire.pending, 0, 'the frame is consumed, not stuck');
    // The established connection is untouched.
    const msg = [1, 2, 3];
    assert.strictEqual(host.wat.test_call_send(acc, host.buf(msg), 3, 0) | 0, 3);
    settle(host, peer);
    const rx = peer.buf(8);
    assert.strictEqual(peer.wat.test_call_recv(cli, rx, 8, 0) | 0, 3);
  });

  check('a malformed frame is dropped without stalling the wire', () => {
    host.wire.deliver(new Uint8Array([1, 2, 3]));                  // too short
    const bad = new Uint8Array(VLN_HDR);
    new DataView(bad.buffer).setUint32(0, 0xdeadbeef, true);       // wrong magic
    host.wire.deliver(bad);
    host.wat.vlan_pump();
    assert.strictEqual(host.wire.pending, 0);
    const msg = [9, 9];
    assert.strictEqual(peer.wat.test_call_send(cli, peer.buf(msg), 2, 0) | 0, 2);
    settle(host, peer);
    const rx = host.buf(8);
    assert.strictEqual(host.wat.test_call_recv(acc, rx, 8, 0) | 0, 2);
  });

  check('a frame whose declared length disagrees with its size is dropped', () => {
    const f = new Uint8Array(VLN_HDR + 4);
    const v = new DataView(f.buffer);
    v.setUint32(0, VLN_MAGIC, true);
    v.setUint32(4, 3, true);
    v.setUint32(8, ip2int(PEER_IP), true);
    v.setUint32(12, 40000, true);
    v.setUint32(16, ip2int(HOST_IP), true);
    v.setUint32(20, GAME_PORT, true);
    v.setUint32(24, 999, true);                 // claims 999 payload bytes
    host.wire.deliver(f);
    host.wat.vlan_pump();
    assert.strictEqual(host.wire.pending, 0);
  });

  // ---- closing --------------------------------------------------------

  check('an orderly shutdown delivers EOF to the other process', () => {
    assert.strictEqual(peer.wat.test_call_shutdown(cli, SD_SEND) | 0, 0);
    settle(host, peer);
    const rx = host.buf(8);
    assert.strictEqual(host.wat.test_call_recv(acc, rx, 8, 0) | 0, 0, 'EOF, not an error');
  });

  check('an abortive close resets the other process', () => {
    const s2 = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    host.nonblocking(s2);
    assert.strictEqual(host.wat.test_call_bind(s2, host.sockaddr('0.0.0.0', 9100), 16) | 0, 0);
    assert.strictEqual(host.wat.test_call_listen(s2, 5) | 0, 0);

    const c2 = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    peer.nonblocking(c2);
    peer.wat.test_call_connect(c2, peer.sockaddr(HOST_IP, 9100), 16);
    settle(host, peer);
    const a2 = host.wat.test_call_accept(s2, 0, 0) | 0;
    assert.notStrictEqual(a2, INVALID_SOCKET);
    host.nonblocking(a2);
    settle(host, peer);
    assert.strictEqual(peer.wat.test_call_connect(c2, peer.sockaddr(HOST_IP, 9100), 16) | 0, 0);

    // Close with the write half still open: TCP aborts.
    assert.strictEqual(host.wat.test_call_closesocket(a2) | 0, 0);
    settle(host, peer);
    const rx = peer.buf(8);
    assert.strictEqual(peer.wat.test_call_recv(c2, rx, 8, 0) | 0, -1);
    assert.strictEqual(peer.err(), WSAECONNRESET);
    host.wat.test_call_closesocket(s2);
    peer.wat.test_call_closesocket(c2);
  });

  check('connecting to a port nobody listens on is refused across the wire', () => {
    const c3 = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    peer.nonblocking(c3);
    assert.strictEqual(peer.wat.test_call_connect(c3, peer.sockaddr(HOST_IP, 9999), 16) | 0, -1);
    assert.strictEqual(peer.err(), WSAEWOULDBLOCK);
    settle(host, peer);
    assert.strictEqual(peer.wat.test_call_connect(c3, peer.sockaddr(HOST_IP, 9999), 16) | 0, -1);
    assert.strictEqual(peer.err(), WSAECONNREFUSED);
    peer.wat.test_call_closesocket(c3);
  });

  check('an address outside the room is unreachable, wire or not', () => {
    const c4 = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    peer.nonblocking(c4);
    assert.strictEqual(peer.wat.test_call_connect(c4, peer.sockaddr('93.184.216.34', 80), 16) | 0, -1);
    assert.strictEqual(peer.err(), 10051, 'WSAENETUNREACH');
    assert.strictEqual(peer.wire.sentFrames > 0, true);
    peer.wat.test_call_closesocket(c4);
  });

  // ---- blocking parks the call instead of lying ------------------------

  check('a blocking accept with an empty backlog parks on the net_wait yield', () => {
    const s5 = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(host.wat.test_call_bind(s5, host.sockaddr('0.0.0.0', 9200), 16) | 0, 0);
    assert.strictEqual(host.wat.test_call_listen(s5, 5) | 0, 0);
    assert.strictEqual(host.wat.get_yield_reason() | 0, 0);
    host.wat.test_call_accept(s5, 0, 0);
    assert.strictEqual(host.wat.get_yield_reason() | 0, 8, 'net_wait');
    host.wat.clear_yield();
    host.wat.test_call_closesocket(s5);
  });

  check('a blocking recv on an idle connection parks the same way', () => {
    const s6 = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    host.nonblocking(s6);
    assert.strictEqual(host.wat.test_call_bind(s6, host.sockaddr('0.0.0.0', 9300), 16) | 0, 0);
    assert.strictEqual(host.wat.test_call_listen(s6, 5) | 0, 0);
    const c6 = peer.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    peer.nonblocking(c6);
    peer.wat.test_call_connect(c6, peer.sockaddr(HOST_IP, 9300), 16);
    settle(host, peer);
    const a6 = host.wat.test_call_accept(s6, 0, 0) | 0;
    assert.notStrictEqual(a6, INVALID_SOCKET);
    // a6 stays blocking: nothing is buffered, so recv must park.
    host.wat.test_call_recv(a6, host.buf(8), 8, 0);
    assert.strictEqual(host.wat.get_yield_reason() | 0, 8, 'net_wait');
    host.wat.clear_yield();
    host.wat.test_call_closesocket(a6);
    host.wat.test_call_closesocket(s6);
    peer.wat.test_call_closesocket(c6);
    settle(host, peer);
  });

  check('select with a finite timeout waits rather than returning at once', () => {
    const s7 = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    host.nonblocking(s7);
    assert.strictEqual(host.wat.test_call_bind(s7, host.sockaddr('0.0.0.0', 9400), 16) | 0, 0);
    assert.strictEqual(host.wat.test_call_listen(s7, 5) | 0, 0);
    const set = host.fdset([s7]);
    host.wat.test_call_select(0, set, 0, 0, host.timeval(1, 0));
    assert.strictEqual(host.wat.get_yield_reason() | 0, 8, 'net_wait');
    // The set is untouched, so the re-entered call still knows what to watch.
    assert.deepStrictEqual(host.fdsetList(set), [s7]);
    host.wat.clear_yield();
    host.wat.test_call_closesocket(s7);
  });

  check('select with a zero timeout is a poll and empties the sets', () => {
    const s8 = host.wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    host.nonblocking(s8);
    assert.strictEqual(host.wat.test_call_bind(s8, host.sockaddr('0.0.0.0', 9500), 16) | 0, 0);
    assert.strictEqual(host.wat.test_call_listen(s8, 5) | 0, 0);
    const set = host.fdset([s8]);
    assert.strictEqual(host.wat.test_call_select(0, set, 0, 0, host.timeval(0, 0)) | 0, 0);
    assert.strictEqual(host.wat.get_yield_reason() | 0, 0, 'a poll never parks');
    assert.deepStrictEqual(host.fdsetList(set), []);
    host.wat.test_call_closesocket(s8);
  });

  console.log(`\n${passed}/${passed} virtual LAN wire checks passed`);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
