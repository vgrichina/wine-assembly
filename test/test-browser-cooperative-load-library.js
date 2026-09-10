#!/usr/bin/env node
'use strict';

// Cooperative CreateThread instances cannot perform asynchronous host work
// from ThreadManager.runSlice(). The browser loop must service their parked
// LoadLibrary yields after each worker budget, just as the CLI loop does.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { hasPageScript } = require('./browser-runtime-scripts');

const root = path.join(__dirname, '..');
const host = fs.readFileSync(path.join(root, 'host.js'), 'utf8');
const manager = fs.readFileSync(path.join(root, 'lib', 'thread-manager.js'), 'utf8');

const helper = host.match(
  /async handleCooperativeThreadLoadLibraries\(\) \{([\s\S]*?)\n  \}\n\n  \/\/ Finish/);
assert(helper, 'browser host has a cooperative thread LoadLibrary service helper');
assert(helper[1].includes("manager.backend !== 'cooperative'"),
  'the helper cannot race the real Worker backend LoadLibrary service');
assert(helper[1].includes('manager.threadsAwaitingLoadLibrary()'),
  'the helper enumerates only cooperative threads parked on yield 5');
assert(helper[1].includes('ProcessBoot.handleLoadLibraryYield({'),
  'the helper reuses the shared browser/CLI LoadLibrary implementation');
assert(helper[1].includes('manager.publishWorkerGlobals(exports);'),
  'a loaded DLL publishes heap/thunk/module cursors back to the main instance');

const scheduler = host.match(
  /if \(self\.threadManager\.hasActiveThreads\(\)\) \{([\s\S]*?)\n          \}\n        \}/);
assert(scheduler, 'browser host has the cooperative active-thread scheduler');
assert(scheduler[1].includes('await self.handleCooperativeThreadLoadLibraries();'),
  'the cooperative scheduler services worker LoadLibrary yields every turn');
assert(scheduler[1].indexOf('await self.handleCooperativeThreadLoadLibraries();') >
  scheduler[1].indexOf('runBudgeted({'),
  'LoadLibrary service runs after the worker yields back to the host');

const workerSlice = manager.match(
  /async _runWorkerThread\([\s\S]*?if \(r\.yield === 11\)[\s\S]*?if \(r\.yield === 12\)/);
assert(workerSlice, 'ThreadManager has the normal real-Worker yield dispatch');
assert(workerSlice[0].includes("r.yield === 3 || r.yield === 5"),
  'ordinary Worker slices recognize asynchronous COM and LoadLibrary yields');
assert(workerSlice[0].includes('await this._resolveThreadSendExternalYield(thread.link, r);'),
  'ordinary Worker slices use the same host callback as nested SendMessage yields');

assert(hasPageScript('host.js'),
  'the page centrally versions cooperative thread LoadLibrary servicing');
assert(hasPageScript('lib/thread-manager.js'),
  'the page centrally versions real-Worker LoadLibrary servicing');

console.log('PASS browser services cooperative and real-Worker CreateThread LoadLibrary yields');
