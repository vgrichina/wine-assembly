#!/usr/bin/env node
// Static server for the repo plus a sink the page can talk back through.
//
// WHY this exists: Chrome device emulation is not iOS. It has no retractable
// toolbars, its timers are not WebKit's, and every phone-only bug we have hit
// so far (the swipe-to-collapse gesture, the app that will not let go of the
// display) was invisible to it. The iOS Simulator runs real WebKit, but there
// is no WebDriver into Simulator Safari without WebDriverAgent -- so the page
// drives itself and posts what it found here, and this prints it.
//
//   node tools/ios-selftest-server.js [--port=8099] [--log=out.ndjson]
//   xcrun simctl openurl booted http://127.0.0.1:8099/test/ios-selftest.html
//
// Reports are printed as they arrive, one line each, so a run is readable
// while it is still going.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = fs.realpathSync(path.join(__dirname, '..'));

function arg(name, fallback) {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = Number(arg('port', '8099'));
const LOG = arg('log', '');

const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.wat': 'text/plain', '.exe': 'application/octet-stream',
};

function serveFile(request, response) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
  catch (_) { response.writeHead(400); response.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  let file = path.normalize(path.join(ROOT, pathname));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    response.writeHead(403); response.end(); return;
  }
  // A directory URL is the one someone types. Without this, /tools/ios-lab/
  // reads a directory as a file, fails with EISDIR and serves a blank 500 --
  // which on a phone is indistinguishable from a page that loaded and drew
  // nothing, and is exactly how the lab was first reported broken.
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch (_) { /* let readFile report it */ }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); return; }
    response.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // Simulator Safari caches aggressively, and a stale host.js is
      // indistinguishable from a fix that did not work.
      'Cache-Control': 'no-store',
    });
    response.end(data);
  });
}

function report(request, response) {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    response.end();
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) { parsed = { raw: body }; }
    const stamp = new Date().toISOString().slice(11, 19);
    if (Array.isArray(parsed)) for (const item of parsed) print(stamp, item);
    else print(stamp, parsed);
    if (LOG) fs.appendFileSync(LOG, body + '\n');
  });
}

function print(stamp, item) {
  if (item && item.kind === 'eval') {
    const answered = answerEval(item);
    console.log(`${stamp}  EVAL #${item.id} ${item.ok ? '->' : 'THREW'} ${item.value}` +
      (answered ? '' : '  (nobody waiting)'));
    return;
  }
  if (item && item.kind === 'lab') {
    console.log(`${stamp}  LAB ${item.page.padEnd(9)} ${item.line}`);
    return;
  }
  if (item && item.kind === 'log') {
    console.log(`${stamp}  ${item.text}`);
    return;
  }
  // lib/phone-diag.js posts one of these twice a second while a phone is
  // being driven. Printed raw they are unreadable at that rate, and the
  // verdict is the only part worth watching live -- the rest is there for
  // when it says DEAD-END, and the full record is in --log either way.
  if (item && item.verdict) {
    const kb = `kb ${item.kbInset}/${item.kbShift}`;
    const zoom = item.vv ? `z${item.vv.scale}` : 'z?';
    const head = `${stamp}  ${item.verdict.padEnd(14)} run ${item.running} win ${item.windows} ` +
      `mem ${item.mem || '?'}  ` +
      `icon@${item.iconTop} hit ${item.hit}  ${zoom} scroll ${item.scroll.join(',')} ` +
      `${kb} wrap "${item.wrapTransform}"  [${item.classes}]`;
    console.log(head);
    if (item.audio) console.log(`${' '.repeat(stamp.length)}  AUDIO ${item.audio}`);
    if (item.collapse) console.log(`${' '.repeat(stamp.length)}  SCROLL ${item.collapse}`);
    if (item.why) console.log(`${' '.repeat(stamp.length)}  WHY ${item.why}`);
    if (item.verdict === 'DEAD-END') console.log(`${' '.repeat(stamp.length)}  ${JSON.stringify(item)}`);
    return;
  }
  console.log(`${stamp}  ${JSON.stringify(item)}`);
}

// ---- the eval channel ------------------------------------------------
//
// There is no debugger into the phone. Safari Web Inspector over USB is the
// official answer and it is a lot of setup to ask of someone whose report is
// "the swipe does nothing" -- and it cannot be driven from here at all. So
// the page asks US for work instead: it polls GET /ios-cmd, evaluates
// whatever comes back, and posts the result to /ios-report like any other
// report. That makes `tools/ios-eval.js 'innerHeight'` a REPL into a real
// iPhone, which is the only place this bug exists.
//
// Deliberately not authenticated and bound to the LAN: it is a debugging
// server for a machine on the user's own network, started by hand, and it
// serves the repo to that network already.
const commands = [];
const waiting = new Map();
let nextCommandId = 1;

function enqueueEval(request, response) {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const id = nextCommandId++;
    commands.push({ id, code: body });
    console.log(`${new Date().toISOString().slice(11, 19)}  EVAL #${id} <- ${body}`);
    // Hold the HTTP response open until the device answers, so the shell
    // command that asked prints the value itself.
    const timer = setTimeout(() => {
      if (!waiting.has(id)) return;
      waiting.delete(id);
      response.writeHead(504, { 'Content-Type': 'text/plain' });
      response.end('no answer from the device in 20s -- is the lab page open?\n');
    }, 20000);
    waiting.set(id, { response, timer });
  });
}

function answerEval(item) {
  const pending = item && waiting.get(item.id);
  if (!pending) return false;
  waiting.delete(item.id);
  clearTimeout(pending.timer);
  pending.response.writeHead(item.ok ? 200 : 500, { 'Content-Type': 'text/plain' });
  pending.response.end(String(item.value) + '\n');
  return true;
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    });
    response.end();
    return;
  }
  if (request.method === 'POST' && request.url.startsWith('/ios-report')) {
    report(request, response);
    return;
  }
  if (request.method === 'POST' && request.url.startsWith('/ios-eval')) {
    enqueueEval(request, response);
    return;
  }
  if (request.method === 'GET' && request.url.startsWith('/ios-cmd')) {
    const batch = commands.splice(0, commands.length);
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(JSON.stringify(batch));
    return;
  }
  serveFile(request, response);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`);
  console.log(`open with: xcrun simctl openurl booted http://127.0.0.1:${PORT}/test/ios-selftest.html`);
});
