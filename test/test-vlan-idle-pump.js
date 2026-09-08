#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { LoopbackSegment } = require('../lib/vlan-wire');
const { compile, makeNode } = require('./vlan-node');

(async () => {
  const wasm = await compile();
  const wire = new LoopbackSegment().attach();
  let peeks = 0;
  const peek = wire.peek.bind(wire);
  wire.peek = () => { peeks++; return peek(); };
  const node = await makeNode(wasm, wire, '10.77.0.1');

  node.pump();
  assert.strictEqual(peeks, 0,
    'an idle GUI process must not cross into the host VLAN wire');

  node.wat.test_dde_instance(0, 1);
  node.pump();
  assert.strictEqual(peeks, 1,
    'a live Win16 DDE instance keeps the shared wire reader active');

  node.wat.test_dde_instance(0, 0);
  node.pump();
  assert.strictEqual(peeks, 1,
    'removing the last DDE instance makes the wire idle again');

  const wsadata = node.buf(400);
  assert.strictEqual(node.wat.test_call_WSAStartup(0x0101, wsadata) | 0, 0);
  node.pump();
  assert.strictEqual(peeks, 2,
    'WSAStartup independently keeps the wire reader active');

  console.log('PASS  idle VLAN pump is gated by live Winsock or Win16 DDE users');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
