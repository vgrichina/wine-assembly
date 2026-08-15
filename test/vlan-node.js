// A minimal emulator endpoint for virtual LAN tests.
//
// One node = one WASM instance with its own linear memory, its own socket
// table, and its own room address, driving the Winsock handlers through the
// test_call_* exports. It is the smallest thing that can sit on a wire and
// behave like a machine, which lets a test put a real guest binary on one
// end and a scripted peer on the other.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

const AF_INET = 2;
const SOCK_STREAM = 1;
const INVALID_SOCKET = -1;
const FIONBIO = 0x8004667e | 0;

const ip2int = ip => ip.split('.').reduce((a, o) => ((a << 8) | (Number(o) & 255)) >>> 0, 0) >>> 0;

async function compile() {
  const root = path.join(__dirname, '..');
  return compileWat(f => fs.promises.readFile(path.join(root, 'src', f), 'utf8'));
}

async function makeNode(wasm, wire, ip) {
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({
    getMemory: () => memory.buffer, renderer: null, resourceJson: {}, vlanWire: wire,
  });
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
  wat.set_vlan_local_ip(ip2int(ip) | 0);

  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = ga => (ga - imageBase + 0x12000) >>> 0;
  const alloc = n => {
    const p = wat.guest_alloc(n) >>> 0;
    assert(p, 'guest_alloc failed');
    return p;
  };

  return {
    ip, wat, wire, memory, wa, alloc,

    sockaddr(addr, port) {
      const p = alloc(16);
      const v = new DataView(memory.buffer, wa(p), 16);
      v.setUint16(0, AF_INET, true);
      v.setUint16(2, port, false);
      addr.split('.').forEach((o, i) => v.setUint8(4 + i, Number(o)));
      for (let i = 8; i < 16; i++) v.setUint8(i, 0);
      return p;
    },
    readSockaddr(ga) {
      const v = new DataView(memory.buffer, wa(ga), 16);
      return {
        port: v.getUint16(2, false),
        ip: [v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7)].join('.'),
      };
    },
    fdset(handles) {
      const p = alloc(4 + 64 * 4);
      const v = new DataView(memory.buffer, wa(p), 4 + 64 * 4);
      v.setUint32(0, handles.length, true);
      handles.forEach((h, i) => v.setUint32(4 + i * 4, h >>> 0, true));
      return p;
    },
    fdsetList(ga) {
      const v = new DataView(memory.buffer, wa(ga), 4 + 64 * 4);
      const n = v.getUint32(0, true);
      const out = [];
      for (let i = 0; i < n; i++) out.push(v.getUint32(4 + i * 4, true) | 0);
      return out;
    },
    timeval(sec, usec) {
      const p = alloc(8);
      const v = new DataView(memory.buffer, wa(p), 8);
      v.setUint32(0, sec, true);
      v.setUint32(4, usec, true);
      return p;
    },
    buf(data) {
      if (typeof data === 'number') return alloc(data);
      const p = alloc(data.length);
      for (let i = 0; i < data.length; i++) bytes[wa(p) + i] = data[i];
      return p;
    },
    readBuf(ga, n) { return Array.from(bytes.subarray(wa(ga), wa(ga) + n)); },
    nonblocking(s) {
      const p = alloc(4);
      new DataView(memory.buffer, wa(p), 4).setUint32(0, 1, true);
      assert.strictEqual(wat.test_call_ioctlsocket(s, FIONBIO, p) | 0, 0);
    },
    err() { return wat.test_call_WSAGetLastError() | 0; },
    pump() { wat.vlan_pump(); },
  };
}

module.exports = {
  compile, makeNode, ip2int,
  AF_INET, SOCK_STREAM, INVALID_SOCKET, FIONBIO,
};
