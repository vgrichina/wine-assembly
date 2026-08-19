// Audio half of the host import layer: the WinMM mixer buses, the voice
// manager shared by waveOut and DirectSound, waveIn capture, the MIDI
// synthesiser, and MCI.
//
// Split out of lib/host-imports.js, which still owns the flat `host` import
// namespace: it calls createAudioHost() once and spreads `.imports` into the
// same object the guest sees, so nothing about the WASM import shape changed.
// Everything this half needs from the other one arrives through `shared`;
// nothing here reaches back into host-imports' closure.

function createAudioHost(ctx, shared) {
  const readStr = shared.readStr;
  const readStrW = shared.readStrW;
  const _readVfsFile = shared.readVfsFile;
  const _profileNow = shared.profileNow;
  const _profileEvent = shared.profileEvent;
  // The import map is built here but installed by host-imports.js, so audio
  // callbacks that want to signal an event reach the finished namespace
  // late rather than capturing a half-built object.
  const getHost = shared.getHost;

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
      if (cbType === 5 && cbHandle && getHost().set_event) getHost().set_event(cbHandle);
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
    } else if (device.callbackType === 5 && device.callback && getHost().set_event) {
      getHost().set_event(device.callback >>> 0);
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

  // The audio slice of the flat host import namespace. host-imports.js
  // spreads these into `host` in place, so the guest still sees one object.
  const imports = {
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
  };

  return { imports, pumpWaveOutCompletions: _pumpWaveOutCompletions };
}

if (typeof module !== 'undefined') module.exports = { createAudioHost };
