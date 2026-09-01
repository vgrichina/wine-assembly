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

(function () {
  'use strict';

  const VK = { LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28 };

  const CORNERS = ['bl', 'br', 'tl', 'tr'];

  const STYLE_ID = 'touch-controls-style';

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
  position: absolute; display: flex; gap: 10px; pointer-events: none;
}
#touch-controls .tc-bl {
  left: 0; bottom: 0; flex-direction: column-reverse; align-items: flex-start;
  padding: 12px calc(12px + env(safe-area-inset-right, 0px))
           calc(12px + env(safe-area-inset-bottom, 0px))
           calc(12px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-br {
  right: 0; bottom: 0; flex-direction: column-reverse; align-items: flex-end;
  padding: 12px calc(12px + env(safe-area-inset-right, 0px))
           calc(12px + env(safe-area-inset-bottom, 0px))
           calc(12px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-tl {
  left: 0; top: 0; flex-direction: column; align-items: flex-start;
  padding: calc(12px + env(safe-area-inset-top, 0px))
           calc(12px + env(safe-area-inset-right, 0px)) 12px
           calc(12px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-tr {
  right: 0; top: 0; flex-direction: column; align-items: flex-end;
  padding: calc(12px + env(safe-area-inset-top, 0px))
           calc(12px + env(safe-area-inset-right, 0px)) 12px
           calc(12px + env(safe-area-inset-left, 0px));
}
#touch-controls .tc-row { display: flex; gap: 10px; align-items: flex-end; }
#touch-controls .tc-br .tc-row, #touch-controls .tc-tr .tc-row {
  flex-direction: row-reverse;
}
#touch-controls .tc-btn {
  pointer-events: auto;
  min-width: 56px; min-height: 56px;
  padding: 0 10px;
  display: flex; align-items: center; justify-content: center;
  font: bold 15px/1 "MS Sans Serif", Tahoma, system-ui, sans-serif;
  color: #000; text-shadow: 0 1px 0 rgba(255,255,255,0.5);
  background: rgba(192,192,192,0.62);
  border: 2px solid;
  border-color: rgba(255,255,255,0.85) rgba(64,64,64,0.85)
                rgba(64,64,64,0.85) rgba(255,255,255,0.85);
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(0,0,0,0.35);
}
#touch-controls .tc-btn.tc-down {
  background: rgba(160,160,160,0.85);
  border-color: rgba(64,64,64,0.85) rgba(255,255,255,0.85)
                rgba(255,255,255,0.85) rgba(64,64,64,0.85);
}
#touch-controls .tc-dpad {
  pointer-events: auto;
  position: relative; width: 132px; height: 132px; border-radius: 50%;
  background: rgba(192,192,192,0.42);
  border: 2px solid rgba(255,255,255,0.6);
  box-shadow: 0 2px 6px rgba(0,0,0,0.35);
}
#touch-controls .tc-dpad .tc-nub {
  position: absolute; left: 50%; top: 50%; width: 46px; height: 46px;
  margin: -23px 0 0 -23px; border-radius: 50%;
  background: rgba(128,128,128,0.75);
  border: 2px solid rgba(255,255,255,0.75);
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
      this.layout = config || null;
      if (!config) {
        this.el.style.display = 'none';
        return this;
      }
      const buttons = Array.isArray(config.buttons) ? config.buttons : [];
      for (const spec of buttons) this._addButton(spec);
      const dpads = config.dpad ? [config.dpad] : (config.dpads || []);
      for (const spec of dpads) this._addDpad(spec);
      this.el.style.display = (buttons.length || dpads.length) ? 'block' : 'none';
      return this;
    },

    _addButton(spec) {
      if (!spec || !Number.isFinite(spec.vk)) return;
      const el = this._doc.createElement('button');
      el.type = 'button';
      el.className = 'tc-btn';
      el.textContent = spec.label === undefined ? String(spec.vk) : String(spec.label);
      el.setAttribute('aria-label', spec.title || spec.label || ('key ' + spec.vk));
      if (spec.width) el.style.minWidth = spec.width + 'px';
      const hold = spec.hold !== false;
      const vk = spec.vk | 0;

      const begin = (e) => {
        e.preventDefault();
        for (const t of changedTouches(e)) {
          if (this._touches.has(t.identifier)) continue;
          this._touches.set(t.identifier, { kind: 'button', vk, el, hold });
          el.classList.add('tc-down');
          if (hold) this._press(vk);
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

      this._rowNode(normalizeCorner(spec.pos), spec.row | 0).appendChild(el);
      this._widgets.push(el);
    },

    _addDpad(spec) {
      const opts = spec || {};
      const el = this._doc.createElement('div');
      el.className = 'tc-dpad';
      el.setAttribute('aria-label', 'direction pad');
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

    _clearWidgets() {
      this.releaseAll();
      for (const [target, type, fn] of this._listeners) {
        if (target.removeEventListener) target.removeEventListener(type, fn);
      }
      this._listeners = [];
      this._widgets = [];
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
