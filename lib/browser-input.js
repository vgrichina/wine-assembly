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
    function relativeMovement(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (Number(e.movementX) || 0) * canvas.width / Math.max(1, r.width),
        y: (Number(e.movementY) || 0) * canvas.height / Math.max(1, r.height),
      };
    }
    function pointerLocked() {
      return (document.pointerLockElement || document.webkitPointerLockElement) === canvas;
    }
    // The renderer heuristic reads live guest cursor state (ShowCursor,
    // ClipCursor), which games publish from inside their frame loop — so at
    // the one moment a browser may request Pointer Lock (a trusted mousedown)
    // that state can be a frame stale. Latch it instead: once this exclusive
    // presentation has ever asked for relative mouse, every later click may
    // capture, even when the sampled state loses the race with that click.
    // The latch is session-only and drops with the exclusive presentation, so
    // an ordinary window from the same process never captures the desktop.
    let relativeMouseLatch = false;
    function exclusivePresentationActive() {
      return !!(renderer._exclusiveTransform || renderer._exclusivePresentationViewport);
    }
    function updateRelativeMouseLatch(canvasX, canvasY) {
      // The renderer heuristic already requires an exclusive presentation, so
      // consult it unconditionally; the bridge's own check only scopes the
      // latch lifetime and the manifest fallback below.
      if (renderer.wantsRelativeMouse && Number.isFinite(canvasX) && Number.isFinite(canvasY) &&
          renderer.wantsRelativeMouse(canvasX, canvasY)) {
        relativeMouseLatch = true;
        return true;
      }
      if (!exclusivePresentationActive()) relativeMouseLatch = false;
      return relativeMouseLatch;
    }
    function wantsRelativeMouse(canvasX, canvasY) {
      if (updateRelativeMouseLatch(canvasX, canvasY)) return true;
      if (!exclusivePresentationActive()) return false;
      // An app manifest may still declare the intent up front (relativeMouse)
      // for games whose cursor state is never observable before first capture.
      return runningApps.some(app => app && app.relativeMouse &&
        (!app.wine || app.wine.running !== false));
    }
    function activeMobileTouchMode() {
      for (let i = runningApps.length - 1; i >= 0; i--) {
        const app = runningApps[i];
        if (!app || (app.wine && app.wine.running === false)) continue;
        if (app.mobileTouch === 'direct' || app.mobileTouch === 'trackpad') {
          return app.mobileTouch;
        }
        break;
      }
      return 'auto';
    }
    function wantsTouchTrackpad(canvasX, canvasY) {
      const mode = activeMobileTouchMode();
      if (mode === 'direct') return false;
      if (mode === 'trackpad') return true;
      return wantsRelativeMouse(canvasX, canvasY);
    }
    let lastCanvasPointer = null;
    function syncGuestCursorVisibility(canvasX, canvasY) {
      if (Number.isFinite(canvasX) && Number.isFinite(canvasY)) {
        lastCanvasPointer = { x: canvasX, y: canvasY };
      }
      const hidden = !!(runningApps.length && lastCanvasPointer &&
        renderer.wantsHiddenMouse &&
        renderer.wantsHiddenMouse(lastCanvasPointer.x, lastCanvasPointer.y));
      if (canvas.classList) canvas.classList.toggle('guest-cursor-hidden', hidden);
      return hidden;
    }
    // ShowCursor can change while the pointer is stationary (during scene
    // setup, or when a modal closes), so input events alone are insufficient.
    // The class is CSS !important and therefore cannot be undone by a later
    // guest SetCursor writing an inline cursor while the display count is low.
    setInterval(() => {
      syncGuestCursorVisibility();
      // Guests publish ShowCursor/ClipCursor between input events; poll so
      // the latch arms even while the pointer sits still over the game.
      updateRelativeMouseLatch(
        lastCanvasPointer ? lastCanvasPointer.x : NaN,
        lastCanvasPointer ? lastCanvasPointer.y : NaN);
    }, 100);
    let mouseDownUsesRelative = false;
    // Some browsers report one synthetic movementX/Y jump while pointer lock
    // is being acquired from a mousedown. That delta describes the browser's
    // capture transition, not physical motion; feeding it to a software-cursor
    // guest moves the hotspot between DOWN and UP and turns a click into a
    // miss. Suppress only that acquisition click's locked movement. Once the
    // button is released, ordinary relative motion resumes immediately.
    let suppressRelativeUntilRelease = false;
    function mouseButtonPoint(e, forceVirtual) {
      // Pointer-lock events carry useful movementX/Y but their clientX/Y may
      // be zero or otherwise outside a letterboxed exclusive viewport. Route
      // button-up through the guest's current virtual cursor instead, or the
      // renderer drops WM_LBUTTONUP while clearing only its host-side mask.
      if ((forceVirtual || pointerLocked() || mouseDownUsesRelative) &&
          renderer._unmapExclusiveInputPoint) {
        const point = renderer._unmapExclusiveInputPoint(
          renderer._mouseX || 0, renderer._mouseY || 0);
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
      }
      return eventPoint(e);
    }
    function forwardMouseMove(e) {
      if (pointerLocked() && renderer.handleRelativeMouseMove) {
        if (suppressRelativeUntilRelease) {
          syncGuestCursorVisibility();
          return true;
        }
        const delta = relativeMovement(e);
        renderer.handleRelativeMouseMove(delta.x, delta.y);
        syncGuestCursorVisibility();
        return true;
      }
      // requestPointerLock() is asynchronous. A drag can arrive after the
      // trusted down asked for capture but before pointerlockchange confirms
      // it; treating that brief sample as absolute recreates the same
      // off-centre jump the capture gate below prevents.
      if (mouseDownUsesRelative) {
        syncGuestCursorVisibility();
        return true;
      }
      const { x, y } = eventPoint(e);
      renderer.handleMouseMove(x, y);
      syncGuestCursorVisibility(x, y);
      return false;
    }
    function requestGuestPointerLock(canvasX, canvasY) {
      if (pointerLocked()) return true;
      const request = canvas.requestPointerLock || canvas.webkitRequestPointerLock;
      if (!request || !wantsRelativeMouse(canvasX, canvasY)) return false;
      // Pointer lock itself hides the host cursor and provides unbounded
      // movementX/Y. The guest remains authoritative for the virtual cursor
      // through GetCursorPos/SetCursorPos. Keep this one synchronous,
      // optionless request inside the trusted click. Some engines reject the
      // raw-movement option asynchronously; a retry from that rejection no
      // longer owns the click's transient user activation and cannot capture.
      try {
        // Keep the explicit standard call for modern engines; older Safari
        // shipped the same API under the WebKit name and requires its method
        // to be called with the canvas as `this`.
        const result = canvas.requestPointerLock
          ? canvas.requestPointerLock()
          : canvas.webkitRequestPointerLock.call(canvas);
        if (result && result.catch) result.catch(() => {});
      } catch (_) {}
      return true;
    }
    const keyboardProxy = document.getElementById('mobile-keyboard-proxy');
    const isKeyboardProxy = el => keyboardProxy && el === keyboardProxy;
    function clearKeyboardProxy() {
      if (keyboardProxy && keyboardProxy.value) keyboardProxy.value = '';
    }
    // Does the guest have somewhere to put text? A Win32 caret exists exactly
    // when something is taking keystrokes, so it is the gate that keeps
    // Minesweeper from opening a keyboard over half its own board.
    let hadCaret = false;
    let caretWatchTimer = null;
    // ...unless the user asked for one by hand. Every fullscreen DirectDraw
    // game that takes text -- Diablo II's character name, StarCraft chat, a
    // Half-Life console -- paints its own field and never creates a Win32
    // caret, so the automatic path above can never fire for them and a phone
    // has no other way in.
    let manualKeyboard = false;
    function guestHasCaret() {
      try {
        return !!(renderer && renderer.caretRect && renderer.caretRect());
      } catch (_) {
        return false;
      }
    }
    function syncKeyboardProxy(gesture) {
      if (!keyboardProxy) return;
      // No app running is not a reason to skip this -- it is the single most
      // important time to run it. The keyboard comes down when the guest drops
      // its caret, and an app that exits drops its caret and empties
      // runningApps in the same instant. Returning early here meant the proxy
      // stayed focused with nothing behind it, iOS kept the keyboard up, and
      // the keyboard controller kept #screen-wrap translated upward -- which
      // takes the desktop icon grid, a child of that same element, off the top
      // of the screen. The result is a bare teal page with no launcher on it,
      // and it looks exactly like an app that refused to close.
      const noApps = !runningApps || !runningApps.length;
      if (noApps) manualKeyboard = false;
      const decide = (window.MobileKeyboard && window.MobileKeyboard.keyboardProxyAction) || null;
      const hasCaret = noApps ? false : guestHasCaret();
      const caretIsNew = hasCaret && !hadCaret;
      hadCaret = hasCaret;
      const action = decide
        ? decide({
            hasCaret,
            proxyFocused: document.activeElement === keyboardProxy,
            gesture,
            caretIsNew,
            manual: manualKeyboard,
          })
        : (gesture || manualKeyboard ? 'focus' : 'none');
      if (action === 'focus') {
        // iOS only opens the software keyboard from a real editable DOM
        // element, and only during a user gesture. The canvas remains the
        // visual surface; this hidden textarea is just the keyboard device.
        try {
          clearKeyboardProxy();
          keyboardProxy.focus({ preventScroll: true });
        } catch (_) {
          try { keyboardProxy.focus(); } catch (_) {}
        }
      } else if (action === 'blur') {
        clearKeyboardProxy();
        try { keyboardProxy.blur(); } catch (_) {}
        try { canvas.focus({ preventScroll: true }); } catch (_) {}
      }
    }
    // The touch-control overlay covers the canvas, so a tap it decides to hand
    // on to the guest never reaches the handler below -- and iOS only opens
    // its keyboard from inside a real user gesture, which is the DOM event the
    // overlay is holding. Publishing this lets the overlay make the same call
    // this file makes, from inside that same gesture.
    if (typeof window !== 'undefined') {
      window.__wineFocusKeyboardProxy = () => focusGuestKeyboardProxy();
      // The manual keyboard, driven by the on-screen pill. Called from inside
      // the overlay's touchstart, which is the only moment iOS will open a
      // keyboard. Returns the state it left the keyboard in so the pill can
      // paint itself.
      window.__wineToggleKeyboard = () => setManualKeyboard(!manualKeyboard);
      window.__wineSetKeyboard = (on) => setManualKeyboard(!!on);
      window.__wineKeyboardOpen = () =>
        manualKeyboard || document.activeElement === keyboardProxy;
    }
    function setManualKeyboard(on) {
      manualKeyboard = !!on;
      // syncKeyboardProxy does both halves: with `manual` set it focuses, and
      // with it cleared the ordinary no-caret rule blurs. A guest that DOES
      // have a caret keeps its keyboard either way, which is right -- turning
      // the manual toggle off should not close a text field's own keyboard.
      syncKeyboardProxy(true);
      return manualKeyboard;
    }
    function focusGuestKeyboardProxy() {
      syncKeyboardProxy(true);
      // The click has only been queued; the guest creates its caret a few
      // frames later, and on Android that late focus still raises the
      // keyboard. Watch briefly rather than guessing from the hit rect.
      if (caretWatchTimer) clearInterval(caretWatchTimer);
      let ticks = 0;
      caretWatchTimer = setInterval(() => {
        syncKeyboardProxy(false);
        if (++ticks >= 8) {
          clearInterval(caretWatchTimer);
          caretWatchTimer = null;
        }
      }, 100);
    }
    // The guest can drop its caret without any input from us -- a dialog
    // closes, the app moves focus to a button -- and the keyboard has to go
    // away with it.
    setInterval(() => syncKeyboardProxy(false), 500);
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
    let mouseDownButton = 0;
    let activeTouchId = null;
    let lastTouchPoint = null;
    let lastTouchClientPoint = null;
    let touchTrackpadActive = false;
    let touchSentMouseDown = false;
    let touchTravelCss = 0;
    let lastTrackpadTapAt = 0;
    const TRACKPAD_TAP_SLOP_CSS = 10;
    const TRACKPAD_DRAG_TAP_MS = 400;
    function inputNow() {
      return typeof performance !== 'undefined' && performance.now
        ? performance.now() : Date.now();
    }
    function virtualCursorCanvasPoint(fallback) {
      if (renderer._unmapExclusiveInputPoint &&
          Number.isFinite(renderer._mouseX) && Number.isFinite(renderer._mouseY)) {
        const point = renderer._unmapExclusiveInputPoint(renderer._mouseX, renderer._mouseY);
        if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
      }
      return fallback;
    }
    function syncTouchCursorToGuest(fallback) {
      const tc = typeof window !== 'undefined' ? window.TouchCursor : null;
      if (!tc || typeof tc.move !== 'function') return;
      const point = virtualCursorCanvasPoint(fallback);
      if (!point) return;
      const r = canvas.getBoundingClientRect();
      tc.move(
        r.left + point.x * r.width / Math.max(1, canvas.width),
        r.top + point.y * r.height / Math.max(1, canvas.height));
    }
    function stopMouseDragCapture() {
      mouseDragActive = false;
      mouseDownActive = false;
      mouseDownUsesRelative = false;
      suppressRelativeUntilRelease = false;
      window.removeEventListener('mousemove', windowMouseMove, true);
      window.removeEventListener('mouseup', windowMouseUp, true);
      window.removeEventListener('blur', windowMouseCancel, true);
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
      lastTouchClientPoint = null;
      touchTrackpadActive = false;
      touchSentMouseDown = false;
      touchTravelCss = 0;
      window.removeEventListener('touchmove', windowTouchMove, true);
      window.removeEventListener('touchend', windowTouchEnd, true);
      window.removeEventListener('touchcancel', windowTouchCancel, true);
    }

    // Pinch to switch how the guest is presented: out fills the screen and
    // crops, in fits the whole window and letterboxes. A phone has exactly one
    // gesture spare for this -- the canvas otherwise routes every touch to the
    // guest as a mouse -- and the second finger is the tell: a Win98 app has
    // no use for one, so a second concurrent touch is unambiguously ours.
    //
    // The gesture takes the first finger's press with it. In direct mode that
    // press already reached the guest as WM_LBUTTONDOWN; a tap-hold trackpad
    // drag also owns a held button. Entering pinch retires either one rather
    // than leaving a button stuck down for the rest of the gesture.
    const PINCH_OUT = 1.25;   // fingers apart by a quarter: fill the screen
    const PINCH_IN = 0.8;     // together by a fifth: fit the whole window
    let pinchStartDist = 0;
    let pinchTouchIds = null;
    function pinchDistance(list, ids) {
      const a = touchById(list, ids[0]);
      const b = touchById(list, ids[1]);
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    function pinchActive() { return !!pinchTouchIds; }
    function beginPinch(e, second) {
      const ids = [activeTouchId, second.identifier];
      const dist = pinchDistance(e.touches, ids);
      if (!(dist > 0)) return false;
      // Retire the guest's button before the gesture owns the screen.
      const p = lastTouchPoint;
      if (p && touchSentMouseDown) {
        const release = touchTrackpadActive ? virtualCursorCanvasPoint(p) : p;
        renderer.handleMouseUp(release.x, release.y, 0);
      }
      stopTouchCapture();
      pinchTouchIds = ids;
      pinchStartDist = dist;
      window.addEventListener('touchmove', windowPinchMove, { capture: true, passive: false });
      window.addEventListener('touchend', windowPinchEnd, { capture: true, passive: false });
      window.addEventListener('touchcancel', windowPinchEnd, { capture: true, passive: false });
      return true;
    }
    function endPinch() {
      pinchTouchIds = null;
      pinchStartDist = 0;
      window.removeEventListener('touchmove', windowPinchMove, true);
      window.removeEventListener('touchend', windowPinchEnd, true);
      window.removeEventListener('touchcancel', windowPinchEnd, true);
    }
    function windowPinchMove(e) {
      if (!pinchTouchIds) return;
      e.preventDefault();
      e.stopPropagation();
      const dist = pinchDistance(e.touches, pinchTouchIds);
      if (!(dist > 0) || !(pinchStartDist > 0)) return;
      const scale = dist / pinchStartDist;
      // One flip per gesture: past the threshold the mode is set and the rest
      // of the gesture is inert, so a wobbling pinch cannot oscillate.
      if (scale >= PINCH_OUT) setPresentationViewMode('zoom');
      else if (scale <= PINCH_IN) setPresentationViewMode('fit');
      else return;
      pinchStartDist = 0;
    }
    function windowPinchEnd(e) {
      if (!pinchTouchIds) return;
      e.preventDefault();
      e.stopPropagation();
      // Hold the gesture until every finger of it is off the glass, so the
      // last one lifting does not start a fresh press on the guest.
      for (const id of pinchTouchIds) {
        if (touchById(e.touches, id)) return;
      }
      endPinch();
    }
    function setPresentationViewMode(mode) {
      const tc = typeof window !== 'undefined' ? window.TouchControls : null;
      // Through the overlay when there is one, so its label follows; straight
      // to the renderer otherwise.
      if (tc && tc.installed && typeof tc.setViewMode === 'function') {
        tc.setViewMode(mode);
        return;
      }
      if (renderer.setViewMode) renderer.setViewMode(mode);
    }
    function windowMouseMove(e) {
      if (!mouseDownActive) return;
      const buttonBit = mouseDownButton === 2 ? 2 : mouseDownButton === 1 ? 4 : 1;
      if (typeof e.buttons === 'number' && !(e.buttons & buttonBit)) {
        // Some browsers omit mouseup while acquiring pointer lock or moving
        // focus. A later move with the physical button clear is authoritative.
        const point = mouseButtonPoint(e, true);
        renderer.handleMouseUp(point.x, point.y, mouseDownButton);
        stopMouseDragCapture();
        return;
      }
      mouseDragActive = true;
      e.preventDefault();
      e.stopPropagation();
      forwardMouseMove(e);
    }
    function windowMouseUp(e) {
      if (!mouseDownActive) return;
      e.preventDefault();
      e.stopPropagation();
      const { x, y } = mouseButtonPoint(e);
      renderer.handleMouseUp(x, y, e.button);
      stopMouseDragCapture();
    }
    function windowMouseCancel() {
      if (!mouseDownActive) return;
      const point = mouseButtonPoint(null, true);
      renderer.handleMouseUp(point.x, point.y, mouseDownButton);
      stopMouseDragCapture();
    }
    function windowTouchMove(e) {
      if (activeTouchId === null) return;
      const t = touchById(e.changedTouches, activeTouchId) || touchById(e.touches, activeTouchId);
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      if (touchTrackpadActive) {
        const previous = lastTouchClientPoint || { x: t.clientX, y: t.clientY };
        const dxCss = t.clientX - previous.x;
        const dyCss = t.clientY - previous.y;
        lastTouchClientPoint = { x: t.clientX, y: t.clientY };
        touchTravelCss += Math.hypot(dxCss, dyCss);
        const r = canvas.getBoundingClientRect();
        const dx = dxCss * canvas.width / Math.max(1, r.width);
        const dy = dyCss * canvas.height / Math.max(1, r.height);
        if ((dx || dy) && renderer.handleRelativeMouseMove) {
          renderer.handleRelativeMouseMove(dx, dy);
          syncTouchCursorToGuest(lastTouchPoint);
        }
        return;
      }
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
      if (touchTrackpadActive) {
        const fallback = lastTouchPoint || eventPointFromClient(t.clientX, t.clientY);
        const p = virtualCursorCanvasPoint(fallback);
        if (touchSentMouseDown) {
          renderer.handleMouseUp(p.x, p.y, 0);
          lastTrackpadTapAt = 0;
        } else if (touchTravelCss <= TRACKPAD_TAP_SLOP_CSS) {
          // A trackpad click belongs to the cursor, not to the finger. Send
          // the pair together on release so looking around never holds Fire.
          renderer.handleMouseDown(p.x, p.y, 0);
          renderer.handleMouseUp(p.x, p.y, 0);
          lastTrackpadTapAt = inputNow();
          focusGuestKeyboardProxy();
        } else {
          lastTrackpadTapAt = 0;
        }
        syncTouchCursorToGuest(p);
      } else {
        const p = eventPointFromClient(t.clientX, t.clientY);
        renderer.handleMouseUp(p.x, p.y, 0);
      }
      stopTouchCapture();
    }
    function windowTouchCancel(e) {
      if (activeTouchId === null) return;
      e.preventDefault();
      e.stopPropagation();
      const p = lastTouchPoint;
      if (p && touchSentMouseDown) {
        const release = touchTrackpadActive ? virtualCursorCanvasPoint(p) : p;
        renderer.handleMouseUp(release.x, release.y, 0);
      }
      stopTouchCapture();
    }
    canvas.onmousedown = e => {
      e.preventDefault();
      canvas.focus();
      unlockRunningAudio();
      // Pointer Lock freezes clientX/Y at the capture anchor. Once locked,
      // button messages must use the guest's virtual cursor, which has kept
      // moving through movementX/Y; otherwise the click lands where capture
      // began instead of where the game's software cursor is drawn.
      const { x: cx, y: cy } = mouseButtonPoint(e, pointerLocked());
      syncGuestCursorVisibility(cx, cy);
      if (forwardEmptyDesktopClick(e.clientX, e.clientY, cx, cy)) return;
      // A second press without an observed release must first retire the old
      // guest down state. This is a final guard for browser/OS event loss.
      if (mouseDownActive) windowMouseCancel();
      mouseDownUsesRelative = requestGuestPointerLock(cx, cy);
      renderer.handleMouseDown(cx, cy, e.button, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
      focusGuestKeyboardProxy();
      mouseDownActive = true;
      mouseDownButton = e.button;
      mouseDragActive = false;
      window.addEventListener('mousemove', windowMouseMove, true);
      window.addEventListener('mouseup', windowMouseUp, true);
      window.addEventListener('blur', windowMouseCancel, true);
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
    const handlePointerLockChange = () => {
      if (pointerLocked() && mouseDownActive && mouseDownUsesRelative) {
        suppressRelativeUntilRelease = true;
      }
      if (mouseDownActive && mouseDownUsesRelative && !pointerLocked()) windowMouseCancel();
    };
    document.addEventListener('pointerlockchange', handlePointerLockChange);
    document.addEventListener('webkitpointerlockchange', handlePointerLockChange);
    document.addEventListener('visibilitychange', () => {
      if (mouseDownActive && document.visibilityState === 'hidden') windowMouseCancel();
    });
    canvas.addEventListener('touchstart', e => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      // A second finger while one is already down on the canvas is a pinch,
      // never a second mouse: it takes the gesture and the guest sees nothing
      // more of either touch.
      if (activeTouchId !== null) {
        if (beginPinch(e, t)) { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      if (pinchActive()) { e.preventDefault(); return; }
      e.preventDefault();
      canvas.focus();
      unlockRunningAudio();
      const { x: cx, y: cy } = eventPointFromClient(t.clientX, t.clientY);
      if (forwardEmptyDesktopClick(t.clientX, t.clientY, cx, cy)) return;
      activeTouchId = t.identifier;
      lastTouchPoint = { x: cx, y: cy };
      lastTouchClientPoint = { x: t.clientX, y: t.clientY };
      touchTravelCss = 0;
      touchTrackpadActive = wantsTouchTrackpad(cx, cy);
      if (!touchTrackpadActive) lastTrackpadTapAt = 0;
      const now = inputNow();
      const beginTrackpadDrag = touchTrackpadActive && lastTrackpadTapAt > 0 &&
        now - lastTrackpadTapAt <= TRACKPAD_DRAG_TAP_MS;
      touchSentMouseDown = !touchTrackpadActive || beginTrackpadDrag;
      if (touchTrackpadActive) {
        if (beginTrackpadDrag) {
          const p = virtualCursorCanvasPoint(lastTouchPoint);
          renderer.handleMouseDown(p.x, p.y, 0);
          lastTrackpadTapAt = 0;
        }
        syncTouchCursorToGuest(lastTouchPoint);
      } else {
        renderer.handleMouseDown(cx, cy, 0);
        focusGuestKeyboardProxy();
      }
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
      // While an agent session holds input exclusively (lib/agent-remote.js),
      // the human at the keyboard must not also type into the guest. The key
      // listeners below are window-capture and registered at page load, so no
      // later-installed guard can get in front of them — this cooperative
      // check is the seam. Synthetic agent keys have isTrusted=false and pass.
      if (e && e.isTrusted && window.__agentInputExclusive) return true;
      const el = e.target;
      if (isKeyboardProxy(el)) return false;
      // A synthesized event can target `window` (not a Node); treat any
      // non-Node target like the canvas — guest-bound — rather than feeding
      // it to toolbar.contains(), which throws on a non-Node argument.
      if (!el || !(el instanceof Node)) return false;
      if (el === canvas || el === document.body || el === document.documentElement) return false;
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
      renderer.handleKeyDown(vk, {
        code: e.code || '', location: e.location | 0, repeat: !!e.repeat,
      });
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
      renderer.handleKeyUp(e.keyCode, {
        code: e.code || '', location: e.location | 0, repeat: !!e.repeat,
      });
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
    // The VK a physical keyboard would have reported for this character. Only
    // the unambiguous ones: letters and digits map to their uppercase code
    // point by definition of the Win32 VK space, space is 0x20, and everything
    // else (punctuation, which is OEM-scancode territory and layout dependent)
    // returns 0 and travels as WM_CHAR only.
    function vkForChar(ch) {
      if (!ch) return 0;
      const c = ch.charCodeAt(0);
      if (c >= 0x30 && c <= 0x39) return c;             // 0-9
      if (c >= 0x41 && c <= 0x5a) return c;             // A-Z
      if (c >= 0x61 && c <= 0x7a) return c - 32;        // a-z -> A-Z
      if (c === 0x20) return 0x20;                      // VK_SPACE
      if (c === 0x0a || c === 0x0d) return 0x0d;        // VK_RETURN
      if (c === 0x09) return 0x09;                      // VK_TAB
      return 0;
    }
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
          // WM_CHAR alone is not the whole keystroke. A soft keyboard reports
          // keyCode 229 (or 0) on iOS, so the window keydown above carries no
          // usable virtual key and a guest that reads WM_KEYDOWN -- which is
          // most games drawing their own text field -- sees nothing at all.
          // Synthesize the pair around the character.
          const vk = vkForChar(ch);
          if (vk) renderer.handleKeyDown(vk, { code: '', location: 0, repeat: false });
          renderer.handleKeyPress(charCode);
          if (vk) renderer.handleKeyUp(vk, { code: '', location: 0, repeat: false });
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
    // iOS closes its keyboard from its own affordances (the Done key, a
    // downward swipe), and all we ever see of that is the proxy losing focus.
    // Without this the manual flag survives the dismissal and the 500ms
    // resync puts the keyboard straight back up, which reads as a keyboard
    // that cannot be closed.
    if (keyboardProxy) {
      keyboardProxy.addEventListener('blur', () => {
        manualKeyboard = false;
        if (typeof window !== 'undefined' && window.TouchControls &&
            window.TouchControls.syncKeyboardToggle) {
          try { window.TouchControls.syncKeyboardToggle(); } catch (_) {}
        }
      });
    }
    canvas.onmousemove = e => {
      if (mouseDragActive) return;
      if (pointerLocked()) {
        forwardMouseMove(e);
        return;
      }
      const { x: mx, y: my } = eventPoint(e);
      // A clipped/hidden exclusive game is asking for relative motion, but a
      // browser cannot grant Pointer Lock until the player clicks. Do not feed
      // the absolute DOM position into that game's virtual Win32 cursor while
      // capture is pending. Quake-style input polls displacement from the
      // screen centre and calls SetCursorPos back to the centre every frame;
      // repeating an off-centre DOM position on each mousemove therefore
      // turns distance from the centre into runaway rotation. The trusted
      // mousedown below requests Pointer Lock, after which movementX/Y takes
      // the normal relative path. forwardMouseMove applies the same hold to
      // the short asynchronous acquisition window during a drag.
      if (wantsRelativeMouse(mx, my)) {
        syncGuestCursorVisibility(mx, my);
        return;
      }
      renderer.handleMenuHover(mx, my);
      // Always deliver mouse moves — WM_SETCURSOR depends on it, and games
      // like Reversi key their "valid move" cross cursor on WM_MOUSEMOVE.
      renderer.handleMouseMove(mx, my);
      syncGuestCursorVisibility(mx, my);
    };
  }

  const browserInput = {
    wireCanvasInput,
    isWired: () => inputWired,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = browserInput;
  if (typeof window !== 'undefined') window.browserInput = browserInput;
})();
