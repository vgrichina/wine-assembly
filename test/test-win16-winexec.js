#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const wat = fs.readFileSync(path.join(__dirname, '..', 'src', '09e-win16-api.wat'), 'utf8');
const body = wat.match(/\(func \$win16_WinExec\b[\s\S]*?\n\n  \(func \$win16_kernel/);
assert(body, 'Win16 WinExec handler exists');
assert(/global\.set \$eax \(i32\.const 33\)/.test(body[0]),
  'WinExec returns a value in the documented success range');
assert(/win16_api_return \(i32\.const 6\)/.test(body[0]),
  'WinExec removes its far-pointer and UINT Pascal arguments');
assert(/i32\.eq \(local\.get \$ordinal\) \(i32\.const 166\)[\s\S]*?call \$win16_WinExec/.test(wat),
  'KERNEL.166 dispatches to WinExec');

console.log('test-win16-winexec: PASS');
