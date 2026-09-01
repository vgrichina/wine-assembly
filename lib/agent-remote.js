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

const state = {
  session: null, hub: null, running: false, token: null,
  // Input exclusivity: while an agent is driving, the human's own mouse and
  // keyboard must not also reach the guest (a stray mousemove edge-scrolled
  // Heroes II's map out from under the agent's path clicks). `inputBlocked`
  // is the live state; `autoEngage` is switched off for good the first time
  // the user unchecks the toolbar box, so a session they took back stays
  // theirs.
  inputBlocked: false, autoEngage: true,
};

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
  // Dispatch on the canvas, not window: a real keystroke targets the focused
  // element, and code downstream treats e.target as a Node (Node.contains
  // throws on `window` as an argument). bubbles:true still reaches
  // lib/browser-input.js's window-capture listeners.
  (canvasEl() || window).dispatchEvent(event);
}

// The guard: window-capture listeners installed once, at connect. They are
// inert until state.inputBlocked is set, and they only ever drop TRUSTED
// events aimed at the screen canvas — the synthetic events execEntry
// dispatches carry isTrusted=false, and the ?debug toolbar (checkbox
// included) is never in the target chain, so both keep working.
//
// Registration order is what makes this win: same-node capture listeners run
// in registration order, and lib/browser-input.js adds its drag-time
// window-capture mousemove/mouseup only once a drag starts — later than this.
// Keys cannot be won that way (browser-input registers those at page load),
// so window.__agentInputExclusive is the cooperative flag its
// shouldIgnorePageKey() reads instead.
const GUARDED = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick',
  'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend'];
let guardInstalled = false;

function installInputGuard() {
  if (guardInstalled || typeof window === 'undefined') return;
  guardInstalled = true;
  const onGuarded = (e) => {
    if (!state.inputBlocked || !e.isTrusted) return;
    const canvas = canvasEl();
    if (!canvas) return;
    const target = e.target;
    if (target !== canvas
      && !(target instanceof Node && canvas.contains && canvas.contains(target))) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  };
  for (const type of GUARDED) {
    window.addEventListener(type, onGuarded, { capture: true, passive: false });
  }
}

// `blocked` true = the agent owns input; false = the user's own mouse and
// keys reach the guest again. `manual` marks the toolbar checkbox as the
// source, which retires auto-engage for the rest of the session.
export function setInputBlocked(blocked, opts) {
  const next = !!blocked;
  if (opts && opts.manual && !next) state.autoEngage = false;
  if (state.inputBlocked === next) return next;
  state.inputBlocked = next;
  try {
    window.__agentInputExclusive = next;
    window.__agentRemote = state;
    window.dispatchEvent(new CustomEvent('agent-remote-input',
      { detail: { blocked: next, autoEngage: state.autoEngage } }));
  } catch (_) {}
  log(next ? 'user input blocked (agent is driving)' : 'user input released');
  return next;
}

function safeValue(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value,
      (k, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v)));
  } catch (_) { return String(value); }
}

function execEntry(entry) {
  // The first input command an agent actually sends is what takes the page —
  // not the connect, because the dev-server auto-connects every page it
  // serves and people play on those normally most of the time.
  if (state.autoEngage) setInputBlocked(true);
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
  // The registry the desktop icons read, via the shell's own select +
  // launchApp() — the same path the Launch button takes, so the agent
  // launches exactly what a person launches.
  if (cmd.action === 'apps') {
    const select = document.getElementById('app-select');
    if (!select) throw new Error('no #app-select on this page');
    return [...select.options].map(o => o.value).filter(Boolean);
  }
  if (cmd.action === 'launch') {
    const id = String(cmd.app || '');
    const select = document.getElementById('app-select');
    if (!select) throw new Error('no #app-select on this page');
    if (typeof window.launchApp !== 'function') throw new Error('page has no launchApp()');
    if (![...select.options].some(o => o.value === id)) {
      const near = [...select.options].map(o => o.value)
        .filter(v => id && v.includes(id)).slice(0, 8);
      throw new Error(`no app ${JSON.stringify(id)} in the registry`
        + (near.length ? ` — close: ${near.join(', ')}` : ' (list them with the apps action)'));
    }
    select.value = id;
    window.launchApp();
    return { launched: id };
  }
  // Hand input back to the person at the keyboard ("on"), or take it ("off").
  if (cmd.action === 'user-input') {
    const mode = String(cmd.mode || '');
    if (mode !== 'on' && mode !== 'off') throw new Error('user-input needs mode "on" or "off"');
    setInputBlocked(mode === 'off');
    return { userInput: state.inputBlocked ? 'off' : 'on' };
  }
  if (cmd.cmd) return execEntry(cmd.cmd);
  throw new Error('need {cmd:"action:args"} or action: ping|snapshot|eval|png|apps|launch|user-input');
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
  return 'Drive my live wine-assembly session:\n'
    + `  node tools/ctl.js -s '${location.href}' snapshot\n`
    + `Protocol instructions: curl ${state.hub}/api/agent\n`
    + `Session ${state.session}.`;
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
      app: (() => {
        const running = window.wineShell && window.wineShell.runningApps;
        return (running && running.length && running[running.length - 1].name) || null;
      })(),
    }),
  });
  const body = await response.json();
  if (!body.sessionId) throw new Error(`hub refused: ${JSON.stringify(body)}`);
  state.session = body.sessionId;
  log(`connected as session ${body.sessionId} via ${state.hub}`);
  // Announce the live session so page chrome can appear only when there is
  // actually a hub behind it (index.html's Agent handoff control listens).
  try {
    window.__agentRemote = state;
    window.dispatchEvent(new CustomEvent('agent-remote-connected',
      { detail: { session: state.session, hub: state.hub } }));
  } catch (_) {}
}

export async function connect(hub) {
  if (state.running) { log(`already connected as ${state.session}`); return state.session; }
  const self = new URL(import.meta.url);
  state.hub = (hub || self.origin).replace(/\/$/, '');
  state.token = self.searchParams.get('token') || null;
  // Installed before the first command can arrive, and before any drag adds
  // its own window-capture listeners; inert until an input command engages it.
  installInputGuard();
  await hello();
  state.running = true;
  pollLoop();
  return state.session;
}

export function disconnect() {
  state.running = false;
  // Nobody is driving any more; never leave the page's own input blocked.
  setInputBlocked(false);
  log('disconnected');
}
