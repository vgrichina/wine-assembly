#!/usr/bin/env node
// Drive a live emulator session (docs/design-agent-control.md).
//
//   node tools/ctl.js snapshot                    # structured state, JSON
//   node tools/ctl.js click 120,88
//   node tools/ctl.js key VK_RETURN               # keydown + keyup
//   node tools/ctl.js type 'hello world'
//   node tools/ctl.js png /tmp/frame.png
//   node tools/ctl.js eval 'renderer.windows'
//   node tools/ctl.js cmd dlg-cmd:1               # any --input action, raw
//   node tools/ctl.js pipe < events.ndjson        # a continuous stream
//   node tools/ctl.js quit
//   node tools/ctl.js sessions                    # list browser sessions on the hub
//
// Targets a CLI VM (test/run.js --control, default http://127.0.0.1:8123) or,
// with -s SESSIONID, a browser session through the dev-server hub (default
// http://127.0.0.1:8080). `-s :8124` is shorthand for a CLI VM on another
// port. The agent loop this exists for: png, look, click, png, png-diff.
//
// Exit codes compose in a shell, same contract as tools/ios-eval.js:
// 0 = executed, 1 = the command failed guest/page-side, 2 = transport.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
// -s SESSION: hub session id, or :PORT for a direct CLI VM on another port.
const sIdx = argv.indexOf('-s');
const SESSION = sIdx >= 0 ? argv[sIdx + 1] : null;
const positional = argv.filter((a, i) =>
  !a.startsWith('--') && (sIdx < 0 || (i !== sIdx && i !== sIdx + 1)));
const VERB = positional[0];

const HUB = flag('hub', 'http://127.0.0.1:8080');
const DIRECT = flag('url', `http://127.0.0.1:${flag('port', '8123')}`);
// A hub bound beyond localhost requires its startup-printed token.
const TOKEN = flag('token', process.env.WINE_AGENT_TOKEN || '');
const tokenPart = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : '';

const target = (() => {
  if (SESSION && SESSION.startsWith(':')) return { kind: 'direct', base: `http://127.0.0.1${SESSION}` };
  if (SESSION) return { kind: 'hub', base: HUB, session: SESSION };
  return { kind: 'direct', base: DIRECT };
})();

function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const request = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
        catch (_) { resolve({ status: response.statusCode, body: { ok: false, error: text.slice(0, 300) } }); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
        catch (_) { resolve({ status: response.statusCode, body: { ok: false, error: text.slice(0, 300) } }); }
      });
    }).on('error', reject);
  });
}

const ctlUrl = target.kind === 'hub'
  ? `${target.base}/api/agent/ctl?s=${encodeURIComponent(target.session)}${tokenPart}`
  : `${target.base}/ctl`;

async function send(commands) {
  const single = !Array.isArray(commands);
  const { body } = await post(ctlUrl, commands);
  return single ? [body] : body;
}

// Named virtual keys for `key` / `type`; anything numeric passes through.
const VK = {
  RETURN: 13, ENTER: 13, ESCAPE: 27, ESC: 27, SPACE: 32, TAB: 9, BACK: 8, BACKSPACE: 8,
  DELETE: 46, INSERT: 45, HOME: 36, END: 35, PRIOR: 33, PAGEUP: 33, NEXT: 34, PAGEDOWN: 34,
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, SHIFT: 16, CONTROL: 17, CTRL: 17, MENU: 18, ALT: 18,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120,
  F10: 121, F11: 122, F12: 123,
};
const vkCode = (name) => {
  const upper = String(name).toUpperCase().replace(/^VK_/, '');
  if (/^\d+$/.test(upper)) return parseInt(upper, 10);
  if (upper in VK) return VK[upper];
  if (/^[A-Z0-9]$/.test(upper)) return upper.charCodeAt(0);
  throw new Error(`unknown key ${JSON.stringify(name)} — use VK_* names, a letter, or a number`);
};

const xy = (spec) => {
  const m = /^(-?\d+)[,x:](-?\d+)$/.exec(String(spec || ''));
  if (!m) throw new Error('need coordinates as X,Y');
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
};

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function printResult(result) {
  if (!result.ok) {
    console.error(`FAIL: ${result.error}`);
    process.exit(1);
  }
  const value = result.value;
  if (value && Array.isArray(value.logs) && value.logs.length) {
    for (const line of value.logs) console.log(line);
  } else if (value !== null && typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else if (value !== null) {
    console.log(String(value));
  } else {
    console.log('ok');
  }
}

async function main() {
  if (!VERB) {
    fail('usage: ctl.js [-s SESSION|:PORT] snapshot|ping|click X,Y|dblclick|rclick|mousedown|mouseup|mousemove|drag X1,Y1 X2,Y2|key VK|type TEXT|png FILE|eval CODE|cmd RAW|pipe|quit|sessions', 2);
  }

  if (VERB === 'sessions') {
    const { body } = await get(`${HUB}/api/agent/sessions?x=1${tokenPart}`);
    if (!Array.isArray(body.sessions)) fail(`hub said: ${JSON.stringify(body)}`, 2);
    if (!body.sessions.length) { console.log('no live sessions on the hub'); return; }
    for (const s of body.sessions) {
      console.log(`${s.id}  ${s.kind || 'browser'}  app=${s.app || '?'}  age=${s.ageSec}s  last-seen=${s.lastSeenSec}s ago`);
    }
    return;
  }

  if (VERB === 'snapshot' && target.kind === 'direct') {
    const { body } = await get(`${target.base}/snapshot`);
    printResult(body);
    return;
  }

  let commands;
  if (VERB === 'snapshot' || VERB === 'ping' || VERB === 'quit') {
    commands = { action: VERB };
  } else if (VERB === 'eval') {
    commands = { action: 'eval', code: positional.slice(1).join(' ') };
  } else if (VERB === 'cmd') {
    commands = { cmd: positional.slice(1).join(' ') };
  } else if (['click', 'dblclick', 'rclick', 'mousedown', 'mouseup', 'mousemove'].includes(VERB)) {
    const [x, y] = xy(positional[1]);
    commands = { cmd: `${VERB}:${x}:${y}` };
  } else if (VERB === 'drag') {
    const [x1, y1] = xy(positional[1]);
    const [x2, y2] = xy(positional[2]);
    // Four intermediate moves, like the corner-drag action: a game tracking
    // pointer deltas must not see one teleport-sized step.
    commands = [{ cmd: `mousedown:${x1}:${y1}` }];
    for (const t of [0.25, 0.5, 0.75, 1]) {
      commands.push({ cmd: `mousemove:${Math.round(x1 + (x2 - x1) * t)}:${Math.round(y1 + (y2 - y1) * t)}` });
    }
    commands.push({ cmd: `mouseup:${x2}:${y2}` });
  } else if (VERB === 'key') {
    const code = vkCode(positional[1]);
    commands = [{ cmd: `keydown:${code}` }, { cmd: `keyup:${code}` }];
  } else if (VERB === 'type') {
    const text = positional.slice(1).join(' ');
    if (!text) fail('type needs text', 2);
    commands = [];
    for (const ch of text) {
      if (ch === '\n') commands.push({ cmd: 'keydown:13' }, { cmd: 'keyup:13' });
      else commands.push({ cmd: `keypress:${ch.charCodeAt(0)}` });
    }
  } else if (VERB === 'png') {
    const out = positional[1];
    if (!out) fail('png needs an output path', 2);
    if (target.kind === 'direct') {
      // The CLI VM shares this filesystem: it writes the file itself and no
      // image bytes cross the wire (design decision, see the doc).
      commands = { cmd: `png:${path.resolve(out)}` };
    } else {
      const [result] = await send({ action: 'png' });
      if (!result.ok) fail(`FAIL: ${result.error}`, 1);
      const m = /^data:image\/png;base64,(.+)$/.exec(String(result.value || ''));
      if (!m) fail(`page returned no PNG data URL: ${String(result.value).slice(0, 80)}`, 1);
      const buf = Buffer.from(m[1], 'base64');
      fs.writeFileSync(out, buf);
      console.log(`wrote ${out} (${buf.length} bytes)`);
      return;
    }
  } else if (VERB === 'pipe') {
    // NDJSON from stdin: each line a JSON command/array or a raw entry
    // string. Sent one line per POST, in order — the continuous-stream case.
    const text = fs.readFileSync(0, 'utf8');
    let bad = 0;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let cmd;
      try { cmd = JSON.parse(trimmed); } catch (_) { cmd = { cmd: trimmed }; }
      const results = await send(cmd);
      for (const r of results) {
        if (!r.ok) bad++;
        console.log(JSON.stringify(r));
      }
    }
    process.exit(bad ? 1 : 0);
  } else {
    fail(`unknown verb ${JSON.stringify(VERB)}`, 2);
  }

  const results = await send(commands);
  const failed = results.find(r => !r.ok);
  if (failed) {
    console.error(`FAIL: ${failed.error}`);
    process.exit(1);
  }
  if (VERB === 'png') {
    // The VM wrote the file itself; its own log line names path and size.
    const value = results[0].value || {};
    const line = (value.logs || []).find(l => l.includes('[input] png'));
    if (line && line.includes('FAILED')) fail(line, 1);
    console.log(line || `wrote ${path.resolve(positional[1])}`);
    if (!fs.existsSync(path.resolve(positional[1]))) fail(`no file at ${path.resolve(positional[1])}`, 1);
  } else {
    printResult(results[results.length - 1]);
  }
}

main().catch(error => fail(`no control server at ${ctlUrl} — ${error.message}`, 2));
