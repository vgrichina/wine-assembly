'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const branch = source.match(
  /if \(yieldReason === 9\) \{([\s\S]*?)\n        \}\n        \/\/ Spawn and run worker threads/);
assert(branch, 'browser host has an explicit cooperative critical-section yield branch');
assert(branch[1].includes('self.instance.exports.clear_yield();'),
  'critical-section yield retries the blocked import on the next main turn');
assert(!/\breturn\b/.test(branch[1].replace(/\/\/[^\n]*/g, '')),
  'critical-section yield falls through so the lock-owning guest thread gets a slice');
assert(/\/\/ Spawn and run worker threads\s+if \(self\.threadManager\)/.test(source),
  'the fall-through target is the shared cooperative thread scheduler');
const hostVersion = html.match(/<script src="host\.js\?v=(\d+)"/);
assert(hostVersion && Number(hostVersion[1]) >= 240,
  'the browser cache-busts cooperative critical-section scheduling');

console.log('PASS  browser critical-section yields run the cooperative lock owner before retry');
