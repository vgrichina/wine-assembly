// Play a MIDI asset without running the app it belongs to.
//
// Solitaire staying silent has four possible causes — the SMF parser, the
// sequencer, the AudioContext, or a guest that never asked for music — and
// three of them are host-side. This isolates them: it drives the real MCI
// path in lib/host-imports.js directly, with no guest at all.
//
// The trick is that MCI takes a filename, not bytes, so there has to be
// something for it to read. It gets a one-page WebAssembly.Memory that exists
// only to hold that filename, and a one-entry VFS holding the file. Nothing
// else about the emulator is instantiated.
//
// A debug-toolbar feature, so it is loaded but never armed unless ?debug is
// on. Lived inline in index.html until it was the last block of application
// logic left in the page template, where nothing could test it and any
// grep-the-template test would break on the move.

function createDebugMidi(deps) {
  const apps = deps.apps || {};
  const appFileUrl = deps.appFileUrl;
  const debugMode = !!deps.debugMode;
  const setStatus = deps.setStatus || (() => {});
  // The page's asset version, so a cached MIDI does not outlive a redeploy.
  const assetVersion = deps.assetVersion || '';
  const newHost = deps.newHost || (() => new WineAssembly());
  const makeImports = deps.createHostImports ||
    (typeof createHostImports === 'function' ? createHostImports : null);

  // MCI command ids. The guest names these; we call the same imports it does.
  const MCI_OPEN_ELEMENT_TYPE = 0x2002;
  const MCI_STOP = 0x0804;
  const MCI_PLAY = 0x0806;

  let player = null;
  let audioHost = null;

  function baseName(url) {
    return String(url || '').split(/[\/\\]/).pop();
  }

  // Which container, or '' for something that is not MIDI at all. Worth
  // checking before handing it to MCI: "parsed to zero notes" and "this was
  // never a MIDI file" are different bugs and the second is not ours.
  function containerKind(bytes) {
    if (!bytes || bytes.length < 14) return '';
    const text4 = (p) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    if (text4(0) === 'MThd') return 'SMF';
    if (bytes.length >= 24 && text4(0) === 'RIFF' && text4(8) === 'RMID') return 'RMID';
    return '';
  }

  // Every MIDI asset any app in the registry mounts, deduplicated.
  function midiAssets() {
    const seen = new Set();
    const out = [];
    for (const [appKey, app] of Object.entries(apps)) {
      for (const file of (app.files || [])) {
        const url = appFileUrl ? appFileUrl(file) : String(file);
        if (!/\.(mid|midi|rmi)$/i.test(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, label: appKey + ': ' + baseName(url) });
      }
    }
    return out;
  }

  function fillSelect(sel) {
    if (!sel) return;
    const assets = midiAssets();
    for (const asset of assets) {
      const opt = document.createElement('option');
      opt.value = asset.url;
      opt.textContent = asset.label;
      sel.appendChild(opt);
    }
    if (!sel.options.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No MIDI assets';
      sel.appendChild(opt);
    }
  }

  function init() {
    if (!debugMode) return;
    fillSelect(document.getElementById('midi-select'));
  }

  // Write a C string where a host import expects a pointer to one.
  function writeString(memory, ptr, value) {
    const mem = new Uint8Array(memory.buffer);
    const s = String(value || '');
    for (let i = 0; i < s.length && ptr + i + 1 < mem.length; i++) {
      mem[ptr + i] = s.charCodeAt(i) & 0xFF;
    }
    mem[Math.min(ptr + s.length, mem.length - 1)] = 0;
  }

  function stop(quiet) {
    if (player) {
      try { player.imports.host.mci_command(player.id, MCI_STOP, 0, 0); } catch (_) {}
      player = null;
    }
    if (!quiet) setStatus('MIDI stopped');
  }

  // With no url, play whatever the toolbar has selected. Told one, the DOM is
  // not consulted at all — the MCI path is the part worth exercising, and it
  // does not need a page.
  async function play(url) {
    let target = url;
    if (!target && typeof document !== 'undefined') {
      const sel = document.getElementById('midi-select');
      target = sel && sel.value;
    }
    if (!target) return null;
    stop(true);
    const name = baseName(target);
    setStatus('Loading MIDI...');
    try {
      // One host for the page, kept only for its AudioContext: priming it
      // needs the user gesture that got us here.
      if (!audioHost) audioHost = newHost();
      const ac = audioHost.primeAudio();
      const response = await fetch(assetVersion ? target + '?v=' + assetVersion : target);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!containerKind(bytes)) {
        setStatus(name + ' is not SMF/RMID MIDI data');
        console.warn('[debug-midi] unsupported MIDI container:', name, bytes.slice(0, 16));
        return null;
      }

      // The whole guest, for MCI's purposes: somewhere to put a filename and
      // a filesystem with one file in it.
      const memory = new WebAssembly.Memory({ initial: 1 });
      const path = 'c:\\' + name.toLowerCase();
      const files = new Map([[path, { data: bytes, attrs: 0x20 }]]);
      const ctx = {
        getMemory: () => memory.buffer,
        get _audioCtx() { return ac; },
        trimMidiLeadIn: true,
        readFile: (requested) => {
          const entry = files.get('c:\\' + baseName(requested).toLowerCase());
          return entry && entry.data;
        },
        vfs: { files },
      };
      if (!makeImports) throw new Error('host imports are not loaded');
      const imports = makeImports(ctx);
      const namePtr = 0x100;
      writeString(memory, namePtr, name);
      const id = imports.host.mci_open(namePtr, 0, MCI_OPEN_ELEMENT_TYPE);
      const dev = ctx._mci && ctx._mci.devices && ctx._mci.devices.get(id >>> 0);
      // "It played nothing" and "it parsed nothing" look identical from the
      // speakers, so say which.
      if (!dev || !dev.smf || !dev.smf.notes.length) throw new Error('MIDI parsed with no notes');
      const err = imports.host.mci_command(id, MCI_PLAY, 0, 0);
      if (err) throw new Error('MCI_PLAY failed: 0x' + (err >>> 0).toString(16));
      player = { imports, id, ctx, url: target };
      setStatus('Playing MIDI: ' + name + ' (' + dev.smf.notes.length + ' notes)');
      return player;
    } catch (e) {
      console.error('[debug-midi] failed:', e);
      setStatus('MIDI failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  return {
    init,
    play,
    stop,
    midiAssets,
    containerKind,
    writeString,
    isPlaying: () => !!player,
  };
}

if (typeof module !== 'undefined') module.exports = { createDebugMidi };
if (typeof window !== 'undefined') window.debugMidi = { createDebugMidi };
