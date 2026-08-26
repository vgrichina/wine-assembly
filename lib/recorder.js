// Screen+audio recorder for the wine-assembly browser host.
// Captures the emulator screen canvas by default and pipes it together with
// the shared AudioContext output into MediaRecorder.

(function () {
  // Nearest-neighbor upscale to survive Twitter/YouTube re-encode. The factor
  // is picked per source rather than fixed: a fixed 2x quadrupled the pixel
  // count of an already-large desktop against a flat bitrate cap, which lowers
  // quality per source pixel instead of raising it. Measured on real captures
  // before this: 2634x1534 at 2.83 Mbps is 0.030 bits/pixel, against the
  // 0.10-0.15 H.264 wants for clean motion -- fine while the screen is still,
  // falling apart the moment it moves.
  const MAX_OUT_W = 2560;
  const MAX_OUT_H = 1600;
  const FPS = 30;
  // Bits per pixel per frame to aim for. Hard-edged pixel art costs more than
  // natural video of the same size, so this sits at the top of the usual band.
  //
  // Set for Safari, which is the engine that needs it. Measured 2026-08-26 on
  // real captures of the same build: Safari encodes Constrained Baseline (no
  // CABAC, no B-frames -- VideoToolbox ignores our High-profile request) and
  // spent 78% of a 7.8 Mbps offer to reach 0.092 bpp, so more budget lands on
  // the picture. Chrome gets profile=High, hits its quality target on fewer
  // bits, and spent only 53% of an 8.7 Mbps offer -- its own rate control is
  // the limiter there, so this costs Chrome recordings little and is not worth
  // splitting into a per-engine constant.
  const TARGET_BPP = 0.15;
  const MIN_BITRATE = 3_000_000;
  const MAX_BITRATE = 20_000_000;

  // Largest whole-pixel multiple that still fits the ceiling. Integer only:
  // a fractional scale resamples across source pixel boundaries and undoes
  // the point of imageSmoothingEnabled=false.
  function pickScale(w, h) {
    let scale = 1;
    for (const k of [3, 2]) {
      if (w * k <= MAX_OUT_W && h * k <= MAX_OUT_H) { scale = k; break; }
    }
    return scale;
  }

  // H.264 in 4:2:0 needs even dimensions; an odd one is either rejected or
  // silently padded, and 1x of an odd-sized window is how we would get one.
  function outSize(w, h) {
    const scale = pickScale(w, h);
    return {
      scale,
      w: Math.max(2, (w * scale) & ~1),
      h: Math.max(2, (h * scale) & ~1),
    };
  }

  function pickBitrate(w, h) {
    const wanted = Math.round(TARGET_BPP * w * h * FPS);
    return Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, wanted));
  }

  let mediaRecorder = null;
  let chunks = [];
  let outStream = null;
  let captureStream = null;
  let recCanvas = null;
  let recCtx = null;
  let rafId = 0;
  let audioTaps = [];   // [{ master, dest }]
  let active = false;
  let startedAt = 0;
  let timerId = 0;
  let recordTarget = 'screen';

  // The renderer is reassigned on every launch, so it is reached through the
  // shell's live getter rather than cached. `sharedRenderer` is a closure-local
  // in browser-shell.js and was never a global -- reading it here found nothing
  // and silently disabled the window-crop target.
  function activeRenderer() {
    const shell = (typeof window !== 'undefined') ? window.wineShell : null;
    return (shell && shell.renderer) || null;
  }

  function pickActiveWindow() {
    const r = activeRenderer();
    if (!r || !r.windows) return null;
    const tops = Object.values(r.windows)
      .filter(w => w && w.visible && !w.isChild && !w._minimized && w.w > 0 && w.h > 0);
    if (!tops.length) return null;
    tops.sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    return tops[tops.length - 1];
  }

  // Where the presented guest image sits on the screen canvas, or null when it
  // fills it. A fullscreen guest is letterboxed on purpose -- the renderer fits
  // its 4:3 image into whatever shape the browser window is and fills the rest
  // with black, the way a real monitor does (renderer.js
  // _computeExclusiveTransform). Recording the whole canvas hands those bars to
  // the encoder: measured on a 1064x620 window holding an 827x620 game, 28% of
  // every frame was black, carried again at every keyframe, and counted against
  // the bits/pixel budget as though it were picture.
  //
  // One transform, two meanings, and taking the wrong half crops the wrong
  // rectangle rather than failing visibly:
  //   * exclusive fullscreen -- the desktop canvas itself is repainted through
  //     the transform, so the picture is at dst* and the bars are real pixels.
  //   * single-app zoom -- the canvas holds the ordinary desktop and only the
  //     *presentation* crops, so the picture is the src* rect and dst* refers
  //     to an output surface this is not reading.
  function presentedRect(canvasW, canvasH) {
    const r = activeRenderer();
    const t = r && r._exclusiveTransform;
    if (!t) return null;
    const box = r._exclusiveFullscreen
      ? { x: t.dstX | 0, y: t.dstY | 0, w: t.dstW | 0, h: t.dstH | 0 }
      : { x: t.srcX | 0, y: t.srcY | 0, w: t.srcW | 0, h: t.srcH | 0 };
    // A rect that does not lie inside this surface is describing a different
    // one. Record the whole canvas rather than a sliver of the wrong thing.
    if (box.w <= 0 || box.h <= 0) return null;
    if (box.x < 0 || box.y < 0) return null;
    if (box.x + box.w > canvasW || box.y + box.h > canvasH) return null;
    if (box.w === canvasW && box.h === canvasH) return null;
    return box;
  }

  function pickRecordSource() {
    const screen = document.getElementById('screen');
    if (recordTarget === 'screen') {
      if (!screen) return null;
      const sw = Math.max(1, screen.width | 0);
      const sh = Math.max(1, screen.height | 0);
      const rect = presentedRect(sw, sh);
      const rx = rect ? rect.x : 0;
      const ry = rect ? rect.y : 0;
      const rw = rect ? rect.w : sw;
      const rh = rect ? rect.h : sh;
      return {
        w: rw,
        h: rh,
        draw: (ctx, dw, dh) => ctx.drawImage(screen, rx, ry, rw, rh, 0, 0, dw, dh),
      };
    }

    const win = pickActiveWindow();
    if (!win) return null;
    const sw = Math.max(1, win.w | 0);
    const sh = Math.max(1, win.h | 0);
    return {
      w: sw,
      h: sh,
      draw: (ctx, dw, dh) => {
        if (win._backCanvas) {
          try {
            if (typeof win._backCanvas._waFlushCanonicalSurface === 'function') {
              win._backCanvas._waFlushCanonicalSurface();
            }
            ctx.drawImage(win._backCanvas, 0, 0, sw, sh, 0, 0, dw, dh);
            return;
          }
          catch (_) {}
        }
        if (screen) {
          try { ctx.drawImage(screen, win.x, win.y, sw, sh, 0, 0, dw, dh); }
          catch (_) {}
        }
      },
    };
  }

  function paintFrame() {
    rafId = requestAnimationFrame(paintFrame);
    if (!recCanvas) return;
    const source = pickRecordSource();
    if (!source) return;
    const sw = source.w;
    const sh = source.h;
    const { w: dw, h: dh } = outSize(sw, sh);
    if (recCanvas.width !== dw || recCanvas.height !== dh) {
      recCanvas.width = dw;
      recCanvas.height = dh;
      recCtx.imageSmoothingEnabled = false;
    }
    recCtx.fillStyle = '#000';
    recCtx.fillRect(0, 0, dw, dh);
    try { source.draw(recCtx, dw, dh); }
    catch (_) {}
  }

  function findAllAudioCtxs() {
    const set = new Set();
    const apps = (typeof runningApps !== 'undefined') ? runningApps
               : (typeof window !== 'undefined' && window.runningApps) || [];
    for (const a of apps) {
      const w = a && a.wine;
      if (w && w._audioCtx) set.add(w._audioCtx);
      const threads = w && w.threads;
      if (threads && typeof threads === 'object') {
        for (const t of Object.values(threads)) {
          const tac = t && (t._audioCtx || (t.imports && t.imports.host && t.imports.host._audioCtx));
          if (tac) set.add(tac);
        }
      }
    }
    return Array.from(set);
  }

  function ensureMaster(ac) {
    if (!ac) return null;
    if (ac._wineMaster) return ac._wineMaster;
    try {
      const m = ac.createGain();
      m.connect(ac.destination);
      ac._wineMaster = m;
      return m;
    } catch (_) { return null; }
  }

  // Every running app owns its own AudioContext, so "the audio" is however
  // many masters happen to be live. MediaRecorder only handles one audio
  // track, so the other contexts are re-entered into the first one through a
  // MediaStreamDestination -> MediaStreamSource pair, which is the only way
  // audio crosses an AudioContext boundary.
  function collectAudioTracks() {
    const acs = findAllAudioCtxs();
    if (!acs.length) {
      console.warn('[record] no AudioContext yet — start audio first, then record (audio will be silent)');
      return [];
    }
    const primary = acs[0];
    if (primary.state === 'suspended') { try { primary.resume(); } catch (_) {} }
    let dest;
    try { dest = primary.createMediaStreamDestination(); }
    catch (e) { console.warn('[record] audio tap failed:', e); return []; }

    let tapped = 0;
    for (const ac of acs) {
      if (ac.state === 'suspended') { try { ac.resume(); } catch (_) {} }
      const master = ensureMaster(ac);
      if (!master) continue;
      try {
        if (ac === primary) {
          master.connect(dest);
          audioTaps.push({ master, dest });
        } else {
          const bridge = ac.createMediaStreamDestination();
          master.connect(bridge);
          const source = primary.createMediaStreamSource(bridge.stream);
          source.connect(dest);
          audioTaps.push({ master, dest: bridge, source, sink: dest });
        }
        tapped++;
      } catch (e) { console.warn('[record] audio tap failed:', e); }
    }
    if (!tapped) return [];
    const tracks = dest.stream.getAudioTracks();
    console.log(`[record] audio tap attached to ${tapped} AudioContext(s), ` +
      `${tracks.length} track(s) (sampleRate=${primary.sampleRate})`);
    return tracks;
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      // Ask for High profile, then Main, before the unqualified string. Both
      // browsers hand us Constrained Baseline by default -- CAVLC, no B-frames,
      // 4x4 transform only -- which is the weakest H.264 toolset there is, and
      // an encoder may accept the profile request even when it will not honour
      // it. Costs nothing to ask; verify with ffprobe, never assume.
      'video/mp4;codecs=avc1.640028,mp4a.40.2',   // High 4.0
      'video/mp4;codecs=avc1.4d0028,mp4a.40.2',   // Main 4.0
      'video/mp4;codecs=avc1,mp4a.40.2',   // Safari
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return '';
  }

  function start(options) {
    if (active) return;
    if (typeof MediaRecorder === 'undefined') {
      alert('MediaRecorder not supported in this browser.');
      return;
    }
    recordTarget = options && options.target === 'window' ? 'window' : 'screen';
    const source = pickRecordSource();
    if (!source) {
      alert(recordTarget === 'screen'
        ? 'No screen canvas to record.'
        : 'No active window to record. Launch an app first.');
      return;
    }
    recCanvas = document.createElement('canvas');
    const out = outSize(source.w, source.h);
    recCanvas.width = out.w;
    recCanvas.height = out.h;
    recCtx = recCanvas.getContext('2d');
    recCtx.imageSmoothingEnabled = false;

    if (typeof recCanvas.captureStream !== 'function') {
      alert('Canvas captureStream not supported.');
      return;
    }
    // Hand MediaRecorder a stream built from the tracks rather than the canvas
    // capture stream grown by addTrack(). Both are legal and Chrome encodes
    // either, but a captureStream() carries the canvas's own track set and
    // WebKit has a long history of recording it as captured; an ignored audio
    // track costs the sound and nothing else, so the file still plays and the
    // failure only shows up after the recording is over.
    captureStream = recCanvas.captureStream(FPS);
    // Tell the encoder this is a screen, not a camera. The default hint makes
    // it spend bits holding the frame rate up and blur a moving frame, which
    // is the wrong trade for 1px window chrome and dithered 8bpp art.
    for (const track of captureStream.getVideoTracks()) {
      try { track.contentHint = 'detail'; } catch (_) {}
    }
    paintFrame();
    const audioTracks = collectAudioTracks();
    try {
      outStream = new MediaStream([...captureStream.getVideoTracks(), ...audioTracks]);
    } catch (_) {
      outStream = captureStream;
      for (const track of audioTracks) { try { outStream.addTrack(track); } catch (_) {} }
    }

    const mime = pickMime();
    chunks = [];
    try {
      // Derive the budget from the frame that is actually being encoded. A flat
      // cap means the bigger the desktop, the worse it looks -- exactly backwards.
      const videoBitsPerSecond = pickBitrate(recCanvas.width, recCanvas.height);
      console.log(`[record] ${source.w}x${source.h} -> ${recCanvas.width}x${recCanvas.height} ` +
        `(${out.scale}x) @ ${(videoBitsPerSecond / 1e6).toFixed(1)} Mbps ${mime || '(browser default)'}`);
      mediaRecorder = new MediaRecorder(outStream,
        mime ? { mimeType: mime, videoBitsPerSecond, audioBitsPerSecond: 128_000 }
             : { videoBitsPerSecond, audioBitsPerSecond: 128_000 });
    } catch (e) {
      console.error('[record] MediaRecorder ctor failed:', e);
      cleanup();
      return;
    }
    const ext = (mime && mime.startsWith('video/mp4')) ? 'mp4' : 'webm';
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wine-assembly-${ts}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      cleanup();
    };
    // Chrome forces an IDR at every chunk boundary, so the timeslice sets the
    // keyframe cadence. At 1000ms a keyframe of a multi-megapixel screen ate
    // most of each second's budget and the frames carrying the motion split
    // what was left. 5s costs us any recording shorter than one chunk and
    // buys those frames roughly five times the bits.
    try { mediaRecorder.start(5000); }
    catch (e) { console.error('[record] start failed:', e); cleanup(); return; }

    active = true;
    startedAt = Date.now();
    updateButton();
    timerId = setInterval(updateButton, 500);
  }

  function stop() {
    if (!active) return;
    try { mediaRecorder && mediaRecorder.state !== 'inactive' && mediaRecorder.stop(); }
    catch (e) { console.warn('[record] stop failed:', e); cleanup(); }
  }

  function cleanup() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    for (const stream of [outStream, captureStream]) {
      if (!stream) continue;
      for (const t of stream.getTracks()) { try { t.stop(); } catch (_) {} }
    }
    outStream = null;
    captureStream = null;
    for (const tap of audioTaps) {
      try { tap.master.disconnect(tap.dest); } catch (_) {}
      if (tap.source) { try { tap.source.disconnect(tap.sink); } catch (_) {} }
    }
    audioTaps = [];
    mediaRecorder = null;
    recCanvas = null;
    recCtx = null;
    active = false;
    recordTarget = 'screen';
    if (timerId) { clearInterval(timerId); timerId = 0; }
    updateButton();
  }

  function fmtElapsed() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function updateButton() {
    const label = active ? `Stop ${fmtElapsed()}` : 'Record';
    const btn = document.getElementById('record-btn');
    if (btn) {
      btn.textContent = active ? `\u25a0 ${label}` : '\u25cf Record';
      btn.classList.toggle('recording', active);
    }

    const item = document.getElementById('start-record-item');
    const itemIcon = document.getElementById('start-record-ico');
    const itemLabel = document.getElementById('start-record-label');
    if (item) {
      item.classList.toggle('recording', active);
      item.title = active ? 'Stop recording and download video' : 'Record screen + audio to video';
    }
    if (itemIcon) itemIcon.textContent = active ? '\u25a0' : '\u25cf';
    if (itemLabel) {
      itemLabel.textContent = active ? `Stop Recording ${fmtElapsed()}` : 'Record Screen';
    }
  }

  window.toggleRecording = function (options) { active ? stop() : start(options); };
})();
