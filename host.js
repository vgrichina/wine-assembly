// Wine-Assembly: JS host for the WASM x86 interpreter
// Win98Renderer is loaded from lib/renderer.js (included via <script> in index.html)

// The boot steps this host shares with the CLI harness: staging the EXE,
// load_pe, the exe-name/cmdline pokes, and the DLL dependency walk.
// lib/process-boot.js is a classic script loaded ahead of this one.
const ProcessBoot = (typeof window !== 'undefined' && window.processBoot) || null;

// iOS decides whether a page may be heard at all, and WebAudio alone does not
// get a say. A page that only ever makes sound through an AudioContext lands
// in the ambient-style session the ringer switch mutes: the context is
// running, samples are scheduled, currentTime advances, every level meter
// reads healthy -- and the phone plays nothing, with no error anywhere. A
// visitor with the switch flipped (or the volume rocker at its media zero,
// which is the same thing) hears silence from an emulator that looks fine.
//
// Declaring the session 'playback' is the one thing that opts a page out of
// it. Safari 16.4+; everywhere else the property is absent and this is a
// no-op. Idempotent because it is called from every launch and every unlock.
function claimAudioSession() {
  try {
    const session = (typeof navigator !== 'undefined') && navigator.audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch (_) { /* a browser that has the property but refuses the value */ }
}
if (typeof window !== 'undefined') window.claimAudioSession = claimAudioSession;

// ShellExecute receives lpFile and lpParameters separately, while WinExec's
// one string starts with the executable token. Keep the latter's whitespace
// rules scoped to WinExec so an unquoted ShellExecute path containing spaces
// retains the compatibility behavior existing applications depend on.
function parseShellLaunchCommand(rawFile, explicitParams, operation) {
  const source = String(rawFile || '');
  const isWinExec = /^winexec$/i.test(String(operation || ''));
  const s = source.trim();
  let file = source;
  let parsedParams = '';

  if (isWinExec) {
    if (s.startsWith('"')) {
      const close = s.indexOf('"', 1);
      if (close >= 0) {
        file = s.slice(1, close);
        parsedParams = s.slice(close + 1).trimStart();
      } else {
        file = '';
      }
    } else {
      const token = /^(\S+)(?:\s+([\s\S]*))?$/.exec(s);
      file = token ? token[1] : '';
      parsedParams = token && token[2] || '';
    }
  } else {
    const quoted = /^"([^"]+)"(?:\s+(.*))?$/.exec(s);
    if (quoted) {
      file = quoted[1];
      parsedParams = quoted[2] || '';
    } else {
      const absolute = /^([a-z]:\\\S+)(?:\s+(.*))?$/i.exec(s);
      if (absolute) {
        file = absolute[1];
        parsedParams = absolute[2] || '';
      }
    }
  }

  return {
    file,
    params: explicitParams || parsedParams,
    isWinExec,
  };
}

function resolveShellLaunchPath(file, vfs, isWinExec) {
  if (!isWinExec || /^[a-z]:\\/i.test(file) || !vfs ||
      typeof vfs._resolvePath !== 'function') return file;
  return vfs._resolvePath(file);
}

// ---------------------------------------------------------------------------
// Frozen (agent-stepped) mode — docs/design-agent-control.md
// ---------------------------------------------------------------------------
//
// The browser twin of the headless CLI: while frozen, the run loop schedules
// NOTHING. No slice runs, no frame is presented, and the guest clock does not
// move, so a screenshot an agent took cannot change under it. Work happens
// only when somebody asks for it — `WineFrozen.step(n)`, which runs exactly n
// slices and then parks again.
//
// The clock is the part that has to be got right. `_guestTickMs` derives guest
// time from the wall (`now - wallStartMs`), and a wall clock that keeps running
// while nothing executes is worse than useless: every WM_TIMER the app owns is
// instantly overdue when it resumes, and a `timeGetTime`-paced animation sees
// one enormous delta per step. So a frozen host stops reading the wall and
// charges `tickMs` of guest time per executed step instead — the browser's
// answer to `--tick-ms-per-batch` (lib/batch-clock.js is the CLI's, and is a
// different object over a different unit; nothing is shared but the idea).
// Unfreezing slides `wallStartMs` forward so the guest never sees a jump,
// exactly the way `_resumeFromHidden` does for a backgrounded tab.
//
// This bus is page-level rather than per-instance because the toolbar
// checkbox, the `?frozen` param and the agent channel all mean "this page",
// and a page may be running more than one guest (WRITE.EXE -> WordPad). Hosts
// register as they start running and inherit whatever the page has decided.
const frozenBus = {
  enabled: false,
  tickMs: 16,
  hosts: new Set(),

  status() {
    const hosts = [...frozenBus.hosts];
    return {
      frozen: frozenBus.enabled,
      tickMs: frozenBus.tickMs,
      hosts: hosts.length,
      steps: hosts.reduce((n, h) => n + (h._frozenSteps | 0), 0),
      // Total steps this page's guests have retired, frozen or live. The
      // number a watcher checks to answer "is anything running at all".
      ticks: hosts.reduce((n, h) => n + (h._stepTicks | 0), 0),
      guestMs: hosts.length ? Math.max(...hosts.map(h => h.frozenGuestMs())) : 0,
    };
  },

  // `manual` marks the ?debug checkbox (or an agent command) as the source, so
  // the page chrome can tell an echo of its own click from a change it must
  // mirror. Announced the same way agent-remote announces input exclusivity.
  setEnabled(on, opts) {
    const next = !!on;
    const changed = frozenBus.enabled !== next;
    frozenBus.enabled = next;
    for (const host of frozenBus.hosts) host.setFrozen(next);
    if (changed || (opts && opts.force)) frozenBus.announce();
    return frozenBus.status();
  },

  setTickMs(ms) {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) {
      frozenBus.tickMs = Math.min(60000, Math.floor(value));
      for (const host of frozenBus.hosts) host._frozenTickMs = frozenBus.tickMs;
      frozenBus.announce();
    }
    return frozenBus.status();
  },

  // Run n slices on every live guest in this page, then park again. Resolves
  // once they have all come back to rest, so the caller's next screenshot is
  // of a machine that has stopped.
  async step(n, tickMs) {
    if (!frozenBus.enabled) throw new Error('not frozen — check "Frozen" in the ?debug toolbar, load ?frozen, or send {action:"frozen",mode:"on"}');
    if (Number.isFinite(Number(tickMs))) frozenBus.setTickMs(tickMs);
    const hosts = [...frozenBus.hosts];
    if (!hosts.length) {
      return Object.assign(frozenBus.status(), { requested: n | 0, ran: 0, note: 'no app is running yet — launch one first' });
    }
    const each = await Promise.all(hosts.map(h => h.stepFrozen(n, frozenBus.tickMs)));
    frozenBus.announce();
    return Object.assign(frozenBus.status(), {
      requested: n | 0,
      ran: Math.max(...each.map(r => r.ran | 0)),
      timedOut: each.some(r => r.timedOut) || undefined,
      guests: each,
    });
  },

  announce() {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new CustomEvent('wine-frozen', { detail: frozenBus.status() }));
    } catch (_) { /* no CustomEvent in this host */ }
  },
};
// ---------------------------------------------------------------------------
// Frozen session recorder  (docs/design-frozen-recording.md)
// ---------------------------------------------------------------------------
//
// An agent driving a frozen session produces a wall-clock profile nothing can
// be made of: ~450 steps a second in bursts, separated by 30-90s of the agent
// thinking. lib/recorder.js records the wall clock, so it would record the
// thinking. This records the GUEST clock instead, and the two invariants that
// make an exact offline reconstruction possible are the frozen contract:
//
//   * pixels change only inside a step, and step k sits at a guest time this
//     recorder is told exactly (tickMs may change per `step` call, so the
//     actual per-step tickMs is written down rather than assumed);
//   * every sound is guest PCM arriving at a submit seam in lib/host-audio.js,
//     stamped off the same step-driven clock.
//
// So: sample the composited screen every k-th step as a JPEG tagged with
// {stepIndex, guestMs}, tap the PCM with its guestStartMs, ship both to the
// dev-server, and let tools/frozen-video.js lay them back down on the guest
// timeline. Hours of deliberation between steps collapse to nothing and the
// clip plays as continuous realtime gameplay.
//
// Nothing here may block stepping: frames are encoded off-thread by toBlob and
// posted from a queue that drains on its own, and a sink that falls behind
// drops frames rather than throttling the guest.
const frozenRecorder = {
  active: false,
  sink: '',
  session: '',
  everyNSteps: 2,
  quality: 0.85,
  frames: 0,
  framesDropped: 0,
  audioChunks: 0,
  audioBytes: 0,
  events: 0,
  startedAtGuestMs: 0,
  lastGuestMs: 0,
  _frames: [],
  _audio: [],
  _events: [],
  _inFlight: 0,
  _lastStep: -1,
  _postChain: Promise.resolve(),
  _capture: null,
  _pumps: new Set(),
  // A queue this deep already means the sink cannot keep up; holding more
  // just converts a network problem into a memory problem.
  MAX_QUEUED_FRAMES: 240,

  status() {
    return {
      recording: frozenRecorder.active,
      session: frozenRecorder.session || null,
      sink: frozenRecorder.sink || null,
      everyNSteps: frozenRecorder.everyNSteps,
      frames: frozenRecorder.frames,
      framesDropped: frozenRecorder.framesDropped,
      audioChunks: frozenRecorder.audioChunks,
      audioBytes: frozenRecorder.audioBytes,
      events: frozenRecorder.events,
      guestMs: Math.max(0, frozenRecorder.lastGuestMs - frozenRecorder.startedAtGuestMs),
      queued: frozenRecorder._frames.length + frozenRecorder._audio.length,
    };
  },

  async start(opts) {
    const o = opts || {};
    if (frozenRecorder.active) return frozenRecorder.status();
    frozenRecorder.sink = String(o.sink || (typeof location !== 'undefined' ? location.origin : ''))
      .replace(/\/+$/, '');
    frozenRecorder.everyNSteps = Math.max(1, parseInt(o.everyNSteps || o.k || 2, 10) || 2);
    frozenRecorder.quality = Number.isFinite(Number(o.quality)) ? Number(o.quality) : 0.85;
    frozenRecorder.frames = 0;
    frozenRecorder.framesDropped = 0;
    frozenRecorder.audioChunks = 0;
    frozenRecorder.audioBytes = 0;
    frozenRecorder.events = 0;
    frozenRecorder._frames.length = 0;
    frozenRecorder._audio.length = 0;
    frozenRecorder._events.length = 0;
    const guestMs = frozenBus.status().guestMs | 0;
    frozenRecorder.startedAtGuestMs = guestMs;
    frozenRecorder.lastGuestMs = guestMs;
    const meta = {
      name: String(o.name || '') || null,
      everyNSteps: frozenRecorder.everyNSteps,
      tickMs: frozenBus.tickMs,
      startGuestMs: guestMs,
      href: typeof location !== 'undefined' ? location.href : null,
      startedAt: new Date().toISOString(),
    };
    const reply = await frozenRecorder._post('start', meta);
    frozenRecorder.session = String((reply && reply.session) || meta.name || 'session');
    frozenRecorder.active = true;
    // One frame of the machine as it stands, so a recording that is stopped
    // after very few steps still has a first picture to start from. Tagged
    // with the step the page is actually AT, not zero: a recording armed
    // mid-session must keep the frame stream monotonic in guest time.
    frozenRecorder._lastStep = -1;
    frozenRecorder._postChain = Promise.resolve();
    frozenRecorder.capture(frozenBus.status().steps, guestMs, frozenBus.tickMs);
    return frozenRecorder.status();
  },

  async stop() {
    if (!frozenRecorder.active) return frozenRecorder.status();
    // The audio still owed by a looping buffer nobody touched belongs to this
    // recording, not to the next one.
    frozenRecorder.pumpAudio();
    frozenRecorder.active = false;
    await frozenRecorder.drain(true);
    const summary = frozenRecorder.status();
    await frozenRecorder._post('stop', {
      session: frozenRecorder.session,
      endGuestMs: frozenRecorder.lastGuestMs,
      frames: summary.frames,
      audioChunks: summary.audioChunks,
    });
    return summary;
  },

  registerPump(fn) {
    if (typeof fn === 'function') frozenRecorder._pumps.add(fn);
  },

  pumpAudio() {
    for (const fn of frozenRecorder._pumps) { try { fn(); } catch (_) {} }
  },

  // Called from _frozenPump with the state the step just produced.
  capture(stepIndex, guestMs, tickMs) {
    if (!frozenRecorder.active) return;
    frozenRecorder.lastGuestMs = guestMs;
    // The arming frame and the first pump frame can name the same step (a
    // recording armed on a k-boundary), and two frames at one guest time is
    // a zero-duration entry the assembler would have to invent a length for.
    if (stepIndex === frozenRecorder._lastStep) return;
    frozenRecorder._lastStep = stepIndex;
    if (frozenRecorder._frames.length >= frozenRecorder.MAX_QUEUED_FRAMES) {
      frozenRecorder.framesDropped++;
      return;
    }
    const canvas = frozenRecorder._sourceCanvas();
    if (!canvas) return;
    const header = {
      stepIndex: stepIndex | 0,
      guestMs: Math.round(guestMs),
      tickMs: Number(tickMs) || frozenBus.tickMs,
      k: frozenRecorder.everyNSteps,
      w: canvas.width, h: canvas.height,
    };
    // Placed in the queue NOW so frames stay in guest order even though
    // toBlob resolves later and out of order.
    // `encoded` rather than a non-null blob: toBlob can hand back null, and
    // a head slot that never becomes non-null would wedge the whole queue.
    const slot = { header, blob: null, encoded: false };
    frozenRecorder._frames.push(slot);
    frozenRecorder.frames++;
    const done = (blob) => { slot.blob = blob; slot.encoded = true; frozenRecorder.drain(); };
    try {
      if (canvas.toBlob) canvas.toBlob(done, 'image/jpeg', frozenRecorder.quality);
      else done(frozenRecorder._dataUrlToBlob(canvas.toDataURL('image/jpeg', frozenRecorder.quality)));
    } catch (_) { done(null); }
  },

  // lib/host-audio.js's tap target. `bytes` is a private copy already.
  pcm(chunk) {
    if (!frozenRecorder.active || !chunk || !chunk.bytes || !chunk.bytes.length) return;
    frozenRecorder.audioChunks++;
    frozenRecorder.audioBytes += chunk.bytes.length;
    frozenRecorder._audio.push({
      guestStartMs: Math.round(chunk.guestStartMs),
      sampleRate: chunk.sampleRate | 0,
      channels: chunk.channels | 0,
      bits: chunk.bits | 0,
      gainL: Number.isFinite(chunk.gainL) ? chunk.gainL : 1,
      gainR: Number.isFinite(chunk.gainR) ? chunk.gainR : 1,
      pcm: frozenRecorder._b64(chunk.bytes),
    });
    if (frozenRecorder._audio.length >= 32) frozenRecorder.drain();
  },

  // Optional sidecar: what the agent did, on the guest clock, so a clip can
  // be annotated with its own inputs later.
  event(kind, detail) {
    if (!frozenRecorder.active) return;
    frozenRecorder.events++;
    frozenRecorder._events.push(Object.assign({
      kind: String(kind), guestMs: Math.round(frozenRecorder.lastGuestMs),
    }, detail || {}));
    if (frozenRecorder._events.length >= 32) frozenRecorder.drain();
  },

  async drain(force) {
    // Frames only leave in order, so a slot still waiting on its encoder
    // holds the ones behind it — which is what keeps the stream monotonic.
    const ready = [];
    while (frozenRecorder._frames.length && frozenRecorder._frames[0].encoded) {
      ready.push(frozenRecorder._frames.shift());
    }
    if (force) {
      // A stop must not lose the tail; give the encoders a turn to land.
      for (let i = 0; i < 40 && frozenRecorder._frames.length; i++) {
        await new Promise(r => setTimeout(r, 25));
        while (frozenRecorder._frames.length && frozenRecorder._frames[0].encoded) {
          ready.push(frozenRecorder._frames.shift());
        }
      }
      frozenRecorder._frames.length = 0;
    }
    const jobs = [];
    if (ready.length) jobs.push(frozenRecorder._postFrames(ready));
    if (frozenRecorder._audio.length && (force || frozenRecorder._audio.length >= 8)) {
      const batch = frozenRecorder._audio.splice(0, frozenRecorder._audio.length);
      jobs.push(frozenRecorder._post('audio', { session: frozenRecorder.session, chunks: batch }));
    }
    if (frozenRecorder._events.length && (force || frozenRecorder._events.length >= 8)) {
      const batch = frozenRecorder._events.splice(0, frozenRecorder._events.length);
      jobs.push(frozenRecorder._post('events', { session: frozenRecorder.session, events: batch }));
    }
    if (jobs.length) await Promise.all(jobs).catch(() => {});
  },

  // The composited screen at guest resolution. In exclusive fullscreen the
  // canvas is the page layout with the picture fitted inside it, so crop the
  // fit box back out — the same rect lib/recorder.js and agent-remote use.
  _sourceCanvas() {
    if (typeof document === 'undefined') return null;
    const canvas = document.getElementById('screen');
    if (!canvas || !canvas.width || !canvas.height) return null;
    const r = (typeof window !== 'undefined' && window.sharedRenderer) || null;
    const t = r && r._exclusiveFullscreen && r._exclusiveTransform;
    const box = (t && (t.dstW | 0) > 0 && (t.dstH | 0) > 0 && (t.srcW | 0) > 0 && (t.srcH | 0) > 0)
      ? { x: t.dstX | 0, y: t.dstY | 0, w: t.dstW | 0, h: t.dstH | 0, sw: t.srcW | 0, sh: t.srcH | 0 }
      : null;
    // H.264 wants even dimensions; rounding here beats making ffmpeg scale.
    const w = ((box ? box.sw : canvas.width) | 0) & ~1;
    const h = ((box ? box.sh : canvas.height) | 0) & ~1;
    if (w < 2 || h < 2) return null;
    let out = frozenRecorder._capture;
    if (!out) out = frozenRecorder._capture = document.createElement('canvas');
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
    const cx = out.getContext('2d');
    // Copy synchronously: toBlob resolves later, and by then the guest may
    // have stepped again. The recording must show the step it is tagged with.
    if (box) cx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, w, h);
    else cx.drawImage(canvas, 0, 0, w, h, 0, 0, w, h);
    return out;
  },

  _b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
    }
    return typeof btoa === 'function' ? btoa(s) : Buffer.from(bytes).toString('base64');
  },

  _dataUrlToBlob(url) {
    try {
      const comma = url.indexOf(',');
      const bin = atob(url.slice(comma + 1));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return new Blob([out], { type: 'image/jpeg' });
    } catch (_) { return null; }
  },

  // Frames go up as one binary container rather than base64 JSON: at 31fps a
  // recording is megabytes a second and a 33% expansion is real cost on a
  // path that must not fall behind the guest.
  //
  //   'WAF1' then, per frame: u32 headerLen, header JSON, u32 jpegLen, jpeg
  async _postFrames(slots) {
    const parts = [new Uint8Array([0x57, 0x41, 0x46, 0x31])];
    const u32 = (n) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n >>> 0, true);
      return b;
    };
    let any = false;
    for (const slot of slots) {
      if (!slot.blob) continue;
      any = true;
      const header = new TextEncoder().encode(JSON.stringify(slot.header));
      parts.push(u32(header.length), header, u32(slot.blob.size), slot.blob);
    }
    if (!any) return;
    const body = new Blob(parts, { type: 'application/octet-stream' });
    // Chained, not parallel. Two batches in flight at once can land at the
    // sink in either order, and the sink numbers frames by arrival — which
    // would leave frames.ndjson out of guest order for no reason at all.
    const send = async () => {
      try {
        await fetch(`${frozenRecorder.sink}/api/record/frames?s=${encodeURIComponent(frozenRecorder.session)}`,
          { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
      } catch (_) { frozenRecorder.framesDropped += slots.length; }
    };
    frozenRecorder._postChain = frozenRecorder._postChain.then(send, send);
    return frozenRecorder._postChain;
  },

  async _post(route, payload) {
    try {
      const response = await fetch(`${frozenRecorder.sink}/api/record/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await response.json();
    } catch (error) {
      if (route === 'start') throw new Error(`recording sink unreachable at ${frozenRecorder.sink}/api/record — is tools/dev-server.js serving this page?`);
      return null;
    }
  },
};

if (typeof window !== 'undefined') {
  window.WineFrozen = frozenBus;
  window.WineRecorder = frozenRecorder;
  // `?frozen` (optionally `?frozen=MS`) is a convenience that pre-checks the
  // box: a dashboard tile, or an agent's own tab, can be born stepped rather
  // than having to freeze a machine that already ran its boot.
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('frozen')) {
      const raw = params.get('frozen');
      if (raw && /^\d+$/.test(raw)) frozenBus.tickMs = Math.min(60000, parseInt(raw, 10));
      frozenBus.enabled = true;
    }
  } catch (_) { /* no location (a worker, a test harness) */ }
}

class WineAssembly {
  static SOURCE_VERSION = '275';
  static ASSET_PART_SIZE = 10 * 1024 * 1024;
  // Ceiling on any sleep the drive loop takes while the guest is parked. Every
  // sleep is bounded by a deadline the guest actually named; this bounds the
  // damage when one of those deadlines is wrong or a wake source is missing,
  // turning a hang into 20Hz polling.
  static MAX_PARK_SLEEP_MS = 50;
  // How long an AudioContext may sit 'running' with nothing playing before it
  // is suspended. A running context holds the audio hardware awake.
  static AUDIO_IDLE_SUSPEND_MS = 10000;
  // Frozen mode: the biggest single `step` a caller may ask for, and how long
  // a step request waits for the step count to move before giving up.
  static FROZEN_MAX_STEPS = 2000000;
  static FROZEN_STALL_MS = 5000;
  static _nextProcessId = 1000;

  static _assetPartUrl(url, index) {
    const match = String(url).match(/^([^?#]*)(.*)$/);
    return match[1] + '.part' + String(index).padStart(3, '0') + match[2];
  }

  // berrry cannot serve a stored file whose name contains a space: the file is
  // in its manifest and 404s under every encoding (%20, +, %2520). The deployer
  // therefore publishes those under a space-free name; this is the read half of
  // that convention. Only a 404 tries it, so a local dev server -- which serves
  // the real spaced name fine -- always takes the direct path.
  static _spaceFreeUrl(url) {
    const match = String(url).match(/^([^?#]*)(.*)$/);
    if (!/[ ]|%20/i.test(match[1])) return null;
    return match[1].replace(/%20/gi, '_').replace(/ /g, '_') + match[2];
  }

  // Keep split assets a transport detail. Normal files take one request; only
  // a 404 tries the deployer's name.part000, name.part001, ... convention.
  static async fetchAssetBytes(url) {
    try {
      return await WineAssembly._fetchAssetCandidate(url);
    } catch (e) {
      const alt = WineAssembly._spaceFreeUrl(url);
      if (!alt || !/HTTP 404$/.test(String(e && e.message))) throw e;
      return await WineAssembly._fetchAssetCandidate(alt);
    }
  }

  static async _fetchAssetCandidate(url) {
    const direct = await fetch(url);
    if (direct.ok) return new Uint8Array(await direct.arrayBuffer());
    if (direct.status !== 404) {
      throw new Error(`Unable to load ${url}: HTTP ${direct.status}`);
    }

    const parts = [];
    let total = 0;
    for (let index = 0; ; index++) {
      const partUrl = WineAssembly._assetPartUrl(url, index);
      const response = await fetch(partUrl);
      if (response.status === 404) {
        if (index === 0) throw new Error(`Unable to load ${url}: HTTP 404`);
        throw new Error(`Unable to load ${url}: missing ${partUrl}`);
      }
      if (!response.ok) {
        throw new Error(`Unable to load ${partUrl}: HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      parts.push(bytes);
      total += bytes.length;
      if (bytes.length < WineAssembly.ASSET_PART_SIZE) break;
    }

    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }

  static hasRemainingAppWindow(destroyed, remainingTopLevel) {
    // A hidden startup/helper window disappearing is not a user-visible app
    // close. Pinball hides and destroys its splash before its main frame is
    // ready; stopping synchronously here prevents the guest from reaching the
    // later ShowWindow call even when no renderer window currently remains.
    if (destroyed && destroyed.visible === false) return true;
    if (!remainingTopLevel || remainingTopLevel.length === 0) return false;
    if (!destroyed || !destroyed.isDialog) return true;

    // A dialog-only application usually leaves one invisible owner behind
    // when its last visible dialog closes. Pinball does the inverse during
    // startup: its independent main frame may exist but not be shown yet.
    // Keep a hidden independent frame, but not the dialog's hidden owner.
    const ownerHwnd = destroyed.ownerHwnd >>> 0;
    return remainingTopLevel.some(w =>
      w && (w.visible || (w.hwnd >>> 0) !== ownerHwnd)
    );
  }

  constructor() {
    // A debug tab is a live-worktree harness. Stop/Launch creates a new
    // process and must see a newly rebuilt module even when the page itself
    // was not reloaded; production keeps sharing one compiled module.
    if (typeof location !== 'undefined' &&
        new URLSearchParams(location.search).has('debug')) {
      WineAssembly._wasmModulePromise = null;
    }
    // One WineAssembly object models one Win32 process. Worker WASM instances
    // created by ThreadManager are threads of this process and share its PID
    // through the process's SharedArrayBuffer-backed memory.
    this.processId = WineAssembly._nextProcessId++;
    this.instance = null;
    this.memory = null;
    this.running = false;
    this.renderer = null;
    this.resourceJson = null;
    this.threadManager = null;
    // Slot 0's focus global lives in the guest Worker. Browser input cannot
    // synchronously call that instance, so the Worker publishes it after each
    // slice and mouse-down routing updates it immediately between slices.
    this._workerFocusHwnd = 0;
    // Keyboard arrival cuts the in-flight Worker slice through INPUT_WAKE.
    // Keep the following few slices short as well so dequeue, dispatch, paint,
    // and presentation cannot disappear inside a fresh 100k-block slice.
    this._workerInputBurstSlices = 0;
    // Real-Worker block cost changes drastically between a loader, a menu and
    // gameplay. Learn a presentation-sized budget from completed slices rather
    // than forcing every phase through one app-wide block count.
    this._workerAdaptiveSteps = 0;
    this._workerAdaptiveCeiling = 0;
    // [{ name, base }], every image this process has loaded. A guest thread that
    // traps reports a raw EIP, and a raw EIP in a DLL is unreadable — the load
    // address depends on what loaded before it, so the same crash prints a
    // different number every run and matches nothing in any disassembly. With
    // this, the trap says `in_mp3.dll+0x14564`, which tools/disasm_fn.js can be
    // pointed at directly.
    this.moduleMap = [];
    this._wasmModule = null;
    this.stepsPerSlice = 100000;
    // Browser-shell may tune cooperative scheduling when a game replaces its
    // renderer in-process. The GL bridge reports context lifetime without
    // making the generic host depend on an app name.
    this.onOpenGLContextCountChange = null;
    this.onGuestFrame = null;
    this.onRegistryValueChanged = null;
    this._perfLogicalFrame = null;
    this._perfCounterPoll = null;
    this._perfCounterPollBusy = false;
    // Most programs replace a destroyed startup window immediately. A few
    // games tear down a warning/splash before doing substantial renderer
    // initialization, so the browser launcher may opt them into a longer
    // no-window interval without weakening normal last-window teardown.
    this.windowlessGraceMs = 750;
    this.verbose = false;
    // Some WinMM clients intentionally wait for a timeSetEvent callback while
    // they are not pumping messages. This remains opt-in per app: the normal
    // path still delivers the callback through the guest message loop.
    this.asyncMultimediaTimer = false;
  }

  _normalizePerfLogicalFrame(perf) {
    const metric = perf && perf.logicalFrame;
    if (!metric) return null;
    const address = Number(metric.address);
    if (!Number.isFinite(address) || address <= 0) return null;
    const out = {
      label: String(metric.label || 'GAME').slice(0, 12) || 'GAME',
      address: address >>> 0,
      verifier: 0,
    };
    const verifier = Number(metric.verifier);
    if (Number.isFinite(verifier) && verifier > 0) out.verifier = verifier >>> 0;
    return out;
  }

  async configurePerf(perf) {
    this._stopPerfCounterPoll();
    this._perfLogicalFrame = this._normalizePerfLogicalFrame(perf);
    const hud = (typeof window !== 'undefined' && window.WinePerf) || null;
    if (!this._perfLogicalFrame) {
      if (hud && hud.setLogicalFrameMetric) hud.setLogicalFrameMetric(null);
      return false;
    }

    const metric = this._perfLogicalFrame;
    if (hud && hud.setLogicalFrameMetric) hud.setLogicalFrameMetric(metric);
    try {
      await this._armPerfCounter(0, metric.address);
      if (metric.verifier) await this._armPerfCounter(1, metric.verifier);
    } catch (err) {
      console.warn('[perf] logical frame counter disabled:', err && err.message || err);
      this._perfLogicalFrame = null;
      if (hud && hud.setLogicalFrameMetric) hud.setLogicalFrameMetric(null);
      return false;
    }
    this._startPerfCounterPoll();
    return true;
  }

  async _armPerfCounter(slot, address) {
    slot |= 0;
    address >>>= 0;
    if (this.guestWorker) {
      await this.guestWorker.callExport('set_count', slot, address);
      return;
    }
    const ex = this.instance && this.instance.exports;
    if (ex && typeof ex.set_count === 'function') ex.set_count(slot, address);
  }

  async _readPerfCounter(slot) {
    slot |= 0;
    if (this.guestWorker) {
      return (await this.guestWorker.callExport('get_count', slot)) >>> 0;
    }
    const ex = this.instance && this.instance.exports;
    return ex && typeof ex.get_count === 'function' ? ex.get_count(slot) >>> 0 : 0;
  }

  _startPerfCounterPoll() {
    if (typeof window === 'undefined' || this._perfCounterPoll || !this._perfLogicalFrame) return;
    const poll = async () => {
      if (this._perfCounterPollBusy || !this._perfLogicalFrame || this._stopped) return;
      const hud = window.WinePerf;
      if (!hud || !hud.logicalFrameCount) return;
      this._perfCounterPollBusy = true;
      try {
        const primary = await this._readPerfCounter(0);
        const verifier = this._perfLogicalFrame.verifier ? await this._readPerfCounter(1) : null;
        hud.logicalFrameCount(primary, verifier);
      } catch (_) {
        this._stopPerfCounterPoll();
      } finally {
        this._perfCounterPollBusy = false;
      }
    };
    poll();
    this._perfCounterPoll = setInterval(poll, 500);
  }

  _stopPerfCounterPoll() {
    if (this._perfCounterPoll) clearInterval(this._perfCounterPoll);
    this._perfCounterPoll = null;
    this._perfCounterPollBusy = false;
    if (typeof window !== 'undefined' && window.WinePerf && window.WinePerf.setLogicalFrameMetric) {
      window.WinePerf.setLogicalFrameMetric(null);
    }
  }

  _pumpMultimediaTimer() {
    const ex = this.instance && this.instance.exports;
    if (!this.asyncMultimediaTimer || !ex || !ex.fire_mm_timer) return 0;
    if (ex.get_eip && !(ex.get_eip() >>> 0)) return 0;
    return ex.fire_mm_timer() | 0;
  }

  _isMainExecutionSuspended() {
    if (!this.threadManager || !this.threadManager.isMainThreadSuspended ||
        !this.threadManager.isMainThreadSuspended()) return false;
    const ex = this.instance && this.instance.exports;
    // timeSetEvent runs on a system timer thread on Win32. The cooperative
    // backend serializes that callback through the main WASM instance, so a
    // callback such as Miles' mixer may suspend the saved application thread
    // while it services audio. Let the borrowed callback context reach its
    // matching ResumeThread; the interrupted application context remains
    // parked until the callback continuation restores it.
    return !(ex && ex.is_mm_timer_callback_active &&
      (ex.is_mm_timer_callback_active() | 0));
  }

  _closeSyncHandle(handle) {
    return !!(this.threadManager && this.threadManager.closeSyncHandle &&
      this.threadManager.closeSyncHandle(handle >>> 0));
  }

  _guestTickState(sharedAudio) {
    const shared = sharedAudio || this._sharedAudio || (this._sharedAudio = {});
    if (!shared.guestTickState) {
      shared.guestTickState = { wallStartMs: 0, batchMs: 0, callsInBatch: 0, lastReturnedMs: 0 };
    }
    return shared.guestTickState;
  }

  _beginGuestTickBatch(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    // Frozen mode charges guest time per executed step instead of reading the
    // wall — see the frozen-mode block above `class WineAssembly`.
    if (this._frozen) { st.callsInBatch = 0; return; }
    const now = this._audioSchedulerNow();
    if (!Number.isFinite(st.wallStartMs) || st.wallStartMs <= 0) st.wallStartMs = now;
    const elapsed = Math.max(0, Math.floor(now - st.wallStartMs));
    st.batchMs = Math.max(Number.isFinite(st.batchMs) ? st.batchMs : 0, elapsed) & 0x7FFFFFFF;
    st.callsInBatch = 0;
  }

  _guestTickMs(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    if (this._frozen) {
      // Whatever the executed steps have charged, and not one millisecond
      // more: a guest polling GetTickCount inside one frozen step must see a
      // clock that is standing still, or a spin-until-the-time-changes loop
      // would burn the step's whole quantum on a clock the agent did not move.
      const batchMs = Number.isFinite(st.batchMs) ? st.batchMs : 0;
      const last = Number.isFinite(st.lastReturnedMs) ? st.lastReturnedMs : 0;
      const tick = Math.max(batchMs, last) & 0x7FFFFFFF;
      st.batchMs = tick;
      st.lastReturnedMs = tick;
      st.callsInBatch = (Number.isFinite(st.callsInBatch) ? st.callsInBatch : 0) + 1;
      return tick;
    }
    const now = this._audioSchedulerNow();
    if (!Number.isFinite(st.wallStartMs) || st.wallStartMs <= 0) st.wallStartMs = now;
    const elapsed = Math.max(0, Math.floor(now - st.wallStartMs));
    const batchMs = Math.max(Number.isFinite(st.batchMs) ? st.batchMs : 0, elapsed);
    const last = Number.isFinite(st.lastReturnedMs) ? st.lastReturnedMs : 0;
    const tick = Math.max(batchMs, last) & 0x7FFFFFFF;
    st.batchMs = tick;
    st.lastReturnedMs = tick;
    st.callsInBatch = (Number.isFinite(st.callsInBatch) ? st.callsInBatch : 0) + 1;
    return tick;
  }

  _advanceGuestTickMs(ms, sharedAudio) {
    const requested = Number(ms);
    const delta = Number.isFinite(requested)
      ? Math.min(0x7FFFFFFF, Math.max(0, Math.floor(requested))) : 0;
    if (!delta) return;
    const st = this._guestTickState(sharedAudio);
    const current = Math.max(Number.isFinite(st.batchMs) ? st.batchMs : 0,
      Number.isFinite(st.lastReturnedMs) ? st.lastReturnedMs : 0);
    const advanced = (current + delta) % 0x80000000;
    st.batchMs = advanced;
    st.lastReturnedMs = advanced;
  }

  _guestAudioClockMs(sharedAudio) {
    const st = this._guestTickState(sharedAudio);
    return Number.isFinite(st.batchMs) ? st.batchMs : 0;
  }

  readString(ptr) {
    const bytes = new Uint8Array(this.memory.buffer);
    let str = '';
    for (let i = ptr; bytes[i] !== 0 && i < ptr + 1024; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return str;
  }

  // The mounted view of a guest path: whatever the launch already put in the
  // VFS, matched by full path, by c:\-rooted path, and finally by basename,
  // because a guest names a file however its own code spelled it.
  _vfsLookup(name, instanceVfs) {
    const baseName = String(name).replace(/^.*[\\\/]/, '');
    const lowerName = String(name).toLowerCase().replace(/\//g, '\\');
    const lowerBase = baseName.toLowerCase();
    const vfs = instanceVfs || (this._helpCtx && this._helpCtx.vfs);
    if (!vfs || !vfs.files) return null;
    const candidates = [
      lowerName,
      'c:\\' + lowerName.replace(/^\\+/, ''),
      'c:\\' + lowerBase,
    ];
    for (const p of candidates) {
      const entry = vfs.files.get(p);
      if (entry && entry.data) return entry.data;
    }
    for (const [p, entry] of vfs.files) {
      if (String(p).split('\\').pop() === lowerBase && entry && entry.data) return entry.data;
    }
    return null;
  }

  // Fetch a file the launch did not mount, off the main thread, and mount it
  // so every later read is a plain VFS hit. Both outcomes are remembered:
  // an app that probes the same missing name in a loop costs one request, not
  // one per probe, and a 404 is remembered as a 404.
  _fetchMissingFile(name, instanceVfs) {
    const baseName = String(name).replace(/^.*[\\\/]/, '');
    if (!this._missingFetches) this._missingFetches = new Map();
    const exeDir = this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
    const url = exeDir ? exeDir + baseName : 'binaries/' + baseName;
    const pending = this._missingFetches.get(url);
    if (pending) return pending;
    const p = WineAssembly.fetchAssetBytes(url)
      .then(data => {
        const vfs = instanceVfs || (this._helpCtx && this._helpCtx.vfs);
        if (vfs && vfs.files) {
          vfs.files.set('c:\\' + baseName.toLowerCase(), { data, attrs: 0x20 });
        }
        return data;
      })
      .catch(() => null);
    this._missingFetches.set(url, p);
    return p;
  }

  // Per-app thread-exit fixups (Winamp's visualizer bookkeeping) live in
  // lib/app-profiles.js, so the CLI harness runs the same ones.
  _onThreadExit(info) {
    const profiles = (typeof window !== 'undefined' && window.appProfiles) || null;
    if (!profiles || !this.instance || !this.memory) return;
    profiles.onThreadExit(
      this._exeName, info, this.instance.exports, this.memory.buffer);
  }

  // The guest has reached an audio API for the first time. Everything below
  // keys off this: until it happens there is no AudioContext, because a
  // running AudioContext keeps the audio hardware powered whether or not a
  // single sample is ever played, and most apps never play one. Notepad used
  // to open one at launch and hold it 'running' for the whole session.
  markAudioRequested() {
    this._audioRequested = true;
    this._startAudioIdleWatch();
  }

  // Resume a context we suspended for silence. Called from the one place that
  // knows sound is imminent (host-audio's _markWaveOutHot), which is reached
  // on open and on every buffer submit — so the first effect of an app that
  // has been quiet is not swallowed, it just costs a resume.
  wakeAudio() {
    this._audioIdleSince = 0;
    const ac = this._audioCtx;
    if (ac && ac.state === 'suspended') {
      try { ac.resume(); } catch (_) {}
    }
  }

  _startAudioIdleWatch() {
    if (this._audioIdleTimer || typeof setInterval !== 'function') return;
    this._audioIdleTimer = setInterval(() => {
      const ac = this._audioCtx;
      if (!ac || ac.state !== 'running') { this._audioIdleSince = 0; return; }
      if (this._isAudioHot()) { this._audioIdleSince = 0; return; }
      const now = this._audioSchedulerNow();
      if (!this._audioIdleSince) { this._audioIdleSince = now; return; }
      if (now - this._audioIdleSince < WineAssembly.AUDIO_IDLE_SUSPEND_MS) return;
      this._audioIdleSince = 0;
      // Suspended, never closed: a closed context cannot be reopened, and
      // wakeAudio() has to be able to bring this one back for the next sound.
      try { ac.suspend(); } catch (_) {}
    }, 2000);
  }

  _stopAudioIdleWatch() {
    if (this._audioIdleTimer) {
      clearInterval(this._audioIdleTimer);
      this._audioIdleTimer = 0;
    }
    this._audioIdleSince = 0;
  }

  primeAudio() {
    // Launch calls this unconditionally, and so does every touch (the iOS
    // gesture unlock). Both are the right moment to *unlock* audio and the
    // wrong moment to *create* it: a gesture is only worth spending on an app
    // that has asked for sound. Once one has, the next gesture primes it —
    // which is the pattern iOS actually needs, since the app's own first
    // waveOut is rarely inside a gesture.
    if (!this._audioCtx && !this._audioRequested) return null;
    const AC = (typeof AudioContext !== 'undefined') ? AudioContext :
               (typeof webkitAudioContext !== 'undefined') ? webkitAudioContext : null;
    if (!AC) return null;
    claimAudioSession();
    if (this._audioCtx && this._audioCtx.state === 'closed') this._audioCtx = null;
    if (!this._audioCtx) {
      try { this._audioCtx = new AC({ sampleRate: 44100 }); }
      catch (_) {
        try { this._audioCtx = new AC(); } catch (_) { this._audioCtx = null; }
      }
    }
    if (this._audioCtx && this._audioCtx.state === 'suspended') {
      try { this._audioCtx.resume(); } catch (_) {}
    }
    return this._audioCtx;
  }

  getImports(options) {
    const self = this;
    const opts = options || {};
    const sharedAudio = opts.sharedAudio || self._sharedAudio || (self._sharedAudio = {});
    const sharedMixer = opts.sharedMixer || self._sharedMixer || null;
    self._guestTickState(sharedAudio);
    const ctx = {
      getMemory: () => self.memory.buffer,
      apiTable: self.apiTable,
      get renderer() { return self.renderer; },
      get resourceJson() { return self.resourceJson; },
      get dllResources() { return self.dllResources; },
      get instance() {
        if (typeof opts.instance === 'function') return opts.instance();
        return opts.instance || self.instance || null;
      },
      get exports() {
        if (typeof opts.exports === 'function') return opts.exports();
        if (opts.exports) return opts.exports;
        const instance = this.instance;
        return instance ? instance.exports : null;
      },
      get processId() { return self.processId; },
      // CloseHandle is shared by VFS files and process synchronization
      // objects. The CLI installs this scheduler callback explicitly; keep the
      // browser context on the same path so short-lived Storm events release
      // their fixed-table slots instead of leaking until creation fails.
      closeSyncHandle: handle => self._closeSyncHandle(handle),
      signalSyncHandle: handle => self.threadManager
        ? self.threadManager.setEvent(handle >>> 0) : 0,
      resetSyncHandle: handle => self.threadManager
        ? self.threadManager.resetEvent(handle >>> 0) : 0,
      traceHost: opts.traceHost || (typeof window !== 'undefined' ? window.__waTraceHostNames : null),
      // Trace categories (the browser twin of test/run.js's --trace-dx etc).
      // lib/host-imports.js reads ctx.trace, so setting window.__waTraceCategories
      // before launch turns the same [dx]/[gdi]/[ctrl] logs on in the page —
      // the only way to see which surface the browser actually uploads.
      trace: opts.trace || (typeof window !== 'undefined' ? window.__waTraceCategories : null),
      threadId: opts.threadId | 0,
      vfs: opts.vfs || null,
      // The virtual LAN segment this page is joined to, or null when it is
      // alone in its own room. A worker thread is part of the same process,
      // so it is handed the same wire rather than opening one of its own.
      vlanWire: opts.vlanWire || self.vlanWire || null,
      get availableDllFiles() { return opts.availableDllFiles || self._availableDllFiles || null; },
      // Live guest thread count, for HKEY_DYN_DATA\PerfStats KERNEL\Threads.
      get threadManager() { return self.threadManager; },
      sharedGdi: opts.sharedGdi || null,
      sharedAudio,
      sharedMixer,
      audioClockMs: () => self._guestAudioClockMs(sharedAudio),
      // Frozen session recorder (docs/design-frozen-recording.md): host-audio
      // asks for a tap on every PCM submit and gets null unless one is armed,
      // so an unrecorded session pays one property read per buffer. The pump
      // is how a looping DirectSound ring nobody touched still gets its swept
      // window emitted once per captured frame.
      audioTap: () => (frozenRecorder.active ? frozenRecorder : null),
      registerAudioTapPump: fn => frozenRecorder.registerPump(fn),
      onOpenGLContextCountChange: count => {
        if (typeof self.onOpenGLContextCountChange === 'function') {
          self.onOpenGLContextCountChange(count | 0);
        }
      },
      onGuestFrame: frame => {
        if (typeof self.onGuestFrame === 'function') self.onGuestFrame(frame);
      },
      onRegistryValueChanged: change => {
        if (typeof self.onRegistryValueChanged === 'function') {
          self.onRegistryValueChanged(change);
        }
      },
      onAudioCaptureError: (message) => {
        self._lastAudioCaptureError = String(message || 'microphone unavailable');
        if (typeof document !== 'undefined') {
          const status = document.getElementById('status');
          if (status) status.textContent = 'Microphone unavailable: ' + self._lastAudioCaptureError;
        }
      },
      get _audioCtx() { return self._audioCtx; },
      set _audioCtx(v) { self._audioCtx = v; },
      // The two seams that make the AudioContext lazy. host-audio owns the
      // context; the host owns the policy about when one should exist.
      markAudioRequested: () => self.markAudioRequested(),
      wakeAudio: () => self.wakeAudio(),
      // A 16-bit LoadLibrary for a module nothing imports statically: the
      // Entertainment Pack's WEPUTIL, or the per-level DLL Stones ships one of
      // per screen. WAT has already given the name a module id and wants the
      // bytes in that id's staging slot before it returns, and the page cannot
      // fetch anything synchronously — so the app's registry entry names these
      // and loadExe has them in hand before the guest runs.
      win16StageModule: (name, id) => self._stageWin16Module(name, id),
      readFile: (name) => self._vfsLookup(name, ctx.vfs),
      // A miss is a file the app's registry entry never listed, so the page
      // never mounted it. It used to be read with a *synchronous*
      // XMLHttpRequest, which froze the tab for a whole network round trip
      // and was invisible to the perf HUD's phase marks. Nothing that reads
      // through here needs the bytes in the same turn: the two callers are a
      // wallpaper set and an MCI open, and MCI is allowed to still be
      // spinning a device up when open returns. So the miss now starts an
      // async fetch and the caller applies the bytes when they land.
      readFileAsync: (name) => {
        const have = self._vfsLookup(name, ctx.vfs);
        if (have) return Promise.resolve(have);
        return self._fetchMissingFile(name, ctx.vfs);
      },
      onTopLevelWindowDestroyed: (hwnd, destroyed) => {
        if (!self._multiApp || !self.renderer || !self._hwndBase) return;
        const lo = self._hwndBase;
        const hi = lo + 0x10000;
        if (hwnd < lo || hwnd >= hi) return;
        const remainingTopLevel = Object.values(self.renderer.windows).filter(w =>
          w && !w.isChild && w.hwnd >= lo && w.hwnd < hi
        );
        const stillHasTopLevel = WineAssembly.hasRemainingAppWindow(
          destroyed, remainingTopLevel
        );
        // "No windows left" is a guess that the app is finished, not proof:
        // a Win32 app ends when its message loop ends, not when its window
        // count reaches zero. Funtris opens on a modal splash and only builds
        // its game window once that is dismissed, so stopping the instant the
        // splash closed killed it in between. Give the guest a short grace
        // period to put another top-level window up; _checkLastWindowStop
        // finishes the teardown if it does not.
        if (!stillHasTopLevel) {
          const graceMs = Number.isFinite(self.windowlessGraceMs)
            ? Math.max(0, self.windowlessGraceMs)
            : 750;
          self._lastWindowStopAt = Date.now() + graceMs;
        } else self._lastWindowStopAt = 0;
      },
      onExit: (code) => {
        self.stop();
      },
    };
    if (!opts.detached) {
      self._helpCtx = ctx;
      self.hostCtx = ctx;
    }
    const base = createHostImports(ctx);
    ctx.sharedGdi = base.gdi;
    const h = base.host;

    // --- DirectDraw presentation: driven by the guest, paced by the display ---
    //
    // Presenting used to be a poll -- one run slice in sixteen called
    // presentBestDxOffscreen(), which then threw the blit away unless a
    // signature of the surface had changed. That signature samples four bytes
    // per row, so on a 640x480 primary it looks at 1920 of 307200 pixels: a
    // small moving sprite (DX-Ball's ball) usually changes none of them and the
    // frame is discarded, and *which* frames survive depends on where the
    // sprite happens to be. That reads as irregular lag rather than as a low
    // frame rate, and no amount of polling faster fixes it.
    //
    // The guest already says when it has finished a frame, so listen instead of
    // guessing. dx_trace kinds, from src/09a8-handlers-directx.wat:
    //   1 = Lock   2 = Unlock   5 = present   6 = Flip
    // Wrapping it here (the way test/run.js does) keeps this whole change out
    // of lib/host-imports.js: presentBestDxOffscreen(true) already bypasses the
    // signature compare, so nothing inside it needs to change.
    const dxLockDepth = new Map();
    const rawDxTrace = h.dx_trace;
    h.dx_trace = (kind, slot, a1, a2, a3) => {
      if (kind === 1) {
        dxLockDepth.set(slot, (dxLockDepth.get(slot) || 0) + 1);
      } else if (kind === 2) {
        const left = (dxLockDepth.get(slot) || 0) - 1;
        if (left > 0) dxLockDepth.set(slot, left); else dxLockDepth.delete(slot);
        self._dxDirty = true;   // a released write is a finished write
      } else if (kind === 5 || kind === 6) {
        self._dxDirty = true;
        if (typeof self.onGuestFrame === 'function') {
          self.onGuestFrame({ kind: 'directdraw' });
        }
      }
      return rawDxTrace ? rawDxTrace(kind, slot, a1, a2, a3) : undefined;
    };

    // Run slices are macrotasks and there are far more of them than there are
    // display frames, so a dirty flag alone would upload the surface hundreds
    // of times a second to show sixty. This counter ticks once per repaint
    // opportunity and caps presentation at one canvas upload per frame; using
    // rAF rather than a timer also means it stops while the tab is hidden.
    //
    // It has to stop when the app does. This loop closes over `self`, so as
    // long as it is scheduled the browser holds the whole WineHost alive --
    // and a WineHost owns a 512MB shared WebAssembly.Memory (8192 pages,
    // initial == maximum, so committed at instantiate). Left
    // running, every launch in a session leaked half a gigabyte that nothing
    // could ever collect: measured 3 launch/close cycles = 1536MB still
    // alive, with runningApps empty and the desktop looking perfectly
    // healthy. A phone does not have three of those, so the second or third
    // app a visitor opened failed with "Out of memory" -- which is what
    // "sometimes it closes properly, sometimes it doesn't" actually was.
    // It used to be a bare rAF chain ticking that counter. Two problems with
    // that: it ran for the app's whole life even for a GDI-only program that
    // never creates a DirectDraw surface, and every scheduled frame held the
    // whole WineHost — and its 512MB shared memory — alive (see above; that
    // was the "second app fails with Out of memory" bug).
    //
    // Derive the frame number from the clock instead. It answers the same
    // question ("has a display frame's worth of time passed since the last
    // upload?") with no chain to leak and nothing to tick when the app is not
    // presenting. The hidden-tab check keeps the property the rAF gave for
    // free: a backgrounded tab uploads nothing.
    self._dxFrameSeqNow = () => {
      if (typeof document !== 'undefined' && document.hidden) return null;
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
      return Math.floor(now / 16.7);
    };

    self._presentDxIfDirty = () => {
      if (!self._dxDirty) return;
      const gdi = self.hostCtx && self.hostCtx.sharedGdi;
      if (!gdi || !gdi.presentBestDxOffscreen) return;
      // One upload per display frame. A null sequence means "do not present
      // at all" (hidden tab); on a non-DOM host with no clock at all the
      // counter is undefined and every dirty slice presents, which is the old
      // unthrottled behaviour rather than none.
      const frameSeq = self._dxFrameSeqNow ? self._dxFrameSeqNow() : undefined;
      if (frameSeq === null) return;
      if (frameSeq !== undefined) {
        if (frameSeq === self._dxPresentedSeq) return;
        self._dxPresentedSeq = frameSeq;
      }
      // Don't upload a surface the guest is part-way through writing. Every
      // Lock measured so far is released inside its own frame (Heroes II
      // gameplay: 140 Locks, 140 Unlocks), and the Unlock re-marks dirty, so
      // waiting costs one frame at most. A lock still held several frames
      // later is a retained pointer into what the guest believes is video
      // memory -- present it anyway, which is what real DirectDraw does.
      if (dxLockDepth.size) {
        self._dxLockHeld = (self._dxLockHeld || 0) + 1;
        if (self._dxLockHeld < 3) return;
      } else {
        self._dxLockHeld = 0;
      }
      self._dxDirty = false;
      gdi.presentBestDxOffscreen(true);
    };

    const traceApiNames = (typeof window !== 'undefined' && window.__waTraceApiNames)
      ? window.__waTraceApiNames
      : null;
    let lastTraceApi = false;
    let pendingTraceComApiId = -1;

    // --- Browser-specific overrides ---
    h.log = (ptr, len) => {
      let text = '';
      if (self.verbose || (traceApiNames && traceApiNames.size)) {
        const view = new Uint8Array(self.memory.buffer, ptr, Math.min(len, 256));
        text = new TextDecoder().decode(new Uint8Array(view));
      }
      lastTraceApi = false;
      if (traceApiNames && traceApiNames.size) {
        let apiName = text.replace(/\0.*$/, '');
        if (pendingTraceComApiId >= 0) {
          const resolved = self.apiTable && self.apiTable[pendingTraceComApiId];
          if (resolved && resolved.name) apiName = resolved.name;
          pendingTraceComApiId = -1;
        }
        if (traceApiNames.has(apiName)) {
          lastTraceApi = true;
          let suffix = '';
          const ex = self.instance && self.instance.exports;
          const entry = self.apiTable && self.apiTable.find(item => item.name === apiName);
          if (ex && ex.get_esp && ex.guest_read32 && entry) {
            const raw = [];
            const esp = ex.get_esp() >>> 0;
            for (let i = 0; i < Math.min(entry.nargs || 0, 8); i++) {
              raw.push(ex.guest_read32((esp + 4 + i * 4) >>> 0) >>> 0);
            }
            suffix = `(${raw.map(v => `0x${v.toString(16).padStart(8, '0')}`).join(', ')})`;
            // Browser acceptance tests occasionally need to distinguish two
            // calls whose raw pointers are different but opaque. Keep the
            // normal lightweight trace unchanged; the opt-in detail flag
            // decodes only API-table arguments explicitly typed as LPCSTR.
            if (typeof window !== 'undefined' && window.__waTraceApiDetails &&
                ex.guest_read8 && Array.isArray(entry.args)) {
              const details = [];
              for (let i = 0; i < entry.args.length && i < raw.length; i++) {
                if (entry.args[i] && entry.args[i].type === 'LPCSTR' && raw[i]) {
                  let value = '';
                  for (let j = 0; j < 256; j++) {
                    const ch = ex.guest_read8((raw[i] + j) >>> 0) & 0xFF;
                    if (!ch) break;
                    value += String.fromCharCode(ch);
                  }
                  details.push(`${entry.args[i].name || `arg${i}`}=${JSON.stringify(value)}`);
                }
              }
              if (details.length) suffix += ` ${details.join(' ')}`;
            }
            if (apiName === 'CoCreateInstance' && raw[0]) {
              suffix += ` clsid.d1=0x${(ex.guest_read32(raw[0]) >>> 0).toString(16).padStart(8, '0')}`;
            }
          }
          console.log(`[API] ${apiName}${suffix}`);
        }
      }
      if (self.verbose) {
        console.log('[wine-asm]', text);
        self.logToUI('[wine-asm] ' + text);
      }
    };
    h.log_i32 = (val) => {
      if (((val >>> 0) >>> 16) === 0xC0DE) {
        pendingTraceComApiId = (val >>> 0) & 0xFFFF;
        lastTraceApi = false;
        return;
      }
      if (lastTraceApi) console.log(`  => 0x${(val >>> 0).toString(16)}`);
      if (self.verbose) {
        console.log('[wine-asm] i32:', '0x' + (val >>> 0).toString(16));
        self.logToUI('[wine-asm] i32: 0x' + (val >>> 0).toString(16));
      }
    };
    h.log_eip = (eip) => {
      if (typeof window !== 'undefined' && typeof window.__waProfileEipHit === 'function') {
        window.__waProfileEipHit(eip >>> 0, 0);
      }
    };
    h.get_ticks = () => self._guestTickMs(sharedAudio);
    // Browser-only Open/Save common-dialog hooks. has_dom returns 1 so
    // $create_open_dialog renders the Upload / Download button.
    h.has_dom = () => 1;
    h.pick_file_upload = (dlgHwnd, destDirWa) => {
      // Native <input type="file"> picker. On selection, write the file
      // bytes into the VFS at "<destDir>\<picked.name>", then call the
      // opendlg_refresh_listbox export so WAT repopulates the listbox.
      const destDir = self.readString(destDirWa) || 'C:\\';
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.onchange = async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        const vfs = self._helpCtx && self._helpCtx.vfs;
        if (vfs) {
          const fullPath = destDir.replace(/\\$/, '') + '\\' + file.name;
          vfs.files.set(fullPath.toLowerCase(), { data: buf, attrs: 0x20 });
          console.log(`[upload] wrote ${fullPath} (${buf.length} bytes)`);
        }
        if (self.instance.exports.opendlg_refresh_listbox) {
          self.instance.exports.opendlg_refresh_listbox(dlgHwnd);
          if (self.renderer) self.renderer.invalidate(dlgHwnd);
        }
        document.body.removeChild(input);
      };
      document.body.appendChild(input);
      input.click();
    };
    h.file_download = (pathWa) => {
      const path = self.readString(pathWa);
      if (!path) return;
      const vfs = self._helpCtx && self._helpCtx.vfs;
      if (!vfs) return;
      const entry = vfs.files.get(path.toLowerCase());
      if (!entry) {
        console.log(`[download] no file at ${path}`);
        return;
      }
      const blob = new Blob([entry.data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = path.replace(/^.*\\/, '');
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
      console.log(`[download] ${path} (${entry.data.length} bytes)`);
    };
    // The About dialog is built entirely in WAT by $create_about_dialog
    // (see src/09a-handlers.wat:$handle_ShellAboutA). This host import
    // only logs; matches lib/host-imports.js signature.
    h.shell_about = (dlgHwnd, ownerHwnd, appPtr) => {
      const appName = self.readString(appPtr);
      console.log(`[ShellAbout] dlg=0x${dlgHwnd.toString(16)} owner=0x${ownerHwnd.toString(16)} "${appName}"`);
      self.logToUI(`[ShellAbout] ${appName}`);
      return 1;
    };
    // ShellExecute("open", "wordpad.exe") is a real process launch, not a
    // log line: WRITE.EXE's entire body is that call followed by
    // ExitProcess, so a stub that only returns 33 leaves a blank screen.
    // Resolve the exe against the app registry and boot it as a second
    // guest; anything that is not a registered exe keeps the base behaviour
    // (open http links in a tab, otherwise report success).
    h.shell_execute = (hwnd, opWa, fileWa, paramsWa, dirWa, nShow) => {
      const rawFile = fileWa ? self.readString(fileWa) : '';
      const op = opWa ? self.readString(opWa) : 'open';
      const parsedCommand = parseShellLaunchCommand(
        rawFile, paramsWa ? self.readString(paramsWa) : '', op);
      const file = parsedCommand.file;
      const params = parsedCommand.params;
      const dir = dirWa ? self.readString(dirWa) : '';
      console.log(`[ShellExecute] hwnd=0x${hwnd.toString(16)} op="${op}" file="${file}" params="${params}"`);
      const shell = window.wineShell;
      if (shell && file) {
        // An absolute path names a concrete file on the caller's own
        // filesystem (a CD launcher handing off to the game its installer
        // just wrote); that beats the registered-app basename heuristic,
        // which could resolve "diablo.exe" to a different registered build.
        const vfs = self._helpCtx && self._helpCtx.vfs;
        const launchFile = resolveShellLaunchPath(file, vfs, parsedCommand.isWinExec);
        const absolute = /^[a-z]:\\/i.test(launchFile);
        const launchDir = parsedCommand.isWinExec && vfs &&
          typeof vfs.getCurrentDirectory === 'function' ? vfs.getCurrentDirectory() : dir;
        if (absolute && shell.launchVfsExe && shell.launchVfsExe(launchFile, self, launchDir, params)) {
          self.logToUI(`[ShellExecute] launching ${launchFile} from the caller's filesystem`);
          return 33;
        }
        if (/\.exe$/i.test(file) && shell.launchExe(file)) {
          self.logToUI(`[ShellExecute] launching ${file}`);
          return 33;
        }
        // A path that resolved nowhere is a failure the guest can react to
        // (SE_ERR_FNF). Bare names keep the lenient success return — several
        // apps fire ShellExecute at helpers they can live without.
        if (absolute || parsedCommand.isWinExec) return 2;
      }
      if (/^https?:/i.test(file)) window.open(file, '_blank');
      return parsedCommand.isWinExec ? 2 : 33;
    };
    // The guest asked for the machine to go down (Shut Down Windows dialog,
    // ExitWindowsEx). This is called from inside a guest batch, and the
    // sequence tears every guest down, this one included -- so it is deferred
    // to after the batch returns, and the guest gets to finish its own quit.
    h.exit_windows = (mode) => {
      const names = ['standby', 'shutdown', 'restart', 'logoff'];
      const name = names[mode] || 'unknown';
      console.log(`[ExitWindows] mode=${mode} (${name})`);
      self.logToUI(`[ExitWindows] ${name}`);
      const power = window.wineShutdown;
      if (!power || !power.run) return 0;
      // This instance paints the screens (its GDI is already up) before it
      // is stopped with the rest.
      setTimeout(() => power.run(name, self), 0);
      return 1;
    };
    h.message_box = (hWnd, textPtr, captionPtr, uType) => {
      const text = self.readString(textPtr);
      const caption = self.readString(captionPtr);
      console.log(`[MessageBox] "${caption}": "${text}"`);
      self.logToUI(`[MessageBox] ${caption}: ${text}`);
      return 1;
    };
    h.exit = (code) => {
      console.log('[ExitProcess] code:', code);
      if (!self._inDllInit) {
        self.logToUI('[ExitProcess] code: ' + code);
        self.logToUI('--- Program exited ---');
        self.stop();
      }
    };
    h.create_window = (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = self.readString(titlePtr);
      ctx.recordWindowText(hwnd, title);
      if (self.verbose) console.log(`[CreateWindow] hwnd=0x${hwnd.toString(16)} title="${title}" menu=${menuId} pos=${x},${y} size=${cx}x${cy}`);
      self.logToUI(`[CreateWindow] "${title}"`);
      const ownerInstance = ctx.instance || self.instance;
      if (self.renderer) {
        self.renderer.createWindow(hwnd, style, x, y, cx, cy, title, menuId, ownerInstance, self.memory);
        const win = self.renderer.windows && self.renderer.windows[hwnd];
        if (win) win.processId = self.processId;
      }
      return hwnd;
    };
    h.dialog_loaded = (hwnd, parentHwnd) => {
      if (self.verbose) console.log(`[CreateDialog] hwnd=0x${hwnd.toString(16)} parent=0x${parentHwnd.toString(16)}`);
      const ownerInstance = ctx.instance || self.instance;
      if (self.renderer) {
        self.renderer.createDialog(hwnd, parentHwnd, ownerInstance, self.memory);
        const win = self.renderer.windows && self.renderer.windows[hwnd];
        if (win) win.processId = self.processId;
      }
    };

    h.set_window_text = (hwnd, textPtr) => {
      const text = self.readString(textPtr);
      ctx.recordWindowText(hwnd, text);
      console.log(`[SetWindowText] hwnd=0x${hwnd.toString(16)} "${text}"`);
      if (self.renderer) self.renderer.setWindowText(hwnd, text);
    };
    const installHostMenu = h.set_menu;
    h.set_menu = (hwnd, menuResId) => {
      console.log(`[SetMenu] hwnd=0x${hwnd.toString(16)} menuRes=${menuResId}`);
      installHostMenu(hwnd, menuResId);
    };

    // --- Input ---
    h.check_input = () => {
      if (!self.renderer) return 0;
      const clearInactiveInput = () => {
        self._lastInputEvent = null;
        self.renderer._activeInputEvent = null;
      };
      // Which queued events are this instance's to take. In multi-app mode
      // that is its own hwnd range; otherwise it is any window this WASM
      // instance owns. An event with no hwnd belongs to whoever asks first.
      // The dequeue itself, and the async-key/repaint bookkeeping that has to
      // follow it, live in the renderer (renderer-input.js takeInput) -- this
      // used to be a second transcription of them that had already lost the
      // GetAsyncKeyState press bit.
      const ownerInstance = ctx.instance || self.instance;
      const owns = (self._hwndBase && self._multiApp)
        ? (e) => !e.hwnd || (e.hwnd >= self._hwndBase && e.hwnd < self._hwndBase + 0x10000)
        : (e) => {
          if (!ownerInstance || !e || !e.hwnd) return true;
          const win = self.renderer.windows && self.renderer.windows[e.hwnd];
          return !win || !win.wasm || win.wasm === ownerInstance;
        };
      const evt = self.renderer.takeInput(owns);
      if (!evt) {
        if (self.renderer.inputQueue.length === 0) clearInactiveInput();
        return 0;
      }
      self._lastInputEvent = evt;
      self.renderer._activeInputEvent = evt;
      if (self.guestWorker && evt.type === 'mouse' && evt.msg === 0x0201 && evt.hwnd) {
        self._workerFocusHwnd = evt.hwnd | 0;
      }
      if (evt.msg !== 0x200) {
        self.logToUI('[input] hwnd=0x' + (evt.hwnd >>> 0).toString(16) + ' msg=0x' + evt.msg.toString(16) + ' wParam=0x' + evt.wParam.toString(16));
      }
      return (evt.wParam << 16) | (evt.msg & 0xFFFF);
    };
    h.check_input_lparam = () => {
      return self._lastInputEvent ? (self._lastInputEvent.lParam | 0) : 0;
    };
    h.check_input_wparam = () => {
      return self._lastInputEvent ? (self._lastInputEvent.wParam | 0) : 0;
    };
    h.check_input_hwnd = () => {
      const evt = self._lastInputEvent;
      if (!evt) return 0;
      const ownerInstance = ctx.instance || self.instance;
      // The routing rule itself is shared with the CLI (lib/host-window.js).
      // In browser Worker mode the local instance is deliberately idle and
      // its per-instance focus global remains zero. Use the focus published by
      // slot 0 so queued WM_KEYDOWN/WM_CHAR/WM_KEYUP reach native EDIT children.
      const routingExports = self.guestWorker
        ? { get_focus_hwnd: () => self._workerFocusHwnd | 0 }
        : (self.instance && self.instance.exports);
      const keyboardFallback = self.guestWorker ? () => {
        const renderer = self.renderer;
        const windows = Object.values((renderer && renderer.windows) || {})
          .filter(win => win && win.visible && !win.isChild &&
            (!win.wasm || win.wasm === ownerInstance))
          .sort((a, b) => renderer && renderer._compareTopLevelZ
            ? renderer._compareTopLevelZ(b, a)
            : ((b.zOrder || 0) - (a.zOrder || 0)));
        return windows.length ? (windows[0].hwnd | 0) : 0;
      } : null;
      return inputEventHwnd(evt, routingExports, null, keyboardFallback);
    };

    // Wire thread/event imports to ThreadManager
    h.create_thread = (s, p, sz, flags, threadIdWa, creatorTid) => self.threadManager
      ? self.threadManager.createThread(s, p, sz, flags, threadIdWa, creatorTid) : 0;
    h.duplicate_current_thread = (tid) => self.threadManager ? self.threadManager.duplicateCurrentThread(tid) : 0;
    h.suspend_thread = (handle) => self.threadManager ? self.threadManager.suspendThread(handle) : 0xFFFFFFFF;
    h.resume_thread = (handle) => self.threadManager ? self.threadManager.resumeThread(handle) : 0xFFFFFFFF;
    h.get_thread_priority = (handle, tid) => self.threadManager
      ? self.threadManager.getThreadPriority(handle, tid) : 0x7FFFFFFF;
    h.set_thread_priority = (handle, priority, tid) => self.threadManager
      ? self.threadManager.setThreadPriority(handle, priority, tid) : 0;
    h.get_thread_locale = (tid) => self.threadManager
      ? self.threadManager.getThreadLocale(tid) : 0x0409;
    h.set_thread_locale = (locale, tid) => self.threadManager
      ? self.threadManager.setThreadLocale(locale, tid) : 0;
    h.com_initialize_thread = (reserved, flags, tid) => self.threadManager
      ? self.threadManager.initializeComApartment(reserved, flags, tid) : 0x8000FFFF;
    h.com_uninitialize_thread = (tid) => self.threadManager
      ? self.threadManager.uninitializeComApartment(tid) : 0;
    h.exit_thread = (c) => self.threadManager && self.threadManager.exitThread(c);
    h.get_exit_code_thread = (handle) => self.threadManager ? self.threadManager.getExitCodeThread(handle) : 0x103;
    h.terminate_thread = (handle, exitCode) => self.threadManager
      ? self.threadManager.terminateThread(handle, exitCode) : 0;
    const readSyncObjectName = (nameWa, wide) => {
      if (!nameWa) return '';
      if (!(wide & 1)) return self.readString(nameWa);
      const memoryBuffer = self.memory && (self.memory.buffer || self.memory);
      if (!(memoryBuffer instanceof ArrayBuffer) &&
          !(typeof SharedArrayBuffer !== 'undefined' && memoryBuffer instanceof SharedArrayBuffer)) return '';
      const dv = new DataView(memoryBuffer);
      let name = '';
      for (let i = 0; i < 512; i++) {
        const ch = dv.getUint16(nameWa + i * 2, true);
        if (!ch) break;
        name += String.fromCharCode(ch);
      }
      return name;
    };
    const win32ThreadId = () => ((ctx.threadId | 0) + 1) | 0;
    h.create_event = (m, i, nameWa, wide) => {
      if (!self.threadManager) return 0;
      const name = readSyncObjectName(nameWa, wide);
      return (wide & 2)
        ? self.threadManager.createMutex(i, name, win32ThreadId())
        : self.threadManager.createEvent(m, i, name);
    };
    h.open_event = (nameWa, wide) => {
      if (!self.threadManager) return 0;
      const name = readSyncObjectName(nameWa, wide);
      return (wide & 2) ? self.threadManager.openMutex(name) : self.threadManager.openEvent(name);
    };
    h.set_event = (handle) => {
      if (!self.threadManager) return 1;
      const value = handle >>> 0;
      return (value & 0x80000000)
        ? self.threadManager.releaseMutex(value & 0x7fffffff, win32ThreadId())
        : self.threadManager.setEvent(value);
    };
    h.reset_event = (handle) => self.threadManager ? self.threadManager.resetEvent(handle) : 1;
    // The cooperative variant exists to run OTHER guest threads from inside a
    // nested synchronous callback, on this thread. With the worker backend
    // there is nothing to run here — the other threads are already running,
    // somewhere else — and its runSlice would walk thread records that have a
    // Worker where it expects an instance.
    const nestedSyncMessage = () => {
      if (self.threadManager && self.threadManager.backend === 'worker') return false;
      const e = ctx.exports;
      return !!(e && e.get_sync_msg_depth && (e.get_sync_msg_depth() | 0));
    };
    h.wait_single = (handle, t) => {
      if (!self.threadManager) return 0;
      return nestedSyncMessage()
        ? self.threadManager.waitSingleCooperative(handle, t, win32ThreadId())
        : self.threadManager.waitSingle(handle, t, win32ThreadId());
    };
    h.wait_multiple = (n, ha, wa, t) => {
      if (!self.threadManager) return 0;
      return nestedSyncMessage()
        ? self.threadManager.waitMultipleCooperative(n, ha, wa, t, win32ThreadId())
        : self.threadManager.waitMultiple(n, ha, wa, t, win32ThreadId());
    };
    h.cs_pump = () => self.threadManager ? self.threadManager.pumpThreadsOnce() : 0;
    h.create_semaphore = (initial, max) => self.threadManager ? self.threadManager.createSemaphore(initial, max) : 0;
    h.release_semaphore = (handle, count, prev) => self.threadManager ? self.threadManager.releaseSemaphore(handle, count, prev) : 0;

    // Memory is set later in init()
    h.memory = null;

    return { host: h, gdi: base.gdi };
  }

  // Every non-mousemove input event, every CreateWindow/SetWindowText and the
  // per-slice heartbeat come through here. `el.textContent += msg` re-serializes
  // the entire accumulated log and forces a layout on each call, so a long
  // session got steadily slower at exactly the moments the user was interacting.
  // Appending a text node is O(1), and the ring keeps the DOM bounded.
  logToUI(msg) {
    if (typeof window !== 'undefined' && window.WINE_RUNTIME_LOGGING === false) return;
    console.log(msg);
    const el = document.getElementById('log');
    if (!el) return;
    el.appendChild(document.createTextNode(msg + '\n'));
    const MAX_LOG_NODES = 2000;
    while (el.childNodes.length > MAX_LOG_NODES) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  async ensureUiFontsReady() {
    if (typeof document === 'undefined' || !document.fonts || !document.fonts.load) return;
    const loads = [
      document.fonts.load('11px "W95FA"'),
      document.fonts.load('bold 11px "W95FA"'),
      document.fonts.load('12px "W95FA"'),
    ];
    if (document.fonts.ready) loads.push(document.fonts.ready);
    try {
      await Promise.race([
        Promise.all(loads),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    } catch (_) {}
  }

  async init(canvas) {
    const compileEl = typeof document !== 'undefined' && document.getElementById('compile-status');
    let showTimeout = null;
    const cacheWarm = !!WineAssembly._wasmModulePromise;
    if (compileEl && !cacheWarm) {
      showTimeout = setTimeout(() => {
        compileEl.style.display = 'block';
      }, 100);
    }
    const fontsReady = this.ensureUiFontsReady();
    const wasmReady = WineAssembly.getWasmModule();
    const apiTableReady = !this.apiTable ? (async () => {
      try {
        const r = await fetch(`src/api_table.json?v=${WineAssembly.SOURCE_VERSION}`);
        this.apiTable = await r.json();
      } catch (e) {
        console.warn('[host] failed to load api_table.json:', e);
        this.apiTable = [];
      }
    })() : Promise.resolve();
    const [, wasmModule] = await Promise.all([fontsReady, wasmReady, apiTableReady]);
    if (showTimeout) clearTimeout(showTimeout);
    if (compileEl) compileEl.style.display = 'none';
    // Load api_table.json so resolve_ordinal can map ordinal imports (e.g.
    // COMCTL32#17 -> InitCommonControls) to real handler IDs. Without this
    // every ordinal call crashes as "<ord> unimplemented".
    const imports = this.getImports();

    // Make deterministic Wine/ANAKRON bitmap stock fonts available before
    // guest code can issue its first GDI text call. WAT installs each FON lazily.
    await this.loadFiles([
      {
        url: 'fonts/System.fon',
        vfsPath: 'c:\\windows\\fonts\\system.fon',
      },
      {
        url: 'fonts/MSSansSerif.fon',
        vfsPath: 'c:\\windows\\fonts\\mssansserif.fon',
      },
      {
        url: 'fonts/Fixedsys.fon',
        vfsPath: 'c:\\windows\\fonts\\fixedsys.fon',
      },
      {
        url: 'fonts/Courier.fon',
        vfsPath: 'c:\\windows\\fonts\\courier.fon',
      },
      {
        url: 'fonts/Terminal.fon',
        vfsPath: 'c:\\windows\\fonts\\terminal.fon',
      },
    ], { required: true });

    // Scalable faces mount under the filenames a real C:\WINDOWS\FONTS had, so
    // WAT opens ARIAL.TTF the way Win98 GDI did and never learns that
    // Liberation Sans is what answers. Without these the WAT TrueType
    // rasterizer has nothing to rasterize and every scalable face silently
    // falls back to Canvas - which still draws text, in whatever the host
    // machine happens to have, at whatever metrics it happens to use.
    await this.loadSubstituteFonts();

    // Create shared memory externally
    this.memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    imports.host.memory = this.memory;
    // Kept so stop() can put it back to null. Every closure in getImports()
    // captures this object, and several of them outlive the app (the audio
    // unlock listener on window, the DX present hook), so `host.memory` is
    // the reference that actually pins the 512MB -- see _releaseGuestMemory.
    this._hostImports = imports.host;

    // THE WASM AND lib/region-map.generated.js ARE ONE MAP IN TWO PLACES.
    // Since wave 3 the bases in both are the region allocator's output, so an
    // artifact built against a different placement than the mirror this page
    // loaded does not fail: every host import reads guest memory at the address
    // the mirror names, the guest wrote it somewhere else, and the app draws a
    // plausible wrong picture. The build stamps the layout fingerprint into a
    // `wine-region-layout` custom section (tools/region-layout-hash.js) for
    // exactly this comparison — the commonest way to get here is a deploy that
    // shipped a rebuilt build/wine-assembly.wasm beside a stale mirror, or the
    // reverse.
    //
    // ABSENT is not a mismatch HERE, and no longer lets `?compile-wat` through
    // unchecked. Worker-compiled bytes carry no section (nothing stamps one
    // there, and hashing in a browser needs crypto.subtle, which plain-http LAN
    // pages do not have), so that path is checked at COMPILE time instead, in
    // _assertSourceBuildLayout, against the placement the Worker sends back
    // with the bytes. What is still reported-and-allowed here is an artifact
    // built before the section landed — refusing those would fail a build that
    // simply predates the check.
    {
      const sections = WebAssembly.Module.customSections(wasmModule, 'wine-region-layout');
      const stamped = sections.length ? new TextDecoder().decode(sections[0]) : null;
      const mirror = (typeof RegionMap !== 'undefined' && RegionMap && RegionMap.LAYOUT_HASH) || null;
      if (stamped && mirror && stamped !== mirror) {
        throw new Error(`[host] region layout MISMATCH: the wasm was built for layout ${stamped}, ` +
          `lib/region-map.generated.js describes ${mirror}. The two halves of the memory map ` +
          `disagree about where the regions are; every host import would read the wrong bytes ` +
          `and the app would draw a plausible wrong picture. Rebuild both ` +
          `(bash tools/build.sh regenerates the mirror and the artifact together).`);
      }
      if (!stamped) {
        console.warn('[host] wasm carries no wine-region-layout section; ' +
          'cannot verify it matches lib/region-map.generated.js');
      }
    }

    this.instance = await WebAssembly.instantiate(wasmModule, imports);
    if (this.instance.exports.set_process_id) {
      this.instance.exports.set_process_id(this.processId);
    }
    // Decode-time superop switches, applied before the first decode. These are
    // per-instance mut globals, so a worker thread has to be told separately
    // (see thread-manager.js) or an A/B measures the folded build on one side.
    if (window.WineSuperops && this.instance.exports.set_rle_run) {
      this.instance.exports.set_rle_run(window.WineSuperops.rleRun === false ? 0 : 1);
    }
    this._wasmModule = wasmModule;
    // Kept so an experimental guest worker can be handed the SAME host import
    // table this instance uses — the point of the broker is that there is one
    // implementation of every host call, not two.
    this._mainImports = imports;
    await this._maybeStartGuestWorker(wasmModule);
    if (this.renderer) {
      this.renderer.wasm = this.instance;
      this.renderer.wasmMemory = this.memory;
      this.renderer.mainWasm = this.instance;
      this.renderer.mainWasmMemory = this.memory;
    }

    // Create ThreadManager
    const self = this;
    const makeWorkerImports = (tid) => {
      const mainCtx = self.hostCtx || self._helpCtx || {};
      const traceApiNames = (typeof window !== 'undefined' && window.__waTraceApiNames)
        ? window.__waTraceApiNames
        : null;
      let workerInstance = null;
      // The filesystem, the LAN wire, the GDI table and the audio device all
      // belong to the process rather than to a thread, and which ones those
      // are is stated once in lib/worker-imports.js so this host and the CLI
      // cannot quietly disagree. The rest of the options are per-thread by
      // nature: this worker's own instance, and its id.
      const wi = self.getImports(Object.assign(processSharedCtx(mainCtx), {
        detached: true,
        instance: () => workerInstance || self.instance,
        exports: () => workerInstance ? workerInstance.exports : self.instance.exports,
        threadId: tid,
      }));
      wi.__setInstance = (instance) => { workerInstance = instance; };
      wi.host.memory = self.memory;
      const markAudioThread = () => {
        if (self.threadManager && self.threadManager.markAudioThread) {
          self.threadManager.markAudioThread(tid, 1500);
        }
      };
      for (const name of [
        'wave_out_open', 'wave_out_write', 'wave_out_schedule_done',
        'wave_out_reset', 'wave_out_close',
        'voice_open', 'voice_write_stream', 'voice_play_ring',
        'voice_stop', 'voice_close',
      ]) {
        const orig = wi.host[name];
        if (typeof orig !== 'function') continue;
        wi.host[name] = (...args) => {
          markAudioThread();
          return orig(...args);
        };
      }
      // Shared decode and the "the return belongs to the call just logged"
      // latch; what stays here is this host's own policy — trace only the
      // names the debug toolbar asked for, and print nothing when it asked for
      // none.
      const workerApiLog = makeWorkerApiLogger({
        getBuffer: () => self.memory.buffer,
        threadId: tid,
        shouldLog: (name) => !!(traceApiNames && traceApiNames.size && traceApiNames.has(name)),
        emit: (line) => console.log(line),
      });
      wi.host.log = workerApiLog.log;
      wi.host.log_i32 = workerApiLog.log_i32;
      wi.host.log_eip = (eip) => {
        if (typeof window !== 'undefined' && typeof window.__waProfileEipHit === 'function') {
          window.__waProfileEipHit(eip >>> 0, tid | 0);
        }
      };
      wi.host.exit = () => {};
      return wi;
    };
    this.threadManager = new ThreadManager(this._wasmModule, this.memory, this.instance, makeWorkerImports, {
      // Opt-in from the debug toolbar. Passing the guest-worker host is what
      // actually switches schedulers: with it, each CreateThread becomes a real
      // Worker; without it (no isolation, CLI, Safari private) ThreadManager runs
      // the cooperative one and says so.
      workerBackend: this.guestWorker || null,
      threadsRequested: !!(typeof window !== 'undefined' && window.WINE_THREADS),
      // So a trapped thread's EIP prints as a module and an offset. In worker
      // mode a DLL's load address depends on load order, so the raw number is
      // different every run and matches nothing in a disassembly.
      describeAddr: (addr) => self.describeAddr(addr),
      // Worker threads take their hwnd slice out of this app's range, so that
      // every window an app owns -- whichever thread put it up -- answers to
      // the one range test that teardown and input routing both use.
      hwndBase: () => self._hwndBase || 0x10001,
      // For servicing a spawned thread's io_wait park (a provider-backed
      // ReadFile off a mounted ISO). Read late: the VFS is attached to the
      // help context after init().
      getVfs: () => (self._helpCtx && self._helpCtx.vfs) || null,
      hasMessage: () => !!(self.renderer && self.renderer.inputQueue && self.renderer.inputQueue.length),
      now: () => self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : Date.now(),
      resolveThreadSendExternalYield: async (link, r) => {
        if (r.yield === 3) await self._handleComDllLoadThreaded(link);
        else if (r.yield === 5) await self._handleLoadLibraryThreaded(link);
        else return false;
        return true;
      },
      onThreadExit: (info) => self._onThreadExit(info),
      profileThreadRun: (info) => {
        if (typeof window !== 'undefined' && typeof window.__waProfileThreadRun === 'function') {
          window.__waProfileThreadRun(info);
        }
      },
    });

    // A room address is a property of this whole process, and the guest reads
    // it the moment it opens a socket, so it has to be in place before the
    // program runs rather than when a connection is attempted.
    if (this.vlanLocalIp && this.instance.exports.set_vlan_local_ip) {
      this.instance.exports.set_vlan_local_ip(this.vlanLocalIp | 0);
    }

    if (canvas && !this.renderer) {
      this.renderer = new Win98Renderer(canvas);
    }
  }

  // Join a virtual LAN room before the guest starts. `wire` is any
  // lib/vlan-wire.js endpoint — a LoopbackWire for two instances in one page,
  // an RtcWire for two people in two browsers. `ip` is this process's address
  // inside the room, as a dotted string.
  //
  // Both have to be set before init(): the wire because host imports capture
  // ctx at instantiate time, the address because the guest may bind a socket
  // on its first slice.
  joinVlan(wire, ip) {
    this.vlanWire = wire || null;
    this.vlanLocalIp = WineAssembly.parseRoomAddress(ip);
    if (this.hostCtx) this.hostCtx.vlanWire = this.vlanWire;
    if (this.instance && this.instance.exports.set_vlan_local_ip) {
      this.instance.exports.set_vlan_local_ip(this.vlanLocalIp | 0);
    }
    return this;
  }

  static parseRoomAddress(ip) {
    const octets = String(ip || '').split('.').map(Number);
    if (octets.length !== 4 || octets.some(o => !(o >= 0 && o <= 255))) {
      throw new Error(`joinVlan: not an IPv4 address: ${ip}`);
    }
    return octets.reduce((a, o) => ((a << 8) | o) >>> 0, 0) | 0;
  }

  static getWasmModule() {
    if (!WineAssembly._wasmModulePromise) {
      const attempt = (WineAssembly._wasmCompileAttempt || 0) + 1;
      WineAssembly._wasmCompileAttempt = attempt;
      const modulePromise = (async () => {
        const tailCalls = WineAssembly.supportsWasmTailCalls();
        console.log(`[host] wasm tail calls ${tailCalls ? 'enabled' : 'not available; using compatibility dispatch'}`);
        // Debug sessions run directly from a changing worktree. A stable
        // production cache key can otherwise leave Safari executing an older
        // WASM artifact after tools/build.sh replaces the file underneath it.
        const debugFetch = typeof location !== 'undefined' &&
          new URLSearchParams(location.search).has('debug');
        const fetchOptions = debugFetch ? { cache: 'no-store' } : undefined;
        const forceSourceCompile = typeof location !== 'undefined' &&
          new URLSearchParams(location.search).has('compile-wat');
        if (!forceSourceCompile) {
          const artifact = tailCalls
            ? 'build/wine-assembly.wasm'
            : 'build/wine-assembly.compat.wasm';
          try {
            const response = await fetch(`${artifact}?v=${WineAssembly.SOURCE_VERSION}`, fetchOptions);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return await WebAssembly.compile(await response.arrayBuffer());
          } catch (error) {
            console.warn(`[host] unable to load ${artifact}; compiling WAT sources`, error);
          }
        }
        // Source compile goes through the WATX compiler Worker — the
        // Milestone 4 wiring from lib/watx-launcher.js's header. The Worker
        // is already terminated when compile() resolves (it does so in a
        // finally), so its heap is gone BEFORE init() allocates the
        // 8192-page shared memory. Do not move this call later.
        //
        // There is no legacy fallback behind it: the in-page
        // compileWatSnapshot path was retired with the M6 symbolization
        // (commit 24b79256) — the src tree now spells region-symbolic
        // operands that lib/compile-wat.js lowers to `unreachable` traps,
        // so that fallback would compile a module that fails validation, or
        // worse, one that traps mid-app.
        if (typeof window !== 'undefined' && window.watxLauncher) {
          // compileDetailed(mode, options): tailCalls is mode; version/noStore
          // are fetch options — in the first argument they are silently ignored
          // and the source fetch loses its ?v= cache-buster. Detailed rather
          // than compile() because the region placement comes back with the
          // bytes and has to be checked; see below.
          const built = await window.watxLauncher.compileDetailed({ tailCalls }, {
            version: WineAssembly.SOURCE_VERSION,
            noStore: debugFetch,
            // Diagnostic/low-memory escape hatch: compile cooperatively on the
            // page thread, yielding between compiler stages and function
            // bodies. The default remains a disposable Worker because it can
            // compute in parallel; both paths dispose their compiler realm
            // before Wine allocates shared memory.
            cooperative: typeof location !== 'undefined' &&
              new URLSearchParams(location.search).has('watx-main-thread'),
          });
          WineAssembly._assertSourceBuildLayout(built.layout);
          return WebAssembly.compile(built.bytes);
        }
        throw new Error('wine-assembly artifacts missing and lib/watx-launcher.js is not ' +
          'loaded (in-page legacy source compilation is retired); run `bash tools/build.sh` ' +
          'to produce build/wine-assembly.wasm, or load lib/watx-launcher.js before host.js ' +
          '(see docs/watx-region-safety-design.md §11)');
      })();
      WineAssembly._wasmModulePromise = modulePromise;
      modulePromise.catch(() => {
        // A transient source update must not poison every later Launch click.
        if (WineAssembly._wasmModulePromise === modulePromise) {
          WineAssembly._wasmModulePromise = null;
        }
      });
    }
    return WineAssembly._wasmModulePromise;
  }

  // ?compile-wat USED TO BE EXEMPT FROM THE MAP CHECK, AND THAT WAS THE WRONG
  // WAY ROUND. The instantiation check below reads a `wine-region-layout`
  // custom section, which only tools/build-compile-wat.js stamps; bytes from
  // the WATX Worker carry none, so `stamped` was null and the host warned and
  // carried on. The exemption landed on the one path where the mismatch is MOST
  // likely: a source build places the regions from whatever src/00-regions.wat
  // says right now, while lib/region-map.generated.js is a committed file that
  // only tools/build.sh regenerates. Editing a region size and hitting reload
  // with ?compile-wat is a two-second round trip that produced a wasm and a
  // mirror describing different maps, and nothing said so — every host import
  // then reads at the mirror's address, the guest wrote at the wasm's, and the
  // app draws a plausible wrong picture rather than failing.
  //
  // It is fixed at the source rather than by relaxing the check: the compile
  // Worker now sends the PLACEMENT back with the bytes. Not a hash of it —
  // hashing needs crypto.subtle, which is undefined outside a secure context,
  // and http://<lan-ip>/?compile-wat is a workflow we use (see the iOS section
  // of CLAUDE.md). Comparing the placement directly is exact, works anywhere,
  // and can name the region that moved.
  //
  // A compiler too old to report regions yields null, which is reported and
  // allowed — same rule as an unstamped artifact.
  static _assertSourceBuildLayout(layout) {
    const mirror = (typeof RegionMap !== 'undefined' && RegionMap && RegionMap.REGIONS) || null;
    if (!layout || !mirror) {
      console.warn('[host] source build did not report its region placement; ' +
        'cannot verify it matches lib/region-map.generated.js');
      return;
    }
    const diffs = [];
    const seen = new Set();
    for (const r of layout) {
      // A span is a transparent named LIMIT containing other regions, owns no
      // bytes and has no mirror entry ($DIRECT_WINDOW). Comparing it would
      // report a missing region on every healthy build.
      if (r.kind === 'span') continue;
      const name = String(r.name).replace(/^\$/, '');
      seen.add(name);
      const m = mirror[name];
      if (!m) { diffs.push(`${name}: compiled at 0x${(r.base >>> 0).toString(16)}, absent from the mirror`); continue; }
      if (m.base !== r.base || m.size !== r.size) {
        diffs.push(`${name}: compiled base 0x${(r.base >>> 0).toString(16)} size 0x${(r.size >>> 0).toString(16)}, ` +
          `mirror base 0x${(m.base >>> 0).toString(16)} size 0x${(m.size >>> 0).toString(16)}`);
      }
    }
    for (const name of Object.keys(mirror)) {
      if (!seen.has(name)) diffs.push(`${name}: in the mirror, not in the compiled map`);
    }
    if (!diffs.length) return;
    const shown = diffs.slice(0, 8).join('\n  ');
    throw new Error(`[host] region layout MISMATCH on a ?compile-wat source build: ` +
      `${diffs.length} region(s) differ between the wasm just compiled from src/00-regions.wat ` +
      `and lib/region-map.generated.js.\n  ${shown}` +
      (diffs.length > 8 ? `\n  ...and ${diffs.length - 8} more` : '') +
      `\nThe two halves of the memory map disagree about where the regions are; every host ` +
      `import would read the wrong bytes and the app would draw a plausible wrong picture. ` +
      `Run \`node tools/gen-region-map.js\` to regenerate the mirror from the declarations ` +
      `(bash tools/build.sh does it too, along with the gate that would have caught this).`);
  }

  static supportsWasmTailCalls() {
    if (WineAssembly._supportsWasmTailCalls !== undefined) {
      return WineAssembly._supportsWasmTailCalls;
    }
    // Minimal module:
    // (module (type (func)) (func (type 0) (return_call 1)) (func (type 0)))
    const probe = new Uint8Array([
      0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
      0x03, 0x03, 0x02, 0x00, 0x00,
      0x0A, 0x09, 0x02, 0x04, 0x00, 0x12, 0x01, 0x0B, 0x02, 0x00, 0x0B,
    ]);
    let ok = false;
    try {
      ok = typeof WebAssembly !== 'undefined' &&
        typeof WebAssembly.validate === 'function' &&
        WebAssembly.validate(probe);
    } catch (_) {
      ok = false;
    }
    WineAssembly._supportsWasmTailCalls = ok;
    return ok;
  }

  _guestToWasmAddress(addr) {
    const ex = this.instance && this.instance.exports;
    if (!ex || !this.memory || !this.memory.buffer || !ex.get_image_base) return -1;
    const imageBase = ex.get_image_base() >>> 0;
    const guestBase = ex.get_guest_base ? (ex.get_guest_base() >>> 0) : 0x12000;
    return (((addr >>> 0) - imageBase + guestBase) >>> 0);
  }

  // The patch table is lib/app-profiles.js, shared with the CLI harness — it
  // used to be a second hand-copy here, so a patch added on one side never
  // reached the other.
  _applyExeCompatibilityPatches(exeName, launchPrefsHook) {
    const profiles = (typeof window !== 'undefined' && window.appProfiles) ||
      (typeof appProfiles !== 'undefined' ? appProfiles : null);
    if (!profiles || !this.instance) return;
    const buffer = this.memory && this.memory.buffer;
    profiles.applyExeCompatibilityPatches(exeName, this.instance.exports, buffer);
    // Screen-size-driven defaults (an app's own resolution setting, say) come
    // from the same table. The canvas is already sized to the viewport by the
    // time an exe loads, so this is the real screen the guest will see.
    if (profiles.applyLaunchPreferences) {
      const canvas = this.renderer && this.renderer.canvas;
      profiles.applyLaunchPreferences(exeName, this.instance.exports, buffer, {
        hook: launchPrefsHook || null,
        screen: canvas ? { width: canvas.width, height: canvas.height } : null,
      });
    }
  }

  // EXPERIMENTAL: run the guest's main thread in a Worker.
  //
  // Only when the page asked for it AND the document is cross-origin isolated,
  // because a shared WebAssembly.Memory cannot reach a Worker otherwise. Any
  // failure here falls back to the normal single-threaded path rather than
  // taking the launch down with it — single-threaded is a supported mode, not a
  // degraded one (docs/design-real-threads.md §3.6).
  async _maybeStartGuestWorker(wasmModule) {
    if (typeof window === 'undefined') return;
    if (!window.WINE_THREADS) return;
    if (!(typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)) {
      this.logToUI('[threads] not cross-origin isolated — running single-threaded');
      return;
    }
    if (typeof GuestThreadHost !== 'function') {
      this.logToUI('[threads] lib/guest-thread-host.js not loaded — running single-threaded');
      return;
    }
    try {
      const res = await fetch('lib/host-import-sigs.generated.json?v=8');
      if (!res.ok) throw new Error(`sigs HTTP ${res.status}`);
      const sigs = (await res.json()).sigs;
      const self = this;
      const worker = new GuestThreadHost({
        memory: this.memory,
        module: wasmModule,
        sigs,
        hostImports: this._mainImports.host,
        workerUrl: 'lib/guest-worker.js?v=18',
        forwardGlLogs: !!this.verbose || !!(window.__waTraceApiNames && window.__waTraceApiNames.size),
        d3dRenderWorker: window.WINE_D3D_RENDER_WORKER === true,
        log: msg => { console.log(msg); self.logToUI(msg); },
        tickMs: () => self._guestTickMs(self.hostCtx && self.hostCtx.sharedAudio),
        advanceGuestTime: ms => {
          self._advanceGuestTickMs(ms, self.hostCtx && self.hostCtx.sharedAudio);
          return self._guestTickMs(self.hostCtx && self.hostCtx.sharedAudio);
        },
      });
      await worker.start();
      this.guestWorker = worker;
      // Renderer windows still retain the browser-side WebAssembly.Instance
      // as their ownership token. Mark that token so keyboard handling queues
      // messages for slot 0 instead of calling exports on the idle instance.
      if (!this.renderer._guestWorkerWasms) this.renderer._guestWorkerWasms = new WeakSet();
      this.renderer._guestWorkerWasms.add(this.instance);
      this.logToUI('[threads] guest main thread is running in a Worker (experimental)');
    } catch (err) {
      this.guestWorker = null;
      this.logToUI(`[threads] worker start failed (${err.message}) — running single-threaded`);
    }
  }

  // `opts.win16Modules` names NE DLLs the task loads by name at runtime rather
  // than importing — see the win16StageModule host import.
  // `opts.launchPrefs` is the app entry's own screen-size → byte-pokes function
  // (lib/apps.js), applied right after load_pe.
  async loadExe(url, opts = {}) {
    if (!this.instance) await this.init();
    this._win16ExtraModules = opts.win16Modules || [];

    // `opts.bytes` is the imported-media path (docs/design-byo-media.md): the
    // program came off a dropped zip/ISO or out of the OPFS library, so there
    // is no URL to fetch and `url` is only the name the guest should see for
    // itself. Everything below treats the two identically.
    const exeBytes = opts.bytes || await WineAssembly.fetchAssetBytes(url);
    this._exeBytes = exeBytes;

    // Resource parsing lives in WAT ($find_resource, $dlg_load,
    // $menu_load, $string_load_a, $rsrc_find_data_wa). The JS side no
    // longer pre-parses anything from the EXE bytes.

    // Load PE. In worker mode the guest instance lives in the Worker, so the
    // loader runs there — the bytes are already in shared memory, only the call
    // is marshalled. The idle main-thread instance is then brought up with the
    // same PE metadata via init_thread, because a handful of host-import paths
    // read image_base off it (SEH and callstack formatting) and would otherwise
    // translate every guest address against zero.
    const exeName = url.replace(/^.*[\\\/]/, '');
    this._exeName = exeName;
    this._exeUrl = url;
    if (opts.args) this._extraArgs = opts.args;

    let entry;
    if (this.guestWorker) {
      entry = await this.guestWorker.loadPe(
        exeBytes, exeName, this.processId, { extraArgs: this._extraArgs || '' });
      const meta = await this.guestWorker.readExports([
        'get_image_base', 'get_code_start', 'get_code_end',
        'get_thunk_base', 'get_thunk_end', 'get_num_thunks',
      ]);
      if (this.instance.exports.init_thread && meta.get_image_base) {
        // tid 7 is the last worker slot; this instance never executes guest
        // code, so its decoded-cache partition is irrelevant — only its globals
        // matter.
        this.instance.exports.init_thread(7, meta.get_image_base, meta.get_code_start,
          meta.get_code_end, meta.get_thunk_base, meta.get_thunk_end, meta.get_num_thunks);
      }
    } else {
      ProcessBoot.setExeName(this.instance.exports, this.memory.buffer, exeName);
      if (this._extraArgs) {
        ProcessBoot.setExtraCmdline(this.instance.exports, this.memory.buffer, this._extraArgs);
      }
      // The staging clamp and its reasoning live in lib/process-boot.js,
      // shared with the CLI harness.
      ({ entry } = ProcessBoot.stageAndLoadPe(
        this.instance.exports, this.memory.buffer, exeBytes));
    }

    this._applyExeCompatibilityPatches(exeName, opts.launchPrefs);

    // A 16-bit task's DLLs go into the same selector arena its own segments
    // just went into, so this has to follow load_pe and precede its first call
    // into one.
    await this._loadWin16Dlls(url, exeBytes);

    // Initialize DirectX COM vtable thunks (must be after load_pe sets image_base).
    if (this.instance.exports.init_dx_com_thunks) {
      this.instance.exports.init_dx_com_thunks();
    }

    if (this._helpCtx && this._helpCtx.vfs) {
      VfsSeed.seedExeImage(this._helpCtx.vfs, exeBytes, exeName);
    }
    if (this.guestWorker) {
      ProcessBoot.setExeName(this.instance.exports, this.memory.buffer, exeName);
    }

    return entry;
  }

  // Fetch and load the NE DLLs a 16-bit task can ask for. loadWin16Dlls reads
  // files synchronously, so every candidate is fetched first and answered out
  // of a map; a name that 404s is simply absent, exactly as a missing file is
  // for the CLI. Hearts loads CARDS through LoadLibrary rather than importing
  // it, so this cannot be driven by the module-reference table.
  async _loadWin16Dlls(url, exeBytes) {
    const _loadWin16Dlls = (typeof DllLoader !== 'undefined' && DllLoader.loadWin16Dlls) || null;
    const _stageable = (typeof DllLoader !== 'undefined' && DllLoader.win16StageableModules) || null;
    if (!_loadWin16Dlls || !_stageable) return;
    const exports = this.instance.exports;
    if (this.guestWorker) {
      const state = await this.guestWorker.readExports(['is_win16']);
      if (!state.is_win16) return;
    } else if (!exports.load_ne_dll || !exports.is_win16 || !exports.is_win16()) {
      return;
    }

    const dir = url.replace(/[^\\\/]*$/, '');
    const files = new Map();
    const vfs = this._helpCtx && this._helpCtx.vfs;
    const mountedDir = /^[a-z]:[\\\/]/i.test(dir)
      ? dir.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '')
      : null;
    // Imported folders/discs have no HTTP directory to probe. Discover the
    // app-local NE modules beside the selected executable directly from the
    // already-mounted BYOM VFS; resource-only DLLs (notably Civ II's artwork
    // packs) do not appear in the executable's import table.
    const mountedExtras = [];
    if (vfs && mountedDir) {
      for (const path of vfs.files.keys()) {
        const slash = path.lastIndexOf('\\');
        if (slash < 0 || path.slice(0, slash) !== mountedDir) continue;
        const leaf = path.slice(slash + 1);
        if (/\.(?:dll|vbx)$/i.test(leaf)) mountedExtras.push(leaf.replace(/\.[^.]+$/, ''));
      }
    }
    const extraNames = [...new Set([...(this._win16ExtraModules || []), ...mountedExtras])];
    this._win16ExtraModules = extraNames;
    const candidates = [...new Set([...(_stageable(exeBytes) || []),
                                    ...extraNames])];
    await Promise.all(candidates.flatMap(name =>
      VfsSeed.win16FileCandidates(name).map(async file => {
        if (files.has(name)) return;
        if (vfs && mountedDir) {
          const mountedPath = mountedDir + '\\' + file.toLowerCase();
          if (vfs.files.has(mountedPath)) {
            try {
              const bytes = await vfs.materialize(mountedPath);
              if (!files.has(name)) files.set(name, bytes);
              return;
            } catch (_) { /* fall through to the ordinary URL lookup */ }
          }
        }
        try {
          const bytes = await WineAssembly.fetchAssetBytes(dir + file);
          if (!files.has(name)) files.set(name, bytes);
        } catch (_) { /* absent is a valid answer */ }
      })));
    // Keyed uppercase, because the name a LoadLibrary arrives with is whatever
    // the app typed and the name fetched here is whatever the registry says.
    this._win16Modules = new Map(
      [...files].map(([name, bytes]) => [name.toUpperCase(), bytes]));

    if (this.guestWorker) {
      const result = await this.guestWorker.loadWin16Dlls(
        exeBytes, [...files], extraNames);
      for (const line of (result && result.lines) || []) console.log(line);
    } else {
      _loadWin16Dlls(exports, this.memory, exeBytes, dir,
        (_dir, name) => files.get(name) || null, (m) => console.log(m),
        extraNames);
    }
  }

  // Answer a 16-bit LoadLibrary for a module nothing imported, out of what
  // _loadWin16Dlls fetched. False is a LoadLibrary failure, not an error.
  _stageWin16Module(name, id) {
    const bytes = this._win16Modules && this._win16Modules.get(String(name).toUpperCase());
    const exports = this.instance && this.instance.exports;
    if (!bytes || !exports || !exports.win16_dll_staging) return false;
    const room = exports.win16_app_dll_staging_size
      ? exports.win16_app_dll_staging_size()
      : 0x00100000;
    if (bytes.length > room) return false;
    const base = exports.win16_dll_staging(id);
    const memory = new Uint8Array(this.memory.buffer);
    memory.fill(0, base, base + room);
    memory.set(bytes, base);
    return true;
  }

  // Mount every vendored open font at the Win98 filename it substitutes.
  // fonts/substitutions.json is the same map the CLI harness and the WAT face
  // table read, so the browser cannot end up offering a different set of faces
  // than the tests cover.
  //
  // Deliberately not `required`: a font that fails to fetch costs that one
  // face its exact metrics and drops it to the Canvas fallback, which is a
  // much better outcome than refusing to launch the app.
  async loadSubstituteFonts() {
    if (this._substituteFontsLoaded) return;
    this._substituteFontsLoaded = true;
    const fontMounts = (typeof window !== 'undefined' && window.fontMounts) || null;
    if (!fontMounts) return;
    let manifest;
    try {
      const response = await fetch('fonts/substitutions.json?v=1');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = await response.json();
    } catch (err) {
      console.warn('font substitutions unavailable, scalable text falls back ' +
        'to Canvas:', err);
      return;
    }
    await this.loadFiles(fontMounts(manifest, { subset: true }).map(mount => ({
      url: 'fonts/' + mount.file,
      vfsPath: mount.vfsPath,
    })), { required: false });
  }

  async _decodeMountedImage(data, url) {
    if (typeof document === 'undefined') return null;
    const lower = String(url || '').toLowerCase();
    const type = lower.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const blob = new Blob([data], { type });
    if (typeof createImageBitmap === 'function') {
      const source = await createImageBitmap(blob);
      return { width: source.width, height: source.height, source };
    }

    // Safari versions without createImageBitmap still decode through the
    // native HTML image pipeline. Materialize RGBA before revoking the blob
    // URL so the synchronous DirectAnimation host call owns stable pixels.
    const objectUrl = URL.createObjectURL(blob);
    try {
      const source = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`failed to decode image: ${url}`));
        image.src = objectUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = source.naturalWidth || source.width;
      canvas.height = source.naturalHeight || source.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(source, 0, 0);
      const rgba = new Uint8Array(context.getImageData(
        0, 0, canvas.width, canvas.height).data);
      return { width: canvas.width, height: canvas.height, rgba };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async loadFiles(urls, options = {}) {
    const vfs = this._helpCtx && this._helpCtx.vfs;
    if (!vfs) return;
    const concurrency = Math.max(1, options.concurrency || 6);
    let loaded = 0, failed = 0, next = 0;
    const total = urls.length;
    const loadOne = async (item) => {
      // Accept plain string (flat -> c:\basename), {url, vfsPath}, or
      // {url, vfsPaths} when one fetched file needs multiple Win32 aliases.
      const url = (typeof item === 'string') ? item : item.url;
      const explicit = (typeof item === 'object') ? item.vfsPath : null;
      const explicitPaths = (typeof item === 'object' && Array.isArray(item.vfsPaths)) ? item.vfsPaths : null;
      try {
        const data = await WineAssembly.fetchAssetBytes(url);
        const decodedImage = (typeof item === 'object' && item.decodeImage)
          ? await this._decodeMountedImage(data, url)
          : null;
        const addFile = (rawPath) => {
          let vfsPath = String(rawPath).toLowerCase().replace(/\//g, '\\');
          if (!/^[a-z]:/.test(vfsPath)) vfsPath = 'c:\\' + vfsPath.replace(/^\\+/, '');
          // Also register the drive root and every parent directory so CD
          // scans can chdir to D:\ and GetFileAttributes(dir) sees directories.
          vfs.ensureParentDirs(vfsPath);
          vfs.files.set(vfsPath, { data, attrs: 0x20, decodedImage });
        };
        if (explicitPaths && explicitPaths.length) {
          for (const p of explicitPaths) addFile(p);
        } else if (explicit) {
          addFile(explicit);
        } else {
          addFile('c:\\' + url.replace(/^.*[\\\/]/, '').toLowerCase());
        }
        // A font an app ships was put in the Windows font directory by its
        // installer on a real machine, and that is the only reason an app
        // like Age of Empires can name "Copperplate Gothic Light" without
        // ever calling AddFontResource. Mount it there too, and let it win
        // over a vendored substitute already at that name: the app ships the
        // real face its artwork was laid out against, so its ARIAL.TTF beats
        // Liberation Sans standing in for one. Text stays identical on every
        // machine either way - the bytes come from the app, not the host.
        const base = url.replace(/^.*[\\\/]/, '').toLowerCase();
        if (/\.(ttf|ttc|fon)$/.test(base)) {
          addFile('c:\\windows\\fonts\\' + base);
        }
        loaded++;
      } catch (_) {
        failed++;
      } finally {
        if (options.onProgress) options.onProgress({ loaded, failed, total, url });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, total) }, async () => {
      while (next < total) {
        const item = urls[next++];
        await loadOne(item);
      }
    });
    await Promise.all(workers);
    if (failed && options.required) {
      throw new Error(`failed to load ${failed} of ${total} data files`);
    }
  }

  async loadDlls(dllPaths) {
    if (!this.instance) return;
    const _loadDlls = (typeof DllLoader !== 'undefined' && DllLoader.loadDlls) || (typeof loadDlls === 'function' && loadDlls);
    if (!_loadDlls) return;
    // dllPaths can be strings (URLs) or {name, bytes} objects
    const rememberDllBytes = (name, bytes) => {
      if (!name || !bytes) return;
      const key = String(name).toLowerCase();
      this._loadedDllBytesByName = this._loadedDllBytesByName || {};
      this._loadedDllBytesByName[key] = bytes;
      const vfs = this._helpCtx && this._helpCtx.vfs;
      if (typeof processBootApi !== 'undefined' && processBootApi.mountLoadedDllFiles) {
        processBootApi.mountLoadedDllFiles(vfs, [{ name: key, bytes }]);
      } else if (vfs && vfs.files) {
        vfs.files.set('c:\\' + key, { data: bytes, attrs: 0x20 });
        vfs.files.set('c:\\windows\\system\\' + key, { data: bytes, attrs: 0x20 });
      }
    };
    const configs = await Promise.all(dllPaths.map(async item => {
      if (typeof item === 'string') {
        let bytes;
        try {
          bytes = await WineAssembly.fetchAssetBytes(item);
        } catch (_) {
          console.error('Failed to fetch DLL:', item);
          return null;
        }
        const name = item.split('/').pop();
        rememberDllBytes(name, bytes);
        return { name, bytes };
      }
      if (item && item.name && item.bytes) {
        rememberDllBytes(item.name, item.bytes);
      }
      return item;
    }));
    const readyConfigs = configs.filter(Boolean);
    const exeBytes = this._exeBytes;
    this._inDllInit = true;
    const opts = {};
    if (this._exeName) opts.exeName = this._exeName;
    if (this._extraArgs) opts.extraArgs = this._extraArgs;
    opts.registerDllResources = (dllConfigs, dllResults) => {
      for (let i = 0; i < dllConfigs.length && i < dllResults.length; i++) {
        this._registerDllBitmapResources(dllConfigs[i].name, dllConfigs[i].bytes, dllResults[i].loadAddr);
      }
    };
    let results;
    if (this.guestWorker) {
      // Guest execution (DllMain runs) must happen on the thread that owns the
      // instance. registerDllResources stays here: it is host bookkeeping over
      // bytes this thread already has.
      const register = opts.registerDllResources;
      delete opts.registerDllResources;
      results = await this.guestWorker.loadDlls(readyConfigs, exeBytes, opts);
      if (register) register(readyConfigs, results);
    } else {
      opts.advanceGuestTime = ms => this._advanceGuestTickMs(ms,
        this.hostCtx && this.hostCtx.sharedAudio);
      results = _loadDlls(this.instance.exports, this.memory.buffer, exeBytes, readyConfigs, console.log, opts);
    }
    // Cooperative threads get their DLL set (and the DllMain entry caller) from
    // here; the worker backend loads them inside each worker instead.
    if (this.threadManager && this.threadManager.setLoadedDlls) {
      const entryCaller = (typeof DllLoader !== 'undefined' && DllLoader.callDllMain) || null;
      this.threadManager.setLoadedDlls(results, entryCaller);
    }
    this._inDllInit = false;
    this.running = true;
  }

  // Where a DLL the guest asks for at runtime comes from in the browser: the
  // VFS the app mounted, whatever was already fetched for it, then the served
  // directories. The CLI answers the same question against the filesystem —
  // the yield pumps themselves are shared (lib/process-boot.js).
  async _findDllBytes(fileName, fullName, { exeDir = false, vfsPaths = null } = {}) {
    const ctx = this._helpCtx;
    if (ctx && ctx.readFile) {
      const fromVfs = ctx.readFile(fullName);
      if (fromVfs) return fromVfs;
    }
    if (ctx && ctx.vfs && vfsPaths) {
      for (const vp of vfsPaths) {
        const entry = ctx.vfs.files.get(vp);
        if (entry && entry.data) return entry.data;
      }
    }
    if (this._loadedDllBytesByName && this._loadedDllBytesByName[fileName]) {
      return this._loadedDllBytesByName[fileName];
    }
    const dir = exeDir && this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
    const paths = [
      dir ? dir + fileName : '',
      `binaries/dlls/${fileName}`,
      `binaries/plugins/${fileName}`,
      `dlls/${fileName}`,
    ].filter(Boolean);
    for (const p of paths) {
      try {
        return await WineAssembly.fetchAssetBytes(p);
      } catch (_) {}
    }
    return null;
  }

  async handleComDllLoad() {
    await ProcessBoot.handleComDllYield({
      exports: this.instance.exports,
      memoryBuffer: this.memory.buffer,
      exeBytes: this._exeBytes || null,
      resourceHost: this,
      log: console.log,
      advanceGuestTime: ms => this._advanceGuestTickMs(ms,
        this.hostCtx && this.hostCtx.sharedAudio),
      findDll: (fileName, fullName) => this._findDllBytes(fileName, fullName, {
        vfsPaths: [fullName.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName],
      }),
    });
  }

  _registerDllBitmapResources(name, bytes, loadAddr) {
    ProcessBoot.registerDllBitmaps(this, name, bytes, loadAddr, console.log);
  }

  // Call a guest export wherever the guest actually is.
  //
  // Launch-time configuration (set_winver, set_hwnd_base, set_extra_cmdline) is
  // main-side code writing per-instance globals, so in worker mode it has to
  // reach the worker's instance — writing them on the idle main instance looks
  // like it worked and does nothing. That is what made MFC42U refuse to load:
  // set_winver never reached the running guest, so GetVersion still answered
  // Win98 and MFC put up "cannot be loaded on Windows 95".
  //
  // Returns a promise in worker mode and the value directly otherwise; callers
  // at launch time can ignore the difference, since nothing reads the result.
  callGuest(name, ...args) {
    if (this.guestWorker) return this.guestWorker.callExport(name, ...args);
    const fn = this.instance && this.instance.exports[name];
    return typeof fn === 'function' ? fn(...args) : undefined;
  }

  hasGuestExport(name) {
    // Both modes instantiate the same module, so the main instance is a valid
    // oracle for whether an export exists even when the guest runs elsewhere.
    return !!(this.instance && typeof this.instance.exports[name] === 'function');
  }

  // Where a DLL's bytes come from: the VFS, the ones already loaded, or a
  // fetch. Pure host work — no instance involved — so both the single-threaded
  // handler and the worker-mode one use it rather than keeping two copies of a
  // four-candidate path search.
  async _resolveDllBytes(dllName) {
    const fileName = dllName.split('\\').pop().toLowerCase();
    const ctx = this._helpCtx;
    let dllBytes = ctx && ctx.readFile ? ctx.readFile(dllName) : null;
    if (!dllBytes && this._loadedDllBytesByName) {
      dllBytes = this._loadedDllBytesByName[fileName] || null;
    }
    if (!dllBytes) {
      const exeDir = this._exeUrl ? this._exeUrl.replace(/[^\/\\]*$/, '') : '';
      const paths = [
        exeDir ? exeDir + fileName : '',
        `binaries/dlls/${fileName}`,
        `binaries/plugins/${fileName}`,
        `dlls/${fileName}`,
      ].filter(Boolean);
      for (const p of paths) {
        try {
          const resp = await fetch(p);
          if (resp.ok) { dllBytes = new Uint8Array(await resp.arrayBuffer()); break; }
        } catch (_) {}
      }
    }
    return { fileName, dllBytes };
  }

  // Worker-mode LoadLibrary. The split is the same one the design predicted:
  // resolving bytes is host work and happens here; loading the image, patching
  // its imports, running DllMain and resuming the guest are guest work and
  // happen in the worker, because they set EIP/ESP and execute code.
  async _handleLoadLibraryThreaded(targetLink) {
    const gw = this.guestWorker;
    const link = targetLink || gw.link;
    const nameWA = (await link.callExport('get_loadlib_name')) >>> 0;
    let dllName = '';
    if (nameWA) {
      const mem = new Uint8Array(this.memory.buffer);
      for (let i = 0; i < 260 && mem[nameWA + i]; i++) dllName += String.fromCharCode(mem[nameWA + i]);
    }
    const { fileName, dllBytes } = dllName ? await this._resolveDllBytes(dllName) : { fileName: '', dllBytes: null };
    if (!dllBytes) {
      if (fileName) console.error(`[LoadLibrary] DLL not found: ${fileName}`);
      await gw.loadLibrary(null, fileName, link);
      return;
    }
    const res = await gw.loadLibrary(dllBytes, fileName, link);
    if (res && res.loadAddr) {
      console.log(`[LoadLibrary] ${fileName} loaded at 0x${(res.loadAddr >>> 0).toString(16)} (worker)`);
      this.registerModule(fileName, res.loadAddr);
      this._registerDllBitmapResources(fileName, dllBytes, res.loadAddr);
    }
  }

  // Remember where an image landed, and resolve an address back to it.
  // Nearest base at or below the address wins: the table has no sizes, and an
  // address inside a module is always above its base and below the next one's.
  // Answering with the wrong module is still better than answering with a bare
  // number, and being explicit about that is the point of the name it prints.
  registerModule(name, base) {
    if (!name || !base) return;
    this.moduleMap.push({ name, base: base >>> 0 });
    this.moduleMap.sort((a, b) => a.base - b.base);
  }

  describeAddr(addr) {
    const a = addr >>> 0;
    const hex = `0x${a.toString(16)}`;
    let best = null;
    for (const m of this.moduleMap) {
      if (m.base <= a && (!best || m.base > best.base)) best = m;
    }
    return best ? `${hex} (${best.name}+0x${(a - best.base).toString(16)})` : hex;
  }

  // Worker-mode COM server load (yield reason 3). Same split as LoadLibrary:
  // the name and bytes are resolved here, the image load, DllMain and the guest
  // resume happen in the worker.
  //
  // The COM search order is not LoadLibrary's — a class's server is looked up by
  // bare filename in the DLL and plugin directories — so this resolves its own
  // candidates rather than sharing _resolveDllBytes.
  async _handleComDllLoadThreaded(targetLink) {
    const gw = this.guestWorker;
    const link = targetLink || gw.link;
    const nameWA = (await link.callExport('get_com_dll_name')) >>> 0;
    if (!nameWA) {
      console.error('COM yield but no pending DLL name');
      await link.callExport('clear_yield');
      return;
    }
    const mem = new Uint8Array(this.memory.buffer);
    let dllName = '';
    for (let i = 0; i < 260 && mem[nameWA + i]; i++) dllName += String.fromCharCode(mem[nameWA + i]);
    const fileName = dllName.split('\\').pop().toLowerCase();
    console.log(`[COM] Loading DLL: ${fileName} (worker)`);

    let dllBytes = null;
    for (const p of [`binaries/dlls/${fileName}`, `binaries/plugins/${fileName}`, `dlls/${fileName}`]) {
      try {
        const resp = await fetch(p);
        if (resp.ok) { dllBytes = new Uint8Array(await resp.arrayBuffer()); break; }
      } catch (_) {}
    }
    if (!dllBytes && this._helpCtx && this._helpCtx.vfs) {
      const vfs = this._helpCtx.vfs;
      for (const vp of [dllName.toLowerCase(), 'c:\\' + fileName, 'c:\\plugins\\' + fileName]) {
        const entry = vfs.files.get(vp);
        if (entry && entry.data) { dllBytes = entry.data; break; }
      }
    }
    if (!dllBytes) {
      console.error(`[COM] Failed to fetch DLL: ${fileName}`);
      await gw.comLoadDll(null, fileName, null, link);
      return;
    }
    const res = await gw.comLoadDll(dllBytes, fileName, this._exeBytes || null, link);
    if (res && res.error) console.error('[COM] DLL load error:', res.error);
    else if (res) console.log(`[COM] DLL loaded at 0x${(res.loadAddr >>> 0).toString(16)} (worker)`);
  }

  async handleLoadLibrary() {
    await ProcessBoot.handleLoadLibraryYield({
      exports: this.instance.exports,
      memoryBuffer: this.memory.buffer,
      resourceHost: this,
      log: console.log,
      advanceGuestTime: ms => this._advanceGuestTickMs(ms,
        this.hostCtx && this.hostCtx.sharedAudio),
      findDll: (fileName, fullName) => this._findDllBytes(fileName, fullName, { exeDir: true }),
    });
  }

  // A cooperative CreateThread owns a separate WASM instance but shares this
  // browser turn. Its LoadLibrary yield cannot be serviced inside runSlice:
  // resolving bytes is asynchronous, so do the same host work the CLI does
  // after the scheduler hands control back. Without this, NSIS finishes most
  // of Winamp's extraction and then parks forever on its first plug-in DLL.
  async handleCooperativeThreadLoadLibraries() {
    const manager = this.threadManager;
    if (!manager || manager.backend !== 'cooperative' ||
        typeof manager.threadsAwaitingLoadLibrary !== 'function') return 0;
    const waiting = manager.threadsAwaitingLoadLibrary();
    for (const thread of waiting) {
      const exports = thread.instance && thread.instance.exports;
      if (!exports) continue;
      await ProcessBoot.handleLoadLibraryYield({
        exports,
        memoryBuffer: this.memory.buffer,
        resourceHost: this,
        log: console.log,
        advanceGuestTime: ms => this._advanceGuestTickMs(ms,
          this.hostCtx && this.hostCtx.sharedAudio),
        findDll: (fileName, fullName) => this._findDllBytes(fileName, fullName, { exeDir: true }),
      });
      manager.publishWorkerGlobals(exports);
    }
    return waiting.length;
  }

  // Finish (or cancel) a deferred last-window teardown. Called once per run
  // slice: a replacement top-level window cancels it, and the deadline
  // passing without one completes the stop.
  _checkLastWindowStop() {
    if (!this._lastWindowStopAt) return;
    if (!this.renderer || !this._hwndBase) { this._lastWindowStopAt = 0; return; }
    const lo = this._hwndBase;
    const hi = lo + 0x10000;
    const hasTopLevel = Object.values(this.renderer.windows).some(w =>
      w && !w.isChild && w.hwnd >= lo && w.hwnd < hi
    );
    if (hasTopLevel) { this._lastWindowStopAt = 0; return; }
    if (Date.now() < this._lastWindowStopAt) return;
    this._lastWindowStopAt = 0;
    this.stop();
  }

  _removeAppWindows() {
    if (!this.renderer || !this._hwndBase) return;
    const lo = this._hwndBase;
    const hi = lo + 0x10000;
    for (const hwnd of Object.keys(this.renderer.windows)) {
      const h = Number(hwnd);
      if (h >= lo && h < hi) {
        delete this.renderer.windows[hwnd];
      }
    }
  }

  _cleanupAudio() {
    if (this.hostCtx && typeof this.hostCtx.stopAudio === 'function') {
      try { this.hostCtx.stopAudio(); } catch (_) {}
    } else if (this._audioCtx) {
      try {
        if (this._audioCtx.close) this._audioCtx.close();
        else if (this._audioCtx.suspend) this._audioCtx.suspend();
      } catch (_) {}
      this._audioCtx = null;
    }
  }

  // The one teardown. Every way an app can end -- ExitProcess, the run loop
  // finding EIP zero, the last top-level window closing out its grace period,
  // a WASM crash, the shell stopping it -- comes through here, and the order
  // below is the whole of it.
  //
  // It used to be a shared middle with five different tails: three call sites
  // repeated the window removal and then repainted, and two repainted not at
  // all. The repaints were the damaging half, because they ran *after* the
  // shell had already put the page back (onStopped -> onAppRunningChange
  // clears the fullscreen classes), so anything still in renderer.windows at
  // that point could hand the display straight back to a guest that no longer
  // exists -- desktop icons hidden over a blank canvas. The two sites with no
  // repaint had the opposite fault: a crash left the dead app's last frame on
  // screen. Repainting last, once, fixes both.
  stop(options = {}) {
    this.running = false;
    // A pending parked-sleep timeout and the visibilitychange listener both
    // close over this WineHost, and a WineHost owns a 512MB shared memory.
    // Same leak the DX rAF chain had.
    this._cancelDelayedStep();
    this._cancelVblankWait();
    this._frozenUnregister();
    this._pausedStep = null;
    this._hiddenPaused = false;
    this._removeVisibilityPause();
    this._removeInputWake();
    this._stopAudioIdleWatch();
    // Read by every self-rescheduling loop this host owns. `running` cannot
    // do that job: it goes false and true again over a host's life, and a
    // loop that restarted itself on the second launch would be back to
    // holding a dead host forever.
    this._stopped = true;
    this._stopPerfCounterPoll();
    this._cleanupAudio();
    // A deferred last-window teardown has nothing left to finish, and leaving
    // the deadline armed would run this a second time.
    this._lastWindowStopAt = 0;
    if (this.renderer) {
      if (this._rendererInputPendingPublisher && this.renderer._inputPendingPublishers) {
        this.renderer._inputPendingPublishers.delete(this._rendererInputPendingPublisher);
        this._rendererInputPendingPublisher = null;
      }
      if (this._rendererFocusPublisher && this.renderer._guestWorkerFocusPublishers) {
        this.renderer._guestWorkerFocusPublishers.delete(this._rendererFocusPublisher);
        this._rendererFocusPublisher = null;
      }
      if (this._multiApp) {
        this._removeAppWindows();
      } else {
        this.renderer._exited = true;
        this.renderer.windows = {};
      }
    }
    // Notify whether or not `running` was still set. The listener is
    // unregisterRunningApp, which is idempotent, and the guard was costing
    // more than it saved: anything that cleared `running` on its own -- an
    // exit taken inside the run loop, a trap, a second stop() -- swallowed
    // the only notification the shell gets, and its runningApps entry then
    // lived forever. On a phone that is fatal rather than untidy: the
    // renderer has already dropped the guest's windows, so the page is bare
    // teal, the desktop icons stay hidden behind body.app-running, and
    // single-app mode silently refuses every later launch because it still
    // believes something is running. No way out but a reload.
    if (typeof this.onStopped === 'function') {
      try { this.onStopped(this); } catch (_) {}
    }
    // Last, so the frame on screen is the one the shell's clean-up decided on
    // and not one composed from windows this stop was in the middle of
    // dropping. `repaint: false` is for a caller stopping several apps that
    // will repaint once at the end.
    if (options.repaint !== false && this.renderer && this.renderer.repaint) {
      this.renderer.repaint();
    }
    // Deferred by a turn, not because the release is slow, but because most
    // stops come from *inside* a guest slice -- h.exit during a WASM call, a
    // trap, the no-windows-left check -- and the step that called us still has
    // `self.instance.exports.get_eip()` ahead of it on the way out. Dropping
    // the references under it would turn a clean exit into a TypeError.
    //
    // Browser only. The CLI reads the guest's memory and exports *after* the
    // run is over -- --png, --dump, the hit counts and the MMX tally at exit
    // -- and it gets its memory back by exiting the process, so it has
    // nothing to gain here and everything to lose.
    if (typeof window !== 'undefined' && !this._releaseTimer) {
      this._releaseTimer = setTimeout(() => {
        this._releaseTimer = null;
        if (this._stopped) this._releaseGuestMemory();
      }, 0);
    }
  }

  // Every launch commits a 512MB guest memory (`initial === maximum` and
  // `shared`, so it is all resident the moment it is instantiated). Nothing
  // reclaims that unless the WebAssembly.Memory itself becomes unreachable --
  // and the renderer is a page-lifetime singleton that has been handed this
  // host's instance and memory, so closing an app left the whole half gigabyte
  // pinned. Measured in Chrome with forced GC between cycles: launch/close
  // Notepad three times and the page holds 3 live guest memories / 1536MB,
  // while every check the shell makes reads healthy (runningApps 0, no
  // windows, icons visible). On a phone the second or third launch simply
  // fails -- `REJECT Out of memory` -- which is the "can't launch new apps"
  // state, and the only way out is a reload.
  //
  // So drop the references this host owns, and the renderer's four only if
  // they still point at us: a later app has already overwritten them with its
  // own and must not be unwired by a straggling stop().
  _releaseGuestMemory() {
    this._deleteOwnSurfacePresentations();
    const renderer = this.renderer;
    if (renderer) {
      if (renderer.wasm === this.instance) renderer.wasm = null;
      if (renderer.mainWasm === this.instance) renderer.mainWasm = null;
      if (renderer.wasmMemory === this.memory) renderer.wasmMemory = null;
      if (renderer.mainWasmMemory === this.memory) renderer.mainWasmMemory = null;
      // Set by _setKeyboardInputOwner (lib/renderer-input.js) and never
      // cleared: _restoreKeyboardInputOwner only ever replaces it, so with no
      // windows left the last app to hold focus keeps its instance alive.
      if (renderer._keyboardInputWasm === this.instance) renderer._keyboardInputWasm = null;
      if (renderer._keyboardInputMemory === this.memory) renderer._keyboardInputMemory = null;
    }
    // The two paths a heap snapshot actually blamed after everything above
    // was already cleared: window's "unlock" audio listener -> _readVfsFile's
    // scope -> host imports -> .memory, and wineShell.stopAllApps -> a stale
    // WineAssembly -> _presentDxIfDirty -> the same host imports object.
    if (this._hostImports) this._hostImports.memory = null;
    this._hostImports = null;
    // Holds the same memory and instance plus one per worker thread.
    this.threadManager = null;
    this.instance = null;
    this.memory = null;
    this._wasmModule = null;
    // `ctx` closes over `self`, and is handed to worker imports and the help
    // system, both of which outlive the run loop.
    this.hostCtx = null;
    this._helpCtx = null;
  }

  // A guest that exits without deleting its GDI surfaces leaves entries in the
  // shared presentation map, and each one holds a GdiSurface whose `storage`
  // is a Uint8Array over the guest's SharedArrayBuffer -- so one undeleted
  // surface pins the whole 512MB just as surely as the instance does. The map
  // is shared with worker threads and, in multi-app mode, with other apps, so
  // ownership is decided by the only thing that cannot be faked: which memory
  // the surface's storage is a view of.
  _deleteOwnSurfacePresentations() {
    const gdi = this.hostCtx && this.hostCtx.sharedGdi;
    const presentations = gdi && gdi.surfacePresentations;
    const del = this._hostImports && this._hostImports.gdi_surface_delete;
    if (!presentations || typeof del !== 'function' || !this.memory) return;
    const buffer = this.memory.buffer;
    const mine = [];
    for (const [id, presentation] of presentations) {
      const storage = presentation && presentation.surface && presentation.surface.storage;
      if (storage && storage.buffer === buffer) mine.push(id);
    }
    // Deleting detaches window/overlay/desktop surfaces and drops the
    // canvas's _waCanonicalPresentation, which is the other half of the leak.
    for (const id of mine) {
      try { del(id); } catch (_) {}
    }
  }

  _audioSchedulerNow() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  _isAudioHot() {
    const shared = this._sharedAudio || (this.hostCtx && this.hostCtx.sharedAudio);
    if (!shared) return false;
    const hotUntil = Number(shared.waveOutHotUntilMs) || 0;
    return hotUntil > this._audioSchedulerNow();
  }

  // Called once per step from the worker-budget calculation, so it used to
  // build a Set and an array and call a WASM export for every instance, on
  // every step, for the whole session. The instance list only changes when a
  // window is created or destroyed, so cache it and rebuild on a window-count
  // change; the exported call itself is cheap and stays exact.
  _hasOpenMenu() {
    const renderer = this.renderer;
    if (!renderer) return false;
    const windows = renderer.windows || {};
    const count = Object.keys(windows).length;
    if (this._menuWasms === undefined || this._menuWasmsWindowCount !== count ||
        this._menuWasmsInstance !== this.instance) {
      const seen = new Set();
      const wasms = [];
      const add = (wasm) => {
        if (wasm && !seen.has(wasm) && wasm.exports && wasm.exports.menu_open_hwnd) {
          seen.add(wasm);
          wasms.push(wasm);
        }
      };
      add(this.instance);
      add(renderer.wasm);
      add(renderer.mainWasm);
      for (const win of Object.values(windows)) add(win && win.wasm);
      this._menuWasms = wasms;
      this._menuWasmsWindowCount = count;
      this._menuWasmsInstance = this.instance;
    }
    for (const wasm of this._menuWasms) {
      try {
        if ((wasm.exports.menu_open_hwnd() >>> 0) !== 0) return true;
      } catch (_) {}
    }
    return false;
  }

  // Worker-mode run loop. The guest executes inside the Worker, so this loop
  // does nothing but hand out slices and composite. The guest no longer blocks
  // the UI thread, but its completed-slice reply is still the presentation
  // boundary, so long slices are paced and keyboard input can request one early.
  _runThreaded(stepsPerSlice) {
    this.running = true;
    this._frozenRegister();
    const self = this;
    // Worker mode gets the hidden-tab pause and the input wake. It does NOT
    // get the parked sleep: its main thread is one participant in a rendezvous
    // with real Workers, so "the main instance is waiting" does not mean the
    // machine has nothing to run, and the cooperative signal this decision
    // rests on is not the same signal here.
    self._installVisibilityPause();
    self._installInputWake();
    if (self.renderer && self.guestWorker && self.guestWorker.broker &&
        !self._rendererInputPendingPublisher) {
      self._rendererInputPendingPublisher = (depth, wake) => {
        if (wake) {
          self._workerInputBurstSlices = Math.max(
            self._workerInputBurstSlices | 0,
            Math.min(12, Math.max(0, depth | 0) + 4)
          );
        }
        self.guestWorker.broker.publish({
          inputPending: depth | 0,
          inputWake: !!wake,
        });
      };
      if (!self.renderer._inputPendingPublishers) {
        self.renderer._inputPendingPublishers = new Set();
      }
      self.renderer._inputPendingPublishers.add(self._rendererInputPendingPublisher);
    }
    if (self.renderer && self.guestWorker && !self._rendererFocusPublisher) {
      self._rendererFocusPublisher = (wasm, hwnd) => {
        if (wasm !== self.instance) return;
        self._workerPendingFocusHwnd = hwnd | 0;
        self._workerInputBurstSlices = Math.max(self._workerInputBurstSlices | 0, 4);
      };
      if (!self.renderer._guestWorkerFocusPublishers) {
        self.renderer._guestWorkerFocusPublishers = new Set();
      }
      self.renderer._guestWorkerFocusPublishers.add(self._rendererFocusPublisher);
    }
    let unsupportedYield = 0;
    const step = async () => {
      if (!self.running) return;
      if (self._hiddenPaused || self._maybePauseForHidden()) {
        self._pausedStep = step;
        return;
      }
      const perf = (typeof window !== 'undefined' && window.WinePerf && window.WinePerf.enabled)
        ? window.WinePerf : null;
      if (perf) perf.stepBegin();
      try {
        self._beginGuestTickBatch();
        if (self.guestWorker.broker) {
          // The guest's message-wait resume runs inside the worker and needs to
          // know whether the renderer has input queued — that queue is here, so
          // its depth is published rather than asked for.
          const q = self.renderer && self.renderer.inputQueue ? self.renderer.inputQueue.length : 0;
          self.guestWorker.broker.publish({
            tickMs: self._guestTickMs(self.hostCtx && self.hostCtx.sharedAudio),
            inputPending: q,
          });
        }
        const configuredSteps = Math.max(1000, (self.stepsPerSlice | 0) || stepsPerSlice);
        if (self._workerAdaptiveCeiling !== configuredSteps) {
          self._workerAdaptiveCeiling = configuredSteps;
          self._workerAdaptiveSteps = configuredSteps;
        }
        const inputBurstSlice = (self._workerInputBurstSlices | 0) > 0;
        const adaptiveSteps = Math.max(1000,
          Math.min(configuredSteps, self._workerAdaptiveSteps | 0 || configuredSteps));
        const steps = inputBurstSlice ? Math.min(adaptiveSteps, 1000) : adaptiveSteps;
        // The guest's main thread and every thread it created run AT THE SAME
        // TIME — that is the whole of phase 2. Awaiting them together rather
        // than in sequence is what makes it true: each slice() is a message to a
        // different Worker, and none of them needs this thread except to be
        // served a host import.
        const runThreads = () => (self.threadManager && self.threadManager.backend === 'worker'
          ? self.threadManager.runWorkerSlices(steps)
          : 0);
        // The guest's main thread takes part in the same rendezvous its threads
        // do: in worker mode it is not the main INSTANCE, so its thunk
        // allocations are invisible to everyone else unless they are published.
        const sync = self.threadManager ? self.threadManager.workerSyncState() : null;
        const pendingFocus = self._workerPendingFocusHwnd;
        self._workerPendingFocusHwnd = undefined;
        const mainSync = pendingFocus === undefined
          ? sync
          : Object.assign({}, sync || {}, { focusHwnd: pendingFocus | 0 });
        let r, threadsRun;
        if (self.renderer && self.renderer.beginWorkerGuestSlice) {
          self.renderer.beginWorkerGuestSlice();
        }
        try {
          if (typeof window !== 'undefined' && window.WINE_THREADS_SERIAL) {
            // Diagnostic only: the same slices, one at a time. A bug that appears
            // in parallel and not here is a race in shared emulator state, which is
            // a different investigation from a bug in the worker plumbing.
            r = await self.guestWorker.slice(steps, mainSync);
            threadsRun = await runThreads();
          } else {
            [r, threadsRun] = await Promise.all([self.guestWorker.slice(steps, mainSync), runThreads()]);
          }
        } finally {
          if (self.renderer && self.renderer.endWorkerGuestSlice) {
            self.renderer.endWorkerGuestSlice();
          }
        }
        if (inputBurstSlice && self._workerInputBurstSlices > 0) {
          self._workerInputBurstSlices--;
        }
        // Only a slice that actually spent its block budget is a useful speed
        // sample. Waits and INPUT_WAKE return early and must not distort the
        // next normal budget.
        const ranBlocks = r.blocks | 0;
        const ranMs = Number(r.ms) || 0;
        if (!inputBurstSlice && ranBlocks >= steps * 0.75 && ranMs > 0) {
          const measured = Math.round((ranBlocks * 12 / ranMs) / 1000) * 1000;
          self._workerAdaptiveSteps = Math.max(1000, Math.min(configuredSteps, measured));
        }
        self._workerFocusHwnd = r.focusHwnd | 0;
        if (self.threadManager) self.threadManager.publishWorkerThunkState(r);
        if (!self.running) return;
        if (self.threadManager && self.threadManager.netWaitPending) {
          // A thread parked in a blocking socket call. Frames arrive on this
          // thread's event loop, so it has to get a turn before the next slice.
          self.threadManager.netWaitPending = false;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        // How many guest threads got a slice this step. Nothing consumes it yet;
        // it is here because "the threads are live but none of them ran" and "no
        // threads exist" look identical from the outside, and that is the first
        // thing worth knowing when a threaded app goes quiet.
        self.workerThreadsRun = threadsRun | 0;
        if (perf) {
          perf.countSteps(ranBlocks > 0 ? ranBlocks : steps);
          // Off-thread time is reported as thread time, not main time: it did
          // not block this thread, and calling it 'guest' here would make the
          // HUD's phase shares mean something different than in the other mode.
          perf.mark('workers', r.ms || 0);
        }
        if (r.trapped) {
          const g = r.regs || {};
          const hex = v => '0x' + ((v || 0) >>> 0).toString(16);
          self.logToUI(`[threads] guest trapped in worker: ${r.trapped} @ EIP=${hex(r.eip)} `
            + `prev_eip=${hex(g.prevEip)} esp=${hex(g.esp)} eax=${hex(g.eax)} ebx=${hex(g.ebx)} `
            + `ecx=${hex(g.ecx)} edx=${hex(g.edx)} esi=${hex(g.esi)} edi=${hex(g.edi)} ebp=${hex(g.ebp)}`);
          self.stop({ repaint: false });
          return;
        }
        const presentStart = perf ? performance.now() : 0;
        // Worker-hosted DirectDraw calls mark the same browser-side dirty flag
        // as cooperative execution. Flush that frame at the slice boundary
        // before compositing it; otherwise the Worker loop keeps repainting
        // the last uploaded layer forever even while the guest updates the
        // shared primary surface (AoE II's New Player screen is the visible
        // case). Both cooperative scheduler paths do this at their matching
        // boundaries below.
        if (self._presentDxIfDirty) self._presentDxIfDirty();
        if (self.renderer && self.renderer.flushRepaint) self.renderer.flushRepaint(true);
        if (perf) perf.mark('present', performance.now() - presentStart);

        if (!r.eip && !r.yield) {
          self.logToUI('--- Program exited (worker) ---');
          self.stop({ repaint: false });
          return;
        }
        // Every yield the WAT actually raises is handled here: 1 wait, 2 exit
        // (caught above as eip=0), 3 com_load_dll, 5 load_library, 6
        // modal_dialog, 7 message_wait, 8 net_wait, 12 io_wait. Reason 4
        // (help_load) is named in thread-manager.js's map but is never set by
        // any WAT or JS path, so there is nothing to port for it. The fallback
        // below stays as a guard for anything added later.
        if (r.yield === 1) {
          // A parked WaitForSingleObject/WaitForMultipleObjects. This used to
          // just clear the yield and let the guest re-poll, which is wrong in a
          // way that only shows up once a wait can actually be satisfied: $run
          // has already popped the return address, so the guest is past the call
          // with its stdcall arguments still on the stack. Only completing the
          // wait drops them. Clearing instead leaked 12 bytes of guest stack per
          // wait, and Winamp died minutes later at EIP=0xffffffff — which is why
          // nothing caught it before guest threads ran in this mode.
          const done = self.threadManager ? self.threadManager.resolveMainWorkerWait(r) : null;
          if (done) await self.guestWorker.link.completeWait(done.result, done.waitStackBytes);
          // Unsatisfied: leave the yield set. The next slice re-polls, and the
          // worker's run() returns immediately while parked.
        } else if (r.yield === 7) {
          // The message-wait resume runs inside the worker at the top of each
          // slice, where the instance is. Nothing to do here — and specifically
          // not clear_yield, for the same reason as above.
        } else if (r.yield === 3) {
          await self._handleComDllLoadThreaded();
        } else if (r.yield === 5) {
          await self._handleLoadLibraryThreaded();
        } else if (r.yield === 9) {
          // cs_wait: EnterCriticalSection found the section held by another guest
          // thread. Clearing re-enters the same call, and the holder gets its
          // slice in this same round — which is why the WAT must not spin there:
          // the holder may be parked in Atomics.wait for an import only this
          // thread serves.
          //
          // The guest's MAIN thread does not currently park (see
          // $handle_EnterCriticalSection — it nests interpreter runs that cannot
          // be unwound), so this is a safety net rather than a live path. It is
          // kept because the alternative is the catch-all below, which stops the
          // app outright, and that is how this was found.
          await self.guestWorker.callExport('clear_yield');
        } else if (r.yield === 10) {
          await self.guestWorker.resolveThreadSend(self.guestWorker.link, {
            targetTid: r.sendTargetTid | 0,
            hwnd: r.sendHwnd | 0, msg: r.sendMsg | 0,
            wparam: r.sendWparam | 0, lparam: r.sendLparam | 0,
            postKind: r.sendPostKind | 0,
          });
        } else if (r.yield === 8) {
          await self.guestWorker.callExport('clear_yield');
          try { await self.guestWorker.callExport('vlan_pump'); } catch (_) {}
        } else if (r.yield === 12) {
          // io_wait: ReadFile parked on a provider-backed VFS entry (mounted
          // zip/iso, dropped File, remote URL over Range). The brokered fs
          // import already ran here on the main thread, so the pending-read
          // record is ours to fill; clearing the yield re-enters the same call
          // in the worker, which then takes the synchronous cache hit.
          const pvfs = self._helpCtx && self._helpCtx.vfs;
          const pending = pvfs && pvfs.pendingRead;
          if (pending) {
            try { await pvfs.fillPendingRead(pending); }
            catch (e) { self.logToUI(`[io] ${pending.path}: ${e && e.message}`); }
            pvfs.pendingRead = null;
          }
          await self.guestWorker.callExport('clear_yield');
        } else if (r.yield === 14 || r.yield === 15) {
          // A spin park in the worker that carries the guest's MAIN thread.
          // Clearing re-enters the parked call on its next slice. This branch
          // has to exist: the catch-all below stops the app outright, so a
          // busy-wait the detector caught would have ended the session.
          await self.guestWorker.callExport('clear_yield');
        } else if (r.yield === 6) {
          // modal_dialog: the single-threaded loop does nothing special here
          // either — the WAT side drives the dialog — so neither does this.
        } else if (r.yield) {
          if (++unsupportedYield === 1) {
            self.logToUI(`[threads] yield ${r.yield} is not supported in worker mode yet `
              + `(needs its host sequence ported into the worker); stopping.`);
            self.stop({ repaint: false });
            return;
          }
        }
      } catch (err) {
        self.logToUI(`[threads] worker loop failed: ${err.message}`);
        self.stop({ repaint: false });
        return;
      } finally {
        if (perf) perf.stepEnd();
      }
      // Same unclamped scheduling the single-threaded loop uses: a nested
      // setTimeout chain is capped at 4ms once it is five deep, which would
      // hold worker mode to ~250 slices a second no matter how fast a slice is.
      if (self.running) self._scheduleStep(step);
    };
    // Frozen at launch (a ?frozen tile, or the box checked before the app
    // started): park the very first slice instead of running it, so the guest
    // is at instruction zero until an agent steps it.
    if (self._frozen) self._scheduleStep(step, 0); else step();
  }

  // Schedule the next guest slice.
  //
  // This used to be setTimeout(step, 0). Browsers clamp a *nested* timer to
  // >=4ms once the chain is five deep, and this chain never ends — so the
  // drive loop was capped near 250 slices/s no matter how fast a slice ran.
  // With a p50 step of ~2.3ms that left the main thread idle more than half
  // of every cycle. A MessageChannel port posts an unclamped macrotask: it
  // still yields to input and rAF between slices, it just doesn't wait 4ms to
  // do it. setTimeout stays as the fallback for anything without MessageChannel.
  //
  // delayMs > 0 asks for the opposite of all that: the guest is parked with
  // nothing to run, so the next slice should happen when something could have
  // changed, not as fast as the event loop will allow. An idle Notepad used to
  // spend ~95% of a core re-asking has_pending_message 100,000 times a second
  // and being told "no" every time. The cap is deliberate — a wake source we
  // forgot to hook up degrades to 20Hz polling, never to a hang.
  _scheduleStep(step, delayMs = 0) {
    // Every completed step of both drive loops passes through here exactly
    // once, which makes this the only honest "did the guest run" counter the
    // page has. `_runSliceCount` is not one: it is bumped only on the branch
    // where the guest's main thread was runnable, so an app idling in
    // GetMessage retires slices forever without moving it.
    this._stepTicks = (this._stepTicks | 0) + 1;
    // Frozen: the loop stops here. The continuation is held, not scheduled,
    // and `stepFrozen` is the only thing that lets it run. Note this is the
    // ONE seam frozen mode needs — both drive loops (cooperative and worker)
    // reach their next slice through it, so neither is special-cased.
    if (this._frozen) {
      this._cancelDelayedStep();
      this._frozenStep = step;
      this._frozenPump();
      return;
    }
    this._cancelDelayedStep();
    const delay = delayMs > 0 ? Math.min(delayMs, WineAssembly.MAX_PARK_SLEEP_MS) : 0;
    if (delay > 0) {
      this._delayedStep = step;
      this._stepTimeoutId = setTimeout(() => {
        this._stepTimeoutId = 0;
        const fn = this._delayedStep;
        this._delayedStep = null;
        if (fn && this.running) fn();
      }, delay);
      return;
    }
    this._postStep(step);
  }

  // Post the next slice as an unclamped macrotask. Split out of
  // _scheduleStep so frozen mode can dispatch a step without going back
  // through the "should I sleep?" decision it has already overruled.
  _postStep(step) {
    if (this._stepPort === undefined) {
      this._stepPort = null;
      if (typeof MessageChannel === 'function') {
        const chan = new MessageChannel();
        // Keep both ends alive. An entangled sending port does not require the
        // browser to retain an otherwise unreachable listener wrapper; image
        // decode pressure made that listener collectable after a few slices.
        this._stepListenPort = chan.port1;
        this._stepListenPort.onmessage = () => {
          const fn = this._pendingStep;
          this._pendingStep = null;
          if (fn) fn();
        };
        this._stepPort = chan.port2;
      }
    }
    if (this._stepPort) {
      this._pendingStep = step;
      this._stepPort.postMessage(0);
    } else {
      setTimeout(step, 0);
    }
  }

  _cancelDelayedStep() {
    if (this._stepTimeoutId) {
      clearTimeout(this._stepTimeoutId);
      this._stepTimeoutId = 0;
    }
    this._delayedStep = null;
  }

  // ---- frozen (agent-stepped) mode ------------------------------------
  //
  // See the frozenBus block above `class WineAssembly` for what this is and
  // why the clock is part of it. Everything below is per-guest bookkeeping;
  // the page-level switch is `window.WineFrozen`.

  _frozenRegister() {
    this._frozenSteps = this._frozenSteps | 0;
    this._frozenBudget = this._frozenBudget | 0;
    this._frozenWaiters = this._frozenWaiters || [];
    this._frozenTickMs = Number.isFinite(this._frozenTickMs) ? this._frozenTickMs : frozenBus.tickMs;
    frozenBus.hosts.add(this);
    if (frozenBus.enabled) this.setFrozen(true);
  }

  _frozenUnregister() {
    frozenBus.hosts.delete(this);
    // A guest that exited (or crashed) is never coming back for its budget;
    // release anyone waiting on a step rather than making them time out.
    this._frozenBudget = 0;
    this._frozenStep = null;
    this._frozenIdle();
  }

  frozenGuestMs() {
    return this._guestAudioClockMs(this.hostCtx && this.hostCtx.sharedAudio) | 0;
  }

  frozenStatus(extra) {
    let eip = 0;
    try { eip = this.instance && this.instance.exports.get_eip ? this.instance.exports.get_eip() >>> 0 : 0; }
    catch (_) { eip = 0; }
    return Object.assign({
      frozen: !!this._frozen,
      tickMs: this._frozenTickMs | 0,
      steps: this._frozenSteps | 0,
      ticks: this._stepTicks | 0,
      guestMs: this.frozenGuestMs(),
      running: !!this.running,
      eip: '0x' + eip.toString(16).padStart(8, '0'),
    }, extra || {});
  }

  setFrozen(on) {
    const next = !!on;
    this._frozenTickMs = Number.isFinite(this._frozenTickMs) ? this._frozenTickMs : frozenBus.tickMs;
    if (this._frozen === next) return this.frozenStatus();
    this._frozen = next;
    if (next) {
      this._frozenBudget = 0;
      this._frozenWaiters = this._frozenWaiters || [];
      // A slice already in flight finishes and parks at its next
      // _scheduleStep — "finish the current step, then stop". A slice merely
      // *sleeping* (the parked-guest case, which is most of an idle app) has
      // not started yet, so take its continuation now instead of letting one
      // more step land up to 50ms after the freeze.
      if (this._delayedStep) {
        const pending = this._delayedStep;
        this._cancelDelayedStep();
        this._frozenStep = pending;
      }
    } else {
      // Live again. Slide the wall-clock origin forward by the time the guest
      // did not experience, or it gets the whole frozen interval as one jump:
      // every timer instantly overdue, every timeGetTime delta enormous.
      const st = this._guestTickState(this.hostCtx && this.hostCtx.sharedAudio);
      if (st) st.wallStartMs = this._audioSchedulerNow() - (st.batchMs | 0);
      const pending = this._frozenStep;
      this._frozenStep = null;
      this._frozenBudget = 0;
      this._frozenIdle();
      if (pending && this.running) this._scheduleStep(pending, 0);
    }
    return this.frozenStatus();
  }

  // Hand the held continuation one step's worth of budget, or come to rest.
  _frozenPump() {
    const step = this._frozenStep;
    if (!step) return;                       // the run loop has not parked here yet
    if ((this._frozenBudget | 0) <= 0) { this._frozenIdle(); return; }
    this._frozenStep = null;
    this._frozenBudget--;
    // Recording tap. The pixels of step N-1 are settled the moment we are
    // about to run step N, so this samples the finished picture without
    // having to wait on a repaint the run loop may defer forever. Every k-th
    // step, tagged with the guest time that produced it — the recorder's
    // whole timeline, and the reason a clip has no agent think-time in it.
    if (frozenRecorder.active && (this._frozenSteps % frozenRecorder.everyNSteps) === 0) {
      try { if (this._presentDxIfDirty) this._presentDxIfDirty(); } catch (_) {}
      try { if (this.renderer && this.renderer.flushRepaint) this.renderer.flushRepaint(true); } catch (_) {}
      try { if (this.renderer && this.renderer.repaint) this.renderer.repaint(); } catch (_) {}
      frozenRecorder.pumpAudio();
      frozenRecorder.capture(this._frozenSteps | 0, this.frozenGuestMs(), this._frozenTickMs);
    }
    this._frozenSteps = (this._frozenSteps | 0) + 1;
    this._advanceGuestTickMs(this._frozenTickMs, this.hostCtx && this.hostCtx.sharedAudio);
    this._postStep(step);
  }

  // At rest: flush whatever the last step drew before anyone screenshots it.
  // The run loop presents inside a step, but a repaint the renderer deferred
  // would otherwise land on the next step — which, frozen, may never come.
  _frozenIdle() {
    const waiters = this._frozenWaiters;
    if (!waiters || !waiters.length) return;
    this._frozenWaiters = [];
    try { if (this._presentDxIfDirty) this._presentDxIfDirty(); } catch (_) {}
    try { if (this.renderer && this.renderer.flushRepaint) this.renderer.flushRepaint(true); } catch (_) {}
    try { if (this.renderer && this.renderer.repaint) this.renderer.repaint(); } catch (_) {}
    for (const waiter of waiters) { try { waiter(); } catch (_) {} }
  }

  // Run exactly `count` slices, then park again. The promise resolves when the
  // guest is at rest, which is what makes "click, step, screenshot" atomic.
  stepFrozen(count, tickMs) {
    const n = Math.max(1, Math.min(WineAssembly.FROZEN_MAX_STEPS, count | 0));
    if (Number.isFinite(Number(tickMs)) && Number(tickMs) >= 0) this._frozenTickMs = Math.floor(Number(tickMs));
    if (!this._frozen) {
      return Promise.resolve(this.frozenStatus({ requested: n, ran: 0, error: 'not frozen' }));
    }
    const before = this._frozenSteps | 0;
    this._frozenBudget = (this._frozenBudget | 0) + n;
    return new Promise(resolve => {
      // A watchdog on PROGRESS, not on wall time: a legitimate 200000-step
      // request may take minutes, while a guest that stopped calling back
      // (crashed mid-slice, awaiting a DLL fetch that will never land) must
      // not hold the agent's HTTP request open forever.
      let seen = -1;
      const watchdog = setInterval(() => {
        const now = this._frozenSteps | 0;
        if (now !== seen) { seen = now; return; }
        clearInterval(watchdog);
        const idx = this._frozenWaiters.indexOf(done);
        if (idx >= 0) this._frozenWaiters.splice(idx, 1);
        this._frozenBudget = 0;
        resolve(this.frozenStatus({ requested: n, ran: (this._frozenSteps | 0) - before, timedOut: true }));
      }, WineAssembly.FROZEN_STALL_MS);
      const done = () => {
        clearInterval(watchdog);
        resolve(this.frozenStatus({ requested: n, ran: (this._frozenSteps | 0) - before }));
      };
      this._frozenWaiters.push(done);
      this._frozenPump();
    });
  }

  // Something happened that the parked guest was waiting for. Cut the sleep
  // short rather than letting it run out: the whole point of sleeping is that
  // nothing could have changed, and this is the call that says otherwise.
  // Cheap and idempotent, so input paths can call it unconditionally.
  _wakeStep() {
    if (!this.running) return;
    if (this._hiddenPaused) { this._resumeFromHidden(); return; }
    if (!this._stepTimeoutId) return;
    clearTimeout(this._stepTimeoutId);
    this._stepTimeoutId = 0;
    const fn = this._delayedStep;
    this._delayedStep = null;
    if (fn) this._scheduleStep(fn, 0);
  }

  // ---- vertical blank -------------------------------------------------
  //
  // A DirectDraw guest parked in WaitForVerticalBlank (yield_reason 13) is
  // waiting for the *display*, and requestAnimationFrame is the only thing a
  // web page can see that actually is the display: it fires on the
  // compositor's own beat. So the wake comes from rAF rather than from a
  // synthetic 16.7 ms grid on a timer — no beat frequency between our idea of
  // 60 Hz and the real refresh, no half-frame of latency from a setTimeout
  // that lands mid-frame, and hidden-tab throttling for free.
  //
  // Deliberately NOT a standing rAF chain: one is armed only while a guest is
  // actually parked, and it is dropped again the moment the wait ends. An
  // always-on rAF is exactly what the idle-cost work removed.
  //
  // (The headless CLI has no rAF at all and keeps the guest-clock model in
  // src/09a8-handlers-directx.wat. The two are meant to differ.)
  _awaitVblank(resume) {
    const ex = this.instance && this.instance.exports;
    const tick = () => {
      this._vblankPending = null;
      if (this._vblankTimer) { clearTimeout(this._vblankTimer); this._vblankTimer = 0; }
      this._vblankRafId = 0;
      try { if (ex && ex.vblank_tick) ex.vblank_tick(); } catch (_) {}
      resume();
    };
    // A display faster than 60 Hz would double the pace of any game that
    // counts vblanks — DirectDraw-era software was written for a ~60 Hz CRT
    // and takes one wait per frame. So measure the real interval and deliver
    // every Nth callback, with N derived rather than hardcoded so 90/120/144
    // all land near 60 rather than only ProMotion being special-cased.
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : null;
    if (raf) {
      const onFrame = (ts) => {
        this._vblankRafId = 0;
        const prev = this._vblankLastTs;
        this._vblankLastTs = ts;
        if (prev !== undefined) {
          const dt = ts - prev;
          // Ignore a gap that is not a refresh (a throttled or resumed tab).
          if (dt > 1 && dt < 40) {
            this._vblankPeriodMs = this._vblankPeriodMs
              ? this._vblankPeriodMs * 0.8 + dt * 0.2 : dt;
          }
        }
        const period = this._vblankPeriodMs || (1000 / 60);
        const divisor = Math.max(1, Math.round((1000 / 60) / period));
        this._vblankPhase = ((this._vblankPhase || 0) + 1) % divisor;
        if (this._vblankPhase !== 0) {
          this._vblankRafId = raf(onFrame);
          return;
        }
        tick();
      };
      this._vblankRafId = raf(onFrame);
    }
    // Backstop. rAF stops entirely on a hidden page, which composes correctly
    // with the hidden-pause path for a silent app — but an audible one keeps
    // running, and it must not hang forever on a vblank that will never come.
    // Also covers a host with no rAF at all (a worker, a test harness).
    this._vblankPending = tick;
    this._vblankTimer = setTimeout(() => {
      this._vblankTimer = 0;
      if (this._vblankPending) {
        if (this._vblankRafId && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this._vblankRafId);
          this._vblankRafId = 0;
        }
        this._vblankPending();
      }
    }, WineAssembly.MAX_PARK_SLEEP_MS);
  }

  // A parked vblank wait holds a rAF registration and a backstop timer, both
  // closing over this host — which owns a 512MB shared memory. Drop both.
  _cancelVblankWait() {
    this._vblankPending = null;
    if (this._vblankTimer) { clearTimeout(this._vblankTimer); this._vblankTimer = 0; }
    if (this._vblankRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._vblankRafId);
    }
    this._vblankRafId = 0;
  }

  // How long a spin park should sleep for. The two detectors wait on different
  // things and therefore have different deadlines:
  //
  //  * A clock park (14) is waiting for the millisecond to change, and the
  //    browser's guest clock is real wall time, so the deadline the guest
  //    named is at most a millisecond away. Sleeping to it is enough — and a
  //    1ms setTimeout is nested, so the browser's 4ms clamp batches several
  //    of them into one wake. That is desirable, not a bug: a guest counting
  //    milliseconds cannot tell 1ms of sleep from 4ms except by reading the
  //    clock, which is exactly what it does on resume.
  //
  //  * A queue park (15) has no clock deadline at all. The things that end it
  //    are input — which cuts the sleep short through renderer._stepWakeHooks
  //    / _wakeMessageWait — and a WM_TIMER, which is the one wake source that
  //    arrives with nothing touching the emulator. next_timer_due_ms is the
  //    export that answers when. With neither, park at the cap and re-check.
  _spinParkDelay(reason) {
    const ex = this.instance && this.instance.exports;
    if (!ex) return 1;
    if (reason === 14) {
      let due = 0, now = 0;
      try {
        due = ex.get_spin_deadline_ms ? (ex.get_spin_deadline_ms() >>> 0) : 0;
        now = ex.get_tick_count ? (ex.get_tick_count() >>> 0) : 0;
      } catch (_) { return 1; }
      const owed = (due - now) | 0;
      return Math.max(1, Math.min(WineAssembly.MAX_PARK_SLEEP_MS, owed));
    }
    let timerDue = -1;
    try { timerDue = ex.next_timer_due_ms ? (ex.next_timer_due_ms() | 0) : -1; } catch (_) {}
    if (timerDue < 0) return WineAssembly.MAX_PARK_SLEEP_MS;
    return Math.max(1, Math.min(WineAssembly.MAX_PARK_SLEEP_MS, timerDue));
  }

  // How long the drive loop may sleep before the next slice, given that the
  // guest's main thread is parked. 0 means "do not sleep".
  //
  // Every deadline here is one the guest itself named. A Sleep(n) and a
  // bounded WaitForSingleObject carry their own; a GetMessage/WaitMessage park
  // has no deadline of its own but can still be woken by a WM_TIMER, which is
  // what next_timer_due_ms answers. Anything else that could wake it — input,
  // a posted message, a worker thread, an async yield — either calls
  // _wakeStep() or does not park in the first place.
  _parkedSleepMs() {
    // Single-use: this step's yield handler recorded it, this step's tail
    // consumes it. Read before any early return so it can never leak into the
    // next step and shorten a sleep that has nothing to do with a spin.
    const spin = this._spinParkSleepMs | 0;
    this._spinParkSleepMs = 0;
    if (this._paused) return 0;
    const tm = this.threadManager;
    // A worker with runnable code is the other half of this step. It is not
    // idle just because the main thread is.
    if (tm && tm.hasActiveThreads && tm.hasActiveThreads()) return 0;
    const ex = this.instance && this.instance.exports;
    if (!ex) return 0;
    const now = this._audioSchedulerNow();
    // A click or keypress lands as a queued input event that the very next
    // slice consumes. Do not sleep through the tail of an interaction.
    const wake = this.renderer && this.renderer._recentMessageWakeAt;
    if (wake && (now - wake) < 120) return 0;
    let best = Infinity;
    if (tm && tm._mainSleepUntil) best = Math.min(best, tm._mainSleepUntil - now);
    let yr = 0;
    try { yr = ex.get_yield_reason ? (ex.get_yield_reason() >>> 0) : 0; } catch (_) { return 0; }
    if (yr === 1) {
      let timeout = 0xFFFFFFFF;
      try { timeout = ex.get_wait_timeout ? (ex.get_wait_timeout() >>> 0) : 0xFFFFFFFF; } catch (_) {}
      if (timeout !== 0xFFFFFFFF && timeout !== 0) best = Math.min(best, timeout);
    } else if (yr === 7) {
      let due = -1;
      try { due = ex.next_timer_due_ms ? (ex.next_timer_due_ms() | 0) : -1; } catch (_) { due = -1; }
      // -1 is "this thread owns no timer at all": nothing but an external
      // event can wake it, and those wake us explicitly.
      if (due >= 0) best = Math.min(best, due);
    } else if (!tm || !tm._mainSleepUntil) {
      // Parked for a reason we do not model. Poll at the cap.
      best = Math.min(best, WineAssembly.MAX_PARK_SLEEP_MS);
    }
    // A spin park has its own deadline, and it is the tighter one by
    // construction (a millisecond for the clock, the next timer for the queue).
    if (spin > 0) best = Math.min(best, spin);
    if (!Number.isFinite(best)) best = WineAssembly.MAX_PARK_SLEEP_MS;
    // A deadline that has already passed still means "park": whatever the
    // guest is waiting for did not arrive, and returning 0 here would put the
    // loop straight back into the spin this exists to end.
    return Math.max(1, Math.min(WineAssembly.MAX_PARK_SLEEP_MS, Math.round(best)));
  }

  // The tab went away. Unless the app is audible, stop the chain outright —
  // a throttled cadence is still a cadence, and a backgrounded emulator that
  // nobody is looking at should cost nothing at all. Audible playback is the
  // one case worth the battery: a music player in another tab is a feature.
  // Let the renderer's input path cut a parked sleep short. Registered per
  // host so two apps in one page each get their own wake.
  _installInputWake() {
    const renderer = this.renderer;
    if (!renderer) return;
    if (!this._wakeStepHook) this._wakeStepHook = () => this._wakeStep();
    const hooks = renderer._stepWakeHooks || (renderer._stepWakeHooks = new Set());
    hooks.add(this._wakeStepHook);
  }

  _removeInputWake() {
    const hooks = this.renderer && this.renderer._stepWakeHooks;
    if (hooks && this._wakeStepHook) hooks.delete(this._wakeStepHook);
  }

  _installVisibilityPause() {
    if (this._visibilityHooked || typeof document === 'undefined') return;
    if (typeof document.addEventListener !== 'function') return;
    this._visibilityHooked = true;
    this._onVisibilityChange = () => {
      if (!this.running) return;
      if (document.hidden) this._maybePauseForHidden();
      else this._resumeFromHidden();
    };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  _removeVisibilityPause() {
    if (!this._visibilityHooked || typeof document === 'undefined') return;
    this._visibilityHooked = false;
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }
  }

  _maybePauseForHidden() {
    // A frozen guest already costs nothing when nobody is stepping it, and a
    // hidden-tab pause would swallow the continuation an agent's next `step`
    // needs. The dashboard's tiles are often not the visible tab.
    if (this._frozen) return false;
    if (this._hiddenPaused || !this.running) return false;
    if (typeof document === 'undefined' || !document.hidden) return false;
    if (this._isAudioHot()) return false;
    this._hiddenPaused = true;
    this._hiddenPausedAt = this._audioSchedulerNow();
    this._cancelDelayedStep();
    return true;
  }

  _resumeFromHidden() {
    if (!this._hiddenPaused) return;
    this._hiddenPaused = false;
    // Freeze the guest clock across the pause. get_ticks is wall-clock derived
    // (now - wallStartMs), so without this a five-minute background stint
    // hands the app a five-minute jump the moment it resumes: every WM_TIMER
    // it owns is instantly overdue, every timeGetTime delta is enormous, and
    // an animation that paces itself off either one either fires a backlog or
    // teleports. Sliding the origin forward by the paused interval costs one
    // addition and makes the pause invisible to the guest.
    const pausedMs = Math.max(0, this._audioSchedulerNow() - (this._hiddenPausedAt || 0));
    if (pausedMs > 0) {
      const st = this._guestTickState(this.hostCtx && this.hostCtx.sharedAudio);
      if (st && Number.isFinite(st.wallStartMs) && st.wallStartMs > 0) {
        st.wallStartMs += pausedMs;
      }
    }
    this._hiddenPausedAt = 0;
    const fn = this._pausedStep;
    this._pausedStep = null;
    if (fn && this.running) this._scheduleStep(fn, 0);
  }

  run(stepsPerSlice = 100000) {
    this.stepsPerSlice = stepsPerSlice;
    if (this.guestWorker) return this._runThreaded(stepsPerSlice);
    this.running = true;
    this._stopped = false;
    this._frozenRegister();
    const self = this;
    self._installVisibilityPause();
    self._installInputWake();
    const step = async () => {
      if (!self.running) return;
      // Hidden tab, nothing audible: park the whole chain here. Nothing is
      // scheduled after this return, so the emulator costs exactly zero until
      // visibilitychange calls _resumeFromHidden with this same closure.
      if (self._hiddenPaused || self._maybePauseForHidden()) {
        self._pausedStep = step;
        return;
      }
      // Debug-mode HUD seam (lib/perf-hud.js). Null unless the HUD is on, so
      // a normal run pays one property read per step. Phases are timed here
      // rather than sampled from outside because the whole point is knowing
      // *which* part of a long step held the main thread.
      const perf = (typeof window !== 'undefined' && window.WinePerf && window.WinePerf.enabled)
        ? window.WinePerf : null;
      if (perf) perf.stepBegin();
      // Set by the one branch below that establishes the guest ran nothing.
      // Read only at the tail, where it decides whether the next slice is
      // posted immediately or slept for.
      let mainParked = false;
      try {
        // Cooperative apps run on the browser's main thread. Respect the
        // smaller compatibility policies selected by browser-shell so a hot
        // guest loop cannot hold input and repaint hostage for a full 1k
        // slice. The guest-Worker path keeps its separate 1k floor above.
        const activeStepsPerSlice = Math.max(1, (self.stepsPerSlice | 0) || stepsPerSlice);
        self._beginGuestTickBatch();
        // Check if main thread is waiting
        if (self.threadManager) await self.threadManager.resolveMainThreadSend();
        const mainThreadWaiting = self.threadManager &&
          (self._isMainExecutionSuspended() || self.threadManager.checkMainYield());
        if (mainThreadWaiting) {
          mainParked = true;
          // Main still waiting — just run worker threads.
          //
          // But the deferred last-window teardown still has to be able to
          // finish here, and it used to be checked only on the other branch.
          // A parked main thread is precisely the case it exists for: the app
          // destroyed its last top-level window and then blocked instead of
          // reaching ExitProcess -- waiting on a message that will never come,
          // or on a handle nothing will signal. The grace deadline then passed
          // with nobody looking at it, so `running` stayed true forever. On a
          // desktop that is an invisible leak; on a phone it is the end of the
          // session, because body.app-running hides the desktop icons and they
          // are the only launcher there is: closing Notepad left a bare teal
          // page that could not start anything. Whether an app happened to
          // park before or after its final slice is a race, which is what made
          // it intermittent.
          self._checkLastWindowStop();
          if (!self.running) {
            if (self.renderer && self._multiApp) {
              self._removeAppWindows();
              self.renderer.repaint();
            }
            return;
          }
        } else {
          if (self.renderer) {
            self.renderer.wasm = self.instance;
            self.renderer.wasmMemory = self.memory;
            self.renderer.mainWasm = self.instance;
            self.renderer.mainWasmMemory = self.memory;
          }
          const runStart = self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : 0;
          const pageProfile = (typeof window !== 'undefined' && window.__aoeProfile) || null;
          const pageProfileStart = pageProfile && typeof performance !== 'undefined' ? performance.now() : 0;
          if (perf) perf.countSteps(activeStepsPerSlice);
          const perfMainStart = perf ? performance.now() : 0;
          self.instance.exports.run(activeStepsPerSlice);
          // Browser waveOut completion is driven by AudioContext timeouts.
          // CALLBACK_FUNCTION clients cannot enter guest code from that
          // timeout: doing so would overwrite whichever x86 frame a slice is
          // currently unwinding. host-audio therefore queues WOM_DONE until
          // this cooperative slice boundary, exactly as the CLI harness does.
          if (self.hostCtx && self.hostCtx.pumpAudioCompletions) {
            self.hostCtx.pumpAudioCompletions();
          }
          // timeSetEvent is asynchronous on Windows. Most emulated apps pump
          // often enough for the existing MM_TIMER message path; opted-in
          // clients such as Diablo also need a callback between slices while
          // their main thread is deliberately busy-waiting. fire_mm_timer is
          // cooperative: it refuses to interrupt a parked wait or an active
          // callback and resumes the interrupted EIP through its return thunk.
          self._pumpMultimediaTimer();
          if (perf) perf.mark('main', performance.now() - perfMainStart);
          self._checkLastWindowStop();
          // ExitProcess/last-window teardown can stop the app from inside a
          // host callback while the current guest slice still unwinds. Run a
          // final ownership cleanup at the slice boundary so those trailing
          // instructions cannot leave a recreated dialog/frame behind.
          if (!self.running) {
            if (self.renderer && self._multiApp) {
              self._removeAppWindows();
              self.renderer.repaint();
            }
            return;
          }
          if (pageProfileStart && pageProfile && pageProfile.add) {
            const dt = performance.now() - pageProfileStart;
            pageProfile.add('main.runSlice', dt, { steps: activeStepsPerSlice });
            if (pageProfile.frame) pageProfile.frame('main.runSlice', { dtMs: dt, steps: activeStepsPerSlice });
          }
          if (runStart && self.renderer && self.renderer._profileMark) {
            self.renderer._profileMark('wasm-run-slice', {
              steps: activeStepsPerSlice,
              ms: self.renderer._profileNow() - runStart,
            });
          }
          const perfPresentStart = perf ? performance.now() : 0;
          if (self._presentDxIfDirty) self._presentDxIfDirty();
          if (self.renderer && self.renderer.flushRepaint) {
            self.renderer.flushRepaint(true);
          }
          if (perf) perf.mark('present', performance.now() - perfPresentStart);
          self._runSliceCount = (self._runSliceCount || 0) + 1;
          if (self.instance && self.instance.exports) {
            const ex = self.instance.exports;
            const windows = self.renderer && self.renderer.windows ? Object.keys(self.renderer.windows).length : 0;
            // The heartbeat used to be "every 32nd slice", which is a count,
            // not a rate. At 100,000 slices a second that is 3,000 log lines a
            // second — and logToUI is DOM work on the thread the guest runs
            // on, so the heartbeat became a meaningful share of the cost of
            // being idle. One a second says the same thing.
            const heartbeatNow = self._audioSchedulerNow();
            const heartbeatDue = heartbeatNow - (self._runHeartbeatAt || 0) >= 1000;
            const shouldLog = windows === 0
              ? (self._runSliceCount <= 64 || heartbeatDue)
              : (self._runSliceCount <= 8 || heartbeatDue);
            if (heartbeatDue) self._runHeartbeatAt = heartbeatNow;
            if (shouldLog) {
              const hex32 = v => (v >>> 0).toString(16).padStart(8, '0');
              const eip = ex.get_eip ? ex.get_eip() >>> 0 : 0;
              const ecx = ex.get_ecx ? ex.get_ecx() >>> 0 : 0;
              const esi = ex.get_esi ? ex.get_esi() >>> 0 : 0;
              const yr = ex.get_yield_reason ? ex.get_yield_reason() >>> 0 : 0;
              self.logToUI(`[run] slice=${self._runSliceCount} eip=0x${hex32(eip)} ecx=0x${hex32(ecx)} esi=0x${hex32(esi)} yield=${yr} windows=${windows}`);
            }
          }
        }
        if (!self.instance.exports.get_eip() && !self.instance.exports.get_yield_reason()) {
          self.logToUI('--- Program exited ---');
          self.stop();
          return;
        }
        // Handle yield reasons
        const yieldReason = self.instance.exports.get_yield_reason();
        if (yieldReason === 3) {
          await self.handleComDllLoad();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 12) {
          // io_wait: a provider-backed VFS entry (mounted zip/iso, dropped
          // File, remote URL over Range) needs a chunk that is not resident.
          // ReadFile parked with its stdcall frame restored and EIP on the
          // thunk, so filling the chunk and clearing the yield re-enters the
          // same call — which then takes the synchronous cache hit.
          const vfs = self._helpCtx && self._helpCtx.vfs;
          const pending = vfs && vfs.pendingRead;
          if (pending) {
            try { await vfs.fillPendingRead(pending); }
            catch (e) { self.logToUI(`[io] ${pending.path}: ${e && e.message}`); }
            vfs.pendingRead = null;
          }
          self.instance.exports.clear_yield();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 13) {
          // vblank_wait: a DirectDraw call is parked on the display. EIP is
          // still on the thunk, so clearing the yield re-enters the same call,
          // which re-tests the model and either completes or parks again.
          //
          // Frozen: the display beat is the step budget, not the compositor's.
          // Waking from a real rAF here let a frozen DirectDraw guest keep
          // running at the real refresh for as long as stepFrozen budget
          // remained — DX-Ball visibly animating inside a "frozen" tile, and a
          // step:N costing N real frames of wall clock. One frozen step is one
          // vblank, so a frame-paced game advances exactly one frame per step.
          if (self._frozen) {
            try { if (self.instance.exports.vblank_tick) self.instance.exports.vblank_tick(); } catch (_) {}
            try { self.instance.exports.clear_yield(); } catch (_) {}
            if (self.running) self._scheduleStep(step, 0);
            return;
          }
          self._awaitVblank(() => {
            try { self.instance.exports.clear_yield(); } catch (_) {}
            if (self.running) self._scheduleStep(step, 0);
          });
          return;
        }
        if (yieldReason === 14 || yieldReason === 15) {
          // A spin park: the guest was busy-waiting on the millisecond clock
          // (14) or on an empty message queue (15), and the handler parked
          // instead of answering "not yet" for the thousandth time. EIP is on
          // the thunk and the frame is intact, so clearing the yield re-enters
          // the same call.
          //
          // Deliberately NOT an early return with its own timer, the way the
          // vblank park is: this is a plain parked main thread, and the drive
          // loop already knows how to sleep one. Falling through records the
          // deadline for _parkedSleepMs() and lets the tail below post the
          // next step with it — which means worker threads still get their
          // slice while the main thread waits, and the nested-setTimeout 4ms
          // clamp coalesces the 1ms clock sleeps for free.
          self._spinParkSleepMs = self._spinParkDelay(yieldReason);
          self.instance.exports.clear_yield();
          mainParked = true;
        }
        if (yieldReason === 8) {
          // net_wait: a blocking socket call parked itself. EIP is still on
          // the thunk, so clearing the yield re-enters the same handler with
          // the same arguments. Rescheduling rather than looping is the whole
          // point — inbound frames arrive on the event loop, so a spin here
          // would starve the delivery this call is waiting for.
          self.instance.exports.clear_yield();
          if (self.instance.exports.vlan_pump) self.instance.exports.vlan_pump();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 5) {
          await self.handleLoadLibrary();
          if (self.running) { self._scheduleStep(step); }
          return;
        }
        if (yieldReason === 9) {
          // cs_wait: EnterCriticalSection found the section held by another guest
          // thread. EIP is still on the thunk, so clearing re-enters the same
          // call next turn. Do not return here: the cooperative holder runs in
          // the shared thread-manager block immediately below. Returning first
          // lets the main thread retry and re-park forever without ever giving
          // the critical-section owner a slice.
          self.instance.exports.clear_yield();
        }
        // Spawn and run worker threads
        if (self.threadManager) {
          if (self.threadManager._pendingThreads.length) {
            await self.threadManager.spawnPending();
          }
          if (self.threadManager.hasActiveThreads()) {
            const windowCount = self.renderer && self.renderer.windows ? Object.keys(self.renderer.windows).length : 0;
            const now = self.renderer && self.renderer._profileNow ? self.renderer._profileNow() : Date.now();
            const recentInputWake = self.renderer && self.renderer._recentMessageWakeAt &&
              (now - self.renderer._recentMessageWakeAt) < 120;
            // Visible-window apps can still have compute-heavy UI worker threads.
            // Winamp's About/Credits animation is one of them: too-small worker
            // quanta starve the credits renderer behind the message/present loop.
            // Keep a wall-clock cap for browser responsiveness, but give
            // active workers enough total steps to use that budget.
            const audioHot = self._isAudioHot();
            const menuOpen = self._hasOpenMenu();
            // Recent input used to zero the worker budget outright, so the
            // main thread could deliver the message without competition.
            // That is fine for a click, and catastrophic for a game played
            // with the mouse: pointer moves arrive faster than the 120ms
            // window expires, so the budget never comes back and the thread
            // running the game stops entirely. Blobby measured 0fps while
            // the mouse moved and 36-41fps with this line neutralized.
            // Reserve most of the slice for input instead of all of it.
            const threadBudget = windowCount
              ? (recentInputWake ? Math.max(10000, activeStepsPerSlice >> 2) : activeStepsPerSlice)
              : activeStepsPerSlice;
            const perfThreadStart = perf ? performance.now() : 0;
            if (threadBudget > 0) {
              if (windowCount && self.threadManager.runBudgeted) {
                const quantumSteps = audioHot ? (menuOpen ? 20000 : 10000) : 50000;
                const maxWallMs = audioHot
                  ? (menuOpen ? (mainThreadWaiting ? 8 : 6) : 4)
                  // While input is arriving, workers get a short quantum so
                  // the pointer still feels attached to the cursor — but a
                  // short one, not none.
                  : (recentInputWake ? 6 : (mainThreadWaiting ? 16 : 12));
                const threadStats = self.threadManager.runBudgeted({
                  // Non-audio UI workers should be limited by the wall-clock
                  // budget, not by one nominal interpreter slice. Credits
                  // needs several quanta before it can present its first frame.
                  maxTotalSteps: audioHot ? threadBudget : threadBudget * 4,
                  quantumSteps,
                  maxWallMs,
                  prioritizeAudioThreads: audioHot && !menuOpen,
                  stopIfMessagePending: false,
                });
                // hitDeadline means the worker was cut off by maxWallMs with
                // work still to do — the guest is being throttled by us, not
                // by its own idle loop. That distinction is invisible from
                // the page's frame rate, which stays a perfect 60 either way.
                if (perf && threadStats) {
                  perf.countSteps(threadStats.steps | 0);
                  perf.markThrottled(!!threadStats.hitDeadline);
                }
              } else {
                const sliceStats = self.threadManager.runSlice(threadBudget);
                if (perf && sliceStats) perf.countSteps(sliceStats.steps | 0);
              }
            }
            if (perf) perf.mark('workers', performance.now() - perfThreadStart);
            await self.handleCooperativeThreadLoadLibraries();
            const perfPresentStart2 = perf ? performance.now() : 0;
            if (self._presentDxIfDirty) self._presentDxIfDirty();
            if (self.renderer && self.renderer.flushRepaint) {
              self.renderer.flushRepaint(true);
            }
            if (perf) perf.mark('present', performance.now() - perfPresentStart2);
          }
        }
      } catch (e) {
        let eip = 0, prevEip = 0, prev2Eip = 0, esp = 0, ebp = 0, yr = 0;
        let eax = 0, ebx = 0, ecx = 0, edx = 0, esi = 0, edi = 0;
        try { eip = self.instance.exports.get_eip(); } catch {}
        try { prevEip = self.instance.exports.get_dbg_prev_eip(); } catch {}
        try { prev2Eip = self.instance.exports.get_dbg_prev2_eip(); } catch {}
        try { esp = self.instance.exports.get_esp(); } catch {}
        try { ebp = self.instance.exports.get_ebp(); } catch {}
        try { eax = self.instance.exports.get_eax(); } catch {}
        try { ebx = self.instance.exports.get_ebx(); } catch {}
        try { ecx = self.instance.exports.get_ecx(); } catch {}
        try { edx = self.instance.exports.get_edx(); } catch {}
        try { esi = self.instance.exports.get_esi(); } catch {}
        try { edi = self.instance.exports.get_edi(); } catch {}
        try { yr = self.instance.exports.get_yield_reason(); } catch {}
        const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');
        const stack = [];
        for (let offset = 0; offset < 16; offset += 4) {
          try { stack.push(hex(self.instance.exports.guest_read32((esp + offset) >>> 0))); }
          catch { stack.push('?'); }
        }
        const unimpl = self.hostCtx && self.hostCtx.lastUnimplemented;
        const tag = unimpl ? ` [unimplemented: ${unimpl}]` : '';
        const state = `EIP=${hex(eip)} prev_eip=${hex(prevEip)} prev2_eip=${hex(prev2Eip)} ` +
          `ESP=${hex(esp)} EBP=${hex(ebp)} EAX=${hex(eax)} EBX=${hex(ebx)} ECX=${hex(ecx)} ` +
          `EDX=${hex(edx)} ESI=${hex(esi)} EDI=${hex(edi)} stack=[${stack.join(',')}] yield=${yr}`;
        console.error('WASM crash:', e, state, tag);
        self.logToUI('ERROR: ' + e.message + ' @ ' + state + tag);
        if (typeof self.onFatal === 'function') {
          try { self.onFatal({ error: e, state, tag }); }
          catch (reportError) { console.error('Unable to show crash report:', reportError); }
        }
        // Repaints, unlike before: a crash that left the option off held the
        // dead app's last frame on screen, which reads as a hang rather than
        // as the exit it is.
        self.stop();
        return;
      } finally {
        // Every yield reason returns early from inside the try, so closing
        // the step anywhere else would silently drop those slices — exactly
        // the ones worth seeing, since a DLL load or a net_wait is a step
        // that did something unusual with the main thread.
        if (perf) perf.stepEnd();
      }
      if (self.running) {
        self._scheduleStep(step, mainParked ? self._parkedSleepMs() : 0);
      }
    };
    // Frozen at launch (a ?frozen tile, or the box checked before the app
    // started): park the very first slice instead of running it, so the guest
    // is at instruction zero until an agent steps it.
    if (self._frozen) self._scheduleStep(step, 0); else step();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseShellLaunchCommand, resolveShellLaunchPath };
}
