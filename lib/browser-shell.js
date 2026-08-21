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
      if (typeof window.updateThreadsStatus === 'function') window.updateThreadsStatus();
    }

    function stopRunningApp(running, repaint) {
      if (!running || !running.wine) return;
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
      if (!configs.length || !wine || !sharedRenderer ||
          !wine.hasGuestExport || !wine.hasGuestExport('send_message')) return;
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
          Promise.resolve(wine.callGuest(
            'send_message', dlg.hwnd | 0, 0x0111, cfg.command || 1, 0)).catch(() => {});
          configs.splice(idx, 1);
          if (!configs.length) clearInterval(timer);
        } else if (!stillRunning || tries >= maxTries) {
          clearInterval(timer);
        }
      }, intervalMs);
    }

    async function launchApp() {
      const sel = document.getElementById('app-select').value;
      const app = apps[sel];
      if (!app) return;
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
      if (wine.hasGuestExport('set_hwnd_base')) {
        await wine.callGuest('set_hwnd_base', hwndBase);
      }

      window.browserInput.wireCanvasInput(canvas, sharedRenderer, {
        runningApps,
        debugMode: DEBUG_MODE,
      });
      canvas.focus();

      document.getElementById('status').textContent = 'Loading PE...';

      const ok = await wine.loadExe(app.exe, { win16Modules: app.win16Modules });
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
        if (app.winver && wine.hasGuestExport('set_winver')) {
          await wine.callGuest('set_winver', app.winver);
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
        if (!app.winver && wine.hasGuestExport('set_winver') &&
            DllLoader && DllLoader.shouldReportNtForDlls &&
            DllLoader.shouldReportNtForDlls(dllsToLoad.map(d => d.name))) {
          await wine.callGuest('set_winver', 0x05650004);
          log.textContent += 'Windows version: NT 4 (auto for MFC42U)\n';
        }
        if (dllsToLoad.length) {
          document.getElementById('status').textContent = 'Loading DLLs...';
          log.textContent += `Loading ${dllsToLoad.length} DLL(s)...\n`;
        }
        await wine.loadDlls(dllsToLoad).catch(e => { failLaunch(e); throw e; });
        log.textContent += 'DLLs ready\n';
        runningApps.push({ wine, name: sel, appIndex });
        document.getElementById('status').textContent = `Running ${runningApps.length} app(s)`;
        if (typeof window.updateThreadsStatus === 'function') window.updateThreadsStatus();
        canvas.focus();
        const runSlice = selectedRunSlice(sel);
        log.textContent += `Starting run slice=${runSlice}\n`;
        log.scrollTop = log.scrollHeight;
        wine.run(runSlice);
        scheduleStartupDialogDismiss(app, wine);
      } else {
        document.getElementById('status').textContent = 'Failed to load';
      }
    }

    // `wine` and `sharedRenderer` are reassigned on every launch, so they are
    // published as live views rather than copied out once.
    return {
      runningApps,
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
      scheduleStartupDialogDismiss,
    };
  }

  const browserShell = { createBrowserShell };
  if (typeof module !== 'undefined' && module.exports) module.exports = browserShell;
  if (typeof window !== 'undefined') window.browserShell = browserShell;
})();
