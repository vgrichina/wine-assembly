# Design: real OS threads for guest threads

**Status:** proposal, unimplemented. Written 2026-08-16.

**Goal:** each guest thread runs on its own Web Worker, executing at the same
time as the others, with the UI thread doing nothing but input and compositing.

**Non-goal:** making a single-threaded app faster. Nothing here raises the
~10-20M x86 steps/sec a single guest thread gets. This is about *concurrency*
and about the UI never being hostage to guest execution.

---

## 1. Why this is worth doing

The immediate cause is a bug that took a day to find (`b7b4d4e`). Guest threads
and the browser's input handling share one JS thread, so the scheduler had to
choose between them, and it chose input:

```js
// host.js, before the fix
const threadBudget = windowCount ? (recentInputWake ? 0 : activeStepsPerSlice) : ...
```

A mouse-driven game therefore stopped whenever the mouse moved — pointer events
arrive every ~16ms, the input window is 120ms, so the thread running the game
got zero steps for as long as a human was playing. The fix reserves a quarter
slice instead of nothing, which is a better compromise, but it is still a
compromise between two things that should not be competing at all.

Everything downstream of that shared thread has the same shape:

| Symptom | Cause |
|---|---|
| Guest stalls while the pointer moves | input and guest share a thread |
| Page GC pause becomes a guest stall | same heap, same thread |
| Audio underruns under UI load | `waveOut` worker competes with paint |
| Worker quantum tuning (`maxWallMs` 4/6/8/12/16) | hand-balancing one thread |
| Guest threads never actually overlap | cooperative round-robin |

Four of those five are not bugs to fix; they are properties of running an
operating system's threads inside one event loop.

---

## 2. Where we actually are

The name is misleading: `lib/thread-manager.js` does not create OS threads.

```
        MAIN JS THREAD
  ┌───────────────────────────────────────────────────────┐
  │ host.js run(): setTimeout(step, 0) chain              │
  │   ├─ main instance   .run(steps)                      │
  │   ├─ T1..T7 instances .run(steps)   ← round-robin,    │
  │   │                                   same JS thread  │
  │   └─ flushRepaint → canvas                            │
  └───────────────────────────────────────────────────────┘
   one WebAssembly.Module, N Instances, ONE shared memory
```

- `host.js:708` — `new WebAssembly.Memory({initial: 8192, maximum: 8192, shared: true})`.
  **The memory is already shared.**
- `thread-manager.js:501` — every thread is `WebAssembly.instantiate(this.module, imports)`
  against that same memory. **The module is already instance-per-thread.**
- `thread-manager.js:41` — the sync table (events, semaphores) is already an
  `Int32Array` over that memory driven by `Atomics.store/notify/wait`.
  **The synchronisation primitives are already atomic.**
- `13-exports.wat:1914 init_thread` — per-thread decoded-code cache
  (`THREAD_BASE = 0x05000000 + tid*4MB`) and per-thread cache index
  (`CACHE_INDEX = 0x07152000 + tid*0x8000`). **The hottest mutable emulator
  structure is already partitioned per thread.**

That is most of the hard part of a threaded design, built for reasons that had
nothing to do with threads. What is missing is not the memory model — it is
that nobody has ever run two of these instances *at the same instant*, so
everything shared has been protected by accident, by there being one thread.

---

## 3. What actually blocks parallel execution

### 3.1 Emulator-private mutable state (the real work)

Guest memory races are the guest's problem — Win98 had them too, and an app
that corrupts its own heap from two threads is behaving authentically. What we
cannot allow is *our own* bookkeeping racing, because that corrupts the
emulator rather than the emulated program.

```
  SHARED, MUTABLE, TOUCHED BY ANY THREAD          strategy
  ───────────────────────────────────────────────────────────────
  free-list allocator     $free_list (global!)    → move to memory + lock
  sparse heap bump        $heap_sparse_ptr        → per-thread arenas
  VirtualAlloc top        $virtual_alloc_top      → single owner (broker)
  window table            WND_RECORDS  0x7000     → main-thread-only (§3.3)
  class table             CLASS_RECORDS           → main-thread-only
  timer table             TIMER_TABLE             → main-thread-only
  post queue              0x400 ring              → lock-free SPSC per thread
  DX objects / COM        0x07FF0000              → lock, coarse
  socket table            09d-winsock.wat         → lock, coarse
  DLL table               0x04462000              → immutable after load
  decoded-code cache      per-tid partition       → already safe
```

Two of these are worth calling out because they are *already* latent bugs that
only the single-thread accident hides:

- **`$free_list` is a per-instance global over shared memory.** Each instance
  keeps its own free-list head while allocating from the same arena. Two
  threads can therefore hand out overlapping blocks today; it survives because
  worker allocations are rare and interleaving is coarse.
- **`$virtual_alloc_top` is reset per instance in `init_thread`.** Two threads
  calling `VirtualAlloc` can be handed the same address.

Fixing both is a prerequisite for phase 1, and both are worth fixing anyway.

### 3.2 Host imports are the surface that must be brokered

`lib/host-imports.js` is ~4,270 lines and 111 sites touch a canvas or the
renderer. Workers cannot touch the DOM, and two of the things it needs do not
exist off the main thread at all:

| Import family | In a worker | Plan |
|---|---|---|
| GDI draw (`gdi_*`) | ✅ OffscreenCanvas | surfaces already offscreen; one per top-level hwnd, owned by whichever worker draws it |
| memory / string / CRT | ✅ pure | no change |
| `get_ticks`, timers | ✅ `performance.now()` | no change |
| file I/O, DLL fetch, help | ✅ `fetch` works in workers | no change |
| **registry / INI** (`storage.js`) | ❌ **no `localStorage`** | broker with `Atomics.wait`, or snapshot into memory at load and write back asynchronously |
| **audio** (`waveOut*`, MIDI) | ❌ `AudioContext` is main-thread | broker; ring buffer in shared memory, main thread drains |
| input (`check_input`) | ❌ events land on main | main thread writes into a shared ring; worker polls |
| screen composite | ❌ | main thread composites offscreen surfaces in z-order |

The registry is the awkward one, because WAT calls it **synchronously**:
`RegQueryValueEx` expects an answer before the instruction retires. Options,
in order of preference:

1. **Snapshot at process start** into shared memory; treat writes as
   fire-and-forget to the main thread. Registry contents are small (INI-scale).
2. `Atomics.wait` round-trip to the main thread. Correct, simple, and blocks a
   worker for a full main-thread turn — acceptable for registry, unacceptable
   for anything per-frame.
3. Move the store to IndexedDB, which workers can reach — still async, so it
   only helps if combined with (1).

### 3.3 Win32 semantics constrain the partition, helpfully

Win32 is not symmetric about threads, and that is a gift here:

- **Window ownership is per-thread.** A window belongs to the thread that
  created it, its messages are delivered on that thread's queue, and its
  wndproc runs there. So `WND_RECORDS`, `CLASS_RECORDS` and `TIMER_TABLE` can
  stay single-owner instead of locked — they belong to the UI thread, which is
  the thread that created the windows in every app in the corpus.
- **`SendMessage` across threads blocks the sender** until the receiver's
  wndproc returns. That is exactly `Atomics.wait` on a request slot, and it is
  the *documented* behaviour, not an emulator compromise.
- **`PostMessage` is asynchronous** and per-target-thread — an SPSC ring per
  thread, no lock.
- **GDI objects are process-global** but per-object serialised. A coarse lock
  around the object table is authentic enough; real GDI serialised too.

The upshot: the interesting apps (a UI thread plus one or two compute/audio
workers) map onto this cleanly. What we must not promise is two threads
drawing to the same DC in parallel; real Windows didn't either.

### 3.4 Cross-origin isolation is a deployment gate

Handing a shared `WebAssembly.Memory` to a Worker requires
`crossOriginIsolated`, i.e. both headers on every response:

```
Cross-Origin-Opener-Policy:   same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Neither is set anywhere today (`tools/dev-server.js` sets none; nothing in the
tree mentions COOP/COEP). Locally that is a two-line change. **On
wine-assembly.berrry.app it is unknown whether headers can be set at all**, and
if they cannot, this design ships to localhost only. `require-corp` also breaks
any cross-origin subresource that lacks CORP — worth auditing before starting.

Measured 2026-08-16, `curl -sI https://wine-assembly.berrry.app`:

```
HTTP/2 200      server: cloudflare      x-render-origin-server: Render
(no cross-origin-opener-policy, no cross-origin-embedder-policy)
```

So production is **not** isolated today. Two mitigating facts:

- The page has no cross-origin *subresources* — the only external URLs in
  `index.html` are two anchor `href`s (berrry remix link, GitHub). So
  `require-corp` would break nothing in the page itself.
- If the platform cannot set headers, a **service worker can synthesise them**
  for the documents it serves (the `coi-serviceworker` pattern): the SW
  intercepts the navigation and adds COOP/COEP to its response, which is what
  the browser uses to decide isolation. Costs one extra reload on first visit,
  and is how projects on header-less hosts (GitHub Pages) ship SAB today.

That downgrades the gate from "fatal" to "one of two known paths", but it still
has to be *proved* on the real host, in Safari as well as Chrome, before phase 1
is worth starting.

---

## 4. Target architecture

```
   MAIN THREAD (broker + compositor, never runs guest code)
  ┌──────────────────────────────────────────────────────────┐
  │ input events ──▶ input ring (shared memory)              │
  │ audio ring ◀── drained to AudioContext                   │
  │ registry/INI broker (Atomics.wait responder)             │
  │ composite: offscreen surfaces ──▶ screen canvas, z-order │
  │ window table / class table / timers  (single owner)      │
  └──────────────────────────────────────────────────────────┘
        │ postMessage: Module + Memory (once, at spawn)
        ▼
  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
  │ WORKER tid=0  │  │ WORKER tid=1  │  │ WORKER tid=2  │
  │ main guest    │  │ CreateThread  │  │ CreateThread  │
  │ thread        │  │               │  │               │
  │ instance+     │  │ instance+     │  │ instance+     │
  │ imports       │  │ imports       │  │ imports       │
  │ own 4MB code  │  │ own 4MB code  │  │ own 4MB code  │
  │ cache         │  │ cache         │  │ cache         │
  └───────────────┘  └───────────────┘  └───────────────┘
         └──────── one shared WebAssembly.Memory ─────────┘
              sync table (Atomics) ── unchanged
```

Each worker runs its own uninterrupted `run(steps)` loop. No wall-clock
budgets, no quantum tuning, no input-wake heuristics — those five scheduling
knobs in `host.js` all delete.

The guest's own thread is a real thread, so `Sleep`, `WaitForSingleObject` and
`SendMessage` become genuine blocking calls (`Atomics.wait`) instead of yields
that unwind to the JS event loop. That removes the yield-reason state machine
for the blocking cases, which is a simplification, not just a move.

---

## 5. Phases

Real threads from the start, as asked — but the first phase is one worker
because the *proof* is the second one.

### Phase 0 — answer the gate (hours)
- Does berrry.app allow COOP/COEP? If not, decide whether localhost-only is
  acceptable before spending the rest.
- Add both headers to `tools/dev-server.js`, assert `crossOriginIsolated` in a
  test.

### Phase 1 — the guest main thread moves off the UI thread (the real work)
- Worker bootstrap: `postMessage({module, memory})`, instantiate in worker.
- Broker: input ring, audio ring, registry snapshot + writeback, log/trace
  forwarding.
- Compositor: main thread owns the screen canvas and blits offscreen surfaces;
  workers never touch the screen.
- Fix `$free_list` and `$virtual_alloc_top` (§3.1) — required, and correct
  regardless.
- **Exit criterion:** corpus green, and the perf HUD shows `page fps` unchanged
  while `GAME fps` is unaffected by continuous mouse movement — the exact
  measurement that caught `b7b4d4e`.

### Phase 2 — N workers actually running at once
- `CreateThread` spawns a Worker instead of an in-process instance.
- Lock the coarse shared tables (DX/COM, sockets, GDI objects).
- Cross-thread `SendMessage` over `Atomics.wait`.
- **Exit criterion:** a two-thread app shows >1.0× aggregate steps/sec versus
  phase 1 on a multi-core box, and Winamp's decoder thread stops underrunning
  under UI load.

### Phase 3 — cleanup
- Delete the scheduling heuristics, the input-wake gate, `runBudgeted`'s
  wall-clock caps, and the `_isAudioHot`/`_hasOpenMenu` priority hacks.
- Node/CLI parity: `test/run.js` needs the same broker shape, or an explicit
  single-threaded mode.

---

## 6. How we know it works

The instrumentation for this already exists, which is the one piece of luck in
this plan:

- `lib/perf-hud.js` reports `GAME fps` (guest-presented frames) separately from
  `page fps`, plus per-phase step timing and x86 throughput. Phase 1's whole
  claim is "GAME fps stops depending on what the UI thread is doing", and that
  is directly the graph.
- `?debug&perf&perf-stream` (or Ctrl+Alt+S) streams a real session to
  `tools/dev-server.js`. Every threading change should be A/B'd against a
  recorded human session, not only against scripted runs — the starvation bug
  was invisible to every headless test precisely because no script moves a
  mouse for 30 seconds.
- `--trace-sched` already prints one line per change in the set of thread
  states. Under real threads it becomes the primary debugging tool for lock
  contention and lost wakeups.
- `test/run-all.sh` + the 107-app corpus is the regression gate. Threading bugs
  are probabilistic, so the corpus needs to run repeatedly, not once.

**Determinism is the thing we lose.** Today a run is reproducible; with real
threads it is not, and a flaky corpus failure becomes "which interleaving".
Mitigation: keep a single-threaded mode (workers disabled, current round-robin)
as the default for CLI tests, and make threading an explicit opt-in that the
browser turns on. That also keeps `test/run.js` viable without a broker.

---

## 7. Risks

| Risk | Severity | Note |
|---|---|---|
| COOP/COEP unavailable in production | **fatal to the plan** | check first (Phase 0) |
| Safari: worker + shared memory + OffscreenCanvas | high | Safari is half the reported jank; must be tested early, not last |
| Registry synchronicity | medium | snapshot approach (§3.2) avoids blocking, but INI writeback ordering needs care |
| Non-determinism in tests | medium | keep single-threaded mode for CLI |
| Debugger/tracing regressions | medium | `--break`, `--trace-at`, memory dumps all assume synchronous access to instance state |
| Guest memory races surfacing | low | authentic; apps that break were broken on Win98 too |
| Effort | high | phase 1 is a broker for every non-pure import — weeks, not days |

---

## 8. Rejected alternatives

- **Keep everything on the main thread and tune the scheduler.** That is what
  `b7b4d4e` did. It works, and it will keep producing bugs of the same family:
  every new app is a new balance between input latency and guest throughput.
- **One worker for everything, guest threads still cooperative** (previously
  labelled "stage 1"). Cheaper, and captures the UI-immunity win, but it does
  not make guest threads concurrent, so audio-under-load and multi-core stay
  unfixed. It is a strict subset of phase 1 here, so nothing is wasted by
  aiming at the full design and stopping early if needed.
- **`wasm` threads with a single instance and `pthread`-style stacks.** Would
  mean one instance executing on many threads, which the interpreter's
  per-instance globals (registers, EIP, flags) fundamentally cannot do: those
  globals *are* the CPU state, and there is one CPU per guest thread.
