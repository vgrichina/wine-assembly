#!/usr/bin/env node

'use strict';

// SHFileOperationA is the Win98 shell's bulk file-operation boundary. WinRAR
// imports it for Explorer-style file management, so a zero-returning stub is
// actively dishonest: the UI says success while the VFS never changes. Drive
// the real WAT handler and shared browser/CLI VirtualFS together here.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, hostCtx } = await bootRenderHarness({
    fonts: 'none',
    extraWat: String.raw`
      (func (export "test_sh_file_operation") (param $op i32) (result i64)
        (global.set $esp (i32.const 0x00300000))
        (call $handle_SHFileOperationA
          (local.get $op) (i32.const 0) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0))
        (i64.or
          (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $esp)) (i64.const 32))))
    `,
  });
  const vfs = hostCtx.vfs;
  let passed = 0;
  const check = (label, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  };
  const alloc = size => wat.guest_alloc(size) >>> 0;
  const putFile = (path, text) => {
    const norm = vfs._resolvePath(path);
    vfs.ensureParentDirs(norm);
    vfs.files.set(norm, { data: new Uint8Array(Buffer.from(text, 'latin1')), attrs: 0x20 });
  };
  const textAt = path => Buffer.from(vfs.files.get(vfs._resolvePath(path)).data).toString('latin1');
  const writeMultiSz = paths => {
    if (paths === null) return 0;
    const bytes = [];
    for (const path of paths) {
      for (const ch of Buffer.from(path, 'latin1')) bytes.push(ch);
      bytes.push(0);
    }
    bytes.push(0);
    const ptr = alloc(bytes.length);
    bytes.forEach((byte, i) => wat.guest_write8(ptr + i, byte));
    return ptr;
  };
  const invoke = (func, from, to = null, flags = 0) => {
    const op = alloc(32);
    for (let off = 0; off < 32; off += 4) wat.guest_write32(op + off, 0);
    wat.guest_write32(op + 4, func);
    wat.guest_write32(op + 8, writeMultiSz(from));
    wat.guest_write32(op + 12, writeMultiSz(to));
    wat.guest_write16(op + 16, flags);
    wat.guest_write32(op + 20, 0x55555555);
    wat.guest_write32(op + 24, 0xAAAAAAAA);
    const packed = wat.test_sh_file_operation(op);
    assert.strictEqual(Number(packed >> 32n), 0x00300008, 'stdcall cleanup');
    assert.strictEqual(wat.guest_read32(op + 20) >>> 0, 0, 'fAnyOperationsAborted');
    assert.strictEqual(wat.guest_read32(op + 24) >>> 0, 0, 'hNameMappings');
    return Number(packed & 0xffffffffn) >>> 0;
  };

  check('FO_COPY copies one file without consuming its source', () => {
    putFile('C:\\work\\one.txt', 'one');
    assert.strictEqual(invoke(2, ['C:\\work\\one.txt'], ['C:\\work\\copy.txt']), 0);
    assert.strictEqual(textAt('C:\\work\\one.txt'), 'one');
    assert.strictEqual(textAt('C:\\work\\copy.txt'), 'one');
  });

  check('one destination directory receives every source basename', () => {
    putFile('C:\\work\\two.bin', 'two');
    vfs.dirs.add('c:\\bulk');
    assert.strictEqual(invoke(2,
      ['C:\\work\\one.txt', 'C:\\work\\two.bin'], ['C:\\bulk']), 0);
    assert.strictEqual(textAt('C:\\bulk\\one.txt'), 'one');
    assert.strictEqual(textAt('C:\\bulk\\two.bin'), 'two');
  });

  check('FOF_MULTIDESTFILES pairs source and destination lists', () => {
    assert.strictEqual(invoke(2,
      ['C:\\work\\one.txt', 'C:\\work\\two.bin'],
      ['C:\\paired\\alpha.txt', 'C:\\paired\\beta.bin'], 0x0001), 0);
    assert.strictEqual(textAt('C:\\paired\\alpha.txt'), 'one');
    assert.strictEqual(textAt('C:\\paired\\beta.bin'), 'two');
  });

  check('wildcard sources use DOS *.* semantics and FOF_FILESONLY', () => {
    putFile('C:\\wild\\plain', 'plain');
    putFile('C:\\wild\\name.txt', 'named');
    vfs.dirs.add('c:\\wild\\folder.txt');
    vfs.dirs.add('c:\\wild-out');
    assert.strictEqual(invoke(2, ['C:\\wild\\*.*'], ['C:\\wild-out'], 0x0080), 0);
    assert.strictEqual(textAt('C:\\wild-out\\plain'), 'plain');
    assert.strictEqual(textAt('C:\\wild-out\\name.txt'), 'named');
    assert(!vfs.dirs.has('c:\\wild-out\\folder.txt'));
  });

  check('FO_RENAME is same-directory only and leaves failures untouched', () => {
    putFile('C:\\rename\\old.txt', 'rename');
    assert.strictEqual(invoke(4,
      ['C:\\rename\\old.txt'], ['C:\\elsewhere\\new.txt']), 0x73);
    assert(vfs.files.has('c:\\rename\\old.txt'));
    assert.strictEqual(invoke(4,
      ['C:\\rename\\old.txt'], ['C:\\rename\\new.txt']), 0);
    assert.strictEqual(textAt('C:\\rename\\new.txt'), 'rename');
    assert(!vfs.files.has('c:\\rename\\old.txt'));
  });

  check('directory copy recursively preserves the tree and bytes', () => {
    putFile('C:\\tree\\top.dat', 'top');
    putFile('C:\\tree\\sub\\deep.dat', 'deep');
    assert.strictEqual(invoke(2, ['C:\\tree'], ['C:\\tree-copy']), 0);
    assert(vfs.dirs.has('c:\\tree-copy\\sub'));
    assert.strictEqual(textAt('C:\\tree-copy\\top.dat'), 'top');
    assert.strictEqual(textAt('C:\\tree-copy\\sub\\deep.dat'), 'deep');
  });

  check('FO_MOVE relocates a directory tree and removes the old names', () => {
    assert.strictEqual(invoke(1, ['C:\\tree-copy'], ['C:\\tree-moved']), 0);
    assert.strictEqual(textAt('C:\\tree-moved\\sub\\deep.dat'), 'deep');
    assert(!vfs.files.has('c:\\tree-copy\\sub\\deep.dat'));
    assert(!vfs.dirs.has('c:\\tree-copy'));
  });

  check('FO_DELETE removes nonempty directory trees recursively', () => {
    assert.strictEqual(invoke(3, ['C:\\tree-moved']), 0);
    assert(!vfs.files.has('c:\\tree-moved\\top.dat'));
    assert(!vfs.dirs.has('c:\\tree-moved\\sub'));
    assert(!vfs.dirs.has('c:\\tree-moved'));
  });

  check('FOF_RENAMEONCOLLISION preserves both files under distinct names', () => {
    putFile('C:\\collision\\source.txt', 'source');
    putFile('C:\\collision\\target.txt', 'target');
    assert.strictEqual(invoke(2,
      ['C:\\collision\\source.txt'], ['C:\\collision\\target.txt'], 0x0008), 0);
    assert.strictEqual(textAt('C:\\collision\\target.txt'), 'target');
    assert.strictEqual(textAt('C:\\collision\\target (2).txt'), 'source');
  });

  check('missing and read-only sources fail instead of reporting success', () => {
    assert.strictEqual(invoke(2, ['C:\\missing.bin'], ['C:\\copy.bin']), 0x7C);
    putFile('D:\\locked.bin', 'locked');
    vfs.setDriveReadOnly('D');
    assert.strictEqual(invoke(1, ['D:\\locked.bin'], ['C:\\moved.bin']), 0x78);
    assert.strictEqual(textAt('D:\\locked.bin'), 'locked');
    assert(!vfs.files.has('c:\\moved.bin'));
  });

  check('NULL SHFILEOPSTRUCT is rejected with balanced stdcall cleanup', () => {
    const packed = wat.test_sh_file_operation(0);
    assert.strictEqual(Number(packed & 0xffffffffn), 0x7C);
    assert.strictEqual(Number(packed >> 32n), 0x00300008);
  });

  console.log(`\n${passed} checks passed`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
