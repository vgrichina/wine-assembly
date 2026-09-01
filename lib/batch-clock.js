'use strict';

// Deterministic guest clock used by the headless batch runner. Calls within a
// batch may advance the clock, but resetting the per-batch call counter must
// never make the next GetTickCount/timeGetTime call go backwards. A small
// reversal makes unsigned Win32 timer arithmetic look almost 25 days overdue.
function createBatchClock(tickMsPerBatch, tickCallStepMs = 1) {
  const batchStep = Math.max(0, Number(tickMsPerBatch) || 0);
  const callStep = Math.max(1, Number(tickCallStepMs) || 1);
  // `pausedMs` is guest time the harness has decided elapsed OUTSIDE the batch
  // schedule -- currently only `--dx-lock-pause-ms`, which charges a primary
  // surface Lock/Flip the display's frame interval so a run can be measured
  // with presentation back-pressure. It shifts the whole clock (base AND the
  // per-batch ceiling below) by the same amount, so it can never make the
  // clock go backwards and can never break the ceiling invariant. It is 0
  // unless a flag set it, and then it costs one add per call.
  const state = { batch: 0, callsInBatch: 0, lastTick: 0, pausedMs: 0 };

  const batchTicks = () => ((state.batch * batchStep + state.pausedMs) | 0) & 0x7FFFFFFF;

  const getTicks = () => {
    const base = batchTicks();
    let candidate = ((base + (state.callsInBatch++ * callStep)) | 0) & 0x7FFFFFFF;
    // Calls may distinguish successive probes inside a batch, but they cannot
    // manufacture more time than the batch itself represents. Without this
    // ceiling, a tight PeekMessage/GetTickCount loop can keep a periodic timer
    // permanently due and never return to the application event queue.
    if (batchStep > 0) {
      const nextBase = ((((state.batch + 1) * batchStep + state.pausedMs) | 0) & 0x7FFFFFFF);
      if (nextBase > base && candidate >= nextBase) candidate = nextBase - 1;
    }
    if (candidate < state.lastTick && (state.lastTick - candidate) < 0x40000000) {
      return state.lastTick;
    }
    state.lastTick = candidate;
    return candidate;
  };

  return { state, batchTicks, getTicks };
}

module.exports = { createBatchClock };
