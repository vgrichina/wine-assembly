// The DOM -> renderer input bridge: everything that turns a browser mouse,
// touch, or key event into a call on the Win98 renderer, plus the pieces that
// only exist because a browser is not a PC — pointer capture outside the
// canvas, the hidden textarea iOS needs before it will open a keyboard, the
// audio unlock that has to ride on a real user gesture, and the clicks that
// belong to the HTML desktop behind the canvas rather than to the guest.
//
// This was 380 lines inside index.html, which made it markup-adjacent by
// accident: the one place where guest input semantics are decided could not be
// read, diffed, or reasoned about without scrolling through a page template.
// It is still browser-only code — the CLI feeds the renderer through its own
// input queue — but it is now a file with a name.
//
// Wiring is once-per-page (a second call is a no-op); `browserInput.isWired()`
// answers the question the desktop icons ask before a guest exists, when their
// own click handlers are still the ones on the canvas.

(function () {
  let inputWired = false;

  // deps.runningApps — the live array of launched guests (audio unlock, and
  //   whether a keypress has anywhere to go at all).
  // deps.debugMode — the ?debug page keeps its HTML desktop clickable through
  //   the canvas; a normal page gives empty-desktop clicks to the guest.
  function wireCanvasInput(canvas, renderer, deps) {
    const runningApps = (deps && deps.runningApps) || [];
    const DEBUG_MODE = !!(deps && deps.debugMode);
    if (inputWired) return;
    inputWired = true;
    canvas.oncontextmenu = e => e.preventDefault();
    function eventPointFromClient(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      const sx = canvas.width / r.width, sy = canvas.height / r.height;
      const x = Math.floor((clientX - r.left) * sx);
      const y = Math.floor((clientY - r.top) * sy);
      return { x, y };
    }
    function eventPoint(e) {
      return eventPointFromClient(e.clientX, e.clientY);
    }
    const keyboardProxy = document.getElementById('mobile-keyboard-proxy');
    const isKeyboardProxy = el => keyboardProxy && el === keyboardProxy;
    function clearKeyboardProxy() {
      if (keyboardProxy && keyboardProxy.value) keyboardProxy.value = '';
    }
    function focusGuestKeyboardProxy() {
      if (!keyboardProxy || !runningApps || !runningApps.length) return;
      // iOS only opens the software keyboard from a real editable DOM
      // element, and only during a user gesture. The canvas remains the
      // visual surface; this hidden textarea is just the keyboard device.
      try {
        clearKeyboardProxy();
        keyboardProxy.focus({ preventScroll: true });
      } catch (_) {
        try { keyboardProxy.focus(); } catch (_) {}
      }
    }
    function unlockRunningAudio() {
      if (!runningApps || !runningApps.length) return;
      for (const app of runningApps) {
        const wineHost = app && app.wine;
        if (!wineHost) continue;
        try {
          if (wineHost.primeAudio) wineHost.primeAudio();
        } catch (_) {}
        const contexts = [];
        if (wineHost._audioCtx) contexts.push(wineHost._audioCtx);
        const voices = wineHost._sharedAudio && wineHost._sharedAudio.voices;
        if (voices && voices._ac && voices._ac !== wineHost._audioCtx) contexts.push(voices._ac);
        for (const ac of contexts) {
          if (ac && ac.state === 'suspended') {
            try { ac.resume(); } catch (_) {}
          }
        }
      }
    }
    function windowAtCanvas(cx, cy) {
      for (const w of Object.values(renderer.windows)) {
        if (!w.visible || w.isChild) continue;
        if (cx >= w.x && cx < w.x + w.w && cy >= w.y && cy < w.y + w.h) return w;
      }
      return null;
    }
    function forwardEmptyDesktopClick(clientX, clientY, cx, cy) {
      if (DEBUG_MODE || windowAtCanvas(cx, cy)) return false;
      canvas.style.pointerEvents = 'none';
      const under = document.elementFromPoint(clientX, clientY);
      canvas.style.pointerEvents = '';
      const iconEl = under && under.closest && under.closest('.desktop-icon');
      if (iconEl) {
        iconEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY }));
        return true;
      }
      for (const sel of document.querySelectorAll('.desktop-icon.selected')) sel.classList.remove('selected');
      return false;
    }
    let mouseDragActive = false;
    let mouseDownActive = false;
    let activeTouchId = null;
    let lastTouchPoint = null;
    function stopMouseDragCapture() {
      mouseDragActive = false;
      mouseDownActive = false;
      window.removeEventListener('mousemove', windowMouseMove, true);
      window.removeEventListener('mouseup', windowMouseUp, true);
    }
    function touchById(list, id) {
      if (!list) return null;
      for (let i = 0; i < list.length; i++) {
        if (list[i].identifier === id) return list[i];
      }
      return null;
    }
    function stopTouchCapture() {
      activeTouchId = null;
      lastTouchPoint = null;
      window.removeEventListener('touchmove', windowTouchMove, true);
      window.removeEventListener('touchend', windowTouchEnd, true);
      window.removeEventListener('touchcancel', windowTouchCancel, true);
    }
    function windowMouseMove(e) {
      if (!mouseDownActive) return;
      mouseDragActive = true;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = eventPoint(e);
      renderer.handleMouseMove(x, y);
    }
    function windowMouseUp(e) {
      if (!mouseDownActive) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = eventPoint(e);
      renderer.handleMouseUp(x, y, e.button);
      stopMouseDragCapture();
    }
    function windowTouchMove(e) {
      if (activeTouchId === null) return;
      const t = touchById(e.changedTouches, activeTouchId) || touchById(e.touches, activeTouchId);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = eventPointFromClient(t.clientX, t.clientY);
      lastTouchPoint = { x, y };
      renderer.handleMouseMove(x, y);
    }
    function windowTouchEnd(e) {
      if (activeTouchId === null) return;
      const t = touchById(e.changedTouches, activeTouchId);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      const p = eventPointFromClient(t.clientX, t.clientY);
      renderer.handleMouseUp(p.x, p.y, 0);
      stopTouchCapture();
    }
    function windowTouchCancel(e) {
      if (activeTouchId === null) return;
      e.preventDefault();
      e.stopPropagation();
      const p = lastTouchPoint;
      if (p) renderer.handleMouseUp(p.x, p.y, 0);
      stopTouchCapture();
    }
    canvas.onmousedown = e => {
      e.preventDefault();
      canvas.focus();
      unlockRunningAudio();
      const { x: cx, y: cy } = eventPoint(e);
      if (forwardEmptyDesktopClick(e.clientX, e.clientY, cx, cy)) return;
      renderer.handleMouseDown(cx, cy, e.button, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
      focusGuestKeyboardProxy();
      mouseDownActive = true;
      mouseDragActive = false;
      window.addEventListener('mousemove', windowMouseMove, true);
      window.addEventListener('mouseup', windowMouseUp, true);
    };
    canvas.onmouseup = e => {
      if (mouseDownActive) return;
      const { x, y } = eventPoint(e);
      renderer.handleMouseUp(x, y, e.button);
    };
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const { x, y } = eventPoint(e);
      renderer.handleWheel(x, y, e.deltaY);
    }, { passive: false });
    canvas.addEventListener('touchstart', e => {
      if (activeTouchId !== null) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      e.preventDefault();
      canvas.focus();
      unlockRunningAudio();
      const { x: cx, y: cy } = eventPointFromClient(t.clientX, t.clientY);
      if (forwardEmptyDesktopClick(t.clientX, t.clientY, cx, cy)) return;
      activeTouchId = t.identifier;
      lastTouchPoint = { x: cx, y: cy };
      renderer.handleMouseDown(cx, cy, 0);
      focusGuestKeyboardProxy();
      window.addEventListener('touchmove', windowTouchMove, { capture: true, passive: false });
      window.addEventListener('touchend', windowTouchEnd, { capture: true, passive: false });
      window.addEventListener('touchcancel', windowTouchCancel, { capture: true, passive: false });
    }, { passive: false });
    canvas.setAttribute('tabindex', '0');
    canvas.focus();
    // Default-claim keys when canvas is focused: the guest gets every
    // keystroke except those reserved for the browser/OS (close tab,
    // reload, devtools, fullscreen, OS keys). This matches Win98 feel
    // — Ctrl+S/F/P etc. land in the app instead of the browser.
    const keepForBrowser = (e) => {
      const vk = e.keyCode;
      if (e.metaKey) return true;                          // Cmd/Win
      if (vk === 44) return true;                          // PrintScreen
      if (vk === 122 || vk === 123) return true;           // F11, F12
      if (vk === 116) return true;                         // F5 (reload)
      if (e.ctrlKey && vk === 82) return true;             // Ctrl+R
      if (e.ctrlKey && vk === 87) return true;             // Ctrl+W
      if (e.ctrlKey && vk === 84) return true;             // Ctrl+T
      if (e.ctrlKey && vk === 9)  return true;             // Ctrl+Tab
      if (e.ctrlKey && vk === 33) return true;             // Ctrl+PgUp
      if (e.ctrlKey && vk === 34) return true;             // Ctrl+PgDn
      if (e.ctrlKey && vk === 27) return true;             // Ctrl+Esc
      if (e.ctrlKey && e.shiftKey && (vk === 73 || vk === 74 || vk === 67)) return true; // devtools
      if (e.ctrlKey && (vk === 187 || vk === 189 || vk === 48)) return true; // zoom
      if (e.altKey && vk === 115) return true;             // Alt+F4
      return false;
    };
    // Keys that would generate a printable character via the keypress
    // event (no Ctrl/Alt modifiers, VK in the typing range). Calling
    // preventDefault() on keydown suppresses the subsequent keypress in
    // browsers, which would break WM_CHAR delivery — so leave those
    // alone and let keypress fire naturally.
    const isPrintableKey = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      const vk = e.keyCode;
      if (vk >= 0x30 && vk <= 0x5A) return true;           // 0-9, A-Z
      if (vk >= 0x60 && vk <= 0x6F) return true;           // numpad
      if (vk >= 0xBA && vk <= 0xC0) return true;           // ;=,-./` etc.
      if (vk >= 0xDB && vk <= 0xDE) return true;           // [\]'
      if (vk === 32) return true;                          // space
      return false;
    };
    let suppressTextInputEvents = 0;
    const charCodeFromKeyEvent = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return 0;
      if (typeof e.key === 'string' && e.key.length === 1) return e.key.charCodeAt(0);
      if (e.key === 'Enter') return 13;
      return 0;
    };
    const focusGuestCanvas = () => {
      try {
        const active = document.activeElement;
        if (active && active !== canvas && !isKeyboardProxy(active) && active.blur) active.blur();
        canvas.focus({ preventScroll: true });
      } catch (_) {
        try { canvas.focus(); } catch (_) {}
      }
    };
    const shouldIgnorePageKey = (e) => {
      const el = e.target;
      if (isKeyboardProxy(el)) return false;
      if (!el || el === canvas || el === document.body || el === document.documentElement) return false;
      if (runningApps && runningApps.length) {
        const toolbar = document.getElementById('toolbar');
        if (toolbar && toolbar.contains(el) && !keepForBrowser(e)) {
          // After a program is running, the Win98 guest owns normal
          // keystrokes. Browser toolbar controls can retain DOM focus after
          // Launch/program selection; refocus the canvas so Notepad-style
          // text input is delivered to the guest, not swallowed by <select>.
          focusGuestCanvas();
          return false;
        }
      }
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const startInputProfile = (label, e, data) => {
      if (!renderer._profileInput || !window.DEBUG_INPUT_PROFILE) return;
      const now = renderer._profileNow ? renderer._profileNow() : performance.now();
      let eventTime = (e && typeof e.timeStamp === 'number') ? e.timeStamp : now;
      if (eventTime > now + 100000 && performance.timeOrigin) eventTime -= performance.timeOrigin;
      if (!Number.isFinite(eventTime) || eventTime < 0 || eventTime > now + 1000) eventTime = now;
      renderer._profileInput(label, {
        ...(data || {}),
        domType: e.type,
        key: e.key,
        code: e.code,
        eventTime: Number(eventTime.toFixed(3)),
      }, eventTime);
      renderer._profileMark('browser-handler-start', {
        delayMs: Number((now - eventTime).toFixed(3)),
      });
    };
    const handleKeyDown = (e) => {
      if (shouldIgnorePageKey(e)) return;
      const vk = e.keyCode;
      unlockRunningAudio();
      renderer.handleKeyDown(vk);
      suppressTextInputEvents = 0;
      if (!keepForBrowser(e)) {
        const charCode = charCodeFromKeyEvent(e);
        if (charCode) {
          startInputProfile('keydown-char', e, { vk, charCode });
          renderer.handleKeyPress(charCode);
          renderer._profileMark && renderer._profileMark('browser-handler-end');
          suppressTextInputEvents = 2;
          e.preventDefault();
        } else if (!isPrintableKey(e)) {
          e.preventDefault();
        }
      }
    };
    const handleKeyUp = (e) => {
      if (shouldIgnorePageKey(e)) return;
      renderer.handleKeyUp(e.keyCode);
    };
    const handleKeyPress = (e) => {
      if (shouldIgnorePageKey(e)) return;
      if (suppressTextInputEvents > 0) {
        suppressTextInputEvents--;
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const charCode = e.charCode || e.keyCode;
      startInputProfile('keypress', e, { charCode });
      renderer.handleKeyPress(charCode);
      renderer._profileMark && renderer._profileMark('browser-handler-end');
    };
    const handleBeforeInput = (e) => {
      if (shouldIgnorePageKey(e)) return;
      if (suppressTextInputEvents > 0) {
        suppressTextInputEvents--;
        e.preventDefault();
        clearKeyboardProxy();
        return;
      }
      if (e.data) {
        e.preventDefault();
        for (const ch of e.data) {
          const charCode = ch.charCodeAt(0);
          startInputProfile('beforeinput', e, { charCode });
          renderer.handleKeyPress(charCode);
          renderer._profileMark && renderer._profileMark('browser-handler-end');
        }
        clearKeyboardProxy();
      }
    };
    const handleProxyInput = (e) => {
      if (!isKeyboardProxy(e.target)) return;
      if (suppressTextInputEvents > 0) {
        suppressTextInputEvents--;
        clearKeyboardProxy();
        return;
      }
      const text = keyboardProxy.value || '';
      if (text) {
        for (const ch of text) {
          const charCode = ch.charCodeAt(0);
          startInputProfile('proxy-input', e, { charCode });
          renderer.handleKeyPress(charCode);
          renderer._profileMark && renderer._profileMark('browser-handler-end');
        }
      }
      clearKeyboardProxy();
    };
    let imeComposing = false;
    const handleCompositionStart = (e) => {
      if (shouldIgnorePageKey(e)) return;
      imeComposing = true;
      suppressTextInputEvents = 0;
      renderer.handleCompositionStart && renderer.handleCompositionStart();
    };
    const handleCompositionUpdate = (e) => {
      if (!imeComposing || shouldIgnorePageKey(e)) return;
      renderer.handleCompositionUpdate && renderer.handleCompositionUpdate(e.data || '');
    };
    const handleCompositionEnd = (e) => {
      if (!imeComposing || shouldIgnorePageKey(e)) return;
      imeComposing = false;
      renderer.handleCompositionEnd && renderer.handleCompositionEnd(e.data || '');
      // Browsers commonly follow compositionend with beforeinput/input for
      // the same committed text. The guest commit above is authoritative.
      suppressTextInputEvents = 2;
      clearKeyboardProxy();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('keyup', handleKeyUp, { capture: true });
    window.addEventListener('keypress', handleKeyPress, { capture: true });
    window.addEventListener('beforeinput', handleBeforeInput, { capture: true });
    window.addEventListener('compositionstart', handleCompositionStart, { capture: true });
    window.addEventListener('compositionupdate', handleCompositionUpdate, { capture: true });
    window.addEventListener('compositionend', handleCompositionEnd, { capture: true });
    if (keyboardProxy) keyboardProxy.addEventListener('input', handleProxyInput);
    canvas.onmousemove = e => {
      if (mouseDragActive) return;
      const { x: mx, y: my } = eventPoint(e);
      renderer.handleMenuHover(mx, my);
      // Always deliver mouse moves — WM_SETCURSOR depends on it, and games
      // like Reversi key their "valid move" cross cursor on WM_MOUSEMOVE.
      renderer.handleMouseMove(mx, my);
    };
  }

  const browserInput = {
    wireCanvasInput,
    isWired: () => inputWired,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = browserInput;
  if (typeof window !== 'undefined') window.browserInput = browserInput;
})();
