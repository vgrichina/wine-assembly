#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const host = fs.readFileSync(path.join(root, 'host.js'), 'utf8');
const fatalStart = host.lastIndexOf('      } catch (e) {', host.indexOf('let eip = 0, prevEip'));
const fatal = host.slice(fatalStart, host.indexOf('      } finally {', fatalStart));

for (const getter of [
  'get_eip', 'get_dbg_prev_eip', 'get_dbg_prev2_eip', 'get_esp', 'get_ebp',
  'get_eax', 'get_ebx', 'get_ecx', 'get_edx', 'get_esi', 'get_edi', 'guest_read32',
]) {
  assert(fatal.includes(getter), `cooperative fatal report should capture ${getter}`);
}
for (const label of ['EIP=', 'prev_eip=', 'prev2_eip=', 'ESP=', 'EBP=', 'EAX=',
  'EBX=', 'ECX=', 'EDX=', 'ESI=', 'EDI=', 'stack=[', 'yield=']) {
  assert(fatal.includes(label), `cooperative fatal report should print ${label}`);
}

console.log('browser cooperative crash register diagnostics: ok');
