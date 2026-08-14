// Shared host imports for wine-assembly WASM instantiation.
// All runners (host.js, test/run.js, tools/render-png.js) use this.
// Real GDI with canvas backend — works with browser canvas or skia-canvas.
//
// Usage:
//   const base = createHostImports({ getMemory, renderer, resourceJson, onExit });
//   base.host.log = (ptr, len) => { ... };  // override as needed
//   const { instance } = await WebAssembly.instantiate(wasm, { host: base.host });

// In Node, use skia-canvas's Path2D so clipping behaves like a real browser.
// Also add a node-canvas-compatible sync `toBuffer('image/png')` to Canvas
// (skia-canvas's own toBuffer is async; toBufferSync is sync but takes 'png').
if (typeof globalThis.Path2D === 'undefined') {
  try {
    const sk = require('skia-canvas');
    globalThis.Path2D = sk.Path2D;
    const cproto = sk.Canvas && sk.Canvas.prototype;
    if (cproto && !cproto._toBufferShim) {
      cproto._toBufferShim = true;
      cproto.toBuffer = function (mime) {
        const fmt = (mime === 'image/jpeg' || mime === 'jpeg' || mime === 'jpg') ? 'jpg' : 'png';
        return this.toBufferSync(fmt);
      };
    }
  } catch (_) {
    globalThis.Path2D = class Path2D {
      constructor() {}
      rect() {} moveTo() {} lineTo() {} ellipse() {} closePath() {} addPath() {}
    };
  }
}
var _mu1 = typeof require !== 'undefined' ? require('./mem-utils') : (typeof window !== 'undefined' && window.memUtils || {});
var _dib = typeof require !== 'undefined' ? require('./dib') : new Proxy({}, { get: (_, k) => (typeof window !== 'undefined' && window.dibLib && window.dibLib[k]) });
var _gdiSurface = typeof require !== 'undefined' ? require('./gdi-surface') : (typeof window !== 'undefined' && window.gdiSurfaceLib || {});
var _traceFmt = typeof require !== 'undefined' ? require('./api-format') : (typeof window !== 'undefined' && window.apiFormat || null);

function createHostImports(ctx) {
  var _readStrA = _mu1.readStrA;
  // ctx.getMemory()    -> ArrayBuffer (late-bound)
  // ctx.renderer       -> Win98Renderer instance (optional; can be getter for late binding)
  // ctx.resourceJson   -> parsed PE resources { menus, dialogs, strings, bitmaps }
  // ctx.onExit(code)   -> called on ExitProcess
  // ctx.trace          -> Set of trace categories: 'gdi', 'msg', etc. (optional)

  const readStr = (ptr, maxLen = 512) => _readStrA(ctx.getMemory(), ptr, maxLen);
  const readStrW = (ptr, maxLen = 512) => {
    if (!ptr) return '';
    const dv = new DataView(ctx.getMemory());
    let s = '';
    for (let i = 0; i < maxLen && ptr + i * 2 + 1 < dv.byteLength; i++) {
      const c = dv.getUint16(ptr + i * 2, true);
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const readBytesString = (ptr, len) => {
    if (!ptr || !len) return '';
    const bytes = new Uint8Array(ctx.getMemory());
    let s = '';
    const end = Math.min(bytes.length, ptr + len);
    for (let p = ptr; p < end; p++) s += String.fromCharCode(bytes[p]);
    return s;
  };
  const _trace = ctx.trace || new Set();
  const _hex = v => '0x' + (v >>> 0).toString(16);
  const DIB_BACKING_BASE = 0x1C000000;
  const _traceFmtCtx = () => ({
    dv: new DataView(ctx.getMemory()),
    memory: ctx.getMemory(),
    ptrSpace: 'wasm',
    hex: _hex,
  });
  const _profileNow = () => {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  };
  const _profileEvent = (name, startedAt, data) => {
    const cb = (typeof globalThis !== 'undefined' && typeof globalThis.__waProfileHostEvent === 'function')
      ? globalThis.__waProfileHostEvent
      : null;
    if (!cb || !startedAt) return;
    try {
      cb({
        name,
        elapsedMs: Math.max(0, _profileNow() - startedAt),
        threadId: ((_audioDoneState && _audioDoneState.profileThreadId) || ctx.threadId || 0) | 0,
        data: data || {},
      });
    } catch (_) {}
  };
  const _formatHostTrace = (name, args, ret) => {
    if (!_traceFmt || !_traceFmt.formatHostCall) return null;
    try { return _traceFmt.formatHostCall(name, args, ret, _traceFmtCtx()); }
    catch (_) { return null; }
  };

  // --- Canvas text resources and derived GDI presentations ---
  // Thread workers share Canvas text resources and derived surface presentations.
  const _sharedGdi = ctx.sharedGdi || null;
  const _richeditFontSizeHint = _sharedGdi
    ? (_sharedGdi.richeditFontSizeHint || (_sharedGdi.richeditFontSizeHint = { twips: 0, px: 0 }))
    : { twips: 0, px: 0 };
  const _fontHandleBox = _sharedGdi ? _sharedGdi.fontHandleBox : { next: 0x400001 };
  const _fontResources = _sharedGdi
    ? (_sharedGdi.fontResources || (_sharedGdi.fontResources = {}))
    : {
    0x3001a: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // OEM_FIXED_FONT (10)
    0x3001b: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // ANSI_FIXED_FONT (11)
    0x3001c: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // ANSI_VAR_FONT (12)
    0x3001d: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // SYSTEM_FONT (13)
    0x3001e: { type: 'font', height: 12, weight: 400, italic: 0, face: 'sans-serif', css: '12px "W95FA", "MS Sans Serif", "Microsoft Sans Serif", Tahoma, sans-serif' }, // DEVICE_DEFAULT_FONT (14)
    0x30020: { type: 'font', height: 16, weight: 400, italic: 0, face: 'monospace', css: '16px "Fixedsys Excelsior", "Fixedsys", "Courier New", monospace' }, // SYSTEM_FIXED_FONT (16)
    0x30021: { type: 'font', height: 11, weight: 400, italic: 0, face: 'MS Sans Serif', css: '11px "W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif' }, // DEFAULT_GUI_FONT (17) — Win98 dialog font
    0x30022: { type: 'font', height: 11, weight: 700, italic: 0, face: 'MS Sans Serif', css: 'bold 11px "W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, Arial, sans-serif' }, // CAPTION_FONT — used by $defwndproc_ncpaint title text
  };
  const _regionPresentations = _sharedGdi
    ? (_sharedGdi.regionPresentations || (_sharedGdi.regionPresentations = {}))
    : {};
  const _gdiSurfacePresentations = _sharedGdi
    ? (_sharedGdi.surfacePresentations || (_sharedGdi.surfacePresentations = new Map()))
    : new Map();
  const _gdiTextStates = _sharedGdi
    ? (_sharedGdi.textStates || (_sharedGdi.textStates = new Map()))
    : new Map();

  // Indexed palettes live in canonical WAT memory. GdiSurface keeps only the
  // decoded RGB tuples needed to format a browser upload, so refresh that
  // derived view immediately before it is read.
  const _refreshGdiSurfacePalette = presentation => {
    if (!presentation || !presentation.surface || presentation.surface.bpp > 8 ||
        !presentation.paletteWa || presentation.paletteCount <= 0) return;
    const { surface } = presentation;
    const mem = new Uint8Array(ctx.getMemory());
    const count = Math.min(presentation.paletteCount, 1 << surface.bpp);
    const directDraw = presentation.id >= 0x200000 && presentation.id < 0x300000;
    surface.palette = [];
    for (let i = 0; i < count; i++) {
      const p = presentation.paletteWa + i * 4;
      surface.palette.push(directDraw
        ? [mem[p], mem[p + 1], mem[p + 2]]
        : [mem[p + 2], mem[p + 1], mem[p]]);
    }
    surface._paletteCache.clear();
  };

  const _scheduleGdiPresentation = presentation => {
    if (!presentation || !ctx.renderer || !ctx.renderer.scheduleRepaint) return;
    if (presentation.targetHwnd) {
      const win = ctx.renderer.windows && ctx.renderer.windows[presentation.targetHwnd];
      if (win) win.clientPainted = true;
    }
    if (presentation.targetHwnd || presentation.targetDesktop || presentation.targetOverlay) {
      ctx.renderer.scheduleRepaint();
    }
  };

  const _flushGdiSurfacePresentation = presentation => {
    if (!presentation || !presentation.surface || !presentation.canvasContext) return 0;
    const dirty = presentation.surface.takeDirtyRect();
    if (!dirty) return 1;
    try {
      _refreshGdiSurfacePalette(presentation);
      const rgba = presentation.surface.rgbaRect(dirty.x, dirty.y, dirty.w, dirty.h);
      const image = presentation.canvasContext.createImageData(dirty.w, dirty.h);
      image.data.set(rgba);
      presentation.canvasContext.putImageData(image, dirty.x, dirty.y);
      presentation.flushCount++;
      presentation.flushedPixels += dirty.w * dirty.h;
      _invalidatePixelCache(presentation.canvas);
      return 1;
    } catch (_) {
      presentation.surface.markDirty(dirty.x, dirty.y, dirty.w, dirty.h);
      return 0;
    }
  };

  const _defaultDcState = () => ({
    // Win32 DC defaults are BLACK_PEN + WHITE_BRUSH. Several Win98 apps rely on
    // PATCOPY before selecting a brush; using BTNFACE here paints stray gray bars.
    penColor: 0x000000, penWidth: 1, brushColor: 0xFFFFFF,
    selectedPen: 0x30017, selectedBrush: 0x30010,
    textColor: 0x000000, bkColor: 0xFFFFFF, bkMode: 2,
    posX: 0, posY: 0, selectedFont: 0,
    vpExtX: 1, vpExtY: 1, winExtX: 1, winExtY: 1,
  });
  // Text state is published from the canonical WAT DC immediately before a
  // Canvas text call. A direct host-only measurement gets immutable defaults.
  const _getDcState = (hdc) => {
    const textState = _gdiTextStates.get(hdc >>> 0);
    if (textState) return textState;
    return _defaultDcState();
  };
  const _allocFontResource = (font) => {
    const handle = _fontHandleBox.next++;
    _fontResources[handle] = font;
    return handle;
  };
  const _pixelCache = _sharedGdi && _sharedGdi.pixelCache ? _sharedGdi.pixelCache : new WeakMap();
  const _invalidatePixelCache = (canvas) => {
    if (canvas) _pixelCache.delete(canvas);
  };

  // ---- Audio mixer buses -------------------------------------------------
  // A shared master plus wave and MIDI child buses. The native WinMM mixer
  // controls these nodes, while recorder.js can continue tapping the master.
  // Mixer controls are desktop-wide in the browser, while voices/MCI devices
  // remain process-owned so closing one application cannot stop another.
  const _audioMixerState = ctx.sharedMixer || ctx.sharedAudio || ctx;
  if (!_audioMixerState.mixerVolumes) {
    _audioMixerState.mixerVolumes = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
  }
  if (!_audioMixerState.mixerMutes) _audioMixerState.mixerMutes = [0, 0, 0];
  if (!_audioMixerState.mixerContexts) _audioMixerState.mixerContexts = new Set();
  if (!_audioMixerState.mixerPeaks) {
    _audioMixerState.mixerPeaks = Array.from({ length: 3 }, () => ({ value: 0, holdUntil: 0, decayUntil: 0 }));
  }
  const _mixerGain = (packed) => {
    const value = packed >>> 0;
    return Math.max(0, Math.min(1, (((value & 0xFFFF) + (value >>> 16)) / 2) / 0xFFFF));
  };
  const _applyAudioMixerVolume = (ac, bus) => {
    if (!ac) return;
    const volume = _audioMixerState.mixerVolumes[bus] >>> 0;
    const node = bus === 0 ? ac._wineMaster : bus === 1 ? ac._wineWaveBus : ac._wineMidiBus;
    if (node && node.gain) node.gain.value = _audioMixerState.mixerMutes[bus] ? 0 : _mixerGain(volume);
  };
  const _audioMixerPeakNow = () => {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  };
  const _markAudioMixerPeak = (bus, value, holdMs = 120) => {
    const channel = Math.max(0, Math.min(2, bus | 0));
    const peak = Math.max(0, Math.min(1, Number(value) || 0));
    const now = _audioMixerPeakNow();
    const state = _audioMixerState.mixerPeaks[channel];
    state.value = Math.max(state.value || 0, peak);
    state.holdUntil = Math.max(state.holdUntil || 0, now + Math.max(50, Number(holdMs) || 0));
    state.decayUntil = Math.max(state.decayUntil || 0, state.holdUntil + 280);
  };
  const _fallbackAudioMixerPeak = (bus) => {
    const state = _audioMixerState.mixerPeaks[Math.max(0, Math.min(2, bus | 0))];
    if (!state) return 0;
    const now = _audioMixerPeakNow();
    if (now <= state.holdUntil) return state.value || 0;
    if (now >= state.decayUntil) {
      state.value = 0;
      return 0;
    }
    return (state.value || 0) * ((state.decayUntil - now) / Math.max(1, state.decayUntil - state.holdUntil));
  };
  const _attachAudioMixerAnalyser = (ac, source, destination, key) => {
    if (!ac || !source || !destination || typeof ac.createAnalyser !== 'function') {
      source.connect(destination);
      return null;
    }
    try {
      const analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(destination);
      ac[key] = analyser;
      return analyser;
    } catch (_) {
      source.connect(destination);
      return null;
    }
  };
  const _getAudioMaster = (ac) => {
    if (!ac) return null;
    if (!ac._wineMaster) {
      try {
        const m = ac.createGain();
        _attachAudioMixerAnalyser(ac, m, ac.destination, '_wineMasterAnalyser');
        ac._wineMaster = m;
      } catch (_) { return ac.destination; }
    }
    _audioMixerState.mixerContexts.add(ac);
    _applyAudioMixerVolume(ac, 0);
    return ac._wineMaster;
  };
  const _getAudioBus = (ac, bus) => {
    if (!ac || bus === 0) return _getAudioMaster(ac);
    const key = bus === 2 ? '_wineMidiBus' : '_wineWaveBus';
    if (!ac[key]) {
      try {
        const node = ac.createGain();
        _attachAudioMixerAnalyser(
          ac, node, _getAudioMaster(ac), bus === 2 ? '_wineMidiAnalyser' : '_wineWaveAnalyser');
        ac[key] = node;
      } catch (_) { return _getAudioMaster(ac); }
    }
    _audioMixerState.mixerContexts.add(ac);
    _applyAudioMixerVolume(ac, bus);
    return ac[key];
  };
  const _setAudioMixerVolume = (bus, packed) => {
    const channel = Math.max(0, Math.min(2, bus | 0));
    _audioMixerState.mixerVolumes[channel] = packed >>> 0;
    for (const ac of _audioMixerState.mixerContexts) _applyAudioMixerVolume(ac, channel);
  };
  ctx.setAudioMixerVolume = _setAudioMixerVolume;
  const _readAudioMixerAnalyser = (analyser) => {
    if (!analyser) return 0;
    try {
      const length = Math.max(32, analyser.fftSize || 256);
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        const samples = analyser._winePeakFloat && analyser._winePeakFloat.length === length
          ? analyser._winePeakFloat : (analyser._winePeakFloat = new Float32Array(length));
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
        return Math.min(1, peak);
      }
      if (typeof analyser.getByteTimeDomainData === 'function') {
        const samples = analyser._winePeakBytes && analyser._winePeakBytes.length === length
          ? analyser._winePeakBytes : (analyser._winePeakBytes = new Uint8Array(length));
        analyser.getByteTimeDomainData(samples);
        let peak = 0;
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i] - 128) / 128);
        return Math.min(1, peak);
      }
    } catch (_) {}
    return 0;
  };
  const _getAudioMixerPeak = (bus) => {
    const channel = Math.max(0, Math.min(2, bus | 0));
    if (_audioMixerState.mixerMutes[channel]) return 0;
    const analyserKey = channel === 0 ? '_wineMasterAnalyser' :
      channel === 1 ? '_wineWaveAnalyser' : '_wineMidiAnalyser';
    let peak = 0;
    for (const ac of _audioMixerState.mixerContexts) {
      peak = Math.max(peak, _readAudioMixerAnalyser(ac && ac[analyserKey]));
    }
    const masterGain = _audioMixerState.mixerMutes[0] ? 0 : _mixerGain(_audioMixerState.mixerVolumes[0]);
    if (channel === 0) {
      const waveGain = _audioMixerState.mixerMutes[1] ? 0 : _mixerGain(_audioMixerState.mixerVolumes[1]);
      const midiGain = _audioMixerState.mixerMutes[2] ? 0 : _mixerGain(_audioMixerState.mixerVolumes[2]);
      peak = Math.max(peak,
        _fallbackAudioMixerPeak(1) * waveGain * masterGain,
        _fallbackAudioMixerPeak(2) * midiGain * masterGain);
    } else {
      const gain = _audioMixerState.mixerMutes[channel] ? 0 : _mixerGain(_audioMixerState.mixerVolumes[channel]);
      peak = Math.max(peak, _fallbackAudioMixerPeak(channel) * gain);
    }
    return Math.max(0, Math.min(32767, Math.round(peak * 32767)));
  };

  const _measurePcmPeak = (mem, ptr, len, channels, bits) => {
    const bytesPerSample = bits === 16 ? 2 : bits === 8 ? 1 : 0;
    if (!mem || !bytesPerSample || len <= 0 || channels <= 0) return 0;
    const end = Math.min(mem.length, ptr + len);
    let peak = 0;
    for (let off = ptr; off + bytesPerSample <= end; off += bytesPerSample) {
      let sample;
      if (bits === 16) {
        const raw = mem[off] | (mem[off + 1] << 8);
        sample = Math.abs((raw > 32767 ? raw - 65536 : raw) / 32768);
      } else {
        sample = Math.abs((mem[off] - 128) / 128);
      }
      if (sample > peak) peak = sample;
    }
    return Math.min(1, peak);
  };

  // ---- Voice manager ----------------------------------------------------
  // Single owner of the AudioContext + per-voice gain/pan graph. waveOut and
  // DSOUND both go through this. Each voice has a sample format and a
  // GainNode→(StereoPannerNode)→destination chain; PCM is decoded from guest
  // memory on submit and queued as AudioBufferSourceNodes.
  const _audioDoneState = ctx.sharedAudio || ctx;
  if (!_audioDoneState.waveDoneQueue) _audioDoneState.waveDoneQueue = [];
  const _audioClockMs = () => {
    if (typeof ctx.audioClockMs === 'function') return ctx.audioClockMs();
    if (ctx.sharedAudio && typeof ctx.sharedAudio.audioClockMs === 'function') return ctx.sharedAudio.audioClockMs();
    return null;
  };
  const _audioWallMs = () => {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  };
  const _markWaveOutHot = (ms) => {
    const now = _audioWallMs();
    const hotMs = Math.max(250, Number.isFinite(ms) ? ms : 250);
    _audioDoneState.lastWaveActivityAt = now;
    _audioDoneState.waveOutHotUntilMs = Math.max(_audioDoneState.waveOutHotUntilMs || 0, now + hotMs);
  };
  const _markWaveOutPending = (delta) => {
    const next = ((_audioDoneState.pendingWaveDoneCount || 0) + delta) | 0;
    _audioDoneState.pendingWaveDoneCount = Math.max(0, next);
    _markWaveOutHot(250);
  };
  if (!_audioDoneState.waveOutOpenHandles) _audioDoneState.waveOutOpenHandles = new Set();
  if (!_audioDoneState.waveScheduledHeaders) _audioDoneState.waveScheduledHeaders = new Map();

  const _trackWaveOutHeader = (handle, waveHdrWA, waveHdrGA) => {
    if (!waveHdrWA) return;
    const key = handle >>> 0;
    let headers = _audioDoneState.waveScheduledHeaders.get(key);
    if (!headers) {
      headers = new Map();
      _audioDoneState.waveScheduledHeaders.set(key, headers);
    }
    headers.set(waveHdrWA >>> 0, waveHdrGA >>> 0);
  };

  const _untrackWaveOutHeader = (handle, waveHdrWA) => {
    if (!waveHdrWA || !_audioDoneState.waveScheduledHeaders) return;
    const key = handle >>> 0;
    const headers = _audioDoneState.waveScheduledHeaders.get(key);
    if (!headers) return;
    headers.delete(waveHdrWA >>> 0);
    if (!headers.size) _audioDoneState.waveScheduledHeaders.delete(key);
  };

  function _completeWaveOutDone(handle, waveHdrWA, waveHdrGA) {
    try {
      _untrackWaveOutHeader(handle, waveHdrWA);
      const dv = new DataView(ctx.getMemory());
      let wasInQueue = true;
      if (waveHdrWA) {
        const flags = dv.getUint32(waveHdrWA + 16, true);
        wasInQueue = (flags & 0x10) !== 0;
        dv.setUint32(waveHdrWA + 16, (flags | 1) & ~0x10, true); // WHDR_DONE, clear WHDR_INQUEUE
      }
      if (!wasInQueue) return 0;
      _markWaveOutPending(-1);
      const cbType = dv.getUint32(0xD16C, true);
      const cbHandle = dv.getUint32(0xD164, true);
      if (cbType === 5 && cbHandle && host.set_event) host.set_event(cbHandle);
      if (cbType === 1 && cbHandle) {
        const e = ctx.exports || (ctx.renderer && ctx.renderer.wasm && ctx.renderer.wasm.exports);
        if (e && typeof e.post_message_q === 'function') {
          e.post_message_q(cbHandle >>> 0, 0x03BD, handle >>> 0, waveHdrGA >>> 0);
        }
      }
      return 1;
    } catch (_) {
      return 0;
    }
  }

  const _pumpWaveOutCompletions = () => {
    const nowMs = _audioClockMs();
    if (nowMs === null) return 0;
    const q = _audioDoneState.waveDoneQueue || [];
    let write = 0;
    let completed = 0;
    for (let read = 0; read < q.length; read++) {
      const item = q[read];
      if (item && item.dueMs <= nowMs) {
        completed += _completeWaveOutDone(item.handle, item.waveHdrWA, item.waveHdrGA);
      } else {
        q[write++] = item;
      }
    }
    q.length = write;
    return completed;
  };

  const _completeWaveOutHandle = (handle) => {
    let completed = 0;
    const key = handle >>> 0;
    const headers = _audioDoneState.waveScheduledHeaders &&
      _audioDoneState.waveScheduledHeaders.get(key);
    if (headers && headers.size) {
      for (const [waveHdrWA, waveHdrGA] of Array.from(headers.entries())) {
        completed += _completeWaveOutDone(key, waveHdrWA, waveHdrGA);
      }
    }
    return completed;
  };

  // ---- waveIn capture --------------------------------------------------
  // Capture devices and queued WAVEHDRs are shared with worker imports in
  // the same app. Browser input is converted to the guest PCM format before
  // being copied into those buffers.
  const _waveIn = _audioDoneState.waveIn || (_audioDoneState.waveIn = {
    nextHandle: 0x0A0001,
    devices: new Map(),
  });

  const _reportWaveInError = (device, error) => {
    const message = error && error.message ? error.message : String(error || 'microphone unavailable');
    if (device) device.lastError = message;
    _audioDoneState.waveInLastError = message;
    if (typeof ctx.onAudioCaptureError === 'function') {
      try { ctx.onAudioCaptureError(message); } catch (_) {}
    }
    console.warn('[waveIn] microphone acquisition failed:', message);
  };

  const _postWaveInMessage = (device, msg, waveHdrGA = 0) => {
    if (!device) return;
    if (device.callbackType === 1 && device.callback) {
      const e = ctx.exports || (ctx.renderer && ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (e && typeof e.post_message_q === 'function') {
        e.post_message_q(device.callback >>> 0, msg >>> 0, device.handle >>> 0, waveHdrGA >>> 0);
      }
    } else if (device.callbackType === 5 && device.callback && host.set_event) {
      host.set_event(device.callback >>> 0);
    }
  };

  const _completeWaveInBuffer = (device, buffer) => {
    if (!device || !buffer) return 0;
    try {
      const dv = new DataView(ctx.getMemory());
      dv.setUint32(buffer.waveHdrWA + 8, buffer.written >>> 0, true);
      const flags = dv.getUint32(buffer.waveHdrWA + 16, true);
      dv.setUint32(buffer.waveHdrWA + 16, (flags | 1) & ~0x10, true); // DONE, clear INQUEUE
      _postWaveInMessage(device, 0x03C0, buffer.waveHdrGA); // MM_WIM_DATA
      return 1;
    } catch (_) {
      return 0;
    }
  };

  const _flushWaveIn = (device, all) => {
    if (!device || !device.queue.length) return 0;
    let completed = 0;
    if (!all) {
      const first = device.queue[0];
      if (first && first.written > 0) {
        device.queue.shift();
        completed += _completeWaveInBuffer(device, first);
      }
      return completed;
    }
    while (device.queue.length) completed += _completeWaveInBuffer(device, device.queue.shift());
    return completed;
  };

  const _stopWaveInNodes = (device) => {
    if (!device) return;
    for (const node of [device.source, device.processor, device.silentGain]) {
      try { if (node && node.disconnect) node.disconnect(); } catch (_) {}
    }
    if (device.stream && device.stream.getTracks) {
      for (const track of device.stream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
    }
    device.source = null;
    device.processor = null;
    device.silentGain = null;
    device.stream = null;
  };

  const _feedWaveInPcm = (handle, channelData, sourceRate) => {
    let device = _waveIn.devices.get(handle >>> 0);
    if (!device && !handle) device = _waveIn.devices.values().next().value;
    if (!device || !device.running || !device.queue.length) return 0;
    const channels = Array.isArray(channelData) ? channelData : [channelData];
    if (!channels.length || !channels[0] || !channels[0].length) return 0;
    const frames = channels.reduce((n, data) => Math.min(n, data.length), channels[0].length);
    const ratio = Math.max(1, sourceRate || device.rate) / Math.max(1, device.rate);
    const bytesPerSample = device.bits === 16 ? 2 : 1;
    const bytes = new Uint8Array(ctx.getMemory());
    let phase = Number.isFinite(device.resamplePhase) ? device.resamplePhase : 0;
    let writtenFrames = 0;
    while (phase < frames && device.queue.length) {
      const sourceFrame = Math.min(frames - 1, Math.floor(phase));
      const buffer = device.queue[0];
      if (buffer.written + bytesPerSample * device.channels > buffer.length) {
        device.queue.shift();
        _completeWaveInBuffer(device, buffer);
        continue;
      }
      let mono = 0;
      for (const data of channels) mono += Number(data[sourceFrame]) || 0;
      mono /= channels.length;
      for (let ch = 0; ch < device.channels; ch++) {
        const sample = Math.max(-1, Math.min(1,
          device.channels === 1 ? mono : Number((channels[ch] || channels[0])[sourceFrame]) || 0));
        const ptr = buffer.dataWA + buffer.written;
        if (device.bits === 16) {
          const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
          bytes[ptr] = value & 0xFF;
          bytes[ptr + 1] = (value >> 8) & 0xFF;
        } else {
          bytes[ptr] = Math.max(0, Math.min(255, Math.round((sample + 1) * 127.5)));
        }
        buffer.written += bytesPerSample;
      }
      writtenFrames++;
      phase += ratio;
      if (buffer.written >= buffer.length) {
        device.queue.shift();
        _completeWaveInBuffer(device, buffer);
      }
    }
    device.resamplePhase = phase - frames;
    device.capturedFrames = (device.capturedFrames || 0) + writtenFrames;
    return writtenFrames;
  };

  function _decodePcm(audioCtx, mem, ptr, len, channels, bits, rate) {
    const profileStartedAt = _profileNow();
    const bps = bits / 8;
    const numSamples = (len / (bps * channels)) | 0;
    let ok = false;
    try {
      if (numSamples <= 0) return null;
      const buf = audioCtx.createBuffer(channels, numSamples, rate);
      for (let ch = 0; ch < channels; ch++) {
        const dst = buf.getChannelData(ch);
        for (let i = 0; i < numSamples; i++) {
          const off = ptr + (i * channels + ch) * bps;
          if (bits === 16) {
            const s = mem[off] | (mem[off + 1] << 8);
            dst[i] = (s > 32767 ? s - 65536 : s) / 32768;
          } else if (bits === 8) {
            dst[i] = (mem[off] - 128) / 128;
          }
        }
      }
      ok = true;
      return buf;
    } finally {
      _profileEvent('audio.decodePcm', profileStartedAt, { bytes: len | 0, samples: numSamples | 0, channels: channels | 0, bits: bits | 0, rate: rate | 0, ok });
    }
  }
  let _voices;
  if (ctx.sharedAudio && ctx.sharedAudio.voices) {
    _voices = ctx._voices = ctx.sharedAudio.voices;
  } else {
    _voices = ctx._voices = {
      _next: 0x0B0001,
      _map: {},
      _ac: null,
      _unlockInstalled: false,
      _installUnlock() {
        if (this._unlockInstalled || typeof window === 'undefined') return;
        this._unlockInstalled = true;
        const unlock = () => {
          let ac = this._ac;
          if (ac && ac.state === 'closed') {
            this._ac = null;
            if (ctx._audioCtx === ac) ctx._audioCtx = null;
            ac = null;
          }
          if (!ac) ac = ctx._audioCtx;
          if (ac && ac.state === 'closed') {
            if (ctx._audioCtx === ac) ctx._audioCtx = null;
            ac = null;
          }
          if (!ac) ac = this._ensureCtx(44100);
          if (ac && ac.state === 'suspended') {
            try { ac.resume(); } catch (_) {}
          }
        };
        window.addEventListener('pointerdown', unlock, { passive: true });
        window.addEventListener('keydown', unlock, { passive: true });
        window.addEventListener('click', unlock, { passive: true });
      },
      _ensureCtx(rate) {
        if (this._ac && this._ac.state === 'closed') this._ac = null;
        if (ctx._audioCtx && ctx._audioCtx.state === 'closed') ctx._audioCtx = null;
        if (this._ac) return this._ac;
        if (ctx._audioCtx) {
          this._ac = ctx._audioCtx;
          this._installUnlock();
          return this._ac;
        }
        const AC = (typeof AudioContext !== 'undefined') ? AudioContext :
                   (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
        if (!AC) return null;
        try { this._ac = new AC({ sampleRate: rate }); }
        catch (_) {
          try { this._ac = new AC(); } catch (_) { this._ac = null; }
        }
        if (this._ac) ctx._audioCtx = this._ac;
        this._installUnlock();
        return this._ac;
      },
      open(rate, channels, bits) {
        const id = this._next++;
        const v = {
          id, rate, channels, bits,
          mode: null,
          bytesWritten: 0,
          nextTime: 0,
          streamStartTime: null,
          streamStartTimeMs: null,
          nextDoneTimeMs: null,
          sources: new Set(),
          timers: new Set(),
          gain: null,
          pan: null,
          freq: rate,
          currentSrc: null,
          playStart: 0,
          lastDuration: 0,
        };
        const ac = this._ensureCtx(rate);
        if (ac) {
          v.gain = ac.createGain();
          const _master = _getAudioBus(ac, 1);
          try { v.pan = ac.createStereoPanner(); v.gain.connect(v.pan); v.pan.connect(_master); }
          catch (_) { v.gain.connect(_master); }
          v.nextTime = ac.currentTime;
        }
        this._map[id] = v;
        return id;
      },
      writeStream(id, ptr, len) {
        const profileStartedAt = _profileNow();
        const v = this._map[id]; if (!v) return;
        let scheduled = false;
        try {
          v.mode = 'stream';
          v.bytesWritten += len;
          const pcm = new Uint8Array(ctx.getMemory());
          const durationMs = len / Math.max(1, v.rate * v.channels * (v.bits / 8)) * 1000;
          _markAudioMixerPeak(1, _measurePcmPeak(pcm, ptr, len, v.channels, v.bits), durationMs);
          const ac = this._ac;
          if (!ac) {
            const nowMs = _audioClockMs();
            if (nowMs !== null && v.streamStartTimeMs === null) v.streamStartTimeMs = nowMs;
            return;
          }
          try {
            const buf = _decodePcm(ac, pcm, ptr, len, v.channels, v.bits, v.rate);
            if (!buf) return;
            const src = ac.createBufferSource();
            src.buffer = buf;
            src.connect(v.gain || _getAudioBus(ac, 1));
            const t = Math.max(ac.currentTime, v.nextTime);
            src.onended = () => v.sources.delete(src);
            src.start(t);
            scheduled = true;
            v.sources.add(src);
            if (v.streamStartTime === null) v.streamStartTime = t;
            v.nextTime = t + buf.duration;
          } catch (_) {}
        } finally {
          _profileEvent('audio.writeStream', profileStartedAt, { id: id >>> 0, bytes: len | 0, scheduled });
        }
      },
      playRing(id, ptr, len, startOff, loop) {
        const v = this._map[id]; if (!v) return;
        v.mode = 'snapshot';
        const pcm = new Uint8Array(ctx.getMemory());
        const playLength = Math.max(0, len - (startOff | 0));
        const durationMs = playLength / Math.max(1, v.rate * v.channels * (v.bits / 8)) * 1000;
        _markAudioMixerPeak(1,
          _measurePcmPeak(pcm, ptr + (startOff | 0), playLength, v.channels, v.bits),
          loop ? 500 : durationMs);
        const ac = this._ac; if (!ac) return;
        try {
          const buf = _decodePcm(ac, pcm, ptr + (startOff | 0), playLength,
                                 v.channels, v.bits, v.rate);
          if (!buf) return;
          if (v.currentSrc) { try { v.currentSrc.stop(); } catch (_) {} v.currentSrc = null; }
          const src = ac.createBufferSource();
          src.buffer = buf;
          src.loop = !!loop;
          if (v.freq && v.freq !== v.rate) src.playbackRate.value = v.freq / v.rate;
          src.connect(v.gain || _getAudioBus(ac, 1));
          v.playStart = ac.currentTime;
          v.lastDuration = buf.duration;
          src.start(v.playStart);
          v.currentSrc = src;
        } catch (_) {}
      },
      stop(id) {
        const v = this._map[id]; if (!v) return;
        if (v.currentSrc) { try { v.currentSrc.stop(); } catch (_) {} v.currentSrc = null; }
        if (v.sources && v.sources.size) {
          for (const src of Array.from(v.sources)) {
            try { src.stop(0); } catch (_) {}
          }
          v.sources.clear();
        }
        if (v.timers && v.timers.size) {
          for (const timer of Array.from(v.timers)) {
            try { clearTimeout(timer); } catch (_) {}
          }
          v.timers.clear();
        }
        if (v.mode === 'stream') {
          v.bytesWritten = 0;
          v.streamStartTime = null;
          v.streamStartTimeMs = null;
          v.nextTime = this._ac ? this._ac.currentTime : 0;
          v.nextDoneTimeMs = null;
          if (_audioDoneState.waveDoneQueue && _audioDoneState.waveDoneQueue.length) {
            _audioDoneState.waveDoneQueue = _audioDoneState.waveDoneQueue.filter(item => (item.handle >>> 0) !== (id >>> 0));
          }
        }
      },
      close(id) {
        this.stop(id);
        delete this._map[id];
      },
      getPos(id) {
        const v = this._map[id]; if (!v) return 0;
        const bytesPerSec = v.rate * v.channels * (v.bits / 8);
        // For STREAM/waveOut voices, report bytes that have actually reached
        // the AudioContext clock. If there is no browser audio clock (CLI PCM
        // capture), fall back to submitted bytes so headless decode keeps moving.
        if (v.mode === 'stream') {
          if (!this._ac) {
            const nowMs = _audioClockMs();
            if (nowMs === null || v.streamStartTimeMs === null) return v.bytesWritten;
            const elapsed = Math.max(0, (nowMs - v.streamStartTimeMs) / 1000);
            const rateScale = v.freq && v.freq !== v.rate ? (v.freq / v.rate) : 1;
            const played = Math.floor(elapsed * bytesPerSec * rateScale);
            return Math.max(0, Math.min(v.bytesWritten, played));
          }
          if (v.streamStartTime === null) return v.bytesWritten;
          const elapsed = Math.max(0, this._ac.currentTime - v.streamStartTime);
          const rateScale = v.freq && v.freq !== v.rate ? (v.freq / v.rate) : 1;
          const played = Math.floor(elapsed * bytesPerSec * rateScale);
          return Math.max(0, Math.min(v.bytesWritten, played));
        }
        // For SNAPSHOT voices, derive cursor from elapsed audio time.
        if (v.currentSrc && v.lastDuration > 0 && this._ac) {
          const elapsed = this._ac.currentTime - v.playStart;
          const cursor = (elapsed * bytesPerSec) | 0;
          const total = (v.lastDuration * bytesPerSec) | 0;
          return total > 0 ? (cursor % total) : 0;
        }
        return v.bytesWritten;
      },
      setGain(id, g) { const v = this._map[id]; if (v && v.gain) v.gain.gain.value = g; },
      setPan(id, p)  { const v = this._map[id]; if (v && v.pan) v.pan.pan.value = p; },
      setFreq(id, hz) {
        const v = this._map[id]; if (!v) return;
        v.freq = hz || v.rate;
        if (v.currentSrc) { try { v.currentSrc.playbackRate.value = v.freq / v.rate; } catch (_) {} }
      },
    };
    if (ctx.sharedAudio) ctx.sharedAudio.voices = _voices;
  }
  _voices._installUnlock();

  // ---- MCI sequencer / MIDI bridge -------------------------------------
  const _mci = ctx._mci = ctx._mci || {
    nextId: 1,
    devices: new Map(),
  };
  if (!_mci.aliases) _mci.aliases = new Map();

  const _midiOut = ctx._midiOut = ctx._midiOut || {
    nextHandle: 0x0C0001,
    devices: new Map(),
    defaultVolume: 0xFFFFFFFF,
  };
  const _midiMasterGain = 1.0;
  const _tinySynthMasterGain = 0.35;
  const _midiSequencerNoteGain = 0.22;
  const _midiOutNoteGain = 0.30;

  const _tinySynthCtor = () => {
    if (ctx.midiBackend === 'oscillator') return null;
    if (ctx.WebAudioTinySynth) return ctx.WebAudioTinySynth;
    if (typeof WebAudioTinySynth !== 'undefined') return WebAudioTinySynth;
    if (typeof window !== 'undefined' && window.WebAudioTinySynth) return window.WebAudioTinySynth;
    if (typeof globalThis !== 'undefined' && globalThis.WebAudioTinySynth) return globalThis.WebAudioTinySynth;
    return null;
  };

  const _ensureTinySynth = (ac) => {
    const Ctor = _tinySynthCtor();
    if (!Ctor || !ac) return null;
    if (ctx._tinySynth && ctx._tinySynth.ac === ac) return ctx._tinySynth.synth;
    try {
      const synth = new Ctor({ quality: 1, useReverb: 1, voices: 64, internalcontext: 0, internalContext: 0 });
      if (synth.setAudioContext) synth.setAudioContext(ac, _getAudioBus(ac, 2));
      if (synth.setTsMode) synth.setTsMode(0);
      if (synth.setMasterVol) synth.setMasterVol(_tinySynthMasterGain);
      ctx._tinySynth = { ac, synth };
      console.log('[MIDI] using WebAudioTinySynth backend');
      return synth;
    } catch (e) {
      console.warn('[MIDI] WebAudioTinySynth init failed, falling back to oscillator synth:', e);
      ctx.midiBackend = 'oscillator';
      return null;
    }
  };

  const _writeStrA = (ptr, len, s) => {
    if (!ptr || !len) return;
    const mem = new Uint8Array(ctx.getMemory());
    const n = Math.max(0, Math.min(len - 1, String(s).length));
    for (let i = 0; i < n; i++) mem[ptr + i] = String(s).charCodeAt(i) & 0xFF;
    mem[ptr + n] = 0;
  };

  const _readVfsFile = (path) => {
    if (!path) return null;
    if (ctx.readFile) {
      try {
        const data = ctx.readFile(path);
        if (data && data.length) return data instanceof Uint8Array ? data : new Uint8Array(data);
      } catch (_) {}
    }
    const vfs = ctx.vfs;
    if (!vfs || !vfs.files) return null;
    const candidates = [];
    try { candidates.push(vfs._resolvePath(path)); } catch (_) {}
    candidates.push(path.toLowerCase().replace(/\//g, '\\'));
    const base = path.replace(/\//g, '\\').split('\\').pop().toLowerCase();
    for (const p of candidates) {
      const entry = vfs.files.get(p);
      if (entry && entry.data) return entry.data;
    }
    for (const [p, entry] of vfs.files) {
      const name = String(p).split('\\').pop();
      if (name === base && entry && entry.data) return entry.data;
    }
    return null;
  };

  const _extractSmfBytes = (bytes) => {
    if (!bytes || bytes.length < 14) return null;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const text4 = (p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (text4(0) === 'MThd') return u8;
    if (u8.length >= 24 && text4(0) === 'RIFF' && text4(8) === 'RMID') {
      const le32 = (p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
      let p = 12;
      while (p + 8 <= u8.length) {
        const id = text4(p);
        const size = le32(p + 4);
        const dataStart = p + 8;
        const dataEnd = dataStart + size;
        if (dataEnd > u8.length) break;
        if (id === 'data') {
          const payload = u8.subarray(dataStart, dataEnd);
          return payload.length >= 14 && String.fromCharCode(payload[0], payload[1], payload[2], payload[3]) === 'MThd'
            ? payload
            : null;
        }
        p = dataEnd + (size & 1);
      }
    }
    return null;
  };

  const _parseSmf = (bytes) => {
    const u8 = _extractSmfBytes(bytes);
    if (!u8) return null;
    const text4 = (p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const u16 = (p) => (u8[p] << 8) | u8[p + 1];
    const u32 = (p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
    const varLen = (state, end) => {
      let v = 0, b = 0;
      do {
        if (state.p >= end) return v;
        b = u8[state.p++];
        v = (v << 7) | (b & 0x7F);
      } while (b & 0x80);
      return v >>> 0;
    };
    const hdrLen = u32(4);
    const tracks = u16(10);
    const division = u16(12);
    if (!division || (division & 0x8000)) return null;
    const trackEvents = [];
    const tempos = [{ tick: 0, usPerQn: 500000 }];
    let p = 8 + hdrLen;
    for (let tr = 0; tr < tracks && p + 8 <= u8.length; tr++) {
      if (text4(p) !== 'MTrk') break;
      const end = Math.min(u8.length, p + 8 + u32(p + 4));
      const state = { p: p + 8 };
      let tick = 0;
      let running = 0;
      while (state.p < end) {
        tick += varLen(state, end);
        let status = u8[state.p++];
        if (status < 0x80) {
          state.p--;
          status = running;
        } else if (status < 0xF0) {
          running = status;
        }
        if (status === 0xFF) {
          const type = u8[state.p++];
          const len = varLen(state, end);
          if (type === 0x51 && len === 3 && state.p + 3 <= end) {
            const usPerQn = (u8[state.p] << 16) | (u8[state.p + 1] << 8) | u8[state.p + 2];
            const prev = tempos[tempos.length - 1];
            if (prev && prev.tick === tick) prev.usPerQn = usPerQn;
            else tempos.push({ tick, usPerQn });
          }
          state.p += len;
          continue;
        }
        if (status === 0xF0 || status === 0xF7) {
          state.p += varLen(state, end);
          continue;
        }
        const op = status & 0xF0;
        const ch = status & 0x0F;
        const a = u8[state.p++] || 0;
        const hasB = op !== 0xC0 && op !== 0xD0;
        const b = hasB ? (u8[state.p++] || 0) : 0;
        const raw = hasB ? [status, a, b] : [status, a];
        if (op === 0x90 && b > 0) trackEvents.push({ tick, type: 'on', ch, note: a, vel: b, raw });
        else if (op === 0x80 || (op === 0x90 && b === 0)) trackEvents.push({ tick, type: 'off', ch, note: a, vel: b, raw });
        else if (op === 0xC0) trackEvents.push({ tick, type: 'program', ch, program: a, raw });
        else if (op === 0xB0) trackEvents.push({ tick, type: 'cc', ch, cc: a, value: b, raw });
        else if (op === 0xE0) trackEvents.push({ tick, type: 'pitch', ch, value: ((b << 7) | a) - 8192, raw });
        else if (op === 0xD0) trackEvents.push({ tick, type: 'pressure', ch, value: a, raw });
        else if (op === 0xA0) trackEvents.push({ tick, type: 'polyPressure', ch, note: a, value: b, raw });
      }
      p = end;
    }
    tempos.sort((a, b) => a.tick - b.tick);
    const tickToSec = (tick) => {
      let sec = 0, lastTick = 0, us = 500000;
      for (const t of tempos) {
        if (t.tick > tick) break;
        sec += (t.tick - lastTick) * us / division / 1000000;
        lastTick = t.tick;
        us = t.usPerQn || us;
      }
      return sec + (tick - lastTick) * us / division / 1000000;
    };
    const events = trackEvents
      .sort((a, b) => a.tick - b.tick)
      .map(ev => ({ ...ev, time: tickToSec(ev.tick) }));
    const open = new Map();
    const notes = [];
    for (const ev of events) {
      if (ev.type === 'on') {
        const key = ev.ch + ':' + ev.note;
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(ev);
      } else if (ev.type === 'off') {
        const key = ev.ch + ':' + ev.note;
        const stack = open.get(key);
        const start = stack && stack.shift();
        if (start && ev.tick > start.tick) {
          notes.push({
            start: tickToSec(start.tick),
            dur: Math.max(0.03, tickToSec(ev.tick) - tickToSec(start.tick)),
            ch: start.ch,
            note: start.note,
            vel: start.vel,
          });
        }
      }
    }
    notes.sort((a, b) => a.start - b.start);
    const tempoEvents = tempos.map(t => ({ tick: t.tick, time: tickToSec(t.tick), usPerQn: t.usPerQn }));
    const eventDuration = events.reduce((m, ev) => Math.max(m, ev.time), 0);
    const noteDuration = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
    const duration = Math.max(eventDuration, noteDuration);
    return { events, notes, tempos: tempoEvents, division, duration };
  };

  const _mciNowMs = () => {
    if (typeof ctx.mciClockMs === 'function') {
      try {
        const v = ctx.mciClockMs();
        if (Number.isFinite(v)) return v;
      } catch (_) {}
    }
    const ac = (ctx._voices && ctx._voices._ac) || ctx._audioCtx;
    if (ac && Number.isFinite(ac.currentTime)) return ac.currentTime * 1000;
    const audioMs = _audioClockMs();
    if (Number.isFinite(audioMs)) return audioMs;
    return _audioWallMs();
  };

  const _mciLengthMs = (dev) => {
    const duration = (dev && dev.smf && Number.isFinite(dev.smf.duration)) ? dev.smf.duration : 0;
    return Math.max(0, Math.round(duration * 1000));
  };

  const _mciStartPlaybackClock = (dev, firstStart = 0) => {
    const now = _mciNowMs();
    const lengthMs = _mciLengthMs(dev);
    const startPositionMs = Math.min(lengthMs, Math.max(0, Math.round(firstStart * 1000)));
    const runMs = Math.max(0, lengthMs - startPositionMs);
    dev.playStartMs = now;
    dev.playStartPositionMs = startPositionMs;
    dev.playLengthMs = lengthMs;
    dev.playRunMs = runMs;
    dev.playEndMs = now + runMs + 100;
    dev.playPositionMs = startPositionMs;
  };

  const _mciMarkPlaybackDone = (dev) => {
    if (!dev) return;
    if (dev.scheduler) { clearInterval(dev.scheduler); dev.scheduler = null; }
    if (dev.timer) { clearTimeout(dev.timer); dev.timer = null; }
    dev.playPositionMs = Math.max(dev.playPositionMs || 0, dev.playLengthMs || _mciLengthMs(dev));
    dev.state = 'stopped';
  };

  const _mciRefreshPlaybackState = (dev) => {
    if (!dev) return 0;
    if (dev.state === 'playing') {
      const now = _mciNowMs();
      const start = Number.isFinite(dev.playStartMs) ? dev.playStartMs : now;
      const startPosition = Number.isFinite(dev.playStartPositionMs) ? dev.playStartPositionMs : 0;
      const lengthMs = Number.isFinite(dev.playLengthMs) ? dev.playLengthMs : _mciLengthMs(dev);
      const elapsed = Math.max(0, Math.round(now - start));
      dev.playPositionMs = lengthMs > 0 ? Math.min(lengthMs, startPosition + elapsed) : startPosition + elapsed;
      const end = Number.isFinite(dev.playEndMs) ? dev.playEndMs : start + lengthMs;
      if (now >= end) _mciMarkPlaybackDone(dev);
    }
    return Math.max(0, Math.round(dev.playPositionMs || 0));
  };

  const _midiSchedule = (dev) => {
    if (!dev || !dev.smf || !dev.smf.notes.length) {
      _midiStop(dev);
      return 0;
    }
    const ac = ctx._voices._ensureCtx(44100);
    if (!ac) {
      _midiStop(dev);
      return 0;
    }
    if (ac.state === 'suspended') {
      try { ac.resume(); } catch (_) {}
    }
    const tiny = _ensureTinySynth(ac);
    const firstStart = ctx.trimMidiLeadIn && dev.smf.notes.length ? dev.smf.notes[0].start : 0;
    if (tiny && dev.smf.events && dev.smf.events.length) {
      _midiStop(dev);
      dev.state = 'playing';
      dev.nodes = [];
      dev.tinySynth = tiny;
      dev.midiCursor = 0;
      _mciStartPlaybackClock(dev, firstStart);
      dev.midiBaseTime = ac.currentTime + 0.08 - firstStart;
      const pumpTiny = () => {
        if (!dev || dev.state !== 'playing') return;
        const events = dev.smf.events;
        const until = ac.currentTime + 0.85;
        let scheduled = 0;
        while (dev.midiCursor < events.length &&
               dev.midiBaseTime + events[dev.midiCursor].time <= until &&
               scheduled < 1024) {
          const ev = events[dev.midiCursor++];
          try { tiny.send(ev.raw, dev.midiBaseTime + ev.time); } catch (_) {}
          scheduled++;
        }
        if (dev.midiCursor >= events.length && dev.scheduler) {
          clearInterval(dev.scheduler);
          dev.scheduler = null;
        }
      };
      pumpTiny();
      dev.scheduler = setInterval(pumpTiny, 100);
      if (dev.timer) clearTimeout(dev.timer);
      dev.timer = setTimeout(() => {
        _mciMarkPlaybackDone(dev);
      }, Math.max(1, (dev.playRunMs || 0) + 100));
      return 0;
    }
    _midiStop(dev);
    dev.state = 'playing';
    dev.nodes = [];
    dev.midiCursor = 0;
    _mciStartPlaybackClock(dev, firstStart);
    const master = ac.createGain();
    dev.master = master;
    master.gain.value = _midiMasterGain;
    master.connect(_getAudioBus(ac, 2));
    dev.nodes.push(master);
    dev.midiBaseTime = ac.currentTime + 0.08 - firstStart;
    const scheduleOne = (n) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const freq = 440 * Math.pow(2, (n.note - 69) / 12);
      const start = dev.midiBaseTime + n.start;
      const end = start + Math.min(n.dur, 8);
      osc.type = n.ch === 9 ? 'square' : 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.002, (n.vel / 127) * _midiSequencerNoteGain), start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain);
      gain.connect(master);
      try {
        osc.start(start);
        osc.stop(end + 0.03);
        osc.onended = () => {
          try { osc.disconnect(); } catch (_) {}
          try { gain.disconnect(); } catch (_) {}
        };
        dev.nodes.push(osc);
      } catch (_) {}
    };
    const pump = () => {
      if (!dev || dev.state !== 'playing') return;
      const notes = dev.smf.notes;
      const until = ac.currentTime + 0.85;
      let scheduled = 0;
      while (dev.midiCursor < notes.length &&
             dev.midiBaseTime + notes[dev.midiCursor].start <= until &&
             scheduled < 512) {
        scheduleOne(notes[dev.midiCursor++]);
        scheduled++;
      }
      if (dev.midiCursor >= notes.length && dev.scheduler) {
        clearInterval(dev.scheduler);
        dev.scheduler = null;
      }
    };
    pump();
    dev.scheduler = setInterval(pump, 100);
    if (dev.timer) clearTimeout(dev.timer);
    dev.timer = setTimeout(() => {
      _mciMarkPlaybackDone(dev);
    }, Math.max(1, (dev.playRunMs || 0) + 100));
    return 0;
  };

  function _midiStop(dev) {
    if (!dev) return;
    if (dev.scheduler) { clearInterval(dev.scheduler); dev.scheduler = null; }
    if (dev.timer) { clearTimeout(dev.timer); dev.timer = null; }
    if (dev.tinySynth) {
      for (let ch = 0; ch < 16; ch++) {
        try {
          if (dev.tinySynth.allSoundOff) dev.tinySynth.allSoundOff(ch);
          else dev.tinySynth.send([0xB0 | ch, 120, 0], 0);
        } catch (_) {}
      }
      dev.tinySynth = null;
    }
    if (dev.master && dev.master.gain) dev.master.gain.value = 0;
    if (dev.nodes) {
      for (const n of dev.nodes) {
        try { if (n.stop) n.stop(0); } catch (_) {}
        try { if (n.disconnect) n.disconnect(); } catch (_) {}
      }
    }
    dev.nodes = [];
    dev.state = 'stopped';
    dev.playStartMs = 0;
    dev.playStartPositionMs = 0;
    dev.playEndMs = 0;
    dev.playRunMs = 0;
    dev.playPositionMs = 0;
  }

  const _midiOutGainValue = (volume) => {
    const left = volume & 0xFFFF;
    const right = (volume >>> 16) & 0xFFFF;
    return Math.max(0, Math.min(1, ((left + right) / 2) / 0xFFFF));
  };

  const _midiOutEnsureMaster = (dev, ac) => {
    if (dev.master && !dev.master.disconnected) return dev.master;
    const master = ac.createGain();
    master.gain.value = _midiMasterGain * _midiOutGainValue(dev.volume);
    master.connect(_getAudioBus(ac, 2));
    dev.master = master;
    return master;
  };

  const _midiOutStopNote = (dev, key) => {
    const voice = dev && dev.active && dev.active.get(key);
    if (!voice) return;
    dev.active.delete(key);
    const ac = ctx._voices && ctx._voices._ac;
    const now = ac ? ac.currentTime : 0;
    try { voice.gain.gain.cancelScheduledValues && voice.gain.gain.cancelScheduledValues(now); } catch (_) {}
    try { voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value || 0.0001), now); } catch (_) {}
    try { voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04); } catch (_) {}
    try { voice.osc.stop(now + 0.06); } catch (_) {}
  };

  const _midiOutResetDevice = (dev) => {
    if (!dev) return 5; // MMSYSERR_INVALHANDLE
    if (dev.tinySynth) {
      for (let ch = 0; ch < 16; ch++) {
        try {
          if (dev.tinySynth.allSoundOff) dev.tinySynth.allSoundOff(ch);
          else dev.tinySynth.send([0xB0 | ch, 120, 0], 0);
        } catch (_) {}
      }
      dev.tinySynth = null;
    }
    for (const key of Array.from(dev.active.keys())) _midiOutStopNote(dev, key);
    if (dev.master) {
      try { dev.master.disconnect(); } catch (_) {}
      dev.master = null;
    }
    return 0;
  };

  const _midiOutNoteOn = (dev, ch, note, vel) => {
    if (!dev || !vel) return 5;
    const ac = ctx._voices._ensureCtx(44100);
    if (!ac) return 0;
    if (ac.state === 'suspended') {
      try { ac.resume(); } catch (_) {}
    }
    const key = ch + ':' + note;
    _midiOutStopNote(dev, key);
    const master = _midiOutEnsureMaster(dev, ac);
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const freq = 440 * Math.pow(2, (note - 69) / 12);
    const now = ac.currentTime;
    osc.type = ch === 9 ? 'square' : 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.002, (vel / 127) * _midiOutNoteGain), now + 0.01);
    osc.connect(gain);
    gain.connect(master);
    try {
      osc.start(now);
      dev.active.set(key, { osc, gain });
    } catch (_) {}
    return 0;
  };

  const _midiOutTinySend = (dev, raw) => {
    const ac = ctx._voices._ensureCtx(44100);
    const tiny = _ensureTinySynth(ac);
    if (!tiny) return false;
    if (ac && ac.state === 'suspended') {
      try { ac.resume(); } catch (_) {}
    }
    try {
      tiny.send(raw, ac ? ac.currentTime : 0);
      dev.tinySynth = tiny;
      return true;
    } catch (_) {
      return false;
    }
  };

  const _mciTokenize = (s) => {
    const out = [];
    String(s || '').replace(/"([^"]*)"|(\S+)/g, (_, q, bare) => {
      out.push(q != null ? q : bare);
      return '';
    });
    return out;
  };

  const _mciCommand = (hostId, command, flags, paramsWa) => {
    const dev = _mci.devices.get(hostId >>> 0);
    if (!dev) return 0x106; // MCIERR_INVALID_DEVICE_ID
    switch (command >>> 0) {
      case 0x080B: { // MCI_GETDEVCAPS
        if (paramsWa) {
          const dv = new DataView(ctx.getMemory());
          const item = dv.getUint32(paramsWa + 8, true);
          let value = 0;
          if (item === 2) value = 1; // MCI_GETDEVCAPS_HAS_AUDIO
          else if (item === 4) value = dev.type === 'sequencer' ? 0x20B : 0x20A;
          else if (item === 5) value = 1; // MCI_GETDEVCAPS_USES_FILES
          else if (item === 6) value = 1; // MCI_GETDEVCAPS_COMPOUND_DEVICE
          else if (item === 8) value = 1; // MCI_GETDEVCAPS_CAN_PLAY
          dv.setUint32(paramsWa + 4, value >>> 0, true);
        }
        return 0;
      }
      case 0x0804: // MCI_CLOSE
        _midiStop(dev);
        _mci.devices.delete(hostId >>> 0);
        return 0;
      case 0x0806: // MCI_PLAY
        if (dev.type === 'sequencer') {
          console.log(`[MCI] play sequencer id=${hostId >>> 0} element="${dev.element || ''}" notes=${dev.smf ? dev.smf.notes.length : 0}`);
        }
        return _midiSchedule(dev);
      case 0x0808: // MCI_STOP
      case 0x0809: // MCI_PAUSE
        _midiStop(dev);
        return 0;
      case 0x0855: // MCI_RESUME
        return _midiSchedule(dev);
      case 0x0814: { // MCI_STATUS
        if (paramsWa) {
          const dv = new DataView(ctx.getMemory());
          const item = dv.getUint32(paramsWa + 8, true);
          let ret = 0;
          _mciRefreshPlaybackState(dev);
          if (item === 4) ret = dev.state === 'playing' ? 526 : 525; // MCI_STATUS_MODE
          else if (item === 1) ret = Math.max(0, Math.round(((dev.smf && dev.smf.duration) || 0) * 1000));
          else if (item === 2) ret = _mciRefreshPlaybackState(dev);
          else if (item === 3) ret = 1;
          dv.setUint32(paramsWa + 4, ret >>> 0, true);
        }
        return 0;
      }
      default:
        return 0;
    }
  };

  const _mciStringCommand = (cmdWa, retWa, retLen) => {
    const cmd = cmdWa ? readStr(cmdWa, 512).trim() : '';
    if (!cmd) return 0;
    const tokens = _mciTokenize(cmd);
    const verb = (tokens[0] || '').toLowerCase();
    const lower = tokens.map(t => String(t).toLowerCase());
    const tokenAfter = (name) => {
      const i = lower.indexOf(name);
      return i >= 0 && i + 1 < tokens.length ? tokens[i + 1] : '';
    };
    if (verb === 'open') {
      let element = '';
      let type = tokenAfter('type');
      const alias = tokenAfter('alias');
      if (!type && lower[1] === 'sequencer') type = 'sequencer';
      if (tokens[1] && lower[1] !== 'type' && lower[1] !== 'alias' && lower[1] !== 'sequencer') element = tokens[1];
      if (!type && /\.m(id|idi|rmi)$/i.test(element)) type = 'sequencer';
      const data = _readVfsFile(element);
      const isSeq = type === 'sequencer' || /\.m(id|idi|rmi)$/i.test(element);
      const id = _mci.nextId++;
      const dev = {
        id,
        type: isSeq ? 'sequencer' : (type || 'auto'),
        element,
        smf: isSeq && data ? _parseSmf(data) : null,
        state: 'stopped',
        nodes: [],
        timer: null,
        playStartMs: 0,
        playStartPositionMs: 0,
        playEndMs: 0,
        playLengthMs: 0,
        playRunMs: 0,
        playPositionMs: 0,
      };
      _mci.devices.set(id, dev);
      _mci.aliases.set(alias || String(id), id);
      if (dev.type === 'sequencer') {
        console.log(`[MCI] open sequencer id=${id} element="${element || ''}" alias="${alias || ''}" notes=${dev.smf ? dev.smf.notes.length : 0}`);
      }
      return 0;
    }
    const name = tokens[1] || '';
    const id = _mci.aliases.get(name) || (Number(name) >>> 0);
    const dev = _mci.devices.get(id);
    if (!dev) return 0x106; // MCIERR_INVALID_DEVICE_ID
    if (verb === 'play') return _mciCommand(id, 0x0806, 0, 0);
    if (verb === 'stop' || verb === 'pause') return _mciCommand(id, verb === 'pause' ? 0x0809 : 0x0808, 0, 0);
    if (verb === 'resume') return _mciCommand(id, 0x0855, 0, 0);
    if (verb === 'close') {
      for (const [alias, aliasId] of Array.from(_mci.aliases.entries())) {
        if (aliasId === id) _mci.aliases.delete(alias);
      }
      return _mciCommand(id, 0x0804, 0, 0);
    }
    if (verb === 'status') {
      const item = lower.includes('length') ? 'length' :
                   lower.includes('position') ? 'position' :
                   lower.includes('mode') ? 'mode' :
                   lower.includes('tracks') ? 'tracks' : '';
      let value = '';
      _mciRefreshPlaybackState(dev);
      if (item === 'length') value = String(Math.max(0, Math.round(((dev.smf && dev.smf.duration) || 0) * 1000)));
      else if (item === 'position') value = String(_mciRefreshPlaybackState(dev));
      else if (item === 'mode') value = dev.state === 'playing' ? 'playing' : 'stopped';
      else if (item === 'tracks') value = '1';
      _writeStrA(retWa, retLen, value);
      return 0;
    }
    return 0;
  };

  const _mciOpen = (deviceTypeOrWa, elementWa, flags, isWide) => {
    const read = isWide ? readStrW : readStr;
    let type = '';
    if ((flags & 0x1000) === 0 && deviceTypeOrWa) {
      try { type = read(deviceTypeOrWa, 64).toLowerCase(); } catch (_) { type = ''; }
    } else if (deviceTypeOrWa) {
      type = String(deviceTypeOrWa >>> 0);
    }
    let element = elementWa ? read(elementWa, 260) : '';
    const typeLooksMidiFile = /\.m(id|idi|rmi)$/i.test(type);
    if (!element && typeLooksMidiFile) {
      element = type;
      type = 'sequencer';
    }
    const lower = element.toLowerCase();
    const isMidi = type === 'sequencer' || /\.m(id|idi|rmi)$/.test(lower);
    const data = _readVfsFile(element);
    const id = _mci.nextId++;
    const dev = {
      id,
      type: isMidi ? 'sequencer' : (type || 'auto'),
      element,
      smf: isMidi && data ? _parseSmf(data) : null,
      state: 'stopped',
      nodes: [],
      timer: null,
      playStartMs: 0,
      playStartPositionMs: 0,
      playEndMs: 0,
      playLengthMs: 0,
      playRunMs: 0,
      playPositionMs: 0,
    };
    _mci.devices.set(id, dev);
    if (isMidi) {
      console.log(`[MCI] open sequencer id=${id} element="${element || ''}" notes=${dev.smf ? dev.smf.notes.length : 0}`);
    }
    return id;
  };

  ctx.stopAudio = () => {
    for (const dev of Array.from(_mci.devices.values())) _midiStop(dev);
    _mci.devices.clear();
    if (_mci.aliases) _mci.aliases.clear();

    for (const dev of Array.from(_midiOut.devices.values())) _midiOutResetDevice(dev);
    _midiOut.devices.clear();

    if (_voices && _voices._map) {
      for (const id of Object.keys(_voices._map)) {
        try { _voices.close(Number(id)); } catch (_) {}
      }
    }

    if (ctx._tinySynth && ctx._tinySynth.synth) {
      const synth = ctx._tinySynth.synth;
      for (let ch = 0; ch < 16; ch++) {
        try {
          if (synth.allSoundOff) synth.allSoundOff(ch);
          else if (synth.send) synth.send([0xB0 | ch, 120, 0], 0);
        } catch (_) {}
      }
      try { if (synth.stopMIDI) synth.stopMIDI(); } catch (_) {}
      ctx._tinySynth = null;
    }

    const ac = (_voices && _voices._ac) || ctx._audioCtx;
    if (ac) {
      try {
        if (ac.close) ac.close();
        else if (ac.suspend) ac.suspend();
      } catch (_) {}
      if (ac._wineMaster && ac._wineMaster.gain) {
        try { ac._wineMaster.gain.value = 0; } catch (_) {}
      }
    }
    if (_audioMixerState.mixerContexts) _audioMixerState.mixerContexts.delete(ac);
    if (_voices) _voices._ac = null;
    ctx._audioCtx = null;
  };

  const _resolveSelectedFont = (hdc) => {
    const dc = _getDcState(hdc);
    return dc.selectedFont ? _fontResources[dc.selectedFont] || null : null;
  };

  // Resolve the CSS font string for a DC's currently selected font
  const _resolveFont = (hdc) => {
    const dc = _getDcState(hdc);
    const font = _resolveSelectedFont(hdc);
    if (font && font.css) {
        const sy = Math.abs((dc.vpExtY || 1) / (dc.winExtY || 1));
        if (Number.isFinite(sy) && sy > 0 && Math.abs(sy - 1) > 0.01) {
          return _buildCssFont(Math.max(1, Math.round((font.height || 13) * sy)), font.weight || 400, font.italic || 0, font.face || '');
        }
        return font.css;
    }
    return '13px monospace'; // system default
  };

  // Build CSS font string from LOGFONT-like properties
  const _normalizeFontHeight = (height) => {
    const h = Math.abs(height | 0) || 13;
    // RichEdit can hand us sentinel-derived LOGFONT heights when upstream
    // CHARFORMAT data is incomplete (WordPad hit -2184px from 32767 twips).
    // Letting that through makes text metrics/page scroll ranges enormous.
    if (h > 256) return (_richeditFontSizeHint.px >= 8 && _richeditFontSizeHint.px <= 128)
      ? _richeditFontSizeHint.px
      : 16;
    return Math.max(8, h);
  };

  const _buildCssFont = (height, weight, italic, face) => {
    const sz = _normalizeFontHeight(height);
    const parts = [];
    if (italic) parts.push('italic');
    if (weight >= 700) parts.push('bold');
    parts.push(sz + 'px');
    // Map Win32 face names to CSS
    const W95 = '"W95FA", "Microsoft Sans Serif", "MS Sans Serif", Tahoma, sans-serif';
    const FSX = '"Fixedsys Excelsior", "Fixedsys", "Courier New", monospace';
    const faceMap = { 'ms sans serif': W95, 'microsoft sans serif': W95, 'ms serif': 'serif',
      'fixedsys': FSX, 'courier': FSX, 'courier new': FSX, 'terminal': FSX, 'fixed': FSX,
      'system': W95, 'tahoma': W95, 'ms shell dlg': W95, 'ms shell dlg 2': W95,
      'arial': 'Arial, sans-serif', 'times new roman': '"Times New Roman", serif',
      'verdana': 'Verdana, sans-serif' };
    const lower = (face || '').toLowerCase();
    parts.push(faceMap[lower] || face || 'sans-serif');
    return parts.join(' ');
  };

  const _setNearestCanvasContext = (ctx2d) => {
    if (ctx2d && 'imageSmoothingEnabled' in ctx2d) ctx2d.imageSmoothingEnabled = false;
    return ctx2d;
  };
  const _prepareNearestCanvas = (canvas) => {
    if (!canvas || !canvas.getContext || canvas._nearestCanvasWrapped) return canvas;
    const origGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = (type, ...rest) => {
      const ctx2d = origGetContext(type, ...rest);
      return type === '2d' ? _setNearestCanvasContext(ctx2d) : ctx2d;
    };
    canvas._nearestCanvasWrapped = true;
    return canvas;
  };

  // Create an offscreen canvas (works in browser and Node with skia-canvas)
  const _createOffscreen = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return _prepareNearestCanvas(new OffscreenCanvas(w, h));
    try { const { Canvas } = require('skia-canvas'); return _prepareNearestCanvas(new Canvas(w, h)); }
    catch (e) { return null; }
  };

  // Canvas exposes no switch for monochrome glyph rasterization. Render text
  // into a reusable alpha mask, threshold coverage to one bit, and composite
  // exact GDI text-color pixels. Font selection and metrics still come from
  // Canvas, so this changes only the Win98-facing raster result.
  let _binaryTextMask = null;
  const _drawBinaryCanvasText = (target, bounds, red, green, blue, drawGlyphs) => {
    const x = Math.floor(bounds.x);
    const y = Math.floor(bounds.y);
    const w = Math.max(1, Math.ceil(bounds.w));
    const h = Math.max(1, Math.ceil(bounds.h));
    if (!_binaryTextMask) _binaryTextMask = _createOffscreen(w, h);
    if (!_binaryTextMask) return false;
    if (_binaryTextMask.width !== w) _binaryTextMask.width = w;
    if (_binaryTextMask.height !== h) _binaryTextMask.height = h;
    const mask = _binaryTextMask.getContext('2d');
    mask.clearRect(0, 0, w, h);
    mask.save();
    try {
      mask.translate(-x, -y);
      mask.fillStyle = '#ffffff';
      drawGlyphs(mask);
    } finally {
      mask.restore();
    }
    let image;
    try { image = mask.getImageData(0, 0, w, h); }
    catch (_) { return false; }
    const pixels = image.data;
    for (let p = 0; p < pixels.length; p += 4) {
      const on = pixels[p + 3] >= 96;
      pixels[p] = red;
      pixels[p + 1] = green;
      pixels[p + 2] = blue;
      pixels[p + 3] = on ? 255 : 0;
    }
    mask.putImageData(image, 0, 0);
    target.drawImage(_binaryTextMask, x, y);
    return true;
  };
  // DirectDraw presentation helpers inspect the canonical DX_OBJECTS table.
  // GDI never draws through a separate JS surface cache: DirectDraw HDCs are
  // bound to the native DIB by WAT and Canvas is presentation/text only.
  const DX_OBJECTS_WA = 0x07FF0000;
  const DX_ENTRY_SIZE = 32;
  const _dxPresentedSignatures = new Map();
  let _dxHadExplicitPrimaryPresent = false;
  const _cursorCssCache = new Map();
  const _readRsrcBytes = (typeId, nameId) => {
    const we = ctx.exports || (ctx.renderer && ctx.renderer.wasm && ctx.renderer.wasm.exports);
    if (!we || !we.rsrc_find_data_wa || !we.rsrc_last_size) return null;
    const ptr = we.rsrc_find_data_wa(typeId >>> 0, nameId >>> 0);
    if (!ptr) return null;
    const size = we.rsrc_last_size() >>> 0;
    if (!size) return null;
    return new Uint8Array(ctx.getMemory(), ptr, size).slice();
  };
  const _bytesToBase64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    return null;
  };
  const _decodeCursorResource = (resourceId) => {
    const group = _readRsrcBytes(12, resourceId);
    if (!group || group.length < 6) return null;
    const r16 = (buf, o) => buf[o] | (buf[o + 1] << 8);
    const r32 = (buf, o) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;
    const count = r16(group, 4);
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 14;
      if (o + 14 > group.length) break;
      const w = group[o] || 256;
      const h = group[o + 1] || 256;
      const bytes = r32(group, o + 8);
      const score = (w <= 32 ? 1000 + w : 512 - w) * 1000 + (h <= 32 ? h : 0) * 10 + Math.min(bytes, 999);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best < 0) return null;
    let hotX = r16(group, best + 4);
    let hotY = r16(group, best + 6);
    let width = group[best] || 256;
    let height = group[best + 1] || 256;
    const colorCount = group[best + 2];
    const imageId = r16(group, best + 12);
    const image = _readRsrcBytes(1, imageId);
    if (!image || !image.length) return null;
    const cursorImage = (() => {
      if (image.length < 16) return image;
      const idv = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const at0 = idv.getUint32(0, true);
      const at4 = idv.getUint32(4, true);
      const isDibHeader = v => v === 12 || v === 40 || v === 52 || v === 56 || v === 108 || v === 124;
      if (isDibHeader(at4) && !isDibHeader(at0)) {
        hotX = idv.getUint16(0, true);
        hotY = idv.getUint16(2, true);
        return image.slice(4);
      }
      return image;
    })();
    if (cursorImage.length >= 16) {
      const cdv = new DataView(cursorImage.buffer, cursorImage.byteOffset, cursorImage.byteLength);
      const biSize = cdv.getUint32(0, true);
      if (biSize === 12) {
        width = cdv.getUint16(4, true);
        height = cdv.getUint16(6, true) >>> 1;
      } else if (biSize >= 40) {
        width = cdv.getInt32(4, true);
        height = Math.abs(cdv.getInt32(8, true)) >>> 1;
      }
    }
    const cur = new Uint8Array(22 + cursorImage.length);
    const dv = new DataView(cur.buffer);
    dv.setUint16(0, 0, true);              // ICONDIR.idReserved
    dv.setUint16(2, 2, true);              // ICONDIR.idType = cursor
    dv.setUint16(4, 1, true);              // ICONDIR.idCount
    cur[6] = width === 256 ? 0 : width;    // ICONDIRENTRY.bWidth
    cur[7] = height === 256 ? 0 : height;  // ICONDIRENTRY.bHeight
    cur[8] = colorCount;
    cur[9] = 0;
    dv.setUint16(10, hotX, true);          // cursor hotspot x
    dv.setUint16(12, hotY, true);          // cursor hotspot y
    dv.setUint32(14, cursorImage.length, true);  // bytes in RT_CURSOR image
    dv.setUint32(18, 22, true);            // image offset
    cur.set(cursorImage, 22);
    const b64 = _bytesToBase64(cur);
    if (!b64) return null;
    const dataUrl = `data:image/x-icon;base64,${b64}`;
    return { dataUrl, hotX, hotY };
  };
  const _cursorCssForHandle = (hcur) => {
    const id = hcur & 0xFFFF;
    if (_cursorCssCache.has(id)) return _cursorCssCache.get(id);
    const cur = _decodeCursorResource(id);
    const css = cur ? `url(${cur.dataUrl}) ${cur.hotX} ${cur.hotY}, default` : null;
    _cursorCssCache.set(id, css);
    return css;
  };
  // Read surface fields from DX_OBJECTS entry. Returns null if slot is not a surface.
  const _surfaceInfo = (slot) => {
    const mem = ctx.getMemory && ctx.getMemory();
    if (!mem) return null;
    const dv = new DataView(mem);
    const entry = DX_OBJECTS_WA + slot * DX_ENTRY_SIZE;
    const type = dv.getUint32(entry, true);
    if (type !== 2) return null; // 2 = DDSurface
    return {
      slot,
      w: dv.getUint16(entry + 12, true),
      h: dv.getUint16(entry + 14, true),
      bpp: dv.getUint16(entry + 16, true),
      pitch: dv.getUint16(entry + 18, true),
      dibWa: dv.getUint32(entry + 20, true),
    };
  };

  const _resolveDirtyRect = (target, dirtyRect) => {
    let rect = dirtyRect;
    if (typeof rect === 'function') {
      try { rect = rect(target); } catch (_) { rect = null; }
    }
    return rect || null;
  };

  // Canvas is only a temporary text rasterizer. Seed exactly the rectangle
  // that text can touch from the canonical WAT surface before drawing; the
  // matching rectangle is copied back by _markDrawTargetDirty afterwards.
  const _seedDrawTargetRect = (target, rect) => {
    if (!target || !target.canonicalSurface) return;
    const presentation = target.canonicalSurface;
    // Canvas fallback text is a synchronization boundary. Flush any older
    // WAT writes before the glyph rasterizer touches the derived cache.
    _flushGdiSurfacePresentation(presentation);
    _refreshGdiSurfacePalette(presentation);
    const left = rect
      ? Math.max(0, (target.ox | 0) + (rect.x | 0))
      : 0;
    const top = rect
      ? Math.max(0, (target.oy | 0) + (rect.y | 0))
      : 0;
    const right = rect
      ? Math.min(presentation.width,
        (target.ox | 0) + (rect.x | 0) + Math.max(0, rect.w | 0))
      : presentation.width;
    const bottom = rect
      ? Math.min(presentation.height,
        (target.oy | 0) + (rect.y | 0) + Math.max(0, rect.h | 0))
      : presentation.height;
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return;
    const rgba = presentation.surface.rgbaRect(left, top, width, height);
    const image = target.ctx.createImageData(width, height);
    image.data.set(rgba);
    target.ctx.putImageData(image, left, top);
  };

  const _markDrawTargetDirty = (target, dirtyRect) => {
    if (!target) return;
    const rect = _resolveDirtyRect(target, dirtyRect);
    if (target.canonicalSurface) {
      const presentation = target.canonicalSurface;
      let x = 0, y = 0, w = presentation.width, h = presentation.height;
      if (rect) {
        x = Math.max(0, (target.ox | 0) + (rect.x | 0));
        y = Math.max(0, (target.oy | 0) + (rect.y | 0));
        w = Math.min(presentation.width - x, rect.w | 0);
        h = Math.min(presentation.height - y, rect.h | 0);
      }
      if (w > 0 && h > 0) {
        const readImage = presentation.rawGetImageData || target.ctx.getImageData.bind(target.ctx);
        const rgba = readImage(x, y, w, h).data;
        for (let yy = 0; yy < h; yy++) {
          for (let xx = 0; xx < w; xx++) {
            const p = (yy * w + xx) * 4;
            presentation.surface._writePixelUnchecked(
              x + xx, y + yy, rgba[p] | (rgba[p + 1] << 8) | (rgba[p + 2] << 16));
          }
        }
        // The text pixels are now identical in Canvas and canonical memory.
        // Re-converting them would be redundant; only the compositor needs a
        // repaint notification.
        _invalidatePixelCache(presentation.canvas);
        _scheduleGdiPresentation(presentation);
      }
    }
  };

  const _gdiMapScalar = (value, winOrg, winExt, vpOrg, vpExt) => {
    const wx = winExt || 1;
    const vx = vpExt || 1;
    return Math.round(vpOrg + ((value - winOrg) * vx) / wx);
  };
  const _gdiMapPoint = (dc, x, y) => ({
    x: _gdiMapScalar(x, dc.winOrgX | 0, dc.winExtX | 0, dc.vpOrgX | 0, dc.vpExtX | 0),
    y: _gdiMapScalar(y, dc.winOrgY | 0, dc.winExtY | 0, dc.vpOrgY | 0, dc.vpExtY | 0),
  });
  const _gdiMapRect = (dc, left, top, right, bottom) => {
    const a = _gdiMapPoint(dc, left, top);
    const b = _gdiMapPoint(dc, right, bottom);
    const l = Math.min(a.x, b.x);
    const t = Math.min(a.y, b.y);
    const r = Math.max(a.x, b.x);
    const btm = Math.max(a.y, b.y);
    return { l, t, r, b: btm, x: l, y: t, w: r - l, h: btm - t };
  };

  const _getPrimaryPalWa = () => {
    const e = ctx.exports;
    if (e && e.get_dx_primary_pal_wa) return e.get_dx_primary_pal_wa() >>> 0;
    return 0;
  };

  const _dxSurfaceContentScore = (surface) => {
    if (!surface || !surface.dibWa || !surface.w || !surface.h || !surface.pitch) {
      return { colors: 0, nonZero: 0, total: 0 };
    }
    const colors = new Set();
    let nonZero = 0;
    let total = 0;
    try {
      const mem = new Uint8Array(ctx.getMemory());
      const palWa = surface.bpp === 8 ? _getPrimaryPalWa() : 0;
      const step = Math.max(1, Math.ceil(Math.sqrt((surface.w * surface.h) / 2048)));
      for (let y = 0; y < surface.h; y += step) {
        const srcRow = surface.dibWa + y * surface.pitch;
        for (let x = 0; x < surface.w; x += step) {
          let key = 0;
          if (surface.bpp === 8) {
            const idx = mem[srcRow + x] || 0;
            if (palWa) {
              const pi = palWa + idx * 4;
              key = ((mem[pi] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi + 2] || 0);
            } else {
              key = idx;
            }
          } else if (surface.bpp === 16) {
            key = (mem[srcRow + x * 2] || 0) | ((mem[srcRow + x * 2 + 1] || 0) << 8);
          } else if (surface.bpp === 24) {
            const pi = srcRow + x * 3;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          } else if (surface.bpp === 32) {
            const pi = srcRow + x * 4;
            key = ((mem[pi + 2] || 0) << 16) | ((mem[pi + 1] || 0) << 8) | (mem[pi] || 0);
          }
          colors.add(key >>> 0);
          if (key !== 0) nonZero++;
          total++;
        }
      }
    } catch (_) {}
    return { colors: colors.size, nonZero, total };
  };

  const _chooseDxPresentationSurface = (primary, offscreen) => {
    const scored = (surface) => ({ surface, score: _dxSurfaceContentScore(surface) });
    const useful = (item) => item && item.score.nonZero > 0;
    const bestByDiversity = (items) => items
      .filter(useful)
      .sort((a, b) =>
        (b.score.colors - a.score.colors) ||
        (b.score.nonZero - a.score.nonZero))[0] || null;

    const primaryCandidates = primary.map(scored);
    const offscreenCandidates = offscreen
      .filter(s => s.w >= 320 && s.h >= 200)
      .map(scored);
    const bestPrimary = bestByDiversity(primaryCandidates);
    const bestOffscreen = bestByDiversity(offscreenCandidates);

    if (!bestPrimary) {
      for (const p of primary) {
        const matching = bestByDiversity(offscreenCandidates.filter(item =>
          item.surface.w === p.w &&
          item.surface.h === p.h &&
          item.surface.bpp === p.bpp));
        if (matching) return matching.surface;
      }
      return bestOffscreen ? bestOffscreen.surface : null;
    }

    if (bestOffscreen &&
        bestOffscreen.score.colors >= 16 &&
        bestOffscreen.score.colors >= Math.max(bestPrimary.score.colors + 8, bestPrimary.score.colors * 4)) {
      return bestOffscreen.surface;
    }

    return bestPrimary.surface;
  };

  const _noteDxPresent = (slot) => {
    const info = _surfaceInfo(slot);
    if (!info || !info.dibWa || !info.w || !info.h) return;
    try {
      const flags = new DataView(ctx.getMemory()).getUint32(DX_OBJECTS_WA + (slot >>> 0) * DX_ENTRY_SIZE + 28, true);
      if (flags & 1) _dxHadExplicitPrimaryPresent = true;
    } catch (_) {}
  };

  const _surfacePresentSignature = (surface) => {
    if (!surface || !surface.dibWa || !surface.bytes) return '';
    let h = 2166136261 >>> 0;
    const mix = (v) => {
      h ^= v & 0xFF;
      h = Math.imul(h, 16777619) >>> 0;
    };
    try {
      const mem = new Uint8Array(ctx.getMemory());
      const step = Math.max(1, surface.pitch >>> 2);
      for (let i = 0; i < surface.bytes; i += step) mix(mem[surface.dibWa + i]);
      mix(mem[surface.dibWa + surface.bytes - 1]);
      const palWa = surface.bpp === 8 ? _getPrimaryPalWa() : 0;
      if (palWa) {
        for (let i = 0; i < 1024; i += 16) {
          mix(mem[palWa + i]);
          mix(mem[palWa + i + 1]);
          mix(mem[palWa + i + 2]);
        }
      }
    } catch (_) {}
    return `${surface.slot}:${surface.w}x${surface.h}:${surface.bpp}:${h}`;
  };

  const _presentDxSurfaceToMainWindow = (surface) => {
    const e = ctx.exports;
    if (!e || !e.get_main_hwnd || !surface || !surface.dibWa) return 0;
    const hwnd = e.get_main_hwnd() >>> 0;
    if (!hwnd) return 0;

    if (ctx.renderer && ctx.renderer.getWindowCanvas) {
      const wc = ctx.renderer.getWindowCanvas(hwnd);
      if (wc && wc.ctx) {
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        const mem = new Uint8Array(ctx.getMemory());
        let dxLayer = win && win._dxFrameLayer;
        if (!dxLayer || dxLayer.w !== surface.w || dxLayer.h !== surface.h) {
          const canvas = _createOffscreen(surface.w, surface.h);
          dxLayer = canvas ? {
            canvas,
            ctx: canvas.getContext('2d'),
            w: surface.w,
            h: surface.h,
          } : null;
          if (win) win._dxFrameLayer = dxLayer;
        }
        const targetCtx = dxLayer ? dxLayer.ctx : wc.ctx;
        const img = targetCtx.createImageData(surface.w, surface.h);
        const data = img.data;
        const palWa = _getPrimaryPalWa();
        for (let y = 0; y < surface.h; y++) {
          const srcRow = surface.dibWa + y * surface.pitch;
          for (let x = 0; x < surface.w; x++) {
            const di = (y * surface.w + x) * 4;
            let r = 0, g = 0, b = 0;
            if (surface.bpp === 8) {
              const idx = mem[srcRow + x];
              if (palWa) {
                const pi = palWa + idx * 4;
                r = mem[pi];
                g = mem[pi + 1];
                b = mem[pi + 2];
              } else {
                r = g = b = idx;
              }
            } else if (surface.bpp === 16) {
              const px = mem[srcRow + x * 2] | (mem[srcRow + x * 2 + 1] << 8);
              r = ((px >> 11) & 0x1F) * 255 / 31 | 0;
              g = ((px >> 5) & 0x3F) * 255 / 63 | 0;
              b = (px & 0x1F) * 255 / 31 | 0;
            } else if (surface.bpp === 24) {
              b = mem[srcRow + x * 3];
              g = mem[srcRow + x * 3 + 1];
              r = mem[srcRow + x * 3 + 2];
            } else if (surface.bpp === 32) {
              b = mem[srcRow + x * 4];
              g = mem[srcRow + x * 4 + 1];
              r = mem[srcRow + x * 4 + 2];
            }
            data[di] = r;
            data[di + 1] = g;
            data[di + 2] = b;
            data[di + 3] = 255;
          }
        }
        targetCtx.putImageData(img, 0, 0);
        if (!dxLayer) wc.ctx.putImageData(img, 0, 0);
        if (win) win.clientPainted = true;
        ctx.renderer.scheduleRepaint && ctx.renderer.scheduleRepaint();
        return 1;
      }
    }

    if (typeof host.gdi_set_dib_to_device !== 'function') return 0;

    const mem = ctx.getMemory();
    const dv = new DataView(mem);
    // Keep this separate from PAINT_SCRATCH (0xAD40), which WAT window
    // paint/update helpers reuse while DirectDraw frames are being presented.
    const bmiWa = 0x00011140;
    const palWa = _getPrimaryPalWa();
    const bmiLen = 40 + (surface.bpp <= 8 ? 1024 : 12);
    new Uint8Array(mem, bmiWa, bmiLen).fill(0);
    dv.setUint32(bmiWa, 40, true);
    dv.setInt32(bmiWa + 4, surface.w | 0, true);
    dv.setInt32(bmiWa + 8, -surface.h, true);
    dv.setUint16(bmiWa + 12, 1, true);
    dv.setUint16(bmiWa + 14, surface.bpp, true);
    if (surface.bpp <= 8 && palWa) {
      const pal = new Uint8Array(mem, palWa, 1024);
      const bmi = new Uint8Array(mem, bmiWa + 40, 1024);
      for (let i = 0; i < 256; i++) {
        const pi = i * 4;
        bmi[pi] = pal[pi + 2];     // RGBQUAD blue
        bmi[pi + 1] = pal[pi + 1]; // green
        bmi[pi + 2] = pal[pi];     // red
      }
    } else if (surface.bpp === 16) {
      dv.setUint32(bmiWa + 16, 3, true); // BI_BITFIELDS
      dv.setUint32(bmiWa + 40, 0xF800, true);
      dv.setUint32(bmiWa + 44, 0x07E0, true);
      dv.setUint32(bmiWa + 48, 0x001F, true);
    }

    host.gdi_set_dib_to_device(
      hwnd + 0x40000,
      0, 0,
      surface.w, surface.h,
      0, 0,
      0, surface.h,
      surface.dibWa,
      bmiWa,
      0);
    return 1;
  };

  const _presentBestDxOffscreen = (force = false) => {
    if (!force && _dxHadExplicitPrimaryPresent) return 0;
    const primary = [];
    const offscreen = [];
    for (let slot = 0; slot < 32; slot++) {
      const info = _surfaceInfo(slot);
      if (!info || !info.dibWa || !info.w || !info.h) continue;
      const flags = new DataView(ctx.getMemory()).getUint32(DX_OBJECTS_WA + slot * DX_ENTRY_SIZE + 28, true);
      const surface = { ...info, flags, bytes: info.pitch * info.h };
      if (flags & 1) primary.push(surface);
      else if (flags & 4) offscreen.push(surface);
    }

    const presentIfChanged = (surface) => {
      if (!surface) return 0;
      const sig = _surfacePresentSignature(surface);
      if (!force && _dxPresentedSignatures.get(surface.slot) === sig) return 0;
      const r = _presentDxSurfaceToMainWindow(surface);
      if (r) _dxPresentedSignatures.set(surface.slot, sig);
      return r;
    };

    return presentIfChanged(_chooseDxPresentationSurface(primary, offscreen));
  };

  // Text is the only Canvas GDI operation. Its WAT caller resolves every
  // HDC, including screen and DirectDraw DCs, to a canonical surface id.
  const _getDrawTarget = (hdc) => {
    const presentation = _gdiSurfacePresentations.get(hdc >>> 0);
    if (presentation) {
      return {
        ctx: presentation.canvas.getContext('2d'), ox: 0, oy: 0, hwnd: 0,
        canvas: presentation.canvas, canonicalSurface: presentation,
      };
    }
    return null;
  };

  // ---- HRGN model: chain-of-Path2D (Approach A) -------------------------
  // HRGN = { branches, bbox, simpleRect?, rects? }
  //   branches: ClipChain[]; ClipChain = [{ path: Path2D, rule, polarity }]
  //   region = ⋃ branches, branches disjoint by construction
  //   simpleRect: only set for as-constructed rect rgns; cleared on first
  //               combine/exclude/intersect that mutates the rgn
  //   rects: legacy rect-list (for renderer.setWindowRgn / gdi_fill_rgn).
  //          Always at least the bbox; populated by builders + offset_rgn.
  const RGN_BRANCH_CAP = 16;


  // Log Approach-B branch-explosion traps with full runtime context, then
  // throw a one-line summary so the WASM trap surfaces something useful too.
  function _crashApproachB(opName, info) {
    const hex = v => '0x' + ((v >>> 0)).toString(16);
    let eip = 0;
    try { eip = ctx.renderer?.wasm?.exports?.get_eip?.() >>> 0; } catch (_) {}
    const br = r => r ? `${r.branches.length}:[${r.bbox.l},${r.bbox.t},${r.bbox.r},${r.bbox.b}]` : '-';
    console.error('====================================');
    console.error('[rgn] Approach B required (not implemented)');
    console.error(`  op: CombineRgn(${opName})`);
    console.error(`  hdc: ${info.hdc != null ? hex(info.hdc) : '-'}`);
    console.error(`  src1: ${br(info.src1)}`);
    console.error(`  src2: ${br(info.src2)}`);
    console.error(`  result branches projected: ${info.projected} (cap=${RGN_BRANCH_CAP})`);
    console.error(`  EIP: ${hex(eip)}`);
    console.error(`  Hint: scratch canvas with 'destination-over' compositing,`);
    console.error(`        per-branch fill of bbox, then drawFn under each chain.`);
    console.error(`        See lib/host-imports.js _drawWithClip.`);
    console.error('====================================');
    throw new Error('Approach B required: ' + opName);
  }

  function _rectPath(l, t, r, b) {
    const p = new Path2D();
    p.rect(l, t, r - l, b - t);
    return p;
  }
  function _makeRectRgn(l, t, r, b) {
    if (r < l) { const x = l; l = r; r = x; }
    if (b < t) { const x = t; t = b; b = x; }
    const branch = [{ path: _rectPath(l, t, r, b), rule: 'nonzero', polarity: +1 }];
    return {
      type: 'region',
      branches: [branch],
      bbox: { l, t, r, b },
      simpleRect: { l, t, r, b },
      rects: [{ x: l, y: t, w: r - l, h: b - t }],
    };
  }
  // WAT owns canonical region geometry. This adapter only rebuilds the
  // browser-facing Path2D/rectangle cache used by the Canvas presenter.
  function _makeBandRgn(rects) {
    const valid = rects.filter(rect => rect.r > rect.l && rect.b > rect.t);
    if (!valid.length) {
      return { type: 'region', branches: [], bbox: { l: 0, t: 0, r: 0, b: 0 }, simpleRect: null, rects: [] };
    }
    let l = valid[0].l, t = valid[0].t, r = valid[0].r, b = valid[0].b;
    const branches = [];
    const legacyRects = [];
    for (const rect of valid) {
      l = Math.min(l, rect.l); t = Math.min(t, rect.t);
      r = Math.max(r, rect.r); b = Math.max(b, rect.b);
      branches.push([{ path: _rectPath(rect.l, rect.t, rect.r, rect.b), rule: 'nonzero', polarity: +1 }]);
      legacyRects.push({ x: rect.l, y: rect.t, w: rect.r - rect.l, h: rect.b - rect.t });
    }
    return {
      type: 'region', branches, bbox: { l, t, r, b },
      simpleRect: valid.length === 1 ? { ...valid[0] } : null,
      rects: legacyRects,
    };
  }
  function _cloneRgn(rgn) {
    return {
      type: 'region',
      branches: rgn.branches.map(ch => ch.map(e => ({ path: e.path, rule: e.rule, polarity: e.polarity }))),
      bbox: { ...rgn.bbox },
      simpleRect: rgn.simpleRect ? { ...rgn.simpleRect } : null,
      rects: rgn.rects ? rgn.rects.map(r => ({ ...r })) : [{ x: rgn.bbox.l, y: rgn.bbox.t, w: rgn.bbox.r - rgn.bbox.l, h: rgn.bbox.b - rgn.bbox.t }],
    };
  }
  function _bboxUnion(a, b) {
    return { l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) };
  }
  function _bboxIntersect(a, b) {
    const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t);
    const r = Math.min(a.r, b.r), bo = Math.min(a.b, b.b);
    if (r < l || bo < t) return { l: 0, t: 0, r: 0, b: 0 };
    return { l, t, r, b: bo };
  }
  // Subtract a single chain P from a single branch A: returns list of branches.
  // A \ P  =  A ∩ ¬P  =  A ∩ (⋃_i ¬p_i)  =  ⋃_i (A ∩ ¬p_i)
  // (each entry of P flipped to polarity=-1, intersected with A separately)
  function _subtractChainFromBranch(A, P) {
    const out = [];
    for (const e of P) {
      out.push([...A, { path: e.path, rule: e.rule, polarity: -e.polarity }]);
    }
    return out;
  }
  // Subtract list-of-chains B from a single branch A: returns list of branches.
  // A \ ⋃ B = A \ B[0] \ B[1] \ ... — apply iteratively.
  function _subtractBranchesFromBranch(A, Bs) {
    let acc = [A];
    for (const P of Bs) {
      const next = [];
      for (const a of acc) for (const r of _subtractChainFromBranch(a, P)) next.push(r);
      acc = next;
      if (acc.length > RGN_BRANCH_CAP * 4) {
        _crashApproachB('subtract', { projected: acc.length });
      }
    }
    return acc;
  }
  function _combineRgn(mode, A, B) {
    // mode: 1=AND, 2=OR, 3=XOR, 4=DIFF, 5=COPY
    if (mode === 5) return _cloneRgn(A);
    if (mode === 1) {
      // cross product
      const branches = [];
      for (const a of A.branches) for (const b of B.branches) branches.push([...a, ...b]);
      if (branches.length > RGN_BRANCH_CAP) {
        _crashApproachB('AND', { src1: A, src2: B, projected: branches.length });
      }
      const bbox = _bboxIntersect(A.bbox, B.bbox);
      return {
        type: 'region', branches, bbox, simpleRect: null,
        rects: [{ x: bbox.l, y: bbox.t, w: bbox.r - bbox.l, h: bbox.b - bbox.t }],
      };
    }
    if (mode === 4) {
      // A \ B = ⋃_a (a \ B.branches)
      const branches = [];
      for (const a of A.branches) for (const r of _subtractBranchesFromBranch(a, B.branches)) branches.push(r);
      if (branches.length > RGN_BRANCH_CAP) {
        _crashApproachB('DIFF', { src1: A, src2: B, projected: branches.length });
      }
      return {
        type: 'region', branches, bbox: { ...A.bbox }, simpleRect: null,
        rects: [{ x: A.bbox.l, y: A.bbox.t, w: A.bbox.r - A.bbox.l, h: A.bbox.b - A.bbox.t }],
      };
    }
    if (mode === 2) {
      // OR: A ⋃ (B \ A) — disjoint by subtracting prior
      const branches = A.branches.map(ch => ch.slice());
      for (const b of B.branches) {
        const subs = _subtractBranchesFromBranch(b, branches);
        for (const s of subs) branches.push(s);
        if (branches.length > RGN_BRANCH_CAP) {
          _crashApproachB('OR', { src1: A, src2: B, projected: branches.length });
        }
      }
      const bbox = _bboxUnion(A.bbox, B.bbox);
      return {
        type: 'region', branches, bbox, simpleRect: null,
        rects: [{ x: bbox.l, y: bbox.t, w: bbox.r - bbox.l, h: bbox.b - bbox.t }],
      };
    }
    if (mode === 3) {
      // XOR = OR(DIFF(A,B), DIFF(B,A))
      const aMinusB = _combineRgn(4, A, B);
      const bMinusA = _combineRgn(4, B, A);
      return _combineRgn(2, aMinusB, bMinusA);
    }
    return _cloneRgn(A);
  }

  function _drawWithClip(hdc, drawFn, dirtyRect) {
    const t = _getDrawTarget(hdc);
    if (!t) return false;
    const resolvedDirtyRect = _resolveDirtyRect(t, dirtyRect);
    _seedDrawTargetRect(t, resolvedDirtyRect);
    _invalidatePixelCache(t.canvas);
    const dc = _getDcState(hdc);
    const bands = dc && dc.clipBands;
    if (bands === null || bands === undefined) {
      t.clipActive = false;
      drawFn(t);
      _markDrawTargetDirty(t, resolvedDirtyRect);
      return true;
    }
    if (!bands.length) return true;
    const c = t.ctx;
    for (const band of bands) {
      const width = band.r - band.l;
      const height = band.b - band.t;
      if (width <= 0 || height <= 0) continue;
      c.save();
      c.beginPath();
      c.rect(t.ox + dc.surfaceOriginX + band.l,
        t.oy + dc.surfaceOriginY + band.t, width, height);
      c.clip();
      t.clipActive = true;
      try { drawFn(t); } finally { c.restore(); }
    }
    _markDrawTargetDirty(t, resolvedDirtyRect);
    return true;
  }

  // putImageData that respects canvas clip (uses temp canvas + drawImage)

  // Clip canvas to exclude windows above the given hwnd, run fn, restore

  // Returns the client origin for screen-space drawing (used by erase_background
  // and other functions that need screen coords for the display canvas).
  const _getClientOriginScreen = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const we = r.wasm && r.wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y) {
      try { return { x: we.wnd_client_screen_x(hwnd) | 0, y: we.wnd_client_screen_y(hwnd) | 0 }; } catch (_) {}
    }
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      const parentOrigin = _getClientOriginScreen(win.parentHwnd);
      return { x: parentOrigin.x + win.x, y: parentOrigin.y + win.y };
    }
    let cy = win.y + 3;
    if ((win.style & 0x00C00000) === 0x00C00000) cy += 19;
    if (r._hasMenuBar(win)) cy += 18;
    return { x: win.x + 3, y: cy + 1 };
  };

  // For GDI drawing: top-level windows draw at (0,0) on their offscreen canvas.
  // Child windows offset by their position within the parent's client area.
  const _getClientOrigin = (hwnd) => {
    const r = ctx.renderer;
    if (!r) return { x: 0, y: 0 };
    const we = r.wasm && r.wasm.exports;
    if (we && we.wnd_client_screen_x && we.wnd_client_screen_y && we.wnd_window_screen_x && we.wnd_window_screen_y) {
      try {
        return {
          x: (we.wnd_client_screen_x(hwnd) | 0) - (we.wnd_window_screen_x(hwnd) | 0),
          y: (we.wnd_client_screen_y(hwnd) | 0) - (we.wnd_window_screen_y(hwnd) | 0),
        };
      } catch (_) {}
    }
    const win = r.windows[hwnd];
    if (!win) return { x: 0, y: 0 };
    if (win.isChild && win.parentHwnd) {
      return { x: win.x, y: win.y };
    }
    // Top-level: return chrome offset within the full-window back canvas
    if (win.clientRect) {
      return { x: win.clientRect.x - win.x, y: win.clientRect.y - win.y };
    }
    return { x: 0, y: 0 };
  };

  const _queueParentExposePaint = (win) => {
    const r = ctx.renderer;
    if (!r || !win || !win.isChild || !win.parentHwnd) return;
    if (!r.windows[win.parentHwnd]) return;
    if (r.restoreParentUnderChild) r.restoreParentUnderChild(win);
    if (r.queuePaint) r.queuePaint(win.parentHwnd);
    if (r.invalidate) r.invalidate(win.parentHwnd);
    else if (r.scheduleRepaint) r.scheduleRepaint();
  };

  const _env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  function _gdiTextOut(hdc, x, y, options, rectWA, textPtr, nCount, isWide) {
    const memBuf = ctx.getMemory();
    const mem = new Uint8Array(memBuf);
    const dv = new DataView(memBuf);
    const count = nCount | 0;
    let text = '';
    if (textPtr && count > 0) {
      if (isWide) {
        for (let i = 0; i < count; i++) {
          const ch = dv.getUint16(textPtr + i * 2, true);
          if (!ch) break;
          text += String.fromCharCode(ch);
        }
      } else {
        for (let i = 0; i < count && mem[textPtr + i]; i++) {
          text += String.fromCharCode(mem[textPtr + i]);
        }
      }
    }

    let extRect = null;
    if (rectWA) {
      try {
        extRect = {
          left: dv.getInt32(rectWA, true),
          top: dv.getInt32(rectWA + 4, true),
          right: dv.getInt32(rectWA + 8, true),
          bottom: dv.getInt32(rectWA + 12, true),
        };
      } catch (_) {
        extRect = null;
      }
    }

    const dc = _getDcState(hdc);
    const textColor = dc.textColor || 0;
    const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
    const bkMode = dc.bkMode || 2; // OPAQUE=2, TRANSPARENT=1
    const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;
    const font = _resolveFont(hdc);
    const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

    // TA_* flags: horizontal (mask 6) → LEFT=0, RIGHT=2, CENTER=6;
    // vertical (mask 24) → TOP=0, BOTTOM=8, BASELINE=24.
    const ta = dc.textAlign | 0;
    const hAlign = ta & 6;
    const vAlign = ta & 24;
    const canvasAlign = hAlign === 2 ? 'right' : hAlign === 6 ? 'center' : 'left';
    const canvasBaseline = vAlign === 24 ? 'alphabetic' : vAlign === 8 ? 'bottom' : 'top';

    const textWidth = (c) => {
      const glyphWidth = c.measureText(text).width;
      const charExtra = dc.charExtra | 0;
      const justifyExtra = dc.justifyCount > 0 ? (dc.justifyExtra | 0) : 0;
      return Math.max(0, glyphWidth + Math.max(0, text.length - 1) * charExtra + justifyExtra);
    };

    const textBounds = (c, dx, dy) => {
      c.font = font;
      const tw = Math.max(1, Math.ceil(textWidth(c)));
      // Background rect must match the aligned glyph box, not a fixed top-left anchor.
      let bgX = dx;
      if (hAlign === 2) bgX = dx - tw;
      else if (hAlign === 6) bgX = dx - (tw >> 1);
      let bgY = dy;
      if (vAlign === 8) bgY = dy - fontHeight;
      else if (vAlign === 24) bgY = dy - Math.round(fontHeight * 0.8);
      return {
        x: Math.floor(bgX) - 1,
        y: Math.floor(bgY) - 1,
        w: tw + 2,
        h: fontHeight + 3,
      };
    };

    const drawGlyphs = (c, dx, dy) => {
      if (!text) return;
      c.font = font;
      const charExtra = dc.charExtra | 0;
      const justifyCount = Math.max(0, dc.justifyCount | 0);
      const justifyExtra = dc.justifyExtra | 0;
      const spaced = charExtra !== 0 || (justifyCount > 0 && justifyExtra !== 0);
      c.textAlign = spaced ? 'left' : canvasAlign;
      c.textBaseline = canvasBaseline;
      if (!spaced) {
        c.fillText(text, dx, dy);
      } else {
        const width = textWidth(c);
        let cursor = hAlign === 2 ? dx - width : hAlign === 6 ? dx - width / 2 : dx;
        let remainingBreaks = justifyCount;
        let remainingExtra = justifyExtra;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          c.fillText(ch, cursor, dy);
          cursor += c.measureText(ch).width;
          if (i + 1 < text.length) cursor += charExtra;
          if (ch === ' ' && remainingBreaks > 0) {
            const add = Math.trunc(remainingExtra / remainingBreaks);
            cursor += add;
            remainingExtra -= add;
            remainingBreaks--;
          }
        }
      }
      c.textAlign = 'left';
      c.textBaseline = 'alphabetic';
    };

    const drawText = (c, dx, dy) => {
      if (!text) return;
      const bounds = textBounds(c, dx, dy);
      if (bkMode === 2) {
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        c.fillStyle = `rgb(${br},${bg2},${bb})`;
        c.fillRect(bounds.x + 1, bounds.y + 1, bounds.w - 2, fontHeight);
      }
      if (!_drawBinaryCanvasText(c, bounds, r, g, b,
        mask => drawGlyphs(mask, dx, dy))) {
        c.fillStyle = `rgb(${r},${g},${b})`;
        drawGlyphs(c, dx, dy);
      }
    };

    const pt = _gdiMapPoint(dc, x, y);
    const extOptions = options >>> 0;
    const wantsOpaque = !!(extRect && (extOptions & 0x2)); // ETO_OPAQUE
    const wantsClip = !!(extRect && (extOptions & 0x4));   // ETO_CLIPPED
    const mappedRect = extRect
      ? _gdiMapRect(dc, extRect.left, extRect.top, extRect.right, extRect.bottom)
      : null;

    if (!text && !wantsOpaque) return 1;

    const unionRects = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      const l = Math.min(a.x, b.x);
      const t = Math.min(a.y, b.y);
      const r2 = Math.max(a.x + a.w, b.x + b.w);
      const b2 = Math.max(a.y + a.h, b.y + b.h);
      return { x: l, y: t, w: r2 - l, h: b2 - t };
    };
    const dirtyRect = (target) => {
      let dirty = text ? textBounds(target.ctx, pt.x, pt.y) : null;
      if (mappedRect && (wantsOpaque || wantsClip)) dirty = unionRects(dirty, mappedRect);
      return dirty;
    };

    _drawWithClip(hdc, (target) => {
      const c = target.ctx;
      if (wantsOpaque && mappedRect) {
        const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
        c.fillStyle = `rgb(${br},${bg2},${bb})`;
        c.fillRect(
          target.ox + mappedRect.l,
          target.oy + mappedRect.t,
          Math.max(0, mappedRect.w),
          Math.max(0, mappedRect.h)
        );
      }
      if (wantsClip && mappedRect) {
        c.save();
        c.beginPath();
        c.rect(
          target.ox + mappedRect.l,
          target.oy + mappedRect.t,
          Math.max(0, mappedRect.w),
          Math.max(0, mappedRect.h)
        );
        c.clip();
        try {
          drawText(c, target.ox + pt.x, target.oy + pt.y);
        } finally {
          c.restore();
        }
      } else {
        drawText(c, target.ox + pt.x, target.oy + pt.y);
      }
    }, dirtyRect);
    return 1;
  }

  const host = {
    // --- Logging (override for tracing/UI) ---
    log: () => {},
    log_i32: (v) => { if (_env.DBG_INV) console.log('[LOG_I32]', '0x' + (v >>> 0).toString(16), v); },
    log_api_exit: () => {},
    log_block: () => {},
    log_eip: () => {},

    // --- DirectX internal tracing hook (--trace-dx) ---
    // WAT calls this from Lock/Unlock/Blt/SetEntries/dx_present/Flip.
    dx_trace: (kind, slot) => {
      if (kind === 5) _noteDxPresent(slot);
    },

    // --- Crash/debug ---
    crash_unimplemented: (namePtr, esp, eip, ebp) => {
      const name = readStr(namePtr, 128);
      const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
      console.error(`\n=== UNIMPLEMENTED API: ${name || '(null/ordinal)'} ===`);
      console.error(`  EIP: ${hex(eip)}  ESP: ${hex(esp)}  EBP: ${hex(ebp)}`);
      if (ctx.exports) {
        const e = ctx.exports;
        console.error(`  EAX: ${hex(e.get_eax())}  ECX: ${hex(e.get_ecx())}  EDX: ${hex(e.get_edx())}  EBX: ${hex(e.get_ebx())}`);
        console.error(`  ESI: ${hex(e.get_esi())}  EDI: ${hex(e.get_edi())}`);
        const imageBase = e.get_image_base();
        const g2w = ctx.g2w || (addr => addr - imageBase + 0x12000);
        const dv = new DataView(e.memory.buffer);
        console.error('  Stack:');
        for (let i = 0; i < 16; i++) {
          const addr = esp + i * 4;
          const val = dv.getUint32(g2w(addr), true);
          console.error(`    [${hex(addr)}] = ${hex(val)}${i === 0 ? '  <- ret addr' : ''}`);
        }
      }
      console.error('  FATAL: implement this API');
      ctx.lastUnimplemented = name || `(ordinal@${hex(namePtr)})`;
    },

    // --- System ---
    get_screen_size: () => {
      const r = ctx.renderer;
      const w = r ? r.canvas.width : 640;
      const h = r ? r.canvas.height : 480;
      return (w & 0xFFFF) | ((h & 0xFFFF) << 16);
    },
    set_wallpaper: (pathWa, tiled) => {
      const path = readStr(pathWa);
      const bytes = _readVfsFile(path);
      if (!bytes || bytes.length < 18 || bytes[0] !== 0x42 || bytes[1] !== 0x4D) return 0;
      let dib = null;
      try { dib = _dib.parseDIB(bytes.subarray(14)); } catch (_) { return 0; }
      if (!dib || dib.w <= 0 || dib.h <= 0 || !dib.pixels ||
          dib.pixels.length < dib.w * dib.h * 4) return 0;
      ctx.desktopWallpaper = { path, tiled: !!tiled, dib };
      const r = ctx.renderer;
      if (r && typeof r.setDesktopWallpaper === 'function') {
        return r.setDesktopWallpaper(dib, !!tiled) ? 1 : 0;
      }
      return 1;
    },
    // Window property store for GetPropA/SetPropA
    show_find_dialog: (dlgHwnd, ownerHwnd, frGuestAddr) => {
      // Bare log only — the WAT side ($create_findreplace_dialog) drives
      // all renderer state via host_register_dialog_frame. The
      // [FindTextA] log line is the existing test gate's anchor.
      console.log(`[FindTextA] hwnd=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} fr=0x${frGuestAddr.toString(16)}`);
      return dlgHwnd;
    },
    shell_about: (dlgHwnd, ownerHwnd, appPtr) => {
      console.log(`[ShellAbout] dlg=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} "${readStr(appPtr)}"`);
      return 1;
    },
    shell_execute: (hwnd, opWa, fileWa, paramsWa, dirWa, nShow) => {
      const op = opWa ? readStr(opWa) : 'open';
      const file = fileWa ? readStr(fileWa) : '';
      const params = paramsWa ? readStr(paramsWa) : '';
      console.log(`[ShellExecute] hwnd=0x${hwnd.toString(16)} op="${op}" file="${file}" params="${params}"`);
      // Browser: try to open links in new tab
      if (typeof window !== 'undefined' && file.startsWith('http')) {
        window.open(file, '_blank');
        return 33;
      }
      return 33; // Success
    },
    // Open / Save dialog web hooks. Default impls are headless no-ops:
    // - has_dom() returns 0, so $create_open_dialog skips the upload/
    //   download buttons in test/render-png contexts.
    // - pick_file_upload / file_download are unreachable from headless
    //   tests but defined as no-ops for safety in case has_dom is overridden.
    // The browser host (host.js) overrides all three with real DOM impls.
    has_dom: () => 0,
    pick_file_upload: (dlgHwnd, destDirWa) => { /* headless no-op */ },
    file_download: (pathWa) => { /* headless no-op */ },

    // WAT-driven dialog frame registration. Called from $create_about_dialog
    // (and any future $create_xxx_dialog) — JS adds a renderer.windows[]
    // entry but does no Win32 logic. The dialog children come from
    // $ctrl_create_child and are walked via _drawWatChildren during paint.
    //
    //   kind bit 0 = isAboutDialog (modal block flag)
    //   kind bit 1 = isFindDialog
    //   kind bit 2 = isPopup (WS_POPUP — no caption/border chrome, drawn at win.x/win.y)
    register_dialog_frame: (dlgHwnd, ownerHwnd, titleWa, w, h, kind) => {
      const r = typeof ctx.renderer === 'function' ? ctx.renderer() : ctx.renderer;
      if (!r) return;
      const title = readStr(titleWa);
      const parentWin = r.windows[ownerHwnd];
      const px = parentWin ? parentWin.x : 0;
      const py = parentWin ? parentWin.y : 0;
      const isPopup = !!(kind & 4);
      r.windows[dlgHwnd] = {
        hwnd: dlgHwnd, style: isPopup ? 0x80000000 : 0x80C80000, title,
        x: px + 40, y: py + 40, w, h,
        visible: !isPopup, isChild: false, menu: null, controls: [],
        isDialog: !isPopup,
        isAboutDialog: !!(kind & 1),
        isFindDialog:  !!(kind & 2),
        isPopup,
        hasCaption: !isPopup,
        ownerHwnd, zOrder: r._nextZ + (isPopup ? 1000000 : 0),
        processId: (ctx.processId >>> 0) || 1000,
        wasm: r.wasm, wasmMemory: r.wasmMemory,
      };
      r._nextZ++;
      // Populate clientRect so WAT can call host_erase_background right after
      // registration to fill the back-canvas with COLOR_BTNFACE.
      r._computeClientRect(r.windows[dlgHwnd]);
      r.invalidate(dlgHwnd);
    },
    message_box: (hWnd, textPtr, captionPtr, uType) => {
      console.log(`[MessageBox] "${readStr(captionPtr)}": "${readStr(textPtr)}"`);
      return 1;
    },
    exit: (code) => {
      console.log('[Exit] code=' + code);
      if (ctx.onExit) ctx.onExit(code);
    },
    message_beep: (uType) => {
      try {
        const audioCtx = ctx._voices._ensureCtx(22050);
        if (!audioCtx) return;
        if (audioCtx.state === 'suspended') {
          try { audioCtx.resume(); } catch (_) {}
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const systemFreq = { 0x10: 200, 0x20: 300, 0x30: 400, 0x40: 600 };
        const freq = systemFreq[uType] || (360 + ((uType >>> 0) % 19) * 28);
        const now = audioCtx.currentTime;
        osc.frequency.value = freq;
        osc.type = 'square';
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
        osc.connect(gain);
        gain.connect(_getAudioBus(audioCtx, 1));
        osc.start(now);
        osc.stop(now + 0.13);
      } catch (_) {}
    },
    play_sound: (wasmPtr, length) => {
      // Play WAV data from WASM memory using Web Audio API
      try {
        const audioCtx = ctx._voices._ensureCtx(22050);
        if (!audioCtx) return;
        ctx._audioCtx = audioCtx;
        if (audioCtx.state === 'suspended') {
          try { audioCtx.resume(); } catch (_) {}
        }
        // Copy WAV data from WASM memory
        const wavData = new Uint8Array(ctx.getMemory(), wasmPtr, length).slice();
        audioCtx.decodeAudioData(wavData.buffer).then(audioBuffer => {
          const source = audioCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(_getAudioBus(audioCtx, 1));
          source.start();
        }).catch(() => {});
      } catch (_) {}
    },
    mci_open: (deviceTypeOrWa, elementWa, flags) => _mciOpen(deviceTypeOrWa, elementWa, flags, false),
    mci_open_w: (deviceTypeOrWa, elementWa, flags) => _mciOpen(deviceTypeOrWa, elementWa, flags, true),
    mci_command: _mciCommand,
    mci_string: _mciStringCommand,
    midi_num_devs: () => 1,
    midi_out_open: (deviceId, callback, callbackInstance, flags) => {
      const devId = deviceId >>> 0;
      if (devId !== 0 && devId !== 0xFFFFFFFF) return 0;
      const handle = _midiOut.nextHandle++;
      _midiOut.devices.set(handle, {
        handle,
        deviceId: devId,
        callback: callback >>> 0,
        callbackInstance: callbackInstance >>> 0,
        flags: flags >>> 0,
        volume: _midiOut.defaultVolume >>> 0,
        program: new Array(16).fill(0),
        channelVolume: new Array(16).fill(127),
        active: new Map(),
        master: null,
      });
      return handle;
    },
    midi_out_close: (handle) => {
      const dev = _midiOut.devices.get(handle >>> 0);
      if (!dev) return 5; // MMSYSERR_INVALHANDLE
      _midiOutResetDevice(dev);
      _midiOut.devices.delete(handle >>> 0);
      return 0;
    },
    midi_out_short_msg: (handle, msg) => {
      const dev = _midiOut.devices.get(handle >>> 0);
      if (!dev) return 5; // MMSYSERR_INVALHANDLE
      const status = msg & 0xFF;
      const a = (msg >>> 8) & 0xFF;
      const b = (msg >>> 16) & 0xFF;
      const op = status & 0xF0;
      const ch = status & 0x0F;
      const raw = (op === 0xC0 || op === 0xD0) ? [status, a] : [status, a, b];
      if (op === 0x90) {
        if (b) _markAudioMixerPeak(2, Math.min(127, b * (dev.channelVolume[ch] || 127) / 127) / 127, 160);
        if (_midiOutTinySend(dev, raw)) return 0;
        if (b) return _midiOutNoteOn(dev, ch, a, Math.min(127, b * (dev.channelVolume[ch] || 127) / 127));
        _midiOutStopNote(dev, ch + ':' + a);
        return 0;
      }
      if (op === 0x80) {
        if (_midiOutTinySend(dev, raw)) return 0;
        _midiOutStopNote(dev, ch + ':' + a);
        return 0;
      }
      if (op === 0xB0) {
        _midiOutTinySend(dev, raw);
        if (a === 7) dev.channelVolume[ch] = b;
        if (a === 120 || a === 123) {
          for (const key of Array.from(dev.active.keys())) {
            if (key.startsWith(ch + ':')) _midiOutStopNote(dev, key);
          }
        }
        return 0;
      }
      if (op === 0xC0) {
        _midiOutTinySend(dev, raw);
        dev.program[ch] = a;
        return 0;
      }
      if (op === 0xE0 || op === 0xD0 || op === 0xA0) {
        _midiOutTinySend(dev, raw);
        return 0;
      }
      return 0;
    },
    midi_out_reset: (handle) => _midiOutResetDevice(_midiOut.devices.get(handle >>> 0)),
    midi_out_get_volume: (handle, volumeWa) => {
      const dev = _midiOut.devices.get(handle >>> 0);
      if (!volumeWa) return 11; // MMSYSERR_INVALPARAM
      if (!dev && (handle >>> 0) !== 0 && (handle >>> 0) !== 0xFFFFFFFF) return 5; // MMSYSERR_INVALHANDLE
      new DataView(ctx.getMemory()).setUint32(volumeWa, (dev ? dev.volume : _midiOut.defaultVolume) >>> 0, true);
      return 0;
    },
    midi_out_set_volume: (handle, volume) => {
      const dev = _midiOut.devices.get(handle >>> 0);
      if (!dev && (handle >>> 0) !== 0 && (handle >>> 0) !== 0xFFFFFFFF) return 5; // MMSYSERR_INVALHANDLE
      if (!dev) {
        _midiOut.defaultVolume = volume >>> 0;
        for (const d of _midiOut.devices.values()) {
          d.volume = volume >>> 0;
          if (d.master && d.master.gain) d.master.gain.value = _midiMasterGain * _midiOutGainValue(d.volume);
        }
        return 0;
      }
      dev.volume = volume >>> 0;
      if (dev.master && dev.master.gain) dev.master.gain.value = _midiMasterGain * _midiOutGainValue(dev.volume);
      return 0;
    },
    audio_mixer_get_volume: (bus) => {
      const channel = Math.max(0, Math.min(2, bus | 0));
      return _audioMixerState.mixerVolumes[channel] >>> 0;
    },
    audio_mixer_set_volume: (bus, volume) => {
      const channel = Math.max(0, Math.min(2, bus | 0));
      _setAudioMixerVolume(channel, volume);
      console.log(`[mixer] ${['master', 'wave', 'midi'][channel]} volume=0x${(volume >>> 0).toString(16).padStart(8, '0')}`);
    },
    audio_mixer_get_mute: (bus) => {
      const channel = Math.max(0, Math.min(2, bus | 0));
      return _audioMixerState.mixerMutes[channel] ? 1 : 0;
    },
    audio_mixer_set_mute: (bus, mute) => {
      const channel = Math.max(0, Math.min(2, bus | 0));
      _audioMixerState.mixerMutes[channel] = mute ? 1 : 0;
      for (const ac of _audioMixerState.mixerContexts) _applyAudioMixerVolume(ac, channel);
      console.log(`[mixer] ${['master', 'wave', 'midi'][channel]} mute=${mute ? 1 : 0}`);
    },
    audio_mixer_get_peak: (bus) => _getAudioMixerPeak(bus),
    audio_mixer_mark_peak: (bus, value, holdMs) => {
      _markAudioMixerPeak(bus, Math.max(0, Math.min(32767, value | 0)) / 32767, holdMs | 0);
    },
    get_ticks: () => Date.now() & 0x7FFFFFFF,
    yield: (reason) => { /* no-op in CLI — browser host can use this to pause */ },

    // ---- Unified voice audio bridge ----
    // Both waveOut (stream submit) and DSOUND (snapshot/loop) sit on top of a
    // single VoiceManager. Each voice = one mixer slot with format + gain/pan/rate
    // + connection to the shared AudioContext destination.
    //   wave_out_*       → voice in STREAM mode (queued one-shots, no random write)
    //   IDirectSoundBuffer_* → voice in SNAPSHOT mode (Play() captures the guest
    //                          ring at that moment, optionally looped)
    // Streaming-music DSOUND (write-during-play) isn't supported yet — would need
    // a real AudioWorklet ring; no current test binary exercises it.
    voice_open: (sampleRate, channels, bitsPerSample) => {
      return ctx._voices.open(sampleRate, channels, bitsPerSample);
    },
    voice_write_stream: (id, pcmDataWA, byteLength) => {
      const prevProfileThreadId = _audioDoneState.profileThreadId;
      _audioDoneState.profileThreadId = (ctx.threadId || 0) | 0;
      try {
        ctx._voices.writeStream(id, pcmDataWA, byteLength);
        return 0;
      } finally {
        _audioDoneState.profileThreadId = prevProfileThreadId;
      }
    },
    voice_play_ring: (id, pcmDataWA, byteLength, startOffset, loop) => {
      ctx._voices.playRing(id, pcmDataWA, byteLength, startOffset, loop);
      return 0;
    },
    voice_stop: (id) => { ctx._voices.stop(id); return 0; },
    voice_close: (id) => { ctx._voices.close(id); return 0; },
    voice_get_pos: (id) => ctx._voices.getPos(id),
    voice_set_volume_linear: (id, vol_0_65535) => {
      ctx._voices.setGain(id, Math.max(0, Math.min(1, vol_0_65535 / 65535)));
    },
    voice_set_volume_db: (id, centibels) => {
      // DSOUND attenuation: 0 = full, -10000 = silent. Linear = 10^(cB/2000).
      const cB = Math.max(-10000, Math.min(0, centibels | 0));
      ctx._voices.setGain(id, Math.pow(10, cB / 2000));
    },
    voice_set_pan: (id, centibels) => {
      // DSOUND pan: -10000 = full left, +10000 = full right. Linear in [-1, 1].
      const cB = Math.max(-10000, Math.min(10000, centibels | 0));
      ctx._voices.setPan(id, cB / 10000);
    },
    voice_set_freq: (id, hz) => { ctx._voices.setFreq(id, hz | 0); },

    // ---- waveOut compatibility shims (wrap a single STREAM voice) ----
    wave_out_open: (sampleRate, channels, bitsPerSample, callbackType) => {
      const id = ctx._voices.open(sampleRate, channels, bitsPerSample);
      console.log(`[waveOut] open: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit -> voice#${id}`);
      if (_audioDoneState.waveOutOpenHandles && _audioDoneState.waveOutOpenHandles.add) {
        _audioDoneState.waveOutOpenHandles.add(id >>> 0);
      }
      _markWaveOutHot(500);
      // Capture format for an optional WAV-header finalize at exit.
      ctx._audioOutFormat = { rate: sampleRate, ch: channels, bits: bitsPerSample };
      return id;
    },
    wave_out_write: (handle, pcmDataWA, byteLength) => {
      const prevProfileThreadId = _audioDoneState.profileThreadId;
      _audioDoneState.profileThreadId = (ctx.threadId || 0) | 0;
      try {
        ctx._voices.writeStream(handle, pcmDataWA, byteLength);
      } finally {
        _audioDoneState.profileThreadId = prevProfileThreadId;
      }
      const v = ctx._voices && ctx._voices._map ? ctx._voices._map[handle] : null;
      if (v && byteLength > 0) {
        const bytesPerSec = Math.max(1, v.rate * v.channels * (v.bits / 8));
        const durationMs = (byteLength / bytesPerSec) * 1000;
        const ac = ctx._voices && ctx._voices._ac;
        const queuedMs = ac && Number.isFinite(v.nextTime)
          ? Math.max(0, (v.nextTime - ac.currentTime) * 1000)
          : durationMs;
        _markWaveOutHot(Math.max(durationMs, queuedMs) + 250);
      } else {
        _markWaveOutHot(250);
      }
      // Optional raw PCM dump for offline test inspection
      if (ctx._audioOutFd !== undefined) {
        try {
          const buf = Buffer.from(ctx.getMemory(), pcmDataWA, byteLength);
          require('fs').writeSync(ctx._audioOutFd, buf);
          ctx._audioOutBytes = (ctx._audioOutBytes || 0) + byteLength;
        } catch (_) {}
      }
      return 0;
    },
    wave_out_schedule_done: (handle, waveHdrWA, waveHdrGA, byteLength) => {
      if (byteLength === undefined) {
        byteLength = waveHdrGA;
        waveHdrGA = 0;
      }
      _trackWaveOutHeader(handle, waveHdrWA, waveHdrGA);
      const v = ctx._voices && ctx._voices._map ? ctx._voices._map[handle] : null;
      const ac = ctx._voices && ctx._voices._ac;
      const complete = () => { _completeWaveOutDone(handle, waveHdrWA, waveHdrGA); };
      if (typeof window !== 'undefined' && ac && v && Number.isFinite(v.nextTime)) {
        const dueTime = v.nextTime;
        _markWaveOutPending(1);
        _markWaveOutHot(Math.max(0, (dueTime - ac.currentTime) * 1000) + 250);
        const arm = (ms) => {
          const timer = setTimeout(() => {
            v.timers.delete(timer);
            poll();
          }, ms);
          v.timers.add(timer);
        };
        const poll = () => {
          if (!ctx._voices || ctx._voices._map[handle] !== v) return;
          if (ac.state === 'suspended' || ac.currentTime + 0.002 < dueTime) {
            const ms = Math.max(8, Math.min(50, (dueTime - ac.currentTime) * 1000));
            arm(ms);
            return;
          }
          complete();
        };
        const ms = Math.max(0, Math.min(50, (dueTime - ac.currentTime) * 1000));
        arm(ms);
      } else if (v && typeof byteLength === 'number' && byteLength > 0 && _audioClockMs() !== null) {
        const bytesPerSec = Math.max(1, v.rate * v.channels * (v.bits / 8));
        const nowMs = _audioClockMs();
        const durationMs = (byteLength / bytesPerSec) * 1000;
        const dueMs = Math.max(nowMs, v.nextDoneTimeMs || nowMs) + durationMs;
        v.nextDoneTimeMs = dueMs;
        _markWaveOutPending(1);
        _markWaveOutHot(durationMs + 250);
        _audioDoneState.waveDoneQueue.push({
          handle: handle >>> 0,
          waveHdrWA: waveHdrWA >>> 0,
          waveHdrGA: waveHdrGA >>> 0,
          dueMs,
        });
      } else {
        complete();
      }
      return 0;
    },
    wave_out_reset: (handle) => {
      const completed = _completeWaveOutHandle(handle);
      if (ctx._voices && ctx._voices.stop) ctx._voices.stop(handle);
      if (!completed) _markWaveOutHot(250);
      return 0;
    },
    wave_out_close: (handle) => {
      console.log(`[waveOut] close voice#${handle}`);
      ctx._voices.close(handle);
      if (_audioDoneState.waveScheduledHeaders) {
        _audioDoneState.waveScheduledHeaders.delete(handle >>> 0);
      }
      if (_audioDoneState.waveOutOpenHandles && _audioDoneState.waveOutOpenHandles.delete) {
        _audioDoneState.waveOutOpenHandles.delete(handle >>> 0);
      }
      if (_audioDoneState.waveOutOpenHandles && _audioDoneState.waveOutOpenHandles.size === 0) {
        _audioDoneState.pendingWaveDoneCount = 0;
      }
      _markWaveOutHot(250);
      return 0;
    },
    wave_out_get_pos: (handle) => ctx._voices.getPos(handle),
    wave_out_set_volume: (handle, volume) => {
      ctx._voices.setGain(handle, Math.max(0, Math.min(1, volume / 65535)));
    },

    // ---- waveIn capture ------------------------------------------------
    wave_in_open: (sampleRate, channels, bitsPerSample, callback, instance, callbackType) => {
      const handle = _waveIn.nextHandle++;
      _waveIn.devices.set(handle, {
        handle,
        rate: Math.max(1, sampleRate | 0),
        channels: Math.max(1, Math.min(2, channels | 0)),
        bits: bitsPerSample === 8 ? 8 : 16,
        callback: callback >>> 0,
        instance: instance >>> 0,
        callbackType: callbackType | 0,
        queue: [],
        running: false,
        resamplePhase: 0,
        stream: null,
        source: null,
        processor: null,
        silentGain: null,
        capturedFrames: 0,
        lastError: '',
      });
      console.log(`[waveIn] open: ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit -> input#${handle}`);
      return handle;
    },
    wave_in_add_buffer: (handle, waveHdrWA, waveHdrGA, dataWA, byteLength) => {
      const device = _waveIn.devices.get(handle >>> 0);
      if (!device || !waveHdrWA || !dataWA || byteLength <= 0) return 11; // MMSYSERR_INVALPARAM
      device.queue.push({
        waveHdrWA: waveHdrWA >>> 0,
        waveHdrGA: waveHdrGA >>> 0,
        dataWA: dataWA >>> 0,
        length: byteLength >>> 0,
        written: 0,
      });
      return 0;
    },
    wave_in_start: (handle) => {
      const device = _waveIn.devices.get(handle >>> 0);
      if (!device) return 5; // MMSYSERR_INVALHANDLE
      device.running = true;
      if (device.stream || device.acquirePending) return 0;
      const getUserMedia = ctx.getUserMedia ||
        (typeof navigator !== 'undefined' && navigator.mediaDevices &&
          navigator.mediaDevices.getUserMedia && navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices));
      if (!getUserMedia) {
        // Node/CLI tests inject PCM through wave_in_feed_pcm. In a browser,
        // however, this means capture is unavailable (usually an insecure
        // origin) and must not look like a successful recording start.
        if (typeof window === 'undefined') return 0;
        device.running = false;
        _reportWaveInError(device, new Error('Microphone capture requires browser permission and a secure connection'));
        return 8; // MMSYSERR_NOTSUPPORTED
      }
      device.acquirePending = true;
      Promise.resolve(getUserMedia({ audio: {
        // Capture at the device's native format, then resample below. Exact
        // 22050 Hz constraints are rejected by some Safari/mobile devices.
        channelCount: { ideal: device.channels },
        sampleRate: { ideal: device.rate },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      } })).then(stream => {
        device.acquirePending = false;
        if (!_waveIn.devices.has(device.handle) || !device.running) {
          if (stream && stream.getTracks) for (const track of stream.getTracks()) track.stop();
          return;
        }
        const ac = _voices._ensureCtx(device.rate);
        if (!ac || !ac.createMediaStreamSource || !ac.createScriptProcessor) {
          if (stream && stream.getTracks) for (const track of stream.getTracks()) track.stop();
          device.running = false;
          _reportWaveInError(device, new Error('This browser does not provide the required microphone audio APIs'));
          return;
        }
        device.stream = stream;
        device.source = ac.createMediaStreamSource(stream);
        device.processor = ac.createScriptProcessor(4096, device.channels, 1);
        device.processor.onaudioprocess = event => {
          if (!device.running || !event || !event.inputBuffer) return;
          const input = event.inputBuffer;
          const inputChannels = [];
          for (let ch = 0; ch < input.numberOfChannels; ch++) inputChannels.push(input.getChannelData(ch));
          _feedWaveInPcm(device.handle, inputChannels, input.sampleRate || ac.sampleRate || device.rate);
        };
        device.silentGain = ac.createGain();
        // A mathematically silent branch can be optimized away by WebKit,
        // which stops ScriptProcessor callbacks. This remains inaudible.
        device.silentGain.gain.value = 1e-8;
        device.source.connect(device.processor);
        device.processor.connect(device.silentGain);
        device.silentGain.connect(ac.destination);
        if (ac.state === 'suspended' && ac.resume) ac.resume().catch(() => {});
      }).catch(error => {
        device.acquirePending = false;
        device.running = false;
        _reportWaveInError(device, error);
      });
      return 0;
    },
    wave_in_stop: (handle) => {
      const device = _waveIn.devices.get(handle >>> 0);
      if (!device) return 5;
      device.running = false;
      _stopWaveInNodes(device);
      _flushWaveIn(device, false);
      return 0;
    },
    wave_in_reset: (handle) => {
      const device = _waveIn.devices.get(handle >>> 0);
      if (!device) return 5;
      device.running = false;
      _stopWaveInNodes(device);
      _flushWaveIn(device, true);
      return 0;
    },
    wave_in_close: (handle) => {
      const device = _waveIn.devices.get(handle >>> 0);
      if (!device) return 5;
      device.running = false;
      _stopWaveInNodes(device);
      _flushWaveIn(device, true);
      _postWaveInMessage(device, 0x03BF, 0); // MM_WIM_CLOSE
      _waveIn.devices.delete(handle >>> 0);
      console.log(`[waveIn] close input#${handle}`);
      return 0;
    },
    // Test/CLI injection bridge. Browser capture calls the same converter.
    wave_in_feed_pcm: (handle, channelData, sourceRate) =>
      _feedWaveInPcm(handle, channelData, sourceRate),

    resolve_ordinal: (dllNameWA, ordinal) => {
      const dllName = readStr(dllNameWA).toUpperCase();
      const key = dllName + '#' + ordinal;
      // Shell32 ordinal exports (undocumented Win9x APIs)
      const ORDINAL_MAP = {
        'SHELL32.DLL#2': 'SHChangeNotifyRegister',
        'SHELL32.DLL#4': 'SHChangeNotifyDeregister',
        'SHELL32.DLL#60': 'ExitWindowsDialog',
        'SHELL32.DLL#61': 'RunFileDlg',
        'SHELL32.DLL#62': 'PickIconDlg',
        'SHELL32.DLL#63': 'GetFileNameFromBrowse',
        'SHELL32.DLL#71': 'IsLFNDriveA',
        'SHELL32.DLL#152': 'SHGetSpecialFolderLocation',
        'SHELL32.DLL#165': 'SHGetPathFromIDListA',
        'SHELL32.DLL#167': 'SHBrowseForFolderA',
        'SHELL32.DLL#181': 'RegisterShellHook',
        'SHELL32.DLL#184': 'ArrangeWindows',
        'SHELL32.DLL#232': 'SHFileOperationA',
        'SHELL32.DLL#640': 'NTSHChangeNotifyRegister',
        // COMCTL32 ordinal exports (named ones have low ordinals)
        'COMCTL32.DLL#2': 'MenuHelp',
        'COMCTL32.DLL#3': 'ShowHideMenuCtl',
        'COMCTL32.DLL#4': 'GetEffectiveClientRect',
        'COMCTL32.DLL#5': 'DrawStatusTextA',
        'COMCTL32.DLL#6': 'CreateStatusWindowA',
        'COMCTL32.DLL#7': 'CreateToolbar',
        'COMCTL32.DLL#8': 'CreateMappedBitmap',
        'COMCTL32.DLL#17': 'InitCommonControls',
        // COMCTL32 internal heap (ordinal-only)
        'COMCTL32.DLL#71': 'Comctl32_Alloc',
        'COMCTL32.DLL#72': 'Comctl32_ReAlloc',
        'COMCTL32.DLL#73': 'Comctl32_Free',
        'COMCTL32.DLL#74': 'Comctl32_GetSize',
        // COMCTL32 DSA/DPA utility (ordinal-only)
        'COMCTL32.DLL#320': 'DSA_Create',
        'COMCTL32.DLL#321': 'DSA_Destroy',
        'COMCTL32.DLL#322': 'DSA_GetItem',
        'COMCTL32.DLL#323': 'DSA_GetItemPtr',
        'COMCTL32.DLL#324': 'DSA_InsertItem',
        'COMCTL32.DLL#326': 'DSA_DeleteItem',
        'COMCTL32.DLL#328': 'DPA_Create',
        'COMCTL32.DLL#329': 'DPA_Destroy',
        'COMCTL32.DLL#332': 'DPA_GetPtr',
        'COMCTL32.DLL#334': 'DPA_InsertPtr',
        'COMCTL32.DLL#336': 'DPA_DeletePtr',
        'COMCTL32.DLL#337': 'DPA_DeleteAllPtrs',
        // COMCTL32 string utilities (ordinal-only, later in shlwapi)
        'COMCTL32.DLL#350': 'StrChrA',
        'COMCTL32.DLL#357': 'StrToIntA',
        // Named exports at higher ordinals
        'COMCTL32.DLL#84': 'InitCommonControlsEx',
        // WSOCK32 ordinal exports
        'WSOCK32.DLL#1': 'accept',
        'WSOCK32.DLL#2': 'bind',
        'WSOCK32.DLL#3': 'closesocket',
        'WSOCK32.DLL#4': 'connect',
        'WSOCK32.DLL#5': 'getpeername',
        'WSOCK32.DLL#6': 'getsockname',
        'WSOCK32.DLL#7': 'getsockopt',
        'WSOCK32.DLL#8': 'htonl',
        'WSOCK32.DLL#9': 'htons',
        'WSOCK32.DLL#10': 'inet_addr',
        'WSOCK32.DLL#11': 'inet_ntoa',
        'WSOCK32.DLL#12': 'ioctlsocket',
        'WSOCK32.DLL#13': 'listen',
        'WSOCK32.DLL#14': 'ntohl',
        'WSOCK32.DLL#15': 'ntohs',
        'WSOCK32.DLL#16': 'recv',
        'WSOCK32.DLL#17': 'recvfrom',
        'WSOCK32.DLL#18': 'select',
        'WSOCK32.DLL#19': 'send',
        'WSOCK32.DLL#20': 'sendto',
        'WSOCK32.DLL#21': 'setsockopt',
        'WSOCK32.DLL#22': 'shutdown',
        'WSOCK32.DLL#23': 'socket',
        'WSOCK32.DLL#115': 'WSAStartup',
        'WSOCK32.DLL#116': 'WSACleanup',
        // OLEAUT32 — BSTR and variant management (official MSDN ordinals)
        'OLEAUT32.DLL#2': 'SysAllocString',
        'OLEAUT32.DLL#4': 'SysAllocStringLen',
        'OLEAUT32.DLL#6': 'SysFreeString',
        'OLEAUT32.DLL#7': 'SysStringLen',
        'OLEAUT32.DLL#9': 'VariantClear',
        'OLEAUT32.DLL#150': 'LoadTypeLib',
        // DirectSound ordinal exports
        'DSOUND.DLL#1': 'DirectSoundCreate',
        // DirectPlay (DPLAYX) — stubs that report "not available" so apps
        // fall back to single-player. Out of scope per directx.md.
        'DPLAYX.DLL#1': 'DirectPlayCreate',
        'DPLAYX.DLL#2': 'DirectPlayEnumerate',
        'DPLAYX.DLL#3': 'DirectPlayEnumerateA',
        'DPLAYX.DLL#4': 'DirectPlayLobbyCreateA',
      };
      const name = ORDINAL_MAP[key];
      if (!name) {
        if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> unknown`);
        return -1;
      }
      // Look up API ID by name hash (FNV-1a)
      const apiTable = ctx.apiTable;
      if (apiTable) {
        const entry = apiTable.find(e => e.name === name);
        if (entry) {
          if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (API #${entry.id})`);
          return entry.id;
        }
      }
      if (ctx.verbose) console.log(`  [ordinal] ${dllName}#${ordinal} -> ${name} (no handler)`);
      return -1;
    },

    read_file: (pathWA, bufWA, maxLen) => {
      const path = readStr(pathWA);
      if (ctx.readFile) {
        const data = ctx.readFile(path);
        if (data && data.length > 0) {
          const len = Math.min(data.length, maxLen);
          new Uint8Array(ctx.getMemory(), bufWA, len).set(data.subarray ? data.subarray(0, len) : data.slice(0, len));
          return len;
        }
      }
      return 0;
    },

    // --- Help system imports ---
    help_open: (pathWA) => {
      // Return cached parser's topic count if already loaded
      if (ctx._helpParser) return ctx._helpParser.topics.length;
      const filePath = readStr(pathWA);
      const HlpParserClass = (typeof HlpParser !== 'undefined') ? HlpParser
        : (typeof require !== 'undefined' ? require('./hlp-parser').HlpParser : null);
      if (!HlpParserClass) return 0;
      // Try sync readFile (works in Node; browser returns null for HLP)
      if (ctx.readFile) {
        const data = ctx.readFile(filePath);
        if (data && data.length > 0) {
          try {
            const parser = new HlpParserClass(data);
            if (parser.parse()) {
              ctx._helpParser = parser;
              return parser.topics.length;
            }
          } catch (e) { return 0; }
        }
      }
      // No sync data — store path for async fetch, return -1 to signal yield
      ctx._helpPendingPath = filePath;
      return -1;
    },
    help_get_topic: (index, destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser) return 0;
      let text;
      if (index === 0) {
        // Contents page: title + numbered list of topics
        let lines = parser.helpTitle || 'Help Topics';
        lines += '\n';
        for (let i = 0; i < parser.topics.length; i++) {
          lines += '\n' + (i + 1) + '. ' + (parser.topics[i].title || '(untitled)');
        }
        text = lines;
      } else if (index > 0 && index <= parser.topics.length) {
        const topic = parser.topics[index - 1];
        text = (topic.title ? topic.title + '\n\n' : '') + topic.text;
      } else {
        return 0;
      }
      const enc = new TextEncoder();
      const encoded = enc.encode(text);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0; // NUL-terminate
      return len;
    },
    help_get_title: (destWA, maxLen) => {
      const parser = ctx._helpParser;
      if (!parser || !parser.helpTitle) return 0;
      const enc = new TextEncoder();
      const encoded = enc.encode(parser.helpTitle);
      const len = Math.min(encoded.length, maxLen);
      new Uint8Array(ctx.getMemory(), destWA, len).set(encoded.subarray(0, len));
      new Uint8Array(ctx.getMemory())[destWA + len] = 0;
      return len;
    },

    // --- Drawing ---
    draw_rect: (x, y, w, h, color) => {
      if (!ctx.renderer) return;
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.fillRect(x, y, w, h);
    },
    draw_text: (x, y, textPtr, textLen, color) => {
      if (!ctx.renderer) return;
      const bytes = new Uint8Array(ctx.getMemory(), textPtr, textLen);
      const text = new TextDecoder().decode(bytes);
      const c = ctx.renderer.ctx;
      c.fillStyle = '#' + (color >>> 0).toString(16).padStart(6, '0');
      c.font = ctx.renderer.font;
      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillText(text, x, y);
    },

    // --- Window management ---
    set_parent: (hwnd, newParent) => {
      const r = ctx.renderer;
      if (!r) return;
      const win = r.windows[hwnd];
      if (!win) return;
      win.parentHwnd = newParent || 0;
      win.isChild = !!(newParent && r.windows[newParent]);
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.parentHwnd && r.windows[win.parentHwnd]) {
        const parent = r.windows[win.parentHwnd];
        if (String(parent.className || '').toLowerCase() === 'afxcontrolbar42') {
          const parentW = parent.clientRect && parent.clientRect.w > 0 ? parent.clientRect.w : parent.w;
          if (parentW > 0 && win.w > parentW + 8) win.w = parentW;
          r._computeClientRect(win);
        }
      }
    },
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = readStr(titlePtr);
      console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId}`);
      if (!ctx._windowText) ctx._windowText = new Map();
      ctx._windowText.set(hwnd, title);
      if (ctx.renderer) {
        ctx.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId, ctx.instance || null, ctx.wasmMemory || null);
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        if (win) win.processId = (ctx.processId >>> 0) || 1000;
      }
      return hwnd;
    },
    sys_command: (hwnd, sc) => {
      // WAT DefWindowProcA routes SC_MINIMIZE/SC_MAXIMIZE/SC_RESTORE here
      // so renderer-side window state stays in sync with the guest.
      const r = ctx.renderer;
      if (!r) return;
      const win = r.windows[hwnd];
      if (!win) return;
      if (sc === 0xF020) { // SC_MINIMIZE
        win.visible = false;
        win._minimized = true;
      } else if (sc === 0xF030) { // SC_MAXIMIZE
        if (!win._maximized) {
          const validRestore =
            Number.isFinite(win.x) && Number.isFinite(win.y) &&
            Number.isFinite(win.w) && Number.isFinite(win.h) &&
            win.w > 0 && win.h > 0 &&
            win.x > -1000000 && win.y > -1000000;
          win._restoreRect = validRestore
            ? { x: win.x, y: win.y, w: win.w, h: win.h }
            : {
                x: 20,
                y: 20,
                w: Math.min(640, Math.max(160, r.canvas.width - 40)),
                h: Math.min(480, Math.max(120, r.canvas.height - 40)),
              };
          win.x = 0; win.y = 0;
          win.w = r.canvas.width;
          win.h = r.canvas.height;
          win._maximized = true;
        }
      } else if (sc === 0xF120) { // SC_RESTORE
        if (win._maximized && win._restoreRect) {
          win.x = win._restoreRect.x;
          win.y = win._restoreRect.y;
          win.w = win._restoreRect.w;
          win.h = win._restoreRect.h;
          win._maximized = false;
        }
        if (win._minimized) {
          win.visible = true;
          win._minimized = false;
        }
      }
      if (typeof r._computeClientRect === 'function') r._computeClientRect(win);
      if (r.invalidate) r.invalidate(hwnd);
      if (r.repaint) r.repaint();
    },
    show_window: (hwnd, cmd) => {
      console.log(`[ShowWindow] hwnd=0x${hwnd.toString(16)} cmd=${cmd}`);
      if (ctx.renderer) ctx.renderer.showWindow(hwnd, cmd);
      const win = ctx.renderer && ctx.renderer.windows[hwnd];
      if (win && win.clientRect) {
        const packed = (win.clientRect.w & 0xFFFF) | ((win.clientRect.h & 0xFFFF) << 16);
        return packed;
      }
      return 0;
    },
    dialog_loaded: (hwnd, parentHwnd) => {
      // WAT's $dlg_load has parsed the RT_DIALOG template into WND_DLG_RECORDS
      // and CONTROL_TABLE. The renderer reads all state from WAT exports —
      // there is no JS-side template parser left.
      if (ctx.renderer) {
        ctx.renderer.createDialog(hwnd, parentHwnd);
        const win = ctx.renderer.windows && ctx.renderer.windows[hwnd];
        if (win) win.processId = (ctx.processId >>> 0) || 1000;
      }
    },
    load_icon: (hInstance, resourceId) => {
      return 0x50000 | (resourceId & 0xFFFF);
    },
    load_cursor: (hInstance, resourceId) => {
      if (!hInstance) return 0x60000 | (resourceId & 0xFFFF);
      return 0x680000 | (resourceId & 0xFFFF);
    },
    set_cursor: (hcur) => {
      const canvas = ctx.renderer && ctx.renderer.canvas;
      if (!canvas || !canvas.style) return;
      if ((hcur & 0xFF0000) === 0x680000) {
        const custom = _cursorCssForHandle(hcur);
        if (custom && canvas.style.cursor !== custom) canvas.style.cursor = custom;
        return;
      }
      const idc = hcur & 0xFFFF;
      let css;
      switch (idc) {
        case 0x7F00: css = 'default'; break;      // IDC_ARROW
        case 0x7F01: css = 'text'; break;         // IDC_IBEAM
        case 0x7F02: css = 'wait'; break;         // IDC_WAIT
        case 0x7F03: css = 'crosshair'; break;    // IDC_CROSS
        case 0x7F04: css = 'crosshair'; break;    // IDC_UPARROW → no good CSS match
        case 0x7F82: css = 'nwse-resize'; break;  // IDC_SIZENWSE
        case 0x7F83: css = 'nesw-resize'; break;  // IDC_SIZENESW
        case 0x7F84: css = 'ew-resize'; break;    // IDC_SIZEWE
        case 0x7F85: css = 'ns-resize'; break;    // IDC_SIZENS
        case 0x7F86: css = 'move'; break;         // IDC_SIZEALL
        case 0x7F88: css = 'not-allowed'; break;  // IDC_NO
        case 0x7F89: css = 'pointer'; break;      // IDC_HAND
        case 0x7F8A: css = 'progress'; break;     // IDC_APPSTARTING
        case 0x7F8B: css = 'help'; break;         // IDC_HELP
        default:     css = 'default'; break;
      }
      if (canvas.style.cursor !== css) canvas.style.cursor = css;
    },
    send_ctrl_msg: (ctrlHwnd, msg, wParam, lParam) => {
      // Progress bar / richedit-style messages to a child control. WAT
      // CONTROL_TABLE and the renderer's GDI paint path are the source of
      // truth; this host import is a no-op stub kept so WAT's call site
      // doesn't trap.
    },
    richedit_stream: (ctrlHwnd, textPtr) => {
      let text = readStr(textPtr, 65536);
      // Strip RTF if it starts with '{'
      if (text.startsWith('{\\rtf')) {
        text = text.replace(/\{[^{}]*\}/g, '').replace(/\\[a-z]+\d* ?/g, '').replace(/[{}]/g, '').trim();
      }
      console.log(`[RichEdit] hwnd=0x${ctrlHwnd.toString(16)} text=${text.length} chars`);
    },
    set_window_text: (hwnd, textPtr) => {
      const text = readStr(textPtr);
      if (!ctx._windowText) ctx._windowText = new Map();
      ctx._windowText.set(hwnd, text);
      if (ctx.renderer) ctx.renderer.setWindowText(hwnd, text);
    },
    set_window_class: (hwnd, classPtr) => {
      if (ctx.renderer) ctx.renderer.setWindowClass(hwnd, readStr(classPtr));
    },
    get_window_class: (hwnd, bufWA, maxLen) => {
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      const className = (win && win.className) || '';
      if (maxLen <= 0) return 0;
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(className.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = className.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    get_window_text: (hwnd, bufWA, maxLen) => {
      const localText = ctx._windowText && ctx._windowText.get(hwnd);
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      const text = localText !== undefined ? localText : ((win && win.title) || '');
      if (maxLen <= 0) return 0;
      const bytes = new Uint8Array(ctx.getMemory());
      const len = Math.min(text.length, maxLen - 1);
      for (let i = 0; i < len; i++) bytes[bufWA + i] = text.charCodeAt(i) & 0xFF;
      bytes[bufWA + len] = 0;
      return len;
    },
    get_window_text_length: (hwnd) => {
      const localText = ctx._windowText && ctx._windowText.get(hwnd);
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      const text = localText !== undefined ? localText : ((win && win.title) || '');
      return text.length;
    },
    get_window_related: (hwnd, cmd) => {
      const r = ctx.renderer;
      const windows = r && r.windows;
      if (!windows) return 0;
      const win = windows[hwnd >>> 0];
      const sortedByZ = list => list
        .filter(w => w && w.hwnd)
        .sort((a, b) => ((b.zOrder || 0) - (a.zOrder || 0)) || ((b.hwnd || 0) - (a.hwnd || 0)));
      // GetDesktopWindow is a WAT-side phantom handle. Its GW_CHILD relation
      // is the renderer's top-level z-order, spanning every app instance.
      if ((!win && (hwnd >>> 0) === 0x10000) || (!win && !hwnd)) {
        if (cmd !== 5) return 0;
        const top = sortedByZ(Object.values(windows).filter(w => w && !w.isChild));
        return top.length ? (top[0].hwnd >>> 0) : 0;
      }
      if (!win) return 0;
      const sameSiblingGroup = w => {
        if (!w) return false;
        if (!!w.isChild !== !!win.isChild) return false;
        if (win.isChild) return (w.parentHwnd >>> 0) === (win.parentHwnd >>> 0);
        return !w.isChild;
      };
      if (cmd === 0 || cmd === 1 || cmd === 2 || cmd === 3) { // GW_HWNDFIRST/LAST/NEXT/PREV
        const siblings = sortedByZ(Object.values(windows).filter(sameSiblingGroup));
        if (!siblings.length) return 0;
        if (cmd === 0) return siblings[0].hwnd >>> 0;
        if (cmd === 1) return siblings[siblings.length - 1].hwnd >>> 0;
        const pos = siblings.findIndex(w => (w.hwnd >>> 0) === (hwnd >>> 0));
        if (pos < 0) return 0;
        if (cmd === 2) return pos + 1 < siblings.length ? (siblings[pos + 1].hwnd >>> 0) : 0;
        return pos > 0 ? (siblings[pos - 1].hwnd >>> 0) : 0;
      }
      if (cmd === 4) { // GW_OWNER
        return (win.ownerHwnd || 0) >>> 0;
      }
      if (cmd === 5) { // GW_CHILD
        const children = sortedByZ(Object.values(windows).filter(w =>
          w && w.isChild && (w.parentHwnd >>> 0) === (hwnd >>> 0)));
        return children.length ? (children[0].hwnd >>> 0) : 0;
      }
      if (cmd === 6) { // GW_ENABLEDPOPUP
        const popups = sortedByZ(Object.values(windows).filter(w =>
          w && !w.isChild &&
          (w.ownerHwnd >>> 0) === (hwnd >>> 0) &&
          w.visible !== false &&
          w.enabled !== false));
        return popups.length ? (popups[0].hwnd >>> 0) : (hwnd >>> 0);
      }
      return 0;
    },
    get_window_info: (hwnd, prop) => {
      const win = ctx.renderer && ctx.renderer.windows && ctx.renderer.windows[hwnd >>> 0];
      if (!win) return 0;
      if (prop === 0) return win.style >>> 0;
      if (prop === 1) return win.visible !== false ? 1 : 0;
      if (prop === 2) return win.enabled === false ? 0 : 1;
      if (prop === 3) return (win.processId >>> 0) || 0;
      return 0;
    },
    post_window_message: (hwnd, msg, wParam, lParam) => {
      const r = ctx.renderer;
      const win = r && r.windows && r.windows[hwnd >>> 0];
      const e = (win && win.wasm && win.wasm.exports) || ctx.exports || (r && r.wasm && r.wasm.exports);
      if (!e || typeof e.post_message_q !== 'function') return 0;
      e.post_message_q(hwnd >>> 0, msg >>> 0, wParam >>> 0, lParam >>> 0);
      return 1;
    },
    activate_window: (hwnd) => {
      const r = ctx.renderer;
      if (!r || !r.windows) return 1;
      const win = r.windows[hwnd >>> 0];
      if (win) {
        win.zOrder = r._nextZ++;
        if (typeof r._setKeyboardInputOwner === 'function') r._setKeyboardInputOwner(win);
        if (typeof r.invalidate === 'function') r.invalidate(hwnd);
        if (typeof r.scheduleRepaint === 'function') r.scheduleRepaint();
        else if (typeof r.repaint === 'function') r.repaint();
      }
      return 1;
    },
    arrange_windows: (mode, flags, rectWa, count, hwndsWa) => {
      const r = ctx.renderer;
      if (!r || !r.windows) return 0;
      const dv = new DataView(ctx.getMemory());
      let left = 0, top = 0, right = r.canvas ? r.canvas.width : 640;
      let bottom = r.canvas ? r.canvas.height : 480;
      if (rectWa && rectWa + 16 <= dv.byteLength) {
        left = dv.getInt32(rectWa, true);
        top = dv.getInt32(rectWa + 4, true);
        right = dv.getInt32(rectWa + 8, true);
        bottom = dv.getInt32(rectWa + 12, true);
      }
      if (r.canvas) {
        left = Math.max(0, Math.min(left, r.canvas.width - 1));
        top = Math.max(0, Math.min(top, r.canvas.height - 1));
        right = Math.max(left + 1, Math.min(right, r.canvas.width));
        bottom = Math.max(top + 1, Math.min(bottom, r.canvas.height));
      }
      const width = Math.max(1, right - left);
      const height = Math.max(1, bottom - top);
      let windows = [];
      if (mode === 2) {
        windows = Object.values(r.windows).filter(win =>
          win && !win.isChild && win._minimized && win.hasCaption !== false);
      } else {
        const limit = Math.max(0, Math.min(count | 0, 256));
        for (let i = 0; i < limit && hwndsWa + i * 4 + 4 <= dv.byteLength; i++) {
          const win = r.windows[dv.getUint32(hwndsWa + i * 4, true)];
          if (win && !win.isChild) windows.push(win);
        }
      }
      if (!windows.length) return 0;
      if (mode === 0) {
        const step = 24;
        const w = Math.max(160, width - step * Math.max(0, windows.length - 1));
        const h = Math.max(100, height - step * Math.max(0, windows.length - 1));
        windows.forEach((win, i) => {
          win.x = left + i * step; win.y = top + i * step;
          win.w = w; win.h = h; win.visible = true; win._minimized = false;
          const e = win.wasm && win.wasm.exports;
          if (e && e.post_resize_messages) e.post_resize_messages(win.hwnd, 0);
          if (r._computeClientRect) r._computeClientRect(win);
        });
      } else if (mode === 1) {
        const horizontal = !!(flags & 1); // MDITILE_HORIZONTAL
        windows.forEach((win, i) => {
          if (horizontal) {
            const y0 = top + Math.floor(height * i / windows.length);
            const y1 = top + Math.floor(height * (i + 1) / windows.length);
            win.x = left; win.y = y0; win.w = width; win.h = y1 - y0;
          } else {
            const x0 = left + Math.floor(width * i / windows.length);
            const x1 = left + Math.floor(width * (i + 1) / windows.length);
            win.x = x0; win.y = top; win.w = x1 - x0; win.h = height;
          }
          win.visible = true; win._minimized = false;
          const e = win.wasm && win.wasm.exports;
          if (e && e.post_resize_messages) e.post_resize_messages(win.hwnd, 0);
          if (r._computeClientRect) r._computeClientRect(win);
        });
      } else {
        const iconW = 160, iconH = 28;
        const cols = Math.max(1, Math.floor(width / iconW));
        windows.forEach((win, i) => {
          const row = Math.floor(i / cols);
          const col = i % cols;
          win.x = left + col * iconW;
          win.y = bottom - (row + 1) * iconH;
          win.w = Math.min(iconW, width);
          win.h = iconH;
          if (r._computeClientRect) r._computeClientRect(win);
        });
        if (r.scheduleRepaint) r.scheduleRepaint();
        return Math.ceil(windows.length / cols) * iconH;
      }
      for (const win of windows) {
        win.zOrder = r._nextZ++;
        if (r.invalidate) r.invalidate(win.hwnd);
      }
      if (r.scheduleRepaint) r.scheduleRepaint();
      return windows.length;
    },
    invalidate: (hwnd) => {
      if (_env.DBG_INV) console.log('[INVALIDATE] hwnd=0x' + hwnd.toString(16));
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    get_window_client_size: (hwnd) => {
      if (!ctx.renderer) return (640 & 0xFFFF) | (480 << 16);
      const win = ctx.renderer.windows[hwnd];
      if (!win) return (640 & 0xFFFF) | (480 << 16);
      // Prefer WAT get_client_rect_wh (authoritative after NCCALCSIZE). This
      // matters for child controls with non-client borders such as Solitaire's
      // status child.
      const e = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (e && e.get_client_rect_wh) {
        const packed = e.get_client_rect_wh(hwnd) | 0;
        if (packed) return packed;
      }
      const cr = win.clientRect;
      if (cr) return (cr.w & 0xFFFF) | (cr.h << 16);
      if (win.isChild) {
        return (win.w & 0xFFFF) | (win.h << 16);
      }
      return (win.w & 0xFFFF) | (win.h << 16);
    },
    get_window_rect: (hwnd, rectPtr) => {
      const mem = new DataView(ctx.getMemory());
      if (!ctx.renderer) {
        // Desktop fallback
        mem.setInt32(rectPtr, 0, true);
        mem.setInt32(rectPtr + 4, 0, true);
        mem.setInt32(rectPtr + 8, 640, true);
        mem.setInt32(rectPtr + 12, 480, true);
        return;
      }
      const win = ctx.renderer.windows[hwnd];
      if (win) {
        const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
        if (win.isChild && we && we.wnd_window_screen_x && we.wnd_window_screen_y && we.wnd_screen_w && we.wnd_screen_h) {
          try {
            const x = we.wnd_window_screen_x(hwnd) | 0;
            const y = we.wnd_window_screen_y(hwnd) | 0;
            const w = we.wnd_screen_w(hwnd) | 0;
            const h = we.wnd_screen_h(hwnd) | 0;
            mem.setInt32(rectPtr, x, true);
            mem.setInt32(rectPtr + 4, y, true);
            mem.setInt32(rectPtr + 8, x + w, true);
            mem.setInt32(rectPtr + 12, y + h, true);
            return;
          } catch (_) {}
        }
        mem.setInt32(rectPtr, win.x, true);
        mem.setInt32(rectPtr + 4, win.y, true);
        mem.setInt32(rectPtr + 8, win.x + win.w, true);
        mem.setInt32(rectPtr + 12, win.y + win.h, true);
        return;
      }
      if (ctx._getWindowRectFallbackDepth) {
        mem.setInt32(rectPtr, 0, true);
        mem.setInt32(rectPtr + 4, 0, true);
        mem.setInt32(rectPtr + 8, 640, true);
        mem.setInt32(rectPtr + 12, 480, true);
        return;
      }
      const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (we && we.wnd_get_style_export && we.wnd_window_screen_x && we.wnd_window_screen_y && we.wnd_screen_w && we.wnd_screen_h) {
        try {
          ctx._getWindowRectFallbackDepth = (ctx._getWindowRectFallbackDepth || 0) + 1;
          const style = we.wnd_get_style_export(hwnd) >>> 0;
          if (style & 0x40000000) {
            const x = we.wnd_window_screen_x(hwnd) | 0;
            const y = we.wnd_window_screen_y(hwnd) | 0;
            const w = we.wnd_screen_w(hwnd) | 0;
            const h = we.wnd_screen_h(hwnd) | 0;
            mem.setInt32(rectPtr, x, true);
            mem.setInt32(rectPtr + 4, y, true);
            mem.setInt32(rectPtr + 8, x + w, true);
            mem.setInt32(rectPtr + 12, y + h, true);
            return;
          }
        } catch (_) {
        } finally {
          ctx._getWindowRectFallbackDepth = Math.max(0, (ctx._getWindowRectFallbackDepth || 1) - 1);
        }
      }
      // hwnd=0 or unknown → desktop rect
      mem.setInt32(rectPtr, 0, true);
      mem.setInt32(rectPtr + 4, 0, true);
      mem.setInt32(rectPtr + 8, 640, true);
      mem.setInt32(rectPtr + 12, 480, true);
    },
    move_window: (hwnd, x, y, w, h, flags) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      const wasVisible = !!win.visible;
      // CW_USEDEFAULT (-2147483648) means "keep existing position/size";
      // common when MFC echoes back unset WINDOWPLACEMENT fields.
      const useDefault = v => v === -2147483648 || v === 0x80000000 | 0;
      if (!(flags & 2)) {
        if (!useDefault(x)) win.x = x;
        if (!useDefault(y)) win.y = y;
      }
      if (!(flags & 1)) {
        const preserveHiddenTopLevelSize =
          !win.isChild && !win.visible &&
          w === 0 && h === 0 &&
          win.w > 0 && win.h > 0;
        if (!preserveHiddenTopLevelSize) {
          if (!useDefault(w)) win.w = Math.max(0, w);
          if (!useDefault(h)) win.h = Math.max(0, h);
        }
        // Fixed resource dialogs (Win98 Calculator standard view) can issue a
        // SetWindowPos with the template width and an oversized height while
        // probing/changing layout. Real USER keeps the fixed dialog frame at
        // the template bounds; otherwise our per-window canvas becomes a tall
        // stale gray hit target.
        if (win.isDialog && win._templateW && win._templateH &&
            Math.abs(win.w - win._templateW) <= 8 &&
            win.h > win._templateH + 64) {
          win.w = win._templateW;
          win.h = win._templateH;
        }
      }
      // SWP_SHOWWINDOW=0x40 / SWP_HIDEWINDOW=0x80 — SDL relies on this to reveal
      // the window after SetVideoMode (no explicit ShowWindow(SW_SHOW) call).
      if (flags & 0x40) {
        win.visible = true;
        // Re-bump windows that are actually becoming visible. Reused popups
        // also need a fresh bump so a combobox dropdown stays above its
        // parent. Repeated SWP_SHOWWINDOW on an already-visible normal window
        // must not steal z-order from a later SetForegroundWindow call.
        if (!wasVisible || win.isPopup) {
          win.zOrder = ctx.renderer._nextZ++ + (win.isPopup ? 1000000 : 0);
        }
      }
      if (flags & 0x80) win.visible = false;
      // MFC control bars may cache a toolbar's full ideal button span and then
      // reposition the ToolbarWindow32 child with SWP_NOSIZE. The toolbar still
      // needs to be clipped by the containing AfxControlBar surface; otherwise
      // WordPad's formatting toolbar dumps/allocates as a 1512px-wide child in
      // a 394px frame.
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.parentHwnd && ctx.renderer.windows[win.parentHwnd]) {
        const parent = ctx.renderer.windows[win.parentHwnd];
        if (String(parent.className || '').toLowerCase() === 'afxcontrolbar42') {
          const parentW = parent.clientRect && parent.clientRect.w > 0 ? parent.clientRect.w : parent.w;
          if (parentW > 0 && win.w > parentW + 8) win.w = parentW;
        }
      }
      if (String(win.className || '').toLowerCase() === 'afxcontrolbar42') {
        const parentW = win.clientRect && win.clientRect.w > 0 ? win.clientRect.w : win.w;
        if (parentW > 0) {
          for (const child of Object.values(ctx.renderer.windows)) {
            if (!child || child.parentHwnd !== hwnd) continue;
            if (String(child.className || '').toLowerCase() !== 'toolbarwindow32') continue;
            if (child.w > parentW + 8) {
              child.w = parentW;
              ctx.renderer._computeClientRect(child);
            }
          }
        }
      }
      ctx.renderer._computeClientRect(win);
      if (wasVisible && !win.visible) _queueParentExposePaint(win);
      if (!win.isChild) ctx.renderer.scheduleRepaint();
    },
    sync_window_client: (hwnd, x, y, w, h) => {
      if (!ctx.renderer) return;
      const win = ctx.renderer.windows[hwnd];
      if (!win) return;
      let width = Math.max(0, w | 0);
      if (String(win.className || '').toLowerCase() === 'toolbarwindow32' &&
          win.w > 0 && width > win.w + 8) {
        width = win.w;
      }
      win.clientRect = {
        x: x | 0,
        y: y | 0,
        w: width,
        h: Math.max(0, h | 0),
      };
    },
    destroy_window: (hwnd) => {
      if (!ctx.renderer) return;
      const destroyed = ctx.renderer.windows[hwnd];
      const wasTopLevel = destroyed && !destroyed.isChild;
      const exposedParent = destroyed && destroyed.isChild ? destroyed : (destroyed && destroyed.visible ? destroyed : null);
      // Drop any per-window menu data the WAT side is holding for this hwnd.
      const we = ctx.exports || (ctx.renderer.wasm && ctx.renderer.wasm.exports);
      if (we && we.menu_clear) we.menu_clear(hwnd);
      for (const k of Object.keys(ctx.renderer.windows)) {
        if (ctx.renderer.windows[k].parentHwnd === hwnd) {
          delete ctx.renderer.windows[k];
        }
      }
      delete ctx.renderer.windows[hwnd];
      if (wasTopLevel && ctx.renderer.notifyShellWindow) {
        ctx.renderer.notifyShellWindow(2, hwnd);
      }
      if (wasTopLevel && ctx.onTopLevelWindowDestroyed) {
        try { ctx.onTopLevelWindowDestroyed(hwnd, destroyed); } catch (_) {}
      }
      _queueParentExposePaint(exposedParent);
      ctx.renderer.scheduleRepaint();
    },
    set_menu: (hwnd, menuResId) => {
      if (ctx.renderer) ctx.renderer.setMenu(hwnd, menuResId);
    },
    menu_create: () => {
      if (!ctx._hostMenus) ctx._hostMenus = new Map();
      const h = ctx._nextHostMenu || 0x800001;
      ctx._nextHostMenu = h + 1;
      ctx._hostMenus.set(h, []);
      return h;
    },
    menu_destroy: (hMenu) => {
      if (ctx._hostMenus) ctx._hostMenus.delete(hMenu >>> 0);
      return 1;
    },
    menu_append: (hMenu, flags, idOrSubmenu, textWA, isWide) => {
      if (!ctx._hostMenus) ctx._hostMenus = new Map();
      const h = hMenu >>> 0;
      if (!ctx._hostMenus.has(h)) ctx._hostMenus.set(h, []);
      const text = textWA ? (isWide ? readStrW(textWA) : readStr(textWA)) : '';
      const f = flags >>> 0;
      ctx._hostMenus.get(h).push({
        flags: f,
        id: idOrSubmenu >>> 0,
        submenu: (f & 0x0010) ? (idOrSubmenu >>> 0) : 0, // MF_POPUP
        popup: !!(f & 0x0010),
        separator: !!(f & 0x0800), // MF_SEPARATOR
        disabled: !!(f & 0x0003),  // MF_GRAYED | MF_DISABLED
        text,
        isWide: !!isWide,
      });
      return 1;
    },
    // --- Input (override for interactive/test) ---
    check_input: () => 0,
    check_input_lparam: () => 0,
    check_input_hwnd: () => 0,
    get_mouse_position: () => ctx.renderer && ctx.renderer.getMousePosition ? ctx.renderer.getMousePosition() : 0,
    set_mouse_position: (x, y) => { if (ctx.renderer && ctx.renderer.setMousePosition) ctx.renderer.setMousePosition(x, y); },
    get_mouse_buttons: () => ctx.renderer && ctx.renderer.getMouseButtons ? ctx.renderer.getMouseButtons() : 0,
    get_async_key_state: (vKey) => ctx.renderer ? ctx.renderer.getAsyncKeyState(vKey) : 0,
    get_key_down_state: (vKey) => ctx.renderer && ctx.renderer.peekAsyncKeyState ? ctx.renderer.peekAsyncKeyState(vKey) : 0,

    // --- Real GDI presentation boundaries ---
    gdi_set_region_bands: (hrgn, rectsWA, count) => {
      if (count === -1) {
        delete _regionPresentations[hrgn];
        return 1;
      }
      if (count < 0 || count > 208) return 0;
      let rgn = _regionPresentations[hrgn];
      if (!rgn) rgn = _regionPresentations[hrgn] = _makeRectRgn(0, 0, 0, 0);
      if (rgn.type !== 'region') return 0;
      const dv = new DataView(ctx.getMemory());
      const rects = [];
      for (let i = 0; i < count; i++) {
        const p = rectsWA + i * 16;
        rects.push({
          l: dv.getInt32(p, true), t: dv.getInt32(p + 4, true),
          r: dv.getInt32(p + 8, true), b: dv.getInt32(p + 12, true),
        });
      }
      const fresh = _makeBandRgn(rects);
      rgn.branches = fresh.branches;
      rgn.bbox = fresh.bbox;
      rgn.simpleRect = fresh.simpleRect;
      rgn.rects = fresh.rects;
      return 1;
    },
    gdi_set_window_rgn: (hwnd, hrgn, redraw) => {
      if (!hrgn) {
        if (ctx.renderer) {
          ctx.renderer.setWindowRgn(hwnd, null);
          if (redraw) ctx.renderer.scheduleRepaint();
        }
        return 1;
      }
      const rgn = _regionPresentations[hrgn];
      if (!rgn || rgn.type !== 'region') return 0;
      if (ctx.renderer) {
        ctx.renderer.setWindowRgn(hwnd, rgn);
        if (redraw) ctx.renderer.scheduleRepaint();
      }
      return 1;
    },
    invalidate_rect: (hwnd, l, t, r, b, erase) => {
      if (!hwnd) return;
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    invalidate_rgn: (hwnd, hrgn, erase) => {
      if (!hwnd) return;
      if (ctx.renderer) ctx.renderer.invalidate(hwnd);
    },
    validate_rect: (hwnd, l, t, r, b) => {
      return 1;
    },
    validate_rgn: (hwnd, hrgn) => {
      return 1;
    },
    get_update_rect: (hwnd, rectWA) => {
      if (rectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true);
        dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true);
      }
      return 0;
    },
    get_update_rgn: (hwnd, dstHrgn) => {
      const dst = _regionPresentations[dstHrgn];
      if (!dst || dst.type !== 'region') return 0;
      const fresh = _makeRectRgn(0, 0, 0, 0);
      dst.branches = fresh.branches; dst.bbox = fresh.bbox;
      dst.simpleRect = null; dst.rects = fresh.rects;
      return 1;
    },
    next_dirty_hwnd: () => {
      return 0;
    },
    seed_child_paints: () => 0,
    begin_paint_clip: (hdc, hwnd, rectWA) => {
      if (rectWA) {
        const dv = new DataView(ctx.getMemory());
        dv.setInt32(rectWA, 0, true); dv.setInt32(rectWA + 4, 0, true);
        dv.setInt32(rectWA + 8, 0, true); dv.setInt32(rectWA + 12, 0, true);
      }
      return 0;
    },
    // Compatibility for stale prebuilt wasm artifacts. Current WAT computes
    // window visibility clips itself via dc_apply_* helpers.
    apply_window_clip: () => 1,
    gdi_surface_create: (id, width, height, bpp, bitsWa, stride, topDown,
      paletteWa, paletteCount, redMask, greenMask, blueMask) => {
      id >>>= 0; width |= 0; height |= 0; bpp |= 0; bitsWa >>>= 0; stride |= 0;
      paletteWa >>>= 0; paletteCount |= 0;
      redMask >>>= 0; greenMask >>>= 0; blueMask >>>= 0;
      if (!id || width <= 0 || height <= 0 || !bitsWa || stride <= 0 ||
          ![1, 4, 8, 16, 24, 32].includes(bpp)) return 0;
      const byteLength = stride * height;
      if (!Number.isSafeInteger(byteLength) || byteLength <= 0 ||
          bitsWa + byteLength > ctx.getMemory().byteLength) return 0;
      // Canonical top-level window surfaces occupy the WAT-assigned
      // 0x610001..0x610100 id range. Seed their otherwise undefined pixels
      // with COLOR_BTNFACE before sparse primitives start uploading bounding
      // rectangles. This prevents untouched pixels inside DrawEdge/FrameRect
      // bounds from appearing as an opaque black slab around Paint's options
      // well and other incrementally painted Win98 controls.
      if (bpp === 32 && id >= 0x00610001 && id <= 0x00610100) {
        const storage = new Uint8Array(ctx.getMemory());
        if ((bitsWa & 3) === 0 && (byteLength & 3) === 0) {
          new Uint32Array(storage.buffer, bitsWa, byteLength >>> 2).fill(0xFFC0C0C0);
        } else {
          for (let p = bitsWa; p < bitsWa + byteLength; p += 4) {
            storage[p] = 0xC0;
            storage[p + 1] = 0xC0;
            storage[p + 2] = 0xC0;
            storage[p + 3] = 0xFF;
          }
        }
      }
      const palette = [];
      if (bpp <= 8 && paletteWa && paletteCount > 0) {
        const mem = new Uint8Array(ctx.getMemory());
        const count = Math.min(paletteCount, 1 << bpp);
        if (paletteWa + count * 4 > mem.length) return 0;
        const directDraw = id >= 0x200000 && id < 0x300000;
        for (let i = 0; i < count; i++) {
          const p = paletteWa + i * 4;
          palette.push(directDraw
            ? [mem[p], mem[p + 1], mem[p + 2]]
            : [mem[p + 2], mem[p + 1], mem[p]]);
        }
      }
      const masks = bpp === 16 && (redMask || greenMask || blueMask)
        ? [redMask, greenMask, blueMask]
        : undefined;
      const canvas = _createOffscreen(width, height);
      if (!canvas || !_gdiSurface.GdiSurface) return 0;
      try {
        const surface = new _gdiSurface.GdiSurface({
          width, height, bpp, stride, topDown: !!topDown,
          storage: new Uint8Array(ctx.getMemory()), storageOffset: bitsWa,
          palette, masks, format: bpp === 32 ? 'bgra32' : `dib${bpp}`,
        });
        // Canvas is only a derived presentation cache. Seed it from the full
        // canonical surface before attaching it anywhere; otherwise pixels
        // that have not appeared in a later dirty upload stay transparent.
        // On window surfaces those holes showed through as white client-edge
        // gaps even though WAT memory already contained COLOR_BTNFACE.
        const canvasContext = canvas.getContext('2d');
        const initialImage = canvasContext.createImageData(width, height);
        initialImage.data.set(surface.rgbaRect(0, 0, width, height));
        canvasContext.putImageData(initialImage, 0, 0);
        const presentation = {
          id, width, height, canvas, surface, bitsWa, byteLength,
          paletteWa, paletteCount, masks, canvasContext,
          flushCount: 0, flushedPixels: 0,
        };
        presentation.rawGetImageData = canvasContext.getImageData.bind(canvasContext);
        presentation.flush = () => _flushGdiSurfacePresentation(presentation);
        surface.onDirty = () => _scheduleGdiPresentation(presentation);
        canvas._waFlushCanonicalSurface = presentation.flush;
        canvasContext.getImageData = (...args) => {
          presentation.flush();
          return presentation.rawGetImageData(...args);
        };
        if (typeof canvas.toBuffer === 'function') {
          const rawToBuffer = canvas.toBuffer.bind(canvas);
          canvas.toBuffer = (...args) => {
            presentation.flush();
            return rawToBuffer(...args);
          };
        }
        if (typeof canvas.toDataURL === 'function') {
          const rawToDataURL = canvas.toDataURL.bind(canvas);
          canvas.toDataURL = (...args) => {
            presentation.flush();
            return rawToDataURL(...args);
          };
        }
        _gdiSurfacePresentations.set(id, presentation);
        return 1;
      } catch (_) {
        return 0;
      }
    },
    gdi_surface_upload: (id, left, top, right, bottom) => {
      const presentation = _gdiSurfacePresentations.get(id >>> 0);
      if (!presentation) return 0;
      const { width, height, surface } = presentation;
      left = Math.max(0, left | 0); top = Math.max(0, top | 0);
      right = Math.min(width, right | 0); bottom = Math.min(height, bottom | 0);
      if (right <= left || bottom <= top) return 1;
      surface.markDirty(left, top, right - left, bottom - top);
      return 1;
    },
    gdi_surface_attach: (id, hwnd) => {
      const presentation = _gdiSurfacePresentations.get(id >>> 0);
      hwnd |= 0;
      if (!presentation || !ctx.renderer) return 0;
      if (hwnd === -1) {
        if (!ctx.renderer.attachDesktopSurface) return 0;
        if (!ctx.renderer.attachDesktopSurface(presentation.canvas)) return 0;
        presentation.targetDesktop = true;
        _scheduleGdiPresentation(presentation);
        return 1;
      }
      if (!hwnd) {
        if (!ctx.renderer.attachMenuOverlaySurface) return 0;
        if (!ctx.renderer.attachMenuOverlaySurface(presentation.canvas)) return 0;
        presentation.targetOverlay = true;
        _scheduleGdiPresentation(presentation);
        return 1;
      }
      if (!ctx.renderer.attachWindowSurface) return 0;
      if (!ctx.renderer.attachWindowSurface(hwnd, presentation.canvas)) return 0;
      presentation.targetHwnd = hwnd;
      _scheduleGdiPresentation(presentation);
      return 1;
    },
    gdi_surface_delete: (id) => {
      id >>>= 0;
      const presentation = _gdiSurfacePresentations.get(id);
      if (presentation && presentation.targetHwnd && ctx.renderer && ctx.renderer.detachWindowSurface) {
        ctx.renderer.detachWindowSurface(presentation.targetHwnd, presentation.canvas);
      }
      if (presentation && presentation.targetOverlay && ctx.renderer && ctx.renderer.detachMenuOverlaySurface) {
        ctx.renderer.detachMenuOverlaySurface(presentation.canvas);
      }
      if (presentation && presentation.targetDesktop && ctx.renderer && ctx.renderer.detachDesktopSurface) {
        ctx.renderer.detachDesktopSurface(presentation.canvas);
      }
      if (presentation && presentation.surface) presentation.surface.onDirty = null;
      if (presentation && presentation.canvas) delete presentation.canvas._waFlushCanonicalSurface;
      _gdiTextStates.delete(id);
      return _gdiSurfacePresentations.delete(id) ? 1 : 0;
    },
    // Text is the sole Canvas rasterizer retained by software GDI. The caller
    // supplies its canonical WAT DC record and an opaque target token. For a
    // memory DC that token is the selected surface id; for a window DC it is
    // the compositor-owned HDC. No JS GDI object/DC mirror is constructed.
    gdi_text_bind: (token, dcWa, originX, originY, auxWa, clipBandsWa, clipCount) => {
      token >>>= 0; dcWa >>>= 0; originX |= 0; originY |= 0; auxWa >>>= 0;
      clipBandsWa >>>= 0; clipCount |= 0;
      if (!token || !dcWa || dcWa + 92 > ctx.getMemory().byteLength) return 0;
      const dv = new DataView(ctx.getMemory());
      const clipBands = [];
      if (clipBandsWa && clipCount > 0 && clipCount <= 208 &&
          clipBandsWa + clipCount * 16 <= ctx.getMemory().byteLength) {
        for (let i = 0; i < clipCount; i++) {
          const p = clipBandsWa + i * 16;
          clipBands.push({
            l: dv.getInt32(p, true), t: dv.getInt32(p + 4, true),
            r: dv.getInt32(p + 8, true), b: dv.getInt32(p + 12, true),
          });
        }
      }
      _gdiTextStates.set(token, {
        textColor: dv.getUint32(dcWa + 20, true) & 0xFFFFFF,
        bkColor: dv.getUint32(dcWa + 24, true) & 0xFFFFFF,
        bkMode: dv.getInt32(dcWa + 28, true) || 2,
        textAlign: dv.getInt32(dcWa + 32, true),
        mapMode: dv.getInt32(dcWa + 36, true) || 1,
        winOrgX: dv.getInt32(dcWa + 40, true), winOrgY: dv.getInt32(dcWa + 44, true),
        winExtX: dv.getInt32(dcWa + 48, true) || 1, winExtY: dv.getInt32(dcWa + 52, true) || 1,
        vpOrgX: dv.getInt32(dcWa + 56, true) + originX,
        vpOrgY: dv.getInt32(dcWa + 60, true) + originY,
        vpExtX: dv.getInt32(dcWa + 64, true) || 1, vpExtY: dv.getInt32(dcWa + 68, true) || 1,
        surfaceOriginX: originX, surfaceOriginY: originY,
        selectedFont: dv.getUint32(dcWa + 88, true),
        charExtra: auxWa ? dv.getInt32(auxWa + 20, true) : 0,
        justifyExtra: auxWa ? dv.getInt32(auxWa + 24, true) : 0,
        justifyCount: auxWa ? dv.getInt32(auxWa + 28, true) : 0,
        clipBands: clipBandsWa ? clipBands : null,
      });
      const presentation = _gdiSurfacePresentations.get(token);
      _refreshGdiSurfacePalette(presentation);
      return 1;
    },
    gdi_text_out: (hdc, x, y, textPtr, nCount, isWide) =>
      _gdiTextOut(hdc, x, y, 0, 0, textPtr, nCount, isWide),
    gdi_ext_text_out: (hdc, x, y, options, rectWA, textPtr, nCount, isWide) => {
      return _gdiTextOut(hdc, x, y, options, rectWA, textPtr, nCount, isWide);
    },

    gdi_draw_text: (hdc, textPtr, nCount, rectWA, uFormat, isWide) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      let text = '';
      if (isWide) {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = dv.getUint16(textPtr + i * 2, true);
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(dv.getUint16(textPtr + i * 2, true));
        }
      } else {
        if (nCount === -1) {
          for (let i = 0; ; i++) {
            const ch = mem[textPtr + i];
            if (!ch) break;
            text += String.fromCharCode(ch);
          }
        } else {
          for (let i = 0; i < nCount; i++) text += String.fromCharCode(mem[textPtr + i]);
        }
      }

      // Default Win32 DrawText processes & as a mnemonic prefix (strip the
      // & and underline the next char). DT_NOPREFIX (0x800) disables it.
      // We strip here and remember the underline target so it can be drawn
      // after the text is laid out below. Matches the old _drawAccelText
      // behaviour previously hand-rolled by the JS menu painter.
      let _accelIdx = -1; // index *in stripped text* of the char to underline
      if (!(uFormat & 0x800) && text.indexOf('&') !== -1) {
        let stripped = '';
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '&' && i + 1 < text.length) {
            if (text[i + 1] === '&') { stripped += '&'; i++; continue; }
            if (_accelIdx < 0) _accelIdx = stripped.length;
            stripped += text[i + 1];
            i++;
            continue;
          }
          stripped += text[i];
        }
        text = stripped;
      }

      const dc = _getDcState(hdc);
      const font = _resolveFont(hdc);
      const fontHeight = parseInt(font.match(/(\d+)px/)?.[1]) || 13;

      // Read rect from guest memory (4 * i32)
      // Important: read this before resolving the draw target. WAT geometry
      // exports may call host_get_window_rect using PAINT_SCRATCH, and many
      // control painters pass their DrawText RECT in that same scratch buffer.
      let left = dv.getInt32(rectWA, true);
      let top = dv.getInt32(rectWA + 4, true);
      let right = dv.getInt32(rectWA + 8, true);
      let bottom = dv.getInt32(rectWA + 12, true);

      const t = _getDrawTarget(hdc, 0);
      if (!t) return fontHeight;
      t.ctx.font = font;

      const drawRect = _gdiMapRect(dc, left, top, right, bottom);
      const rectW = (uFormat & 0x400) ? (right - left) : drawRect.w;

      // DT_WORDBREAK (0x10) without DT_SINGLELINE: split text into lines
      // that fit within rectW. Plain greedy word-wrap by spaces; long words
      // that don't fit get a line of their own (still clipped, matches GDI).
      const wantsWrap = (uFormat & 0x10) && !(uFormat & 0x20) && rectW > 0;
      let lines;
      if (wantsWrap) {
        lines = [];
        const paragraphs = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
        for (const para of paragraphs) {
          const words = para.split(' ');
          let cur = '';
          const maxChars = Math.max(1, Math.floor(rectW / 6));
          for (let wi = 0; wi < words.length; wi++) {
            const word = words[wi];
            const candidate = cur === '' ? word : cur + ' ' + word;
            if (Math.round(t.ctx.measureText(candidate).width) <= rectW && candidate.length <= maxChars) {
              cur = candidate;
            } else {
              if (cur !== '') lines.push(cur);
              cur = word;
            }
          }
          lines.push(cur);
        }
        if (lines.length === 0) lines = [''];
      } else {
        lines = [text];
      }

      const sampleMetrics = t.ctx.measureText(lines[0] || ' ');
      const ascent = Number.isFinite(sampleMetrics.actualBoundingBoxAscent) && sampleMetrics.actualBoundingBoxAscent > 0
        ? sampleMetrics.actualBoundingBoxAscent
        : Math.ceil(fontHeight * 0.8);
      const descent = Number.isFinite(sampleMetrics.actualBoundingBoxDescent) && sampleMetrics.actualBoundingBoxDescent >= 0
        ? sampleMetrics.actualBoundingBoxDescent
        : Math.max(2, fontHeight - ascent);
      const lineH = Math.max(fontHeight, Math.ceil(ascent + descent));
      const totalH = lineH * lines.length;

      if (uFormat & 0x400) { // DT_CALCRECT
        let maxW = 0;
        for (const ln of lines) maxW = Math.max(maxW, Math.round(t.ctx.measureText(ln).width));
        right = left + maxW;
        bottom = top + totalH;
        dv.setInt32(rectWA + 8, right, true);
        dv.setInt32(rectWA + 12, bottom, true);
        return totalH;
      }

      let yStart = top;
      // DT_VCENTER applies to single-line only; for word-wrap GDI ignores it.
      if (uFormat & 0x20) { // DT_SINGLELINE
        if (uFormat & 0x04) yStart = top + Math.floor((bottom - top - lineH) / 2); // DT_VCENTER
        else if (uFormat & 0x08) yStart = bottom - lineH; // DT_BOTTOM
      }
      const mappedYStart = _gdiMapPoint(dc, left, yStart).y;
      let deviceYStart = mappedYStart;
      if (uFormat & 0x20) {
        if (uFormat & 0x04) deviceYStart = drawRect.t + Math.floor((drawRect.h - lineH) / 2);
        else if (uFormat & 0x08) deviceYStart = drawRect.b - lineH;
      }

      const textColor = dc.textColor || 0;
      const r = textColor & 0xFF, g = (textColor >> 8) & 0xFF, b = (textColor >> 16) & 0xFF;
      const bkMode = dc.bkMode || 2;
      const bkColor = dc.bkColor !== undefined ? dc.bkColor : 0xFFFFFF;

      _drawWithClip(hdc, (tt) => {
        const c = tt.ctx;
        const clippedToRect = !(uFormat & 0x100); // DT_NOCLIP
        if (clippedToRect) {
          c.save();
          c.beginPath();
          c.rect(tt.ox + drawRect.l, tt.oy + drawRect.t, Math.max(0, drawRect.w), Math.max(0, drawRect.h));
          c.clip();
        }
        c.font = font;
        c.textBaseline = 'alphabetic';
        try {
          for (let li = 0; li < lines.length; li++) {
            const ln = lines[li];
            const lw = Math.round(c.measureText(ln).width);
            let lx = drawRect.l;
            if (uFormat & 0x01) lx = drawRect.l + (drawRect.w - lw) / 2; // DT_CENTER
            else if (uFormat & 0x02) lx = drawRect.r - lw; // DT_RIGHT
            const ly = deviceYStart + li * lineH;
            if (bkMode === 2) { // OPAQUE
              const br = bkColor & 0xFF, bg2 = (bkColor >> 8) & 0xFF, bb = (bkColor >> 16) & 0xFF;
              c.fillStyle = `rgb(${br},${bg2},${bb})`;
              c.fillRect(tt.ox + lx, tt.oy + ly, lw, lineH);
            }
            const textX = tt.ox + lx;
            const textY = tt.oy + ly + ascent;
            const glyphBounds = {
              x: Math.floor(textX) - 1,
              y: Math.floor(tt.oy + ly) - 1,
              w: Math.max(1, Math.ceil(lw) + 2),
              h: lineH + 2,
            };
            if (ln && !_drawBinaryCanvasText(c, glyphBounds, r, g, b, mask => {
              mask.font = font;
              mask.textBaseline = 'alphabetic';
              mask.fillText(ln, textX, textY);
            })) {
              c.fillStyle = `rgb(${r},${g},${b})`;
              c.fillText(ln, textX, textY);
            }
            // Underline accelerator only if it lands on this line. _accelIdx
            // is in the original (pre-wrap) string; map it through line splits.
            if (_accelIdx >= 0 && li === 0 /* simple: only first line */ && !wantsWrap) {
              const ch = ln[_accelIdx];
              if (ch != null) {
                const prefixIncl = c.measureText(ln.substring(0, _accelIdx + 1)).width;
                const chWidth    = c.measureText(ch).width;
                const ux = tt.ox + lx + Math.round(prefixIncl - chWidth);
                const uw = Math.max(1, Math.round(chWidth));
                const uy = tt.oy + ly + Math.round(ascent) + 1;
                c.fillRect(ux, uy, uw, 1);
              }
            }
          }
        } finally {
          if (clippedToRect) c.restore();
        }
      }, {
        x: drawRect.x,
        y: drawRect.y,
        w: Math.max(0, drawRect.w),
        h: Math.max(0, drawRect.h),
      });
      return totalH;
    },

    note_richedit_charformat_size: (yHeightTwips, selectionLo, selectionHi) => {
      const twips = yHeightTwips | 0;
      if (twips > 0 && twips < 32767) {
        const px = Math.round(twips * 96 / 1440);
        if (px >= 8 && px <= 128) {
          ctx._richeditLastYHeightTwips = twips;
          ctx._richeditLastSelectionLo = Math.max(0, selectionLo | 0);
          ctx._richeditLastSelectionHi = Math.max(ctx._richeditLastSelectionLo, selectionHi | 0);
          _richeditFontSizeHint.twips = twips;
          _richeditFontSizeHint.px = px;
        }
      }
    },
    create_font: (height, weight, italic, facePtr) => {
      const face = facePtr ? readStr(facePtr, 64) : '';
      const css = _buildCssFont(height, weight, italic, face);
      const normalizedHeight = _normalizeFontHeight(height);
      return _allocFontResource({ type: 'font', height: normalizedHeight, weight, italic, face, css });
    },
    measure_text: (token, textPtr, nCount, isWide) => {
      const mem = new Uint8Array(ctx.getMemory());
      const dv = new DataView(ctx.getMemory());
      let text = '';
      if (isWide) {
        for (let i = 0; i < nCount; i++) {
          const ch = dv.getUint16(textPtr + i * 2, true);
          if (!ch) break;
          text += String.fromCharCode(ch);
        }
      } else {
        for (let i = 0; i < nCount && mem[textPtr + i]; i++) text += String.fromCharCode(mem[textPtr + i]);
      }
      const font = _resolveFont(token);
      let c;
      if (ctx.renderer) {
        c = ctx.renderer.ctx;
      } else {
        // Node/headless: approximate
        const sz = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
        return text.length * Math.round(sz * 0.6);
      }
      c.font = font;
      return Math.round(c.measureText(text).width);
    },
    get_text_metrics: (hdc) => {
      // Returns packed: (height | (aveCharWidth << 16))
      const font = _resolveFont(hdc);
      const height = parseInt(font.match(/(\d+)px/)?.[1]) || 13;
      let aveW = Math.round(height * 0.6); // reasonable default
      if (ctx.renderer) {
        const c = ctx.renderer.ctx;
        c.font = font;
        aveW = Math.round(c.measureText('x').width);
      }
      return (height & 0xFFFF) | ((aveW & 0xFFFF) << 16);
    },

    // --- Math (FPU transcendentals) ---
    math_sin: Math.sin,
    math_cos: Math.cos,
    math_tan: Math.tan,
    math_atan2: Math.atan2,
    math_log2: Math.log2,
    math_pow: Math.pow,
    math_pow2: (x) => 2 ** x,

    // --- Thread/event stubs (overridden by ThreadManager when active) ---
    create_thread: (startAddr, param, stackSize, creationFlags) => 0,
    suspend_thread: (handle) => 0xFFFFFFFF,
    resume_thread: (handle) => 0xFFFFFFFF,
    exit_thread: (exitCode) => {},
    get_exit_code_thread: (handle) => 0x103, // STILL_ACTIVE
    create_event: (manualReset, initialState) => 0,
    set_event: (handle) => 1,
    reset_event: (handle) => 1,
    wait_single: (handle, timeout) => 0, // WAIT_OBJECT_0 — immediate success
    di_set_event_notification: (deviceType, handle) => {
      const r = ctx.renderer;
      if (r) {
        if (!r._directInputEventHandles) r._directInputEventHandles = Object.create(null);
        const type = deviceType >>> 0;
        if (handle) r._directInputEventHandles[type] = handle >>> 0;
        else delete r._directInputEventHandles[type];
        r._directInputSignalEvent = (h) => host.set_event ? host.set_event(h >>> 0) : 1;
      }
      if (handle && host.set_event) host.set_event(handle >>> 0);
      return 1;
    },
    create_semaphore: (initialCount, maxCount) => 0,
    release_semaphore: (handle, releaseCount, lpPrevCountWA) => 1,
  };

  const _profileWrapHost = (name, profileName, dataFn) => {
    const orig = host[name];
    if (typeof orig !== 'function') return;
    host[name] = (...args) => {
      const startedAt = _profileNow();
      try {
        return orig(...args);
      } finally {
        let data = null;
        try { data = dataFn ? dataFn(args) : null; } catch (_) {}
        _profileEvent(profileName || name, startedAt, data);
      }
    };
  };
  _profileWrapHost('wave_out_write', 'host.waveOutWrite', ([handle, ptr, len]) => ({
    handle: handle >>> 0,
    bytes: len | 0,
  }));
  _profileWrapHost('wave_out_schedule_done', 'host.waveOutScheduleDone', ([handle, waveHdrWA, waveHdrGA, len]) => ({
    handle: handle >>> 0,
    bytes: (len === undefined ? waveHdrGA : len) | 0,
  }));
  _profileWrapHost('gdi_bitblt', 'gdi.bitblt', ([dstDC, dx, dy, w, h, srcDC, sx, sy, rop]) => ({
    dstDC: dstDC >>> 0,
    srcDC: srcDC >>> 0,
    w: w | 0,
    h: h | 0,
    pixels: Math.max(0, (w | 0) * (h | 0)),
    rop: rop >>> 0,
  }));
  _profileWrapHost('gdi_stretch_blt', 'gdi.stretchBlt', ([dstDC, dx, dy, dw, dh, srcDC, sx, sy, sw, sh, rop]) => ({
    dstDC: dstDC >>> 0,
    srcDC: srcDC >>> 0,
    w: dw | 0,
    h: dh | 0,
    pixels: Math.max(0, (dw | 0) * (dh | 0)),
    srcW: sw | 0,
    srcH: sh | 0,
    rop: rop >>> 0,
  }));

  // --- Tracing wrapper ---
  // Wraps host functions to log calls when a trace category is enabled.
  // Categories: 'gdi' (CreateBitmap, BitBlt, SelectObject, etc.)
  const trace = ctx.trace || new Set();

  if (trace.has('wave') || trace.has('audio-stats')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const traceWave = trace.has('wave');
    const stride = ctx.audioStatsStride || 50;
    // Share stats across threads: T4 is where waveOutWrite actually fires for Winamp.
    // Without this, the main-thread stats stay at 0 and the final summary lies.
    const stats = ctx._waveStats = ctx._waveStats || { open: 0, write: 0, writeBytes: 0, reset: 0, close: 0, lastFmt: null, lastWriteAt: 0 };
    const waveWrap = (name, fn, fmt) => {
      if (!host[name]) return;
      const orig = host[name];
      host[name] = (...args) => {
        const r = orig(...args);
        // fmt also accumulates stats — must run unconditionally,
        // not just when traceWave is on.
        const line = fmt(args, r);
        if (traceWave) console.log(`[wave] ${line}`);
        return r;
      };
    };
    waveWrap('wave_out_open', host.wave_out_open,
      ([rate, ch, bits, cb], r) => {
        stats.open++;
        stats.lastFmt = { rate, ch, bits };
        return `open(${rate}Hz ${ch}ch ${bits}bit cb=${hex(cb)}) → voice#${r}`;
      });
    waveWrap('wave_out_write', host.wave_out_write,
      ([h, p, len], r) => {
        stats.write++;
        stats.writeBytes += len;
        stats.lastWriteAt = Date.now();
        if (trace.has('audio-stats') && stats.write % stride === 0) {
          const f = stats.lastFmt;
          const secs = f ? (stats.writeBytes / (f.rate * f.ch * (f.bits / 8))).toFixed(2) : '?';
          const fmtStr = f ? `${f.rate}Hz s${f.bits}x${f.ch}` : '?';
          console.log(`[audio] ${stats.write} buffers, ${stats.writeBytes} B, ~${secs}s @ ${fmtStr}`);
        }
        return `write #${stats.write} h=${hex(h)} buf=${hex(p)} ${len} B`;
      });
    waveWrap('wave_out_close', host.wave_out_close,
      ([h], r) => { stats.close++; return `close(h=${hex(h)})`; });
    waveWrap('wave_out_reset', host.wave_out_reset,
      ([h], r) => { stats.reset = (stats.reset || 0) + 1; return `reset(h=${hex(h)})`; });
    waveWrap('wave_out_get_pos', host.wave_out_get_pos,
      ([h], r) => `getPos(h=${hex(h)}) → ${r}`);
    waveWrap('wave_out_set_volume', host.wave_out_set_volume,
      ([h, v], r) => `setVolume(h=${hex(h)} v=${hex(v)})`);
    ctx._finalizeWaveTrace = () => {
      if (trace.has('wave')) {
        console.log(`[wave] totals: open=${stats.open} write=${stats.write} (${stats.writeBytes} B) reset=${stats.reset} close=${stats.close}`);
      }
      if (trace.has('audio-stats')) {
        const idle = stats.lastWriteAt ? ((Date.now() - stats.lastWriteAt) / 1000).toFixed(1) : '?';
        console.log(`[audio] final: ${stats.write} buffers / ${stats.writeBytes} B; idle since last write: ${idle}s`);
      }
    };
  }

  // GDI trace wrapping is intentionally limited to the permanent JS policy
  // surface. Non-text raster/state calls no longer cross this module.
  if (trace.has('gdi')) {
    const wrap = (name, fn) => {
      host[name] = (...args) => {
        const result = fn(...args);
        console.log(`[gdi] ${_formatHostTrace(name, args, result) || name}`);
        return result;
      };
    };
    for (const name of [
      'gdi_set_region_bands', 'gdi_set_window_rgn',
      'gdi_surface_create', 'gdi_surface_upload', 'gdi_surface_delete', 'gdi_surface_attach',
      'gdi_text_bind', 'gdi_text_out', 'gdi_ext_text_out', 'gdi_draw_text',
    ]) wrap(name, host[name]);
  }

  if (trace.has('dx')) {
    const hex = v => '0x' + (v >>> 0).toString(16);
    const surfCap = (flags) => {
      const parts = [];
      if (flags & 1) parts.push('PRI');
      if (flags & 2) parts.push('BACK');
      if (flags & 4) parts.push('OFFSCR');
      if (flags & 0x100) parts.push('CK');
      return parts.join('|') || '?';
    };
    // Sample the first non-zero byte in a DIB region (up to 'max' bytes).
    // Returns -1 if all-zero, else the offset. Used to tell "empty DIB" apart
    // from "drawn but wrong colors".
    const firstNonZero = (wa, max) => {
      if (!wa) return -2;
      try {
        const mem = new Uint8Array(ctx.getMemory(), wa, max);
        for (let i = 0; i < max; i++) if (mem[i]) return i;
      } catch (_) { return -3; }
      return -1;
    };
    const sampleDwords = (wa, n) => {
      if (!wa) return [];
      try {
        const dv = new DataView(ctx.getMemory(), wa, n * 4);
        const out = [];
        for (let i = 0; i < n; i++) out.push('0x' + dv.getUint32(i * 4, true).toString(16).padStart(8, '0'));
        return out;
      } catch (_) { return ['?']; }
    };
    host.dx_trace = (kind, slot, a, b, c) => {
      if (kind === 5) _noteDxPresent(slot);
      switch (kind) {
        case 1: // Lock
          console.log(`[dx] Lock    slot=${slot} caps=${surfCap(a)} dib=${hex(b)} firstNonZero=${firstNonZero(b, 65536)}`);
          break;
        case 2: { // Unlock
          const where = firstNonZero(b, 65536);
          console.log(`[dx] Unlock  slot=${slot} caps=${surfCap(a)} dib=${hex(b)} firstNonZero=${where}${where >= 0 ? ' first4=' + sampleDwords(b + where, 1).join(',') : ''}`);
          break;
        }
        case 3: { // Blt: slot=dst_slot, a=src_slot(-1=fill), b=dst_dib, c=flags
          const fill = (c & 0x400) ? ' COLORFILL' : '';
          const src = a === 0xFFFFFFFF ? 'null' : a;
          console.log(`[dx] Blt     dst=${slot} ← src=${src}${fill} dstDib=${hex(b)} flags=${hex(c)}`);
          break;
        }
        case 4: // SetEntries: slot=palette_slot, a=startIdx, b=count, c=pal_wa
          console.log(`[dx] SetPal  palSlot=${slot} start=${a} count=${b} palWA=${hex(c)} first4=${sampleDwords(c + a * 4, 4).join(' ')}`);
          break;
        case 5: { // dx_present: slot=surface, a=bpp, b=dib_wa, c=primary_pal_wa
          const where = firstNonZero(b, 65536);
          const palFirst = c ? sampleDwords(c, 4).join(' ') : '(none)';
          let nz = 0;
          try {
            const scan = new Uint8Array(ctx.getMemory(), b, 640 * 480 * (a >> 3 || 4));
            for (let i = 0; i < scan.length; i++) if (scan[i]) nz++;
          } catch (_) {}
          console.log(`[dx] Present slot=${slot} bpp=${a} dib=${hex(b)} firstNonZero=${where} nzBytes=${nz} pal=${hex(c)} first4=${palFirst}`);
          break;
        }
        case 6: // Flip: slot=front, a=back_slot, b=new_front_dib, c=old_front_dib
          console.log(`[dx] Flip    front=${slot} back=${a} newFrontDib=${hex(b)} oldFrontDib=${hex(c)}`);
          break;
        case 7: { // D3DIM Execute instruction: slot=opcode, a=bSize, b=wCount, c=off
          const opNames = {
            1: 'POINT', 2: 'LINE', 3: 'TRIANGLE', 4: 'MATRIXLOAD', 5: 'MATRIXMULT',
            6: 'STATETRANSFORM', 7: 'STATELIGHT', 8: 'STATERENDER', 9: 'PROCESSVERTICES',
            10: 'TEXTURELOAD', 11: 'EXIT', 12: 'BRANCHFORWARD', 13: 'SPAN',
            14: 'SETSTATUS',
          };
          console.log(`[dx] Exec    op=${slot}(${opNames[slot] || '?'}) size=${a} count=${b} off=${hex(c)}`);
          break;
        }
        case 8: { // Execute entry: slot=bufPtr(guest), a=instr_off, b=instr_len
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          let retAddr = 0;
          try {
            const esp = e.get_esp();
            const retWa = esp - imageBase + 0x12000;
            retAddr = new DataView(ctx.getMemory(), retWa, 4).getUint32(0, true);
          } catch (_) {}
          let caller2 = 0;
          try {
            const ebp = e.get_ebp();
            if (ebp) {
              const callerRetWa = ebp + 4 - imageBase + 0x12000;
              caller2 = new DataView(ctx.getMemory(), callerRetWa, 4).getUint32(0, true);
            }
          } catch (_) {}
          console.log(`[dx] ExecIn bufGuest=${hex(slot)} instrOff=${a} instrLen=${b} caller=${hex(retAddr)} caller2=${hex(caller2)}`);
          if (trace.has('dx-raw') && b > 0 && b < 65536) {
            try {
              const wa = slot - imageBase + 0x12000 + a;
              const bytes = new Uint8Array(ctx.getMemory(), wa, b);
              const opNames = {
                1: 'POINT', 2: 'LINE', 3: 'TRIANGLE', 4: 'MATRIXLOAD', 5: 'MATRIXMULT',
                6: 'STATETRANSFORM', 7: 'STATELIGHT', 8: 'STATERENDER', 9: 'PROCESSVERTICES',
                10: 'TEXTURELOAD', 11: 'EXIT', 12: 'BRANCHFORWARD', 13: 'SPAN', 14: 'SETSTATUS',
              };
              // Walk D3DINSTRUCTIONs: 4-byte header (op, bSize, wCount), then bSize*wCount payload
              let off = 0;
              while (off + 4 <= bytes.length) {
                const op = bytes[off], bSize = bytes[off + 1];
                const wCount = bytes[off + 2] | (bytes[off + 3] << 8);
                const payload = bSize * wCount;
                const head = `  @+${off.toString().padStart(4)} op=${op}(${opNames[op] || '?'}) bSize=${bSize} wCount=${wCount} payload=${payload}`;
                let hexRow = '';
                const payEnd = Math.min(off + 4 + payload, bytes.length, off + 4 + 64);
                for (let i = off + 4; i < payEnd; i++) hexRow += bytes[i].toString(16).padStart(2, '0') + ' ';
                console.log(`[dx-raw]${head}${payload ? ' | ' + hexRow.trim() : ''}${payload > 64 ? ' ...' : ''}`);
                if (op === 11 || bSize === 0) break;
                off += 4 + payload;
              }
            } catch (err) {
              console.log(`[dx-raw] error: ${err.message}`);
            }
          }
          break;
        }
        case 14: // BltFastPos: slot=dst, a=src, b=dwX, c=dwY
          console.log(`[dx] BFPos   dst=${slot} ← src=${a} at=${b},${c}`);
          break;
        case 13: // ColorFill: slot=dst, a=fillColor, b=dx, c=dy
          console.log(`[dx] CFill   dst=${slot} color=${hex(a)} at=${b},${c}`);
          break;
        case 12: { // BltRect: slot=dst, a=src, b=lpDestRectGuest, c=lpSrcRectGuest
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          const readRect = (g) => {
            if (!g) return 'NULL';
            try {
              const wa = g - imageBase + 0x12000;
              const dv = new DataView(ctx.getMemory(), wa, 16);
              return `${dv.getInt32(0, true)},${dv.getInt32(4, true)}-${dv.getInt32(8, true)},${dv.getInt32(12, true)}`;
            } catch (_) { return '?'; }
          };
          console.log(`[dx] BltRect dst=${slot} ← src=${a === 0xFFFFFFFF ? 'null' : a} dstR=${readRect(b)} srcR=${readRect(c)}`);
          break;
        }
        case 11: { // BltFast: slot=dst, a=src, b=src_ckey, c=trans
          console.log(`[dx] BltFast dst=${slot} ← src=${a} srcCkey=${hex(b)} trans=${hex(c)}`);
          break;
        }
        case 10: { // Device2 DrawPrimitive: slot=primType, a=vtxType, b=count, c=lpvVerts(guest)
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          let retAddr = 0;
          try {
            const esp = e.get_esp();
            const retWa = esp - imageBase + 0x12000;
            retAddr = new DataView(ctx.getMemory(), retWa, 4).getUint32(0, true);
          } catch (_) {}
          const vWa = c - imageBase + 0x12000;
          let vs = ` <read OOB vWa=${hex(vWa)} memSize=${ctx.getMemory().byteLength}>`;
          try {
            const n = Math.min(b, 4);
            const dv = new DataView(ctx.getMemory(), vWa, n * 32);
            const out = [];
            for (let i = 0; i < n; i++) {
              const o = i * 32;
              const fx = dv.getFloat32(o, true).toFixed(2);
              const fy = dv.getFloat32(o + 4, true).toFixed(2);
              const fz = dv.getFloat32(o + 8, true).toFixed(2);
              const rhw = dv.getFloat32(o + 12, true).toFixed(2);
              const col = hex(dv.getUint32(o + 16, true));
              out.push(`v${i}(${fx},${fy},${fz},rhw=${rhw}) col=${col}`);
            }
            vs = '\n    ' + out.join('\n    ');
          } catch (e) { vs = ` <err: ${e.message}>`; }
          console.log(`[dx] DP2     primType=${slot} vtxType=${a} count=${b} lpv=${hex(c)} caller=${hex(retAddr)}${vs}`);
          break;
        }
        case 15: { // Device3 DrawPrimitive: slot=primType, a=FVF, b=count, c=lpvVerts(guest)
          const e = ctx.exports;
          const imageBase = e ? e.get_image_base() : 0;
          let retAddr = 0;
          try {
            const esp = e.get_esp();
            const retWa = esp - imageBase + 0x12000;
            retAddr = new DataView(ctx.getMemory(), retWa, 4).getUint32(0, true);
          } catch (_) {}
          const vWa = c - imageBase + 0x12000;
          let vs = ` <read OOB vWa=${hex(vWa)} memSize=${ctx.getMemory().byteLength}>`;
          try {
            const n = Math.min(b, 4);
            const dv = new DataView(ctx.getMemory(), vWa, n * 32);
            const out = [];
            for (let i = 0; i < n; i++) {
              const o = i * 32;
              const fx = dv.getFloat32(o, true).toFixed(2);
              const fy = dv.getFloat32(o + 4, true).toFixed(2);
              const fz = dv.getFloat32(o + 8, true).toFixed(2);
              const rhw = dv.getFloat32(o + 12, true).toFixed(2);
              const col = hex(dv.getUint32(o + 16, true));
              const spec = hex(dv.getUint32(o + 20, true));
              out.push(`v${i}(${fx},${fy},${fz},rhw=${rhw}) col=${col} spec=${spec}`);
            }
            vs = '\n    ' + out.join('\n    ');
          } catch (e) { vs = ` <err: ${e.message}>`; }
          console.log(`[dx] DP3     primType=${slot} fvf=${hex(a)} count=${b} lpv=${hex(c)} caller=${hex(retAddr)}${vs}`);
          break;
        }
        default:
          console.log(`[dx] kind=${kind} slot=${slot} a=${hex(a)} b=${hex(b)} c=${hex(c)}`);
      }
    };
  }

  // Merge storage imports (registry + INI files backed by localStorage)
  const _createStorageImports = (typeof StorageImports !== 'undefined' && StorageImports.createStorageImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./storage').createStorageImports; } catch (_) { return null; } })());
  if (_createStorageImports) {
    const storageHost = _createStorageImports(ctx);
    Object.assign(host, storageHost);
  }

  // Merge filesystem imports (virtual FS backed by in-memory Map)
  const _createFsImports = (typeof FilesystemImports !== 'undefined' && FilesystemImports.createFilesystemImports)
    || (typeof require !== 'undefined' && (() => { try { return require('./filesystem').createFilesystemImports; } catch (_) { return null; } })());
  if (_createFsImports) {
    const fsHost = _createFsImports(ctx);
    Object.assign(host, fsHost);
  }

  // Z-order clipping no longer needed — each window draws to its own offscreen canvas.
  // The compositor in repaint() handles overlap by blitting back-to-front.

  // DLL file check for dynamic LoadLibraryA — check VFS and browser-known DLLs.
  host.has_dll_file = (nameWA) => {
    const name = readStr(nameWA);
    const fileName = name.split('\\').pop().toLowerCase();
    if (ctx.vfs) {
      const tryPaths = [name.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName];
      for (const p of tryPaths) {
        if (ctx.vfs.files.has(p)) return 1;
      }
    }
    const available = ctx.availableDllFiles;
    if (available) {
      const lowerName = name.toLowerCase().replace(/\//g, '\\');
      if (typeof available.has === 'function') {
        if (available.has(fileName) || available.has(lowerName)) return 1;
      } else if (available[fileName] || available[lowerName]) {
        return 1;
      }
    }
    return 0;
  };

  // --- Generic host-function tracer ---
  // Enable with --trace-host=name1,name2 (CLI) or ctx.traceHost = Set of names.
  // Wraps any host import by name and logs args/return without a bespoke
  // formatter. Useful for one-off investigations so we stop editing source
  // to add console.log. Numbers render hex when >= 0x100.
  // Runs AFTER storage/fs/other merges so wrappable names include fs_* etc.
  if (ctx.traceHost && ctx.traceHost.size > 0) {
    const fmt = v => (typeof v === 'number')
      ? (Math.abs(v) >= 0x100 ? '0x' + (v >>> 0).toString(16) : String(v))
      : String(v);
    for (const name of ctx.traceHost) {
      if (typeof host[name] !== 'function') {
        console.warn(`[trace-host] no such host import: ${name}`);
        continue;
      }
      const orig = host[name];
      host[name] = (...args) => {
        const r = orig(...args);
        if (name === 'has_dll_file') {
          console.log(`[host] has_dll_file("${readStr(args[0])}") => ${fmt(r)}`);
          return r;
        }
        console.log(`[host] ${_formatHostTrace(name, args, r) || `${name}(${args.map(fmt).join(', ')}) => ${fmt(r)}`}`);
        return r;
      };
    }
  }

  ctx.pumpAudioCompletions = _pumpWaveOutCompletions;

  return { host, readStr, gdi: {
    fontResources: _fontResources,
    regionPresentations: _regionPresentations,
    surfacePresentations: _gdiSurfacePresentations,
    fontHandleBox: _fontHandleBox,
    pixelCache: _pixelCache,
    getClientOrigin: _getClientOrigin,
    presentBestDxOffscreen: _presentBestDxOffscreen,
    flushSurfacePresentation: id =>
      _flushGdiSurfacePresentation(_gdiSurfacePresentations.get(id >>> 0)),
  } };
}

if (typeof module !== 'undefined') module.exports = { createHostImports };
