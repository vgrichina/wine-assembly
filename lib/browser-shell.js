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
    const runningApps = [];  // array of { wine, name, appIndex }
    let nextAppIndex = 0;
    let sharedRenderer = null;
    const sharedAudioMixer = {};

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

    function unregisterRunningApp(wine) {
      const index = runningApps.findIndex(running => running && running.wine === wine);
      if (index >= 0) runningApps.splice(index, 1);
      const status = document.getElementById('status');
      if (status) status.textContent = runningApps.length
        ? `Running ${runningApps.length} app(s)`
        : 'Ready';
      onAppRunningChange(runningApps.length > 0);
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
      if (sharedRenderer) {
        sharedRenderer.windows = {};
        sharedRenderer.repaint();
      }
      onStopAll();
      onAppRunningChange(false);
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
          const alreadyFull = win.x <= 0 && win.y <= 0 &&
            win.w >= sharedRenderer.canvas.width && win.h >= sharedRenderer.canvas.height;
          if (resizable && !alreadyFull) {
            // WM_SYSCOMMAND / SC_MAXIMIZE. It goes to the app's own wndproc
            // first, so an app that tracks its own maximized state sees the
            // command rather than just a surprise WM_SIZE.
            e.send_message(win.hwnd | 0, 0x0112, 0xF030, 0);
          }
          appendDebugLog(`Single-app mode: ${resizable ? 'maximized' : 'zoomed'} ` +
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

    function autoRunSliceFor(appKey, compatDispatch) {
      switch (appKey) {
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

    function selectedRunSlice(appKey) {
      const compatDispatch = !hasWasmTailCalls();
      const autoSlice = autoRunSliceFor(appKey, compatDispatch);
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
        app.wine.stepsPerSlice = selectedRunSlice(app.name);
        applied.push(`${app.name}:${app.wine.stepsPerSlice}`);
      }
      if (applied.length) {
        appendDebugLog(`Run slice updated: ${applied.join(', ')}`);
      }
    }
    function scheduleStartupDialogDismiss(app, wine) {
      const pending = app && (app.dismissStartupDialogs || app.dismissStartupDialog);
      const configs = Array.isArray(pending) ? pending.slice() : (pending ? [pending] : []);
      if (!configs.length || !wine || !wine.instance || !wine.instance.exports || !sharedRenderer) return;
      const e = wine.instance.exports;
      if (!e.send_message) return;
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
          e.send_message(dlg.hwnd | 0, 0x0111, cfg.command || 1, 0);
          configs.splice(idx, 1);
          if (!configs.length) clearInterval(timer);
        } else if (!stillRunning || tries >= maxTries) {
          clearInterval(timer);
        }
      }, intervalMs);
    }

    async function launchApp(appKey) {
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
      const failLaunch = (e) => {
        const log = document.getElementById('log');
        const msg = 'ERROR launching ' + sel + ': ' + (e && e.message ? e.message : e);
        console.error('[launchApp] failed:', e);
        bootDone();
        document.getElementById('status').textContent = msg;
        if (log) {
          log.textContent += msg + '\n';
          log.scrollTop = log.scrollHeight;
        }
      };

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
      wine.asyncMultimediaTimer = !!app.asyncMultimediaTimer;
      wine.onStopped = unregisterRunningApp;
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
      if (wine.instance.exports.set_hwnd_base) {
        wine.instance.exports.set_hwnd_base(hwndBase);
      }

      window.browserInput.wireCanvasInput(canvas, sharedRenderer, {
        runningApps,
        debugMode: DEBUG_MODE,
      });
      canvas.focus();

      document.getElementById('status').textContent = 'Loading PE...';

      const ok = await wine.loadExe(app.exe, {
        win16Modules: app.win16Modules,
        launchPrefs: app.launchPrefs,
      });
      if (ok) {
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
        if (app.winver && wine.instance.exports.set_winver) {
          wine.instance.exports.set_winver(app.winver);
        }
        if (app.args) {
          wine._extraArgs = app.args;
          window.processBoot.setExtraCmdline(
            wine.instance.exports, wine.memory.buffer, app.args);
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
        const fetchDll = async (spec) => {
          const name = spec.split('/').pop();
          const url = spec.includes('/') ? spec
            : (availableDlls[name.toLowerCase()] || appFileByName.get(name.toLowerCase()));
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
        if (!app.winver && wine.instance.exports.set_winver &&
            DllLoader && DllLoader.shouldReportNtForDlls &&
            DllLoader.shouldReportNtForDlls(dllsToLoad.map(d => d.name))) {
          wine.instance.exports.set_winver(0x05650004);
          log.textContent += 'Windows version: NT 4 (auto for MFC42U)\n';
        }
        if (dllsToLoad.length) {
          document.getElementById('status').textContent = 'Loading DLLs...';
          log.textContent += `Loading ${dllsToLoad.length} DLL(s)...\n`;
        }
        await wine.loadDlls(dllsToLoad).catch(e => { failLaunch(e); throw e; });
        log.textContent += 'DLLs ready\n';
        runningApps.push({ wine, name: sel, appIndex });
        onAppRunningChange(true);
        document.getElementById('status').textContent = `Running ${runningApps.length} app(s)`;
        canvas.focus();
        const runSlice = selectedRunSlice(sel);
        log.textContent += `Starting run slice=${runSlice}\n`;
        log.scrollTop = log.scrollHeight;
        wine.run(runSlice);
        scheduleStartupDialogDismiss(app, wine);
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
      if (SINGLE_APP() && runningApps.length) {
        let waited = 0;
        const tick = setInterval(() => {
          if (!runningApps.length) { clearInterval(tick); api.launchApp(key); return; }
          if ((waited += 100) >= 10000) {
            clearInterval(tick);
            appendDebugLog(`[ShellExecute] gave up waiting to launch ${key}`);
          }
        }, 100);
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
    };
    return api;
  }

  const browserShell = { createBrowserShell, firstTopLevelWindow };
  if (typeof module !== 'undefined' && module.exports) module.exports = browserShell;
  if (typeof window !== 'undefined') window.browserShell = browserShell;
})();
