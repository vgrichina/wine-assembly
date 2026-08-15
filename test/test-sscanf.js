#!/usr/bin/env node

'use strict';

// sscanf — the inverse of the wsprintf in 12-wsprintf.wat. cdplayer.exe parses
// its disc/track database with it, and before this existed the call trapped as
// an unimplemented API.
//
// The return value carries as much meaning as the outputs: it is the number of
// items assigned, and -1 (EOF) when the input ran out before the first
// conversion. Callers branch on it, so every case below asserts it.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  ok  ${label}`);
}

(async () => {
  const harness = await bootRenderHarness();
  const wat = harness.exports;
  const mem = harness.memory;

  const allocated = [];
  const alloc = size => {
    const p = wat.guest_alloc(size) >>> 0;
    allocated.push(p);
    return p;
  };
  const str = text => {
    const p = alloc(text.length + 1);
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i, text.charCodeAt(i));
    wat.guest_write8(p + text.length, 0);
    return p;
  };
  const readStr = p => {
    let out = '';
    for (let i = 0; i < 256; i++) {
      const ch = wat.guest_read8(p + i);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  };
  // Run sscanf with `n` output slots; returns { ret, slots }.
  const scan = (input, format, n) => {
    const slots = [];
    const va = alloc(Math.max(n, 1) * 4);
    for (let i = 0; i < n; i++) {
      const buf = alloc(64);
      for (let b = 0; b < 64; b++) wat.guest_write8(buf + b, 0);
      slots.push(buf);
      wat.guest_write32(va + i * 4, buf);
    }
    const ret = wat.test_sscanf(str(input), str(format), va);
    return { ret, slots };
  };
  const i32 = p => wat.guest_read32(p) | 0;
  // %f writes an IEEE float; read the raw dword back and reinterpret it.
  const f32 = p => {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, wat.guest_read32(p) >>> 0, true);
    return view.getFloat32(0, true);
  };

  check('%d reads a signed decimal', () => {
    const { ret, slots } = scan('42', '%d', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), 42);
  });

  check('a negative number keeps its sign', () => {
    const { ret, slots } = scan('-17', '%d', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), -17);
  });

  check('several fields separated by literal text', () => {
    const { ret, slots } = scan('12:34:56', '%d:%d:%d', 3);
    assert.strictEqual(ret, 3);
    assert.deepStrictEqual(slots.map(i32), [12, 34, 56]);
  });

  check('a literal mismatch stops the scan and reports the partial count', () => {
    const { ret, slots } = scan('12-34', '%d:%d', 2);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), 12);
  });

  check('whitespace in the format spans any run of input whitespace', () => {
    const { ret, slots } = scan('7   \t 9', '%d %d', 2);
    assert.strictEqual(ret, 2);
    assert.deepStrictEqual(slots.map(i32), [7, 9]);
  });

  check('leading whitespace is skipped before a numeric conversion', () => {
    const { ret, slots } = scan('   88', '%d', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), 88);
  });

  check('%s reads one whitespace-delimited token', () => {
    const { ret, slots } = scan('  hello world', '%s', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(readStr(slots[0]), 'hello');
  });

  check('a width limits how much %s consumes', () => {
    const { ret, slots } = scan('abcdefgh', '%3s', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(readStr(slots[0]), 'abc');
  });

  check('a width limits how many digits %d takes', () => {
    const { ret, slots } = scan('12345', '%2d%3d', 2);
    assert.strictEqual(ret, 2);
    assert.deepStrictEqual(slots.map(i32), [12, 345]);
  });

  check('%c takes the next character without skipping whitespace', () => {
    const { ret, slots } = scan(' A', '%c', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(wat.guest_read8(slots[0]), 0x20);
  });

  check('%x reads hex, with or without an 0x prefix', () => {
    assert.strictEqual(i32(scan('ff', '%x', 1).slots[0]), 255);
    assert.strictEqual(i32(scan('0x1A', '%x', 1).slots[0]), 26);
  });

  check('%o reads octal', () => {
    assert.strictEqual(i32(scan('17', '%o', 1).slots[0]), 15);
  });

  check('%i infers base from an 0x prefix', () => {
    assert.strictEqual(i32(scan('0x20', '%i', 1).slots[0]), 32);
    assert.strictEqual(i32(scan('20', '%i', 1).slots[0]), 20);
  });

  check('%* suppresses assignment but still consumes input', () => {
    const { ret, slots } = scan('11 22', '%*d %d', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), 22);
  });

  check('%hd stores only 16 bits', () => {
    const { ret, slots } = scan('65535', '%hd', 1);
    assert.strictEqual(ret, 1);
    // The high half of the slot must be untouched, which is the whole point
    // of honouring the length modifier.
    assert.strictEqual(wat.guest_read32(slots[0]) >>> 0, 0x0000FFFF);
  });

  check('%f reads a decimal float', () => {
    const { ret, slots } = scan('3.5', '%f', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(f32(slots[0]), 3.5);
  });

  check('%f accepts an exponent, and leaves a stray e alone when it is not one', () => {
    assert.strictEqual(f32(scan('1.5e2', '%f', 1).slots[0]), 150);
    const trailing = scan('2.5end', '%f%s', 2);
    assert.strictEqual(trailing.ret, 2);
    assert.strictEqual(f32(trailing.slots[0]), 2.5);
    assert.strictEqual(readStr(trailing.slots[1]), 'end');
  });

  check('%% matches a literal percent', () => {
    const { ret, slots } = scan('50% off', '%d%% off', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(i32(slots[0]), 50);
  });

  check('a scanset reads until a character outside the set', () => {
    const { ret, slots } = scan('abc123', '%[a-z]', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(readStr(slots[0]), 'abc');
  });

  check('a negated scanset reads until a listed character', () => {
    const { ret, slots } = scan('name=value', '%[^=]', 1);
    assert.strictEqual(ret, 1);
    assert.strictEqual(readStr(slots[0]), 'name');
  });

  check('a scanset does not skip leading whitespace', () => {
    const { ret } = scan('  abc', '%[a-z]', 1);
    assert.strictEqual(ret, 0, 'the space is outside the set, so nothing matches');
  });

  check('a failed first conversion assigns nothing', () => {
    const { ret } = scan('abc', '%d', 1);
    assert.strictEqual(ret, 0);
  });

  check('empty input reports EOF rather than zero items', () => {
    const { ret } = scan('', '%d', 1);
    assert.strictEqual(ret, -1);
  });

  check('a realistic CD database line parses in one call', () => {
    // The shape cdplayer.exe stores: numeric fields plus a delimited title.
    const { ret, slots } = scan('3,255,Rhapsody in Blue', '%d,%d,%[^\n]', 3);
    assert.strictEqual(ret, 3);
    assert.strictEqual(i32(slots[0]), 3);
    assert.strictEqual(i32(slots[1]), 255);
    assert.strictEqual(readStr(slots[2]), 'Rhapsody in Blue');
  });

  for (const p of allocated) wat.guest_free(p);

  console.log(`\ntest-sscanf: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
