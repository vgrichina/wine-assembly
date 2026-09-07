// Live control channel for test/run.js --control (docs/design-agent-control.md).
//
// A tiny HTTP server with one idea, borrowed from tools/ios-selftest-server.js:
// the response to a command is HELD OPEN until the command has actually
// executed inside a batch, so `curl -d '{"cmd":"click:120:88"}' :8123/ctl`
// prints the outcome itself. This module is pure transport — it parses HTTP
// and JSON, enforces limits, and hands every command to the onCommand
// callback run.js provides; it knows nothing about the emulator.
//
// Deliberately bound to 127.0.0.1 unless the caller says otherwise: the
// command set includes eval, so exposing it is remote code execution by
// design, acceptable only when the user asked for it (--control-host).

'use strict';

const http = require('http');

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A command that got no batch turn in this long is stuck behind a batch that
// never yielded (or a run that ended); answer rather than hang the client.
const COMMAND_TIMEOUT_MS = 30000;

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error(`body over ${limit} bytes`)); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

// onCommand(cmd) -> value or Promise<value>; a throw/rejection becomes
// {ok:false, error}. One HTTP status for a whole POST: 200 if every command
// executed (even with ok:false results — a guest-side failure is a result,
// not a transport failure, same contract as tools/ios-eval.js), 504 if any
// timed out waiting for a batch turn.
function startControlServer({ port, host = '127.0.0.1', onCommand, log = () => {} }) {
  const sockets = new Set();

  const runOne = async (cmd) => {
    let timer;
    try {
      const value = await Promise.race([
        Promise.resolve(onCommand(cmd)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(
            new Error('no batch turn in 30s — the guest may be inside one long batch, or the run ended'),
            { timedOut: true })), COMMAND_TIMEOUT_MS);
          // The guest/control loop and sockets own process lifetime. Once a
          // shutdown has unref'ed those sockets, an interrupted in-flight
          // command must not keep the process alive for this whole timeout.
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      return { ok: false, error: String(error && error.message || error), timedOut: !!(error && error.timedOut) };
    } finally {
      clearTimeout(timer);
    }
  };

  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url.startsWith('/snapshot')) {
        const result = await runOne({ action: 'snapshot' });
        return sendJson(response, result.ok ? 200 : 500, result);
      }
      if (request.method === 'POST' && request.url.startsWith('/ctl')) {
        let parsed;
        try {
          const raw = await readBody(request, MAX_BODY_BYTES);
          parsed = JSON.parse(raw);
        } catch (error) {
          return sendJson(response, 400, { ok: false, error: String(error.message || error) });
        }
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        // In order, one at a time: a mousedown must have landed before the
        // mouseup behind it is even parsed, or a drag decomposes.
        const results = [];
        for (const cmd of batch) results.push(await runOne(cmd));
        const status = results.some(r => r.timedOut) ? 504 : 200;
        return sendJson(response, status, Array.isArray(parsed) ? results : results[0]);
      }
      sendJson(response, 404, { ok: false, error: 'routes: POST /ctl, GET /snapshot' });
    } catch (error) {
      try { sendJson(response, 500, { ok: false, error: String(error.message || error) }); } catch (_) {}
    }
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.listen(port, host, () => {
    // The ready line tests and agents wait for; keep its shape stable.
    log(`[control] listening on http://${host}:${port}/ctl`);
  });
  server.on('error', error => {
    log(`[control] server error: ${error.message}`);
  });

  return {
    server,
    // unref rather than destroy: a reply resolved just before the run ends
    // still gets flushed while the exit path prints its summaries, and the
    // open sockets no longer hold the process alive after that.
    close() {
      server.close();
      for (const socket of sockets) socket.unref();
      server.unref();
    },
  };
}

module.exports = { startControlServer };
