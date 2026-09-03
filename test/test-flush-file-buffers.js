#!/usr/bin/env node

'use strict';

// FlushFileBuffers has no deferred work in the synchronous in-memory VFS, but
// it must not turn every handle into a successful disk flush. Pin both halves:
// immediate durability for a writable file and Win32 BOOL/LastError behavior
// for read-only, closed, invalid, and console handles.

const assert = require('assert');
const { createFilesystemImports } = require('../lib/filesystem');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const memory = new WebAssembly.Memory({ initial: 2 });
  const ctx = { getMemory: () => memory.buffer };
  const host = createFilesystemImports(ctx);

  const writable = ctx.vfs.createFile('C:\\archive.rar', 0x40000000, 2);
  assert(writable, 'writable archive opens');
  assert.deepStrictEqual(
    ctx.vfs.writeFile(writable, Uint8Array.of(0x52, 0x61, 0x72, 0x21), 4),
    { ok: true, bytesWritten: 4 },
    'archive bytes are committed synchronously');
  assert.strictEqual(host.fs_flush_file_buffers(writable), 0,
    'a live GENERIC_WRITE file flushes successfully');
  assert.deepStrictEqual(Array.from(ctx.vfs.files.get('c:\\archive.rar').data),
    [0x52, 0x61, 0x72, 0x21], 'successful flush observes committed bytes');

  const readOnly = ctx.vfs.createFile('C:\\archive.rar', 0x80000000, 3);
  assert(readOnly, 'read-only view of the archive opens');
  assert.strictEqual(host.fs_flush_file_buffers(readOnly), 5,
    'a handle without GENERIC_WRITE reports ERROR_ACCESS_DENIED');
  assert.strictEqual(host.fs_flush_file_buffers(0xDEADBEEF), 6,
    'an unknown handle reports ERROR_INVALID_HANDLE');
  assert.strictEqual(host.fs_flush_file_buffers(2), 6,
    'a console output handle is not treated as a buffered disk file');
  assert(ctx.vfs.closeHandle(writable), 'writable fixture closes');
  assert.strictEqual(host.fs_flush_file_buffers(writable), 6,
    'a closed file handle reports ERROR_INVALID_HANDLE');

  const calls = [];
  const { exports: wat } = await bootRenderHarness({
    extraWat: String.raw`
      (func (export "test_flush_file_buffers") (param $handle i32) (param $seed_error i32) (result i64)
        (global.set $last_error (local.get $seed_error))
        (global.set $esp (i32.const 0x00300000))
        (call $handle_FlushFileBuffers
          (local.get $handle) (i32.const 0) (i32.const 0)
          (i32.const 0) (i32.const 0) (i32.const 0))
        (i64.or
          (i64.extend_i32_u (global.get $eax))
          (i64.shl (i64.extend_i32_u (global.get $last_error)) (i64.const 32))))
    `,
    extraHostOverrides: {
      fs_flush_file_buffers: handle => {
        calls.push(handle >>> 0);
        return handle === 0x77 ? 0 : handle === 0x88 ? 5 : 6;
      },
    },
  });

  let result = wat.test_flush_file_buffers(0x77, 0x1234);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 1,
    'successful host validation becomes TRUE');
  assert.strictEqual(Number(result >> 32n), 0x1234,
    'success does not invent a new LastError value');
  assert.strictEqual(wat.get_esp() >>> 0, 0x00300008,
    'FlushFileBuffers pops its return address and one stdcall argument');

  result = wat.test_flush_file_buffers(0x88, 0x4321);
  assert.strictEqual(Number(result & 0xFFFFFFFFn), 0,
    'host rejection becomes FALSE');
  assert.strictEqual(Number(result >> 32n), 5,
    'host failure publishes its Win32 error through GetLastError');
  assert.deepStrictEqual(calls, [0x77, 0x88],
    'the original handle reaches the host exactly once per call');

  console.log('PASS  FlushFileBuffers validates a live writable VFS file');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
