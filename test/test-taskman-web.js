#!/usr/bin/env node

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'scratch', 'taskman-web');
const tasksPng = path.join(OUT, 'live-tasks.png');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for Task Manager browser test');
  process.exit(0);
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function mimeType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.json') return 'application/json';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (_) { res.writeHead(400); res.end('bad url'); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code || 'read error'); return; }
      res.writeHead(200, { 'Content-Type': mimeType(file), 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function reserveTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', data => { body += data; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function wsConnect(wsUrl) {
  const url = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.connect(Number(url.port), url.hostname);
  const pending = new Map();
  const events = [];
  let buffer = Buffer.alloc(0);
  let ready = false;
  let nextId = 1;

  function parseFrames() {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        if (buffer.readUInt32BE(2)) throw new Error('large websocket frame');
        length = buffer.readUInt32BE(6); offset = 10;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode !== 1) continue;
      const message = JSON.parse(payload.toString('utf8'));
      if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
      } else {
        events.push(message);
      }
    }
  }

  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    if (!ready) {
      const end = buffer.toString('latin1').indexOf('\r\n\r\n');
      if (end < 0) return;
      ready = true;
      buffer = buffer.subarray(end + 4);
    }
    parseFrames();
  });

  const opened = new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.write([
        `GET ${url.pathname}${url.search} HTTP/1.1`,
        `Host: ${url.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '', '',
      ].join('\r\n'));
      const started = Date.now();
      const poll = () => {
        if (ready) resolve();
        else if (Date.now() - started > 5000) reject(new Error('websocket timeout'));
        else setTimeout(poll, 25);
      };
      poll();
    });
    socket.once('error', reject);
  });

  function send(method, params = {}) {
    const id = nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
    header[0] = 0x81;
    if (payload.length < 126) {
      header[1] = 0x80 | payload.length;
      crypto.randomBytes(4).copy(header, 2);
      for (let i = 0; i < payload.length; i++) payload[i] ^= header[2 + (i & 3)];
    } else {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      crypto.randomBytes(4).copy(header, 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= header[4 + (i & 3)];
    }
    socket.write(Buffer.concat([header, payload]));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  return { opened, send, events, close: () => socket.destroy() };
}

function consoleSummary(events) {
  const lines = [];
  for (const event of events) {
    if (event.method === 'Runtime.consoleAPICalled') {
      lines.push(((event.params && event.params.args) || []).map(arg =>
        Object.prototype.hasOwnProperty.call(arg, 'value') ? String(arg.value) : (arg.description || '')).join(' '));
    } else if (event.method === 'Runtime.exceptionThrown') {
      const details = (event.params && event.params.exceptionDetails) || {};
      lines.push(details.text || (details.exception && details.exception.description) || '');
    }
  }
  return lines.filter(Boolean).slice(-160);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.unlinkSync(tasksPng); } catch (_) {}

  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = await reserveTcpPort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-assembly-taskman-web-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-search-engine-choice-screen',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `http://127.0.0.1:${port}/index.html?debug&taskman-web=${Date.now()}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = '';
  chrome.stderr.on('data', data => { chromeError += data.toString(); });
  let cdp = null;

  const cleanup = () => {
    try { if (cdp) cdp.close(); } catch (_) {}
    try { chrome.kill('SIGKILL'); } catch (_) {}
    try { server.close(); } catch (_) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  };
  process.on('exit', cleanup);

  let page;
  for (let i = 0; i < 120; i++) {
    try {
      const pages = await getJson(`http://127.0.0.1:${debugPort}/json/list`);
      page = pages.find(item => item.type === 'page' && String(item.url || '').includes('/index.html'));
      if (page) break;
    } catch (_) {}
    await wait(100);
  }
  assert(page, `Chrome page did not appear\n${chromeError.slice(-4000)}`);

  cdp = wsConnect(page.webSocketDebuggerUrl);
  await cdp.opened;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function evaluate(expression, timeoutMs = 10000) {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime.evaluate timeout')), timeoutMs));
    const response = await Promise.race([cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }), timeout]);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || JSON.stringify(response.exceptionDetails));
    return response.result && response.result.value;
  }

  await evaluate(`new Promise((resolve, reject) => {
    const started = performance.now();
    const poll = () => {
      if (document.readyState === 'complete' && typeof launchApp === 'function' && typeof WineAssembly !== 'undefined') resolve(1);
      else if (performance.now() - started > 15000) reject(new Error('browser globals did not initialize'));
      else setTimeout(poll, 50);
    };
    poll();
  })`, 18000);

  async function launch(name, titlePattern, timeoutMs = 30000) {
    await evaluate(`(() => {
      document.getElementById('app-select').value = ${JSON.stringify(name)};
      return launchApp();
    })()`, timeoutMs);
    return evaluate(`new Promise((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        const app = runningApps.find(item => item && item.name === ${JSON.stringify(name)});
        const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
          .find(item => item && item.visible && new RegExp(${JSON.stringify(titlePattern)}, 'i').test(item.title || ''));
        if (app && app.wine.running && win) resolve({ hwnd: win.hwnd, title: win.title, x: win.x, y: win.y, w: win.w, h: win.h });
        else if (performance.now() - started > ${timeoutMs}) reject(new Error(${JSON.stringify(name + ' did not become ready')}));
        else setTimeout(poll, 100);
      };
      poll();
    })`, timeoutMs + 3000);
  }

  const regedit = await launch('regedit', 'Registry Editor');
  const notepad = await launch('notepad', 'Notepad');
  assert(regedit.hwnd !== notepad.hwnd, 'RegEdit and Notepad should use distinct HWND ranges');
  const notepadInput = await evaluate(`new Promise(resolve => {
    const app = runningApps.find(item => item && item.name === 'notepad');
    const win = sharedRenderer.windows[${notepad.hwnd}];
    setTimeout(() => {
      const ownsKeyboard = sharedRenderer._keyboardInputWasm === app.wine.instance;
      sharedRenderer.handleKeyPress(88);
      const e = app.wine.instance.exports;
      let editHwnd = 0;
      let slot = 0;
      while ((slot = e.wnd_next_child_slot(win.hwnd, slot) | 0) >= 0) {
        const hwnd = e.wnd_slot_hwnd(slot) | 0;
        slot++;
        if (hwnd && (e.ctrl_get_class(hwnd) | 0) === 2) { editHwnd = hwnd; break; }
      }
      setTimeout(() => resolve({ ownsKeyboard, editHwnd, length: editHwnd ? e.get_edit_text_len(editHwnd) | 0 : -1 }), 100);
    }, 250);
  })`, 5000);
  assert(notepadInput.ownsKeyboard, 'launching Notepad after RegEdit should make Notepad the keyboard owner');
  assert.strictEqual(notepadInput.length, 1, 'Notepad should accept text immediately after launching behind RegEdit');
  const calculator = await launch('calc', 'Calculator');
  const recorder = await launch('sndrec32_98', 'Sound Recorder');
  const taskman = await launch('taskman', '^Tasks$');

  const inspectTasksSource = `(() => {
    const app = runningApps.find(item => item && item.name === 'taskman');
    const win = Object.values((sharedRenderer && sharedRenderer.windows) || {})
      .find(item => item && /^Tasks$/i.test(item.title || ''));
    const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
    let listHwnd = 0;
    if (win && e && e.wnd_next_child_slot && e.wnd_slot_hwnd && e.ctrl_get_class) {
      let slot = 0;
      while ((slot = e.wnd_next_child_slot(win.hwnd, slot) | 0) >= 0) {
        const hwnd = e.wnd_slot_hwnd(slot) | 0;
        slot++;
        if (hwnd && (e.ctrl_get_class(hwnd) | 0) === 4) { listHwnd = hwnd; break; }
      }
    }
    const rows = [];
    if (listHwnd && e.listbox_get_count && e.listbox_get_item_text && e.guest_alloc) {
      const count = Math.max(0, Math.min(e.listbox_get_count(listHwnd) | 0, 32));
      const buffer = e.guest_alloc(512) >>> 0;
      const wa = app.wine._guestToWasmAddress(buffer);
      const bytes = new Uint8Array(app.wine.memory.buffer);
      for (let row = 0; row < count; row++) {
        const length = Math.max(0, Math.min(e.listbox_get_item_text(listHwnd, row, buffer, 512) | 0, 511));
        let text = '';
        for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[wa + i]);
        rows.push(text);
      }
      if (e.guest_free) e.guest_free(buffer);
    }
    return win && {
      hwnd: win.hwnd, x: win.x, y: win.y, w: win.w, h: win.h,
      listHwnd, rows,
      listX: listHwnd && e.wnd_window_screen_x ? e.wnd_window_screen_x(listHwnd) | 0 : 0,
      listY: listHwnd && e.wnd_window_screen_y ? e.wnd_window_screen_y(listHwnd) | 0 : 0,
      selection: listHwnd && e.listbox_get_cur_sel ? e.listbox_get_cur_sel(listHwnd) | 0 : -1,
    };
  })()`;

  async function waitForRows(expected, timeoutMs = 10000) {
    const started = Date.now();
    let state;
    while (Date.now() - started < timeoutMs) {
      state = await evaluate(inspectTasksSource);
      if (state && expected.every(pattern => state.rows.some(row => new RegExp(pattern, 'i').test(row)))) return state;
      await wait(100);
    }
    throw new Error(`Task Manager rows did not contain ${expected.join(', ')}: ${JSON.stringify(state)}`);
  }

  const initialTasks = await waitForRows(['Calculator', 'Sound Recorder']);
  assert(!initialTasks.rows.some(row => /^Tasks$/i.test(row)), `Task Manager should not list itself: ${JSON.stringify(initialTasks.rows)}`);

  async function commandTask(pattern, command) {
    const selected = await evaluate(`(() => {
      const state = ${inspectTasksSource};
      const row = state.rows.findIndex(text => new RegExp(${JSON.stringify(pattern)}, 'i').test(text));
      if (row < 0) throw new Error('task row not found: ' + ${JSON.stringify(pattern)} + ' in ' + JSON.stringify(state.rows));
      const win = sharedRenderer.windows[state.hwnd];
      win.visible = true;
      win._minimized = false;
      win.zOrder = sharedRenderer._nextZ++;
      sharedRenderer.handleMouseDown(state.listX + 8, state.listY + row * 16 + 8, 0);
      sharedRenderer.handleMouseUp(state.listX + 8, state.listY + row * 16 + 8, 0);
      return { row, rows: state.rows };
    })()`);
    const selection = await evaluate(`new Promise(resolve => {
      const started = performance.now();
      const poll = () => {
        const value = (${inspectTasksSource}).selection;
        if (value === ${selected.row} || performance.now() - started > 3000) resolve(value);
        else setTimeout(poll, 50);
      };
      poll();
    })`, 5000);
    if (selection !== selected.row) {
      selected.debug = await evaluate(`(() => {
        const app = runningApps.find(item => item && item.name === 'taskman');
        const e = app.wine.instance.exports;
        return {
          inputQueue: sharedRenderer.inputQueue.map(item => ({ hwnd: item.hwnd, msg: item.msg, wParam: item.wParam })),
          log: document.getElementById('log').textContent.slice(-5000),
          postQueue: e.get_post_queue_count ? e.get_post_queue_count() | 0 : -1,
          yieldReason: e.get_yield_reason ? e.get_yield_reason() | 0 : -1,
        };
      })()`);
    }
    assert(selection === selected.row,
      `Task Manager should select ${pattern}: expected ${selected.row}, got ${selection}; ${JSON.stringify(selected)}`);
    await evaluate(`(() => {
      const state = ${inspectTasksSource};
      const app = runningApps.find(item => item && item.name === 'taskman');
      const e = app.wine.instance.exports;
      e.post_message_q(state.hwnd, 0x0111, ${command}, 0);
      sharedRenderer._wakeMessageWait();
    })()`);
    return selected;
  }

  await commandTask('Calculator', 424);
  const switched = await evaluate(`new Promise(resolve => {
    const started = performance.now();
    const poll = () => {
      const windows = Object.values(sharedRenderer.windows).filter(win => win && win.visible && !win.isChild);
      const calc = windows.find(win => /Calculator/i.test(win.title || ''));
      const top = windows.sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0))[0];
      const tasks = Object.values(sharedRenderer.windows).find(win => win && /^Tasks$/i.test(win.title || ''));
      const app = runningApps.find(item => item && item.name === 'taskman');
      const e = app && app.wine && app.wine.instance && app.wine.instance.exports;
      const result = {
        topTitle: top && top.title,
        calcZ: calc && calc.zOrder,
        tasksMinimized: !!(tasks && tasks._minimized),
        postQueue: e && e.get_post_queue_count ? e.get_post_queue_count() | 0 : -1,
        eip: e && e.get_eip ? e.get_eip() >>> 0 : 0,
        yieldReason: e && e.get_yield_reason ? e.get_yield_reason() | 0 : -1,
      };
      if ((top && /Calculator/i.test(top.title || '')) || performance.now() - started > 5000) resolve(result);
      else setTimeout(poll, 100);
    };
    poll();
  })`, 7000);
  assert(/Calculator/i.test(switched.topTitle || ''), `Switch To should raise Calculator: ${JSON.stringify(switched)}`);

  await launch('sndvol32', '^Volume Control$');
  const liveTasks = await waitForRows(['Calculator', 'Sound Recorder', 'Volume Control']);
  await wait(1000);
  const screenshot = await evaluate(`(() => {
    const win = Object.values(sharedRenderer.windows).find(item => item && /^Tasks$/i.test(item.title || ''));
    win.visible = true;
    win._minimized = false;
    win.zOrder = sharedRenderer._nextZ++;
    sharedRenderer.repaint();
    const canvas = document.getElementById('screen');
    const crop = document.createElement('canvas');
    crop.width = win.w; crop.height = win.h;
    crop.getContext('2d').drawImage(canvas, win.x, win.y, win.w, win.h, 0, 0, win.w, win.h);
    return { width: win.w, height: win.h, png: crop.toDataURL('image/png') };
  })()`);
  fs.writeFileSync(tasksPng, Buffer.from(screenshot.png.replace(/^data:image\/png;base64,/, ''), 'base64'));

  await commandTask('Volume Control', 425);
  const ended = await evaluate(`new Promise(resolve => {
    const started = performance.now();
    const volumeApp = runningApps.find(item => item && item.name === 'sndvol32');
    const poll = () => {
      const names = runningApps.map(item => item && item.name);
      const volumeVisible = Object.values(sharedRenderer.windows)
        .some(win => win && win.visible && !win.isChild && /^Volume Control$/i.test(win.title || ''));
      const result = { names, volumeVisible, volumeRunning: !!(volumeApp && volumeApp.wine.running) };
      if ((!names.includes('sndvol32') && !volumeVisible) || performance.now() - started > 7000) resolve(result);
      else setTimeout(poll, 100);
    };
    poll();
  })`, 9000);
  assert(!ended.names.includes('sndvol32') && !ended.volumeVisible,
    `End Task should close only Volume Control: ${JSON.stringify(ended)}`);
  assert(ended.names.includes('calc') && ended.names.includes('sndrec32_98') && ended.names.includes('taskman'),
    `other apps should survive End Task: ${JSON.stringify(ended)}`);

  const refreshed = await waitForRows(['Calculator', 'Sound Recorder']);
  assert(!refreshed.rows.some(row => /Volume Control/i.test(row)),
    `Task Manager should remove ended tasks: ${JSON.stringify(refreshed.rows)}`);

  await evaluate(`(() => {
    const win = Object.values(sharedRenderer.windows).find(item => item && /^Tasks$/i.test(item.title || ''));
    const app = runningApps.find(item => item && item.name === 'taskman');
    if (!win || !app) throw new Error('Task Manager missing before close');
    app.wine.instance.exports.post_message_q(win.hwnd, 0x0010, 0, 0);
    sharedRenderer._wakeMessageWait();
    return 1;
  })()`);
  const taskmanClosed = await evaluate(`new Promise(resolve => {
    const started = performance.now();
    const poll = () => {
      const names = runningApps.map(item => item && item.name);
      if (!names.includes('taskman') || performance.now() - started > 5000) resolve(names);
      else setTimeout(poll, 100);
    };
    poll();
  })`, 7000);
  assert(!taskmanClosed.includes('taskman') && taskmanClosed.includes('calc') && taskmanClosed.includes('sndrec32_98'),
    `closing Task Manager should leave other apps running: ${JSON.stringify(taskmanClosed)}`);

  const consoleText = consoleSummary(cdp.events).join('\n');
  assert(!/UNIMPLEMENTED API:|RuntimeError|LinkError|Thread \d+ crashed|FATAL:/i.test(consoleText),
    `browser console should not contain runtime failures\n${consoleText.slice(-4000)}`);
  assert(screenshot.width >= 375 && screenshot.height >= 275 && fs.statSync(tasksPng).size > 5000,
    `Task Manager screenshot should be complete: ${JSON.stringify(screenshot)}`);

  console.log(`PASS  browser Task Manager initially enumerates real Calculator and Sound Recorder tasks`);
  console.log('PASS  Notepad accepts delayed keyboard input after RegEdit launches first');
  console.log(`PASS  browser Task Manager live refresh adds and removes Volume Control (${liveTasks.rows.length} tasks)`);
  console.log('PASS  browser Task Manager Switch To raises the selected real app');
  console.log('PASS  browser Task Manager End Task closes only the selected real app');
  console.log('PASS  browser closing Task Manager leaves other desktop apps running');
  console.log(`Screenshot: ${tasksPng}`);
  cleanup();
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
