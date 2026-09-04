#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wat = fs.readFileSync(path.join(root, 'src', '09a8-handlers-directx.wat'), 'utf8');
const apis = JSON.parse(fs.readFileSync(path.join(root, 'src', 'api_table.json'), 'utf8'));

function check(name, pass) {
  console.log(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
  if (!pass) process.exitCode = 1;
}

const body = wat.match(/\(func \$handle_ICOpen\b[\s\S]*?(?=\n\n  ;; ICClose)/)?.[0] || '';
const api = apis.find(entry => entry.name === 'ICOpen');

check('ICOpen metadata declares the Win32 three-argument signature', api?.nargs === 3);
check('ICOpen pops return address plus three stdcall arguments',
  /\(global\.set \$esp \(i32\.add \(global\.get \$esp\) \(i32\.const 16\)\)\)/.test(body));
check('ICOpen no longer advances the caller stack by an extra dword',
  !/\(i32\.const 20\)/.test(body));
