# EmPipe local idle audit

2026-09-10, source304, headful Chrome,1280x900. Game/New command100 resets the
title screen; it does not start the pipe board. Click **Next** at475,354,
held220ms, to start. Actual menu Game/Pause is101. After Pause the board has
START/FINISH pipes and the bottom button says Accelerate; no timers remain
(`next_timer_due_ms=-1`). Before/after board images are pixel-identical over15s.
The existing CLI route is in `test/test-empipe-start.js`.

Paused audible renderer CPU7.93% initially,9.77% repeat. Suspending only the
page AudioContext (diagnostic, never a source change) reduces this to0.70%.
The repeat wraps `_parkedSleepMs` without changing its result:198 calls in10s,
every returned delay50ms, yield7 and no timer. Audio-disabled repeat295 calls
in15s, also all50ms. Thus the normal paused host is sleeping; real music
synthesis accounts for most of the renderer cost, as in Heroes II.

Raw `/private/tmp/wa-idle-empipe-paused304`,
`/private/tmp/wa-idle-empipe-pause-audible304`, and
`/private/tmp/wa-idle-empipe-pause-diagnostic304`. No page errors.

An earlier host-phase-instrumented run recorded13791 scheduler turns/15s with
only0.2ms guest work and39.3ms total measured phases. This excessive wake count
was **not reproduced** by the subsequent audible or audio-disabled delay
census. Do not infer that audible playback requires900 guest polls/s. The
instrumented discrepancy remains to isolate; neither measurement changed
runtime code. The startup New-only screen likewise has zero main slices
during10s but9.57% renderer when music is playing.

Combined phase+delay census repeat (`wa-idle-empipe-combined304`) also sleeps
normally:296 turns/15s, every delay50ms, main slices71 ->71, wait polls59 ->355.
Guest/worker/present time all0; total host phases11.3ms. Renderer7.97% with
music, no errors. This rules out the phase hook alone as a sufficient cause
of the earlier anomaly; it does not establish why that earlier run differed.
Three subsequent measured paused runs now show the normal20Hz park cadence.
