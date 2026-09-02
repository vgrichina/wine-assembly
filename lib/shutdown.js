// Shut Down Windows.
//
// The Start menu's last item, the "What do you want the computer to do?"
// dialog behind it, and what the box does after OK: the shutting-down
// screen, then either the orange "It's now safe to turn off your computer."
// on black, a restart, or -- for Stand by -- a dark screen that wakes on the
// first key or tap with everything still running.
//
// ---- where the pictures come from ----------------------------------------
//
// Windows 98 kept both screens as 320x400 bitmaps (LOGOW.SYS, LOGOS.SYS)
// that the display stretched to 640x480, which is why their pixels are twice
// as wide as they are tall. Here they are painted by the emulator's own GDI
// -- src/09c3-controls.wat, $paint_power_screen, through the
// paint_power_screen export -- into a 320x400 DIB in wasm memory, and this
// file only copies those pixels onto a canvas and stretches it 4:3. Nothing
// about the picture is decided on the host side. The instance that paints is
// the one whose guest asked (host.js hands it over), any instance still
// running for the Start menu path, or, with nothing running, a bare one
// booted just long enough to paint.
//
// ---- why the dialog is host-page DOM and not a guest window --------------
//
// The machine is the page. Powering it off tears down every guest, so the
// thing doing the powering off cannot live inside one, and the Start menu it
// hangs from is already page DOM (index.html). The guest-side twin is real
// and separate: Task Manager's File > Shutdown Windows... opens a WAT-built
// copy of this same dialog (src/09c3-controls.wat, $create_shutdown_dialog),
// and ExitWindowsEx is a real API; both end in the `exit_windows` host import
// (host.js), which lands in run() below. One sequence, two front doors.
//
// ---- input while a screen is up ------------------------------------------
//
// lib/browser-input.js owns the keyboard at window capture and forwards keys
// to the guest, but ignores any event whose target is an <input>. Every
// screen here keeps a focused, invisible <input>, so a key pressed to wake
// from Stand by reaches this file and never the game underneath. Pointer
// events are simpler: the screen is on top and stops them.
//
// window.wineShutdownUI.install({ shell, closeStartMenu, instances })
// returns the controller that host.js and the Start menu call; index.html
// publishes it as window.wineShutdown.

(function () {
  'use strict';

  // exit_windows mode numbers (src/01-header.wat) -> names.
  const MODES = ['standby', 'shutdown', 'restart', 'logoff'];

  const WAIT_MS = 2600;      // how long "Please wait" stays up before the next screen
    const LOGOFF_MS = 1400;

  // The bitmap the guest side paints: 320 columns of BGRX, 400 rows.
  const LOGO_W = 320;
  const LOGO_H = 400;
  const SCREEN_WAIT = 0;     // $paint_power_screen kinds
  const SCREEN_OFF = 1;
  const SCREEN_OFF_FOOTER = 2;  // the same, plus the what-now footer
  const SCREENS = [SCREEN_WAIT, SCREEN_OFF, SCREEN_OFF_FOOTER];
  const FOOTER_MS = 400;     // the dead screen sits alone this long first
  // Where $power_paint_off puts the footer's two boxes, in bitmap pixels.
  // The picture is the control: these only say where a click lands.
  const FOOTER_HITS = [
    { name: 'restart', left: 40, top: 352, right: 152, bottom: 376 },
    { name: 'visit', left: 168, top: 352, right: 280, bottom: 376 },
  ];
  const VISIT_URL = 'https://berrry.app';

  const STYLE = `
    #wine-shutdown-dialog {
      position: fixed; inset: 0; z-index: 5000;
      display: flex; align-items: center; justify-content: center;
      font-family: "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif;
      font-size: 11px; color: #000;
    }
    /* The geometry is shell32.dll 4.72's dialog 1064 (see
       $create_shutdown_dialog in src/09c3-controls.wat for the dialog
       units): a 316x148 client, icon at (10,16), prompt at (57,18), radios
       at x=57 from y=44 every 19.5px, and 78x23 buttons at y=117. */
    #wine-shutdown-dialog .win {
      width: 322px; max-width: calc(100vw - 16px); box-sizing: border-box;
      background: #c0c0c0;
      border: 1px solid; border-color: #dfdfdf #000 #000 #dfdfdf;
      box-shadow: inset 1px 1px #fff, inset -1px -1px #808080, 2px 2px 0 rgba(0,0,0,.25);
      padding: 1px; user-select: none;
    }
    #wine-shutdown-dialog .title {
      display: flex; align-items: center; height: 18px; margin: 1px;
      padding: 0 2px 0 4px; color: #fff; font-weight: bold;
      background: linear-gradient(to right, #000080, #1084d0);
    }
    #wine-shutdown-dialog .title span { flex: 1; }
    #wine-shutdown-dialog .title button {
      width: 16px; height: 14px; padding: 0; font: bold 10px/1 Arial, sans-serif;
      background: #c0c0c0; color: #000; border: 1px solid; border-color: #fff #000 #000 #fff;
      box-shadow: inset -1px -1px #808080; cursor: pointer;
    }
    #wine-shutdown-dialog .title button:active { border-color: #000 #fff #fff #000; box-shadow: none; }
    #wine-shutdown-dialog .client { position: relative; height: 148px; }
    #wine-shutdown-dialog .icon { position: absolute; left: 10px; top: 16px; width: 32px; height: 32px; }
    #wine-shutdown-dialog .prompt { position: absolute; left: 57px; top: 18px; width: 226px; line-height: 16px; white-space: nowrap; }
    #wine-shutdown-dialog label {
      position: absolute; left: 57px; width: 232px; height: 16px;
      display: flex; align-items: center; gap: 5px; cursor: pointer;
    }
    #wine-shutdown-dialog label:nth-of-type(1) { top: 44px; }
    #wine-shutdown-dialog label:nth-of-type(2) { top: 63px; }
    #wine-shutdown-dialog label:nth-of-type(3) { top: 83px; }
    #wine-shutdown-dialog input[type=radio] { margin: 0; width: 12px; height: 12px; accent-color: #000; }
    #wine-shutdown-dialog .buttons button {
      position: absolute; top: 117px; width: 78px; height: 23px; padding: 0;
      font: inherit; color: #000; background: #c0c0c0; cursor: pointer;
      border: 1px solid; border-color: #fff #000 #000 #fff;
      box-shadow: inset -1px -1px #808080, inset 1px 1px #dfdfdf;
    }
    #wine-shutdown-dialog .buttons button[data-action=ok] { left: 58px; }
    #wine-shutdown-dialog .buttons button[data-action=cancel] { left: 142px; }
    #wine-shutdown-dialog .buttons button[data-action=help] { left: 226px; }
    #wine-shutdown-dialog .buttons button.default { outline: 1px solid #000; outline-offset: -1px; }
    #wine-shutdown-dialog .buttons button:active { border-color: #000 #fff #fff #000; box-shadow: none; }
    #wine-shutdown-dialog .buttons button[disabled] { color: #808080; text-shadow: 1px 1px #fff; cursor: default; }

    #wine-power-screen {
      position: fixed; inset: 0; z-index: 5001; background: #000;
      display: flex; align-items: center; justify-content: center;
      cursor: default; user-select: none; -webkit-user-select: none;
      touch-action: none; overflow: hidden;
    }
    /* Mounted inside the fullscreen element rather than on <body>: that
       element is the whole display, and it may carry will-change/transform
       (index.html's single-app #screen-wrap does), which makes it the
       containing block of a fixed child anyway -- so fill it outright. */
    #wine-power-screen.inner, #wine-shutdown-dialog.inner { position: absolute; }
    #wine-power-screen .keys {
      position: absolute; left: 0; top: 0; width: 1px; height: 1px;
      opacity: 0; border: 0; padding: 0; margin: 0; outline: 0; color: transparent;
      caret-color: transparent; background: transparent; resize: none;
      font-size: 16px; /* iOS zooms the page to any smaller focused field */
    }
    /* The 320x400 bitmap shown the way a 640x480 display showed it: 4:3,
       no smoothing, as large as the viewport allows. */
    /* Sized by fit() below from the screen's own box, not from viewport
       units: the box is the viewport on <body>, but inside a fullscreen
       element it is that element, and on a phone the visible viewport is
       whatever the browser's bars leave. */
    /* index.html styles every <canvas> as the app display (absolute at 0,0,
       100% x 100%, and !important in its fullscreen/single-app states), so
       this one has to say, at higher specificity and just as loudly, that it
       is a flex item and nothing else; fit() sets its size inline the same
       way. */
    #wine-power-screen canvas.logo {
      display: block;
      position: static !important; inset: auto !important;
      margin: 0 !important; transform: none !important;
      z-index: 0 !important; /* a flex item stacks by z-index; the page gives every canvas 2 */
      image-rendering: pixelated; image-rendering: crisp-edges;
      background: #000;
    }
    #wine-power-screen canvas.logo.hot { cursor: pointer; }
  `;

  const ICON_SVG =
    '<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">' +
    '<rect x="1" y="3" width="26" height="19" fill="#c0c0c0" stroke="#000"/>' +
    '<rect x="3" y="5" width="22" height="15" fill="#000080"/>' +
    '<rect x="4" y="6" width="20" height="13" fill="#1084d0"/>' +
    '<rect x="10" y="22" width="8" height="3" fill="#808080"/>' +
    '<rect x="6" y="25" width="16" height="2" fill="#000"/>' +
    '<circle cx="26" cy="24" r="5" fill="#ffd700" stroke="#000"/>' +
    '<rect x="25" y="20" width="2" height="5" fill="#000"/>' +
    '</svg>';

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.appendChild(child);
    return node;
  }

  // Ask a live instance for one screen and copy it onto the canvas.
  // Returns false when that instance could not paint (no exports, no memory,
  // or the DIB allocation failed).
  function blitScreen(wine, kind, canvas) {
    const exports = wine && wine.instance && wine.instance.exports;
    const memory = wine && wine.memory;
    if (!exports || !memory) return false;
    if (!exports.paint_power_screen) {
      // A wasm without the export is a stale build in the browser's cache
      // (host.js SOURCE_VERSION is the cache key). Say so: the alternative
      // is a black screen with nothing to point at.
      console.warn('[shutdown] this wasm has no paint_power_screen export: stale build/wine-assembly.wasm in cache?');
      return false;
    }
    let bits = 0;
    try { bits = exports.paint_power_screen(kind) >>> 0; }
    catch (error) { console.warn('[shutdown] paint_power_screen threw', error); return false; }
    if (!bits) return false;
    const src = new Uint8Array(memory.buffer, bits, LOGO_W * LOGO_H * 4);
    const context = canvas.getContext('2d');
    const image = context.createImageData(LOGO_W, LOGO_H);
    const dst = image.data;
    for (let i = 0; i < LOGO_W * LOGO_H * 4; i += 4) {
      dst[i] = src[i + 2];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i];
      dst[i + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return true;
  }

  function install(deps) {
    const shell = deps.shell;
    const closeStartMenu = deps.closeStartMenu || (() => {});
    // Every instance up right now, for the Start menu path: any of them can
    // paint. index.html passes the desktop's list.
    const instances = deps.instances || (() => []);
    // The page reload IS the power button; a test replaces it.
    const powerOn = deps.powerOn || (() => location.reload());

    if (!document.getElementById('wine-shutdown-style')) {
      document.head.appendChild(el('style', { id: 'wine-shutdown-style', text: STYLE }));
    }

    let dialog = null;
    let screen = null;
    let phase = 'on';          // on | wait | off | standby

    // ---- where the overlays live -----------------------------------------
    //
    // index.html gives a game the display by putting #screen-wrap into
    // element fullscreen, and a browser paints nothing outside the
    // fullscreen element -- an overlay on <body> is simply not there. So the
    // dialog and the screens mount inside whatever element is fullscreen
    // right now, and move when that changes (the renderer leaves fullscreen
    // when the last guest window goes, halfway through the sequence).
    function mountHost() {
      return document.fullscreenElement || document.webkitFullscreenElement || document.body;
    }
    function mount(node) {
      const host = mountHost();
      node.classList.toggle('inner', host !== document.body);
      host.appendChild(node);
    }
    function remount() {
      const host = mountHost();
      for (const node of [dialog, screen]) {
        if (node && node.parentNode !== host) {
          mount(node);
          const keys = node.querySelector('.keys');
          if (keys) keys.focus({ preventScroll: true });
        }
      }
      fit();
    }
    // The bitmap as large as the screen's box allows at 4:3, centred by the
    // flex layout. Measured, not computed from viewport units, so it is right
    // inside a fullscreen element and under a phone's moving toolbars alike.
    function fit() {
      const canvas = screen && screen.querySelector('canvas.logo');
      if (!canvas) return;
      const boxW = screen.clientWidth;
      const boxH = screen.clientHeight;
      if (!boxW || !boxH) return;
      const w = Math.min(boxW, Math.floor(boxH * 4 / 3));
      const h = Math.min(boxH, Math.floor(boxW * 3 / 4));
      canvas.style.setProperty('width', `${w}px`, 'important');
      canvas.style.setProperty('height', `${h}px`, 'important');
    }
    document.addEventListener('fullscreenchange', remount);
    document.addEventListener('webkitfullscreenchange', remount);
    window.addEventListener('resize', fit);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', fit);
    const timers = new Set();
    function after(ms, fn) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    }
    function clearTimers() { for (const id of timers) clearTimeout(id); timers.clear(); }

    // ---- the dialog ------------------------------------------------------

    function openDialog() {
      if (dialog) { focusDefault(); return dialog; }
      closeStartMenu();
      const radios = [
        ['standby', 'Stand by'],
        ['shutdown', 'Shut down'],
        ['restart', 'Restart'],
      ].map(([value, label]) => el('label', {}, [
        el('input', { type: 'radio', name: 'wine-shutdown-mode', value }),
        el('span', { text: label }),
      ]));
      const ok = el('button', { type: 'button', class: 'default', text: 'OK', 'data-action': 'ok' });
      const cancel = el('button', { type: 'button', text: 'Cancel', 'data-action': 'cancel' });
      const help = el('button', { type: 'button', text: 'Help', 'data-action': 'help', disabled: '' });
      const closeX = el('button', { type: 'button', text: '✕', 'aria-label': 'Close' });
      const win = el('div', { class: 'win', role: 'dialog', 'aria-label': 'Shut Down Windows' }, [
        el('div', { class: 'title' }, [el('span', { text: 'Shut Down Windows' }), closeX]),
        el('div', { class: 'client' }, [
          el('div', { class: 'icon', html: ICON_SVG }),
          el('div', { class: 'prompt', text: 'What do you want the computer to do?' }),
          ...radios,
          el('div', { class: 'buttons' }, [ok, cancel, help]),
        ]),
      ]);
      dialog = el('div', { id: 'wine-shutdown-dialog' }, [win]);
      // shell32 reopens the dialog on whatever was chosen last time (the
      // behaviour ClassicShutdown reproduces from it); a fresh machine opens
      // on "Shut down".
      const last = lastChoice();
      const preset = radios.find(r => r.querySelector('input').value === last) || radios[1];
      preset.querySelector('input').checked = true;

      ok.addEventListener('click', () => confirm());
      cancel.addEventListener('click', () => closeDialog());
      closeX.addEventListener('click', () => closeDialog());
      // Click on the dim area outside the box: nothing, it is modal.
      dialog.addEventListener('mousedown', e => { if (e.target === dialog) e.preventDefault(); });
      dialog.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); confirm(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDialog(); }
      });
      mount(dialog);
      focusDefault();
      return dialog;
    }
    function focusDefault() {
      const checked = dialog && dialog.querySelector('input[type=radio]:checked');
      if (checked) checked.focus();
    }
    function selectedMode() {
      const checked = dialog && dialog.querySelector('input[type=radio]:checked');
      return checked ? checked.value : 'shutdown';
    }
    // The last option chosen, kept the way shell32 kept it in the registry.
    const CHOICE_KEY = 'wine-shutdown-last-choice';
    function lastChoice() {
      try { return localStorage.getItem(CHOICE_KEY); } catch (_) { return null; }
    }
    function rememberChoice(mode) {
      try { localStorage.setItem(CHOICE_KEY, mode); } catch (_) { /* private mode: forget it */ }
    }
    function confirm() {
      const mode = selectedMode();
      rememberChoice(mode);
      closeDialog();
      run(mode);
    }
    function closeDialog() {
      if (!dialog) return;
      dialog.remove();
      dialog = null;
      const canvas = document.getElementById('screen');
      if (canvas && canvas.focus) canvas.focus({ preventScroll: true });
    }

    // ---- the screens -----------------------------------------------------

    function keyTrap() {
      // A focused field so keystrokes come here and not to the guest; see
      // the header. autocomplete off, or the phone offers suggestions for a
      // field it cannot see.
      return el('input', {
        class: 'keys', type: 'text', autocomplete: 'off', autocorrect: 'off',
        autocapitalize: 'off', spellcheck: 'false', 'aria-hidden': 'true',
      });
    }
    function showScreen(nextPhase, children) {
      hideScreen();
      phase = nextPhase;
      screen = el('div', { id: 'wine-power-screen', 'data-phase': nextPhase }, children);
      const keys = keyTrap();
      screen.appendChild(keys);
      mount(screen);
      fit();
      // Keep the trap focused, so Stand by wakes on a key even after the
      // user clicked around.
      screen.addEventListener('pointerdown', () => keys.focus({ preventScroll: true }));
      keys.focus({ preventScroll: true });
      return { screen, keys };
    }
    function hideScreen() {
      clearTimers();
      if (screen) {
        for (const canvas of screen.querySelectorAll('canvas.logo')) waiting.delete(canvas);
        screen.remove();
      }
      screen = null;
      phase = 'on';
    }

    // ---- painting through the emulator -----------------------------------

    // The bitmaps, once painted, are kept: the same instance is gone by the
    // time the second screen is due, and a bare boot is not free.
    const painted = new Map();   // kind -> offscreen canvas holding the bitmap
    const waiting = new Set();   // on-screen canvases still black, keyed by data-kind
    let painter = null;          // the instance to ask first
    let bareBoot = null;         // promise of a bare instance, when needed

    // Paint every screen not painted yet from one live instance. Returns
    // true when the instance could paint at all.
    function paintAllFrom(wine) {
      let any = false;
      for (const kind of SCREENS) {
        if (painted.has(kind)) { any = true; continue; }
        const offscreen = el('canvas', { width: LOGO_W, height: LOGO_H });
        if (blitScreen(wine, kind, offscreen)) {
          painted.set(kind, offscreen);
          any = true;
        }
      }
      deliver();
      return any;
    }
    // Copy the bitmaps onto whatever on-screen canvases are still black.
    function deliver() {
      for (const canvas of [...waiting]) {
        const done = painted.get(Number(canvas.dataset.kind));
        if (!done) continue;
        canvas.getContext('2d').drawImage(done, 0, 0);
        canvas.dataset.painted = '1';
        waiting.delete(canvas);
      }
    }
    // Get both bitmaps painted while something can still paint them.
    function paintAhead() {
      if (SCREENS.every(kind => painted.has(kind))) return;
      const live = [painter, ...instances()].filter(w => w && w.instance && w.instance.exports);
      for (const wine of live) {
        if (paintAllFrom(wine)) return;
      }
      // Nothing running: boot a bare emulator (fonts and GDI, no exe), paint
      // both screens from it, and throw it away. The screen shows black
      // until it arrives, which is what a real display did between modes.
      if (typeof WineAssembly !== 'function') return;
      if (!bareBoot) {
        bareBoot = (async () => {
          const wine = new WineAssembly();
          await wine.init(el('canvas', { width: 640, height: 480 }));
          paintAllFrom(wine);
          try { wine.stop(); } catch (_) { /* never ran a guest; nothing to stop */ }
        })().catch(error => { console.warn('[shutdown] bare boot failed', error); });
      }
    }
    function logoCanvas(kind) {
      const canvas = el('canvas', { class: 'logo', width: LOGO_W, height: LOGO_H, 'data-kind': kind });
      waiting.add(canvas);
      paintAhead();
      deliver();
      return canvas;
    }

    function stopEverything() {
      // Let the screen paint before the guests are torn down: stopAllApps is
      // synchronous and can take a moment with several instances up.
      after(40, () => {
        try { if (shell && shell.stopAllApps) shell.stopAllApps(); }
        catch (error) { console.warn('[shutdown] stopAllApps failed', error); }
      });
    }

    function showWait() {
      showScreen('wait', [logoCanvas(SCREEN_WAIT)]);
    }

    // A click's position in bitmap pixels, whatever the canvas is scaled to.
    function footerHit(canvas, e) {
      if (canvas.dataset.kind !== String(SCREEN_OFF_FOOTER)) return null;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const x = (e.clientX - rect.left) * LOGO_W / rect.width;
      const y = (e.clientY - rect.top) * LOGO_H / rect.height;
      return FOOTER_HITS.find(h => x >= h.left && x < h.right && y >= h.top && y < h.bottom) || null;
    }

    function showOff() {
      // The machine is off. The screen is the picture LOGOS.SYS was, and a
      // moment later the picture grows a footer -- painted by the same GDI,
      // in the same orange -- with the two things worth doing next. Those
      // boxes are the only thing on the screen that does anything: a tap
      // anywhere used to reload the page, and a reload is not something to
      // hand out for a stray click.
      const canvas = logoCanvas(SCREEN_OFF);
      showScreen('off', [canvas]);
      after(FOOTER_MS, () => {
        canvas.dataset.kind = String(SCREEN_OFF_FOOTER);
        canvas.dataset.painted = '0';
        waiting.add(canvas);
        paintAhead();
        deliver();
      });
      canvas.addEventListener('pointermove', e => {
        canvas.classList.toggle('hot', !!footerHit(canvas, e));
      });
      canvas.addEventListener('click', e => {
        const hit = footerHit(canvas, e);
        if (!hit) return;
        e.preventDefault(); e.stopPropagation();
        if (hit.name === 'restart') powerOn();
        else window.open(VISIT_URL, '_blank', 'noopener');
      });
    }

    function showStandby() {
      const { screen: s } = showScreen('standby', []);
      // Nothing was stopped: the guests keep running under a dark screen, the
      // way a standby machine keeps its memory. The first key or tap wakes it.
      const wake = e => {
        e.preventDefault(); e.stopPropagation();
        hideScreen();
        const canvas = document.getElementById('screen');
        if (canvas && canvas.focus) canvas.focus({ preventScroll: true });
      };
      s.addEventListener('pointerdown', wake);
      s.addEventListener('keydown', wake);
    }

    // ---- the sequence ------------------------------------------------------

    // run(mode, wine): wine is the instance whose guest asked, when one did
    // (host.js), and paints the screens before it is stopped.
    function run(mode, wine) {
      if (typeof mode === 'number') mode = MODES[mode] || 'shutdown';
      painter = wine || null;
      closeDialog();
      closeStartMenu();
      console.log(`[shutdown] ${mode}`);
      switch (mode) {
        case 'standby':
          showStandby();
          break;
        case 'logoff':
          // Windows 98 logs off to a fresh desktop; there is no picture for
          // it, just every program going away.
          showScreen('wait', []);
          stopEverything();
          after(LOGOFF_MS, hideScreen);
          break;
        case 'restart':
          paintAhead();
          showWait();
          stopEverything();
          after(WAIT_MS, powerOn);
          break;
        case 'shutdown':
        default:
          paintAhead();
          showWait();
          stopEverything();
          after(WAIT_MS, showOff);
          break;
      }
      return mode;
    }

    return {
      MODES,
      open: openDialog,
      close: closeDialog,
      run,
      wake: hideScreen,
      phase: () => phase,
      dialogOpen: () => !!dialog,
      // For tests: the painted bitmap for a kind, or null.
      bitmap: kind => painted.get(kind) || null,
      footerHits: () => FOOTER_HITS.map(h => ({ ...h })),
    };
  }

  window.wineShutdownUI = { install, MODES };
})();
