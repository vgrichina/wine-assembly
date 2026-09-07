// Drop anything on the desktop, sniff it, ask one question.
//
// The visible half of phase ④ (docs/design-byo-media.md). lib/media-import.js
// decides what a file is and how to mount it; this file is the desktop
// affordance, the insert dialog, the My Media shelf, and the desktop icons the
// imports leave behind. Once a guest window registers with DragAcceptFiles,
// this same listener instead becomes the Win98 Shell's WM_DROPFILES ingress.
//
// ---- why this is host-page DOM and not a guest window -------------------
//
// All of it has to work before any guest exists — importing a game is how you
// get a guest — so there is no wndproc to hang it on. It is drawn in the same
// Win98 skin the desktop and the LAN lobby (lib/vlan-lobby.js) already use,
// with the same trade the design's "integration realities" note calls out: a
// DOM panel is a second window manager, so it deliberately does NOT pretend to
// join guest z-order, focus or the taskbar. It is a modal overlay, visually
// outside the window metaphor, reachable while a guest runs.
//
// ---- the drop target and the canvas -------------------------------------
//
// The canvas overlays the desktop icons and covers the whole of #screen-wrap,
// so a drop handler on the icon grid alone would never fire. The listeners go
// on the wrap element in the CAPTURE phase and preventDefault() every
// dragover — without that last part the browser navigates away to the dropped
// file and the page is simply gone, which is the failure mode this costs one
// line to avoid. A drop while a guest owns the canvas first checks that
// window's WS_EX_ACCEPTFILES state. Registered windows receive WM_DROPFILES;
// otherwise the page-level import dialog remains the fallback.
//
// iOS has no drag-drop at all, so the same flow is reachable from a button
// over a hidden <input type=file> — Safari has no showOpenFilePicker, and the
// input accepts anything from Files/iCloud.
//
// ---- session vs kept, and saying which ----------------------------------
//
// "This session only" is the default because it is the honest one: nothing is
// copied, no quota is consumed, and the File reference lives exactly as long
// as the page does. The cost is that it is gone on reload, so a session import
// is badged (~) everywhere it appears and offers a one-click [keep] while its
// File is still alive. A kept import is badged (o) and reappears on the next
// visit — subject to eviction, which the library footer reports rather than
// papering over.

(function () {
  'use strict';

  const STYLE_ID = 'wa-media-styles';
  const styles = `
.wa-media-modal{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
  align-items:center;justify-content:center;z-index:10000;font:13px system-ui,sans-serif}
.wa-media-panel{background:#c0c0c0;border:2px outset #fff;min-width:340px;max-width:min(560px,94vw);
  max-height:92vh;overflow:auto;box-shadow:4px 4px 12px rgba(0,0,0,.4)}
.wa-media-title{background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:700;
  padding:4px 8px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.wa-media-title button{font:inherit;line-height:1;padding:0 6px;background:#c0c0c0;
  border:2px outset #fff;cursor:pointer}
.wa-media-body{padding:12px}
.wa-media-what{background:#fff;border:1px inset #808080;padding:8px;margin-bottom:10px;
  display:flex;gap:10px;align-items:flex-start}
.wa-media-glyph{font-size:26px;line-height:1}
.wa-media-what b{display:block}
.wa-media-dim{color:#444;font-size:12px}
.wa-media-choice{margin:8px 0}
.wa-media-choice label{display:block;padding:2px 0;cursor:pointer}
.wa-media-choice label.disabled{color:#808080;cursor:default}
.wa-media-exe{width:100%;font:inherit;margin-top:4px}
.wa-media-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.wa-media-modal button,.wa-media-shelf button{font:inherit;padding:4px 12px;background:#c0c0c0;
  border:2px outset #fff;cursor:pointer}
.wa-media-modal button:active{border-style:inset}
.wa-media-modal button:disabled{color:#808080;cursor:default}
.wa-media-status{min-height:1.2em;color:#000080;padding:4px 0}
.wa-media-err{color:#800;padding:4px 0}
.wa-media-progress{height:14px;border:1px inset #808080;background:#fff;margin:6px 0;display:none}
.wa-media-progress i{display:block;height:100%;background:#000080;width:0}
.wa-media-list{background:#fff;border:1px inset #808080;min-height:80px;max-height:40vh;
  overflow-y:auto;margin-bottom:8px}
.wa-media-row{padding:6px 8px;display:flex;gap:8px;align-items:center;
  border-bottom:1px solid #e0e0e0}
.wa-media-row:last-child{border-bottom:none}
.wa-media-row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wa-media-badge{font-family:ui-monospace,monospace;font-weight:700}
.wa-media-badge.kept{color:#006000}
.wa-media-badge.session{color:#805000}
.wa-media-empty{padding:16px;text-align:center;color:#666}
.wa-media-foot{font-size:11px;color:#333;border-top:1px solid #808080;padding-top:6px}
.wa-media-foot .warn{color:#800}
.wa-media-drop{position:absolute;inset:0;z-index:60;display:none;
  align-items:center;justify-content:center;background:rgba(0,0,64,.35);pointer-events:none}
.wa-media-drop.on{display:flex}
.wa-media-drop div{background:#c0c0c0;border:3px dashed #fff;padding:20px 28px;
  font:700 15px system-ui,sans-serif;color:#000080;text-align:center}
.wa-media-import-btn{position:absolute;left:8px;bottom:8px;z-index:55;font:12px system-ui,sans-serif;
  padding:4px 10px;background:#c0c0c0;border:2px outset #fff;cursor:pointer}
/* Desktop furniture: follow the desktop icons' visibility rules. A running
   single-app page and an exclusive-fullscreen surface both hide the desktop,
   so the affordance goes with it. */
body.single-app.app-running .wa-media-import-btn,
body.exclusive-fullscreen .wa-media-import-btn{display:none !important}
.desktop-icon.wa-session .icon-img{opacity:.75;outline:1px dashed rgba(255,255,255,.8)}
`;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = styles;
    document.head.appendChild(el);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  const GLYPH = { iso: '💿', cue: '💿', zip: '🗜️', exe: '🪟', unknown: '📄' };
  const BADGE = { kept: '(o)', session: '(~)' };

  function moduleOf(name, global) {
    if (typeof window !== 'undefined' && window[global]) return window[global];
    if (typeof require === 'function') { try { return require(name); } catch (_) { /* browser */ } }
    return null;
  }

  // ---- the controller -----------------------------------------------------

  function install(opts) {
    const options = opts || {};
    const doc = options.document || document;
    const dropTarget = options.dropTarget || doc.getElementById('screen-wrap');
    const iconGrid = options.desktopIcons || doc.getElementById('desktop-icons');
    const apps = options.apps || (window.wineApps && window.wineApps.APPS) || {};
    const shell = () => options.shell || window.wineShell;
    const log = options.appendLog || (() => {});
    const singleApp = typeof options.singleApp === 'function' ? options.singleApp : () => false;
    const mediaImport = moduleOf('./media-import', 'mediaImport');
    const mediaSniff = moduleOf('./media-sniff', 'mediaSniff');
    const libraryModule = moduleOf('./media-library', 'mediaLibrary');

    injectStyles();

    // Session imports live here and nowhere else: they are page state by
    // definition, and writing them anywhere durable would be the lie the
    // badge exists to prevent.
    const sessionItems = new Map();  // appId -> { plan, entry, file }
    const keptItems = new Map();     // appId -> { row, entry }
    let library = null;
    let libraryError = null;
    let persistState = null;

    // Each guest gets a fresh VFS, so inserting a disc for a game does not by
    // itself make that disc visible to a separately launched CD Player. Keep
    // the latest optical-media mount on the registered player entry as well.
    // The mount stays lazy: selecting a 600MB BIN retains its File/OPFS
    // provider, and CD-DA bytes are not read until MCI asks to play a track.
    function isOpticalMedia(value) {
      return !!value && (value.kind === 'cue' || value.kind === 'iso');
    }

    async function bindCdPlayer(value, mount) {
      const player = apps.cdplayer;
      if (!player || !isOpticalMedia(value) || typeof mount !== 'function') return false;
      player.mounts = [mount];
      player.mediaKind = value.kind;
      player.mediaName = value.name;
      player.mediaId = value.id || null;
      log(`[media] inserted "${value.name}" into CD Player`);

      // Treat import like inserting a physical disc, including when the
      // player was opened first and is currently polling with "Please
      // insert...". Its drive-probe loop will discover the new VFS disc and
      // open MCI on the next pass; no guest restart is necessary.
      const activeShell = shell();
      const running = activeShell && activeShell.runningApps &&
        activeShell.runningApps.find(item => item && item.name === 'cdplayer' &&
          item.wine && item.wine.running);
      const vfs = running && running.wine._helpCtx && running.wine._helpCtx.vfs;
      if (vfs) {
        await mount(vfs);
        log(`[media] mounted "${value.name}" in the open CD Player`);
      }
      return true;
    }

    // ---- library bootstrap ------------------------------------------------

    // Opening the library also runs the orphan sweep, so a crashed import from
    // a previous visit is cleaned up before anything is listed.
    async function openLibrary() {
      if (library) return library;
      if (libraryError) return null;
      try {
        library = await libraryModule.MediaLibrary.open();
        return library;
      } catch (error) {
        libraryError = String((error && error.message) || error);
        return null;
      }
    }

    // Kept media, restored as desktop icons before a byte of it is read. The
    // catalog carries the chosen exe, so the entry can be rebuilt without
    // touching OPFS; the mount happens on launch.
    async function restoreLibrary() {
      const lib = await openLibrary();
      if (!lib) {
        log(`[media] library unavailable: ${libraryError}`);
        return [];
      }
      const rows = await lib.list();
      for (const row of rows) {
        if (isOpticalMedia(row)) await bindCdPlayer(row, keptMount(row));
        if (!row.exePath) continue;  // media with nothing to launch: shelf only
        registerKept(row);
      }
      return rows;
    }

    function keptMount(row) {
      return async (vfs) => {
        const files = await library.filesFor(row.id);
        const plans = await mediaImport.analyzeFiles(files);
        const plan = plans[0];
        if (!plan) throw new Error(`${row.name} has no stored media parts`);
        return plan.mount(vfs);
      };
    }

    function keptEntryFor(row) {
      return {
        exe: row.exePath,
        dynamic: true,
        badge: 'kept',
        mediaId: row.id,
        mediaKind: row.kind,
        mediaName: row.name,
        label: row.appLabel || row.name,
        workingDirectory: row.exePath.replace(/[^\\]+$/, ''),
        mirrorWorkingDirectoryToC: true,
        // Every byte of this is deferred to launch: the icon must appear on a
        // cold page load without opening a 638MB disc.
        mounts: [keptMount(row)],
        exeBytes: async (vfs) => vfs.materialize(row.exePath),
      };
    }

    function registerKept(row, iconUrl) {
      const entry = keptEntryFor(row);
      apps[row.appId || row.id] = entry;
      keptItems.set(row.appId || row.id, { row, entry });
      addDesktopIcon(row.appId || row.id, entry,
        { badge: 'kept', iconUrl: iconUrl || row.iconUrl || null });
      return entry;
    }

    // A dropped program gets its own icon, walked out of its resources by
    // lib/resources-icon.js — the same extractor the built-in desktop uses,
    // through the bytes entry point rather than the URL one. An imported game
    // is meant to be indistinguishable from a registered one, and the icon is
    // most of that.
    //
    // Only for a bare exe: inside a container the program has not been mounted
    // yet at this point, and reading it out of the archive to draw an icon
    // would undo the "nothing is copied" property of a session import. Those
    // wear the container glyph instead.
    async function iconFor(plan) {
      if (plan.kind !== 'exe') return null;
      const extract = typeof window !== 'undefined' && window.iconDataURLFromBytes;
      if (!extract) return null;
      try {
        const bytes = await mediaImport.readAll(plan.provider);
        return extract(bytes);
      } catch (error) {
        log(`[media] no icon in ${plan.name}: ${(error && error.message) || error}`);
        return null;
      }
    }

    // ---- desktop icons ----------------------------------------------------

    function addDesktopIcon(appId, entry, meta) {
      if (!iconGrid) return null;
      const existing = iconGrid.querySelector(`.desktop-icon[data-app="${cssEscape(appId)}"]`);
      if (existing) existing.remove();
      const node = el('div', 'desktop-icon');
      node.dataset.app = appId;
      node.dataset.mediaBadge = meta.badge;
      if (meta.badge === 'session') node.classList.add('wa-session');
      const img = el('div', 'icon-img');
      if (meta.iconUrl) {
        const image = doc.createElement('img');
        image.src = meta.iconUrl;
        image.style.width = '32px';
        image.style.height = '32px';
        image.style.imageRendering = 'pixelated';
        img.appendChild(image);
      } else {
        img.textContent = GLYPH[entry.mediaKind] || GLYPH.unknown;
      }
      const label = el('div', 'icon-label',
        `${BADGE[meta.badge]} ${entry.label || appId}`);
      node.appendChild(img);
      node.appendChild(label);
      // The same open gesture the built-in icons use: one tap on a phone,
      // double-click with a mouse. Diverging here would make imported games
      // feel like a different kind of thing, which is exactly what the design
      // says they must not be.
      let lastClick = 0;
      node.addEventListener('click', () => {
        for (const other of iconGrid.querySelectorAll('.desktop-icon.selected')) {
          other.classList.remove('selected');
        }
        node.classList.add('selected');
        const now = Date.now();
        if (singleApp() || now - lastClick < 500) {
          lastClick = 0;
          launch(appId);
          return;
        }
        lastClick = now;
      });
      iconGrid.appendChild(node);
      return node;
    }

    function cssEscape(value) {
      return String(value).replace(/["\\]/g, '\\$&');
    }

    function launch(appId) {
      const s = shell();
      if (!s) { log('[media] no shell to launch into'); return; }
      const select = doc.getElementById('app-select');
      if (select) {
        // The shell reads the dropdown when it is given no id; keep the two in
        // step so a later launch with no argument does not fall back to
        // whatever was selected before the import.
        if (![...select.options].some(o => o.value === appId)) {
          const option = doc.createElement('option');
          option.value = appId;
          option.textContent = (apps[appId] && apps[appId].label) || appId;
          select.appendChild(option);
        }
        select.value = appId;
      }
      return s.launchApp(appId);
    }

    // ---- import ------------------------------------------------------------

    // The whole flow for one file: analyze, ask, act. Resolves to the app id
    // when something was registered, or null when the visitor cancelled or the
    // media had nothing to launch.
    async function importFile(file, opts2) {
      const forced = opts2 || {};
      let plan;
      try {
        plan = await mediaImport.analyze(file, { name: file.name });
      } catch (error) {
        await showError(file.name, error);
        return null;
      }
      const choice = forced.choice || await askInsert(plan);
      if (!choice) return null;
      return applyChoice(plan, file, choice);
    }

    // Files selected/dropped together are analyzed together so a CUE and all
    // referenced BIN tracks produce one insert dialog and one mounted disc.
    // Non-CUE files retain the old behavior and each get their own dialog.
    async function importFiles(files, opts2) {
      const values = Array.from(files || []);
      if (!values.length) return [];
      let plans;
      try {
        plans = await mediaImport.analyzeFiles(values);
      } catch (error) {
        await showError(values.map(file => file.name).join(', '), error);
        return [];
      }
      const results = [];
      for (const plan of plans) {
        const choice = opts2 && opts2.choice ? opts2.choice : await askInsert(plan);
        if (!choice) continue;
        results.push(await applyChoice(plan, plan.storageFiles, choice));
      }
      return results;
    }

    async function keepPlan(lib, plan, choice, extra) {
      const storageFiles = plan.storageFiles || [];
      const common = {
        name: plan.name,
        kind: plan.kind,
        volumeLabel: plan.volumeLabel,
        onProgress: choice.onProgress,
        extra,
      };
      if (storageFiles.length > 1) return lib.addBundle(storageFiles, common);
      const source = storageFiles.length ? storageFiles[0].source : plan.source;
      return lib.add(source, common);
    }

    async function applyChoice(plan, source, choice) {
      let mediaId = null;
      let row = null;
      // Extracted before the copy so a kept import can carry its icon in the
      // catalog: on the next visit the desktop is rebuilt from IndexedDB
      // alone, without opening the media, so an icon that is not in the row
      // is an icon that never comes back.
      const iconUrl = await iconFor(plan);
      if (choice.keep) {
        const lib = await openLibrary();
        if (!lib) {
          // Degrade rather than refuse: the media is still perfectly usable
          // for this session, and saying so is more useful than an error.
          log(`[media] keeping "${plan.name}" is not possible here (${libraryError}); ` +
            'inserted for this session only');
          choice.keep = false;
        } else {
          if (!persistState) persistState = await libraryModule.MediaLibrary.requestPersist();
          row = await keepPlan(lib, plan, choice, {
              exePath: choice.exePath || null,
              appId: plan.id,
              appLabel: choice.label || null,
              iconUrl,
          });
          mediaId = row.id;
        }
      }

      // CD Player is a separate process with a separate VFS. Give its desktop
      // entry the same optical mount now, including discs that contain no EXE
      // and therefore do not get their own launch icon.
      if (choice.keep && row) await bindCdPlayer(row, keptMount(row));
      else await bindCdPlayer(plan, async (vfs) => plan.mount(vfs));

      if (!choice.exePath) {
        // Media with no program in it still mounts — a data disc, a folder of
        // assets — it simply has no icon to leave behind.
        if (choice.keep) log(`[media] kept "${plan.name}" (${plan.entryCount} files, nothing to launch)`);
        return null;
      }

      choice.iconUrl = iconUrl;
      const entry = (choice.keep && row)
        ? registerKept(row, iconUrl)
        : registerSession(plan, source, choice, mediaId);
      if (choice.launch) launch(plan.id);
      return plan.id;
    }

    function registerSession(plan, source, choice, mediaId) {
      const entry = mediaImport.makeAppEntry(plan, {
        exePath: choice.exePath,
        badge: 'session',
        mediaId,
        label: choice.label,
      });
      apps[plan.id] = entry;
      sessionItems.set(plan.id, { plan, entry, source, iconUrl: choice.iconUrl || null });
      addDesktopIcon(plan.id, entry, { badge: 'session', iconUrl: choice.iconUrl || null });
      log(`[media] inserted "${plan.name}" for this session (${plan.entryCount} files)`);
      return entry;
    }

    // Upgrade a session import to the library, while its File is still alive.
    // This is the one-click promotion the badge advertises; it cannot work
    // after a reload, which is precisely why the badge is there.
    async function keepSession(appId, onProgress) {
      const item = sessionItems.get(appId);
      if (!item) throw new Error(`${appId} is not a session import`);
      const lib = await openLibrary();
      if (!lib) throw new Error(libraryError || 'the media library is unavailable');
      if (!persistState) persistState = await libraryModule.MediaLibrary.requestPersist();
      const row = await keepPlan(lib, item.plan, { onProgress }, {
          exePath: item.entry.exe,
          appId,
          appLabel: item.entry.label,
          iconUrl: item.iconUrl || null,
      });
      sessionItems.delete(appId);
      registerKept(row, item.iconUrl);
      return row;
    }

    // ---- the insert dialog -------------------------------------------------

    // One dialog, three costumes. Resolves to
    // `{exePath, keep, launch, label, onProgress}` or null on cancel.
    function askInsert(plan) {
      return new Promise((resolve) => {
        const modal = el('div', 'wa-media-modal');
        const panel = el('div', 'wa-media-panel');
        const title = el('div', 'wa-media-title');
        title.appendChild(el('span', null, `${plan.name} — new media`));
        panel.appendChild(title);
        const body = el('div', 'wa-media-body');

        const what = el('div', 'wa-media-what');
        what.appendChild(el('div', 'wa-media-glyph', GLYPH[plan.kind] || GLYPH.unknown));
        const facts = el('div');
        facts.appendChild(el('b', null, plan.label));
        const bits = [mediaSniff.humanSize(plan.size)];
        if (plan.volumeLabel) bits.unshift(`label "${plan.volumeLabel}"`);
        if (plan.entryCount) bits.push(`${plan.entryCount} file${plan.entryCount === 1 ? '' : 's'}`);
        facts.appendChild(el('div', 'wa-media-dim', bits.join(' \u25aa ')));
        if (plan.mountRoot) facts.appendChild(el('div', 'wa-media-dim', `mounts at ${plan.mountRoot}`));
        what.appendChild(facts);
        body.appendChild(what);
        if (plan.warning) body.appendChild(el('div', 'wa-media-err', plan.warning));

        // Which program to run. One candidate needs no picker; several get a
        // list, which is the "one decision is a goal, not a guarantee" case
        // the design calls out. None is legitimate — a data disc mounts and
        // leaves no icon.
        let exeSelect = null;
        const candidates = plan.exeCandidates;
        if (candidates.length === 1) {
          body.appendChild(el('div', 'wa-media-dim', `found ${candidates[0].name}`));
        } else if (candidates.length > 1) {
          body.appendChild(el('div', 'wa-media-dim', `${candidates.length} programs — pick one:`));
          exeSelect = el('select', 'wa-media-exe');
          for (const candidate of candidates) {
            const option = doc.createElement('option');
            option.value = candidate.path;
            option.textContent = candidate.path +
              (candidate.brokenAutorun ? ' (broken disc autorun)' : '') +
              (candidate.compatibilityLabel ? ` (${candidate.compatibilityLabel})` : '');
            exeSelect.appendChild(option);
          }
          body.appendChild(exeSelect);
        } else {
          body.appendChild(el('div', 'wa-media-dim', 'no program found — this mounts as files only'));
        }

        const choice = el('div', 'wa-media-choice');
        const sessionLabel = el('label');
        const sessionRadio = doc.createElement('input');
        sessionRadio.type = 'radio';
        sessionRadio.name = 'wa-media-where';
        sessionRadio.checked = true;
        sessionLabel.appendChild(sessionRadio);
        sessionLabel.appendChild(doc.createTextNode(' Insert now — this session only'));
        const keepLabel = el('label');
        const keepRadio = doc.createElement('input');
        keepRadio.type = 'radio';
        keepRadio.name = 'wa-media-where';
        keepLabel.appendChild(keepRadio);
        keepLabel.appendChild(doc.createTextNode(' Insert and keep — copy into the library'));
        choice.appendChild(sessionLabel);
        choice.appendChild(keepLabel);
        body.appendChild(choice);

        const launchLabel = el('label');
        const launchBox = doc.createElement('input');
        launchBox.type = 'checkbox';
        launchBox.checked = candidates.length > 0;
        launchBox.disabled = candidates.length === 0;
        launchLabel.appendChild(launchBox);
        const launchText = doc.createTextNode(candidates.length
          ? ` Launch ${candidates[0].name} after insert` : ' Nothing to launch');
        launchLabel.appendChild(launchText);
        if (!candidates.length) launchLabel.className = 'disabled';
        body.appendChild(launchLabel);
        if (exeSelect) {
          exeSelect.addEventListener('change', () => {
            launchText.textContent = ` Launch ${mediaImport.baseName(exeSelect.value)} after insert`;
          });
        }

        const status = el('div', 'wa-media-status');
        const progress = el('div', 'wa-media-progress');
        const bar = el('i');
        progress.appendChild(bar);
        body.appendChild(status);
        body.appendChild(progress);

        // What "keep" actually means here, said before it is chosen rather
        // than after it fails.
        const note = el('div', 'wa-media-dim');
        body.appendChild(note);
        const probe = libraryModule.probe();
        if (!probe.opfs || !probe.idb || !probe.writable) {
          keepRadio.disabled = true;
          keepLabel.className = 'disabled';
          note.textContent = `Keeping is unavailable: ${probe.reason}.`;
        }
        keepRadio.addEventListener('change', async () => {
          if (!keepRadio.checked) { note.textContent = ''; return; }
          const estimate = await libraryModule.MediaLibrary.estimate();
          note.textContent = estimate
            ? `Copies ${mediaSniff.humanSize(plan.size)} into site storage ` +
              `(${mediaSniff.humanSize(estimate.usage)} of ` +
              `${mediaSniff.humanSize(estimate.quota)} available used).`
            : `Copies ${mediaSniff.humanSize(plan.size)} into site storage.`;
        });

        const actions = el('div', 'wa-media-actions');
        const ok = el('button', null, 'OK');
        const cancel = el('button', null, 'Cancel');
        actions.appendChild(ok);
        actions.appendChild(cancel);
        body.appendChild(actions);
        panel.appendChild(body);
        modal.appendChild(panel);
        doc.body.appendChild(modal);

        const close = (value) => { modal.remove(); resolve(value); };
        cancel.addEventListener('click', () => close(null));
        ok.addEventListener('click', () => {
          const exePath = exeSelect ? exeSelect.value
            : (candidates[0] ? candidates[0].path : null);
          // The copy runs while the dialog is still up, because a 600MB import
          // needs somewhere to show a progress bar.
          ok.disabled = true;
          cancel.disabled = true;
          const keep = keepRadio.checked;
          if (keep) {
            progress.style.display = 'block';
            status.textContent = 'Copying into the library...';
          }
          close({
            exePath,
            keep,
            launch: launchBox.checked && !!exePath,
            label: exePath ? mediaImport.baseName(exePath).replace(/\.exe$/i, '') : plan.name,
            onProgress: ({ loaded, total }) => {
              bar.style.width = `${total ? Math.round((loaded / total) * 100) : 0}%`;
            },
          });
        });
        ok.focus();
      });
    }

    function showError(name, error) {
      return new Promise((resolve) => {
        const modal = el('div', 'wa-media-modal');
        const panel = el('div', 'wa-media-panel');
        panel.appendChild(el('div', 'wa-media-title', `${name} — cannot insert`));
        const body = el('div', 'wa-media-body');
        body.appendChild(el('div', 'wa-media-err', String((error && error.message) || error)));
        const actions = el('div', 'wa-media-actions');
        const ok = el('button', null, 'OK');
        actions.appendChild(ok);
        body.appendChild(actions);
        panel.appendChild(body);
        modal.appendChild(panel);
        doc.body.appendChild(modal);
        ok.addEventListener('click', () => { modal.remove(); resolve(); });
        log(`[media] ${name}: ${(error && error.message) || error}`);
      });
    }

    // ---- My Media -----------------------------------------------------------

    async function showLibrary() {
      const modal = el('div', 'wa-media-modal');
      const panel = el('div', 'wa-media-panel');
      const title = el('div', 'wa-media-title');
      title.appendChild(el('span', null, 'My Media'));
      const closeBtn = el('button', null, '\u2715');
      title.appendChild(closeBtn);
      panel.appendChild(title);
      const body = el('div', 'wa-media-body');
      const list = el('div', 'wa-media-list');
      body.appendChild(list);
      const actions = el('div', 'wa-media-actions');
      const importBtn = el('button', null, 'Import\u2026');
      actions.appendChild(importBtn);
      body.appendChild(actions);
      const foot = el('div', 'wa-media-foot');
      body.appendChild(foot);
      panel.appendChild(body);
      modal.appendChild(panel);
      doc.body.appendChild(modal);

      closeBtn.addEventListener('click', () => modal.remove());
      importBtn.addEventListener('click', () => { modal.remove(); openPicker(); });

      async function render() {
        list.replaceChildren();
        const lib = await openLibrary();
        const rows = lib ? await lib.list() : [];
        if (!rows.length && !sessionItems.size) {
          list.appendChild(el('div', 'wa-media-empty', 'Nothing imported yet.'));
        }
        for (const row of rows) {
          const line = el('div', 'wa-media-row');
          line.appendChild(el('span', 'wa-media-badge kept', BADGE.kept));
          line.appendChild(el('span', 'name', row.name));
          line.appendChild(el('span', 'wa-media-dim', mediaSniff.humanSize(row.size)));
          const remove = el('button', null, 'Remove');
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              // The immutable media bytes and its writable C: journal are two
              // OPFS trees under the same media id. Removing only the catalog
              // row leaves the installed tree unreachable but still charged
              // to the origin's quota.
              if (typeof window !== 'undefined' && window.OverlayStore &&
                  typeof window.OverlayStore.removeOpfsScope === 'function') {
                await window.OverlayStore.removeOpfsScope(row.id);
              }
              await lib.remove(row.id);
              const appId = row.appId || row.id;
              delete apps[appId];
              keptItems.delete(appId);
              const icon = iconGrid && iconGrid.querySelector(
                `.desktop-icon[data-app="${cssEscape(appId)}"]`);
              if (icon) icon.remove();
              render();
            } catch (error) {
              remove.disabled = false;
              const message = `Cannot remove ${row.name}: ${error && error.message || error}`;
              foot.appendChild(el('div', 'warn', message));
              log(`[media] ${message}`);
            }
          });
          line.appendChild(remove);
          list.appendChild(line);
        }
        for (const [appId, item] of sessionItems) {
          const line = el('div', 'wa-media-row');
          line.appendChild(el('span', 'wa-media-badge session', BADGE.session));
          line.appendChild(el('span', 'name', item.plan.name));
          line.appendChild(el('span', 'wa-media-dim', 'session'));
          const keep = el('button', null, 'Keep');
          keep.addEventListener('click', async () => {
            keep.disabled = true;
            keep.textContent = 'Copying\u2026';
            try {
              await keepSession(appId);
              render();
            } catch (error) {
              keep.textContent = 'Failed';
              foot.appendChild(el('div', 'warn', String((error && error.message) || error)));
            }
          });
          line.appendChild(keep);
          list.appendChild(line);
        }
        await renderFooter();
      }

      // The honest part. `estimate()` is origin headroom, not disk free space,
      // and persist() is a request that can be refused — both are labelled as
      // what they are, because a UI that implies durability it does not have
      // is worse than one that admits the limit.
      async function renderFooter() {
        foot.replaceChildren();
        const estimate = await libraryModule.MediaLibrary.estimate();
        if (estimate) {
          foot.appendChild(el('div', null,
            `used ${mediaSniff.humanSize(estimate.usage)} of ` +
            `${mediaSniff.humanSize(estimate.quota)} site storage available`));
        }
        if (libraryError) {
          foot.appendChild(el('div', 'warn', `Library unavailable: ${libraryError}`));
          return;
        }
        const persisted = typeof navigator !== 'undefined' && navigator.storage &&
          typeof navigator.storage.persisted === 'function'
          ? await navigator.storage.persisted() : false;
        if (persisted) {
          foot.appendChild(el('div', null, 'Eviction protection: granted.'));
        } else {
          const line = el('div', 'warn',
            'Eviction protection: not granted \u2014 the browser may clear kept media.');
          foot.appendChild(line);
          const ask = el('button', null, 'Keep my stuff');
          ask.addEventListener('click', async () => {
            persistState = await libraryModule.MediaLibrary.requestPersist();
            renderFooter();
          });
          foot.appendChild(ask);
        }
      }

      await render();
      return modal;
    }

    // ---- drop target + picker ------------------------------------------------

    const fileInput = doc.createElement('input');
    fileInput.type = 'file';
    fileInput.style.display = 'none';
    // No `accept` filter: the extension is not what we trust (see
    // lib/media-sniff.js), and a filter would hide the very files — a .bin CD
    // image, an extension-less download — that this flow exists to accept.
    fileInput.multiple = true;
    doc.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const files = [...fileInput.files];
      fileInput.value = '';
      await importFiles(files);
    });

    function openPicker() { fileInput.click(); }

    // ---- guest WM_DROPFILES bridge ---------------------------------------

    // The page already owns the browser's one file-drop listener. When a
    // running Win98 window has called DragAcceptFiles, route the same browser
    // File objects into that guest instead of opening the game-media dialog.
    // Files are mounted lazily in a real VFS directory, then named by a
    // DROPFILES block posted as WM_DROPFILES; an unclaimed drop keeps the
    // existing "insert media" behavior below.
    function canvasPoint(event) {
      const canvas = doc.getElementById('screen');
      if (!canvas || !canvas.width || !canvas.height) return null;
      const rect = canvas.getBoundingClientRect();
      if (!(rect.width > 0) || !(rect.height > 0)) return null;
      return {
        x: Math.floor((event.clientX - rect.left) * canvas.width / rect.width),
        y: Math.floor((event.clientY - rect.top) * canvas.height / rect.height),
      };
    }

    function guestDropContext(event) {
      const activeShell = shell();
      const renderer = activeShell && activeShell.renderer;
      const point = canvasPoint(event);
      if (!renderer || !point || !renderer._inputWindowAtPoint) return null;
      const win = renderer._inputWindowAtPoint(point.x, point.y);
      if (!win) return null;
      const exports = win.wasm && win.wasm.exports;
      if (!exports || !exports.drop_target_at) return null;
      let hwnd = 0;
      try { hwnd = exports.drop_target_at(win.hwnd | 0, point.x, point.y) >>> 0; }
      catch (_) { return null; }
      if (!hwnd) return null;
      const running = activeShell.runningApps && activeShell.runningApps.find(item =>
        item && item.wine && item.wine.running !== false &&
        ((win.processId && item.wine.processId === win.processId) ||
         (!win.processId && item.wine.instance === win.wasm)));
      if (!running) return null;
      let clientX = point.x;
      let clientY = point.y;
      try {
        if (exports.wnd_client_screen_x) clientX -= exports.wnd_client_screen_x(hwnd) | 0;
        if (exports.wnd_client_screen_y) clientY -= exports.wnd_client_screen_y(hwnd) | 0;
      } catch (_) { /* the DROPFILES point is advisory; keep screen coordinates */ }
      return { wine: running.wine, hwnd, point, clientX, clientY };
    }

    function safeDropName(name) {
      const leaf = String(name || 'dropped-file').replace(/^.*[\\/]/, '');
      // Win98's ANSI shell APIs cannot represent arbitrary browser Unicode.
      // Match the old ACP replacement behavior with a stable ASCII spelling,
      // and reject the characters Win32 file names cannot contain.
      const safe = [...leaf].map(ch => {
        const code = ch.charCodeAt(0);
        return code >= 0x20 && code <= 0x7e && !/[<>:"/\\|?*]/.test(ch) ? ch : '_';
      }).join('').replace(/[ .]+$/, '').slice(0, 120);
      return safe || 'dropped-file';
    }

    function uniqueDropPath(vfs, rawName) {
      const root = 'C:\\WINDOWS\\TEMP\\Dropped Files';
      const name = safeDropName(rawName);
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let path = `${root}\\${name}`;
      let suffix = 2;
      while (vfs.files.has(vfs._normPath(path))) {
        path = `${root}\\${stem} (${suffix++})${ext}`;
      }
      return path;
    }

    async function mountDroppedFile(vfs, file, path) {
      const providers = typeof window !== 'undefined' && window.byteProvider;
      if (providers && providers.BlobProvider && typeof vfs.setProviderFile === 'function' &&
          typeof Blob !== 'undefined' && file instanceof Blob) {
        vfs.setProviderFile(path, {
          provider: new providers.BlobProvider(file, file.name || path),
          attrs: 0x20,
        });
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      vfs.files.set(vfs._normPath(path), { data: bytes, attrs: 0x20 });
      if (vfs.ensureParentDirs) vfs.ensureParentDirs(path);
    }

    async function deliverGuestDrop(files, event, knownContext) {
      const context = knownContext || guestDropContext(event);
      if (!context || !files.length) return false;
      const wine = context.wine;
      const vfs = wine._helpCtx && wine._helpCtx.vfs;
      if (!vfs || !wine.callGuest || !wine.memory) return false;

      const paths = [];
      for (const file of files) {
        const path = uniqueDropPath(vfs, file && file.name);
        await mountDroppedFile(vfs, file, path);
        paths.push(path);
      }

      // DROPFILES is 20 bytes followed by a double-NUL-terminated ANSI path
      // list. Allocate in the guest heap so DragFinish can release the HDROP
      // with the ordinary heap owner instead of maintaining a parallel table.
      const encoded = paths.map(path => Uint8Array.from(path, ch => ch.charCodeAt(0) & 0xff));
      const size = 20 + encoded.reduce((sum, bytes) => sum + bytes.length + 1, 1);
      const hdrop = (await wine.callGuest('guest_alloc', size)) >>> 0;
      if (!hdrop) throw new Error('guest has no memory for dropped file names');
      const wa = (await wine.callGuest('guest_to_wasm', hdrop)) >>> 0;
      if (wa + size > wine.memory.buffer.byteLength) {
        await wine.callGuest('guest_free', hdrop);
        throw new Error('guest returned an invalid dropped-file allocation');
      }
      const view = new DataView(wine.memory.buffer, wa, size);
      view.setUint32(0, 20, true);                    // DROPFILES.pFiles
      view.setInt32(4, context.clientX | 0, true);    // client point.x
      view.setInt32(8, context.clientY | 0, true);    // client point.y
      view.setUint32(12, 0, true);                   // fNC = FALSE
      view.setUint32(16, 0, true);                   // fWide = FALSE (Win98 ACP)
      const payload = new Uint8Array(wine.memory.buffer, wa + 20, size - 20);
      payload.fill(0);
      let at = 0;
      for (const bytes of encoded) {
        payload.set(bytes, at);
        at += bytes.length + 1;
      }
      const posted = await wine.callGuest('post_message_q', context.hwnd, 0x0233, hdrop, 0);
      if (!posted) {
        await wine.callGuest('guest_free', hdrop);
        throw new Error('guest message queue is full');
      }
      log(`[drop] sent ${paths.length} file(s) to hwnd=0x${context.hwnd.toString(16)}`);
      return true;
    }

    let overlay = null;
    let dragDepth = 0;
    if (dropTarget) {
      overlay = el('div', 'wa-media-drop');
      const overlayLabel = el('div', null, 'Drop to insert');
      overlay.appendChild(overlayLabel);
      dropTarget.appendChild(overlay);

      // Capture phase, and preventDefault on BOTH dragover and drop. Without
      // the dragover default the drop event never fires at all; without the
      // drop default the browser navigates to the file and the page is gone.
      // Capture because the canvas sits over everything in this container and
      // would otherwise be the only thing that ever sees these events.
      const show = (on) => { if (overlay) overlay.classList.toggle('on', on); };
      dropTarget.addEventListener('dragenter', (event) => {
        event.preventDefault();
        dragDepth++;
        show(true);
      }, true);
      dropTarget.addEventListener('dragover', (event) => {
        event.preventDefault();
        overlayLabel.textContent = guestDropContext(event)
          ? 'Drop files into this application' : 'Drop to insert';
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }, true);
      dropTarget.addEventListener('dragleave', (event) => {
        event.preventDefault();
        // dragleave fires for every child boundary crossed, so a plain
        // "hide on leave" flickers the overlay off while the pointer is still
        // over the desktop. Count enters against leaves instead.
        if (--dragDepth <= 0) { dragDepth = 0; show(false); }
      }, true);
      dropTarget.addEventListener('drop', async (event) => {
        event.preventDefault();
        dragDepth = 0;
        show(false);
        const files = event.dataTransfer ? [...event.dataTransfer.files] : [];
        const context = guestDropContext(event);
        if (!await deliverGuestDrop(files, event, context)) await importFiles(files);
      }, true);
    }

    // The phone's import affordance, and the desktop's discoverable one. Sits
    // in the corner of the desktop rather than in the taskbar, because the
    // taskbar belongs to the renderer and a DOM button in it would be a second
    // window manager's worth of trouble for one button.
    let importButton = null;
    if (dropTarget && options.showButton !== false) {
      importButton = el('button', 'wa-media-import-btn', '+ Add a game\u2026');
      importButton.addEventListener('click', (event) => {
        event.preventDefault();
        openPicker();
      });
      importButton.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showLibrary();
      });
      dropTarget.appendChild(importButton);
    }

    const controller = {
      importFile,
      importFiles,
      openPicker,
      showLibrary,
      restoreLibrary,
      deliverGuestDrop,
      keepSession,
      launch,
      get sessionItems() { return sessionItems; },
      get keptItems() { return keptItems; },
      get libraryError() { return libraryError; },
      get persistState() { return persistState; },
      _fileInput: fileInput,
      _overlay: overlay,
      _importButton: importButton,
    };
    return controller;
  }

  const api = { install, GLYPH, BADGE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.mediaImportUI = api;
})();
