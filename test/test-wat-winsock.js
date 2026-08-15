#!/usr/bin/env node

// Slice 1 gate for the virtual LAN socket core (docs/virtual-lan-party.md).
//
// A synthetic client and server exchange fragmented bidirectional byte
// streams through the public Winsock handlers, in both blocking and
// nonblocking modes, with no Liquid War binary involved. The point is that
// the switch behaves like TCP — partial I/O, EOF, reset, backlog limits —
// rather than that a particular game happens to work.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const AF_INET = 2;
const SOCK_STREAM = 1;
const SOCK_DGRAM = 2;
const INVALID_SOCKET = -1;
const SOCKET_ERROR = -1;
const FIONBIO = 0x8004667e | 0;
const FIONREAD = 0x4004667f | 0;
const SD_SEND = 1;

const WSAEWOULDBLOCK = 10035;
const WSAENOTSOCK = 10038;
const WSAEADDRINUSE = 10048;
const WSAEADDRNOTAVAIL = 10049;
const WSAENETUNREACH = 10051;
const WSAECONNRESET = 10054;
const WSAECONNREFUSED = 10061;
const WSAESOCKTNOSUPPORT = 10044;
const WSAEAFNOSUPPORT = 10047;
const WSAEINVAL = 10022;

const ROOM_HOST = '10.77.0.1';
const GAME_PORT = 8035;

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  Object.assign(imports.host, {
    memory,
    create_thread: () => 0,
    exit_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const wat = instance.exports;
  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  let passed = 0;

  const wa = ga => (ga - imageBase + 0x12000) >>> 0;

  function check(name, fn) {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  }

  function alloc(n) {
    const p = wat.guest_alloc(n) >>> 0;
    assert(p, 'guest_alloc failed');
    return p;
  }

  function cstr(s) {
    const p = alloc(s.length + 1);
    for (let i = 0; i < s.length; i++) bytes[wa(p) + i] = s.charCodeAt(i);
    bytes[wa(p) + s.length] = 0;
    return p;
  }

  function readCstr(ga) {
    let out = '';
    for (let i = 0; i < 64; i++) {
      const c = bytes[wa(ga) + i];
      if (!c) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  // sockaddr_in { short family; u_short port (net); u_long addr (net); char pad[8] }
  function sockaddr(ip, port) {
    const p = alloc(16);
    const v = new DataView(memory.buffer, wa(p), 16);
    v.setUint16(0, AF_INET, true);
    v.setUint16(2, port, false);
    const o = ip.split('.').map(Number);
    v.setUint8(4, o[0]); v.setUint8(5, o[1]); v.setUint8(6, o[2]); v.setUint8(7, o[3]);
    for (let i = 8; i < 16; i++) v.setUint8(i, 0);
    return p;
  }

  function readSockaddr(ga) {
    const v = new DataView(memory.buffer, wa(ga), 16);
    return {
      family: v.getUint16(0, true),
      port: v.getUint16(2, false),
      ip: [v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7)].join('.'),
    };
  }

  // fd_set { u_int count; SOCKET array[64] }
  function fdset(handles) {
    const p = alloc(4 + 64 * 4);
    const v = new DataView(memory.buffer, wa(p), 4 + 64 * 4);
    v.setUint32(0, handles.length, true);
    handles.forEach((h, i) => v.setUint32(4 + i * 4, h >>> 0, true));
    return p;
  }

  function fdsetList(ga) {
    const v = new DataView(memory.buffer, wa(ga), 4 + 64 * 4);
    const n = v.getUint32(0, true);
    const out = [];
    for (let i = 0; i < n; i++) out.push(v.getUint32(4 + i * 4, true) | 0);
    return out;
  }

  function timeval(sec, usec) {
    const p = alloc(8);
    const v = new DataView(memory.buffer, wa(p), 8);
    v.setUint32(0, sec, true);
    v.setUint32(4, usec, true);
    return p;
  }

  function buf(dataOrLen) {
    if (typeof dataOrLen === 'number') return alloc(dataOrLen);
    const p = alloc(dataOrLen.length);
    for (let i = 0; i < dataOrLen.length; i++) bytes[wa(p) + i] = dataOrLen[i];
    return p;
  }

  function readBuf(ga, n) {
    return Array.from(bytes.subarray(wa(ga), wa(ga) + n));
  }

  function setNonblocking(s, on) {
    const p = alloc(4);
    new DataView(memory.buffer, wa(p), 4).setUint32(0, on ? 1 : 0, true);
    assert.strictEqual(wat.test_call_ioctlsocket(s, FIONBIO, p) | 0, 0);
  }

  // Bring up a listening server and a connected client pair. Both halves
  // are nonblocking so a would-block is an assertion, never a hang.
  function connectedPair() {
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.notStrictEqual(srv, INVALID_SOCKET);
    setNonblocking(srv, true);
    assert.strictEqual(wat.test_call_bind(srv, sockaddr('0.0.0.0', GAME_PORT), 16) | 0, 0);
    assert.strictEqual(wat.test_call_listen(srv, 5) | 0, 0);

    const cli = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.notStrictEqual(cli, INVALID_SOCKET);
    setNonblocking(cli, true);
    assert.strictEqual(wat.test_call_connect(cli, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);

    const acc = wat.test_call_accept(srv, 0, 0) | 0;
    assert.notStrictEqual(acc, INVALID_SOCKET);
    setNonblocking(acc, true);
    return { srv, cli, acc };
  }

  // ---- byte order and address helpers --------------------------------

  wat.test_vsock_reset();

  check('htons/ntohs swap 16-bit values', () => {
    assert.strictEqual(wat.test_call_htons(8035) | 0, 0x631f);  // 0x1f63 swapped
    assert.strictEqual(wat.test_call_ntohs(0x6331) | 0, 0x3163);
    assert.strictEqual(wat.test_call_htons(wat.test_call_ntohs(0x1234) | 0) | 0, 0x1234);
  });

  check('inet_addr parses dotted quads in network order', () => {
    assert.strictEqual(wat.test_call_inet_addr(cstr('10.77.0.1')) >>> 0, 0x01004d0a);
    assert.strictEqual(wat.test_call_inet_addr(cstr('127.0.0.1')) >>> 0, 0x0100007f);
    assert.strictEqual(wat.test_call_inet_addr(cstr('0.0.0.0')) >>> 0, 0);
  });

  check('inet_addr rejects malformed input with INADDR_NONE', () => {
    for (const bad of ['10.77.0', '10.77.0.1.2', '10.77.0.256', 'localhost', '', '10..0.1']) {
      assert.strictEqual(wat.test_call_inet_addr(cstr(bad)) | 0, -1, `expected failure for "${bad}"`);
    }
  });

  check('inet_ntoa round-trips through inet_addr', () => {
    for (const ip of ['10.77.0.1', '10.77.0.254', '127.0.0.1', '0.0.0.0']) {
      const net = wat.test_call_inet_addr(cstr(ip)) >>> 0;
      assert.strictEqual(readCstr(wat.test_call_inet_ntoa(net) >>> 0), ip);
    }
  });

  check('gethostbyname resolves numeric room addresses only', () => {
    const he = wat.test_call_gethostbyname(cstr(ROOM_HOST)) >>> 0;
    assert(he, 'expected a hostent for a numeric address');
    const v = new DataView(memory.buffer, wa(he), 16);
    assert.strictEqual(v.getUint16(8, true), AF_INET);
    assert.strictEqual(v.getUint16(10, true), 4);
    const list = v.getUint32(12, true) >>> 0;
    const addrPtr = new DataView(memory.buffer, wa(list), 8).getUint32(0, true) >>> 0;
    assert.strictEqual(new DataView(memory.buffer, wa(addrPtr), 4).getUint32(0, true) >>> 0, 0x01004d0a);
    assert.strictEqual(readCstr(v.getUint32(0, true) >>> 0), ROOM_HOST);
    assert.strictEqual(wat.test_call_gethostbyname(cstr('liquidwar.example')) | 0, 0);
  });

  // ---- socket creation and validation --------------------------------

  check('socket rejects unsupported families and types', () => {
    wat.test_vsock_reset();
    assert.strictEqual(wat.test_call_socket(23, SOCK_STREAM, 0) | 0, INVALID_SOCKET);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEAFNOSUPPORT);
    assert.strictEqual(wat.test_call_socket(AF_INET, SOCK_DGRAM, 0) | 0, INVALID_SOCKET);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAESOCKTNOSUPPORT);
  });

  check('operations on a non-socket handle report WSAENOTSOCK', () => {
    wat.test_vsock_reset();
    for (const bogus of [0, 1, 0x70000002, 0x53000005]) {
      assert.strictEqual(wat.test_call_listen(bogus, 5) | 0, SOCKET_ERROR);
      assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAENOTSOCK);
    }
  });

  check('a closed handle stops being a socket', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_closesocket(s) | 0, 0);
    assert.strictEqual(wat.test_call_closesocket(s) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAENOTSOCK);
  });

  // ---- addressing and isolation --------------------------------------

  check('bind refuses addresses outside the room', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_bind(s, sockaddr('192.168.1.10', GAME_PORT), 16) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEADDRNOTAVAIL);
  });

  check('connect to an address outside the room is unreachable', () => {
    wat.test_vsock_reset();
    for (const ip of ['8.8.8.8', '192.168.1.10', '169.254.1.1', '172.16.0.1']) {
      const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
      assert.strictEqual(wat.test_call_connect(s, sockaddr(ip, GAME_PORT), 16) | 0, SOCKET_ERROR,
        `expected ${ip} to be unroutable`);
      assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAENETUNREACH);
    }
  });

  check('a second bind to the same port reports WSAEADDRINUSE', () => {
    wat.test_vsock_reset();
    const a = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    const b = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_bind(a, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);
    assert.strictEqual(wat.test_call_bind(b, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEADDRINUSE);
  });

  check('port 0 allocates from the room ephemeral range', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_bind(s, sockaddr(ROOM_HOST, 0), 16) | 0, 0);
    assert.strictEqual(wat.test_call_listen(s, 1) | 0, 0);
    const c = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(c, true);
    // The listener took an ephemeral port, so the fixed game port is free.
    assert.strictEqual(wat.test_call_connect(c, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNREFUSED);
  });

  // ---- listener lifecycle ---------------------------------------------

  check('listen requires a bound socket', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_listen(s, 5) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEINVAL);
  });

  check('connect with no listener is refused', () => {
    wat.test_vsock_reset();
    const c = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(c, true);
    assert.strictEqual(wat.test_call_connect(c, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNREFUSED);
  });

  check('backlog is enforced and clamped', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    wat.test_call_bind(srv, sockaddr(ROOM_HOST, GAME_PORT), 16);
    assert.strictEqual(wat.test_call_listen(srv, 2) | 0, 0);
    const conns = [];
    for (let i = 0; i < 2; i++) {
      const c = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
      setNonblocking(c, true);
      assert.strictEqual(wat.test_call_connect(c, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);
      conns.push(c);
    }
    const overflow = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(overflow, true);
    assert.strictEqual(wat.test_call_connect(overflow, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNREFUSED);
    // Draining one slot makes room again.
    assert.notStrictEqual(wat.test_call_accept(srv, 0, 0) | 0, INVALID_SOCKET);
    assert.strictEqual(wat.test_call_connect(overflow, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);
  });

  check('accept reports the connecting peer address', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    wat.test_call_bind(srv, sockaddr(ROOM_HOST, GAME_PORT), 16);
    wat.test_call_listen(srv, 4);
    const cli = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    const cliAddr = sockaddr(ROOM_HOST, 51000);
    assert.strictEqual(wat.test_call_bind(cli, cliAddr, 16) | 0, 0);
    assert.strictEqual(wat.test_call_connect(cli, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);

    const out = alloc(16);
    const outLen = alloc(4);
    new DataView(memory.buffer, wa(outLen), 4).setUint32(0, 16, true);
    const acc = wat.test_call_accept(srv, out, outLen) | 0;
    assert.notStrictEqual(acc, INVALID_SOCKET);
    assert.deepStrictEqual(readSockaddr(out), { family: AF_INET, port: 51000, ip: ROOM_HOST });
    assert.strictEqual(new DataView(memory.buffer, wa(outLen), 4).getUint32(0, true), 16);
  });

  check('accept on an empty nonblocking backlog would block', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(srv, true);
    wat.test_call_bind(srv, sockaddr(ROOM_HOST, GAME_PORT), 16);
    wat.test_call_listen(srv, 4);
    assert.strictEqual(wat.test_call_accept(srv, 0, 0) | 0, INVALID_SOCKET);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEWOULDBLOCK);
  });

  // ---- byte stream semantics ------------------------------------------

  check('send and recv move bytes in both directions', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    const msg = [...Buffer.from('LIQUIDWAR-HELLO')];
    const src = buf(msg);
    assert.strictEqual(wat.test_call_send(cli, src, msg.length, 0) | 0, msg.length);
    const dst = buf(64);
    assert.strictEqual(wat.test_call_recv(acc, dst, 64, 0) | 0, msg.length);
    assert.deepStrictEqual(readBuf(dst, msg.length), msg);

    const reply = [...Buffer.from('OK')];
    assert.strictEqual(wat.test_call_send(acc, buf(reply), reply.length, 0) | 0, reply.length);
    const back = buf(8);
    assert.strictEqual(wat.test_call_recv(cli, back, 8, 0) | 0, reply.length);
    assert.deepStrictEqual(readBuf(back, reply.length), reply);
  });

  check('the stream has no message boundaries', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    // Three sends, one recv: the reader sees one run of bytes.
    for (const part of ['aaa', 'bb', 'cccc']) {
      const d = [...Buffer.from(part)];
      assert.strictEqual(wat.test_call_send(cli, buf(d), d.length, 0) | 0, d.length);
    }
    const dst = buf(64);
    assert.strictEqual(wat.test_call_recv(acc, dst, 64, 0) | 0, 9);
    assert.strictEqual(Buffer.from(readBuf(dst, 9)).toString(), 'aaabbcccc');

    // One send, byte-at-a-time recv: the reader chooses the split.
    const payload = [...Buffer.from('fragmented')];
    assert.strictEqual(wat.test_call_send(cli, buf(payload), payload.length, 0) | 0, payload.length);
    let got = '';
    for (let i = 0; i < payload.length; i++) {
      const one = buf(1);
      assert.strictEqual(wat.test_call_recv(acc, one, 1, 0) | 0, 1);
      got += Buffer.from(readBuf(one, 1)).toString();
    }
    assert.strictEqual(got, 'fragmented');
  });

  check('send reports a partial count when the peer buffer fills', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    const big = 16384 + 4096;
    const src = alloc(big);
    for (let i = 0; i < big; i++) bytes[wa(src) + i] = i & 0xff;
    const first = wat.test_call_send(cli, src, big, 0) | 0;
    assert(first > 0 && first < big, `expected a partial send, got ${first}`);
    // The accepted prefix must be exact, so draining it and resending the
    // remainder reconstructs the original bytes.
    const drain = alloc(big);
    let total = 0;
    while (total < first) {
      const n = wat.test_call_recv(acc, drain + total, first - total, 0) | 0;
      assert(n > 0);
      total += n;
    }
    assert.strictEqual(total, first);
    for (let i = 0; i < first; i++) {
      assert.strictEqual(bytes[wa(drain) + i], i & 0xff, `byte ${i} corrupted`);
    }
    // Once drained the socket accepts more.
    assert(wat.test_call_send(cli, src, big - first, 0) | 0 > 0);
  });

  check('recv on an empty nonblocking socket would block', () => {
    wat.test_vsock_reset();
    const { acc } = connectedPair();
    assert.strictEqual(wat.test_call_recv(acc, buf(16), 16, 0) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEWOULDBLOCK);
  });

  check('FIONREAD reports queued bytes', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    const p = alloc(4);
    const view = new DataView(memory.buffer, wa(p), 4);
    assert.strictEqual(wat.test_call_ioctlsocket(acc, FIONREAD, p) | 0, 0);
    assert.strictEqual(view.getUint32(0, true), 0);
    wat.test_call_send(cli, buf([1, 2, 3, 4, 5]), 5, 0);
    assert.strictEqual(wat.test_call_ioctlsocket(acc, FIONREAD, p) | 0, 0);
    assert.strictEqual(view.getUint32(0, true), 5);
  });

  // ---- half close, EOF, reset -----------------------------------------

  check('shutdown(SD_SEND) delivers an orderly EOF after buffered bytes', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    const d = [...Buffer.from('tail')];
    wat.test_call_send(cli, buf(d), d.length, 0);
    assert.strictEqual(wat.test_call_shutdown(cli, SD_SEND) | 0, 0);
    // Buffered data still arrives before the EOF.
    const dst = buf(16);
    assert.strictEqual(wat.test_call_recv(acc, dst, 16, 0) | 0, 4);
    assert.strictEqual(wat.test_call_recv(acc, dst, 16, 0) | 0, 0);
    assert.strictEqual(wat.test_call_recv(acc, dst, 16, 0) | 0, 0, 'EOF must be sticky');
    // The reverse direction stays usable after a half close.
    assert.strictEqual(wat.test_call_send(acc, buf([9]), 1, 0) | 0, 1);
    assert.strictEqual(wat.test_call_recv(cli, dst, 16, 0) | 0, 1);
  });

  check('closing with the write half open resets the peer', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    assert.strictEqual(wat.test_call_closesocket(cli) | 0, 0);
    assert.strictEqual(wat.test_call_recv(acc, buf(16), 16, 0) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNRESET);
  });

  check('closing after shutdown is an orderly EOF, not a reset', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    wat.test_call_shutdown(cli, SD_SEND);
    assert.strictEqual(wat.test_call_closesocket(cli) | 0, 0);
    assert.strictEqual(wat.test_call_recv(acc, buf(16), 16, 0) | 0, 0);
  });

  check('a reset surfaces after buffered bytes are drained', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    wat.test_call_send(cli, buf([7, 7, 7]), 3, 0);
    wat.test_call_closesocket(cli);
    const dst = buf(16);
    assert.strictEqual(wat.test_call_recv(acc, dst, 16, 0) | 0, 3, 'queued bytes survive the reset');
    assert.strictEqual(wat.test_call_recv(acc, dst, 16, 0) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNRESET);
  });

  check('send after the peer is gone reports WSAECONNRESET', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    wat.test_call_closesocket(acc);
    assert.strictEqual(wat.test_call_send(cli, buf([1]), 1, 0) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNRESET);
  });

  // ---- select ----------------------------------------------------------

  check('select reports a listener with a pending connection as readable', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(srv, true);
    wat.test_call_bind(srv, sockaddr(ROOM_HOST, GAME_PORT), 16);
    wat.test_call_listen(srv, 4);

    let set = fdset([srv]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 0);
    assert.deepStrictEqual(fdsetList(set), []);

    const cli = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(cli, true);
    wat.test_call_connect(cli, sockaddr(ROOM_HOST, GAME_PORT), 16);

    set = fdset([srv]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 1);
    assert.deepStrictEqual(fdsetList(set), [srv]);
    assert.strictEqual(wat.test_call_WSAFDIsSet(srv, set) | 0, 1);
  });

  check('select rewrites each set to only ready handles', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    const idle = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(idle, true);
    wat.test_call_send(cli, buf([1, 2]), 2, 0);

    const set = fdset([idle, acc, cli]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 1);
    assert.deepStrictEqual(fdsetList(set), [acc]);
    assert.strictEqual(wat.test_call_WSAFDIsSet(acc, set) | 0, 1);
    assert.strictEqual(wat.test_call_WSAFDIsSet(cli, set) | 0, 0);
    assert.strictEqual(wat.test_call_WSAFDIsSet(idle, set) | 0, 0);
  });

  check('select counts ready handles across all three sets', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    wat.test_call_send(cli, buf([1]), 1, 0);
    const r = fdset([acc, cli]);
    const w = fdset([acc, cli]);
    const e = fdset([acc, cli]);
    // acc is readable; both halves are writable; neither is in error.
    assert.strictEqual(wat.test_call_select(0, r, w, e, timeval(0, 0)) | 0, 3);
    assert.deepStrictEqual(fdsetList(r), [acc]);
    assert.deepStrictEqual(fdsetList(w), [acc, cli]);
    assert.deepStrictEqual(fdsetList(e), []);
  });

  check('an EOF socket is readable, and a full peer is not writable', () => {
    wat.test_vsock_reset();
    const { cli, acc } = connectedPair();
    wat.test_call_shutdown(cli, SD_SEND);
    let set = fdset([acc]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 1,
      'an orderly EOF must be read-ready');

    // Fill the peer receive ring so the writer stops being write-ready.
    const chunk = alloc(16384);
    let sent = 0;
    for (let i = 0; i < 8; i++) {
      const n = wat.test_call_send(acc, chunk, 16384, 0) | 0;
      if (n <= 0) break;
      sent += n;
    }
    assert(sent > 0);
    set = fdset([acc]);
    assert.strictEqual(wat.test_call_select(0, 0, set, 0, timeval(0, 0)) | 0, 0,
      'a writer whose peer ring is full must not be write-ready');
  });

  check('select ignores handles that are not sockets', () => {
    wat.test_vsock_reset();
    const set = fdset([0x70000002, 0, 0x53000030]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 0);
    assert.deepStrictEqual(fdsetList(set), []);
  });

  // ---- socket options ---------------------------------------------------

  check('setsockopt accepts the options Liquid War uses', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    const val = alloc(4);
    new DataView(memory.buffer, wa(val), 4).setUint32(0, 1, true);
    assert.strictEqual(wat.test_call_setsockopt(s, 0xffff, 0x0004, val, 4) | 0, 0, 'SO_REUSEADDR');
    assert.strictEqual(wat.test_call_setsockopt(s, 6, 1, val, 4) | 0, 0, 'TCP_NODELAY');
    assert.strictEqual(wat.test_call_setsockopt(s, 0xffff, 0x1234, val, 4) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, 10042, 'WSAENOPROTOOPT');
  });

  check('ioctlsocket rejects unsupported commands', () => {
    wat.test_vsock_reset();
    const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    assert.strictEqual(wat.test_call_ioctlsocket(s, 0x1234, alloc(4)) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAEINVAL);
  });

  // ---- a full synthetic session ------------------------------------------

  check('a synthetic client and server complete a fragmented session', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(srv, true);
    assert.strictEqual(wat.test_call_bind(srv, sockaddr('0.0.0.0', GAME_PORT), 16) | 0, 0);
    assert.strictEqual(wat.test_call_listen(srv, 6) | 0, 0);

    // Three clients join the room, as six-team Liquid War would.
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const c = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
      setNonblocking(c, true);
      assert.strictEqual(wat.test_call_connect(c, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);
      clients.push(c);
    }
    const set = fdset([srv]);
    assert.strictEqual(wat.test_call_select(0, set, 0, 0, timeval(0, 0)) | 0, 1);

    const served = [];
    for (let i = 0; i < 3; i++) {
      const a = wat.test_call_accept(srv, 0, 0) | 0;
      assert.notStrictEqual(a, INVALID_SOCKET);
      setNonblocking(a, true);
      served.push(a);
    }
    assert.strictEqual(wat.test_call_accept(srv, 0, 0) | 0, INVALID_SOCKET);

    // Every client sends a distinct message in one-byte fragments; the
    // server must reassemble each stream independently and in order.
    const messages = clients.map((_, i) => `client-${i}-payload`);
    const maxLen = Math.max(...messages.map(m => m.length));
    for (let off = 0; off < maxLen; off++) {
      clients.forEach((c, i) => {
        if (off >= messages[i].length) return;
        const one = buf([messages[i].charCodeAt(off)]);
        assert.strictEqual(wat.test_call_send(c, one, 1, 0) | 0, 1);
      });
    }
    served.forEach((a, i) => {
      const dst = buf(64);
      let total = 0;
      for (;;) {
        const n = wat.test_call_recv(a, dst + total, 64 - total, 0) | 0;
        if (n <= 0) break;
        total += n;
        if (total >= messages[i].length) break;
      }
      assert.strictEqual(Buffer.from(readBuf(dst, total)).toString(), messages[i]);
    });

    // The server answers each client, then closes the room down cleanly.
    served.forEach((a, i) => {
      const reply = [...Buffer.from(`ack-${i}`)];
      assert.strictEqual(wat.test_call_send(a, buf(reply), reply.length, 0) | 0, reply.length);
      assert.strictEqual(wat.test_call_shutdown(a, SD_SEND) | 0, 0);
    });
    clients.forEach((c, i) => {
      const dst = buf(32);
      const n = wat.test_call_recv(c, dst, 32, 0) | 0;
      assert.strictEqual(Buffer.from(readBuf(dst, n)).toString(), `ack-${i}`);
      assert.strictEqual(wat.test_call_recv(c, dst, 32, 0) | 0, 0, 'server EOF');
      assert.strictEqual(wat.test_call_closesocket(c) | 0, 0);
    });
    served.forEach(a => assert.strictEqual(wat.test_call_closesocket(a) | 0, 0));
    assert.strictEqual(wat.test_call_closesocket(srv) | 0, 0);
  });

  check('closing a listener drops its unaccepted backlog', () => {
    wat.test_vsock_reset();
    const srv = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    wat.test_call_bind(srv, sockaddr(ROOM_HOST, GAME_PORT), 16);
    wat.test_call_listen(srv, 4);
    const cli = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
    setNonblocking(cli, true);
    assert.strictEqual(wat.test_call_connect(cli, sockaddr(ROOM_HOST, GAME_PORT), 16) | 0, 0);
    assert.strictEqual(wat.test_call_closesocket(srv) | 0, 0);
    // The queued child never reached the application, so its peer resets.
    assert.strictEqual(wat.test_call_recv(cli, buf(8), 8, 0) | 0, SOCKET_ERROR);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, WSAECONNRESET);
  });

  check('the socket table is bounded and recovers after close', () => {
    wat.test_vsock_reset();
    const open = [];
    for (;;) {
      const s = wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0;
      if (s === INVALID_SOCKET) break;
      open.push(s);
      assert(open.length <= 64, 'socket table must be bounded');
    }
    assert.strictEqual(open.length, 64);
    assert.strictEqual(wat.test_call_WSAGetLastError() | 0, 10024, 'WSAEMFILE');
    assert.strictEqual(wat.test_call_closesocket(open.pop()) | 0, 0);
    assert.notStrictEqual(wat.test_call_socket(AF_INET, SOCK_STREAM, 0) | 0, INVALID_SOCKET);
  });

  console.log(`\n${passed}/${passed} winsock checks passed`);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
