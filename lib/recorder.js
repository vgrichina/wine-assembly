// Screen+audio recorder for the wine-assembly browser host.
// Captures the #screen canvas via captureStream and (optionally) taps the
// shared AudioContext's master GainNode by connecting it to a
// MediaStreamAudioDestinationNode. Output is a single .webm file.

(function () {
  let mediaRecorder = null;
  let chunks = [];
  let combinedStream = null;
  let audioTap = null;   // { master, dest }
  let active = false;
  let startedAt = 0;
  let timerId = 0;

  function findAudioCtx() {
    const apps = (typeof window !== 'undefined' && window.runningApps) ? window.runningApps : [];
    for (const a of apps) {
      const w = a && a.wine;
      if (w && w._audioCtx) return w._audioCtx;
    }
    return null;
  }

  function attachAudio(stream) {
    const ac = findAudioCtx();
    if (!ac || !ac._wineMaster) return;
    try {
      const dest = ac.createMediaStreamDestination();
      ac._wineMaster.connect(dest);
      audioTap = { master: ac._wineMaster, dest };
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    } catch (e) { console.warn('[record] audio tap failed:', e); }
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
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
    const canvas = document.getElementById('screen');
    if (!canvas || typeof canvas.captureStream !== 'function') {
      alert('Canvas captureStream not supported.');
      return;
    }
    combinedStream = canvas.captureStream(30);
    attachAudio(combinedStream);

    const mime = pickMime();
    chunks = [];
    try {
      mediaRecorder = new MediaRecorder(combinedStream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      console.error('[record] MediaRecorder ctor failed:', e);
      cleanup();
      return;
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wine-assembly-${ts}.webm`;
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
    if (combinedStream) {
      for (const t of combinedStream.getTracks()) { try { t.stop(); } catch (_) {} }
      combinedStream = null;
    }
    if (audioTap) {
      try { audioTap.master.disconnect(audioTap.dest); } catch (_) {}
      audioTap = null;
    }
    mediaRecorder = null;
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
