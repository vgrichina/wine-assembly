#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function program() {
  const bytes = [];
  const labels = Object.create(null);
  const patches = [];
  const emit = (...values) => bytes.push(...values);
  const at = () => 0x100 + bytes.length;
  const label = name => { labels[name] = at(); };
  const rel8 = (opcode, name) => {
    emit(opcode, 0);
    patches.push({ offset: bytes.length - 1, name, next: at() });
  };
  const outputCheck = (okJump, okLabel, good) => {
    rel8(okJump, okLabel);
    emit(0xB2, 0x78);                           // mov dl,'x'
    rel8(0xEB, okLabel + '_print');             // jmp short print
    label(okLabel);
    emit(0xB2, good.charCodeAt(0));              // mov dl,good
    label(okLabel + '_print');
    emit(0xB4, 0x02, 0xCD, 0x21);               // DOS putc
  };

  emit(0xBA, 0, 0);                             // mov dx,filename
  patches.push({ offset: bytes.length - 2, name: 'filename', absolute: true });
  emit(0x31, 0xC9, 0xB4, 0x3C, 0xCD, 0x21);     // create/truncate
  emit(0x89, 0xC3, 0xB8, 0x00, 0x44, 0xCD, 0x21); // bx=ax; ioctl 4400h
  emit(0xF6, 0xC2, 0x80);                       // test dl,80h
  outputCheck(0x74, 'file_ok', 'F');             // regular file is not a device

  emit(0xBB, 0x01, 0x00, 0xB8, 0x00, 0x44, 0xCD, 0x21); // stdout ioctl
  emit(0xF6, 0xC2, 0x80);                       // test dl,80h
  outputCheck(0x75, 'device_ok', 'D');           // stdout is a device

  emit(0xBB, 0x34, 0x12, 0xB8, 0x00, 0x44, 0xCD, 0x21); // invalid handle
  outputCheck(0x72, 'invalid_ok', 'I');          // invalid handle sets carry
  emit(0xB8, 0x00, 0x4C, 0xCD, 0x21);           // exit 0
  label('filename');
  emit(...Buffer.from('IOCTL.DAT\0', 'ascii'));

  for (const patch of patches) {
    const target = labels[patch.name];
    assert.notStrictEqual(target, undefined, `missing label ${patch.name}`);
    if (patch.absolute) {
      bytes[patch.offset] = target & 0xFF;
      bytes[patch.offset + 1] = (target >> 8) & 0xFF;
    } else {
      const delta = target - patch.next;
      assert(delta >= -128 && delta <= 127, `short jump ${patch.name} is out of range`);
      bytes[patch.offset] = delta & 0xFF;
    }
  }
  return Buffer.from(bytes);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toyvm-dos-files-'));
try {
  const com = path.join(dir, 'IOCTL.COM');
  fs.writeFileSync(com, program());
  const log = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'tools', 'toyvm', 'run-dos.js'),
    com, '--dispatches=2000000', '--text',
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 22 });
  const screen = (log.match(/^  \|(.*)$/gm) || [])
    .map(line => line.slice(3).trim()).join('');
  assert.strictEqual(screen, 'FDI', `unexpected IOCTL status checks (${screen}):\n${log}`);
  assert.match(log, /exited=true/, `IOCTL test did not exit:\n${log}`);
  console.log('PASS  ToyVM distinguishes regular files, devices, and invalid IOCTL handles');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
