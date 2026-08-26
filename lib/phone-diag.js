// A beacon for the one bug a phone cannot be debugged for.
//
// The report is always the same: in single-app mode, close an app and the
// page is bare teal with no icons and no way to launch anything. It does not
// reproduce in Chrome device emulation, it does not reproduce in the iOS
// Simulator under programmatic control, and there is no debugger to attach to
// the device it does reproduce on. Every fix so far has been a hypothesis
// that matched a mechanism, shipped without ever seeing the failing state.
//
// So stop guessing and watch the invariant instead. In single-app mode with
// nothing running, ONE thing has to be true:
//
//     the first desktop icon is inside the viewport, and a tap at its centre
//     lands on that icon.
//
// That is the whole product at that moment -- the icon grid is the only
// launcher a phone has. Everything else previously asserted (runningApps is
// empty, no window is left, no class is hiding the grid, display is grid) can
// be true while it is false, which is exactly why this bug survived four
// rounds of fixes. The hit test is the part that cannot be fooled: it fails
// for a transform, a scroll, a zoom, a fullscreen wrap, an overlay on top, a
// zero-size grid and a pointer-events hole alike, without needing to know in
// advance which one it was.
//
// Enable with ?diag on the URL; off it costs one string check at load.
// Reports POST to same-origin /ios-report (tools/ios-selftest-server.js
// prints them), or ?diag=URL to aim it elsewhere. Same-origin matters: the
// page has to be SERVED from the machine collecting the reports, because an
// https page cannot post to an http box on the LAN.

'use strict';

(() => {
  const params = new URLSearchParams(location.search);
  if (!params.has('diag')) return;
  const raw = params.get('diag') || '';
  const SINK = raw && raw !== '1' && raw !== 'true' ? raw : '/ios-report';
  const HEARTBEAT_MS = 10000;
  const POLL_MS = 500;

  // Count the big allocations. One guest is a 512MB shared
  // WebAssembly.Memory (src/01-header.wat: 8192 pages, initial == maximum, so
  // the whole thing is committed at instantiate). A phone does not have many
  // of those, and if closing an app does not let go of the last one, the next
  // launch has nowhere to put its own -- which shows up as "Out of memory" on
  // a page whose desktop looks perfectly healthy. This says how many were
  // asked for, how many are still alive, and which attempt failed.
  const mem = { made: 0, pages: 0, failed: 0, live: 0 };
  try {
    const Real = WebAssembly.Memory;
    const alive = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(() => { mem.live--; }) : null;
    const Wrapped = function Memory(descriptor) {
      const pages = (descriptor && descriptor.initial) | 0;
      try {
        const value = new Real(descriptor);
        // Only the guest-sized ones are interesting; lib/debug-midi.js makes
        // a one-page toy and it would drown the count.
        if (pages >= 1024) {
          mem.made++; mem.pages += pages; mem.live++;
          if (alive) alive.register(value, null);
        }
        return value;
      } catch (error) {
        mem.failed++;
        post({ kind: 'log', text: `MEMORY FAILED after ${mem.made} allocations ` +
          `(${Math.round(mem.pages / 16)}MB asked for, ${mem.live} still alive): ` +
          `${pages} pages -- ${error && error.message}` });
        throw error;
      }
    };
    Wrapped.prototype = Real.prototype;
    WebAssembly.Memory = Wrapped;
  } catch (_) { /* leave the real one alone */ }

  // "No sound on the phone" has two completely different causes and they look
  // identical from the outside. Either the AudioContext never started -- iOS
  // creates one suspended and only a real gesture may resume it -- or it is
  // running, samples are being scheduled into it, and iOS is throwing them
  // away because the page's audio session is the ambient category the ringer
  // switch mutes. Only the device can tell those apart, so ask it: state and
  // sampleRate say whether it started, an advancing currentTime says the
  // clock is live, and an RMS off the mixer's own analyser taps say whether
  // anything is actually being played into it.
  //
  // The RMS peak is sticky. A snapshot is posted when the verdict changes,
  // which is nowhere near the moment a sound effect fires, so an
  // instantaneous reading would be zero almost every time and would read as
  // silence in a session that was audible.
  const audio = { peak: 0, ticks: 0 };
  const lastTime = new WeakMap();
  const rmsOf = (node) => {
    if (!node || !node.getByteTimeDomainData) return 0;
    try {
      const data = new Uint8Array(node.fftSize);
      node.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / data.length);
    } catch (_) { return 0; }
  };
  const audioState = () => {
    const contexts = [];
    const add = (ac) => {
      if (ac && typeof ac.state === 'string' && !contexts.includes(ac)) contexts.push(ac);
    };
    for (const entry of peek('runningApps || []', [])) {
      const w = entry && entry.wine;
      if (!w) continue;
      add(w._audioCtx);
      const voices = w._sharedAudio && w._sharedAudio.voices;
      if (voices) add(voices._ac);
    }
    add(peek('wine ? wine._audioCtx : null', null));
    const session = (navigator.audioSession && navigator.audioSession.type) || 'none';
    if (!contexts.length) return `no-ctx session=${session}`;
    audio.ticks++;
    const parts = contexts.map((ac) => {
      const previous = lastTime.get(ac);
      lastTime.set(ac, ac.currentTime);
      const moving = previous === undefined ? '?' : (ac.currentTime > previous ? 'clock+' : 'CLOCK-STUCK');
      const rms = Math.max(
        rmsOf(ac._wineMasterAnalyser), rmsOf(ac._wineWaveAnalyser), rmsOf(ac._wineMidiAnalyser));
      if (rms > audio.peak) audio.peak = rms;
      const taps = ['_wineMasterAnalyser', '_wineWaveAnalyser', '_wineMidiAnalyser']
        .filter(key => ac[key]).length;
      return `${ac.state}@${Math.round(ac.sampleRate)} ${moving} taps=${taps} rms=${rms.toFixed(3)}`;
    });
    return `${parts.join(' | ')} peak=${audio.peak.toFixed(3)} session=${session}`;
  };

  // Scroll-to-collapse: the only way to get Safari's own toolbars off an
  // iPhone short of installing the page. index.html arms it by giving the
  // document a spacer taller than the viewport plus a gutter strip to start
  // the gesture on that is not the canvas; Safari is then supposed to retract
  // its bars for the resulting real scroll.
  //
  // It does not, on the device, and Chrome cannot reproduce that at all --
  // device emulation has no retractable toolbars, so vh and dvh are the same
  // number and the headless assertion (document comes out ~2x the viewport)
  // passes while the phone shows nothing. Four causes are indistinguishable
  // from the outside and each has its own signature here:
  //
  //   h ~= v                the spacer never applied -- nothing to scroll
  //   h >> v, maxY stays 0  it cannot scroll -- a clamp, not the spacer
  //   h >> v, maxY climbs   it scrolls, and the bars stayed anyway
  //   moves=0               the gesture never reached the page at all
  //   gutter covered:...    something is on top of the strip
  //
  // innerHeight's own range is the answer to the actual question: the bars
  // ARE the difference, so a max that never exceeds the min means they never
  // moved, whatever else scrolled.
  const scroll = { maxY: 0, moves: 0, scrolls: 0, maxInner: 0, minInner: 1e9 };
  addEventListener('scroll', () => {
    scroll.scrolls++;
    scroll.maxY = Math.max(scroll.maxY, window.scrollY || 0);
  }, { passive: true, capture: true });
  addEventListener('touchmove', () => { scroll.moves++; }, { passive: true, capture: true });
  const scrollState = () => {
    const doc = document.documentElement;
    const inner = window.innerHeight || 0;
    scroll.maxInner = Math.max(scroll.maxInner, inner);
    scroll.minInner = Math.min(scroll.minInner, inner);
    scroll.maxY = Math.max(scroll.maxY, window.scrollY || 0);
    const overflow = (el) => {
      try { return getComputedStyle(el).overflowY; } catch (_) { return '?'; }
    };
    const scroller = document.scrollingElement === doc ? 'html'
      : describe(document.scrollingElement);
    // The strip has to be hittable, and by the finger -- not merely present.
    const gutter = document.getElementById('scroll-collapse-gutter');
    let strip = 'absent';
    if (gutter) {
      const r = gutter.getBoundingClientRect();
      if (!r.width || !r.height) strip = 'zero-size';
      else {
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        strip = (at === gutter || gutter.contains(at)) ? 'hit' : 'covered:' + describe(at);
        strip += `@${Math.round(r.top)}+${Math.round(r.height)}`;
      }
    }
    return `h${doc.scrollHeight}/v${inner} y${Math.round(window.scrollY || 0)} ` +
      `maxY${Math.round(scroll.maxY)} inner${Math.round(scroll.minInner)}..${scroll.maxInner} ` +
      `scroller=${scroller} of=${overflow(doc)}/${overflow(document.body)} ` +
      `touchAction=${(() => { try { return getComputedStyle(document.body).touchAction; } catch (_) { return '?'; } })()} ` +
      `moves=${scroll.moves} scrolls=${scroll.scrolls} gutter=${strip}`;
  };

  // The emulated cursor (lib/touch-cursor.js) has three separate ways to come
  // out invisible on a phone, and from the outside they look identical: the
  // guest never set one, the sprite is hidden, or the guest's own art failed
  // to decode and the fallback drew nothing. So report each link of the chain
  // -- what the canvas' style.cursor says, whether TouchCursor parsed an
  // image out of it, whether that image decoded, and how many opaque pixels
  // ended up on the sprite. Chrome's touch emulation cannot answer this: it
  // draws the guest's cursor correctly there.
  const cursorState = () => {
    const tc = window.TouchCursor;
    if (!tc) return 'absent';
    if (!tc.installed) return 'not-installed';
    const canvas = tc.canvas || document.getElementById('screen');
    const css = canvas && canvas.style ? String(canvas.style.cursor || '') : '';
    const el = document.getElementById('touch-cursor');
    let ink = 'no-sprite';
    let rect = '';
    if (el) {
      rect = `${el.width}x${el.height}@${Math.round(el.getBoundingClientRect().left)},` +
        `${Math.round(el.getBoundingClientRect().top)}`;
      try {
        const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        ink = String(n);
      } catch (error) { ink = 'read-failed:' + (error && error.name); }
    }
    // Whether the guest's art decoded at all is the one thing only the device
    // can tell us -- a browser that cannot read image/x-icon fails here and
    // nowhere else.
    let img = 'none';
    if (tc._custom && tc._custom.url) {
      const probe = new Image();
      probe.src = tc._custom.url;
      img = probe.complete
        ? (probe.naturalWidth ? `ok ${probe.naturalWidth}x${probe.naturalHeight}` : 'decode-failed')
        : 'pending';
    }
    return `inst=1 vis=${tc._visible ? 1 : 0} disp=${el ? el.style.display : '?'} ` +
      `shape=${tc._shape} custom=${tc._custom ? 1 : 0} img=${img} ink=${ink} sprite=${rect} ` +
      `hot=${Math.round(tc._hotX || 0)},${Math.round(tc._hotY || 0)} ` +
      `css=${css.length}:${css.slice(0, 28)}`;
  };

  const describe = (el) => {
    if (!el) return 'null';
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return (el.tagName || '?').toLowerCase() + id + cls;
  };
  const box = (el) => {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // Script-scope `const`s in index.html are not properties of window, and are
  // in their temporal dead zone until that script runs -- so every read is a
  // guarded eval rather than a property lookup.
  const peek = (expr, fallback) => {
    try {
      // eslint-disable-next-line no-eval
      const value = (0, eval)(expr);
      return value === undefined ? fallback : value;
    } catch (_) { return fallback; }
  };

  function snapshot() {
    const body = document.body;
    const wrap = document.getElementById('screen-wrap');
    const grid = document.getElementById('desktop-icons');
    const first = document.querySelector('.desktop-icon');
    const vv = window.visualViewport;
    const gridStyle = grid ? getComputedStyle(grid) : null;
    const wrapStyle = wrap ? getComputedStyle(wrap) : null;

    const running = peek('runningApps ? runningApps.length : -1', -1);
    const names = peek('runningApps ? runningApps.map(a => a && a.name).join(",") : ""', '');
    const alive = peek('runningApps ? runningApps.filter(a => a && a.wine && a.wine.running).length : -1', -1);
    const windows = peek('sharedRenderer ? Object.keys(sharedRenderer.windows).length : -1', -1);

    const rect = first ? first.getBoundingClientRect() : null;
    // The hit test is the assertion. Everything above it is context for
    // reading the answer, not a substitute for asking the question.
    //
    // ANY icon, not the first one: the grid scrolls, and a scrolled grid puts
    // the first icon above the viewport while the desktop is perfectly
    // usable. Asking about the first icon scored ordinary scrolling as a dead
    // end (three of them in the first ten seconds of the user's session). The
    // product question is "is there something here to launch", so that is the
    // question.
    let hit = 'no-icon';
    let hitOk = false;
    for (const icon of document.querySelectorAll('.desktop-icon')) {
      const r = icon.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > (window.innerWidth || 0) || cy > (window.innerHeight || 0)) {
        if (hit === 'no-icon') hit = 'off-screen';
        continue;
      }
      const at = document.elementFromPoint(cx, cy);
      if (at && (at === icon || icon.contains(at) || at.closest('.desktop-icon') === icon)) {
        hit = describe(at);
        hitOk = true;
        break;
      }
      hit = 'covered:' + describe(at);
    }

    const singleApp = !!(body && body.classList.contains('single-app'));
    const idle = running === 0;
    const reasons = [];
    if (singleApp && idle && !hitOk) {
      if (running > 0) reasons.push('app-running');
      for (const cls of ['app-running', 'exclusive-fullscreen', 'page-fullscreen']) {
        if (body.classList.contains(cls)) reasons.push('class:' + cls);
      }
      if (gridStyle && gridStyle.display === 'none') reasons.push('display:none');
      if (gridStyle && gridStyle.visibility === 'hidden') reasons.push('visibility:hidden');
      if (gridStyle && gridStyle.pointerEvents === 'none') reasons.push('pointer-events:none');
      if (wrap && wrap.style.transform) reasons.push('wrap-transform:' + wrap.style.transform);
      if (grid && grid.style.transform) reasons.push('grid-transform:' + grid.style.transform);
      if (grid && grid.scrollTop) reasons.push('grid-scroll:' + grid.scrollTop);
      if (window.scrollY) reasons.push('page-scroll:' + Math.round(window.scrollY));
      if (vv && vv.scale > 1.02) reasons.push('zoom:' + vv.scale.toFixed(2));
      if (vv && vv.offsetTop) reasons.push('vv-offset:' + Math.round(vv.offsetTop));
      if (!first) reasons.push('no-icons-in-dom');
      if (hit !== 'off-screen' && hit !== 'no-icon') reasons.push('covered-by:' + hit);
      if (!reasons.length) reasons.push('unexplained');
    }

    return {
      t: Math.round(performance.now()),
      verdict: !singleApp ? 'not-single-app' : (running > 0 ? 'running' : (hitOk ? 'ok' : 'DEAD-END')),
      why: reasons.join(' '),
      hit,
      running, alive, names, windows,
      classes: body ? body.className : '',
      icon: box(first),
      iconTop: rect ? Math.round(rect.top) : null,
      gridBox: box(grid),
      gridDisplay: gridStyle ? gridStyle.display : '?',
      gridPointer: gridStyle ? gridStyle.pointerEvents : '?',
      gridZ: gridStyle ? gridStyle.zIndex : '?',
      gridScroll: grid ? grid.scrollTop : null,
      wrapTransform: wrap ? (wrap.style.transform || '') : 'missing',
      wrapComputed: wrapStyle ? wrapStyle.transform : '?',
      wrapBox: box(wrap),
      kbInset: peek('keyboardController ? keyboardController.inset() : -1', -1),
      kbShift: peek('keyboardController ? keyboardController.shift() : -1', -1),
      kbFrozen: peek('keyboardController ? keyboardController.frozenHeight() : -1', -1),
      keyboardOpen: !!(body && body.classList.contains('keyboard-open')),
      active: describe(document.activeElement),
      scroll: [Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)],
      vv: vv ? {
        w: Math.round(vv.width), h: Math.round(vv.height),
        scale: Number(vv.scale.toFixed(3)),
        offTop: Math.round(vv.offsetTop), pageTop: Math.round(vv.pageTop),
      } : null,
      inner: [window.innerWidth, window.innerHeight],
      fullscreenEl: describe(document.fullscreenElement || document.webkitFullscreenElement),
      mem: `${mem.made}made/${mem.live}live/${mem.failed}fail/${Math.round(mem.pages / 16)}MB`,
      audio: audioState(),
      collapse: scrollState(),
      cursor: cursorState(),
      exclusive: peek('sharedRenderer ? !!sharedRenderer._exclusiveFullscreen : null', null),
      declined: peek('sharedRenderer ? !!sharedRenderer._fullscreenDeclined : null', null),
    };
  }

  const queue = [];
  let sending = false;
  const flush = () => {
    if (sending || !queue.length) return;
    const batch = queue.splice(0, queue.length);
    sending = true;
    const body = JSON.stringify(batch);
    const done = () => { sending = false; if (queue.length) flush(); };
    try {
      fetch(SINK, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body, keepalive: true }).then(done, done);
    } catch (_) { done(); }
  };
  const post = (item) => { queue.push(item); flush(); };

  let lastKey = '';
  let lastSent = 0;
  const tick = () => {
    let now;
    try { now = snapshot(); } catch (error) { post({ kind: 'log', text: 'diag error ' + error.message }); return; }
    // Post on any change to the answer or to why it is what it is, plus a
    // heartbeat so a silent stream still says the page is alive.
    // The levels move every tick by design, so they are stripped out of the
    // change key -- otherwise a running app would post twice a second and the
    // stream would be levels and nothing else. State, taps and session are
    // the parts whose change is news; the levels ride along on the next post.
    const key = now.verdict + '|' + now.why + '|' + now.hit + '|' + now.running + '|' + now.classes +
      '|' + now.audio.replace(/(rms|peak)=[\d.]+/g, '') + '|' + now.collapse;
    const due = performance.now() - lastSent > HEARTBEAT_MS;
    if (key !== lastKey || due) {
      lastKey = key;
      lastSent = performance.now();
      post(now);
    }
  };

  // A tap is the gesture that reproduces this, and the state a moment after
  // one is the state worth having.
  for (const type of ['pointerup', 'touchend', 'visibilitychange']) {
    document.addEventListener(type, () => setTimeout(tick, 60), true);
  }
  // A bare "Out of memory" names nothing. The stack is the whole finding --
  // it says which allocation failed, and on this page the only allocation big
  // enough to matter is the guest's 512MB shared WebAssembly.Memory.
  // Deduplicated, because a failure that repeats twice a second otherwise
  // buries everything else in the stream.
  const seenErrors = new Map();
  const reportError = (label, message, stack) => {
    const key = label + '|' + message;
    const count = (seenErrors.get(key) || 0) + 1;
    seenErrors.set(key, count);
    // First two, then powers of ten.
    if (count > 2 && count % 100 !== 0) return;
    post({ kind: 'log', text: `${label} #${count} ${message}\n    ${(stack || '(no stack)').split('\n').slice(0, 8).join('\n    ')}` });
  };
  window.addEventListener('error', (e) => reportError('ERROR',
    e.message + ' @' + e.filename + ':' + e.lineno, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => reportError('REJECT',
    String((e.reason && e.reason.message) || e.reason), e.reason && e.reason.stack));
  setInterval(tick, POLL_MS);
  post({ kind: 'log', text: 'diag attached ' + navigator.userAgent });
  tick();

  // The eval channel, same protocol as tools/ios-lab/lab.js: GET a queue of
  // expressions from the server, run them here, POST the answers back. It is
  // the difference between "the beacon reports body overflow hidden" and
  // "here is the rule that set it" -- the snapshot can only report what it
  // was written to report, and the next question is never the one it
  // anticipated. tools/ios-eval.js is the other end.
  //
  // Polling rather than a socket, because this has to survive the phone
  // locking, the tab backgrounding, and the server being restarted
  // mid-investigation -- a poll does all three by doing nothing special.
  // Only reachable when the page was loaded with ?diag, like everything else
  // in this file.
  const CMD = SINK.replace(/\/ios-report.*$/, '/ios-cmd');
  const pump = async () => {
    try {
      const batch = await (await fetch(CMD, { cache: 'no-store' })).json();
      for (const command of batch) {
        let ok = true;
        let value;
        try {
          // eslint-disable-next-line no-eval
          value = (0, eval)(command.code);
          if (value && typeof value === 'object') {
            try { value = JSON.stringify(value); } catch (_) { value = String(value); }
          }
        } catch (error) { ok = false; value = String((error && error.message) || error); }
        post({ kind: 'eval', id: command.id, ok, value: String(value) });
      }
    } catch (_) { /* server down or not this kind of sink; try again */ }
    setTimeout(pump, 500);
  };
  pump();

  window.PhoneDiag = { snapshot, tick };
})();
