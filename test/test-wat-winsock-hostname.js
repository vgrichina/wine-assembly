#!/usr/bin/env node
'use strict';

// How a Win32 app finds out its own address: gethostname, then gethostbyname
// on whatever that returned. TetriNET's server does exactly this to show the
// address players should type in, and Delphi's wrapper prints "0.0.0.0" when
// either half comes back empty.
//
// The two halves have to agree. Answering gethostname with a name the
// resolver then refuses is no better than not answering at all, so this pins
// the round trip rather than either call on its own: the name that comes out
// of the first call must resolve, through the second, to the address this
// process actually answers for on the wire.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_gethostname") (param $buf i32) (param $len i32) (result i32)
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_gethostname (local.get $buf) (local.get $len)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_gethostbyname") (param $name i32) (result i32)
    (global.set $esp (i32.const 0x074ff000))
    (call $handle_gethostbyname (local.get $name)
      (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_local_ip") (result i32) (global.get $vsock_local_ip))
  (func (export "test_peek8") (param $a i32) (result i32)
    (i32.load8_u (call $g2w (local.get $a))))
  (func (export "test_peek32") (param $a i32) (result i32)
    (i32.load (call $g2w (local.get $a))))
  (func (export "test_poke8") (param $a i32) (param $b i32)
    (i32.store8 (call $g2w (local.get $a)) (local.get $b)))
`;

const BUF = 0x00030000;

(async () => {
  const { exports: e } = await bootRenderHarness({ extraWat, width: 64, height: 48 });

  const readStr = addr => {
    let out = '';
    for (let i = 0; i < 64; i++) {
      const ch = e.test_peek8(addr + i);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  };

  assert.strictEqual(e.test_gethostname(BUF, 128), 0, 'gethostname should succeed');
  const name = readStr(BUF);
  assert.ok(name.length, 'gethostname should write a name, not an empty string');
  console.log(`PASS  gethostname answers "${name}"`);

  // A buffer too small for the name is WSAEFAULT, not a silent truncation.
  assert.strictEqual(e.test_gethostname(BUF, 1) | 0, -1,
    'gethostname should fail when the buffer cannot hold the name');
  console.log('PASS  a buffer too small for the name is refused');

  // Restore the name the short call was not allowed to touch.
  assert.strictEqual(e.test_gethostname(BUF, 128), 0, 'gethostname should succeed');

  const hostent = e.test_gethostbyname(BUF) >>> 0;
  assert.ok(hostent, 'gethostbyname should resolve the name gethostname just gave');
  console.log('PASS  the name gethostname returns is one gethostbyname resolves');

  assert.strictEqual(readStr(e.test_peek32(hostent) >>> 0), name,
    'h_name should be the name that was asked for');

  // h_addr_list[0] points at the in_addr, which holds network byte order.
  const list = e.test_peek32(hostent + 12) >>> 0;
  const addrPtr = e.test_peek32(list) >>> 0;
  assert.ok(addrPtr, 'h_addr_list[0] should point at an address');
  const netOrder = e.test_peek32(addrPtr) >>> 0;
  const octets = [netOrder & 0xff, (netOrder >>> 8) & 0xff,
                  (netOrder >>> 16) & 0xff, (netOrder >>> 24) & 0xff];

  const localIp = e.test_local_ip() >>> 0;
  const expected = [(localIp >>> 24) & 0xff, (localIp >>> 16) & 0xff,
                    (localIp >>> 8) & 0xff, localIp & 0xff];
  assert.deepStrictEqual(octets, expected,
    `expected ${expected.join('.')}, got ${octets.join('.')}`);
  console.log(`PASS  it resolves to this process's own room address ${octets.join('.')}`);

  // The resolver is not simply saying yes to everything: a name that is
  // neither ours nor a dotted quad still has to fail.
  const OTHER = BUF + 256;
  'nosuchhost\0'.split('').forEach((ch, i) => e.test_poke8(OTHER + i, ch.charCodeAt(0)));
  assert.strictEqual(e.test_gethostbyname(OTHER) >>> 0, 0,
    'an unknown name should still fail to resolve');
  console.log('PASS  an unknown name is still not found');

  console.log('\n6/6 winsock hostname checks passed');
})();
