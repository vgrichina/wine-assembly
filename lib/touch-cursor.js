// An emulated mouse cursor for touch devices.
//
// A phone has no pointer, so everything the guest says with the cursor is
// simply lost. The shape is real state -- host-window.js's set_cursor turns
// every SetCursor into canvas.style.cursor, and the renderer sets its own for
// window edges -- but CSS cursors only exist under a mouse. On a touch screen
// an app grinding through a long operation looks exactly like an app that has
// died: no hourglass, no I-beam over a text field, no resize arrows on a
// border. So draw the cursor ourselves.
//
// The sprite tracks the finger and STAYS where the finger left it, because the
// interesting case is the one where nothing is touching the screen: the guest
// went busy after a tap and the hourglass is the only thing saying so. Same
// reason it follows body.app-booting -- a launch takes seconds on a phone, and
// during it there is no guest to ask.
//
// The shapes are pixel art rather than the guest's own cursor bitmaps: the
// stock IDC_* cursors live in USER.EXE resources we do not load, and CSS
// keywords are all the rest of the shell has ever had to work with. Reading
// canvas.style.cursor is what keeps this honest -- one poll catches every
// writer, present and future, instead of a call site in each of them.
//
// A guest that builds its OWN cursor is the exception, and it is the one that
// matters most: Heroes of Might & Magic II draws a hand, and no keyword in the
// list above is a hand. Those arrive as `url(data:image/x-icon;...) hx hy` --
// CreateIconIndirect composited the AND/XOR planes in WAT and host-window.js
// turned them into a data URL -- so when the CSS names an image we draw the
// image and the guest's own hotspot, and the pixel art is only the fallback.

(function () {
  'use strict';

  const K = '#000';           // black outline
  const W = '#fff';           // white fill
  const SHADOW = 'rgba(0,0,0,0.35)';

  // '.' transparent, 'K' black, 'W' white. Hotspot is [x, y] in cursor pixels.
  const SHAPES = {
    default: {
      hot: [0, 0],
      art: [
        'K...........',
        'KK..........',
        'KWK.........',
        'KWWK........',
        'KWWWK.......',
        'KWWWWK......',
        'KWWWWWK.....',
        'KWWWWWWK....',
        'KWWWWWWWK...',
        'KWWWWWWWWK..',
        'KWWWWWKKKKK.',
        'KWWKWWK.....',
        'KWK.KWWK....',
        'KK..KWWK....',
        'K....KWWK...',
        '.....KWWK...',
        '......KWK...',
        '......KKK...',
      ],
    },
    text: {
      hot: [3, 8],
      art: [
        'KK.KK',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        '..K..',
        'KK.KK',
      ],
    },
    wait: {
      hot: [6, 8],
      art: [
        'KKKKKKKKKKKKK',
        'KWWWWWWWWWWWK',
        '.KWWWWWWWWWK.',
        '.KWKKKKKKKWK.',
        '..KWKKKKKWK..',
        '..KWWKKKWWK..',
        '...KWWKWWK...',
        '....KWWWK....',
        '....KWWWK....',
        '...KWWWWWK...',
        '..KWWKKKWWK..',
        '..KWKKKKKWK..',
        '.KWKKKKKKKWK.',
        '.KWWWWWWWWWK.',
        'KWWWWWWWWWWWK',
        'KKKKKKKKKKKKK',
      ],
    },
    crosshair: {
      hot: [7, 7],
      art: [
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '...............',
        'KKKKKK...KKKKKK',
        '...............',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
        '.......K.......',
      ],
    },
    pointer: {
      hot: [5, 0],
      art: [
        '.....KK.....',
        '....KWWK....',
        '....KWWK....',
        '....KWWK....',
        '....KWWK....',
        '....KWWKKK..',
        '....KWWKWWKK',
        '.KK.KWWKWWKWK',
        'KWWKKWWKWWKWK',
        'KWWWKWWWWWWWK',
        '.KWWWWWWWWWWK',
        '..KWWWWWWWWWK',
        '..KWWWWWWWWWK',
        '...KWWWWWWWK.',
        '....KWWWWWWK.',
        '....KWWWWWWK.',
      ],
    },
    move: {
      hot: [7, 7],
      art: [
        '.......K.......',
        '......KWK......',
        '.....KWWWK.....',
        '.......K.......',
        '...K...K...K...',
        '..KWK..K..KWK..',
        '.KWWWKKKKKWWWK.',
        'KWK.KKKKKKK.KWK',
        '.KWWWKKKKKWWWK.',
        '..KWK..K..KWK..',
        '...K...K...K...',
        '.......K.......',
        '.....KWWWK.....',
        '......KWK......',
        '.......K.......',
      ],
    },
    'ew-resize': {
      hot: [8, 4],
      art: [
        '...K.......K...',
        '..KWK.....KWK..',
        '.KWWKKKKKKKWWK.',
        'KWWWWWWWWWWWWWK',
        '.KWWKKKKKKKWWK.',
        '..KWK.....KWK..',
        '...K.......K...',
      ],
    },
    'ns-resize': {
      hot: [3, 8],
      art: [
        '...K...',
        '..KWK..',
        '.KWWWK.',
        'KWKWKWK',
        '..KWK..',
        '..KWK..',
        '..KWK..',
        '..KWK..',
        '..KWK..',
        '..KWK..',
        'KWKWKWK',
        '.KWWWK.',
        '..KWK..',
        '...K...',
      ],
    },
    'nwse-resize': {
      hot: [6, 6],
      art: [
        'KKKKKK.....',
        'KWWWWK.....',
        'KWWWK......',
        'KWKWWK.....',
        'KK..KWK....',
        'K....KWK...',
        '......KWK..',
        '.......KWKK',
        '....KWWKWWK',
        '.....KWWWWK',
        '.....KWWWWK',
        '.....KKKKKK',
      ],
    },
    'nesw-resize': {
      hot: [6, 6],
      art: [
        '.....KKKKKK',
        '.....KWWWWK',
        '......KWWWK',
        '.....KWWKWK',
        '....KWK..KK',
        '...KWK....K',
        '..KWK......',
        'KKWK.......',
        'KWWKWWK....',
        'KWWWWK.....',
        'KWWWWK.....',
        'KKKKKK.....',
      ],
    },
    'not-allowed': {
      hot: [7, 7],
      art: [
        '....KKKKK....',
        '..KKWWWWWKK..',
        '.KWWWWWWWKKK.',
        '.KWWWWWKKKKK.',
        'KWWWWKKKKKWWK',
        'KWWWKKKKWWWWK',
        'KWWKKKKWWWWWK',
        'KWKKKKWWWWWWK',
        'KWKKKWWWWWWWK',
        'KWKKWWWWWWWWK',
        '.KKWWWWWWWWK.',
        '..KKWWWWWKK..',
        '....KKKKK....',
      ],
    },
    help: {
      hot: [0, 0],
      art: [
        'K...........',
        'KK..........',
        'KWK.........',
        'KWWK........',
        'KWWWK.......',
        'KWWWWK.KKK..',
        'KWWWWWKWWWK.',
        'KWWWWWWKKWWK',
        'KWWWWWWWKWWK',
        'KWWWWWWWWKK.',
        'KWWWWWKKKWK.',
        'KWWKWWK.KWK.',
        'KWK.KWWK.K..',
        'KK..KWWK.K..',
        'K....KWWK...',
        '.....KWWK...',
      ],
    },
  };

  // The busy-arrow: a normal pointer with a small hourglass beside it. Both
  // shapes mean "wait", so it borrows the arrow's art and gets the badge drawn
  // over it rather than a third pixel grid.
  SHAPES.progress = { hot: [0, 0], art: SHAPES.default.art, badge: 'wait' };

  const ALIAS = {
    auto: 'default',
    'col-resize': 'ew-resize',
    'row-resize': 'ns-resize',
    'e-resize': 'ew-resize',
    'w-resize': 'ew-resize',
    'n-resize': 'ns-resize',
    's-resize': 'ns-resize',
    'nw-resize': 'nwse-resize',
    'se-resize': 'nwse-resize',
    'ne-resize': 'nesw-resize',
    'sw-resize': 'nesw-resize',
    'all-scroll': 'move',
    grab: 'pointer',
    grabbing: 'pointer',
    hand: 'pointer',
    wait: 'wait',
    progress: 'progress',
    none: null,
  };

  function normalizeShape(css) {
    if (!css) return 'default';
    // "url(...), pointer" -- a custom cursor with a keyword fallback. The
    // fallback is the only part we can draw.
    const name = String(css).split(',').pop().trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ALIAS, name)) return ALIAS[name];
    return Object.prototype.hasOwnProperty.call(SHAPES, name) ? name : 'default';
  }

  // `url(data:image/x-icon;base64,AAAB...) 3 5, default`. Splitting on commas
  // is not an option -- a base64 data URL contains one -- so match the url()
  // token and the two hotspot numbers that may follow it.
  const URL_CURSOR =
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)\s*(?:(-?[\d.]+)\s+(-?[\d.]+))?/;

  function parseUrlCursor(css) {
    if (!css) return null;
    const m = URL_CURSOR.exec(String(css));
    if (!m) return null;
    const url = m[1] || m[2] || m[3];
    if (!url) return null;
    return {
      url,
      hotX: m[4] === undefined ? 0 : parseFloat(m[4]),
      hotY: m[5] === undefined ? 0 : parseFloat(m[5]),
    };
  }

  // Decoding is asynchronous and a cursor is re-selected constantly, so images
  // are cached by URL and a load re-renders whatever is current then.
  const IMAGES = new Map();

  function cursorImage(url, onLoad) {
    let entry = IMAGES.get(url);
    if (!entry) {
      entry = { img: new Image(), ready: false, failed: false };
      entry.img.onload = () => { entry.ready = true; if (onLoad) onLoad(); };
      entry.img.onerror = () => { entry.failed = true; if (onLoad) onLoad(); };
      entry.img.src = url;
      IMAGES.set(url, entry);
      // A data URL can decode synchronously in some browsers.
      if (entry.img.complete && entry.img.naturalWidth) entry.ready = true;
    }
    return entry;
  }

  function drawArt(ctx, art, scale, ox, oy) {
    for (let row = 0; row < art.length; row++) {
      const line = art[row];
      for (let col = 0; col < line.length; col++) {
        const c = line[col];
        if (c === '.') continue;
        ctx.fillStyle = c === 'K' ? K : W;
        ctx.fillRect(ox + col * scale, oy + row * scale, scale, scale);
      }
    }
  }

  function artSize(art) {
    let w = 0;
    for (const line of art) w = Math.max(w, line.length);
    return { w, h: art.length };
  }

  const TouchCursor = {
    installed: false,
    _shape: 'default',
    _x: null,
    _y: null,
    _visible: false,

    // Touch-only by default: with a real mouse the browser already draws the
    // cursor, and two of them is worse than none.
    shouldInstall() {
      try {
        const params = new URLSearchParams(location.search);
        if (params.has('touch-cursor')) return params.get('touch-cursor') !== '0';
      } catch (_) {}
      if (typeof matchMedia !== 'function') return false;
      return matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches;
    },

    install(options) {
      if (this.installed) return this;
      const opts = options || {};
      this.canvas = opts.canvas || document.getElementById('screen');
      // A fixed scale is for tools and tests. Left unset, the cursor is drawn
      // at the guest's own zoom -- see _appZoom.
      this.fixedScale = opts.scale || null;
      this.scale = this.fixedScale || 2;

      const el = document.createElement('canvas');
      el.id = 'touch-cursor';
      el.setAttribute('aria-hidden', 'true');
      // Every one of these matters: a sprite that took a tap would eat the
      // very input it is drawn to describe, and one inside a stacking context
      // that transforms (the on-screen-keyboard shift, page fullscreen) would
      // drift away from the finger.
      el.style.cssText = [
        'position:fixed', 'left:0', 'top:0', 'margin:0', 'padding:0',
        'pointer-events:none', 'z-index:2147483000', 'display:none',
        'image-rendering:pixelated', 'will-change:transform',
      ].join(';');
      document.body.appendChild(el);
      this.el = el;

      const track = (clientX, clientY) => this.move(clientX, clientY);
      // Capture + passive: the canvas handlers call preventDefault and
      // stopPropagation on these, so a bubble-phase listener would never see a
      // touch that lands on the guest.
      const touchOpts = { capture: true, passive: true };
      window.addEventListener('touchstart', e => {
        const t = e.touches && e.touches[0];
        if (t) track(t.clientX, t.clientY);
      }, touchOpts);
      window.addEventListener('touchmove', e => {
        const t = e.touches && e.touches[0];
        if (t) track(t.clientX, t.clientY);
      }, touchOpts);
      // No touchend handler on purpose: the sprite stays where the finger left
      // it, which is the whole point -- the hourglass appears after the tap
      // that started the work.
      window.addEventListener('pointermove', e => {
        if (e.pointerType === 'mouse') track(e.clientX, e.clientY);
      }, { capture: true, passive: true });

      // One poll instead of a hook in every writer of style.cursor. 100ms is
      // far below the threshold where a shape change reads as laggy, and this
      // reads a property -- it forces no layout.
      this._timer = setInterval(() => this.tick(), 100);
      this.tick();
      this.installed = true;
      return this;
    },

    // CSS pixels per guest pixel: exactly the factor the shell blows the
    // screen canvas up by to fill the phone (browser-input.js's
    // eventPointFromClient divides by the same one to turn a touch back into a
    // guest coordinate). Drawing the cursor at any other size makes it a
    // sticker on top of the picture rather than part of it -- a 2x cursor over
    // a 320x240 game scaled 1.2x is nearly twice the size of the buttons it is
    // pointing at.
    _appZoom() {
      if (this.fixedScale) return this.fixedScale;
      const canvas = this.canvas;
      if (!canvas || !canvas.width || !canvas.getBoundingClientRect) return 2;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return 2;   // hidden: no app running, nothing to match
      return rect.width / canvas.width;
    },

    move(clientX, clientY) {
      this._x = clientX;
      this._y = clientY;
      if (this._visible) this._place();
    },

    // What the shell is doing outstrips what the guest can say: during a
    // launch there is no guest yet, and the boot cursor is exactly the state a
    // visitor most needs told about.
    tick() {
      const booting = document.body.classList.contains('app-booting');
      const running = document.body.classList.contains('app-running');
      const css = this.canvas && this.canvas.style ? this.canvas.style.cursor : '';
      const custom = booting ? null : parseUrlCursor(css);
      const shape = booting ? 'wait' : normalizeShape(css);
      // `cursor: none` with an image still means "draw the image": the keyword
      // is only the fallback for a browser that cannot fetch it.
      const visible = !!(custom || shape) && (booting || running);
      // The zoom changes under us on rotation, on a window resize, when the
      // on-screen keyboard shrinks the viewport and when an app switches
      // resolution mid-run, so it is read every poll rather than at install.
      const zoom = this._appZoom();
      const rezoom = Math.abs(zoom - (this._renderedZoom || 0)) > 0.01;
      if (rezoom) this.scale = zoom;
      if (shape && shape !== this._shape) this._shape = shape;
      this._custom = custom;
      const customKey = custom ? custom.url + ' ' + custom.hotX + ' ' + custom.hotY : '';
      if (rezoom || shape !== this._renderedShape || customKey !== this._renderedCustom) {
        this._renderedShape = this._shape;
        this._renderedCustom = customKey;
        this._render();
      }
      if (visible !== this._visible) {
        this._visible = visible;
        this.el.style.display = visible ? 'block' : 'none';
      }
      if (visible) this._place();
    },

    _render() {
      if (this._custom && this._renderCustom(this._custom)) return;
      const shape = SHAPES[this._shape] || SHAPES.default;
      const size = artSize(shape.art);
      const badge = shape.badge ? SHAPES[shape.badge] : null;
      const badgeSize = badge ? artSize(badge.art) : { w: 0, h: 0 };

      // The zoom is whatever the app is at, so it is fractional as often as
      // not, and fillRect on fractional coordinates gives soft edges on art
      // whose whole point is hard ones. So: lay the sprite out in CSS pixels
      // at the app's exact zoom, but rasterize at a whole number of DEVICE
      // pixels per cursor pixel and let the element scale that down.
      const zoom = this.scale;
      const dpr = window.devicePixelRatio || 1;
      const dev = Math.max(1, Math.round(zoom * dpr));
      const badgeF = badge ? 0.6 : 0;
      const badgeDev = badge ? Math.max(1, Math.round(dev * badgeF)) : 0;
      const badgeOx = badge ? size.w * dev : 0;

      const wDev = Math.max(size.w * dev, badgeOx + badgeSize.w * badgeDev) + dev;
      const hDev = Math.max(size.h * dev, badgeSize.h * badgeDev) + dev;
      this.el.width = wDev;
      this.el.height = hDev;
      this.el.style.width = (wDev / dev) * zoom + 'px';
      this.el.style.height = (hDev / dev) * zoom + 'px';

      const ctx = this.el.getContext('2d');
      ctx.clearRect(0, 0, wDev, hDev);
      // A hard shadow, because the sprite has to read over a Win98 grey
      // toolbar and over black game art alike.
      ctx.save();
      ctx.shadowColor = SHADOW;
      ctx.shadowOffsetX = dev / 2;
      ctx.shadowOffsetY = dev / 2;
      drawArt(ctx, shape.art, dev, 0, 0);
      ctx.restore();
      if (badge) drawArt(ctx, badge.art, badgeDev, badgeOx, 0);

      // The hotspot is placed in CSS pixels, so it scales with the sprite and
      // not with the rasterization.
      this._hotX = shape.hot[0] * zoom;
      this._hotY = shape.hot[1] * zoom;
      this._renderedZoom = zoom;
    },

    // The guest's own cursor art. Returns false when there is nothing to draw
    // yet and the caller should fall back to the pixel-art shape; returns true
    // while a decode is in flight, which leaves the previous sprite up rather
    // than blinking an arrow in for one frame.
    _renderCustom(custom) {
      const entry = cursorImage(custom.url, () => {
        if (this._custom && this._custom.url === custom.url) {
          this._render();
          this._place();
        }
      });
      if (entry.failed) return false;
      if (!entry.ready) return true;
      const w = entry.img.naturalWidth || entry.img.width;
      const h = entry.img.naturalHeight || entry.img.height;
      if (!w || !h) return false;

      const zoom = this.scale;
      const dpr = window.devicePixelRatio || 1;
      const dev = Math.max(1, Math.round(zoom * dpr));
      const wDev = w * dev + dev;
      const hDev = h * dev + dev;
      this.el.width = wDev;
      this.el.height = hDev;
      this.el.style.width = (wDev / dev) * zoom + 'px';
      this.el.style.height = (hDev / dev) * zoom + 'px';

      const ctx = this.el.getContext('2d');
      ctx.clearRect(0, 0, wDev, hDev);
      ctx.imageSmoothingEnabled = false;
      ctx.save();
      ctx.shadowColor = SHADOW;
      ctx.shadowOffsetX = dev / 2;
      ctx.shadowOffsetY = dev / 2;
      ctx.drawImage(entry.img, 0, 0, w * dev, h * dev);
      ctx.restore();

      this._hotX = custom.hotX * zoom;
      this._hotY = custom.hotY * zoom;
      this._renderedZoom = zoom;
      return true;
    },

    _place() {
      if (!this.el) return;
      if (this._hotX === undefined) this._render();
      let x = this._x;
      let y = this._y;
      if (x === null || x === undefined) {
        // Never touched yet -- a boot, or an app that went busy on its own.
        // Middle of the screen is where it will be looked for.
        x = window.innerWidth / 2;
        y = window.innerHeight / 2;
      }
      this.el.style.transform =
        `translate(${Math.round(x - this._hotX)}px, ${Math.round(y - this._hotY)}px)`;
    },

    // For tests and for the shell: force a shape without waiting for a poll.
    setShape(css) {
      const custom = parseUrlCursor(css);
      const shape = normalizeShape(css) || this._shape;
      const customKey = custom ? custom.url + ' ' + custom.hotX + ' ' + custom.hotY : '';
      if (shape === this._shape && customKey === (this._renderedCustom || '')) return;
      this._custom = custom;
      this._renderedCustom = customKey;
      this._shape = shape;
      this._renderedShape = shape;
      this.scale = this._appZoom();
      this._render();
      this._place();
    },
  };

  window.TouchCursor = TouchCursor;

  const start = () => { if (TouchCursor.shouldInstall()) TouchCursor.install(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
