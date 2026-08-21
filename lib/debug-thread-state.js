// Live scheduler diagnostics for the browser debug toolbar.
//
// The normal debug log is intentionally noisy. A deadlocked guest can emit the
// same run heartbeat forever, which makes a one-off console expression hard to
// read. This module keeps the useful state in a separate, reusable popup and
// never writes a line to the page log or developer console.

(function () {
  'use strict';

  const YIELD_NAMES = {
    0: 'running',
    1: 'wait',
    2: 'exited',
    3: 'COM DLL load',
    4: 'help load',
    5: 'LoadLibrary',
    6: 'modal dialog',
    7: 'message wait',
    8: 'network wait',
    9: 'critical section',
  };

  const hex = value => '0x' + (value >>> 0).toString(16).padStart(8, '0');

  function call(exports, name, fallback) {
    try {
      return exports && typeof exports[name] === 'function'
        ? exports[name]()
        : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function threadSnapshot(exports, extra) {
    const yieldReason = call(exports, 'get_yield_reason', 0) >>> 0;
    return Object.assign({
      tid: call(exports, 'get_current_thread_id', 0) >>> 0,
      eip: call(exports, 'get_eip', 0) >>> 0,
      esp: call(exports, 'get_esp', 0) >>> 0,
      yieldReason,
      yieldName: YIELD_NAMES[yieldReason] || 'unknown',
      waitHandle: call(exports, 'get_wait_handle', 0) >>> 0,
    }, extra || {});
  }

  function readCriticalSection(exports, address) {
    if (!address || !exports || typeof exports.guest_read32 !== 'function') return null;
    try {
      return {
        address: address >>> 0,
        lock: exports.guest_read32((address + 4) >>> 0) | 0,
        recursion: exports.guest_read32((address + 8) >>> 0) >>> 0,
        owner: exports.guest_read32((address + 12) >>> 0) >>> 0,
      };
    } catch (_) {
      return null;
    }
  }

  function collectApp(running, index) {
    const wine = running && running.wine;
    const exports = wine && wine.instance && wine.instance.exports;
    if (!exports) return { name: (running && running.name) || `app ${index + 1}`, loading: true };

    const main = threadSnapshot(exports, { kind: 'main', state: wine.running ? 'active' : 'stopped' });
    const manager = wine.threadManager;
    const workers = [];
    if (manager && manager.threads && typeof manager.threads[Symbol.iterator] === 'function') {
      for (const [handle, worker] of manager.threads) {
        const workerExports = worker && worker.instance && worker.instance.exports;
        workers.push(threadSnapshot(workerExports, {
          kind: 'worker',
          handle: handle >>> 0,
          tid: worker && worker.tid != null ? worker.tid >>> 0 : 0,
          state: (worker && worker.state) || 'pending',
          suspended: (worker && worker.suspendCount) >>> 0 || 0,
          waitPolls: (worker && worker.waitPolls) >>> 0 || 0,
        }));
      }
    }

    const criticalAddress = main.yieldReason === 9 ? main.waitHandle : 0;
    const criticalSection = readCriticalSection(exports, criticalAddress);
    if (criticalSection) {
      const owner = criticalSection.owner >>> 0;
      main.ownsBlockedSection = main.tid === owner;
      for (const worker of workers) worker.ownsBlockedSection = worker.tid === owner;
    }

    return {
      name: (running && running.name) || `app ${index + 1}`,
      appIndex: running && running.appIndex,
      main,
      workers,
      criticalSection,
    };
  }

  function collectSnapshot(runningApps) {
    const apps = Array.from(runningApps || []);
    return {
      capturedAt: new Date().toISOString(),
      apps: apps.map(collectApp),
    };
  }

  function formatThread(thread) {
    const owner = thread.ownsBlockedSection ? '  <== OWNS BLOCKED SECTION' : '';
    const handle = thread.handle == null ? '' : ` handle=${hex(thread.handle)}`;
    return `${thread.kind.padEnd(6)} T${String(thread.tid).padEnd(3)} ${String(thread.state).padEnd(8)}` +
      ` eip=${hex(thread.eip)} esp=${hex(thread.esp)}` +
      ` yield=${thread.yieldReason} (${thread.yieldName}) wait=${hex(thread.waitHandle)}` +
      `${handle}${owner}`;
  }

  function formatSnapshot(snapshot) {
    const lines = [
      'Wine-Assembly live thread state',
      snapshot.capturedAt,
      'Yield 9 = blocked EnterCriticalSection',
      '',
    ];
    if (!snapshot.apps.length) lines.push('No running apps.');
    for (const app of snapshot.apps) {
      lines.push(`[${app.name}]`);
      if (app.loading) {
        lines.push('loading (WASM instance not ready)', '');
        continue;
      }
      lines.push(formatThread(app.main));
      for (const worker of app.workers) lines.push(formatThread(worker));
      if (app.criticalSection) {
        const cs = app.criticalSection;
        lines.push('', `blocked critical section ${hex(cs.address)}`,
          `  lock=${cs.lock} recursion=${cs.recursion} owner=T${cs.owner}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function createDebugThreadState(options) {
    options = options || {};
    const debugMode = !!options.debugMode;
    const getRunningApps = options.getRunningApps || (() => []);
    const openWindow = options.openWindow || ((...args) => window.open(...args));
    const startInterval = options.setInterval || setInterval;
    const stopInterval = options.clearInterval || clearInterval;
    let popup = null;
    let timer = null;

    function update() {
      if (!popup || popup.closed) {
        if (timer) stopInterval(timer);
        timer = null;
        popup = null;
        return null;
      }
      const output = popup.document.getElementById('thread-state-output');
      const snapshot = collectSnapshot(getRunningApps());
      if (output) output.textContent = formatSnapshot(snapshot);
      return snapshot;
    }

    function open() {
      if (!debugMode) return null;
      if (!popup || popup.closed) {
        popup = openWindow('', 'wine-assembly-thread-state',
          'width=940,height=640,resizable=yes,scrollbars=yes');
        if (!popup) return null;
        popup.document.title = 'Wine-Assembly Thread State';
        popup.document.body.innerHTML =
          '<pre id="thread-state-output" style="margin:0;padding:12px;' +
          'background:#101010;color:#e8e8e8;min-height:100vh;' +
          'font:13px/1.45 Menlo,Monaco,Consolas,monospace;white-space:pre-wrap"></pre>';
      }
      if (timer) stopInterval(timer);
      update();
      timer = startInterval(update, 500);
      if (typeof popup.focus === 'function') popup.focus();
      return popup;
    }

    function close() {
      if (timer) stopInterval(timer);
      timer = null;
      if (popup && !popup.closed && typeof popup.close === 'function') popup.close();
      popup = null;
    }

    return { open, close, update };
  }

  const api = { createDebugThreadState, collectSnapshot, formatSnapshot, YIELD_NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.debugThreadState = api;
})();
