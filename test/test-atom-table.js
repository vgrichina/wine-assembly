#!/usr/bin/env node

'use strict';

// Atom tables: AddAtom* / GlobalAddAtom* / FindAtom* / DeleteAtom / *GetAtomName*.
//
// The property that matters to apps is identity, not the numeric value: adding
// the same name twice returns the *same* atom, FindAtom recovers it, and the
// process-local and system-global namespaces stay separate. Delphi's VCL
// (Tetravex) registers a global atom once and calls GlobalFindAtomA on every
// window activation to get it back.

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

  const allocated = [];
  const strA = text => {
    const p = wat.guest_alloc(text.length + 1) >>> 0;
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i, text.charCodeAt(i));
    wat.guest_write8(p + text.length, 0);
    allocated.push(p);
    return p;
  };
  const strW = text => {
    const p = wat.guest_alloc((text.length + 1) * 2) >>> 0;
    for (let i = 0; i < text.length; i++) wat.guest_write8(p + i * 2, text.charCodeAt(i)),
      wat.guest_write8(p + i * 2 + 1, 0);
    wat.guest_write8(p + text.length * 2, 0);
    wat.guest_write8(p + text.length * 2 + 1, 0);
    allocated.push(p);
    return p;
  };
  const readA = (p, max) => {
    let out = '';
    for (let i = 0; i < max; i++) {
      const ch = wat.guest_read8(p + i);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  };
  const readW = (p, max) => {
    let out = '';
    for (let i = 0; i < max; i++) {
      const ch = wat.guest_read8(p + i * 2) | (wat.guest_read8(p + i * 2 + 1) << 8);
      if (!ch) break;
      out += String.fromCharCode(ch);
    }
    return out;
  };
  const buffer = size => {
    const p = wat.guest_alloc(size) >>> 0;
    allocated.push(p);
    return p;
  };

  check('AddAtomA returns a string atom in the 0xC000 range', () => {
    const a = wat.test_call_AddAtomA(strA('Delphi.WndClass')) >>> 0;
    assert(a >= 0xC000 && a <= 0xFFFF, `expected a string atom, got 0x${a.toString(16)}`);
  });

  check('adding the same name twice returns the same atom', () => {
    const first = wat.test_call_AddAtomA(strA('SameName')) >>> 0;
    const second = wat.test_call_AddAtomA(strA('SameName')) >>> 0;
    assert.strictEqual(second, first);
  });

  check('atom names are case-insensitive, as in Win32', () => {
    const lower = wat.test_call_AddAtomA(strA('mixedcase')) >>> 0;
    const upper = wat.test_call_FindAtomA(strA('MiXeDcAsE')) >>> 0;
    assert.strictEqual(upper, lower);
  });

  check('FindAtomA returns 0 for a name that was never added', () => {
    assert.strictEqual(wat.test_call_FindAtomA(strA('NeverAdded')) >>> 0, 0);
  });

  check('distinct names get distinct atoms', () => {
    const a = wat.test_call_AddAtomA(strA('AtomOne')) >>> 0;
    const b = wat.test_call_AddAtomA(strA('AtomTwo')) >>> 0;
    assert.notStrictEqual(a, b);
  });

  check('GetAtomNameA reads the name back', () => {
    const atom = wat.test_call_AddAtomA(strA('ReadBack')) >>> 0;
    const buf = buffer(64);
    const len = wat.test_call_GetAtomNameA(atom, buf, 64);
    assert.strictEqual(len, 8);
    assert.strictEqual(readA(buf, 64), 'ReadBack');
  });

  check('GetAtomNameA truncates to the buffer and still terminates', () => {
    const atom = wat.test_call_AddAtomA(strA('LongEnoughName')) >>> 0;
    const buf = buffer(64);
    const len = wat.test_call_GetAtomNameA(atom, buf, 5);
    assert.strictEqual(len, 4);
    assert.strictEqual(readA(buf, 64), 'Long');
  });

  check('GetAtomNameA returns 0 for an atom that was never handed out', () => {
    const buf = buffer(64);
    assert.strictEqual(wat.test_call_GetAtomNameA(0xFFF0, buf, 64), 0);
  });

  check('DeleteAtom drops one reference; the atom survives until the last', () => {
    const name = 'RefCounted';
    const atom = wat.test_call_AddAtomA(strA(name)) >>> 0;
    wat.test_call_AddAtomA(strA(name));
    assert.strictEqual(wat.test_call_DeleteAtom(atom), 0);
    assert.strictEqual(wat.test_call_FindAtomA(strA(name)) >>> 0, atom,
      'still referenced once, so it must remain findable');
    assert.strictEqual(wat.test_call_DeleteAtom(atom), 0);
    assert.strictEqual(wat.test_call_FindAtomA(strA(name)) >>> 0, 0,
      'last reference released, so the name is gone');
  });

  check('a freed slot is reused rather than leaked', () => {
    const atom = wat.test_call_AddAtomA(strA('SlotChurn')) >>> 0;
    wat.test_call_DeleteAtom(atom);
    const reused = wat.test_call_AddAtomA(strA('SlotChurnToo')) >>> 0;
    assert.strictEqual(reused, atom);
  });

  check('integer atoms pass through without consuming a slot', () => {
    assert.strictEqual(wat.test_call_AddAtomA(0x1234) >>> 0, 0x1234);
    assert.strictEqual(wat.test_call_FindAtomA(0x1234) >>> 0, 0x1234);
    assert.strictEqual(wat.test_call_GlobalFindAtomA(0x1234) >>> 0, 0x1234);
    assert.strictEqual(wat.test_call_DeleteAtom(0x1234), 0);
  });

  check('the local and global namespaces are independent', () => {
    const name = 'BothTables';
    const local = wat.test_call_AddAtomA(strA(name)) >>> 0;
    const global = wat.test_call_GlobalAddAtomA(strA(name)) >>> 0;
    assert.strictEqual(wat.test_call_FindAtomA(strA(name)) >>> 0, local);
    assert.strictEqual(wat.test_call_GlobalFindAtomA(strA(name)) >>> 0, global);
    // Releasing the global one must not disturb the local entry.
    wat.test_call_GlobalDeleteAtom(global);
    assert.strictEqual(wat.test_call_GlobalFindAtomA(strA(name)) >>> 0, 0);
    assert.strictEqual(wat.test_call_FindAtomA(strA(name)) >>> 0, local);
  });

  check('GlobalFindAtomA recovers an atom added earlier (the Tetravex path)', () => {
    const name = 'TApplication';
    const atom = wat.test_call_GlobalAddAtomA(strA(name)) >>> 0;
    assert(atom >= 0xC000);
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(wat.test_call_GlobalFindAtomA(strA(name)) >>> 0, atom);
    }
  });

  check('GlobalGetAtomNameA reads a global name back', () => {
    const atom = wat.test_call_GlobalAddAtomA(strA('GlobalName')) >>> 0;
    const buf = buffer(64);
    assert.strictEqual(wat.test_call_GlobalGetAtomNameA(atom, buf, 64), 10);
    assert.strictEqual(readA(buf, 64), 'GlobalName');
  });

  check('a name added as W is findable as A in the same table', () => {
    const atom = wat.test_call_GlobalAddAtomW(strW('WideAdded')) >>> 0;
    assert.strictEqual(wat.test_call_GlobalFindAtomA(strA('WideAdded')) >>> 0, atom);
    assert.strictEqual(wat.test_call_GlobalFindAtomW(strW('WideAdded')) >>> 0, atom);
  });

  check('a name added as A is findable as W', () => {
    const atom = wat.test_call_AddAtomA(strA('NarrowAdded')) >>> 0;
    assert.strictEqual(wat.test_call_FindAtomW(strW('NarrowAdded')) >>> 0, atom);
  });

  check('AddAtomW and GetAtomNameW round-trip', () => {
    const atom = wat.test_call_AddAtomW(strW('WideRound')) >>> 0;
    const buf = buffer(64);
    assert.strictEqual(wat.test_call_GetAtomNameW(atom, buf, 32), 9);
    assert.strictEqual(readW(buf, 32), 'WideRound');
  });

  check('GlobalGetAtomNameW reads a global name back as UTF-16', () => {
    const atom = wat.test_call_GlobalAddAtomW(strW('WideGlobal')) >>> 0;
    const buf = buffer(64);
    assert.strictEqual(wat.test_call_GlobalGetAtomNameW(atom, buf, 32), 10);
    assert.strictEqual(readW(buf, 32), 'WideGlobal');
  });

  check('a null name is rejected instead of claiming a slot', () => {
    assert.strictEqual(wat.test_call_AddAtomA(0) >>> 0, 0);
    assert.strictEqual(wat.test_call_FindAtomA(0) >>> 0, 0);
  });

  check('the table reports failure rather than overflowing', () => {
    // 128 slots per table; some are already taken by the checks above, so fill
    // until failure and confirm it degrades to 0 instead of corrupting memory.
    let last = 0;
    let added = 0;
    for (let i = 0; i < 200; i++) {
      const atom = wat.test_call_GlobalAddAtomA(strA(`Fill${i}`)) >>> 0;
      if (!atom) { last = 0; break; }
      last = atom;
      added++;
    }
    assert.strictEqual(last, 0, 'expected the table to run out and return 0');
    assert(added <= 128, `should not hand out more than 128 slots, got ${added}`);
    assert(added > 0, 'expected at least some names to fit');
  });

  for (const p of allocated) wat.guest_free(p);

  console.log(`\ntest-atom-table: ${passed}/${passed} passed`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
