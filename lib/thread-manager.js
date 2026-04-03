// ThreadManager: multi-instance threading for wine-assembly
// Each WASM instance = one thread, sharing the same linear memory.

class ThreadManager {
  constructor(wasmModule, memory, mainInstance, makeImports) {
    this.module = wasmModule;
    this.memory = memory;
    this.mainInstance = mainInstance;
    this.makeImports = makeImports; // (threadId) => imports object

    this.threads = new Map(); // handle → { instance, state, startAddr, param, stackSize }
    this.events = new Map();  // handle → { signaled, manualReset }
    this._nextHandle = 0xE0001;
    this._pendingThreads = []; // threads awaiting spawn
    this._log = (typeof console !== 'undefined') ? console.log.bind(console) : () => {};
  }

  // Called from WASM host import
  createThread(startAddr, param, stackSize) {
    const handle = this._nextHandle;
    this._nextHandle = ((this._nextHandle + 1) & 0xFFFFF) | 0xE0000;
    this._pendingThreads.push({ handle, startAddr, param, stackSize: stackSize || 0x10000 });
    this._log(`[ThreadManager] CreateThread handle=0x${handle.toString(16)} start=0x${startAddr.toString(16)} param=0x${param.toString(16)}`);
    return handle;
  }

  exitThread(exitCode) {
    // The WASM side sets yield_reason=2, eip=0. We'll clean up in runSlice.
  }

  createEvent(manualReset, initialState) {
    const handle = this._nextHandle;
    this._nextHandle = ((this._nextHandle + 1) & 0xFFFFF) | 0xE0000;
    this.events.set(handle, { signaled: !!initialState, manualReset: !!manualReset });
    this._log(`[ThreadManager] CreateEvent handle=0x${handle.toString(16)} manual=${!!manualReset} initial=${!!initialState}`);
    return handle;
  }

  setEvent(handle) {
    const ev = this.events.get(handle);
    if (ev) {
      ev.signaled = true;
      this._log(`[ThreadManager] SetEvent 0x${handle.toString(16)}`);
    }
    return 1;
  }

  resetEvent(handle) {
    const ev = this.events.get(handle);
    if (ev) {
      ev.signaled = false;
    }
    return 1;
  }

  waitSingle(handle, timeout) {
    const ev = this.events.get(handle);
    if (ev) {
      if (ev.signaled) {
        if (!ev.manualReset) ev.signaled = false; // auto-reset
        return 0; // WAIT_OBJECT_0
      }
      if (timeout === 0) return 0x102; // WAIT_TIMEOUT
      return 0xFFFF; // must wait — yield
    }
    // Handle might be a thread handle — wait for thread exit
    const thread = this.threads.get(handle);
    if (thread && thread.state === 'exited') return 0;
    if (thread) return 0xFFFF; // must wait
    // Unknown handle — return immediately
    return 0;
  }

  // Instantiate pending threads (async)
  async spawnPending() {
    for (const pending of this._pendingThreads) {
      const tid = this.threads.size + 1;
      const imports = this.makeImports(tid);
      const { instance } = await WebAssembly.instantiate(this.module, imports);

      // Get PE metadata from main instance
      const main = this.mainInstance.exports;
      instance.exports.init_thread(
        tid,
        main.get_image_base(),
        main.get_code_start(),
        main.get_code_end(),
        main.get_thunk_base(),
        main.get_thunk_end(),
        main.get_num_thunks()
      );

      // Set up thread stack in shared memory
      // Allocate stack space from main heap (guest addresses)
      const stackSize = pending.stackSize;
      const stackBase = main.guest_alloc(stackSize);
      const stackTop = stackBase + stackSize;

      // Set ESP to top of stack
      instance.exports.set_esp(stackTop);

      // Push parameter and return address (ExitThread thunk) onto stack
      // Push parameter
      instance.exports.set_esp(stackTop - 4);
      instance.exports.guest_write32(stackTop - 4, pending.param);
      // Push return address = 0 (will halt thread when it returns)
      instance.exports.set_esp(stackTop - 8);
      instance.exports.guest_write32(stackTop - 8, 0);

      // Set EIP to thread start function
      instance.exports.set_eip(pending.startAddr);

      // Sync heap_ptr from main
      instance.exports.set_heap_ptr(main.get_heap_ptr());

      // Allocate TIB/FS base for this thread
      const tib = main.guest_alloc(0x30);
      instance.exports.guest_write32(tib, 0xFFFFFFFF); // SEH head = -1
      instance.exports.guest_write32(tib + 4, stackTop);  // stack top
      instance.exports.guest_write32(tib + 8, stackBase);  // stack bottom
      instance.exports.guest_write32(tib + 0x18, tib);     // self pointer

      this.threads.set(pending.handle, {
        instance,
        state: 'active',
        tid,
        fsBase: tib,
      });

      this._log(`[ThreadManager] Spawned thread ${tid} handle=0x${pending.handle.toString(16)} EIP=0x${pending.startAddr.toString(16)} ESP=0x${(stackTop - 8).toString(16)}`);
    }
    this._pendingThreads = [];
  }

  // Run one batch across all active threads
  runSlice(batchSize) {
    const main = this.mainInstance.exports;

    for (const [handle, thread] of this.threads) {
      if (thread.state !== 'active') continue;

      const e = thread.instance.exports;

      // Check if thread is waiting
      const yieldReason = e.get_yield_reason();
      if (yieldReason === 1) {
        // Waiting — check if event is now signaled
        const waitHandle = e.get_wait_handle();
        const result = this.waitSingle(waitHandle, 0);
        if (result === 0xFFFF || result === 0x102) continue; // still waiting
        // Signaled — resume thread
        e.clear_yield();
        // Complete the WaitForSingleObject call
        e.set_eax(result);
        // Clean up stack (ret + 2 args = 12)
        e.set_esp(e.get_esp() + 12);
        this._log(`[ThreadManager] Thread ${thread.tid} resumed from wait, handle=0x${waitHandle.toString(16)}`);
      } else if (yieldReason === 2) {
        thread.state = 'exited';
        this._log(`[ThreadManager] Thread ${thread.tid} exited`);
        continue;
      }

      if (!e.get_eip()) {
        thread.state = 'exited';
        continue;
      }

      // Sync heap_ptr from main → worker
      e.set_heap_ptr(main.get_heap_ptr());

      // Run the thread
      e.run(batchSize);

      // Sync heap_ptr back from worker → main
      main.set_heap_ptr(e.get_heap_ptr());

      // Check post-run yield
      const postYield = e.get_yield_reason();
      if (postYield === 2) {
        thread.state = 'exited';
        this._log(`[ThreadManager] Thread ${thread.tid} exited`);
      }
    }
  }

  // Also check main thread for yield (WaitForSingleObject)
  checkMainYield() {
    const e = this.mainInstance.exports;
    const yr = e.get_yield_reason();
    if (yr !== 1) return false; // not waiting

    const waitHandle = e.get_wait_handle();
    const result = this.waitSingle(waitHandle, 0);
    if (result === 0xFFFF || result === 0x102) return true; // still waiting

    // Signaled — resume
    e.clear_yield();
    e.set_eax(result);
    e.set_esp(e.get_esp() + 12);
    this._log(`[ThreadManager] Main thread resumed from wait, handle=0x${waitHandle.toString(16)}`);
    return false;
  }

  hasActiveThreads() {
    for (const [, t] of this.threads) {
      if (t.state === 'active') return true;
    }
    return this._pendingThreads.length > 0;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ThreadManager };
} else if (typeof window !== 'undefined') {
  window.ThreadManager = ThreadManager;
}
