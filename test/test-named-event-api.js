#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_named_event_init")
    (global.set $image_base (i32.const 0)))
  (func (export "test_open_event_a") (param $name i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_OpenEventA (i32.const 0x001f0003) (i32.const 0)
      (local.get $name) (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_create_event_a") (param $name i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_CreateEventA (i32.const 0) (i32.const 1) (i32.const 0)
      (local.get $name) (i32.const 0) (i32.const 0))
    (global.get $eax))
  (func (export "test_named_event_last_error") (result i32)
    (global.get $last_error))
`;

(async () => {
  let memory = null;
  let existingHandle = 0;
  const created = [];
  const readName = ptr => {
    const bytes = new Uint8Array(memory.buffer);
    let value = '';
    for (let i = ptr; bytes[i]; i++) value += String.fromCharCode(bytes[i]);
    return value;
  };
  const harness = await bootRenderHarness({
    extraWat,
    extraHostOverrides: {
      open_event: (nameWa, wide) => {
        assert.strictEqual(wide, 0);
        return readName(nameWa) === 'StarcraftSetupEvent' ? existingHandle : 0;
      },
      create_event: (manual, initial, nameWa, wide) => {
        created.push({ manual, initial, name: readName(nameWa), wide });
        return 0xE0007;
      },
    },
  });
  memory = harness.memory;
  const wat = harness.exports;
  wat.test_named_event_init();

  const name = 0x2000;
  'StarcraftSetupEvent'.split('').forEach((ch, i) => wat.guest_write8(name + i, ch.charCodeAt(0)));
  wat.guest_write8(name + 'StarcraftSetupEvent'.length, 0);

  assert.strictEqual(wat.test_open_event_a(name), 0,
    'OpenEventA reports a missing named event');
  assert.strictEqual(wat.test_named_event_last_error(), 2,
    'a missing event sets ERROR_FILE_NOT_FOUND');

  assert.strictEqual(wat.test_create_event_a(name), 0xE0007,
    'CreateEventA creates the missing event through the shared host table');
  assert.deepStrictEqual(created, [{
    manual: 1, initial: 0, name: 'StarcraftSetupEvent', wide: 0,
  }]);
  assert.strictEqual(wat.test_named_event_last_error(), 0);

  existingHandle = 0xE0007;
  assert.strictEqual(wat.test_open_event_a(name), existingHandle,
    'OpenEventA returns the existing process-local handle');
  assert.strictEqual(wat.test_create_event_a(name), existingHandle,
    'CreateEventA opens an existing same-name event');
  assert.strictEqual(wat.test_named_event_last_error(), 183,
    'opening through CreateEventA sets ERROR_ALREADY_EXISTS');
  assert.strictEqual(created.length, 1,
    'CreateEventA does not allocate a second object for the same name');

  console.log('PASS  named event API preserves lookup, creation, and last-error contracts');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
