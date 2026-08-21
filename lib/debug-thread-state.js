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
    const snapshot = Object.assign({
      tid: call(exports, 'get_current_thread_id', 0) >>> 0,
      eip: call(exports, 'get_eip', 0) >>> 0,
      previousEip: call(exports, 'get_dbg_prev_eip', 0) >>> 0,
      esp: call(exports, 'get_esp', 0) >>> 0,
      edx: call(exports, 'get_edx', 0) >>> 0,
      yieldReason,
      yieldName: YIELD_NAMES[yieldReason] || 'unknown',
      waitHandle: call(exports, 'get_wait_handle', 0) >>> 0,
    }, extra || {});
    snapshot.schedulerState = snapshot.state === 'exited' || yieldReason === 2
      ? 'exited'
      : snapshot.suspended
        ? 'suspended'
        : yieldReason
          ? `blocked:${snapshot.yieldName}`
          : snapshot.state === 'active'
            ? 'runnable'
            : String(snapshot.state || 'unknown');
    return snapshot;
  }

  function readCriticalSection(exports, address) {
    if (!address || !exports || typeof exports.guest_read32 !== 'function') return null;
    try {
      return {
        address: address >>> 0,
        lockCount: exports.guest_read32((address + 4) >>> 0) | 0,
        recursion: exports.guest_read32((address + 8) >>> 0) >>> 0,
        owner: exports.guest_read32((address + 12) >>> 0) >>> 0,
      };
    } catch (_) {
      return null;
    }
  }

  function readGuestCString(exports, address, maxLength) {
    if (!address || !exports || typeof exports.guest_read8 !== 'function') return '';
    let text = '';
    const limit = Math.max(1, maxLength || 64);
    try {
      for (let i = 0; i < limit; i++) {
        const byte = exports.guest_read8((address + i) >>> 0) & 0xFF;
        if (!byte) break;
        if (byte < 0x20 || byte > 0x7E) return '';
        text += String.fromCharCode(byte);
      }
    } catch (_) {
      return '';
    }
    return text;
  }

  // DLL_TABLE is emulator-private memory, while its fields point back into
  // guest memory. Reading both sides here lets the popup name the module that
  // owns an EIP without adding another diagnostic export to the core.
  function collectModules(wine, exports) {
    const memory = wine && wine.memory && wine.memory.buffer;
    const count = call(exports, 'get_dll_count', 0) >>> 0;
    const table = call(exports, 'get_dll_table', 0) >>> 0;
    if (!memory || !count || !table || table + count * 32 > memory.byteLength) return [];
    const view = new DataView(memory);
    const modules = [];
    for (let i = 0; i < Math.min(count, 64); i++) {
      const entry = table + i * 32;
      const loadAddress = view.getUint32(entry, true) >>> 0;
      const size = view.getUint32(entry + 4, true) >>> 0;
      const exportRva = view.getUint32(entry + 8, true) >>> 0;
      let name = '';
      if (loadAddress && exportRva && typeof exports.guest_read32 === 'function') {
        try {
          const nameRva = exports.guest_read32((loadAddress + exportRva + 12) >>> 0) >>> 0;
          name = readGuestCString(exports, (loadAddress + nameRva) >>> 0, 64);
        } catch (_) {}
      }
      modules.push({ name, loadAddress, size });
    }
    return modules;
  }

  function readWords(exports, address, beforeBytes, wordCount) {
    if (!exports || typeof exports.guest_read32 !== 'function' || !address) return null;
    const start = (address - (beforeBytes || 0)) >>> 0;
    const words = [];
    try {
      for (let i = 0; i < wordCount; i++) {
        const wordAddress = (start + i * 4) >>> 0;
        words.push({ address: wordAddress, value: exports.guest_read32(wordAddress) >>> 0 });
      }
    } catch (_) {
      return null;
    }
    return { address: address >>> 0, start, words };
  }

  function collectStormQueue(exports, modules, appName) {
    if (appName !== 'diablo_demo') return null;
    const storm = (modules || []).find(module => /^storm(?:\.dll)?$/i.test(module.name || ''));
    if (!storm) return null;
    // The loop at Storm 0x1500850b walks [0x15022260], following node+0x30
    // until NULL before releasing CS 0x150243b0. A cycle here explains both
    // the held lock and the repeated audio fragment.
    const address = (storm.loadAddress + 0x22260) >>> 0;
    const dump = readWords(exports, address, 16, 12);
    if (!dump) return null;
    dump.moduleBase = storm.loadAddress >>> 0;
    dump.head = exports.guest_read32(address) >>> 0;
    dump.nodes = [];
    dump.cycleAt = 0;
    const seen = new Set();
    let node = dump.head;
    try {
      while (node && dump.nodes.length < 16) {
        if (seen.has(node)) {
          dump.cycleAt = node;
          break;
        }
        seen.add(node);
        const next = exports.guest_read32((node + 0x30) >>> 0) >>> 0;
        dump.nodes.push({
          address: node,
          object: exports.guest_read32((node + 0x04) >>> 0) >>> 0,
          span: exports.guest_read32((node + 0x0C) >>> 0) >>> 0,
          clock: exports.guest_read32((node + 0x10) >>> 0) >>> 0,
          next,
        });
        node = next;
      }
      dump.truncated = !!node && !dump.cycleAt && dump.nodes.length === 16;
    } catch (_) {
      dump.readFailedAt = node >>> 0;
    }
    return dump;
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
          // ThreadManager's tid is a zero-based worker/cache slot. The WAT
          // guest ID is slot+1 because main owns T1. Critical-section owner
          // fields contain the guest ID, so conflating the two made an owner
          // of T2 look unrelated to the popup's worker T1 row.
          slot: worker && worker.tid != null ? worker.tid >>> 0 : 0,
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

    const modules = collectModules(wine, exports);

    const name = (running && running.name) || `app ${index + 1}`;
    return {
      name,
      appIndex: running && running.appIndex,
      main,
      workers,
      criticalSection,
      stormQueue: collectStormQueue(exports, modules, name),
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
    const identity = thread.kind === 'worker'
      ? `S${thread.slot}/T${thread.tid}`
      : `T${thread.tid}`;
    return `${thread.kind.padEnd(6)} ${identity.padEnd(6)} ${String(thread.state).padEnd(8)}` +
      ` eip=${hex(thread.eip)} esp=${hex(thread.esp)}` +
      ` yield=${thread.yieldReason} (${thread.yieldName}) wait=${hex(thread.waitHandle)}` +
      `${handle} scheduler=${thread.schedulerState}${owner}`;
  }

  function formatWordDump(dump) {
    const lines = [];
    for (let i = 0; i < dump.words.length; i += 4) {
      const row = dump.words.slice(i, i + 4);
      lines.push(`  ${hex(row[0].address)}: ${row.map(word => hex(word.value)).join(' ')}`);
    }
    return lines;
  }

  function defaultStorageSnapshot() {
    const snapshot = new Map();
    try {
      if (typeof localStorage === 'undefined') return snapshot;
      for (const key of Object.keys(localStorage).sort()) {
        if (!/^(?:reg:|ini:|wine-assembly\.)/i.test(key)) continue;
        const value = localStorage.getItem(key);
        snapshot.set(key, value == null ? '' : String(value));
      }
    } catch (_) {}
    return snapshot;
  }

  function storageDiff(before, after) {
    const changes = [];
    const keys = new Set([...(before || new Map()).keys(), ...(after || new Map()).keys()]);
    for (const key of Array.from(keys).sort()) {
      const had = before && before.has(key);
      const has = after && after.has(key);
      const oldValue = had ? before.get(key) : '';
      const newValue = has ? after.get(key) : '';
      if (had && has && oldValue === newValue) continue;
      changes.push({
        key,
        kind: !had ? 'added' : !has ? 'removed' : 'changed',
        beforeBytes: String(oldValue).length,
        afterBytes: String(newValue).length,
      });
    }
    return changes;
  }

  function createDeadlockWatchdog(options) {
    options = options || {};
    const now = options.now || (() => Date.now());
    const getStorageSnapshot = options.getStorageSnapshot || defaultStorageSnapshot;
    const states = new Map();
    const pendingStorage = new Map();

    function beginLaunch(name) {
      pendingStorage.set(String(name || ''), getStorageSnapshot());
    }

    function enrich(snapshot) {
      const capturedMs = now();
      const storageNow = getStorageSnapshot();
      for (const app of snapshot.apps) {
        const key = `${app.appIndex == null ? '?' : app.appIndex}:${app.name}`;
        let state = states.get(key);
        if (!state) {
          state = {
            signature: '',
            since: capturedMs,
            samples: 0,
            ownerHistory: [],
            storageBaseline: pendingStorage.get(String(app.name)) || storageNow,
          };
          pendingStorage.delete(String(app.name));
          states.set(key, state);
        }
        app.storageChanges = storageDiff(state.storageBaseline, storageNow);

        if (!app.criticalSection || app.main.yieldReason !== 9) {
          state.signature = '';
          state.samples = 0;
          state.ownerHistory.length = 0;
          continue;
        }

        const cs = app.criticalSection;
        const signature = `${cs.address}:${cs.owner}:${app.main.eip}`;
        if (signature !== state.signature) {
          state.signature = signature;
          state.since = capturedMs;
          state.samples = 0;
          state.ownerHistory.length = 0;
        }
        state.samples++;
        const owner = [app.main, ...app.workers].find(thread => thread.tid === cs.owner) || null;
        state.ownerHistory.push({
          at: capturedMs,
          eip: owner ? owner.eip : 0,
          previousEip: owner ? owner.previousEip : 0,
          edx: owner ? owner.edx : 0,
          schedulerState: owner ? owner.schedulerState : 'missing',
        });
        if (state.ownerHistory.length > 12) state.ownerHistory.shift();

        const distinctEips = new Set(state.ownerHistory.map(item => item.eip));
        let diagnosis = 'collecting owner samples';
        if (!owner) diagnosis = 'lock owner thread is missing';
        else if (owner.schedulerState === 'exited') diagnosis = 'exited thread still owns the lock';
        else if (state.samples >= 4 && distinctEips.size === 1) {
          diagnosis = `owner EIP unchanged across ${state.samples} samples`;
        } else if (state.samples >= 4) {
          diagnosis = `owner EIP is advancing (${distinctEips.size} recent addresses)`;
        }
        app.deadlockWatch = {
          samples: state.samples,
          durationMs: Math.max(0, capturedMs - state.since),
          ownerTid: cs.owner,
          owner,
          ownerHistory: state.ownerHistory.slice(),
          diagnosis,
        };
      }
      return snapshot;
    }

    return { beginLaunch, enrich };
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
          `  lockCount=${cs.lockCount} recursion=${cs.recursion} owner=T${cs.owner}`);
      }
      if (app.deadlockWatch) {
        const watch = app.deadlockWatch;
        const recent = watch.ownerHistory.map(sample =>
          `${hex(sample.eip)}<-${hex(sample.previousEip)}[${sample.schedulerState}]`);
        lines.push(`  watchdog: ${watch.diagnosis}; ${watch.durationMs}ms`,
          `  owner recent EIP<-previous: ${recent.join('  ')}`,
          `  owner recent EDX nodes: ${watch.ownerHistory.map(sample => hex(sample.edx)).join('  ')}`);
      }
      if (app.stormQueue) {
        const queue = app.stormQueue;
        lines.push('', `Storm active-list head ${hex(queue.address)} -> ${hex(queue.head)} ` +
          `(module ${hex(queue.moduleBase)})`);
        for (const node of queue.nodes) {
          lines.push(`  node ${hex(node.address)} object=${hex(node.object)} ` +
            `span=${hex(node.span)} clock=${hex(node.clock)} next=${hex(node.next)}`);
        }
        if (queue.cycleAt) lines.push(`  CYCLE: ${hex(queue.cycleAt)} is reached again`);
        else if (queue.truncated) lines.push('  chain continues beyond 16 nodes');
        else if (queue.readFailedAt) lines.push(`  unreadable node ${hex(queue.readFailedAt)}`);
        lines.push('  globals around list head:', ...formatWordDump(queue));
      }
      if (app.storageChanges) {
        lines.push('', 'localStorage changes since launch:');
        if (!app.storageChanges.length) lines.push('  none');
        for (const change of app.storageChanges) {
          lines.push(`  ${change.kind.padEnd(7)} ${change.key} ` +
            `(${change.beforeBytes} -> ${change.afterBytes} bytes)`);
        }
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
    const watchdog = createDeadlockWatchdog({
      now: options.now,
      getStorageSnapshot: options.getStorageSnapshot,
    });
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
      const snapshot = watchdog.enrich(collectSnapshot(getRunningApps()));
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

    return {
      open,
      close,
      update,
      beginLaunch: name => { if (debugMode) watchdog.beginLaunch(name); },
    };
  }

  const api = {
    createDebugThreadState,
    createDeadlockWatchdog,
    collectSnapshot,
    formatSnapshot,
    storageDiff,
    YIELD_NAMES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.debugThreadState = api;
})();
