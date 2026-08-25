#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
const channels = [];
class FakeMessageChannel {
  constructor() {
    this.port1 = { onmessage: null };
    this.port2 = { postMessage: () => {} };
    channels.push(this);
  }
}

const context = {
  MessageChannel: FakeMessageChannel,
  URLSearchParams,
  console,
  setTimeout,
};
vm.runInNewContext(hostSource + '\n;globalThis.WineAssembly = WineAssembly;', context);

const wine = new context.WineAssembly();
let calls = 0;
wine._scheduleStep(() => { calls++; });

assert.strictEqual(channels.length, 1, 'the scheduler creates one MessageChannel');
assert.strictEqual(wine._stepListenPort, channels[0].port1,
  'the process retains the listener port for its full run lifetime');
assert.strictEqual(typeof wine._stepListenPort.onmessage, 'function');

wine._stepListenPort.onmessage();
assert.strictEqual(calls, 1, 'the retained listener runs the pending guest slice');
assert.strictEqual(wine._pendingStep, null, 'delivery consumes the pending slice exactly once');

wine._scheduleStep(() => { calls++; });
assert.strictEqual(channels.length, 1, 'later slices reuse the retained channel');
wine._stepListenPort.onmessage();
assert.strictEqual(calls, 2);

console.log('PASS  browser scheduler retains and reuses its MessageChannel listener');
