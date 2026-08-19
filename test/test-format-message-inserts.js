#!/usr/bin/env node

'use strict';

// FormatMessage's template language is not printf. %1..%99 name the Arguments
// entries positionally, %0 ends the message, and the escapes (%%, %., %!, %b,
// %r, %n) are their own small alphabet. The handler used to ignore all of it
// and strcpy the template, so RegEdit's "Cannot create key: Error while
// opening the key %1." reached the user with the %1 still in it.
//
// These cases go straight at $format_message_expand, because the interesting
// behaviour — measure mode, truncation, a spec that changes how an argument is
// read — is hard to provoke through an app and easy to state here.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

async function main() {
  const root = path.join(__dirname, '..');
  const wasm = await compileWat(file => fs.promises.readFile(path.join(root, 'src', file), 'utf8'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { getMemory: () => memory.buffer, renderer: null, resourceJson: {} };
  const base = createHostImports(ctx);
  base.host.memory = memory;
  base.host.create_thread = () => 0;
  base.host.exit_thread = () => 0;
  base.host.create_event = () => 0;
  base.host.set_event = () => 0;
  base.host.reset_event = () => 0;
  base.host.wait_single = () => 0;
  base.host.wait_multiple = () => 0;
  base.host.com_create_instance = () => 0x80004002;
  const { instance } = await WebAssembly.instantiate(wasm, base);
  const wat = instance.exports;
  ctx.exports = wat;

  const putStr = (s) => {
    const g = wat.guest_alloc(s.length + 1) >>> 0;
    for (let i = 0; i < s.length; i++) wat.guest_write8(g + i, s.charCodeAt(i));
    wat.guest_write8(g + s.length, 0);
    return g;
  };
  const getStr = (g) => {
    let out = '';
    for (let i = 0; ; i++) {
      const c = wat.guest_read8(g + i) & 0xFF;
      if (!c) return out;
      out += String.fromCharCode(c);
    }
  };
  // Arguments is a flat array of DWORDs — a va_list on x86 is exactly that,
  // so FORMAT_MESSAGE_ARGUMENT_ARRAY needs no separate representation.
  const putArgs = (vals) => {
    const g = wat.guest_alloc(4 * Math.max(vals.length, 1)) >>> 0;
    vals.forEach((v, i) => wat.guest_write32(g + 4 * i, v));
    return g;
  };

  const expand = (template, args) => {
    const src = putStr(template);
    const argv = args === null ? 0 : putArgs(args);
    const need = wat.test_format_message_expand(src, 0, 0, argv);   // measure
    const dst = wat.guest_alloc(need + 1) >>> 0;
    const wrote = wat.test_format_message_expand(src, dst, need + 1, argv);
    assert.strictEqual(wrote, need, `measure and write disagree for ${JSON.stringify(template)}`);
    return { text: getStr(dst), len: need };
  };

  const cases = [];
  const check = (name, actual, expected) => {
    const pass = actual === expected;
    cases.push({ name, pass, actual, expected });
  };

  const name = putStr('My Computer');
  const other = putStr('HKEY_CLASSES_ROOT');

  check('plain text is copied unchanged',
    expand('nothing to expand', []).text, 'nothing to expand');

  check('%1 becomes the first argument',
    expand('Error while opening the key %1.', [name]).text,
    'Error while opening the key My Computer.');

  check('arguments are positional, not sequential',
    expand('%2 then %1 then %2', [name, other]).text,
    'HKEY_CLASSES_ROOT then My Computer then HKEY_CLASSES_ROOT');

  check('%% is one percent', expand('100%% done', []).text, '100% done');

  check('escapes: %. %! %b', expand('a%.b%!c%bd', []).text, 'a.b!c d');

  check('%n is a hard line break', expand('one%ntwo', []).text, 'one\r\ntwo');

  check('%0 ends the message', expand('kept%0dropped', []).text, 'kept');

  check('a two-digit index is one insert, not %1 followed by 0',
    expand('%10', [1, 2, 3, 4, 5, 6, 7, 8, 9, other]).text, 'HKEY_CLASSES_ROOT');

  check('!d! reads the argument as a signed number',
    expand('code %1!d!', [-17]).text, 'code -17');

  check('!u! reads it unsigned',
    expand('code %1!u!', [0xFFFFFFFF]).text, 'code 4294967295');

  check('!x! reads it as hex',
    expand('code %1!x!', [0xDEAD]).text, 'code dead');

  check('a spec with width still finds the value',
    expand('[%1!8d!]', [42]).text, '[42]');

  check('no Arguments leaves the insert visible',
    expand('key %1 missing', null).text, 'key %1 missing');

  // Truncation: the return value is the length the message wanted, and the
  // buffer still ends in a NUL. This is what an ALLOCATE_BUFFER-less caller
  // with a short nSize sees.
  {
    const src = putStr('%1 is long');
    const argv = putArgs([name]);
    const dst = wat.guest_alloc(64) >>> 0;
    for (let i = 0; i < 64; i++) wat.guest_write8(dst + i, 0x7F);
    const need = wat.test_format_message_expand(src, dst, 6, argv);
    check('truncation still reports the full length', need, 'My Computer is long'.length);
    check('truncation NUL-terminates inside the buffer', getStr(dst), 'My Co');
  }

  let failed = 0;
  for (const c of cases) {
    if (c.pass) {
      console.log(`PASS  ${c.name}`);
    } else {
      failed++;
      console.log(`FAIL  ${c.name}`);
      console.log(`        expected ${JSON.stringify(c.expected)}`);
      console.log(`        actual   ${JSON.stringify(c.actual)}`);
    }
  }
  console.log('');
  console.log(`${cases.length - failed}/${cases.length} checks passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
