#!/usr/bin/env node

'use strict';

// Naming a C++ throw.
//
// An MFC app that fails during startup dies the same way whatever went wrong:
// the throw walks the SEH chain, the CRT's outer __except accepts it, and the
// process leaves through ExitProcess(0xE06D7363). That code says "a C++
// exception happened" and nothing else -- CResourceException (a missing
// dialog template), CFileException (a file the VFS does not have) and
// CMemoryException all look identical from outside.
//
// MSVC packs the type into the throw itself: lpArguments is
// { magic, object*, ThrowInfo* }, ThrowInfo+12 points at a CatchableTypeArray,
// and each CatchableType's +4 is a TypeDescriptor whose name starts at +8.
// That chain is what turns the exit code back into a diagnosis, so the host
// decodes it at the moment of the throw, while the payload still exists.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_cxx_throw") (param $args i32)
    (global.set $image_base (i32.const 0))
    (call $host_cxx_throw (local.get $args)))
`;

function writeStr(wat, addr, text) {
  for (let i = 0; i < text.length; i++) wat.guest_write8(addr + i, text.charCodeAt(i));
  wat.guest_write8(addr + text.length, 0);
}

function captureStderr(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.error = original; }
  return lines.join('\n');
}

(async () => {
  const { exports: wat } = await bootRenderHarness({ extraWat });

  const ARGS = 0x2700;
  const OBJ = 0x2740;
  const THROW_INFO = 0x2780;
  const CTA = 0x27c0;
  const CT0 = 0x2800, CT1 = 0x2840;
  const TYPE0 = 0x2880, TYPE1 = 0x28c0;

  wat.guest_write32(ARGS + 0, 0x19930520);   // MSVC throw magic
  wat.guest_write32(ARGS + 4, OBJ);
  wat.guest_write32(ARGS + 8, THROW_INFO);
  wat.guest_write32(THROW_INFO + 12, CTA);
  // Two catchable types: the thrown class and the base it derives from, which
  // is how a `catch (CException*)` matches a CResourceException.
  wat.guest_write32(CTA + 0, 2);
  wat.guest_write32(CTA + 4, CT0);
  wat.guest_write32(CTA + 8, CT1);
  wat.guest_write32(CT0 + 4, TYPE0);
  wat.guest_write32(CT1 + 4, TYPE1);
  writeStr(wat, TYPE0 + 8, '.?AVCResourceException@@');
  writeStr(wat, TYPE1 + 8, '.?AVCException@@');

  const named = captureStderr(() => wat.test_cxx_throw(ARGS));
  assert.ok(/\[C\+\+ throw\]/.test(named), `expected a [C++ throw] line, got: ${named}`);
  assert.ok(named.includes('.?AVCResourceException@@'),
    `the thrown type must be named, got: ${named}`);
  assert.ok(named.includes('.?AVCException@@'),
    `the base types must be named too, got: ${named}`);

  // `throw;` inside a catch block rethrows with a null ThrowInfo. There is no
  // type to read, and following the null would decode guest address 12 as a
  // CatchableTypeArray and print whatever happens to live there.
  wat.guest_write32(ARGS + 8, 0);
  const rethrow = captureStderr(() => wat.test_cxx_throw(ARGS));
  assert.ok(/rethrow/.test(rethrow), `a null ThrowInfo is a rethrow, got: ${rethrow}`);
  assert.ok(!rethrow.includes('CResourceException'),
    'a rethrow must not invent a type name from stale memory');

  // A null lpArguments is legal input to RaiseException and must be silent
  // rather than fatal -- the reporter is diagnostics, never a second fault.
  const empty = captureStderr(() => wat.test_cxx_throw(0));
  assert.strictEqual(empty, '', `a null payload reports nothing, got: ${empty}`);

  console.log('PASS  C++ throw payload decodes to type names, survives rethrow and null');
})().catch(err => { console.error(err); process.exit(1); });
