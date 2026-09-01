// On-screen buttons and a dpad for guests that are driven by the keyboard.
//
// A phone can generate a click and nothing else. Every keyboard game in the
// registry is therefore unplayable there -- Pinball's flippers are Z and '/',
// SkiFree steers with the arrows, and no amount of tapping the canvas produces
// a WM_KEYDOWN. The on-screen keyboard (lib/mobile-keyboard.js) is the wrong
// instrument for this: it is a text-entry proxy that repeats, autocorrects and
// cannot hold two keys at once, and holding two keys at once IS the flipper.
//
// So: a DOM overlay of real buttons over the canvas, each wired straight to
// renderer.handleKeyDown/handleKeyUp -- the same two calls lib/browser-input.js
// makes for a physical key, so nothing downstream can tell the difference.
//
// Three constraints the code cannot show on its own:
//
//   * The overlay covers the canvas, so the container is pointer-events:none
//     and only the buttons themselves take input. Anything else eats the taps
//     meant for the game underneath.
//   * A touch is tracked by its `identifier`, not by "the finger is down".
//     Two flippers pressed together are two live touches, and releasing one
//     must not release the other's key.
//   * Keys are released on touchcancel as well as touchend. iOS cancels
//     touches for its own reasons (a system gesture, a call arriving); a
//     missed release leaves the guest with a key stuck down forever.
//
// Three widget kinds:
//
//   buttons — a labelled pill in one of the four corners. The label names the
//     ACTION ("Flip", "Nudge", "New game"); the vk is wiring, not UI. A button
//     may instead carry `command:` and post a WM_COMMAND, for a game whose
//     new-game action is a menu item rather than a key.
//   dpad — a floating joystick.
//   zones — transparent regions laid over the game itself, positioned in
//     FRACTIONS of the presented app rectangle. Pinball's flippers are at the
//     bottom of the table, so pressing the table there is the control; a
//     labelled button in the corner is a worse version of the same thing. A
//     zone swallows the touches in its area (a stray WM_LBUTTONDOWN mid-ball
//     is exactly what you do not want); a tap outside every zone still reaches
//     the game. Zones follow renderer.getPresentedRectClient(), so the crop,
//     the zoom and the bottom inset below all move them together.
//
// The bottom band the corner widgets occupy is published as
// getOccupiedHeight()/getOccupiedFraction(); lib/renderer.js reserves it in
// the single-app zoom so a small game is pushed UP above the controls rather
// than drawn underneath them.

(function () {
  'use strict';

  const VK = { LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28 };

  const CORNERS = ['bl', 'br', 'tl', 'tr'];

  const STYLE_ID = 'touch-controls-style';

  // A physical keyboard's own repeat, near enough: long enough that a
  // deliberate single step is not doubled, fast enough to cross a board.
  const REPEAT_DELAY_MS = 300;
  const REPEAT_INTERVAL_MS = 150;

  // Dominant-axis travel that separates a swipe from a tap, in CSS pixels.
  const SWIPE_PX = 30;

  // Kept in the module rather than index.html so wiring the overlay into a
  // page costs one script tag.
  const CSS = `
#touch-controls {
  position: absolute; inset: 0; pointer-events: none;
  /* Above the canvas (2) and below the page-fullscreen chrome (40): the exit
     button and the "Add to Home Screen" hint are the two things a visitor
     must always be able to reach. */
  z-index: 30; overflow: hidden;
  touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
#touch-controls .tc-corner {
  position: absolute; display: flex; gap: 12px; pointer-events: none;
  z-index: 2;
}
#touch-controls .tc-bl {
  left: 0; bottom: 0; flex-direction: column-reverse; align-items: flex-start;
  padding: 16px calc(18px + env(safe-area-inset-right, 0px))
           calc(18px + env(safe-area-inset-bottom, 0px))
           calc(18px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-br {
  right: 0; bottom: 0; flex-direction: column-reverse; align-items: flex-end;
  padding: 16px calc(18px + env(safe-area-inset-right, 0px))
           calc(18px + env(safe-area-inset-bottom, 0px))
           calc(18px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-tl {
  left: 0; top: 0; flex-direction: column; align-items: flex-start;
  padding: calc(16px + env(safe-area-inset-top, 0px))
           calc(18px + env(safe-area-inset-right, 0px)) 16px
           calc(18px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-tr {
  right: 0; top: 0; flex-direction: column; align-items: flex-end;
  padding: calc(16px + env(safe-area-inset-top, 0px))
           calc(18px + env(safe-area-inset-right, 0px)) 16px
           calc(18px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-row { display: flex; gap: 12px; align-items: flex-end; }
#touch-controls .tc-br .tc-row, #touch-controls .tc-tr .tc-row {
  flex-direction: row-reverse;
}
/* A game control layer, not a Win98 dialog: translucent dark pills that read
   over both a bright board and a black playfield, and stay quiet enough that
   the game is still the thing on screen. */
#touch-controls .tc-btn {
  pointer-events: auto;
  min-width: 58px; min-height: 58px;
  padding: 0 18px;
  display: flex; align-items: center; justify-content: center;
  font: 600 15px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.2px; white-space: nowrap;
  color: rgba(255,255,255,0.94);
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  background: rgba(18,20,26,0.42);
  border: 1px solid rgba(255,255,255,0.28);
  border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.30);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  transition: transform 90ms ease-out, background-color 90ms ease-out,
              opacity 90ms ease-out;
}
#touch-controls .tc-btn.tc-down {
  background: rgba(255,255,255,0.30);
  border-color: rgba(255,255,255,0.55);
  transform: scale(0.94);
}
/* The discrete pad. A tile game (Rodent's Revenge, Rattler, Funtris) does not
   poll a held direction -- it moves one square per keystroke -- so its control
   is four buttons that PULSE, not an analogue stick that holds. */
#touch-controls .tc-cross {
  pointer-events: none;
  position: relative; width: 168px; height: 168px;
}
#touch-controls .tc-cross .tc-arrow {
  pointer-events: auto; position: absolute;
  width: 56px; height: 56px;
  display: flex; align-items: center; justify-content: center;
  font: 600 20px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: rgba(255,255,255,0.94);
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  background: rgba(18,20,26,0.42);
  border: 1px solid rgba(255,255,255,0.28);
  border-radius: 14px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.30);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  transition: transform 90ms ease-out, background-color 90ms ease-out;
}
#touch-controls .tc-cross .tc-arrow.tc-down {
  background: rgba(255,255,255,0.30);
  border-color: rgba(255,255,255,0.55);
  transform: scale(0.92);
}
#touch-controls .tc-cross .tc-up    { left: 56px; top: 0; }
#touch-controls .tc-cross .tc-left  { left: 0; top: 56px; }
#touch-controls .tc-cross .tc-right { left: 112px; top: 56px; }
#touch-controls .tc-cross .tc-down-btn { left: 56px; top: 112px; }
#touch-controls .tc-dpad {
  pointer-events: auto;
  position: relative; width: 140px; height: 140px; border-radius: 50%;
  background: rgba(18,20,26,0.34);
  border: 1px solid rgba(255,255,255,0.22);
  box-shadow: 0 2px 12px rgba(0,0,0,0.30);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
#touch-controls .tc-dpad .tc-nub {
  position: absolute; left: 50%; top: 50%; width: 54px; height: 54px;
  margin: -27px 0 0 -27px; border-radius: 50%;
  background: rgba(255,255,255,0.34);
  border: 1px solid rgba(255,255,255,0.45);
  box-shadow: 0 1px 6px rgba(0,0,0,0.25);
  transition: background-color 90ms ease-out;
}
#touch-controls .tc-dpad.tc-down .tc-nub { background: rgba(255,255,255,0.52); }
/* In-place zones: the control IS the thing on screen (pinball's flippers are
   at the bottom of the table, so that is where you press). Invisible at rest
   apart from a hairline, and a brief wash while held so the region can be
   learned. They sit UNDER the corner widgets (z-index 1 vs 2). */
/* The view-mode toggle. Left edge, vertically centred: every corner is spoken
   for -- top-right by the page-fullscreen exit and the debug peek, the other
   three by the control clusters. */
#touch-controls .tc-mode,
#touch-controls .tc-key {
  pointer-events: auto; position: absolute; z-index: 3;
  left: calc(10px + env(safe-area-inset-left, 0px)); top: 50%;
  transform: translateY(-50%);
  min-width: 40px; height: 40px; padding: 0 10px;
  display: flex; align-items: center; justify-content: center;
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: rgba(255,255,255,0.9); text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  background: rgba(18,20,26,0.36);
  border: 1px solid rgba(255,255,255,0.22);
  border-radius: 999px;
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
#touch-controls .tc-mode.tc-down,
#touch-controls .tc-key.tc-down { background: rgba(255,255,255,0.28); }
/* The keyboard pill reads as a latch, not a button: while the keyboard is up
   it stays lit, because that is the only on-screen evidence of which state
   the toggle is in. */
#touch-controls .tc-key { font-size: 16px; }
#touch-controls .tc-key.tc-on {
  background: rgba(120,190,255,0.42);
  border-color: rgba(255,255,255,0.55);
  color: #fff;
}
/* The swipe field is the whole picture and must not look like anything. */
#touch-controls .tc-swipe {
  position: absolute; pointer-events: auto; z-index: 0;
  background: transparent; border: 0;
}
#touch-controls .tc-zone {
  position: absolute; pointer-events: auto; z-index: 1;
  background: rgba(255,255,255,0);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 10px;
  transition: background-color 140ms ease-out, border-color 140ms ease-out;
}
#touch-controls .tc-zone.tc-down {
  background: rgba(255,255,255,0.10);
  border-color: rgba(255,255,255,0.28);
  transition-duration: 40ms;
}
`;

  function ensureStyle(doc) {
    if (!doc || typeof doc.createElement !== 'function') return;
    if (doc.getElementById && doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    const head = doc.head || doc.body;
    if (head && head.appendChild) head.appendChild(style);
  }

  // A TouchList is array-like but not iterable in every WebKit build we run on.
  function changedTouches(e) {
    const list = e && e.changedTouches;
    if (!list) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) out.push(list[i]);
    return out;
  }

  function normalizeCorner(pos) {
    const p = String(pos || 'bl').toLowerCase();
    return CORNERS.indexOf(p) >= 0 ? p : 'bl';
  }

  // Eight sectors around the pad, each naming the arrow keys held there. The
  // diagonals hold two, which is what a guest polling GetAsyncKeyState for two
  // directions expects; a 4-way pad simply rounds each diagonal to one axis.
  const SECTORS = [
    [VK.RIGHT], [VK.RIGHT, VK.UP], [VK.UP], [VK.LEFT, VK.UP],
    [VK.LEFT], [VK.LEFT, VK.DOWN], [VK.DOWN], [VK.RIGHT, VK.DOWN],
  ];

  // dx/dy are in screen coordinates, so dy grows downward and "up" is negative.
  function dpadKeys(dx, dy, ways) {
    const eightWay = ways !== 4;
    const angle = Math.atan2(-dy, dx);
    const step = eightWay ? Math.PI / 4 : Math.PI / 2;
    let index = Math.round(angle / step);
    const count = eightWay ? 8 : 4;
    index = ((index % count) + count) % count;
    return eightWay ? SECTORS[index] : SECTORS[index * 2];
  }

  const TouchControls = {
    installed: false,
    el: null,
    layout: null,
    _renderer: null,
    _doc: null,
    _listeners: [],
    _touches: null,          // touch identifier -> { kind, vk, el, keys }
    _held: null,             // vk -> number of touches holding it
    _widgets: [],
    _zones: [],              // the tc-zone elements, re-laid-out on a poll
    _zoneTimer: null,

    // `?touch-controls=1` forces the overlay on a desktop for development, and
    // `=0` takes it off a phone. Otherwise: only where there is no mouse.
    shouldInstall() {
      try {
        if (typeof location !== 'undefined' && location.search) {
          const params = new URLSearchParams(location.search);
          if (params.has('touch-controls')) {
            return params.get('touch-controls') !== '0';
          }
        }
      } catch (_) {}
      if (typeof window !== 'undefined' && 'ontouchstart' in window) return true;
      if (typeof matchMedia !== 'function') return false;
      return matchMedia('(pointer: coarse)').matches;
    },

    install(options) {
      if (this.installed) return this;
      const opts = options || {};
      this._doc = opts.document || (typeof document !== 'undefined' ? document : null);
      if (!this._doc) return this;
      this._renderer = opts.renderer || null;
      this._touches = new Map();
      this._held = new Map();
      this._widgets = [];
      this._zones = [];

      ensureStyle(this._doc);
      const container = opts.container ||
        (this._doc.getElementById && this._doc.getElementById('screen-wrap')) ||
        this._doc.body;
      const el = this._doc.createElement('div');
      el.id = 'touch-controls';
      el.setAttribute('aria-hidden', 'true');
      el.style.display = 'none';
      if (container && container.appendChild) container.appendChild(el);
      this.el = el;
      this.container = container;
      this.installed = true;
      return this;
    },

    // The renderer is shared and created after the overlay, so it is resolved
    // per key rather than captured at install.
    setRenderer(renderer) { this._renderer = renderer; return this; },

    _renderer_() {
      if (typeof this._renderer === 'function') return this._renderer();
      return this._renderer;
    },

    _key(vk, down) {
      const renderer = this._renderer_();
      if (!renderer) return;
      const info = { code: '', location: 0, repeat: false };
      if (down) renderer.handleKeyDown(vk, info);
      else renderer.handleKeyUp(vk, info);
    },

    // A menu command as a button. Funtris starts a game from its "Start!" menu
    // and no key does it, so the only honest control is the WM_COMMAND the
    // menu would have posted -- the same one test/run.js sends as `post-cmd`.
    // Posted, not sent: a synchronous send would reenter the guest from a DOM
    // event handler.
    _command(id) {
      const renderer = this._renderer_();
      if (!renderer || !renderer.windows) return false;
      const top = Object.values(renderer.windows)
        .filter(w => w && w.visible && !w.isChild)
        .reduce((best, w) => ((w.zOrder || 0) > (best ? best.zOrder || 0 : -1) ? w : best), null);
      const we = top && top.wasm && top.wasm.exports;
      if (!we || !we.post_message_q) return false;
      we.post_message_q(top.hwnd | 0, 0x0111 /* WM_COMMAND */, id | 0, 0);
      if (renderer.scheduleRepaint) renderer.scheduleRepaint();
      return true;
    },

    // Reference-counted, because two widgets can legitimately hold one vk (a
    // dpad diagonal and a spare arrow button). Releasing one must not tell the
    // guest the key came up while the other is still pressed.
    _press(vk) {
      const n = this._held.get(vk) || 0;
      this._held.set(vk, n + 1);
      if (n === 0) this._key(vk, true);
    },

    _release(vk) {
      const n = this._held.get(vk) || 0;
      if (n <= 1) {
        this._held.delete(vk);
        if (n === 1) this._key(vk, false);
        return;
      }
      this._held.set(vk, n - 1);
    },

    _on(target, type, fn) {
      target.addEventListener(type, fn, { passive: false });
      this._listeners.push([target, type, fn]);
    },

    _cornerNode(corner) {
      if (!this._corners) this._corners = {};
      if (this._corners[corner]) return this._corners[corner];
      const node = this._doc.createElement('div');
      node.className = 'tc-corner tc-' + corner;
      this.el.appendChild(node);
      this._corners[corner] = node;
      return node;
    },

    _rowNode(corner, row) {
      const key = corner + ':' + row;
      if (!this._rows) this._rows = {};
      if (this._rows[key]) return this._rows[key];
      const node = this._doc.createElement('div');
      node.className = 'tc-row';
      this._cornerNode(corner).appendChild(node);
      this._rows[key] = node;
      return node;
    },

    // Replaces whatever is on screen. Passing null/undefined hides the overlay
    // and releases anything still held.
    setLayout(config) {
      if (!this.installed) return this;
      this._clearWidgets();
      this._fracAt = 0;
      this.layout = config || null;
      if (!config) {
        this.el.style.display = 'none';
        return this;
      }
      if (config.viewToggle !== false) this._addModeToggle();
      if (config.keyboard !== false) this._addKeyboardToggle();
      if (config.swipes) this._addSwipeField(config.swipes);
      const zones = Array.isArray(config.zones) ? config.zones : [];
      for (const spec of zones) this._addZone(spec);
      const buttons = Array.isArray(config.buttons) ? config.buttons : [];
      for (const spec of buttons) this._addButton(spec);
      const dpads = config.dpad ? [config.dpad] : (config.dpads || []);
      for (const spec of dpads) {
        if (spec && spec.style === 'cross') this._addCross(spec);
        else this._addDpad(spec);
      }
      this._hasGameControls =
        !!(buttons.length || dpads.length || zones.length || config.swipes);
      this.el.style.display =
        (this._hasGameControls || this._modeEl || this._keyEl) ? 'block' : 'none';
      if (this._zones.length || this._modeEl || this._keyEl) this._startZoneTracking();
      return this;
    },

    _addButton(spec) {
      if (!spec || (!Number.isFinite(spec.vk) && !Number.isFinite(spec.command))) return;
      const el = this._doc.createElement('button');
      el.type = 'button';
      el.className = 'tc-btn';
      el.textContent = spec.label === undefined ? String(spec.vk) : String(spec.label);
      el.setAttribute('aria-label', spec.title || spec.label || ('key ' + spec.vk));
      if (spec.width) el.style.minWidth = spec.width + 'px';
      const corner = normalizeCorner(spec.pos);
      el._tcCorner = corner;
      el._tcRow = spec.row | 0;
      el._tcHeight = 58;
      // A command button is a one-shot by construction: there is no "held"
      // WM_COMMAND.
      const command = Number.isFinite(spec.command) ? spec.command | 0 : null;
      const hold = command === null && spec.hold !== false;
      const vk = spec.vk | 0;

      const begin = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          if (this._touches.has(t.identifier)) continue;
          this._touches.set(t.identifier, { kind: 'button', vk, el, hold });
          el.classList.add('tc-down');
          if (command !== null) this._command(command);
          else if (hold) this._press(vk);
          else { this._key(vk, true); this._key(vk, false); }
        }
      };
      const end = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el) continue;
          this._touches.delete(t.identifier);
          el.classList.remove('tc-down');
          if (entry.hold) this._release(entry.vk);
        }
      };
      this._on(el, 'touchstart', begin);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      // A button under a real pointer is a development convenience, not a
      // second input path: it is the same press/release the touch takes.
      this._on(el, 'contextmenu', (e) => e.preventDefault());

      this._rowNode(corner, spec.row | 0).appendChild(el);
      this._widgets.push(el);
    },

    _addDpad(spec) {
      const opts = spec || {};
      const el = this._doc.createElement('div');
      el.className = 'tc-dpad';
      el.setAttribute('aria-label', 'direction pad');
      el._tcCorner = normalizeCorner(opts.pos);
      el._tcRow = opts.row | 0;
      el._tcHeight = 140;
      const nub = this._doc.createElement('div');
      nub.className = 'tc-nub';
      el.appendChild(nub);
      const ways = opts.ways === 4 ? 4 : 8;
      const dead = Number.isFinite(opts.deadZone) ? opts.deadZone : 14;
      const map = opts.vks || {};
      // A layout may rename the directions (numpad steering, WASD); the arrow
      // keys are only the default.
      const remap = (vk) => {
        if (vk === VK.UP && Number.isFinite(map.up)) return map.up | 0;
        if (vk === VK.DOWN && Number.isFinite(map.down)) return map.down | 0;
        if (vk === VK.LEFT && Number.isFinite(map.left)) return map.left | 0;
        if (vk === VK.RIGHT && Number.isFinite(map.right)) return map.right | 0;
        return vk;
      };

      const centerOf = () => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      };
      const applyKeys = (entry, keys) => {
        const next = keys.map(remap);
        for (const vk of entry.keys) if (next.indexOf(vk) < 0) this._release(vk);
        for (const vk of next) if (entry.keys.indexOf(vk) < 0) this._press(vk);
        entry.keys = next;
        if (next.length) el.classList.add('tc-down');
        else el.classList.remove('tc-down');
        const dx = entry.lastDx || 0;
        const dy = entry.lastDy || 0;
        const len = Math.hypot(dx, dy) || 1;
        const cap = Math.min(len, 40);
        nub.style.transform = next.length
          ? `translate(${(dx / len) * cap}px, ${(dy / len) * cap}px)`
          : 'translate(0px, 0px)';
      };
      const track = (entry, t) => {
        const c = centerOf();
        const dx = t.clientX - c.x;
        const dy = t.clientY - c.y;
        entry.lastDx = dx;
        entry.lastDy = dy;
        applyKeys(entry, Math.hypot(dx, dy) < dead ? [] : dpadKeys(dx, dy, ways));
      };

      const begin = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          if (this._touches.has(t.identifier)) continue;
          const entry = { kind: 'dpad', el, keys: [] };
          this._touches.set(t.identifier, entry);
          track(entry, t);
        }
      };
      const move = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el) continue;
          track(entry, t);
        }
      };
      const end = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el) continue;
          this._touches.delete(t.identifier);
          entry.lastDx = 0;
          entry.lastDy = 0;
          applyKeys(entry, []);
        }
      };
      this._on(el, 'touchstart', begin);
      this._on(el, 'touchmove', move);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      this._on(el, 'contextmenu', (e) => e.preventDefault());

      this._rowNode(normalizeCorner(opts.pos), opts.row | 0).appendChild(el);
      this._widgets.push(el);
    },

    // Fit <-> zoom. The affordance exists because the gesture is invisible:
    // nobody discovers a pinch on a page that has never had one.
    _addModeToggle() {
      const el = this._doc.createElement('button');
      el.type = 'button';
      el.className = 'tc-mode';
      el.setAttribute('aria-label', 'switch between fitting and filling the screen');
      this._modeEl = el;
      const press = (e) => {
        e.preventDefault();
        el.classList.add('tc-down');
        this.toggleViewMode();
      };
      const end = (e) => { e.preventDefault(); el.classList.remove('tc-down'); };
      this._on(el, 'touchstart', press);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      this._on(el, 'contextmenu', (e) => e.preventDefault());
      this.el.appendChild(el);
      this._widgets.push(el);
      this.syncViewMode();
    },

    // The manual keyboard. This exists for EVERY app on a touch device, with
    // or without a control layout, because the apps that need it most are the
    // ones with no layout at all: a fullscreen DirectDraw game draws its own
    // text field, never calls CreateCaret, and so is invisible to the
    // caret-driven keyboard in lib/browser-input.js. Diablo II's character
    // name is unreachable on a phone without it.
    _addKeyboardToggle() {
      const el = this._doc.createElement('button');
      el.type = 'button';
      el.className = 'tc-key';
      el.textContent = '⌨';        // KEYBOARD
      el.setAttribute('aria-label', 'show or hide the keyboard');
      this._keyEl = el;
      const press = (e) => {
        // preventDefault, but NOT stopPropagation: the focus() below has to
        // run inside this very gesture or iOS will not open the keyboard.
        if (e && e.preventDefault) e.preventDefault();
        el.classList.add('tc-down');
        this.toggleKeyboard();
      };
      const end = (e) => {
        if (e && e.preventDefault) e.preventDefault();
        el.classList.remove('tc-down');
      };
      this._on(el, 'touchstart', press);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      // Desktop development (`?touch-controls=1`) has no touch events.
      this._on(el, 'mousedown', (e) => {
        if (e && e.__tcFromTouch) return;
        press(e);
        end(e);
      });
      this._on(el, 'contextmenu', (e) => e.preventDefault());
      this.el.appendChild(el);
      this._widgets.push(el);
      this.syncKeyboardToggle();
    },

    toggleKeyboard() {
      const fn = typeof window !== 'undefined' ? window.__wineToggleKeyboard : null;
      let open = false;
      if (typeof fn === 'function') {
        try { open = !!fn(); } catch (_) { open = false; }
      }
      this.syncKeyboardToggle(open);
      return open;
    },

    // `state` is what the toggle just returned; without one, ask the page.
    syncKeyboardToggle(state) {
      if (!this._keyEl) return this;
      let open = state;
      if (open === undefined) {
        const probe = typeof window !== 'undefined' ? window.__wineKeyboardOpen : null;
        try { open = typeof probe === 'function' ? !!probe() : false; } catch (_) { open = false; }
      }
      if (open) this._keyEl.classList.add('tc-on');
      else this._keyEl.classList.remove('tc-on');
      return this;
    },

    // The label names what a press will DO, which is the opposite of the mode
    // you are in.
    syncViewMode() {
      if (!this._modeEl) return this;
      const renderer = this._renderer_();
      const zoom = !!(renderer && renderer.viewMode === 'zoom');
      this._modeEl.textContent = zoom ? 'Fit' : 'Fill';
      return this;
    },

    setViewMode(mode) {
      const renderer = this._renderer_();
      if (!renderer || !renderer.setViewMode) return false;
      const changed = renderer.setViewMode(mode);
      this.syncViewMode();
      if (changed) this.layoutZones();
      return changed;
    },

    toggleViewMode() {
      const renderer = this._renderer_();
      const zoom = !!(renderer && renderer.viewMode === 'zoom');
      return this.setViewMode(zoom ? 'fit' : 'zoom');
    },

    // One complete keystroke. A tile game moves a square per keystroke, so a
    // finger held on a direction has to keep producing them -- a real keyboard
    // repeats, and holding our continuous pad sent exactly one keydown and
    // then nothing, which is a control that feels dead after the first step.
    _pulse(vk) {
      this._key(vk, true);
      this._key(vk, false);
    },

    _startRepeat(entry, vk) {
      this._pulse(vk);
      if (typeof setTimeout !== 'function') return;
      entry.repeatTimer = setTimeout(() => {
        entry.repeatTimer = null;
        entry.repeatInterval = setInterval(() => this._pulse(vk), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    },

    _stopRepeat(entry) {
      if (!entry) return;
      if (entry.repeatTimer) { clearTimeout(entry.repeatTimer); entry.repeatTimer = null; }
      if (entry.repeatInterval) { clearInterval(entry.repeatInterval); entry.repeatInterval = null; }
    },

    // The discrete pad: four arrows in a cross, each a pulse with keyboard
    // auto-repeat under a hold.
    _addCross(spec) {
      const opts = spec || {};
      const map = opts.vks || {};
      const pad = this._doc.createElement('div');
      pad.className = 'tc-cross';
      pad.setAttribute('aria-label', 'direction pad');
      pad._tcCorner = normalizeCorner(opts.pos);
      pad._tcRow = opts.row | 0;
      pad._tcHeight = 168;

      const dirs = [
        ['up', 'tc-arrow tc-up', '▲', Number.isFinite(map.up) ? map.up | 0 : VK.UP],
        ['left', 'tc-arrow tc-left', '◀', Number.isFinite(map.left) ? map.left | 0 : VK.LEFT],
        ['right', 'tc-arrow tc-right', '▶', Number.isFinite(map.right) ? map.right | 0 : VK.RIGHT],
        ['down', 'tc-arrow tc-down-btn', '▼', Number.isFinite(map.down) ? map.down | 0 : VK.DOWN],
      ];
      for (const [name, cls, glyph, vk] of dirs) {
        const el = this._doc.createElement('button');
        el.type = 'button';
        el.className = cls;
        el.textContent = glyph;
        el.setAttribute('aria-label', name);
        el._tcDir = name;
        el._tcVk = vk;
        const begin = (e) => {
          e.preventDefault();
          for (const t of changedTouches(e)) {
            if (this._touches.has(t.identifier)) continue;
            const entry = { kind: 'cross', vk, el };
            this._touches.set(t.identifier, entry);
            el.classList.add('tc-down');
            this._startRepeat(entry, vk);
          }
        };
        const end = (e) => {
          e.preventDefault();
          for (const t of changedTouches(e)) {
            const entry = this._touches.get(t.identifier);
            if (!entry || entry.el !== el) continue;
            this._touches.delete(t.identifier);
            el.classList.remove('tc-down');
            this._stopRepeat(entry);
          }
        };
        this._on(el, 'touchstart', begin);
        this._on(el, 'touchend', end);
        this._on(el, 'touchcancel', end);
        this._on(el, 'contextmenu', (e) => e.preventDefault());
        pad.appendChild(el);
      }
      this._rowNode(pad._tcCorner, pad._tcRow).appendChild(pad);
      this._widgets.push(pad);
    },

    // Client coordinates to the logical canvas coordinates the renderer's
    // input entry points take -- the same conversion lib/browser-input.js's
    // eventPointFromClient makes. Needed because a swipe field covers the
    // canvas, so a tap it decides NOT to consume has to be handed on.
    _canvasPoint(clientX, clientY) {
      const renderer = this._renderer_();
      const canvas = renderer && renderer.canvas;
      if (!canvas || !canvas.getBoundingClientRect) return null;
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return null;
      return {
        x: (clientX - r.left) * (canvas.width || r.width) / r.width,
        y: (clientY - r.top) * (canvas.height || r.height) / r.height,
      };
    },

    // Swipe the playing field. A tile game reads far better with a flick in
    // the direction you want to go than with any pad, and the field is already
    // the biggest target on the screen.
    //
    // The threshold is the whole design: under it the gesture is a tap and is
    // handed to the guest as a click, so menus and buttons keep working; over
    // it the gesture is a direction and the guest sees no mouse event at all
    // (a swipe that also clicked would drag a selection across the board).
    _addSwipeField(spec) {
      const opts = spec === true ? {} : (spec || {});
      const el = this._doc.createElement('div');
      el.className = 'tc-swipe';
      el.setAttribute('aria-label', 'swipe field');
      el._tcRect = opts.rect
        ? { x: +opts.rect.x || 0, y: +opts.rect.y || 0,
            w: +opts.rect.w || 0, h: +opts.rect.h || 0 }
        : { x: 0, y: 0, w: 1, h: 1 };
      const map = opts.vks || {};
      const vks = {
        up: Number.isFinite(map.up) ? map.up | 0 : VK.UP,
        down: Number.isFinite(map.down) ? map.down | 0 : VK.DOWN,
        left: Number.isFinite(map.left) ? map.left | 0 : VK.LEFT,
        right: Number.isFinite(map.right) ? map.right | 0 : VK.RIGHT,
      };
      const threshold = Number.isFinite(opts.threshold) ? opts.threshold : SWIPE_PX;

      const begin = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          if (this._touches.has(t.identifier)) continue;
          this._touches.set(t.identifier, {
            kind: 'swipe', el, x0: t.clientX, y0: t.clientY, fired: false,
          });
        }
      };
      const move = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el || entry.fired) continue;
          const dx = t.clientX - entry.x0;
          const dy = t.clientY - entry.y0;
          if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold) continue;
          entry.fired = true;
          const dir = Math.abs(dx) >= Math.abs(dy)
            ? (dx > 0 ? 'right' : 'left')
            : (dy > 0 ? 'down' : 'up');
          this._pulse(vks[dir]);
        }
      };
      const end = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el) continue;
          this._touches.delete(t.identifier);
          if (entry.fired) continue;
          // Under the threshold this was never a swipe: give the guest the
          // click the canvas would have seen if the field were not here.
          const renderer = this._renderer_();
          const p = this._canvasPoint(t.clientX, t.clientY);
          if (!renderer || !p || !renderer.handleMouseDown) continue;
          renderer.handleMouseDown(p.x, p.y, 0);
          if (renderer.handleMouseUp) renderer.handleMouseUp(p.x, p.y, 0);
          // Still inside the touch event, which is the only moment iOS will
          // open its keyboard: if that tap put a caret in a guest edit box,
          // this is what raises the keyboard for it.
          if (typeof window !== 'undefined' &&
              typeof window.__wineFocusKeyboardProxy === 'function') {
            window.__wineFocusKeyboardProxy();
          }
        }
      };
      this._on(el, 'touchstart', begin);
      this._on(el, 'touchmove', move);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      this._on(el, 'contextmenu', (e) => e.preventDefault());

      this.el.appendChild(el);
      this._widgets.push(el);
      this._zones.push(el);
    },

    // A transparent region over the game. `rect` is in fractions of the
    // PRESENTED app rectangle, so the same numbers hold at any window size,
    // any zoom and with or without the bottom inset.
    _addZone(spec) {
      if (!spec || !Number.isFinite(spec.vk) || !spec.rect) return;
      const el = this._doc.createElement('div');
      el.className = 'tc-zone';
      el.setAttribute('aria-label', spec.title || spec.label || ('key ' + spec.vk));
      el._tcRect = {
        x: +spec.rect.x || 0,
        y: +spec.rect.y || 0,
        w: +spec.rect.w || 0,
        h: +spec.rect.h || 0,
      };
      const vk = spec.vk | 0;

      const begin = (e) => {
        e.preventDefault();
        e.stopPropagation();
        for (const t of changedTouches(e)) {
          if (this._touches.has(t.identifier)) continue;
          this._touches.set(t.identifier, { kind: 'zone', vk, el });
          el.classList.add('tc-down');
          this._press(vk);
        }
      };
      const end = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          const entry = this._touches.get(t.identifier);
          if (!entry || entry.el !== el) continue;
          this._touches.delete(t.identifier);
          el.classList.remove('tc-down');
          this._release(entry.vk);
        }
      };
      this._on(el, 'touchstart', begin);
      this._on(el, 'touchend', end);
      this._on(el, 'touchcancel', end);
      this._on(el, 'contextmenu', (e) => e.preventDefault());

      this.el.appendChild(el);
      this._widgets.push(el);
      this._zones.push(el);
    },

    // Where the guest's picture actually is on the page. Nothing fires when
    // the guest resizes its own window or switches display mode, so this is a
    // poll rather than an event -- two getBoundingClientRect calls every
    // 250ms, and only while a layout has zones.
    _startZoneTracking() {
      this.layoutZones();
      if (this._zoneTimer || typeof setInterval !== 'function') return;
      this._zoneTimer = setInterval(() => this.layoutZones(), 250);
      if (typeof window !== 'undefined' && window.addEventListener) {
        this._zoneResize = () => this.layoutZones();
        window.addEventListener('resize', this._zoneResize);
        window.addEventListener('orientationchange', this._zoneResize);
      }
    },

    _stopZoneTracking() {
      if (this._zoneTimer) { clearInterval(this._zoneTimer); this._zoneTimer = null; }
      if (this._zoneResize && typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('resize', this._zoneResize);
        window.removeEventListener('orientationchange', this._zoneResize);
      }
      this._zoneResize = null;
    },

    // Public so a test (and the shell, after a mode switch) can force it.
    layoutZones() {
      if (!this.el) return this;
      const renderer = this._renderer_();
      const app = renderer && typeof renderer.getPresentedRectClient === 'function'
        ? renderer.getPresentedRectClient() : null;
      const host = this.el.getBoundingClientRect ? this.el.getBoundingClientRect() : null;
      if (!host) return this;
      if (!app || !(app.w > 0) || !(app.h > 0)) {
        // No presented rect to hang zones off, but the pills still have to go
        // somewhere -- a full-bleed host means no letterbox, which is exactly
        // the edge-pill case.
        this._placeModeToggle(
          { x: host.left, y: host.top, w: host.width, h: host.height }, host);
        return this;
      }
      const ox = app.x - host.left;
      const oy = app.y - host.top;
      for (const el of this._zones) {
        const r = el._tcRect;
        el.style.left = (ox + r.x * app.w) + 'px';
        el.style.top = (oy + r.y * app.h) + 'px';
        el.style.width = (r.w * app.w) + 'px';
        el.style.height = (r.h * app.h) + 'px';
      }
      // A guest text field beats every gesture on this layer. The high-score
      // dialog Rodent's Revenge puts up wants a name typed into it, and a
      // swipe field over the picture would eat the tap that focuses the edit
      // control -- and with it the gesture iOS requires to open its keyboard.
      const caret = renderer && typeof renderer.caretRect === 'function'
        ? renderer.caretRect() : null;
      for (const el of this._zones) el.style.pointerEvents = caret ? 'none' : 'auto';
      this._placeModeToggle(app, host);
      return this;
    },

    // The toggle lives in dead space. It is a control you touch twice a
    // session, so it must never sit on the picture or next to the pad, where
    // the cost of finding it once is much lower than the cost of hitting it by
    // accident: the letterbox bar is exactly the part of the screen where
    // nothing else can ever be.
    _placeModeToggle(app, host) {
      // Both pills share one strip of dead space, so they are placed together
      // -- two independent placers would each centre themselves in the same
      // gap and land on top of each other.
      const pills = [this._keyEl, this._modeEl].filter(Boolean);
      if (!pills.length) return;
      const MIN_BAND = 46;
      const size = 40;
      const PILL_GAP = 10;
      const spanFor = (n) => n * size + (n - 1) * PILL_GAP;
      const topBand = (app.y - host.top);
      const bottomBand = (host.bottom - (app.y + app.h));
      for (const p of pills) {
        p.style.transform = 'none';
        p.style.width = size + 'px';
      }
      if (bottomBand >= MIN_BAND || topBand >= MIN_BAND) {
        // Prefer the bigger bar. Inside it, aim for the gap BETWEEN the two
        // corner clusters -- "the middle of the bar" is not the same thing
        // once a 168px cross pad is sitting in the left corner, and landing
        // on a direction key by mistake is the whole thing to avoid.
        const bottom = bottomBand >= topBand;
        const band = bottom ? bottomBand : topBand;
        const corners = bottom ? ['bl', 'br'] : ['tl', 'tr'];
        let leftEdge = 0;
        let rightEdge = host.width || 0;
        for (const w of (this._widgets || [])) {
          if (!w._tcCorner || !w.getBoundingClientRect) continue;
          const r = w.getBoundingClientRect();
          if (!(r.width > 0)) continue;
          if (w._tcCorner === corners[0]) leftEdge = Math.max(leftEdge, r.right - host.left);
          else if (w._tcCorner === corners[1]) rightEdge = Math.min(rightEdge, r.left - host.left);
        }
        const gap = rightEdge - leftEdge;
        // How many pills that gap can take. Partial is worth having: with a
        // 168px cross pad in one corner and a command button in the other
        // there is often room for one and not two, and putting ONE of them
        // where it belongs beats sending both to the edge. The keyboard pill
        // is first in the list and so gets the good spot -- it is the one a
        // user reaches for mid-game.
        const fits = Math.max(0,
          Math.floor((gap - 8 + PILL_GAP) / (size + PILL_GAP)));
        if (fits > 0) {
          const placed = pills.splice(0, fits);
          const span = spanFor(placed.length);
          const top = bottom
            ? (app.y - host.top) + app.h + (band - size) / 2
            : (topBand - size) / 2;
          let x = leftEdge + (gap - span) / 2;
          for (const p of placed) {
            p.style.left = x + 'px';
            p.style.top = Math.max(0, top) + 'px';
            p.style.opacity = '1';
            x += size + PILL_GAP;
          }
          if (!pills.length) return;
        }
      }
      // No letterbox at all (zoom mode, or a game that fits): there is no dead
      // space, so they get an edge and get quiet rather than prime screen.
      // Stacked, never side by side -- the left edge is where the picture is
      // widest and a horizontal pair reaches further into it.
      const stack = spanFor(pills.length);
      let y = Math.max(4, (host.height || 0) / 2 - stack / 2);
      for (const p of pills) {
        p.style.left = '8px';
        p.style.top = y + 'px';
        p.style.opacity = '0.35';
        y += size + PILL_GAP;
      }
    },

    // "Are the app's own game controls up?" -- NOT "is any part of the overlay
    // on screen". The keyboard pill is now put up for every app on a touch
    // device, and the two callers of this (the renderer's bottom inset and the
    // touch-cursor suppression policy) both mean the game controls: a pill in
    // the letterbox reserves no space and is no reason to take a cursor away
    // from Solitaire.
    isVisible() {
      return !!(this.installed && this.layout && this._hasGameControls && this.el &&
        this.el.style.display !== 'none');
    },

    // "Is anything of ours on screen?" -- the pills included.
    isMounted() {
      return !!(this.installed && this.layout && this.el &&
        this.el.style.display !== 'none');
    },

    // The height of the bottom band the CORNER widgets occupy, in CSS pixels.
    // Zones are excluded on purpose: they lie over the picture and reserving
    // space for them would push the game away from its own controls.
    //
    // Measured off layout when there is layout to measure, and estimated from
    // the widget stack when there is not (a hidden page, a fake DOM).
    getOccupiedHeight() {
      if (!this.isVisible()) return 0;
      const host = this.el.getBoundingClientRect ? this.el.getBoundingClientRect() : null;
      let band = 0;
      if (host && host.height > 0) {
        for (const el of (this._widgets || [])) {
          if (el._tcCorner !== 'bl' && el._tcCorner !== 'br') continue;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          if (!r || !(r.height > 0)) continue;
          band = Math.max(band, host.bottom - r.top);
        }
        if (band > 0) return Math.min(band, host.height);
      }
      return this._estimateOccupiedHeight();
    },

    // Same number as a fraction of the overlay's own height, which is the form
    // the renderer wants: it works in presentation-canvas pixels and has no
    // business knowing the page's CSS scale.
    // Cached for a quarter second: the renderer asks once per repaint and the
    // answer is two getBoundingClientRect calls, which force layout. Nothing
    // that changes it (a layout swap, a rotation, a resize) is faster than
    // that anyway.
    getOccupiedFraction() {
      const now = typeof Date !== 'undefined' ? Date.now() : 0;
      if (this._fracAt && now - this._fracAt < 250) return this._frac;
      const value = this._occupiedFraction();
      this._fracAt = now;
      this._frac = value;
      return value;
    },

    _occupiedFraction() {
      const band = this.getOccupiedHeight();
      if (!(band > 0)) return 0;
      const host = this.el && this.el.getBoundingClientRect
        ? this.el.getBoundingClientRect() : null;
      const h = host && host.height > 0 ? host.height :
        (typeof window !== 'undefined' && window.innerHeight) || 0;
      if (!(h > 0)) return 0;
      return Math.min(1, band / h);
    },

    // Rows stack bottom-up with a 12px gap inside 18px of padding.
    _estimateOccupiedHeight() {
      const GAP = 12;
      const PAD_BOTTOM = 18;
      let best = 0;
      for (const corner of ['bl', 'br']) {
        const rows = new Map();
        for (const el of (this._widgets || [])) {
          if (el._tcCorner !== corner) continue;
          const row = el._tcRow | 0;
          rows.set(row, Math.max(rows.get(row) || 0, el._tcHeight || 58));
        }
        if (!rows.size) continue;
        let total = PAD_BOTTOM + (rows.size - 1) * GAP;
        for (const h of rows.values()) total += h;
        best = Math.max(best, total);
      }
      return best;
    },

    _clearWidgets() {
      this.releaseAll();
      for (const [target, type, fn] of this._listeners) {
        if (target.removeEventListener) target.removeEventListener(type, fn);
      }
      this._listeners = [];
      this._widgets = [];
      this._zones = [];
      this._modeEl = null;
      this._keyEl = null;
      this._hasGameControls = false;
      this._stopZoneTracking();
      this._corners = {};
      this._rows = {};
      if (this.el) {
        while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
      }
    },

    // Every key this overlay is holding goes up. Called on teardown and on any
    // layout change: an app that closed mid-flipper must not leave the next one
    // with Z down.
    releaseAll() {
      if (this._touches) {
        for (const entry of this._touches.values()) this._stopRepeat(entry);
      }
      if (!this._held) return;
      for (const vk of Array.from(this._held.keys())) this._key(vk, false);
      this._held.clear();
      if (this._touches) this._touches.clear();
    },

    destroy() {
      if (!this.installed) return;
      this._clearWidgets();
      if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.el = null;
      this.layout = null;
      this.installed = false;
    },

    // The layout an app with no touchControls entry of its own gets: the
    // keyboard pill and nothing else. Deliberately NOT the fit/fill toggle --
    // that one drives a per-app mobileCrop nobody has authored for these apps,
    // and an affordance that does nothing visible is worse than no affordance.
    // Frozen and shared so `sync` can compare it by identity and not rebuild
    // the overlay on every call.
    _chromeLayout() {
      if (!this._chromeLayoutObj) {
        this._chromeLayoutObj = { viewToggle: false, keyboard: true, chrome: true };
      }
      return this._chromeLayoutObj;
    },

    // The shell's one entry point: hand it the running-app records and it puts
    // up the layout of the most recently launched app that declares one.
    sync(runningApps, renderer) {
      if (renderer) this.setRenderer(renderer);
      const list = Array.isArray(runningApps) ? runningApps : [];
      let layout = null;
      for (let i = list.length - 1; i >= 0; i--) {
        const app = list[i];
        if (app && app.touchControls) { layout = app.touchControls; break; }
      }
      // Every running app gets the bare chrome, whether or not it declares
      // controls. The keyboard pill is the reason: Diablo II has no
      // touchControls entry and should not need one to be typed into, and no
      // registry edit can cover the apps we have not met yet.
      if (!layout && list.length) layout = this._chromeLayout();
      if (!layout) {
        if (this.installed && this.layout) this.setLayout(null);
        return this;
      }
      if (!this.installed) {
        if (!this.shouldInstall()) return this;
        this.install({ renderer });
        if (!this.installed) return this;
      }
      if (this.layout !== layout) this.setLayout(layout);
      return this;
    },
  };

  TouchControls.VK = VK;
  TouchControls._dpadKeys = dpadKeys;   // exported for the unit test

  if (typeof window !== 'undefined') window.TouchControls = TouchControls;
  if (typeof module !== 'undefined' && module.exports) module.exports = TouchControls;
})();
