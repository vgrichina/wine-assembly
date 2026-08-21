#!/usr/bin/env node

'use strict';

// Cross-thread SendMessage routing: real owner-worker execution plus the
// scheduler's reentrant A -> B -> A request/reply state machine.

const path = require('path');
const fs = require('fs');
const { GuestThreadHost } = require('../lib/guest-thread-host');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');

let passed = 0, failed = 0;
function check(ok, label, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

(async () => {
  console.log('Cross-thread SendMessage owner dispatch\n');

  // First exercise the real Worker and WAT dispatcher. The tiny WndProc returns
  // 0x12345678 with `ret 16`, exactly the stdcall shape USER expects.
  {
    const src = path.join(__dirname, '..', 'src');
    const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(src, f), 'utf8'));
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    const ctx = {
      getMemory: () => memory.buffer,
      resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
      onExit: () => {},
    };
    const imports = createHostImports(ctx);
    imports.host.memory = memory;
    for (const name of ['create_thread', 'exit_thread', 'create_event', 'set_event',
      'reset_event', 'wait_single', 'wait_multiple']) imports.host[name] = () => 0;
    const sigs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib',
      'host-import-sigs.generated.json'), 'utf8')).sigs;
    const host = new GuestThreadHost({
      memory, module, sigs, hostImports: imports.host,
      workerUrl: path.join(__dirname, '..', 'lib', 'guest-worker.js'),
      clockIntervalMs: 0,
    });
    await host.start();
    const ex = name => (...args) => host.callExport(name, ...args);
    await ex('init_thread')(0, 0x400000, 0x400000, 0x600000, 0, 0, 0);
    await ex('set_esp')(0x510000);
    await ex('set_eip')(0x401234);
    const procGuest = 0x500000;
    const procWasm = procGuest - 0x400000 + 0x12000;
    new Uint8Array(memory.buffer).set([
      0xB8, 0x78, 0x56, 0x34, 0x12, // mov eax,0x12345678
      0xC2, 0x10, 0x00,             // ret 16
    ], procWasm);
    const hwnd = 0x13579;
    await ex('test_wnd_table_set')(hwnd, procGuest);
    const before = await host.readExports(['get_eip', 'get_esp']);
    let completed = null;
    const sender = { completeThreadSend: async value => { completed = value | 0; } };
    const result = await host.resolveThreadSend(sender, {
      targetTid: 1, hwnd, msg: 0x500, wparam: 7, lparam: 9,
    });
    const after = await host.readExports(['get_eip', 'get_esp']);
    check(result === 0x12345678 && completed === 0x12345678,
      'the owner Worker returns its WndProc LRESULT to the parked sender',
      `0x${(result >>> 0).toString(16)}`);
    check(before.get_eip === after.get_eip && before.get_esp === after.get_esp,
      'owner dispatch restores the interrupted thread context');
    host.stop();
  }

  // CLI threaded mode keeps the guest main instance local. It uses the same
  // request/reply protocol through a local adapter rather than a slot-0 Worker.
  {
    const src = path.join(__dirname, '..', 'src');
    const wasmBytes = await compileWat(f => fs.promises.readFile(path.join(src, f), 'utf8'));
    const module = await WebAssembly.compile(wasmBytes);
    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    const ctx = {
      getMemory: () => memory.buffer,
      resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
      onExit: () => {},
    };
    const imports = createHostImports(ctx);
    imports.host.memory = memory;
    for (const name of ['create_thread', 'exit_thread', 'create_event', 'set_event',
      'reset_event', 'wait_single', 'wait_multiple']) imports.host[name] = () => 0;
    const local = await WebAssembly.instantiate(module, imports);
    ctx.exports = local.exports;
    local.exports.init_thread(0, 0x400000, 0x400000, 0x600000, 0, 0, 0);
    local.exports.set_esp(0x510000);
    local.exports.set_eip(0x402468);
    const procGuest = 0x500100;
    const procWasm = procGuest - 0x400000 + 0x12000;
    new Uint8Array(memory.buffer).set([
      0xB8, 0xBE, 0xBA, 0xFE, 0xCA, 0xC2, 0x10, 0x00,
    ], procWasm);
    const hwnd = 0x24680;
    local.exports.test_wnd_table_set(hwnd, procGuest);
    const host = new GuestThreadHost({
      memory, module, sigs: {}, hostImports: imports.host,
      localMainExports: () => local.exports, clockIntervalMs: 0,
    });
    await host.start();
    let completed = null;
    const result = await host.resolveThreadSend({
      completeThreadSend: async value => { completed = value | 0; },
    }, { targetTid: 1, hwnd, msg: 1, wparam: 2, lparam: 3 });
    check((result >>> 0) === 0xCAFEBABE && (completed >>> 0) === 0xCAFEBABE,
      'CLI local-main adapter executes owner callbacks and returns LRESULT');
    host.stop();
  }

  // Then isolate the reentrant scheduler protocol. B sends back to parked A;
  // A remains command-responsive, returns 77, and B resumes to return 88.
  {
    const host = new GuestThreadHost({ memory: null, module: null, sigs: {}, hostImports: {} });
    const calls = [];
    const a = {
      dispatchThreadSend: async args => { calls.push(['A', args.msg]); return { done: true, result: 77 }; },
    };
    const b = {
      dispatchThreadSend: async args => {
        calls.push(['B', args.msg]);
        return { nested: true, targetTid: 1, hwnd: 1, msg: 0xBEEF, wparam: 0, lparam: 0 };
      },
      resumeThreadSendDispatch: async value => {
        calls.push(['B-resume', value]);
        return { done: true, result: 88 };
      },
    };
    host.link = a;
    host.threadLinks.set(1, b);
    host.slotTid.set(1, 1); // guest tid 1 == Win32 thread id 2
    let completed = null;
    const sender = { completeThreadSend: async value => { completed = value | 0; } };
    const result = await host.resolveThreadSend(sender, {
      targetTid: 2, hwnd: 2, msg: 0xAAAA, wparam: 0, lparam: 0,
    });
    check(result === 88 && completed === 88 && calls.join('|') === 'B,43690|A,48879|B-resume,77',
      'nested A -> B -> A dispatch resumes each sender with the inner LRESULT');

    let aborted = null;
    const exiting = {
      dispatchThreadSend: async () => ({ blocked: true, yield: 2 }),
      abortThreadSendDispatch: async restore => { aborted = restore; },
    };
    host.threadLinks.set(2, exiting);
    host.slotTid.set(2, 2); // guest tid 2 == Win32 thread id 3
    completed = null;
    const exited = await host.resolveThreadSend(sender, {
      targetTid: 3, hwnd: 3, msg: 1, wparam: 2, lparam: 3,
    });
    check(exited === 0 && completed === 0 && aborted === false,
      'a target exit completes the sender with zero without reviving target context');
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
