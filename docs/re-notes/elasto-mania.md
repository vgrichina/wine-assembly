# Elasto Mania 1.0

Registered executable: `test/binaries/candidates/elasto-mania/Elma/Elma.exe`,
app id `elasto_mania`, image base `0x400000`. Imports `DSOUND.dll!DirectSoundCreate`.

## Browser recording and sound (2026-09-10)

The game presents a 4:3 image. A user recording begun before fullscreen had
2528×1534 encoded dimensions and horizontally stretched gameplay. The recorder
resized its capture canvas on source transitions; it now fixes the session
dimensions and contains new sources proportionally. Safari retaining initial
encoder dimensions is the leading explanation, not a directly reproduced
Safari result. `test/test-recorder-aspect.js` fails against the old code and
passes with the fix.

Audio is lazy: at launch the WineAssembly instance has no `_audioCtx`. After
the guest requests audio, a 44100 Hz context appears. The old recorder checked
only once and therefore made a permanently video-only file when started early.
The recorder now owns a stable audio track from the start and attaches newly
created guest contexts during recording. Browser regression:
`node test/test-recorder-late-audio-web.js`.

Actual game verification used `/private/tmp/elasto-audio-probe.js`: start
recording immediately after launch, navigate through player/menu/level screens,
hold Up to accelerate in Level 16 (New Wave), then reach the failure screen.
The saved `/private/tmp/elasto-audio-real-game.mp4` contains real guest sound
(no injected tone): stereo AAC, mean −40.8 dB, peak −14.9 dB measured by ffmpeg
volumedetect. Sampling the result menu alone gives silence and is insufficient
to decide whether the game produces sound. Hold menu keys for about 250 ms in
automated probes; instant presses can be missed by this game's polled input
under load. The original user recording has no audio stream to recover.

Video repair details and cut points:
`downloads/elasto-mania-recording-notes.md`. Recorder fixes are local source
changes; this investigation did not deploy them.
