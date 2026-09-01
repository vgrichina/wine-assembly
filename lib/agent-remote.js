// Connect a live emulator page to the dev-server's agent hub, so an agent at
// a shell can drive it with tools/ctl.js (docs/design-agent-control.md).
//
// The page cannot listen for connections, so it polls — the same shape as
// tools/ios-lab (the page asks the server for work, executes it, posts the
// result back), promoted to long-poll so an idle page costs one request every
// ~25s instead of a battery-burning fast loop.
//
// Connecting is one pasted line in any tab of the app, deployed builds
// included (the logic stays in this file; the snippet never grows):
//
//   import('http://127.0.0.1:8080/lib/agent-remote.js').then(m => m.connect())
//
// Input commands are executed by synthesizing REAL DOM events on the screen
// canvas — the exact events lib/browser-input.js wires — so they take the
// same routing a human's input takes, --trace-input semantics and all.
// Commands use the same colon syntax as run.js --input entries; the verbs
// ctl.js emits are the supported subset.

const state = { session: null, hub: null, running: false, token: null };

// A hub bound beyond localhost requires its startup-printed token; the paste
// snippet carries it in the import URL (?token=...), so connect() needs no
// second argument in either case.
const qs = (extra) => {
  const params = new URLSearchParams(extra || {});
  if (state.token) params.set('token', state.token);
  const text = params.toString();
  return text ? `?${text}` : '';
};

const log = (line) => console.log(`[agent-remote] ${line}`);

function canvasEl() {
  return document.getElementById('screen');
}

// Map guest screen coordinates to client coordinates through the canvas's
// current CSS box: the phone shell scales the canvas, and a click computed
// against the backing-store size would land on the wrong control.
function clientPoint(x, y) {
  const canvas = canvasEl();
  const rect = canvas.getBoundingClientRect();
  return {
    clientX: rect.left + ((x + 0.5) * rect.width) / canvas.width,
    clientY: rect.top + ((y + 0.5) * rect.height) / canvas.height,
  };
}

function mouseEvent(type, x, y, button) {
  const { clientX, clientY } = clientPoint(x, y);
  const event = new MouseEvent(type, {
    clientX, clientY, button: button || 0, buttons: type === 'mouseup' ? 0 : 1,
    bubbles: true, cancelable: true, view: window,
  });
  canvasEl().dispatchEvent(event);
}

const KEY_NAMES = {
  8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt',
  27: 'Escape', 32: ' ', 33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown',
  45: 'Insert', 46: 'Delete',
};

// lib/browser-input.js reads e.keyCode (and e.charCode on keypress), which a
// synthesized KeyboardEvent reports as 0 — the defineProperty is what makes
// the event indistinguishable from a real one to that code.
function keyEvent(type, code) {
  const key = type === 'keypress'
    ? String.fromCharCode(code)
    : (KEY_NAMES[code] || (code >= 112 && code <= 123 ? `F${code - 111}`
      : String.fromCharCode(code).toLowerCase()));
  const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'keyCode', { get: () => code });
  Object.defineProperty(event, 'which', { get: () => code });
  if (type === 'keypress') Object.defineProperty(event, 'charCode', { get: () => code });
  window.dispatchEvent(event);
}

function safeValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value,
      (k, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v)));
  } catch (_) { return String(value); }
}

function execEntry(entry) {
  const parts = String(entry).split(':');
  const kind = parts[0];
  const x = parseInt(parts[1], 10), y = parseInt(parts[2], 10);
  switch (kind) {
    case 'click': mouseEvent('mousedown', x, y, 0); mouseEvent('mouseup', x, y, 0); return { did: entry };
    case 'dblclick':
      mouseEvent('mousedown', x, y, 0); mouseEvent('mouseup', x, y, 0);
      mouseEvent('mousedown', x, y, 0); mouseEvent('mouseup', x, y, 0);
      return { did: entry };
    case 'rclick': mouseEvent('mousedown', x, y, 2); mouseEvent('mouseup', x, y, 2); return { did: entry };
    case 'mousedown': case 'mouseup': case 'mousemove': mouseEvent(kind, x, y, 0); return { did: entry };
    case 'wheel': {
      const { clientX, clientY } = clientPoint(x, y);
      canvasEl().dispatchEvent(new WheelEvent('wheel', {
        clientX, clientY, deltaY: -(parseInt(parts[3], 10) || 0),
        bubbles: true, cancelable: true,
      }));
      return { did: entry };
    }
    case 'keydown': case 'keyup': case 'keypress': keyEvent(kind, parseInt(parts[1], 10)); return { did: entry };
    default:
      throw new Error(`the browser session supports click/dblclick/rclick/mouse*/wheel/key* entries, not ${JSON.stringify(kind)}`);
  }
}

function execute(cmd) {
  if (cmd.action === 'ping') {
    return { pong: true, kind: 'browser', href: location.href, title: document.title };
  }
  if (cmd.action === 'snapshot') {
    const canvas = canvasEl();
    return {
      href: location.href,
      title: document.title,
      screen: canvas ? { w: canvas.width, h: canvas.height } : null,
    };
  }
  if (cmd.action === 'eval') {
    // Indirect eval: page global scope, same reach as the console.
    return safeValue((0, eval)(String(cmd.code || '')));
  }
  if (cmd.action === 'png') {
    const canvas = canvasEl();
    if (!canvas) throw new Error('no #screen canvas on this page');
    return canvas.toDataURL('image/png');
  }
  if (cmd.cmd) return execEntry(cmd.cmd);
  throw new Error('need {cmd:"action:args"} or action: ping|snapshot|eval|png');
}

async function pollLoop() {
  let backoff = 1000;
  while (state.running) {
    let commands;
    try {
      const response = await fetch(`${state.hub}/api/agent/poll${qs({ s: state.session })}`,
        { cache: 'no-store' });
      if (response.status === 410) { log('session expired; reconnecting'); await hello(); continue; }
      commands = await response.json();
      backoff = 1000;
    } catch (error) {
      // The hub being down is not a page error; retry quietly.
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 10000);
      continue;
    }
    if (!Array.isArray(commands) || !commands.length) continue;
    const results = commands.map(cmd => {
      try { return { id: cmd.id, ok: true, value: execute(cmd) }; }
      catch (error) { return { id: cmd.id, ok: false, error: String(error && error.message || error) }; }
    });
    try {
      await fetch(`${state.hub}/api/agent/result${qs({ s: state.session })}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s: state.session, results }),
      });
    } catch (_) { /* the poll loop's next turn re-establishes contact */ }
  }
}

// The page-side answer to "where do I get the link": the ?debug toolbar's
// Agent handoff button (index.html) calls copyHandoff(), which puts the tab
// URL plus the ctl.js line an agent needs on the clipboard. The logic lives
// here so the toolbar stays one call, like the paste snippet.
export function handoffText() {
  return 'Drive my live wine-assembly session (docs/design-agent-control.md):\n'
    + `  node tools/ctl.js -s '${location.href}' snapshot\n`
    + 'Verbs: snapshot | png FILE | click X,Y | drag X1,Y1 X2,Y2 | key VK_NAME'
    + ' | type TEXT | eval CODE | cmd RAW | pipe < ndjson.\n'
    + `Session ${state.session} on hub ${state.hub}.`;
}

export async function copyHandoff() {
  const text = handoffText();
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    // Clipboard API needs a secure context or permission; the textarea
    // fallback works on plain-http LAN pages (the phone case).
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }
  return text;
}

async function hello() {
  const response = await fetch(`${state.hub}/api/agent/hello${qs()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      href: location.href,
      ua: navigator.userAgent,
      app: (window.wineShell && window.wineShell.currentAppId) || null,
    }),
  });
  const body = await response.json();
  if (!body.sessionId) throw new Error(`hub refused: ${JSON.stringify(body)}`);
  state.session = body.sessionId;
  log(`connected as session ${body.sessionId} via ${state.hub}`);
}

export async function connect(hub) {
  if (state.running) { log(`already connected as ${state.session}`); return state.session; }
  const self = new URL(import.meta.url);
  state.hub = (hub || self.origin).replace(/\/$/, '');
  state.token = self.searchParams.get('token') || null;
  await hello();
  state.running = true;
  pollLoop();
  return state.session;
}

export function disconnect() {
  state.running = false;
  log('disconnected');
}
