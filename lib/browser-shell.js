// The process lifecycle of the browser host: what it means to launch an app,
// what it means to stop one, and the handful of policies that only exist
// because several guests share one page — one renderer, one canvas, disjoint
// hwnd ranges, and a tab-local LAN segment for two copies of a networked game.
//
// launchApp() is the whole boot in one place: seed the registry/INI values the
// app expects to find, ask the LAN lobby who else is out there (before init(),
// because host imports capture the wire at instantiate time), retire an older
// copy of the same app, stage the PE, mount its data files, walk its DLL
// graph, then start the run loop and arm the startup-dialog dismissal.
//
// This was ~330 lines inside index.html. None of it is markup, all of it
// decides how a guest starts, and it is the code most likely to explain "it
// works headless but not in the browser" — so it now has a file of its own.
//
// The page keeps what is genuinely page: the toolbar, the desktop icons, the
// canvas sizing policy, the debug MIDI player.

(function () {
  function crashReportText(details = {}) {
    const error = details.error || {};
    const message = error && error.message ? error.message : String(error || 'Unknown fatal error');
    const lines = [
      'Wine-Assembly crash report',
      `kind: ${details.kind || 'fatal'}`,
      `app: ${details.app || '(unknown)'}`,
      `time: ${new Date().toISOString()}`,
    ];
    if (typeof location !== 'undefined') lines.push(`url: ${location.href}`);
    if (typeof navigator !== 'undefined') lines.push(`user-agent: ${navigator.userAgent}`);
    if (typeof WineAssembly !== 'undefined' && WineAssembly.SOURCE_VERSION != null) {
      lines.push(`source-version: ${WineAssembly.SOURCE_VERSION}`);
    }
    if (typeof isSecureContext !== 'undefined') lines.push(`secure-context: ${!!isSecureContext}`);
    if (typeof crossOriginIsolated !== 'undefined') lines.push(`cross-origin-isolated: ${!!crossOriginIsolated}`);
    if (typeof SharedArrayBuffer !== 'undefined') lines.push('shared-array-buffer: available');
    else lines.push('shared-array-buffer: unavailable');
    lines.push('', `${error.name || 'Error'}: ${message}`);
    if (error.stage) lines.push(`compiler-stage: ${error.stage}`);
    if (error.line || error.col) lines.push(`source-location: ${error.line || 0}:${error.col || 0}`);
    if (details.state) lines.push(`guest-state: ${details.state}`);
    if (details.tag) lines.push(`detail: ${details.tag}`);
    if (error.stack) lines.push('', 'stack:', String(error.stack));
    if (Array.isArray(error.logs) && error.logs.length) {
      lines.push('', 'compiler-log:', ...error.logs.map(String));
    }
    return lines.join('\n');
  }

  function crashReportUi() {
    let overlay = document.getElementById('wine-crash-report');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'wine-crash-report';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'wine-crash-title');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '100000', display: 'none',
      alignItems: 'center', justifyContent: 'center', padding: '12px',
      background: 'rgba(0,0,0,.58)', boxSizing: 'border-box',
    });
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      width: 'min(680px, 100%)', maxHeight: 'min(760px, 94vh)', display: 'flex',
      flexDirection: 'column', gap: '8px', padding: '3px 10px 10px',
      color: '#000', background: '#c0c0c0', border: '2px outset #fff',
      boxSizing: 'border-box', font: '13px Arial, sans-serif',
    });
    const title = document.createElement('div');
    title.id = 'wine-crash-title';
    title.textContent = 'Wine-Assembly encountered a fatal error';
    Object.assign(title.style, {
      margin: '0 -7px', padding: '4px 6px', color: '#fff', background: '#000080',
      fontWeight: 'bold',
    });
    const summary = document.createElement('div');
    summary.className = 'wine-crash-summary';
    summary.textContent = 'The app stopped. Copy this report when filing a bug.';
    const report = document.createElement('textarea');
    report.className = 'wine-crash-text';
    report.readOnly = true;
    report.spellcheck = false;
    report.setAttribute('aria-label', 'Crash report');
    Object.assign(report.style, {
      width: '100%', minHeight: '230px', flex: '1 1 45vh', resize: 'vertical',
      padding: '7px', boxSizing: 'border-box', color: '#000', background: '#fff',
      border: '2px inset #fff', font: '12px/1.35 monospace', whiteSpace: 'pre',
    });
    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'wine-crash-copy';
    copy.textContent = 'Copy crash report';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'wine-crash-close';
    close.textContent = 'Close';
    for (const button of [copy, close]) {
      Object.assign(button.style, { minWidth: '92px', padding: '5px 10px' });
    }
    copy.addEventListener('click', async () => {
      let copied = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(report.value);
          copied = true;
        }
      } catch (_) { /* insecure LAN / denied permission: use selection below */ }
      if (!copied) {
        report.focus();
        report.select();
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
      }
      copy.textContent = copied ? 'Copied' : 'Select all & copy';
      if (!copied) { report.focus(); report.select(); }
    });
    close.addEventListener('click', () => { overlay.style.display = 'none'; });
    panel.append(title, summary, report, buttons);
    buttons.append(copy, close);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return overlay;
  }

  function showCrashReport(details) {
    const text = crashReportText(details);
    if (typeof document === 'undefined' || !document.body) return text;
    const overlay = crashReportUi();
    overlay.querySelector('.wine-crash-text').value = text;
    overlay.querySelector('.wine-crash-summary').textContent =
      `${details && details.app ? details.app + ' stopped. ' : ''}` +
      'Copy this report when filing a bug.';
    const copy = overlay.querySelector('.wine-crash-copy');
    copy.textContent = 'Copy crash report';
    overlay.style.display = 'flex';
    copy.focus();
    return text;
  }

  // "Has this guest put anything on screen yet?" — the bottom window it owns
  // that is visible, real-sized and not a child control. Two callers ask this
  // and they must agree: the single-app maximizer needs the window it is about
  // to resize, and the boot cursor needs the moment the app stops looking
  // dead. Both are polls because nothing notifies us — the window is created
  // by the guest, mid-run-slice, long after launchApp returns.
  function firstTopLevelWindow(renderer, wine) {
    if (!renderer || !wine) return null;
    return Object.values(renderer.windows || {})
      .filter(w => w && w.visible && !w.isChild && w.w > 0 && w.h > 0 &&
        w.wasm === wine.instance)
      .sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0))[0] || null;
  }

  // deps.apps            — the shared registry (lib/apps.js)
  // deps.debugMode       — ?debug: keeps the HTML desktop visible behind the guest
  // deps.screenCanvasSize() — the page's canvas sizing policy
  // deps.appendDebugLog(text) — write a line into the debug log pane
  // deps.onStopAll()     — page cleanup after the last guest is gone
  function createBrowserShell(deps) {
    const apps = deps.apps;
    const DEBUG_MODE = !!deps.debugMode;
    const screenCanvasSize = deps.screenCanvasSize;
    const appendDebugLog = deps.appendDebugLog || (() => {});
    const onStopAll = deps.onStopAll || (() => {});
    // A small screen: one guest owns the page. The desktop cannot launch a
    // second app while one runs, and the app is given the whole screen — see
    // maximizeForSingleApp below and Win98Renderer._computeSingleAppZoom.
    // The page re-decides this whenever the window is resized, so read it
    // through the callback rather than latching it here.
    const SINGLE_APP = () => (typeof deps.singleApp === 'function'
      ? !!deps.singleApp() : !!deps.singleApp);
    const onAppRunningChange = deps.onAppRunningChange || (() => {});

    let wine = null;
    let lastExitedVfs = null;
    let lastExitedRunSliceAppKey = null;
    const runningApps = [];  // array of { wine, name, appIndex }
    let nextAppIndex = 0;
    let sharedRenderer = null;
    const sharedAudioMixer = {};
    const OVERLAY_FLUSH_MS = 2000;

    function overlayLog(message, failed) {
      appendDebugLog(message);
      if (failed) console.error(message); else console.log(message);
    }

    function flushBrowserOverlay(wine, reason) {
      const overlay = wine && wine._vfsOverlay;
      if (!overlay || !overlay.dirtyPaths().length) return Promise.resolve(null);
      return overlay.flush().then(report => {
        const failed = (report.failed | 0) > 0;
        overlayLog(`[overlay] ${reason}: persisted ${report.written | 0} change(s)` +
          (failed ? `, ${report.failed | 0} failed` : ''), failed);
        return report;
      }, error => {
        overlayLog(`[overlay] ${reason} failed: ${error && error.message || error}`, true);
        return null;
      });
    }

    function stopBrowserOverlay(wine) {
      if (!wine) return;
      if (wine._vfsOverlayTimer) clearInterval(wine._vfsOverlayTimer);
      wine._vfsOverlayTimer = null;
      // A session import already owns its changed bytes in this live VFS.
      // Serializing that same tree into the in-memory store cannot make it
      // survive a reload; on installers it only clones the growing multi-MB
      // output files once more on the UI thread. Only durable OPFS journals
      // need a final store flush.
      if (wine._vfsOverlayDurable) void flushBrowserOverlay(wine, 'stop');
    }

    async function attachDynamicOverlay(wine, app, appId) {
      if (!app.dynamic) return null;
      if (!window.VfsOverlay || !window.OverlayStore) {
        throw new Error(`${appId}: writable import overlay modules are not loaded`);
      }
      const vfs = wine._helpCtx && wine._helpCtx.vfs;
      if (!vfs) throw new Error(`${appId}: the guest has no VFS for its writable overlay`);

      const durable = app.badge === 'kept' && !!app.mediaId;
      let store;
      if (durable) {
        store = window.OverlayStore.opfsStore(app.mediaId, {
          log: message => overlayLog(message, false),
        });
        // Open before wrapping the VFS. If OPFS became unavailable since the
        // media library was restored (private mode/quota revocation), the app
        // still runs with an explicitly session-only journal instead of
        // half-attaching a durable store that can never hydrate or flush.
        try {
          await store.list();
        } catch (error) {
          overlayLog(`[overlay] ${appId}: browser storage unavailable; ` +
            `writable C: changes are session-only (${error && error.message || error})`, true);
          store = null;
        }
      }
      if (!store) {
        if (!app._sessionOverlayStore) app._sessionOverlayStore = window.OverlayStore.memoryStore();
        store = app._sessionOverlayStore;
      }

      const overlay = window.VfsOverlay.attach(vfs, {
        store,
        log: message => overlayLog(message, false),
      });
      const hydrated = await overlay.hydrate();
      wine._vfsOverlay = overlay;
      wine._vfsOverlayDurable = store.kind === 'opfs';
      wine._flushVfsOverlay = reason => flushBrowserOverlay(wine, reason || 'checkpoint');
      // Session imports hand their live VFS directly to an installed child,
      // so checkpointing them to another in-memory copy buys no durability.
      // A WISE installer rewrites its current .pak on every copy slice; the
      // old two-second timer repeatedly cloned that whole growing file and
      // made Safari appear hung. Kept imports still checkpoint to OPFS.
      wine._vfsOverlayTimer = wine._vfsOverlayDurable ? setInterval(() => {
        void flushBrowserOverlay(wine, 'checkpoint');
      }, OVERLAY_FLUSH_MS) : null;
      overlayLog(`[overlay] ${appId}: ${store.kind === 'opfs' ? 'restored' : 'opened session'} ` +
        `${hydrated.files} file(s), ${hydrated.dirs} dir(s), ` +
        `${hydrated.whiteouts} whiteout(s)`, hydrated.errors.length > 0);
      return overlay;
    }

    // One segment for every instance in this tab that chose "both players
    // here". It is the same wire the RTC lobby hands back, minus the network:
    // LoopbackSegment broadcasts each frame to every other endpoint, and the
    // room switch in WAT does the addressing exactly as it does over WebRTC.
    // Sequential addresses are safe because this segment reaches nobody else.
    let pageSegment = null;
    let nextLocalHost = 1;
    function joinPageSegment() {
      if (!pageSegment) pageSegment = new VlanWire.LoopbackSegment();
      return {
        wire: pageSegment.attach(),
        address: `10.77.0.${nextLocalHost++}`,
        local: true,
      };
    }

    // On-screen buttons for keyboard-driven guests (lib/touch-controls.js).
    // Inert on a pointer device and for any app with no `touchControls` in the
    // registry, so this is a call at every lifecycle edge rather than a branch
    // at each of them.
    function syncTouchControls() {
      const tc = typeof window !== 'undefined' ? window.TouchControls : null;
      if (tc) tc.sync(runningApps, sharedRenderer);
      // Zoom (fill) mode needs to know which part of the window is worth
      // filling with; the mode itself resets with the app, so a game left in
      // zoom does not hand the next one a crop of somebody else's window.
      if (sharedRenderer) {
        const last = runningApps.length ? runningApps[runningApps.length - 1] : null;
        const crop = last && last.mobileCrop ? last.mobileCrop : null;
        if (sharedRenderer.mobileCrop !== crop) {
          sharedRenderer.mobileCrop = crop;
          if (sharedRenderer.setViewMode) sharedRenderer.setViewMode('fit');
        }
        // Whether maximizing this app means "the whole canvas" or "the largest
        // rect at its own aspect ratio" -- see Win98Renderer._singleAppMaximizeRect.
        sharedRenderer.singleAppKeepAspect = !!(last && last.keepAspect);
        sharedRenderer.exclusiveCrop = last && last.exclusiveCrop
          ? last.exclusiveCrop : null;
      }
    }

    function snapshotVfs(vfs) {
      if (!vfs || typeof vfs._normPath !== 'function' || !(vfs.files instanceof Map)) {
        return null;
      }
      const normPath = vfs._normPath;
      const resolvePath = vfs._resolvePath;
      const snapshot = {
        files: new Map(vfs.files),
        dirs: new Set(vfs.dirs || []),
        readOnlyDrives: new Set(vfs.readOnlyDrives || []),
        cwd: vfs.cwd,
        _normPath(fileName) { return normPath.call(this, fileName); },
      };
      if (typeof resolvePath === 'function') {
        snapshot._resolvePath = function(fileName) {
          return resolvePath.call(this, fileName);
        };
      }
      for (const mapName of ['volumeLabels', 'volumeSerials', 'driveTypes', 'volumeSizes']) {
        if (vfs[mapName] instanceof Map) snapshot[mapName] = new Map(vfs[mapName]);
      }
      return snapshot;
    }

    function unregisterRunningApp(wine) {
      const index = runningApps.findIndex(running => running && running.wine === wine);
      if (index >= 0) {
        // Preserve the installed machine after its process exits. This copies
        // only VFS maps and path semantics, not the guest's 512MB WASM memory.
        const vfs = wine && wine._helpCtx && wine._helpCtx.vfs;
        const snapshot = snapshotVfs(vfs);
        if (snapshot) {
          lastExitedVfs = snapshot;
          lastExitedRunSliceAppKey = wine._runSliceAppKey || null;
        }
        runningApps.splice(index, 1);
      }
      syncTouchControls();
      const status = document.getElementById('status');
      if (status) status.textContent = runningApps.length
        ? `Running ${runningApps.length} app(s)`
        : 'Ready';
      if (typeof window.updateThreadsStatus === 'function') window.updateThreadsStatus();
      onAppRunningChange(runningApps.length > 0);
      dispatchPendingLaunch();
    }

    function stopRunningApp(running, repaint) {
      if (!running || !running.wine) return;
      if (running.wine._vfsPersistence) running.wine._vfsPersistence.flush();
      if (typeof running.wine.stop === 'function') running.wine.stop({ repaint: false });
      else {
        running.wine.running = false;
        if (running.wine._cleanupAudio) running.wine._cleanupAudio();
        if (running.wine._removeAppWindows) running.wine._removeAppWindows();
      }
      unregisterRunningApp(running.wine);
      if (repaint !== false && sharedRenderer) sharedRenderer.repaint();
    }

    function stopAllApps() {
      for (const app of [...runningApps]) stopRunningApp(app, false);
      runningApps.length = 0;
      syncTouchControls();
      if (sharedRenderer) {
        sharedRenderer.windows = {};
        sharedRenderer.repaint();
      }
      onStopAll();
      onAppRunningChange(false);
    }

    function clearUnownedDisplayMode() {
      if (runningApps.length) return;
      if (sharedRenderer) {
        sharedRenderer._exclusiveFullscreen = false;
        sharedRenderer._exclusiveTransform = null;
        sharedRenderer._exclusivePresentationViewport = null;
        sharedRenderer._exclusivePresentationSource = null;
        sharedRenderer._requestedBrowserFullscreen = false;
        sharedRenderer._fullscreenDeclined = false;
      }
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.remove('exclusive-fullscreen', 'page-fullscreen');
      }
    }

    // Single-app mode: give the app the whole screen the way Windows would —
    // by maximizing it, not by stretching it. A window that can be maximized
    // (WS_MAXIMIZEBOX or a sizing border) relays out at the phone's aspect
    // ratio and stays pixel-exact; one that cannot (Minesweeper, Solitaire's
    // fixed board) is left alone and the renderer zooms it instead.
    //
    // The window does not exist yet when launchApp returns, so this polls for
    // the first top-level window this instance owns, the same way
    // scheduleStartupDialogDismiss waits for a startup dialog.
    const WS_MAXIMIZEBOX = 0x00010000;
    const WS_THICKFRAME = 0x00040000;

    // "Has this guest put anything on screen yet?" — the bottom window it owns
    // that is visible, real-sized and not a child control. Two callers ask
    // this and they must agree: the single-app maximizer needs the window it
    // is about to resize, and the boot cursor needs the moment the app stops
    // looking dead. Both are polls because nothing notifies us: the window is
    // created by the guest, mid-run-slice, long after launchApp returns.
    function maximizeForSingleApp(wine) {
      if (!SINGLE_APP() || !wine || !sharedRenderer) return;
      const e = wine.instance && wine.instance.exports;
      if (!e || !e.send_message) return;
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (!runningApps.some(r => r && r.wine === wine)) { clearInterval(timer); return; }
        const win = firstTopLevelWindow(sharedRenderer, wine);
        if (win) {
          clearInterval(timer);
          const style = win.style >>> 0;
          const resizable = !!(style & (WS_MAXIMIZEBOX | WS_THICKFRAME));
          // "Already as big as we are going to make it." For a keepAspect app
          // that is not the full canvas but the fitted rect, and the guest
          // starts out smaller than it, so the command still has to be sent.
          const keepAspect = !!sharedRenderer.singleAppKeepAspect;
          const alreadyFull = !keepAspect && win.x <= 0 && win.y <= 0 &&
            win.w >= sharedRenderer.canvas.width && win.h >= sharedRenderer.canvas.height;
          if (resizable && !alreadyFull) {
            // WM_SYSCOMMAND / SC_MAXIMIZE. It goes to the app's own wndproc
            // first, so an app that tracks its own maximized state sees the
            // command rather than just a surprise WM_SIZE.
            e.send_message(win.hwnd | 0, 0x0112, 0xF030, 0);
          }
          const how = !resizable ? 'zoomed' : (keepAspect ? 'fitted to its aspect' : 'maximized');
          appendDebugLog(`Single-app mode: ${how} ` +
            `hwnd=0x${(win.hwnd >>> 0).toString(16)} ${win.w}x${win.h}`);
        } else if (tries >= 120) {
          clearInterval(timer);
        }
      }, 50);
    }

    // Booting is invisible, and that reads as broken. Between the click and
    // the app's first window there is a PE to stage, up to 76 data files to
    // fetch (RollerCoaster Tycoon) and a DLL graph to walk, and the desktop
    // shows nothing at all while it happens — the status text lives in the
    // debug toolbar, which is hidden on the live site. Windows answered this
    // with the AppStarting cursor, so the page does too: `progress` is the
    // arrow-plus-hourglass, not the fully-busy `wait`, because the desktop
    // stays live underneath.
    //
    // The boot is over when the guest paints its first top-level window, not
    // when launchApp returns — launchApp is done long before the guest has
    // run a single instruction. Counted rather than a boolean because a
    // ShellExecute hand-off (WRITE.EXE -> WordPad) can have two boots in
    // flight, and the first one to finish must not clear the other's cursor.
    const onAppBootingChange = deps.onAppBootingChange || (() => {});
    let bootsInFlight = 0;
    function beginBoot() {
      bootsInFlight++;
      if (bootsInFlight === 1) onAppBootingChange(true);
    }
    function endBoot() {
      if (bootsInFlight <= 0) return;
      bootsInFlight--;
      if (bootsInFlight === 0) onAppBootingChange(false);
    }
    // Every launch path has to reach exactly one endBoot: the LAN-lobby
    // cancel, both failure branches, and the success path below. This makes
    // that safe to call more than once per launch.
    function bootTicket() {
      let spent = false;
      beginBoot();
      return () => { if (!spent) { spent = true; endBoot(); } };
    }
    // Success path: hold the cursor until there is something to look at. An
    // app that dies or is stopped before it ever shows a window releases it
    // too, otherwise the desktop would keep an hourglass over nothing.
    function releaseBootCursorOnFirstWindow(wine, done) {
      if (!wine || !sharedRenderer) { done(); return; }
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        const running = runningApps.some(r => r && r.wine === wine);
        // 100ms * 6000 = 10 minutes. Not a deadline for the app, just a
        // guarantee that a wedged guest cannot leave a cursor behind forever.
        if (firstTopLevelWindow(sharedRenderer, wine) || !running || tries >= 6000) {
          clearInterval(timer);
          done();
        }
      }, 100);
    }

    // What each app is made of, and which ones get a desktop icon: lib/apps.js.
    function hasWasmTailCalls() {
      return typeof WineAssembly === 'undefined' ||
        !WineAssembly.supportsWasmTailCalls ||
        WineAssembly.supportsWasmTailCalls();
    }

    function autoRunSliceFor(appKey, compatDispatch, workerMode) {
      switch (appKey) {
        case 'heaven7':
        case 'bakkslide7':
          // Both intros unpack a dense payload before and after their setup
          // dialogs. A generic 100k cooperative slice makes the page look
          // frozen and delays the timer that presses the dialog's Start
          // button; 5k keeps that transition responsive.
          return workerMode ? 100000 : 5000;
        case 'jazz2_demo':
          // Keep the old cooperative scheduler responsive through Jazz's J2V
          // decoder and title-to-level transition. A confirmed guest Worker
          // does not occupy the browser thread; there the 1k slice only adds
          // postMessage/rendezvous overhead. Gameplay profiling measured 65.5%
          // Worker duty at 1k versus 94.5% at 100k while page FPS stayed 60.
          return workerMode ? 100000 : 1000;
        // Uplink's immediate-mode OpenGL world submits enough guest work per
        // frame that 1k underfeeds both video and streamed audio. A fresh
        // New Game -> Easy run at 10k sustained about 8.6 presents/s while
        // keeping each cooperative main-thread slice near one frame budget.
        case 'halflife_uplink':
          return 10000;
        // ref_gl's immediate-mode startup is expensive; keep it cooperative
        // with browser input and presentation at the gameplay-proven 10k.
        case 'quake2_demo':
          return 10000;
        // The localized Speed Demons WISE installer spends almost its entire
        // copy phase in a Win16 decompressor and 32KB _lwrite loop. At the
        // generic 100k quantum Safari takes long enough per .pak to look
        // frozen, even though its output file is still growing. The measured
        // 500k path remains responsive (the installer pumps between chunks)
        // and is the same budget used by its browser completion harness.
        case 'cue:speed-demons':
        case 'iso:speed-demons':
          return compatDispatch ? 500 : 500000;
        // The exact SMAC preservation disc's Quick Start path generates its
        // first world synchronously while repainting a cosmetic menu-close
        // sequence. At the generic 100k quantum that correct work presents as
        // a many-minute static planet. The tail-call engine remains responsive
        // at 2M and feeds terrain generation at a practical Pentium-era rate.
        case 'iso:sidmeieralphacentauriclassic-windows95':
          return compatDispatch ? 500 : 500000;
        // Deliberately NOT here: diablo_shareware. Clicking to skip its intro
        // blocks the page for seconds, and this looked like the same case --
        // headless --batch-stats shows 178 of the 300 batches after the click
        // spending the whole 100k-block budget (59%) against 0 of the next
        // 300. But measured in the browser it is not: window.WinePerf's
        // cumulative blockedMs comes out 12159ms at a 100000 slice and 12224ms
        // at 20000, i.e. unchanged, while the smaller slice also cuts the
        // worker budget 5x (maxTotalSteps is derived from this number in
        // host.js). Whatever holds the main thread there is not the main
        // guest slice. See docs/re-notes/diablo-shareware.md.
        case 'spider':
        case 'sol':
        case 'freecell':
        case 'cruel':
        case 'golf':
        case 'pyramid':
        case 'winmine_wep':
        case 'winmine':
        case 'winmine16':
        case 'freecell16':
        case 'sol16':
        case 'mshearts16':
        case 'reversi':
        case 'tictac':
          return compatDispatch ? 100 : 25000;
        default:
          return compatDispatch ? 500 : 100000;
      }
    }

    function selectedRunSlice(appKey, workerMode = false) {
      const compatDispatch = !hasWasmTailCalls();
      const autoSlice = autoRunSliceFor(appKey, compatDispatch, workerMode);
      const select = document.getElementById('slice-size-select');
      const raw = select && select.value ? select.value : 'auto';
      if (raw !== 'auto') {
        const selected = parseInt(raw, 10);
        if (Number.isFinite(selected) && selected > 0) {
          return compatDispatch ? Math.min(selected, autoSlice) : selected;
        }
      }
      return autoSlice;
    }

    function applyRunSlice() {
      const applied = [];
      for (const app of runningApps) {
        app.wine.stepsPerSlice = selectedRunSlice(
          app.runSliceAppKey || app.name, !!app.wine.guestWorker);
        applied.push(`${app.name}:${app.wine.stepsPerSlice}`);
      }
      if (applied.length) {
        appendDebugLog(`Run slice updated: ${applied.join(', ')}`);
      }
    }
    function scheduleStartupDialogDismiss(app, wine) {
      const pending = app && (app.dismissStartupDialogs || app.dismissStartupDialog);
      const configs = Array.isArray(pending) ? pending.slice() : (pending ? [pending] : []);
      if (!configs.length || !wine || !sharedRenderer || !wine.hasGuestExport) return;
      let tries = 0;
      const maxTries = Math.max(...configs.map(cfg => cfg.tries || 80));
      const intervalMs = Math.min(...configs.map(cfg => cfg.intervalMs || 50));
      const timer = setInterval(() => {
        tries++;
        const stillRunning = runningApps.some(r => r && r.wine === wine);
        const dialogs = Object.values(sharedRenderer.windows || {})
          .filter(w => w && w.visible && w.isDialog)
          .sort((a, b) => (b.zOrder || 0) - (a.zOrder || 0));
        const idx = configs.findIndex(cfg =>
          dialogs.some(w => !cfg.title || String(w.title || '').includes(cfg.title)));
        if (idx >= 0) {
          const cfg = configs[idx];
          const dlg = dialogs.find(w => !cfg.title || String(w.title || '').includes(cfg.title));
          const control = Number(cfg.control);
          if (Number.isFinite(control)) {
            if (!wine.hasGuestExport('click_dialog_control')) return;
            Promise.resolve(wine.callGuest(
              'click_dialog_control', dlg.hwnd | 0, control | 0)).catch(() => {});
          } else if (wine.hasGuestExport('send_message')) {
            Promise.resolve(wine.callGuest(
              'send_message', dlg.hwnd | 0, 0x0111, cfg.command || 1, 0)).catch(() => {});
          }
          configs.splice(idx, 1);
          if (!configs.length) clearInterval(timer);
        } else if (!stillRunning || tries >= maxTries) {
          clearInterval(timer);
        }
      }, intervalMs);
    }

    // A few period games begin with an optional codec-driven movie which can
    // be skipped from the keyboard. Keep that compatibility policy in the app
    // registry, but enqueue the key through the normal renderer input path so
    // cooperative guests and real guest Workers observe identical messages.
    function scheduleStartupInput(app, wine) {
      const pending = app && app.startupInput;
      const configs = Array.isArray(pending) ? pending.slice() : (pending ? [pending] : []);
      if (!configs.length || !wine || !sharedRenderer) return;
      for (const cfg of configs) {
        const vk = Number(cfg && cfg.vk);
        if (!Number.isFinite(vk)) continue;
        const delayMs = Math.max(0, Number(cfg.delayMs) || 0);
        const holdMs = Math.max(1, Number(cfg.holdMs) || 30);
        setTimeout(() => {
          if (!runningApps.some(r => r && r.wine === wine)) return;
          sharedRenderer.handleKeyDown(vk);
          setTimeout(() => {
            if (runningApps.some(r => r && r.wine === wine)) {
              sharedRenderer.handleKeyUp(vk);
            }
          }, holdMs);
        }, delayMs);
      }
    }

    // Set by the launch in progress so the outer guard below can reach its
    // failLaunch (which owns that launch's boot ticket) from a catch.
    let pendingLaunchFail = null;

    // Every await in here is somewhere a boot can die -- an out-of-memory in
    // init(), a missing asset, a DLL that will not load -- and only some of
    // them had a .catch. A rejection that escaped left the boot ticket
    // unspent, so body.app-booting stayed on for the life of the page: a
    // permanent hourglass over a desktop with nothing running. Seen on the
    // real phone as "null is not an object (evaluating 'wine.instance.exports')"
    // at the set_hwnd_base line, after init() failed to get its guest memory.
    // launchApp wraps it so failLaunch runs whatever threw.
    // A boot takes seconds on a phone, and the desktop icons stay tappable for
    // all of it -- body.app-booting hides nothing. `wine` is one shared
    // variable, so a second tap during the first boot does not start a second
    // app, it *overwrites the first one mid-init*: launch A resumes after its
    // await and configures B's instance, while A's own WineAssembly is left
    // with no owner, no stop() and its 512MB of guest memory held for the life
    // of the page. That is what the phone hit -- two icon taps, 1GB gone, then
    // "Out of memory" on every later launch. The single-app guard below cannot
    // catch it because runningApps is not pushed until the boot finishes.
    let launchInFlight = false;
    const pendingAppLaunches = [];
    let pendingDispatchScheduled = false;

    function dispatchPendingLaunch() {
      const pending = pendingAppLaunches[0];
      if (pendingDispatchScheduled || launchInFlight || !pending ||
          (pending.waitForExit && runningApps.length)) return;
      pendingDispatchScheduled = true;
      queueMicrotask(() => {
        pendingDispatchScheduled = false;
        const next = pendingAppLaunches[0];
        if (launchInFlight || !next || (next.waitForExit && runningApps.length)) return;
        pendingAppLaunches.shift();
        appendDebugLog(`[ShellExecute] starting queued launch ${next.key}`);
        void api.launchApp(next.key);
      });
    }

    function queuePendingLaunch(key, waitForExit) {
      pendingAppLaunches.push({ key, waitForExit });
      appendDebugLog(`[ShellExecute] queued ${key} until ` +
        (waitForExit ? 'the current process exits' : 'the current boot finishes'));
      dispatchPendingLaunch();
    }

    async function launchApp(appKey) {
      if (launchInFlight) {
        appendDebugLog(`Launch of ${appKey || '(selected)'} ignored: a boot is already in progress`);
        return;
      }
      launchInFlight = true;
      try {
        await launchAppInner(appKey);
        pendingLaunchFail = null;
      } catch (e) {
        const fail = pendingLaunchFail;
        pendingLaunchFail = null;
        if (fail) fail(e);
        else console.error('[launchApp] failed:', e);
      } finally {
        launchInFlight = false;
        dispatchPendingLaunch();
      }
    }

    async function launchAppInner(appKey) {
      const select = document.getElementById('app-select');
      const sel = appKey || select.value;
      const app = apps[sel];
      if (!app) return;
      // A guest that stopped without its notification reaching here leaves an
      // entry that says an app is running when none is, and on a phone that
      // is a dead end: the icons stay hidden behind body.app-running over a
      // renderer that has already dropped the guest's windows, so the page is
      // bare teal and every tap below is refused in silence. Whether the
      // entry is live is knowable, so check it instead of trusting the
      // bookkeeping -- the same reason onAppRunningChange asserts ownership
      // rather than relying on a transition.
      for (const stale of [...runningApps]) {
        if (stale && stale.wine && stale.wine.running === false) {
          unregisterRunningApp(stale.wine);
        }
      }
      clearUnownedDisplayMode();
      // One guest at a time on a phone. The desktop icons are hidden while an
      // app runs, so this only catches a stray programmatic launch.
      if (SINGLE_APP() && runningApps.length) {
        appendDebugLog(`Single-app mode: ignoring launch of ${sel}, an app is already running`);
        return;
      }
      // From here on the page is committed to a boot, so it says so.
      const bootDone = bootTicket();
      if (app.resetIniOnLaunch && typeof localStorage !== 'undefined') {
        for (const name of app.resetIniOnLaunch) {
          localStorage.removeItem('ini:' + String(name).toLowerCase());
        }
      }
      if (app.startupIni && window.StorageImports && StorageImports.setIniValue) {
        for (const entry of app.startupIni) {
          StorageImports.setIniValue(entry.fileName, entry.section, entry.key, entry.value);
        }
      }
      if (app.startupRegistry && window.StorageImports && StorageImports.setRegValue) {
        for (const entry of app.startupRegistry) {
          StorageImports.setRegValue(entry.keyPath, entry.valueName, entry.type, entry.data);
        }
      }
      let launchFailed = false;
      // The WineAssembly this launch built, if it got that far. A boot that
      // dies after init() has already committed 512MB of shared guest memory,
      // and nothing else will ever call stop() on it -- it was never pushed to
      // runningApps -- so the page keeps that half-gigabyte until it is
      // reloaded. Two of those is every later launch failing with "Out of
      // memory" on a phone.
      let createdWine = null;
      const failLaunch = (e) => {
        // Idempotent: the inner catches call this and rethrow, and the outer
        // guard in launchApp catches the same rejection on the way out.
        if (launchFailed) return;
        launchFailed = true;
        const log = document.getElementById('log');
        const msg = 'ERROR launching ' + sel + ': ' + (e && e.message ? e.message : e);
        console.error('[launchApp] failed:', e);
        pendingLaunchFail = null;
        if (createdWine) {
          const orphan = createdWine;
          createdWine = null;
          try { orphan.stop(); } catch (_) {}
        }
        bootDone();
        document.getElementById('status').textContent = msg;
        showCrashReport({ kind: 'launch', app: sel, error: e });
        if (log) {
          log.textContent += msg + '\n';
          log.scrollTop = log.scrollHeight;
        }
      };
      pendingLaunchFail = failLaunch;

      const canvas = document.getElementById('screen');
      const size = screenCanvasSize();
      canvas.width = size.w;
      canvas.height = size.h;

      const log = document.getElementById('log');
      log.textContent += `Launching ${sel}.exe...\n`;

      // Create shared renderer on first launch
      if (!sharedRenderer) {
        sharedRenderer = new Win98Renderer(canvas);
        if (!DEBUG_MODE) sharedRenderer.transparentDesktop = true;
        sharedRenderer.singleAppMode = SINGLE_APP();
      }

      // A LAN-capable app asks who else is out there before it boots. The
      // wire and the room address have to be in place before init(), because
      // host imports capture them at instantiate time and the guest may bind
      // a socket on its first slice.
      //
      // This runs before the same-app cleanup below because its answer decides
      // whether that cleanup should happen at all: "both players here" is a
      // second copy of the very app being relaunched.
      let lanLink = null;
      if (app.lan && window.VlanLobby) {
        try {
          lanLink = await VlanLobby.showLobby({
            exe: app.lan.exe || sel,
            label: app.lan.label || sel,
            localPlay: app.lan.local !== false,
            hint: app.lan.hint,
          });
        } catch (e) {
          console.error('[lan] lobby failed:', e);
        }
        if (lanLink === null) {
          log.textContent += `Launch of ${sel} cancelled.\n`;
          bootDone();
          return;
        }
        if (lanLink && lanLink.local) lanLink = joinPageSegment();
        if (lanLink && lanLink.wire) {
          const who = lanLink.peer && lanLink.peer.name
            ? `connected to ${lanLink.peer.name}`
            : 'on this tab’s own segment';
          log.textContent += `LAN: ${who} — you are ${lanLink.address}\n`;
        }
      }

      // The CLI harness creates a fresh renderer for every run. The browser
      // intentionally shares one renderer so multiple apps can coexist, but
      // relaunching the same app must not leave stale back-canvases or old
      // wasm bindings around; those make the web view disagree with CLI PNGs.
      // A local LAN launch is the one case where two copies of one app are
      // the point, so it keeps whatever is already running.
      if (!(lanLink && lanLink.local)) {
        for (let i = runningApps.length - 1; i >= 0; i--) {
          const running = runningApps[i];
          if (!running || running.name !== sel) continue;
          stopRunningApp(running, false);
        }
      }
      sharedRenderer.repaint();

      wine = new WineAssembly();
      createdWine = wine;
      wine.asyncMultimediaTimer = !!app.asyncMultimediaTimer;
      const windowlessGraceMs = Number(app.windowlessGraceMs);
      if (Number.isFinite(windowlessGraceMs) && windowlessGraceMs >= 0) {
        wine.windowlessGraceMs = windowlessGraceMs;
      }
      wine.onStopped = stoppedWine => {
        stopBrowserOverlay(stoppedWine);
        unregisterRunningApp(stoppedWine);
      };
      wine.onFatal = crash => showCrashReport({
        kind: 'runtime', app: sel,
        error: crash && crash.error,
        state: crash && crash.state,
        tag: crash && crash.tag,
      });
      wine._sharedMixer = sharedAudioMixer;
      wine.primeAudio();
      wine.renderer = sharedRenderer;  // set before init so it won't create a new one
      wine._multiApp = true;
      if (lanLink && lanLink.wire) wine.joinVlan(lanLink.wire, lanLink.address);
      await wine.init(canvas);

      // Set unique hwnd range for this app
      const appIndex = nextAppIndex++;
      const hwndBase = 0x10001 + appIndex * 0x10000;
      wine._hwndBase = hwndBase;
      if (wine.hasGuestExport('set_hwnd_base')) {
        await wine.callGuest('set_hwnd_base', hwndBase);
      }

      window.browserInput.wireCanvasInput(canvas, sharedRenderer, {
        runningApps,
        debugMode: DEBUG_MODE,
      });
      canvas.focus();

      // An imported app (docs/design-byo-media.md phase ④) has no URL to
      // fetch: its exe lives inside a zip, on a mounted ISO, or in a File the
      // visitor dropped a moment ago. So a dynamic entry brings its own
      // container mounts, applied to this guest's VFS before the PE loader
      // runs, and resolves its bytes out of the result. Everything after this
      // -- DLL graph, run slice, persistence -- is the registered-app path
      // unchanged, which is the whole point of synthesizing a registry entry
      // rather than writing a second launcher.
      let dynamicExeBytes = null;
      if (app.localFileManifest && !app._localFilesResolved) {
        document.getElementById('status').textContent = 'Reading local media...';
        const manifestUrl = new URL(app.localFileManifest, location.href);
        const response = await fetch(manifestUrl);
        if (!response.ok) {
          throw new Error(`${sel}: local media is not prepared (${response.status})`);
        }
        const local = await response.json();
        if (!local || local.schemaVersion !== 1 || !Array.isArray(local.files)) {
          throw new Error(`${sel}: invalid local media manifest`);
        }
        const resolved = local.files.map(file => ({
          ...file,
          url: new URL(file.url, manifestUrl).href,
        }));
        app.files = [...(app.files || []), ...resolved];
        app._localFilesResolved = true;
        if (app.cdAudio && !app.cdAudio.trackSizes) {
          app.cdAudio.trackSizes = local.trackSizes || {};
        }
      }
      if (app.mounts && app.mounts.length) {
        const vfs = wine._helpCtx && wine._helpCtx.vfs;
        if (!vfs) throw new Error(`${sel}: the guest has no VFS to mount media into`);
        document.getElementById('status').textContent = 'Mounting media...';
        for (const mount of app.mounts) {
          const info = await mount(vfs, wine).catch(e => { failLaunch(e); throw e; });
          if (info && info.root) log.textContent += `Mounted ${info.root}\n`;
        }
      }
      if (app.workingDirectory) {
        const vfs = wine._helpCtx && wine._helpCtx.vfs;
        if (!vfs || typeof vfs.setCurrentDirectory !== 'function' ||
            !vfs.setCurrentDirectory(app.workingDirectory)) {
          throw new Error(`${sel}: working directory ${app.workingDirectory} is not mounted`);
        }
        // The guest ABI still reports every main image as C:\<basename> (see
        // $module_file_name and VfsSeed.seedExeImage). An imported installer
        // consequently constructs absolute C:\ paths for files beside an EXE
        // that actually came from D:\ or a mounted ZIP directory. Mirror only
        // the directory's immediate files, lazily and without overwriting C:
        // state, so sidecars follow the same reported path as the image.
        if (app.mirrorWorkingDirectoryToC && vfs.files instanceof Map) {
          const sourceDir = vfs._normPath(app.workingDirectory).replace(/\\$/, '');
          const prefix = sourceDir + '\\';
          for (const [path] of [...vfs.files]) {
            if (!path.startsWith(prefix)) continue;
            const leaf = path.slice(prefix.length);
            if (!leaf || leaf.includes('\\')) continue;
            const alias = 'c:\\' + leaf;
            if (!vfs.files.has(alias)) vfs.copyFile(path, alias, false);
          }
        }
      }
      // Writable C: state belongs above the immutable import mount and any
      // C: aliases made for an imported executable. Attach only after both
      // exist: otherwise the alias copies themselves look like guest writes,
      // and every checkpoint retries synchronous reads from their lazy media
      // providers. Hydration still happens before resolving the EXE, so an
      // installed replacement wins and a recorded deletion stays deleted.
      // Kept imports use OPFS; session imports keep the same journal only for
      // this page. Both are periodically flushed once the guest starts.
      await attachDynamicOverlay(wine, app, sel);
      // Registered retail/local fixtures can describe a Redump-style CUE
      // without forcing hundreds of megabytes of music through loadFiles().
      // Fetch the tiny table of contents now; each raw audio BIN remains a
      // promise owned by CdRom and is fetched only when MCI plays that track.
      if (app.cdAudio) {
        const vfs = wine._helpCtx && wine._helpCtx.vfs;
        if (!vfs || typeof CdRom === 'undefined') {
          throw new Error(`${sel}: CD audio support is not loaded`);
        }
        const config = app.cdAudio;
        const cueUrl = new URL(config.cue, location.href);
        const response = await fetch(cueUrl);
        if (!response.ok) throw new Error(`${sel}: failed to load ${config.cue} (${response.status})`);
        const cueText = await response.text();
        const sizes = config.trackSizes || {};
        const foldedSizes = new Map(Object.entries(sizes).map(([name, size]) =>
          [String(name).replace(/\\/g, '/').toLowerCase(), size]));
        const disc = CdRom.mountCue(vfs, cueText, {
          drive: config.drive || 'D',
          volumeLabel: config.volumeLabel,
          trackSize: name => foldedSizes.get(String(name).replace(/\\/g, '/').toLowerCase()),
          loadTrack: name => WineAssembly.fetchAssetBytes(new URL(name, cueUrl).href),
        });
        log.textContent += `Mounted ${disc.root} CD audio (${disc.tracks.length} tracks)\n`;
      }
      if (app.exeBytes) {
        const vfs = wine._helpCtx && wine._helpCtx.vfs;
        dynamicExeBytes = typeof app.exeBytes === 'function'
          ? await app.exeBytes(vfs, wine).catch(e => { failLaunch(e); throw e; })
          : app.exeBytes;
      }

      document.getElementById('status').textContent = 'Loading PE...';

      const ok = await wine.loadExe(app.exe, {
        win16Modules: app.win16Modules,
        launchPrefs: app.launchPrefs,
        args: app.args,
        bytes: dynamicExeBytes,
      });
      if (ok) {
        for (const [name, value] of Object.entries(app.environment || {})) {
          if (wine.guestWorker) {
            const nameBytes = new TextEncoder().encode(name);
            const valueBytes = new TextEncoder().encode(String(value));
            const staging = (await wine.callGuest('get_staging')) >>> 0;
            const capacity = (await wine.callGuest('get_staging_size')) >>> 0;
            const needed = nameBytes.length + valueBytes.length + 2;
            if (!staging || needed > capacity) {
              throw new Error(`${sel}: environment value ${name} exceeds guest staging`);
            }
            const memory = new Uint8Array(wine.memory.buffer);
            const valueAt = staging + nameBytes.length + 1;
            memory.set(nameBytes, staging);
            memory[staging + nameBytes.length] = 0;
            memory.set(valueBytes, valueAt);
            memory[valueAt + valueBytes.length] = 0;
            if (!(await wine.callGuest('set_process_environment_a', staging, valueAt))) {
              throw new Error(`${sel}: failed to set guest environment value ${name}`);
            }
          } else if (!window.processBoot.setEnvironmentVariable(
            wine.instance.exports, wine.memory.buffer, name, value)) {
            throw new Error(`${sel}: failed to set guest environment value ${name}`);
          }
        }
        if (wine.configurePerf) await wine.configurePerf(app.perf || null);
        if (app.files && app.files.length) {
          document.getElementById('status').textContent = 'Loading data files...';
          log.textContent += `Loading ${app.files.length} data file(s)...\n`;
          const progressStride = Math.max(1, Math.ceil(app.files.length / 20));
          await wine.loadFiles(app.files, {
            required: !!app.requiredFiles,
            concurrency: app.fileConcurrency || 6,
            onProgress: ({ loaded, failed, total }) => {
              const done = loaded + failed;
              if (done === total || done === 1 || done % progressStride === 0) {
                const msg = `Loading data files ${done}/${total}${failed ? ` (${failed} failed)` : ''}`;
                document.getElementById('status').textContent = msg;
                log.textContent += msg + '\n';
                log.scrollTop = log.scrollHeight;
              }
            },
          }).catch(e => { failLaunch(e); throw e; });
          log.textContent += `Data files ready: ${app.files.length}\n`;
          log.scrollTop = log.scrollHeight;
        }
        if (app.persistFiles && window.VfsPersistence && wine._helpCtx && wine._helpCtx.vfs) {
          wine._vfsPersistence = window.VfsPersistence.attach(wine._helpCtx.vfs, {
            appId: sel,
            patterns: app.persistFiles,
            log: message => { log.textContent += message + '\n'; },
          });
          if (wine._vfsPersistence.restored) {
            log.textContent += `Restored ${wine._vfsPersistence.restored} saved file(s)\n`;
          }
        }
        if (app.winver && wine.hasGuestExport('set_winver')) {
          if (wine.threadManager && wine.threadManager.recordInheritedWasmGlobal) {
            wine.threadManager.recordInheritedWasmGlobal('set_winver', app.winver);
          }
          await wine.callGuest('set_winver', app.winver);
        }
        // COPY_RUN remains rollback-gated. A title opts in explicitly so its
        // exact recognizers are enabled before their first block is decoded.
        if (app.copySuperops && wine.hasGuestExport('set_loop_copy_emit')) {
          if (wine.threadManager && wine.threadManager.recordInheritedWasmGlobal) {
            wine.threadManager.recordInheritedWasmGlobal('set_loop_copy_emit', 1);
          }
          await wine.callGuest('set_loop_copy_emit', 1);
        }
        if (app.args) {
          wine._extraArgs = app.args;
          if (wine.guestWorker) {
            const bytes = new TextEncoder().encode(app.args);
            const staging = await wine.callGuest('get_staging');
            new Uint8Array(wine.memory.buffer).set(bytes, staging);
            await wine.callGuest('set_extra_cmdline', staging, bytes.length);
          } else {
            window.processBoot.setExtraCmdline(
              wine.instance.exports, wine.memory.buffer, app.args);
          }
        }
        // One list, shared with the CLI (lib/dll-registry.js), and one graph
        // walk (lib/process-boot.js). Both used to exist twice: this page knew
        // a 14-entry URL map and resolved only the EXE's own imports, so an app
        // needing SHELL32 — or the Kodak OI*400 set, which imports itself two
        // levels deep — booted headless and trapped here on the first
        // cross-DLL ordinal.
        const availableDlls = { ...window.dllRegistry.DLL_PATHS };
        wine._availableDllFiles = new Set(Object.keys(availableDlls));
        // App-local DLLs ship beside their exe, so a dependency named by
        // another DLL is looked up in this app's own `files` list too.
        // A files entry is either a URL or { url, vfsPath }.
        const appFileByName = new Map();
        for (const f of (app.files || [])) {
          const url = typeof f === 'string' ? f : (f && f.url);
          if (url) appFileByName.set(url.split('/').pop().toLowerCase(), url);
        }
        const mountedExeDir = /^[a-z]:[\\\/]/i.test(app.exe)
          ? app.exe.toLowerCase().replace(/\//g, '\\').replace(/\\[^\\]*$/, '')
          : null;
        const fetchDll = async (spec) => {
          const name = spec.split(/[\\/]/).pop();
          const url = spec.includes('/') ? spec
            : (availableDlls[name.toLowerCase()] || appFileByName.get(name.toLowerCase()));
          // A BYOM executable and its private DLLs already share a mounted
          // folder; they deliberately have no server URL or app.files entry.
          // Resolve that sibling before giving up, and materialize lazy ISO/
          // ZIP entries because the PE loader consumes the complete image.
          if (!url && mountedExeDir) {
            const vfs = wine._helpCtx && wine._helpCtx.vfs;
            const mountedPath = mountedExeDir + '\\' + name.toLowerCase();
            if (vfs && vfs.files.has(mountedPath)) {
              // Preserve where an app-local module actually lives. The PE
              // loader records this path for GetModuleFileName(hModule), and
              // old plug-in hosts use that answer to enumerate sibling files.
              // Retail Storm.dll, for example, derives
              // C:\Diablo\*.snp from its own module path; reporting the old
              // compatibility alias C:\storm.dll hides standard.snp and
              // makes single-player initialization fail after hero naming.
              return { name, path: mountedPath, bytes: await vfs.materialize(mountedPath) };
            }
          }
          if (!url) return null;
          const resp = await fetch(url);
          if (!resp.ok) { console.error('Failed to fetch DLL:', url); return null; }
          return { name, bytes: new Uint8Array(await resp.arrayBuffer()) };
        };
        const dllsToLoad = await window.processBoot.resolveDllGraph({
          exeBytes: wine._exeBytes,
          seeds: app.dlls || [],
          detectRequiredDlls: DllLoader && DllLoader.detectRequiredDlls,
          loadSpec: fetchDll,
          onLog: (msg) => { log.textContent += msg + '\n'; },
        });
        // The CLI reports NT to any app that pulls in MFC42U — the unicode MFC
        // never shipped on 9x, and an app that finds Win98 under it takes a
        // different path. The page only honoured an explicit `winver` in the
        // registry, so a second NT app added there would have diverged silently.
        if (!app.winver && wine.hasGuestExport('set_winver') &&
            DllLoader && DllLoader.shouldReportNtForDlls &&
            DllLoader.shouldReportNtForDlls(dllsToLoad.map(d => d.name))) {
          const winver = 0x05650004;
          if (wine.threadManager && wine.threadManager.recordInheritedWasmGlobal) {
            wine.threadManager.recordInheritedWasmGlobal('set_winver', winver);
          }
          await wine.callGuest('set_winver', winver);
          log.textContent += 'Windows version: NT 4 (auto for MFC42U)\n';
        }
        if (dllsToLoad.length) {
          document.getElementById('status').textContent = 'Loading DLLs...';
          log.textContent += `Loading ${dllsToLoad.length} DLL(s)...\n`;
        }
        await wine.loadDlls(dllsToLoad).catch(e => { failLaunch(e); throw e; });
        log.textContent += 'DLLs ready\n';
        const runSliceAppKey = app.runSliceAppKey || sel;
        wine._runSliceAppKey = runSliceAppKey;
        const exeLeaf = String(app.exe || '').split(/[\\/]/).pop().toLowerCase();
        const profileExclusiveCrop = (typeof appProfiles !== 'undefined' &&
          appProfiles.EXCLUSIVE_CROPS) ? appProfiles.EXCLUSIVE_CROPS[exeLeaf] : null;
        runningApps.push({ wine, name: sel, appIndex, runSliceAppKey,
          relativeMouse: app.relativeMouse === true,
          mobileTouch: app.mobileTouch || 'auto',
          mobileCrop: app.mobileCrop || null,
          exclusiveCrop: app.exclusiveCrop || profileExclusiveCrop || null,
          keepAspect: app.keepAspect === true,
          touchControls: app.touchControls || null });
        syncTouchControls();
        // Registered, so it has an owner that can stop it; a later failure
        // must not tear down an app the visitor can see.
        createdWine = null;
        onAppRunningChange(true);
        document.getElementById('status').textContent = `Running ${runningApps.length} app(s)`;
        if (typeof window.updateThreadsStatus === 'function') window.updateThreadsStatus();
        canvas.focus();
        // guestWorker is final here: init() has either established the Worker
        // backend or fallen back. Never give the cooperative fallback Jazz's
        // Worker-sized quantum.
        const runSlice = selectedRunSlice(runSliceAppKey, !!wine.guestWorker);
        const rendererSlices = app.rendererRunSlices;
        if (rendererSlices && Number.isFinite(rendererSlices.software) &&
            Number.isFinite(rendererSlices.opengl)) {
          const applyRendererSlice = (renderer) => {
            const next = renderer === 'opengl'
              ? rendererSlices.opengl : rendererSlices.software;
            if (wine.stepsPerSlice === next) return;
            wine.stepsPerSlice = next;
            log.textContent += `Renderer run slice=${next} (${renderer})\n`;
            log.scrollTop = log.scrollHeight;
          };
          wine.onOpenGLContextCountChange = count => {
            if (count === 0) applyRendererSlice('software');
          };
          wine.onGuestFrame = frame => {
            if (frame && frame.kind === 'gpu') applyRendererSlice('opengl');
            else if (frame && frame.kind === 'directdraw') applyRendererSlice('software');
          };
          wine.onRegistryValueChanged = change => {
            if (!change || String(change.name).toLowerCase() !== 'enginetype' ||
                !/\\software\\valve\\hldemo\\settings$/i.test(String(change.path))) return;
            // Selecting Software writes EngineType before GoldSrc tears down
            // the old renderer and reconstructs the Video Modes UI. Dropping
            // to the 1k CPU-renderer quantum here makes that restart crawl and
            // leaves several partially painted dialogs visible long enough for
            // repeated clicks to queue another restart. Keep the 10k setup
            // quantum until an actual DirectDraw frame proves Software is
            // running; the onGuestFrame hook above performs that handoff. The
            // OpenGL write can raise the budget immediately so its restart is
            // fed without waiting for the first GPU present.
            if (Number(change.data) === 2) applyRendererSlice('opengl');
          };
        }
        log.textContent += `Starting run slice=${runSlice}\n`;
        log.scrollTop = log.scrollHeight;
        wine.run(runSlice);
        scheduleStartupDialogDismiss(app, wine);
        scheduleStartupInput(app, wine);
        maximizeForSingleApp(wine);
        releaseBootCursorOnFirstWindow(wine, bootDone);
      } else {
        bootDone();
        document.getElementById('status').textContent = 'Failed to load';
      }
    }

    // ShellExecute("wordpad.exe") — a guest asking the shell to start another
    // program. WRITE.EXE is nothing but that call, and several Win98 apps
    // hand off to a sibling the same way, so the exe name has to resolve
    // against the same registry the desktop icons read. Match the app key
    // first ("wordpad"), then any registered app whose exe basename matches
    // ("mspaint.exe" -> mspaint98 if that is how it is registered).
    function appKeyForExe(fileName) {
      const base = String(fileName || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (!base) return null;
      const stem = base.endsWith('.exe') ? base.slice(0, -4) : base;
      if (apps[stem]) return stem;
      for (const key of Object.keys(apps)) {
        const exe = String((apps[key] || {}).exe || '')
          .replace(/\\/g, '/').split('/').pop().toLowerCase();
        if (exe && (exe === base || exe === stem + '.exe')) return key;
      }
      return null;
    }

    // Launch by exe name. Returns true when the name resolved — the launch
    // itself is async and the caller (a synchronous host import) cannot wait
    // for it. In single-app mode the launcher process is usually still in
    // runningApps at this instant (write.exe calls ShellExecute and only then
    // returns into ExitProcess), so hold the launch until the list drains
    // instead of letting launchApp decline it.
    function launchExe(fileName) {
      const key = appKeyForExe(fileName);
      if (!key) {
        appendDebugLog(`[ShellExecute] no registered app for "${fileName}"`);
        return false;
      }
      if (launchInFlight || (SINGLE_APP() && runningApps.length)) {
        queuePendingLaunch(key, SINGLE_APP());
        return true;
      }
      api.launchApp(key);
      return true;
    }

    // ShellExecute("C:\Diablo\diablo.exe") — a guest naming a program that
    // exists only in its own VFS, the way the Diablo CD launcher hands off to
    // the game its installer wrote a moment earlier. No registered app can
    // answer that, and the new process must see the SAME filesystem, so the
    // caller's VFS is adopted wholesale into the fresh instance the launch
    // creates. `workDir` is ShellExecute's lpDirectory; the exe's own
    // directory is the Win98 default when the caller passed none.
    function launchVfsExe(fileName, callerWine, workDir, args) {
      // DX2-era installers commonly offer to replace video/audio drivers even
      // after setup has completed. Wine-Assembly exposes the newer DirectX 7
      // runtime and advertises it in HKLM, so accept the obsolete redistributable
      // as an already-satisfied launch instead of booting a driver installer.
      if (/(?:^|[\\/])dxsetup\.exe$/i.test(String(fileName || ''))) {
        appendDebugLog(`[ShellExecute] skipped obsolete DirectX setup "${fileName}"`);
        // War Wind makes that offer from its final completion dialog. Its
        // 16-bit bootstrap cannot observe the separately emulated installer
        // child exiting, so it otherwise resurfaces its old 39% progress
        // window forever. The installed game is already complete at this
        // point; hand it the same VFS after the synchronous WinExec returns.
        const installerVfs = callerWine && callerWine._helpCtx && callerWine._helpCtx.vfs;
        const warWindExe = 'c:\\program files\\warwind\\ww.exe';
        if (installerVfs && installerVfs.files instanceof Map &&
            installerVfs.files.has(warWindExe)) {
          queueMicrotask(() => {
            appendDebugLog('[ShellExecute] starting installed War Wind after setup');
            launchVfsExe(warWindExe, callerWine, 'C:\\Program Files\\WarWind\\', '');
          });
        }
        return true;
      }
      const callerVfs = callerWine && callerWine._helpCtx && callerWine._helpCtx.vfs;
      const vfs = callerVfs || lastExitedVfs;
      if (!vfs || typeof vfs._normPath !== 'function' || !(vfs.files instanceof Map)) return false;
      const candidate = workDir && workDir.trim() && !/^[a-z]:[\\/]/i.test(fileName)
        ? workDir.replace(/[\\/]$/, '') + '\\' + fileName
        : fileName;
      const norm = typeof vfs._resolvePath === 'function'
        ? vfs._resolvePath(candidate)
        : vfs._normPath(candidate);
      if (!vfs.files.has(norm)) return false;
      const base = norm.split('\\').pop();
      const key = 'vfs:' + norm;
      const cwd = (workDir && workDir.trim())
        || norm.replace(/\\[^\\]*$/, '') + '\\';
      const snapshot = snapshotVfs(vfs);
      // An installed child is still the same workload as the mounted app
      // that spawned it. Preserve that Auto run-slice identity through
      // wrapper -> localized installer -> game handoffs; otherwise Speed
      // Demons drops from 500k to the generic 100k and shows a long black
      // transition between its logo and menu.
      const runSliceAppKey = (callerWine && callerWine._runSliceAppKey)
        || (!callerVfs ? lastExitedRunSliceAppKey : null);
      // Always a fresh entry: the closure holds the *calling* process's VFS,
      // and a second chain-launch in a later session has a different one.
      apps[key] = {
        exe: norm,
        dynamic: true,
        badge: 'session',
        label: base.replace(/\.exe$/i, ''),
        runSliceAppKey,
        // Installed children inherit timing semantics from the disc/setup
        // workload that produced them. Diablo's Storm provider, for example,
        // cannot finish SNet initialization without its timeSetEvent callback.
        asyncMultimediaTimer: !!(callerWine && callerWine.asyncMultimediaTimer),
        args: args && args.trim() ? args : undefined,
        mounts: [async (newVfs) => {
          newVfs.adoptFrom(snapshot);
          if (cwd) newVfs.cwd = /\\$/.test(cwd) ? cwd : cwd + '\\';
          // `root` becomes the shell's "Mounted <root>" line; this mount is
          // an inherited filesystem, not a disc, so say that.
          return { root: `caller's filesystem (${snapshot.files.size} entries)` };
        }],
        exeBytes: async (newVfs) => newVfs.materialize(norm),
      };
      if (launchInFlight || (SINGLE_APP() && runningApps.length)) {
        queuePendingLaunch(key, SINGLE_APP());
        return true;
      }
      api.launchApp(key);
      return true;
    }

    // `wine` and `sharedRenderer` are reassigned on every launch, so they are
    // published as live views rather than copied out once. launchExe goes
    // through `api.launchApp` rather than the local binding so a caller that
    // replaces launchApp (tests, a future single-app policy) is honoured.
    const api = {
      runningApps,
      appKeyForExe,
      launchExe,
      launchVfsExe,
      sharedAudioMixer,
      get currentWine() { return wine; },
      get renderer() { return sharedRenderer; },
      launchApp,
      stopRunningApp,
      stopAllApps,
      unregisterRunningApp,
      joinPageSegment,
      selectedRunSlice,
      applyRunSlice,
      singleApp: SINGLE_APP,
      maximizeForSingleApp,
      firstTopLevelWindow: wine => firstTopLevelWindow(sharedRenderer, wine),
      bootTicket,
      releaseBootCursorOnFirstWindow,
      get bootsInFlight() { return bootsInFlight; },
      scheduleStartupDialogDismiss,
      scheduleStartupInput,
    };
    return api;
  }

  const browserShell = {
    createBrowserShell,
    firstTopLevelWindow,
    crashReportText,
    showCrashReport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = browserShell;
  if (typeof window !== 'undefined') window.browserShell = browserShell;
})();
