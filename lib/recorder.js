// Screen+audio recorder for the wine-assembly browser host.
// Crops to the active (top z-order) window's rect on each frame and pipes
// it together with the shared AudioContext output into MediaRecorder.

(function () {
  const SCALE = 2;  // 2× nearest-neighbor upscale to survive Twitter/YouTube re-encode
  let mediaRecorder = null;
  let chunks = [];
  let outStream = null;
  let recCanvas = null;
  let recCtx = null;
  let rafId = 0;
  let audioTaps = [];   // [{ master, dest }]
  let active = false;
  let startedAt = 0;
  let timerId = 0;

  function pickActiveWindow() {
    const r = (typeof sharedRenderer !== 'undefined') ? sharedRenderer
            : (typeof window !== 'undefined' && window.sharedRenderer) || null;
    if (!r || !r.windows) return null;
    const tops = Object.values(r.windows)
      .filter(w => w && w.visible && !w.isChild && !w._minimized && w.w > 0 && w.h > 0);
    if (!tops.length) return null;
    tops.sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    return tops[tops.length - 1];
  }

  function paintFrame() {
    rafId = requestAnimationFrame(paintFrame);
    if (!recCanvas) return;
    const win = pickActiveWindow();
    const screen = document.getElementById('screen');
    if (!win || !screen) return;
    const sw = Math.max(1, win.w | 0);
    const sh = Math.max(1, win.h | 0);
    const dw = sw * SCALE;
    const dh = sh * SCALE;
    if (recCanvas.width !== dw || recCanvas.height !== dh) {
      recCanvas.width = dw;
      recCanvas.height = dh;
      recCtx.imageSmoothingEnabled = false;
    }
    recCtx.fillStyle = '#000';
    recCtx.fillRect(0, 0, dw, dh);
    if (win._backCanvas) {
      try { recCtx.drawImage(win._backCanvas, 0, 0, sw, sh, 0, 0, dw, dh); return; }
      catch (_) {}
    }
    try { recCtx.drawImage(screen, win.x, win.y, sw, sh, 0, 0, dw, dh); }
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

  function attachAudio(stream) {
    const acs = findAllAudioCtxs();
    if (!acs.length) {
      console.warn('[record] no AudioContext yet — start audio first, then record (audio will be silent)');
      return;
    }
    // MediaRecorder reliably handles a single audio track; merge multiple
    // contexts via the first AC only (typical case = 1 ctx anyway).
    const ac = acs[0];
    if (ac.state === 'suspended') { try { ac.resume(); } catch (_) {} }
    const master = ensureMaster(ac);
    if (!master) return;
    try {
      const dest = ac.createMediaStreamDestination();
      master.connect(dest);
      audioTaps.push({ master, dest });
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      console.log('[record] audio tap attached to AudioContext (sampleRate=' + ac.sampleRate + ')');
    } catch (e) { console.warn('[record] audio tap failed:', e); }
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
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

  function start() {
    if (active) return;
    if (typeof MediaRecorder === 'undefined') {
      alert('MediaRecorder not supported in this browser.');
      return;
    }
    const win = pickActiveWindow();
    if (!win) {
      alert('No active window to record. Launch an app first.');
      return;
    }
    recCanvas = document.createElement('canvas');
    recCanvas.width = Math.max(1, win.w | 0) * SCALE;
    recCanvas.height = Math.max(1, win.h | 0) * SCALE;
    recCtx = recCanvas.getContext('2d');
    recCtx.imageSmoothingEnabled = false;

    if (typeof recCanvas.captureStream !== 'function') {
      alert('Canvas captureStream not supported.');
      return;
    }
    outStream = recCanvas.captureStream(30);
    paintFrame();
    attachAudio(outStream);

    const mime = pickMime();
    chunks = [];
    try {
      mediaRecorder = new MediaRecorder(outStream, mime ? { mimeType: mime, videoBitsPerSecond: 4_000_000 } : undefined);
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
    try { mediaRecorder.start(1000); }
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
    if (outStream) {
      for (const t of outStream.getTracks()) { try { t.stop(); } catch (_) {} }
      outStream = null;
    }
    for (const tap of audioTaps) {
      try { tap.master.disconnect(tap.dest); } catch (_) {}
    }
    audioTaps = [];
    mediaRecorder = null;
    recCanvas = null;
    recCtx = null;
    active = false;
    if (timerId) { clearInterval(timerId); timerId = 0; }
    updateButton();
  }

  function fmtElapsed() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    return `${String((s / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function updateButton() {
    const btn = document.getElementById('record-btn');
    if (!btn) return;
    if (active) {
      btn.textContent = `■ Stop ${fmtElapsed()}`;
      btn.classList.add('recording');
    } else {
      btn.textContent = '● Record';
      btn.classList.remove('recording');
    }
  }

  window.toggleRecording = function () { active ? stop() : start(); };
})();
