# Frozen session recording

Record an agent-driven frozen emulator session as a video that plays back as
continuous realtime gameplay. Frames *and* audio are reconstructed on the
**guest** timeline, so hours of agent deliberation between steps vanish and the
result looks like a human played it live.

Companion to [design-agent-control.md](design-agent-control.md), which is where
frozen mode itself is described.

## Why not lib/recorder.js

`lib/recorder.js` wraps `MediaRecorder` over `captureStream()` on the screen
canvas. That is exactly right for a person playing: the wall clock and the
guest clock are the same clock, and MediaRecorder's variable frame rate tracks
what the canvas actually did.

An agent driving a frozen session has a wall-clock profile nothing can be made
of. Measured: bursts of roughly 450 steps a second, separated by 30–90 seconds
of the agent thinking about its next move. `MediaRecorder` would faithfully
record the thinking — one long freeze-frame per move — and a five-minute
session of real play would come out as ninety minutes of stills.

So this is not a recorder in that sense at all. It is a **sampler plus an
offline assembler**, and the thing that makes an exact offline reconstruction
possible is the frozen contract itself.

## The timeline model

Two invariants, both of them properties of frozen mode rather than of this
feature:

1. **Pixels change only inside a step.** While frozen, `host.js`'s drive loop
   holds its continuation in `_scheduleStep` and schedules nothing — no slice,
   no frame, no clock. `stepFrozen(n)` releases exactly `n` of them. Between
   steps the composited screen is a constant, which is the same property that
   makes `ctl png` byte-stable.
2. **Guest time is `sum(tickMs)` over the steps run.** A frozen host stops
   reading the wall and charges `_frozenTickMs` of guest time per executed step
   through `_advanceGuestTickMs`. `tickMs` can change between `step` calls
   (`step N MS`), so the recorder writes down the **actual per-step tickMs**
   with every frame rather than assuming a constant.

Given those, a session is completely described by: the picture after step *k*,
for every *k*; the guest time of step *k*; and the guest PCM submitted with the
guest time at which it started sounding. None of that references the wall
clock, so the reconstruction cannot contain agent think-time — not because it
is subtracted out, but because it was never a coordinate.

The pixel sampler runs every `k`-th step (default `k = 2`). With the default
`tickMs = 16` that is one frame per 32ms of guest time: **31.25 fps**, exactly.

## The two taps

### Frames — `host.js`, `frozenRecorder`

At the top of `_frozenPump`, on every `k`-th step: flush the deferred repaint,
blit the composited `#screen` canvas (cropping the exclusive-fullscreen fit box
back out, the same rect `lib/recorder.js` and `lib/agent-remote.js` use) into a
reused offscreen canvas, and hand *that* to `toBlob('image/jpeg', 0.85)`.

Three details that are load-bearing:

* The blit is **synchronous** and the encode is not. `toBlob` resolves later,
  by which time the guest may have stepped again — encoding the live canvas
  would tag frame *k* with the pixels of frame *k+3*.
* Frames are queued **before** their encoder resolves and drained only from the
  head, so the stream stays in guest order even though the encoders finish out
  of order.
* Nothing here may block stepping. A sink that falls behind hits
  `MAX_QUEUED_FRAMES` and frames are **dropped**, counted, and reported —
  converting a network problem into a memory problem would be worse, and the
  assembler holds the previous picture for a dropped frame's duration anyway.

Sampling happens *before* the step runs, so it captures the settled picture of
the step before it. That avoids waiting on a repaint the run loop may defer
indefinitely.

### Audio — `lib/host-audio.js`

Every sound this emulator makes is guest PCM arriving at one of two submit
seams, and both are already timestamped off `_audioClockMs()` — which in frozen
mode *is* the step-driven clock. So the tap is placed at the submit, and the
audio lands on the same timeline as the frames for free.

The tap is passive: it copies bytes, and never touches scheduling. A recorded
session sounds exactly like an unrecorded one. `ctx.audioTap()` returns null
unless a recording is armed, so an unrecorded session pays one property read
per buffer.

**waveOut (`voices.writeStream`)** is a *queue*: buffer *k* plays where buffer
*k−1* ended, and a stream that drained restarts at "now". That is the rebase
`v.nextTime` already performs against the `AudioContext` clock; the tap mirrors
it against the guest clock in `v.tapNextMs`. Placed before the
no-`AudioContext` early return, so a muted or headless page still records what
the guest submitted.

**DirectSound (`voices.playRing`)** is a *ring* the guest rewrites underneath a
play cursor. There is no need to invent a cursor model: `getPos()` already
derives that cursor from the guest clock —
`played = elapsed × bytesPerSec × rateScale`, wrapped modulo the ring length —
because a game polling `GetCurrentPosition` has to see it advance headlessly.
The tap mirrors exactly that arithmetic in `v.tapRing`, and emits the window
the cursor swept on every event that changes the ring:

| event | what the tap does |
|---|---|
| `Play` (loop 0/1) | flush the old ring's remaining window, start a new one at `v.snapshotStartMs` |
| `Unlock` refresh (`loop === 2`) | flush everything that played from the **old** content, then swap in what the guest just wrote — the cursor keeps going |
| `Stop` / `close` | flush, then clear |
| once per captured frame | `pumpAudioTap()` flushes every live ring |

That last row is what makes a held music loop record as music. A looping buffer
the guest never touches again would otherwise emit nothing until `Stop`.

Per-chunk gain is the voice's canonical `gainValue`, the WAVE bus, the master
bus and the mixer mutes the guest set through `mixerSetControlDetails`; pan uses
the canonical `panValue` with the equal-power law a `StereoPannerNode` applies.
Those two values exist even when the CLI has no `AudioContext`; browser
GainNode/StereoPannerNode parameters merely mirror them. This matters for RCT,
which attenuates its 1.2-second ride loops to roughly 3%: treating the absent
browser node as full gain makes that ring drown the music and sound stuck.

**MIDI needs a separate path.** The MIDI bus does not submit PCM at all — it is
synthesized in the browser by TinySynth, so there is nothing at a submit seam
to tap. Browser frozen capture still has that limitation. The direct CLI now
solves it by rendering MCI's parsed SMF notes with `lib/tinysynth-offline.js`
onto the same guest clock before the final audio mix.

## The sink — `tools/dev-server.js`, `/api/record/*`

Same shape as the `--perf-log` sink: the page posts, the server writes, one
directory per recording under `recordings/` (`--record-dir=DIR` to move it).

```
recordings/<session>/meta.json      what start/stop said
                    /frames.ndjson  {stepIndex,guestMs,tickMs,k,w,h,file,bytes}
                    /frames/*.jpg
                    /audio.ndjson   {guestStartMs,sampleRate,channels,bits,gainL,gainR,pcm}
                    /events.ndjson  optional input markers on the guest clock
```

| route | body |
|---|---|
| `POST /api/record/start` | JSON meta; answers `{session, dir}` |
| `POST /api/record/frames?s=ID` | binary `WAF1` container (below) |
| `POST /api/record/audio` | `{session, chunks:[...]}` — base64 PCM |
| `POST /api/record/events` | `{session, events:[...]}` |
| `POST /api/record/stop` | finalizes `meta.json`, prints the assemble command |

Frames go up as one **binary container** rather than base64 JSON: at 31fps a
recording is megabytes a second, and a 33% expansion is real cost on a path
that must not fall behind the guest. The format is deliberately trivial —
`'WAF1'`, then per frame `u32 headerLen`, header JSON, `u32 jpegLen`, JPEG.

Audio and events are small and irregular, so they stay JSON.

Driven from the agent channel exactly like `frozen` and `step`:

```sh
node tools/ctl.js -s ID frozen on
node tools/ctl.js -s ID record on [NAME] [--every=N]
#   ...click / step / click / step, for as long as you like...
node tools/ctl.js -s ID record off        # prints the session directory
node tools/frozen-video.js recordings/<session> --out=clip.mp4
```

`record on` is **refused on a live session**: a live session's clock is the
wall clock and `lib/recorder.js` is the right tool there. `GET /api/agent`
documents all of this as plain text, so a handoff need only carry the link.

### Headless CLI recording

The direct CLI control channel supports the same play shape without a browser:

```sh
node test/run.js --app=rct --control --frozen --tick-ms-per-batch=16 \
  --batch-size=200000 --quiet-api --quiet-blocks
node tools/ctl.js record on rct-run --every=2
node tools/ctl.js step 1000
# click / step / inspect for as long as needed
node tools/ctl.js record off
```

The CLI renderer streams RGBA frames directly to ffmpeg; a bare recording name
writes `recordings/NAME.mp4`, while a name ending in `.mp4` or `.webm` is used as
an explicit path. Its frame rate is derived from `--tick-ms-per-batch` and
`--every`, so wall-clock pauses between `step` commands never enter the video.
The same guest-clock PCM tap used by browser frozen recording collects waveOut
and DirectSound voices (including voices submitted by guest worker threads),
mixes them on the recording timeline, and muxes stereo AAC into MP4 or Opus into
WebM. MCI MIDI bypasses those PCM APIs, so the direct CLI renders its parsed
sequence offline with the bundled WebAudioTinySynth quality-1 GM timbre tables;
program changes, channel volume/pan, percussion, envelopes, and ambience remain
deterministic on the same guest clock. A silent audio track is still written when the guest produces no sound,
so every finalized CLI recording has a stable video+audio stream contract.

`tools/compare-tinysynth-offline.js` is the quality/performance oracle. It
renders the same MIDI segment twice: once through the production TinySynth
AudioNode graph in a browser `OfflineAudioContext`, and once through the CLI
renderer. For the first 20 seconds of `PINBALL.MID` at 44100 Hz, the CLI output
is within 0.73 dB RMS level, 0.70 dB brightness, and 1.79 dB stereo side/mid of
the browser output; their 20 ms loudness envelopes correlate at 0.72. Raw
sample correlation is intentionally not a target because TinySynth creates
its noise and convolution impulse with `Math.random()`.

The full 14139-note, 527.87-second score is the performance fixture. At the
CLI's 16000 Hz recording rate it rendered in 4.22 seconds (125.1x realtime),
versus 18.64 seconds (28.3x) before timbre compilation, envelope recurrences,
and oscillator tables — 4.42x faster on the same machine. Reproduce either
measurement without opening a browser:

```sh
node tools/compare-tinysynth-offline.js --seconds=9999 --rate=16000 --offline-only
```

## The assembler — `tools/frozen-video.js`

```
frames + audio + per-step tickMs  ->  H.264 + AAC mp4, +faststart
```

**Video.** Per-frame durations come from the *recorded* guest times, written
into an `ffconcat` file — that is what handles a `tickMs` changed mid-recording
and a dropped frame (whose predecessor simply holds for longer). The output is
then resampled to a constant rate with `-r`, and that rate is given as an
**exact rational**: `1000/(tickMs*k)`, e.g. `1000/32` for 31.25fps. Writing
`-framerate 31` instead drifts about a second and a half out of sync with the
audio over a five-minute clip, which is the whole reason the rational is spelled
out. The concat demuxer ignores the final entry's duration, so the last frame is
listed twice.

**Audio.** All tapped PCM is mixed offline onto the guest timeline into one
WAV: each chunk placed at its `guestStartMs`, linearly resampled to 44100 if
its rate differs, scaled by its recorded gains, summed as float, clamped, and
TPDF-dithered to s16. Gaps with no audio are silence, because that is what the
guest produced — nothing is stretched to fit the video. Linear resampling is
adequate here: the material is game effects and tracker music, much of it 8-bit,
and the interpolation error sits below the source's own quantization.

Then one mux. ffmpeg discipline is `tools/twitter-clip.js`'s: **ffmpeg writes
its diagnostics to stderr and exits 0 on plenty of things that are not
success**, so every invocation checks the status *and* keeps the stderr to
quote in the failure message. `astats` in the test reads from stderr for the
same reason.

## Limits

* Browser-side MIDI and audio an imported media file plays through `<audio>`
  are not at a PCM submit seam and are not captured by the browser frozen
  recorder. Direct CLI MCI sequences are the exception: they use the offline
  TinySynth companion described above.
* Non-frozen tiles keep `lib/recorder.js`; nothing here changes them.
* Frames dropped under sink backpressure are counted in `record status` and
  reported by `record off`. A recording that reports drops is still coherent —
  the assembler holds the previous picture — but it is not smooth.
* The sampler samples the **composited screen canvas**, so it records what the
  page shows, including page chrome inside the canvas. Exclusive fullscreen is
  cropped back to guest resolution; a windowed desktop is recorded whole.
* Only 8- and 16-bit PCM is decoded, which is everything the guest submits.

## Test

`test/test-web-frozen-recording.js` (WEB tier) drives a real Chrome against a
real dev-server on port 8095, records a frozen `dxball`, and assembles the
result. Its headline assertion is the duration one: the mp4 must be as long as
the **guest** ran (steps × tickMs, ±5%) even though the test deliberately sits
idle for four seconds mid-recording the way an agent does. A wall-clock
recorder would put those four seconds in the file. It also asserts the exact
rational frame rate, that an idle stretch adds neither frames nor guest time,
that frame guest times increase strictly `k` steps apart, that an AAC track
exists at all, and — when the run tapped any guest PCM — that the track has
nonzero RMS. Skips cleanly without Chrome, puppeteer, or ffmpeg/ffprobe.
