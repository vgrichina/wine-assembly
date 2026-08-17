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
    }

    // ---- lifecycle -----------------------------------------------------

    start() {
      if (this.enabled) return;
      this.enabled = true;
      this._startedAt = now();
      this._ensureDom();
      this._dom.root.style.display = 'block';

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
          this.frames.push(t - this._lastFrameAt);
          if (this.frames.length > HISTORY) this.frames.shift();
        }
        this._lastFrameAt = t;
        this._draw();
        this._rafHandle = requestAnimationFrame(tick);
      };
      this._rafHandle = requestAnimationFrame(tick);
    }

    stop() {
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

    // ---- readout for headless tools ------------------------------------

    // tools/profile-web-frames.js reads this instead of inferring phases
    // from the outside. Same numbers the HUD is drawing.
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
        phaseMs: { main: sum('main'), workers: sum('workers'), present: sum('present'), other: sum('other') },
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
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '10px ui-monospace,Menlo,monospace';
      const blockedPct = snap.wallMs ? (snap.blockedMs / snap.wallMs) * 100 : 0;
      ctx.fillText(`${snap.fps.toFixed(1)} fps   step p50 ${snap.stepMs.p50.toFixed(1)} p99 ${snap.stepMs.p99.toFixed(1)}ms`, pad, 10);
      ctx.fillStyle = blockedPct > 5 ? '#f87171' : '#94a3b8';
      ctx.fillText(`long ${snap.longTasks}  blocked ${blockedPct.toFixed(0)}%  max step ${snap.stepMs.max.toFixed(0)}ms`, pad, 22);

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
