#!/usr/bin/env node
// A REPL into the phone.
//
//   node tools/ios-eval.js 'innerHeight'
//   node tools/ios-eval.js --file=probe.js
//   node tools/ios-eval.js 'document.body.style.background="red"'
//
// There is no debugger into an iPhone on someone else's desk. Web Inspector
// over USB is the official answer, needs the cable and a Mac in front of the
// device, and cannot be driven from a shell at all. So the lab page polls the
// server for work instead (tools/ios-lab/lab.js), evaluates whatever arrives
// and posts the result back -- and this hands it the work and prints what it
// said. The expression's value comes back as text; objects arrive as JSON.
//
// Needs tools/ios-selftest-server.js running and a lab page open on the
// device. If nothing is open, this says so after 20 seconds rather than
// hanging.

'use strict';

const fs = require('fs');
const http = require('http');

function arg(name, fallback) {
  const hit = process.argv.find(value => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = Number(arg('port', '8099'));
const HOST = arg('host', '127.0.0.1');
const FILE = arg('file', '');
const code = FILE ? fs.readFileSync(FILE, 'utf8')
  : process.argv.slice(2).filter(value => !value.startsWith('--')).join(' ');

if (!code) {
  console.error('usage: node tools/ios-eval.js \'<javascript>\' | --file=probe.js');
  process.exit(2);
}

const request = http.request({
  host: HOST, port: PORT, path: '/ios-eval', method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(code) },
}, response => {
  let body = '';
  response.setEncoding('utf8');
  response.on('data', chunk => { body += chunk; });
  response.on('end', () => {
    process.stdout.write(body);
    // A thrown expression is a result, not a tool failure -- but the exit
    // code should still say which it was, so this composes in a shell.
    process.exit(response.statusCode === 200 ? 0 : 1);
  });
});
request.on('error', error => {
  console.error(`no server on ${HOST}:${PORT} -- ${error.message}`);
  process.exit(2);
});
request.end(code);
