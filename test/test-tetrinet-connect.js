#!/usr/bin/env node

// TetriNET drives a real connect() through the whole Winsock path.
//
// This is an end-to-end gate rather than a unit test, because everything it
// covers only fails in combination:
//
//   - the dialog is dismissable at all       (system-class subclassing)
//   - typing reaches the Delphi TEdit        (adopted EDIT control)
//   - the app reads its own button caption   (button WM_GETTEXTLENGTH)
//   - the Borland range check decodes        (opcode 0x62 BOUND)
//   - service/protocol lookup answers        (getservbyname/getprotobyname)
//   - the socket reports by window message   (WSAAsyncSelect)
//
// Any one of those regressing puts the app back to silently doing nothing
// when Connect is clicked, which is exactly the failure that is invisible
// from a screenshot.
//
// The binary is a gitignored corpus fixture, so this reports SKIP when it has
// not been fetched.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'candidates', 'tetrinet', 'TETRINET.EXE');
const ADDRESS = '10.77.0.1';

// Batch numbers are spaced out because each step has to reach the app's
// message pump before the next one means anything.
const INPUT = [
  '1200:click:319:284',        // dismiss the first-run dialog
  '1600:click:57:455',         // toolbar: the connect screen
  '1750:click:455:186',        // focus the Server field
  ...[...'10.77.0.1'].map((ch, i) => `${1800 + i * 10}:keypress:${ch.charCodeAt(0)}`),
  '1900:click:455:213',        // focus the nickname field
  '1920:keypress:98',          // "b"
  '1930:keypress:111',         // "o"
  '2000:click:437:279',        // Connect
].join(',');

function main() {
  if (!fs.existsSync(EXE)) {
    console.log('SKIP TetriNET connect: fetch with '
      + 'node tools/fetch-candidate-corpus.js --id=tetrinet');
    return;
  }

  const result = spawnSync('node', [RUN, `--exe=${EXE}`,
    '--max-batches=6000', '--batch-size=25000', '--vlan-ip=10.77.0.2',
    `--input=${INPUT}`,
    '--trace-api=socket,connect,WSAAsyncSelect,getservbyname,getprotobyname,inet_addr'], {
    cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 96 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const out = `${result.stdout || ''}${result.stderr || ''}`;

  assert.ok(!/UNIMPLEMENTED API:/.test(out),
    `unimplemented API on the connect path: ${(/UNIMPLEMENTED API: (\w+)/.exec(out) || [])[1]}`);
  assert.ok(!/\*\*\* CRASH|RuntimeError/.test(out),
    `crash on the connect path\n${out.slice(-3000)}`);
  assert.ok(!/0xbadc0de0/i.test(out), 'hit an undecodable opcode on the connect path');

  // Order matters: the address must be parsed before the socket exists, and
  // the socket must be registered for messages before connect is attempted.
  const steps = [
    { re: /\[API #\d+\] getservbyname\(/, what: 'getservbyname answered' },
    { re: new RegExp(`\\[API #\\d+\\] inet_addr\\(cp="${ADDRESS.replace(/\./g, '\\.')}"`),
      what: `inet_addr saw the typed address ${ADDRESS}` },
    { re: /\[API #\d+\] getprotobyname\(/, what: 'getprotobyname answered' },
    { re: /\[API #\d+\] socket\(af=2, type=1, protocol=6\)/, what: 'a TCP socket was created' },
    { re: /\[API #\d+\] WSAAsyncSelect\(/, what: 'the socket was registered for window messages' },
    { re: /\[API #\d+\] connect\(s=/, what: 'connect was attempted' },
  ];

  let cursor = 0;
  for (const step of steps) {
    const rest = out.slice(cursor);
    const hit = step.re.exec(rest);
    assert.ok(hit, `${step.what}: not found` + (cursor ? ' after the previous step' : ''));
    cursor += hit.index + hit[0].length;
    console.log(`PASS  ${step.what}`);
  }
}

main();
