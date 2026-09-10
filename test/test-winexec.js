#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');
const { parseShellLaunchCommand, resolveShellLaunchPath } = require('../host.js');

const extraWat = String.raw`
  (func (export "test_call_WinExec")
        (param $command i32) (param $show i32) (param $name i32) (result i32)
    (global.set $esp (i32.const 0))
    (call $handle_WinExec
      (local.get $command) (local.get $show) (i32.const 0)
      (i32.const 0) (i32.const 0) (call $g2w (local.get $name)))
    (global.get $eax))
  (func (export "test_winexec_esp") (result i32) (global.get $esp))
`;

function checkParsing() {
  assert.deepStrictEqual(
    parseShellLaunchCommand('  "C:\\Program Files\\WinRAR\\WinRAR.exe" x archive.rar  ', '', 'WinExec'),
    {
      file: 'C:\\Program Files\\WinRAR\\WinRAR.exe',
      params: 'x archive.rar',
      isWinExec: true,
    },
    'WinExec treats a quoted long executable name as one token');
  assert.deepStrictEqual(
    parseShellLaunchCommand('child.exe /S /D=C:\\Games', '', 'winexec'),
    { file: 'child.exe', params: '/S /D=C:\\Games', isWinExec: true },
    'WinExec splits an unquoted relative command at its first whitespace');
  assert.deepStrictEqual(
    parseShellLaunchCommand('Program Files\\Tool.exe', '', 'open'),
    { file: 'Program Files\\Tool.exe', params: '', isWinExec: false },
    'ShellExecute keeps its separately supplied unquoted lpFile intact');
  assert.deepStrictEqual(
    parseShellLaunchCommand('C:\\Program Files\\Tool.exe', '', 'open'),
    { file: 'C:\\Program Files\\Tool.exe', params: '', isWinExec: false },
    'ShellExecute keeps an absolute unquoted long path intact');
  assert.deepStrictEqual(
    parseShellLaunchCommand('C:\\Black and White Setup.exe -deleter', '', 'open'),
    {
      file: 'C:\\Black and White Setup.exe',
      params: '-deleter',
      isWinExec: false,
    },
    'ShellExecute splits an InstallShield unquoted whole command at its executable suffix');
  assert.deepStrictEqual(
    parseShellLaunchCommand('"C:\\Black and White Setup.exe -deleter"', '', 'open'),
    {
      file: 'C:\\Black and White Setup.exe',
      params: '-deleter',
      isWinExec: false,
    },
    'ShellExecute accepts InstallShield legacy whole-command quoting');
  assert.strictEqual(
    resolveShellLaunchPath('child.exe', { _resolvePath: p => `c:\\games\\${p}` }, true),
    'c:\\games\\child.exe',
    'a relative WinExec program is searched from the caller VFS directory');
  assert.strictEqual(resolveShellLaunchPath('child.exe', null, true), 'child.exe');
  const cwd = { _resolvePath: p => `c:\\games\\${p}` };
  assert.strictEqual(resolveShellLaunchPath('child', cwd, true), 'c:\\games\\child.exe',
    'WinExec supplies the default executable extension');
  assert.strictEqual(resolveShellLaunchPath('c:\\games\\child', cwd, true), 'c:\\games\\child.exe',
    'absolute WinExec paths also receive the default extension');
  assert.strictEqual(resolveShellLaunchPath('v1.0\\child', cwd, true), 'c:\\games\\v1.0\\child.exe',
    'dots in directory components are not file extensions');
  assert.strictEqual(resolveShellLaunchPath('child.com', cwd, true), 'c:\\games\\child.com');
  assert.strictEqual(resolveShellLaunchPath('child.', cwd, true), 'c:\\games\\child.');
  assert.strictEqual(resolveShellLaunchPath('child', cwd, false), 'child',
    'ShellExecute document names are not changed by WinExec extension rules');
  assert.strictEqual(resolveShellLaunchPath('child', null, true), 'child.exe');
  assert.strictEqual(resolveShellLaunchPath('', cwd, true), '', 'empty commands remain invalid');
}

async function main() {
  checkParsing();
  let memory;
  let returnCode = 33;
  const launches = [];
  const readString = ptr => {
    if (!ptr) return '';
    const bytes = new Uint8Array(memory.buffer);
    let end = ptr;
    while (bytes[end]) end++;
    return Buffer.from(bytes.subarray(ptr, end)).toString('latin1');
  };
  const harness = await bootRenderHarness({
    extraWat,
    fonts: 'none',
    extraHostOverrides: {
      shell_execute(hwnd, op, file, params, dir, show) {
        launches.push({
          hwnd, op: readString(op), file: readString(file), params, dir, show,
        });
        return returnCode;
      },
    },
  });
  memory = harness.memory;
  const e = harness.exports;
  const writeString = value => {
    const ptr = e.guest_alloc(value.length + 1) >>> 0;
    for (let i = 0; i < value.length; i++) e.guest_write8(ptr + i, value.charCodeAt(i));
    e.guest_write8(ptr + value.length, 0);
    return ptr;
  };
  const command = writeString('child.exe /S');
  const name = writeString('WinExec');

  assert.strictEqual(e.test_call_WinExec(command, 7, name), 33,
    'WinExec returns the host launch success code');
  assert.deepStrictEqual(launches.pop(), {
    hwnd: 0, op: 'WinExec', file: 'child.exe /S', params: 0, dir: 0, show: 7,
  }, 'WinExec forwards its full command line and nCmdShow with an operation marker');
  assert.strictEqual(e.test_winexec_esp(), 12, 'WinExec pops its two stdcall arguments');

  returnCode = 2;
  assert.strictEqual(e.test_call_WinExec(command, 1, name), 2,
    'WinExec preserves the documented host failure code instead of claiming success');
  assert.strictEqual(e.test_call_WinExec(0, 1, name), 2,
    'a missing command line is allowed to fail through the same host contract');

  console.log('PASS  WinExec delegates real browser launches with Win98 command parsing and return codes');
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
