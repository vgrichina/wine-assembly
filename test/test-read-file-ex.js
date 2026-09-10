#!/usr/bin/env node
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const {bootRenderHarness}=require('./render-helper');
const sleepId=require('../src/api_table.json').find(a=>a.name==='SleepEx').id;
const extraWat=`
  (func (export "sleep_thunk") (result i32)
    (call $gl32 (call $init_com_vtable (i32.const ${sleepId}) (i32.const 1))))
  (func (export "start_inline") (param $code i32)
    (global.set $esp (i32.const 0x07000000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $eip (local.get $code)))
  (func (export "read_ex") (param $h i32) (param $buf i32) (param $count i32) (param $ov i32) (param $cb i32) (result i32)
    (global.set $esp (i32.const 0x07000000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (call $handle_ReadFileEx (local.get $h) (local.get $buf) (local.get $count) (local.get $ov) (local.get $cb) (i32.const 0))
    (global.get $eax))
  (func (export "alert") (param $alertable i32) (param $object i32)
    (global.set $esp (i32.const 0x07000000))
    (call $gs32 (global.get $esp) (i32.const 0))
    (global.set $eip (i32.const 0))
    (if (local.get $object) (then
      (call $handle_WaitForSingleObjectEx (i32.const 1) (i32.const 0) (local.get $alertable) (i32.const 0) (i32.const 0) (i32.const 0)))
    (else (call $handle_SleepEx (i32.const 0) (local.get $alertable) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))))
`;
const u32=n=>[n&255,n>>>8&255,n>>>16&255,n>>>24&255];
(async()=>{
  const {exports:e,memory,hostCtx,host}=await bootRenderHarness({fonts:'none',extraWat});
  const pe=fs.readFileSync(path.join(__dirname,'binaries/calc.exe'));
  new Uint8Array(memory.buffer).set(pe,e.get_staging());assert.ok(e.load_pe(pe.length));
  const alloc=n=>e.guest_alloc(n)>>>0,read=p=>e.guest_read32(p)>>>0,write=(p,n)=>e.guest_write32(p,n);
  const buf=alloc(64),ov=alloc(40),seen=alloc(80),cb=alloc(100);
  for(let i=0;i<80;i+=4)write(seen+i,0);
  const code=[0x8b,0x0d,...u32(seen), // ecx=count
    0x8b,0x44,0x24,4,0x89,0x04,0x8d,...u32(seen+4),
    0x8b,0x44,0x24,8,0x89,0x04,0x8d,...u32(seen+20),
    0x8b,0x44,0x24,12,0x89,0x04,0x8d,...u32(seen+36),
    0x41,0x89,0x0d,...u32(seen),0xc2,12,0];
  new Uint8Array(memory.buffer).set(code,e.guest_to_wasm(cb));
  const vfs=hostCtx.vfs;
  vfs.files.set('c:\\apc.bin',{data:Uint8Array.from([10,11,12,13,14,15]),attrs:0x20});
  const h=vfs.createFile('c:\\apc.bin',0x80000000,3);assert.ok(h);
  vfs.handles.get(h).pos=4;
  const init=(p,offset)=>{for(let i=0;i<20;i+=4)write(p+i,0);write(p+8,offset);write(p+16,0xdecafbad);};
  init(ov,1);init(ov+20,99);
  assert.strictEqual(e.read_ex(h,buf,3,ov,cb),1);
  assert.strictEqual(read(buf)&0xffffff,0x0d0c0b);assert.strictEqual(read(ov+4),3);
  assert.strictEqual(read(ov+16),0xdecafbad,'hEvent belongs to the caller');
  assert.strictEqual(vfs.handles.get(h).pos,4,'overlapped offset does not move file cursor');
  assert.strictEqual(read(seen),0,'completion is never called inline');
  assert.strictEqual(e.read_ex(h,buf+8,3,ov+20,cb),1);
  assert.strictEqual(read(ov+20),0xc0000011,'EOF status stored in OVERLAPPED');
  e.alert(0,0);assert.strictEqual(read(seen),0,'nonalertable sleep does not dispatch');
  e.clear_yield();e.alert(1,0);
  for(let i=0;i<20&&e.get_eip();i++)e.run(1000);
  assert.strictEqual(read(seen),2);assert.strictEqual(e.get_eax()>>>0,0xc0);
  assert.strictEqual(e.get_esp()>>>0,0x0700000c,'callback and SleepEx stack cleanup');
  assert.deepStrictEqual([read(seen+4),read(seen+8)],[0,38]);
  assert.deepStrictEqual([read(seen+20),read(seen+24)],[3,0]);
  assert.deepStrictEqual([read(seen+36),read(seen+40)],[ov,ov+20]);
  init(ov,4);assert.strictEqual(e.read_ex(h,buf,8,ov,cb),1);
  e.alert(1,1);for(let i=0;i<20&&e.get_eip();i++)e.run(1000);
  assert.strictEqual(read(seen),3);assert.strictEqual(read(seen+28),2,'partial EOF completes successfully');
  assert.strictEqual(e.get_esp()>>>0,0x07000010,'WaitForSingleObjectEx cleanup');
  assert.strictEqual(e.read_ex(0,buf,1,ov,cb),0);assert.strictEqual(e.read_ex(h,buf,1,0,cb),0);
  assert.strictEqual(host.fs_read_file_at(h,buf,1,ov,0,0x200000),87,'unsafe 64-bit offset rejected');
  assert.strictEqual(vfs.handles.get(h).pos,4);
  // Regression: a direct handler invocation cannot detect the CALL-reg path
  // overwriting callback EIP unless the callback continuation also clears steps.
  const caller=alloc(64),after=seen+64;
  const thunk=e.sleep_thunk()>>>0;
  new Uint8Array(memory.buffer).set([
    0x6a,1,0x6a,0,0xb8,...u32(thunk),0xff,0xd0,
    0xa3,...u32(after),0xc3,
  ],e.guest_to_wasm(caller));
  init(ov,0);assert.strictEqual(e.read_ex(h,buf,1,ov,cb),1);
  e.clear_yield();e.start_inline(caller);
  for(let i=0;i<20&&e.get_eip();i++)e.run(1000);
  assert.strictEqual(read(seen),4,'inline CALL dispatch reaches the callback');
  assert.strictEqual(read(after),0xc0,'inline caller resumes with WAIT_IO_COMPLETION');
  assert.strictEqual(e.get_esp()>>>0,0x07000004,'inline caller and callback stack are balanced');
  console.log('PASS ReadFileEx positional bytes, OVERLAPPED, deferred x86 callbacks, alertable waits and ABI');
})().catch(error=>{console.error(error);process.exitCode=1;});
