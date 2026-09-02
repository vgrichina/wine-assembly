#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_start_directplay_enumerate")
      (param $ansi i32) (param $callback i32) (param $context i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $ansi)
      (then
        (call $handle_DirectPlayEnumerateA
          (local.get $callback) (local.get $context) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0)))
      (else
        (call $handle_DirectPlayEnumerate
          (local.get $callback) (local.get $context) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.get $eip))

  (func (export "test_null_directplay_enumerate") (result i64)
    (global.set $eip (i32.const 0))
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_DirectPlayEnumerateA
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (i64.or
      (i64.extend_i32_u (global.get $eax))
      (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))

  (func (export "test_dp_create_group")
      (param $out i32) (param $name i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $flags))
    (call $handle_IDirectPlay3_CreateGroup
      (i32.const 0) (local.get $out) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_dp_create_player")
      (param $out i32) (param $name i32) (param $flags i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $flags))
    (call $handle_IDirectPlay3_CreatePlayer
      (i32.const 0) (local.get $out) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_dp_create_group_in_group")
      (param $parent i32) (param $out i32) (param $name i32) (param $flags i32)
      (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $gs32 (i32.add (global.get $esp) (i32.const 28)) (local.get $flags))
    (call $handle_IDirectPlay3_CreateGroupInGroup
      (i32.const 0) (local.get $parent) (local.get $out) (local.get $name)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_dp_player_membership")
      (param $group i32) (param $player i32) (param $add i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $add)
      (then (call $handle_IDirectPlay3_AddPlayerToGroup
        (i32.const 0) (local.get $group) (local.get $player)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirectPlay3_DeletePlayerFromGroup
        (i32.const 0) (local.get $group) (local.get $player)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.get $eax))

  (func (export "test_dp_set_player_name")
      (param $player i32) (param $name i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_IDirectPlay3_SetPlayerName
      (i32.const 0) (local.get $player) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_dp_get_name")
      (param $id i32) (param $type i32) (param $out i32) (param $size_ptr i32)
      (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $type)
      (then (call $handle_IDirectPlay3_GetPlayerName
        (i32.const 0) (local.get $id) (local.get $out) (local.get $size_ptr)
        (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirectPlay3_GetGroupName
        (i32.const 0) (local.get $id) (local.get $out) (local.get $size_ptr)
        (i32.const 0) (i32.const 0))))
    (global.get $eax))

  (func (export "test_dp_get_flags")
      (param $id i32) (param $type i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $type)
      (then (call $handle_IDirectPlay3_GetPlayerFlags
        (i32.const 0) (local.get $id) (local.get $out)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirectPlay3_GetGroupFlags
        (i32.const 0) (local.get $id) (local.get $out)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.get $eax))

  (func (export "test_dp_destroy")
      (param $id i32) (param $type i32) (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (local.get $type)
      (then (call $handle_IDirectPlay3_DestroyPlayer
        (i32.const 0) (local.get $id) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0)))
      (else (call $handle_IDirectPlay3_DestroyGroup
        (i32.const 0) (local.get $id) (i32.const 0)
        (i32.const 0) (i32.const 0) (i32.const 0))))
    (global.get $eax))

  (func (export "test_dp_enum")
      (param $kind i32) (param $group i32) (param $callback i32)
      (param $context i32) (param $flags i32) (result i32)
    (global.set $eip (i32.const 0))
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (if (i32.eq (local.get $kind) (i32.const 0))
      (then (call $handle_IDirectPlay3_EnumPlayers
        (i32.const 0) (i32.const 0) (local.get $callback) (local.get $context)
        (local.get $flags) (i32.const 0)))
      (else
        (if (i32.eq (local.get $kind) (i32.const 1))
          (then (call $handle_IDirectPlay3_EnumGroups
            (i32.const 0) (i32.const 0) (local.get $callback) (local.get $context)
            (local.get $flags) (i32.const 0)))
          (else
            (call $gs32 (i32.add (global.get $esp) (i32.const 24)) (local.get $flags))
            (if (i32.eq (local.get $kind) (i32.const 2))
              (then (call $handle_IDirectPlay3_EnumGroupPlayers
                (i32.const 0) (local.get $group) (i32.const 0)
                (local.get $callback) (local.get $context) (i32.const 0)))
              (else (call $handle_IDirectPlay3_EnumGroupsInGroup
                (i32.const 0) (local.get $group) (i32.const 0)
                (local.get $callback) (local.get $context) (i32.const 0))))))))
    (global.get $eip))

  (func (export "test_dp_close") (result i32)
    (global.set $esp (i32.const 0x074FF000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_IDirectPlay3_Close
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

(async () => {
  const { exports: e, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const root = path.join(__dirname, '..');
  const exe = fs.readFileSync(path.join(root, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'PE load initializes callback continuation thunks');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const callback = e.guest_alloc(16) >>> 0;
  // BOOL CALLBACK callback(...): return TRUE and pop five stdcall arguments.
  bytes.set([0xb8, 1, 0, 0, 0, 0xc2, 0x14, 0], wa(callback));

  const readAnsi = pointer => {
    let value = '';
    for (let index = 0; index < 128; index++) {
      const byte = e.guest_read8(pointer + index);
      if (!byte) break;
      value += String.fromCharCode(byte);
    }
    return value;
  };
  const runCallback = () => {
    for (let index = 0; index < 1000 && e.get_eip(); index++) e.run(1000);
    assert.strictEqual(e.get_eip(), 0, 'callback continuation restores the API caller');
    assert.strictEqual(e.get_eax(), 0, 'DirectPlayEnumerate returns DP_OK');
    assert.strictEqual(e.get_esp() >>> 0, 0x074ff00c,
      'API and callback both honor their stdcall frame sizes');
  };

  for (const [ansi, context] of [[0, 0x12345678], [1, 0x87654321]]) {
    assert.strictEqual(e.test_start_directplay_enumerate(ansi, callback, context) >>> 0,
      callback, 'enumeration enters the guest callback');
    const stack = e.get_esp() >>> 0;
    const guid = e.guest_read32(stack + 4) >>> 0;
    const name = e.guest_read32(stack + 8) >>> 0;
    assert.strictEqual(e.guest_read32(guid) >>> 0, 0x36e95ee0);
    assert.strictEqual(e.guest_read32(guid + 4) >>> 0, 0x11cf8577);
    assert.strictEqual(e.guest_read32(guid + 8) >>> 0, 0x80000c96);
    assert.strictEqual(e.guest_read32(guid + 12) >>> 0, 0x824e53c7,
      'callback receives DPSPGUID_TCPIP');
    assert.strictEqual(readAnsi(name), 'Internet TCP/IP Connection For DirectPlay');
    assert.strictEqual(e.guest_read32(stack + 12), 6, 'provider major version is 6');
    assert.strictEqual(e.guest_read32(stack + 16), 0, 'provider minor version is 0');
    assert.strictEqual(e.guest_read32(stack + 20) >>> 0, context >>> 0,
      'caller context survives callback setup');
    runCallback();
  }

  const nullResult = e.test_null_directplay_enumerate();
  assert.strictEqual(Number(nullResult & 0xffffffffn) >>> 0, 0x80070057,
    'a NULL callback returns DPERR_INVALIDPARAMS');
  assert.strictEqual(Number(nullResult >> 32n) >>> 0, 0x074ff00c,
    'invalid-parameter return still consumes the two-argument frame');

  const writeAnsi = value => {
    const pointer = e.guest_alloc(value.length + 1) >>> 0;
    bytes.set([...Buffer.from(value, 'latin1'), 0], wa(pointer));
    return pointer;
  };
  const makeName = (shortName, longName, flags) => {
    const shortPointer = writeAnsi(shortName);
    const longPointer = writeAnsi(longName);
    const name = e.guest_alloc(16) >>> 0;
    e.guest_write32(name, 16);
    e.guest_write32(name + 4, flags);
    e.guest_write32(name + 8, shortPointer);
    e.guest_write32(name + 12, longPointer);
    return { name, shortPointer, longPointer };
  };
  const u32 = value => [value, value >>> 8, value >>> 16, value >>> 24]
    .map(byte => byte & 0xff);
  const makeCountingCallback = (count, result) => {
    const proc = e.guest_alloc(24) >>> 0;
    bytes.set(Uint8Array.from([
      0xa1, ...u32(count),             // mov eax,[count]
      0x40,                            // inc eax
      0xa3, ...u32(count),             // mov [count],eax
      0xb8, ...u32(result),            // mov eax,result
      0xc2, 0x14, 0x00,                // ret 20
    ]), wa(proc));
    return proc;
  };
  const count = e.guest_alloc(4) >>> 0;
  const continueCallback = makeCountingCallback(count, 1);
  const cancelCallback = makeCountingCallback(count, 0);
  const runEntityEnum = (kind, group, callback, context, flags, expected, inspect) => {
    e.guest_write32(count, 0);
    const entered = e.test_dp_enum(kind, group, callback, context, flags) >>> 0;
    if (expected) {
      assert.strictEqual(entered, callback,
        'a non-empty DirectPlay entity enumeration enters its callback');
      if (inspect) inspect(e.get_esp() >>> 0);
    } else {
      assert.strictEqual(entered, 0,
        'an empty DirectPlay entity enumeration returns without a callback');
    }
    for (let index = 0; index < 1000 && e.get_eip(); index++) e.run(1000);
    assert.strictEqual(e.get_eip(), 0, 'entity callback continuation restores the caller');
    assert.strictEqual(e.get_eax(), 0, 'entity enumeration returns DP_OK');
    assert.strictEqual(e.guest_read32(count), expected,
      'entity enumeration invokes exactly the matching callbacks');
  };

  const groupOut = e.guest_alloc(4) >>> 0;
  const player1Out = e.guest_alloc(4) >>> 0;
  const player2Out = e.guest_alloc(4) >>> 0;
  const childOut = e.guest_alloc(4) >>> 0;
  const red = makeName('Red', 'Red team', 0x31);
  const alice = makeName('Alice', 'Alice local', 0x41);
  const bob = makeName('Bob', 'Bob local', 0x42);
  runEntityEnum(0, 0, continueCallback, 0, 0, 0);
  runEntityEnum(1, 0, continueCallback, 0, 0, 0);
  assert.strictEqual(e.test_dp_create_group(groupOut, red.name, 0x101), 0,
    'CreateGroup creates a local group');
  assert.strictEqual(e.test_dp_create_player(player1Out, alice.name, 0x201), 0,
    'CreatePlayer creates the first local player');
  assert.strictEqual(e.test_dp_create_player(player2Out, bob.name, 0x102), 0,
    'CreatePlayer creates a second local player');
  const groupId = e.guest_read32(groupOut) >>> 0;
  const player1 = e.guest_read32(player1Out) >>> 0;
  const player2 = e.guest_read32(player2Out) >>> 0;
  assert(groupId && player1 && player2, 'created DirectPlay entities receive nonzero IDs');
  assert.strictEqual(new Set([groupId, player1, player2]).size, 3,
    'created DirectPlay entities receive unique IDs');

  const sizePtr = e.guest_alloc(4) >>> 0;
  const flagsOut = e.guest_alloc(4) >>> 0;
  e.guest_write32(sizePtr, 0);
  assert.strictEqual(e.test_dp_get_name(player1, 1, 0, sizePtr) >>> 0, 0x8877001e,
    'GetPlayerName size query returns DPERR_BUFFERTOOSMALL');
  const playerNameSize = e.guest_read32(sizePtr) >>> 0;
  assert.strictEqual(playerNameSize, 34,
    'GetPlayerName reports DPNAME plus both retained strings');
  const playerNameOut = e.guest_alloc(playerNameSize) >>> 0;
  e.guest_write32(sizePtr, playerNameSize - 1);
  assert.strictEqual(
    e.test_dp_get_name(player1, 1, playerNameOut, sizePtr) >>> 0, 0x8877001e,
    'GetPlayerName rejects an undersized non-null buffer');
  assert.strictEqual(e.guest_read32(sizePtr), playerNameSize,
    'undersized GetPlayerName republishes the required size');
  assert.strictEqual(e.test_dp_get_name(player1, 1, playerNameOut, sizePtr), 0,
    'GetPlayerName fills a sufficiently sized buffer');
  assert.strictEqual(e.guest_read32(playerNameOut), 16,
    'GetPlayerName returns a DPNAME header');
  assert.strictEqual(e.guest_read32(playerNameOut + 4), 0x41,
    'GetPlayerName preserves application DPNAME flags');
  assert.strictEqual(readAnsi(e.guest_read32(playerNameOut + 8) >>> 0), 'Alice',
    'GetPlayerName packs the retained short name into the caller buffer');
  assert.strictEqual(readAnsi(e.guest_read32(playerNameOut + 12) >>> 0), 'Alice local',
    'GetPlayerName packs the retained long name into the caller buffer');
  assert.strictEqual(e.test_dp_get_flags(player1, 1, flagsOut), 0,
    'GetPlayerFlags accepts a live player');
  assert.strictEqual(e.guest_read32(flagsOut), 0x209,
    'GetPlayerFlags reports creation flags plus DPPLAYER_LOCAL');
  assert.strictEqual(e.test_dp_get_flags(groupId, 0, flagsOut), 0,
    'GetGroupFlags accepts a live group');
  assert.strictEqual(e.guest_read32(flagsOut), 0x109,
    'GetGroupFlags reports creation flags plus DPGROUP_LOCAL');

  e.guest_write32(sizePtr, 0);
  assert.strictEqual(e.test_dp_get_name(groupId, 0, 0, sizePtr) >>> 0, 0x8877001e,
    'GetGroupName exposes the same two-call buffer contract');
  const groupNameSize = e.guest_read32(sizePtr) >>> 0;
  const groupNameOut = e.guest_alloc(groupNameSize) >>> 0;
  assert.strictEqual(e.test_dp_get_name(groupId, 0, groupNameOut, sizePtr), 0,
    'GetGroupName fills the caller buffer');
  assert.strictEqual(readAnsi(e.guest_read32(groupNameOut + 8) >>> 0), 'Red',
    'GetGroupName returns the retained group name');

  // The provider owns the name after CreatePlayer. Overwriting the caller's
  // source proves enumeration receives a retained copy, not a borrowed stack
  // pointer that happened to remain readable.
  bytes[wa(alice.shortPointer)] = 'X'.charCodeAt(0);
  runEntityEnum(0, 0, continueCallback, 0x12345678, 0, 2, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, player1,
      'EnumPlayers begins with the first live player ID');
    assert.strictEqual(e.guest_read32(stack + 8), 1,
      'EnumPlayers reports DPPLAYERTYPE_PLAYER');
    const name = e.guest_read32(stack + 12) >>> 0;
    assert.strictEqual(e.guest_read32(name), 16, 'callback DPNAME has the Win32 size');
    assert.strictEqual(e.guest_read32(name + 4), 0x41,
      'callback DPNAME preserves its flags');
    assert.strictEqual(readAnsi(e.guest_read32(name + 8) >>> 0), 'Alice',
      'CreatePlayer retained its own short-name copy');
    assert.strictEqual(readAnsi(e.guest_read32(name + 12) >>> 0), 'Alice local',
      'CreatePlayer retained its own long-name copy');
    assert.strictEqual(e.guest_read32(stack + 16), 0x209,
      'EnumPlayers reports the player creation flags plus DPPLAYER_LOCAL');
    assert.strictEqual(e.guest_read32(stack + 20) >>> 0, 0x12345678,
      'EnumPlayers preserves the caller context');
  });
  runEntityEnum(0, 0, cancelCallback, 0, 0, 1,
    null);

  runEntityEnum(1, 0, continueCallback, 0, 0, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, groupId,
      'EnumGroups reports the live group ID');
    assert.strictEqual(e.guest_read32(stack + 8), 0,
      'EnumGroups reports DPPLAYERTYPE_GROUP');
    assert.strictEqual(e.guest_read32(stack + 16), 0x109,
      'EnumGroups reports DPGROUP_LOCAL for a locally created group');
  });
  runEntityEnum(0, 0, continueCallback, 0, 0x08, 2,
    null);
  runEntityEnum(0, 0, continueCallback, 0, 0x10, 0,
    null);
  runEntityEnum(0, 0, continueCallback, 0, 0x20, 3,
    null);
  runEntityEnum(0, 0, continueCallback, 0, 0x200, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, player1,
      'SPECTATOR filtering returns only the flagged player');
  });
  assert.strictEqual(e.test_dp_player_membership(groupId, player1, 1), 0,
    'AddPlayerToGroup records local membership');
  runEntityEnum(2, groupId, continueCallback, 0, 0, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, player1,
      'EnumGroupPlayers reports only the attached player');
  });

  const blue = makeName('Blue', 'Blue subgroup', 0x51);
  assert.strictEqual(
    e.test_dp_create_group_in_group(groupId, childOut, blue.name, 0x301), 0,
    'CreateGroupInGroup creates and links a child group');
  const childId = e.guest_read32(childOut) >>> 0;
  runEntityEnum(3, groupId, continueCallback, 0, 0, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, childId,
      'EnumGroupsInGroup reports the linked child');
  });

  const carol = makeName('Carol', 'Carol renamed', 0x61);
  assert.strictEqual(e.test_dp_set_player_name(player1, carol.name), 0,
    'SetPlayerName replaces the retained name');
  bytes[wa(carol.shortPointer)] = 'Y'.charCodeAt(0);
  runEntityEnum(2, groupId, continueCallback, 0, 0, 1, stack => {
    const name = e.guest_read32(stack + 12) >>> 0;
    assert.strictEqual(readAnsi(e.guest_read32(name + 8) >>> 0), 'Carol',
      'SetPlayerName retained its own replacement copy');
  });

  assert.strictEqual(e.test_dp_player_membership(groupId, player1, 0), 0,
    'DeletePlayerFromGroup removes local membership');
  runEntityEnum(2, groupId, continueCallback, 0, 0, 0);
  assert.strictEqual(e.test_dp_destroy(player1, 1), 0,
    'DestroyPlayer removes the first player');
  runEntityEnum(0, 0, continueCallback, 0, 0, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, player2,
      'EnumPlayers skips the destroyed player');
  });
  assert.strictEqual(e.test_dp_destroy(player1, 1) >>> 0, 0x80070057,
    'DestroyPlayer rejects an already-destroyed ID');
  assert.strictEqual(e.test_dp_get_flags(player1, 1, flagsOut) >>> 0, 0x80070057,
    'GetPlayerFlags rejects a destroyed player');
  assert.strictEqual(e.guest_read32(flagsOut), 0,
    'failed GetPlayerFlags clears its output');

  assert.strictEqual(e.test_dp_destroy(groupId, 0), 0,
    'DestroyGroup removes the parent group');
  runEntityEnum(1, 0, continueCallback, 0, 0, 1, stack => {
    assert.strictEqual(e.guest_read32(stack + 4) >>> 0, childId,
      'destroying a parent leaves the child as a live top-level group');
  });
  assert.strictEqual(e.test_dp_enum(2, groupId, continueCallback, 0, 0), 0,
    'EnumGroupPlayers rejects a destroyed group without entering the callback');
  assert.strictEqual(e.get_eax() >>> 0, 0x80070057,
    'a destroyed enumeration target returns an invalid-parameter error');

  assert.strictEqual(e.test_dp_close(), 0, 'Close releases all local entities');
  runEntityEnum(0, 0, continueCallback, 0, 0, 0);
  runEntityEnum(1, 0, continueCallback, 0, 0, 0);

  console.log('PASS  DirectPlay local entities retain, query, and enumerate with Win98 semantics');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
