// Debug-mode performance HUD.
//
// Jank in this emulator is not a rendering problem, it is a scheduling one:
// the run loop in host.js is a `setTimeout(step, 0)` chain, and every step
// runs a guest slice, then the worker threads, then a repaint, all on the
// main thread. Anything the browser wants to do — paint, hit-test, handle a
// click — waits for the whole step. So "a frame was late" is not the useful
// measurement; "which phase of which step held the thread" is.
//
// External profilers can only see the outside of that: rAF cadence and
// longtask totals, with no attribution. This measures it from the inside.
// host.js calls mark() around each phase; everything else here is display.
//
// Cost: four performance.now() calls per step. The guest already makes
// ~500k clock reads per second through GetTickCount, so this is noise.

(function (global) {
  'use strict';

  const HISTORY = 240;          // steps kept in the ring, ~4s at 60/s
  const PHASES = [
    { key: 'main',    label: 'guest',   color: '#4ade80' },
    { key: 'workers', label: 'threads', color: '#38bdf8' },
    { key: 'present', label: 'paint',   color: '#e879f9' },
    { key: 'other',   label: 'other',   color: '#94a3b8' },
  ];

  const now = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now());

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  class PerfHud {
    constructor() {
      this.enabled = false;
      this.steps = [];            // ring of {main, workers, present, other, total, at}
      this.frames = [];           // ring of rAF intervals
      this.longTasks = [];        // ring of {at, ms}
      // A page painting at 60fps says nothing about how fast the emulated
      // machine is running. These two are the guest's own rate: frames it
      // actually presented, and x86 steps it was given. "Smooth but laggy"
      // is precisely a healthy page rate over a starved guest rate.
      this.guestFrames = [];      // ring of timestamps of presented guest frames
      this.guestSteps = [];       // ring of {at, steps}
      this._cur = null;
      this._lastStepEnd = 0;
      this._lastFrameAt = 0;
      this._rafHandle = 0;
      this._observer = null;
      this._dom = null;
      this._startedAt = now();
    }

    // ---- instrumentation seam (called from host.js) --------------------

    stepBegin() {
      const t = now();
      // Time between the end of the previous step and the start of this one
      // is the browser's: paint, input, GC, and setTimeout's own clamping.
      // It is the only part of the budget the emulator is not spending.
      this._cur = { main: 0, workers: 0, present: 0, other: 0, at: t, total: 0, gap: this._lastStepEnd ? t - this._lastStepEnd : 0 };
    }

    // One frame the guest actually put on screen (a GDI surface flush with a
    // non-empty dirty rect). Called from lib/host-imports.js.
    guestFrame() {
      if (!this.enabled) return;
      this.guestFrames.push(now());
      if (this.guestFrames.length > HISTORY * 2) this.guestFrames.shift();
      if (this._streamTimer) this._streamGuest = (this._streamGuest || 0) + 1;
    }

    // x86 steps handed to the guest this slice, so throughput can be read in
    // instructions/sec rather than inferred from how busy the loop looks.
    countSteps(n) {
      if (!this.enabled || !(n > 0)) return;
      this.guestSteps.push({ at: now(), steps: n });
      if (this.guestSteps.length > HISTORY) this.guestSteps.shift();
    }

    // Whether this step's worker budget ran out with work still pending.
    markThrottled(hit) {
      if (this._cur) this._cur.throttled = !!hit;
    }

    mark(phase, ms) {
      if (!this._cur || !(ms >= 0)) return;
      if (this._cur[phase] === undefined) this._cur[phase] = 0;
      this._cur[phase] += ms;
    }

    stepEnd() {
      const cur = this._cur;
      if (!cur) return;
      this._cur = null;
      const t = now();
      cur.total = t - cur.at;
      // Whatever the step spent outside the three marked phases: yield
      // handling, DLL loads, the logging path, thread spawn. Unattributed
      // time showing up here is a finding, not an accounting error.
      cur.other = Math.max(0, cur.total - cur.main - cur.workers - cur.present);
      this._lastStepEnd = t;
      this.steps.push(cur);
      if (this.steps.length > HISTORY) this.steps.shift();
      if (this._streamSteps) this._streamSteps.push(cur);
    }

    // ---- lifecycle -----------------------------------------------------

    start(opts) {
      const draw = !opts || opts.draw !== false;
      if (draw) {
        this._ensureDom();
        this._dom.root.style.display = 'block';
        this._visible = true;
      }
      if (this.enabled) return;
      this.enabled = true;
      this._startedAt = now();

      if (typeof PerformanceObserver !== 'undefined' && !this._observer) {
        try {
          this._observer = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              this.longTasks.push({ at: now(), ms: e.duration });
              if (this.longTasks.length > HISTORY) this.longTasks.shift();
            }
          });
          this._observer.observe({ entryTypes: ['longtask'] });
        } catch (_) {
          // Safari has no longtask entry type. The per-step bars carry the
          // same information there, which is why they are the primary graph.
          this._observer = null;
        }
      }

      const tick = () => {
        if (!this.enabled) return;
        const t = now();
        if (this._lastFrameAt) {
          const dt = t - this._lastFrameAt;
          this.frames.push(dt);
          if (this.frames.length > HISTORY) this.frames.shift();
          if (this._streamFrames) this._streamFrames.push(dt);
        }
        this._lastFrameAt = t;
        if (this._visible) this._draw();
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
      // A stream outlives the overlay: someone can hide the panel and keep
      // recording, which is the usual shape of "play normally and send me
      // the data".
      if (this._streamTimer) {
        this._visible = false;
        if (this._dom) this._dom.root.style.display = 'none';
        return;
      }
      this._visible = false;
      this.enabled = false;
      if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
      this._rafHandle = 0;
      if (this._observer) { try { this._observer.disconnect(); } catch (_) {} this._observer = null; }
      if (this._dom) this._dom.root.style.display = 'none';
    }

    toggle(on) {
      const want = on === undefined ? !this.enabled : !!on;
      if (want) this.start(); else this.stop();
    }

    reset() {
      this.steps.length = 0;
      this.frames.length = 0;
      this.longTasks.length = 0;
      this._startedAt = now();
    }

    // ---- streaming -----------------------------------------------------

    // Post batched samples to a sink (tools/dev-server.js serves /api/perf).
    // The point is to capture a session someone is actually playing, in
    // their own browser, rather than a scripted puppeteer run: the jank a
    // player reports and the jank a script reproduces are not reliably the
    // same thing, and only the first one is the bug.
    startStream(url, everyMs) {
      this.streamUrl = url || '/api/perf';
      this._streamSteps = [];
      this._streamFrames = [];
      this._streamGuest = 0;
      this._streamSeq = 0;
      this._session = (Math.random().toString(36).slice(2, 8)) + '-' + String(Date.now()).slice(-6);
      if (!this.enabled) this.start({ draw: false });
      if (this._streamTimer) clearInterval(this._streamTimer);
      this._streamTimer = setInterval(() => this._flushStream(), Math.max(250, everyMs || 1000));
      // A page closed mid-session should still deliver its last batch;
      // sendBeacon survives unload where fetch does not.
      window.addEventListener('pagehide', () => this._flushStream(true));
      return this._session;
    }

    stopStream() {
      if (this._streamTimer) clearInterval(this._streamTimer);
      this._streamTimer = 0;
      this.streamUrl = '';
    }

    // One place that posts, one place that records what happened to it.
    // A stream that fails invisibly is worse than no stream: it looks like
    // the app is fine and it costs whoever is watching the log real time.
    // The failure that actually happened here — posting to a server without
    // the sink route — is a 404, i.e. a *successful* fetch, so catching
    // exceptions alone would still have shown nothing.
    _post(body, beacon) {
      const note = s => {
        if (this.streamStatus === s) return;
        this.streamStatus = s;
        if (typeof console !== 'undefined') console.warn('[perf] stream', s, this.streamUrl);
      };
      try {
        if (beacon && navigator.sendBeacon) {
          navigator.sendBeacon(this.streamUrl, new Blob([body], { type: 'application/json' }));
          return;
        }
        // No `keepalive`: Safari has historically rejected or dropped
        // keepalive fetches, and this one runs every second in a live page
        // where the unload case is already covered by sendBeacon above.
        fetch(this.streamUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        }).then(r => {
          note(r.ok ? 'ok' : `HTTP ${r.status} — is this server the one with the sink?`);
        }).catch(e => note('failed: ' + (e && e.message || e)));
      } catch (e) {
        note('threw: ' + (e && e.message || e));
      }
    }

    _flushStream(beacon) {
      if (!this.streamUrl) return;
      const steps = this._streamSteps || [];
      const frames = this._streamFrames || [];
      this._streamSteps = [];
      this._streamFrames = [];
      const guest = this._streamGuest || 0;
      this._streamGuest = 0;
      // Skipping empty batches made silence ambiguous: a page with nothing
      // launched, a backgrounded tab (no rAF, setTimeout clamped to ~1/sec)
      // and a closed tab all produced exactly no output. Send a heartbeat
      // instead, so the log says which one it is.
      if (!steps.length && !frames.length && !guest) {
        const since = now() - (this._lastBeatAt || 0);
        if (since < 5000) return;
        this._lastBeatAt = now();
        this._post(JSON.stringify({
          session: this._session, seq: this._streamSeq++, at: Date.now(),
          idle: true, hidden: !!(typeof document !== 'undefined' && document.hidden),
          steps: [], frames: [], guestFrames: 0, snapshot: this.snapshot(),
        }));
        return;
      }
      this._lastBeatAt = now();
      const r = v => Math.round(v * 10) / 10;
      const body = JSON.stringify({
        session: this._session,
        seq: this._streamSeq++,
        at: Date.now(),
        // Per step, compact and positional: total, guest, threads, paint,
        // other, throttled. Full fidelity at ~60/s is only a few KB/s, and
        // aggregates computed here could not be re-cut later.
        steps: steps.map(s => [r(s.total), r(s.main), r(s.workers), r(s.present), r(s.other), s.throttled ? 1 : 0]),
        frames: frames.map(r),
        guestFrames: guest,
        snapshot: this.snapshot(),
        ua: navigator.userAgent,
        app: (typeof document !== 'undefined' && document.title) || '',
      });
      this._post(body, beacon);
    }

    // ---- readout for headless tools ------------------------------------

    // tools/profile-web-frames.js reads this instead of inferring phases
    // from the outside. Same numbers the HUD is drawing.
    // Rate of events in a recent window, in per-second. Uses the window the
    // samples actually span rather than a fixed divisor, so a rate stays
    // honest when the ring covers less than the window asked for.
    _rate(times, windowMs = 2000) {
      const t = now();
      let n = 0, oldest = t;
      for (let i = times.length - 1; i >= 0; i--) {
        const at = times[i];
        if (t - at > windowMs) break;
        n++; oldest = at;
      }
      const span = t - oldest;
      return (n > 1 && span > 0) ? ((n - 1) * 1000) / span : 0;
    }

    snapshot() {
      const steps = this.steps.slice();
      const totals = steps.map(s => s.total).sort((a, b) => a - b);
      const frames = this.frames.slice().sort((a, b) => a - b);
      const sum = k => steps.reduce((a, s) => a + s[k], 0);
      const wall = Math.max(1, now() - this._startedAt);
      return {
        wallMs: Math.round(wall),
        steps: steps.length,
        stepMs: { p50: percentile(totals, 50), p90: percentile(totals, 90), p99: percentile(totals, 99), max: totals.length ? totals[totals.length - 1] : 0 },
        frameMs: { p50: percentile(frames, 50), p90: percentile(frames, 90), p99: percentile(frames, 99), max: frames.length ? frames[frames.length - 1] : 0 },
        fps: this.frames.length ? 1000 / (this.frames.reduce((a, b) => a + b, 0) / this.frames.length) : 0,
        // pageFps is the compositor; guestFps is the emulated machine. They
        // are unrelated numbers, and only the second one is what "laggy"
        // describes. Report both or the report is misleading.
        guestFps: this._rate(this.guestFrames),
        stepsPerSec: (() => {
          const t = now();
          const recent = this.guestSteps.filter(s => t - s.at <= 2000);
          if (recent.length < 2) return 0;
          const span = t - recent[0].at;
          return span > 0 ? (recent.reduce((a, s) => a + s.steps, 0) * 1000) / span : 0;
        })(),
        phaseMs: { main: sum('main'), workers: sum('workers'), present: sum('present'), other: sum('other') },
        throttledPct: steps.length ? (steps.filter(s => s.throttled).length / steps.length) * 100 : 0,
        longTasks: this.longTasks.length,
        blockedMs: Math.round(this.longTasks.reduce((a, t) => a + t.ms, 0)),
      };
    }

    // ---- display -------------------------------------------------------

    _ensureDom() {
      if (this._dom) return;
      const root = document.createElement('div');
      root.id = 'perf-hud';
      root.style.cssText = [
        'position:absolute', 'top:6px', 'right:6px', 'z-index:40',
        'background:rgba(8,12,20,0.86)', 'border:1px solid #334155',
        'padding:4px', 'display:none', 'pointer-events:none',
        'font:10px/1.3 ui-monospace,Menlo,monospace', 'color:#e2e8f0',
      ].join(';');
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 168;
      // index.html styles every <canvas> as the full-bleed screen surface,
      // and its fullscreen rules do it with `height: 0 !important`. Inline
      // styles lose to !important, so opt out with an id-scoped rule of our
      // own — higher specificity, so it wins in every one of those states.
      if (!document.getElementById('perf-hud-style')) {
        const style = document.createElement('style');
        style.id = 'perf-hud-style';
        style.textContent = '#perf-hud canvas {'
          + 'position:static !important; inset:auto !important;'
          + 'width:300px !important; height:168px !important;'
          + 'max-width:none !important; max-height:none !important;'
          + 'flex:none !important; display:block !important;'
          + 'image-rendering:auto !important; background:transparent !important;'
          + '}';
        document.head.appendChild(style);
      }
      root.appendChild(canvas);
      (document.getElementById('screen-wrap') || document.body).appendChild(root);
      this._dom = { root, canvas, ctx: canvas.getContext('2d') };
    }

    _draw() {
      const { canvas, ctx } = this._dom;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const snap = this.snapshot();
      const pad = 4;

      // --- header ------------------------------------------------------
      ctx.font = '10px ui-monospace,Menlo,monospace';
      const blockedPct = snap.wallMs ? (snap.blockedMs / snap.wallMs) * 100 : 0;
      // GAME first, PAGE second, and never just "fps". A page compositing at
      // 60 while the guest presents 9 frames a second is the exact state that
      // feels laggy, and a single fps number hides it completely.
      ctx.fillStyle = snap.guestFps < 20 ? '#f87171' : '#4ade80';
      ctx.fillText(`GAME ${snap.guestFps.toFixed(1)} fps`, pad, 10);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`page ${snap.fps.toFixed(0)}  ${(snap.stepsPerSec / 1e6).toFixed(1)}M steps/s`, pad + 84, 10);
      ctx.fillStyle = blockedPct > 5 ? '#f87171' : '#94a3b8';
      ctx.fillText(`step p50 ${snap.stepMs.p50.toFixed(1)} p99 ${snap.stepMs.p99.toFixed(1)}ms  blocked ${blockedPct.toFixed(0)}%`, pad, 22);
      // If a stream was asked for, its state belongs on screen. Whoever
      // turned it on is usually not the person reading the server log.
      if (this.streamUrl) {
        const ok = this.streamStatus === 'ok';
        ctx.fillStyle = ok ? '#4ade80' : '#f87171';
        ctx.fillText(ok ? `● streaming ${this._session}` : `● stream ${this.streamStatus || 'starting'}`, pad, H - 14);
      }

      // --- stacked per-step bars ---------------------------------------
      // One column per step; height is where the main thread went. This is
      // the graph that answers "what is janking", because a tall column is
      // literally a step the browser could not interrupt.
      const g1y = 28, g1h = 74;
      const steps = this.steps;
      // Scale to the worst recent step, floored at 33ms so a healthy run
      // does not get auto-scaled into looking dramatic.
      let peak = 33;
      for (const s of steps) if (s.total > peak) peak = s.total;
      const barW = Math.max(1, W / HISTORY);

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, g1y, W, g1h);

      for (const ms of [16.7, 33]) {
        const y = g1y + g1h - (ms / peak) * g1h;
        ctx.strokeStyle = ms === 33 ? '#7f1d1d' : '#1e3a8a';
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); ctx.stroke();
      }

      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const x = i * barW;
        let y = g1y + g1h;
        for (const ph of PHASES) {
          const h = (s[ph.key] / peak) * g1h;
          if (h <= 0) continue;
          ctx.fillStyle = ph.color;
          ctx.fillRect(x, y - h, Math.max(1, barW - 0.2), h);
          y -= h;
        }
      }
      ctx.fillStyle = '#64748b';
      ctx.fillText(`${peak.toFixed(0)}ms`, W - 32, g1y + 9);

      // --- frame interval line -----------------------------------------
      const g2y = g1y + g1h + 14, g2h = 40;
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, g2y, W, g2h);
      let fpeak = 33;
      for (const f of this.frames) if (f > fpeak) fpeak = f;
      ctx.strokeStyle = '#1e3a8a';
      const y167 = g2y + g2h - (16.7 / fpeak) * g2h;
      ctx.beginPath(); ctx.moveTo(0, y167 + 0.5); ctx.lineTo(W, y167 + 0.5); ctx.stroke();
      ctx.strokeStyle = '#fbbf24';
      ctx.beginPath();
      for (let i = 0; i < this.frames.length; i++) {
        const x = i * barW;
        const y = g2y + g2h - Math.min(g2h, (this.frames[i] / fpeak) * g2h);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText('frame interval', pad, g2y - 3);
      ctx.fillText(`${fpeak.toFixed(0)}ms`, W - 32, g2y + 9);

      // --- legend with per-phase share ---------------------------------
      const totalPhase = Math.max(1, snap.phaseMs.main + snap.phaseMs.workers + snap.phaseMs.present + snap.phaseMs.other);
      let lx = pad;
      const ly = H - 3;
      for (const ph of PHASES) {
        const pct = (snap.phaseMs[ph.key] / totalPhase) * 100;
        ctx.fillStyle = ph.color;
        ctx.fillRect(lx, ly - 7, 6, 6);
        ctx.fillStyle = '#cbd5e1';
        const text = `${ph.label} ${pct.toFixed(0)}%`;
        ctx.fillText(text, lx + 9, ly);
        lx += 9 + ctx.measureText(text).width + 8;
      }
    }
  }

  global.WinePerf = new PerfHud();
})(typeof window !== 'undefined' ? window : globalThis);
