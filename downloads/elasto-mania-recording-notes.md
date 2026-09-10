# Elasto Mania recording repair — 2026-09-10

Input: `/Users/vg/Downloads/wine-assembly-20260910194619.mp4`.

The original is 102.338 seconds, 2528×1534, H.264 Constrained Baseline,
149.0 MB, with no audio stream. The game picture fills this wide frame with
horizontal distortion; this is not a removable black-bar problem.

`elasto-mania-twitter-4x3.mp4` keeps both recorded levels:

- 16.010–56.100: Uphill Battle, including its finish and a brief result screen.
- 60.436667–88.856667: Long Haul, through the failed landing.

The startup, intervening loading screen and trailing menus are removed. Export:
1440×1080, square pixels, 4:3, 30 fps, H.264 High, CRF 18, capped at 12 Mbps,
MP4 faststart. Verified output: 68.533 seconds, 55,500,266 bytes, 30/1 fps,
1:1 sample aspect, 4:3 display aspect. No sound was recoverable from the source.

## Recorder diagnosis and fix

`lib/recorder.js` sized its canvas when Record was pressed, then resized that
same capture canvas inside `paintFrame()` whenever the source size changed.
Entering exclusive fullscreen changes the source from a browser-shaped desktop
to a cropped game image. The file retaining a desktop-shaped 2528×1534 frame
while stretching a 4:3 game is consistent with Safari retaining the encoder's
initial dimensions across that canvas resize. A Safari reproduction was not
performed, so the precise encoder behavior remains an inference.

The recorder now fixes the capture dimensions for the whole session and centers
each source with proportional scaling. If recording begins before the game
enters fullscreen, the fixed frame can contain bars; it cannot stretch the game.
Starting recording after the game has entered fullscreen chooses its aspect
from the outset. These are local source changes, not a deployed release.

Validation:

- `node test/test-recorder-aspect.js`: passes desktop, fullscreen, resized,
  portrait and single-app crop transitions. The original recorder fails this
  regression at the fullscreen transition because the capture surface resizes.
- `node tools/record-probe.js --app=elasto_mania --seconds=3
  --out=/private/tmp/elasto-recorder-fixed-probe.mp4`: real Chrome recording
  succeeded, source 1021×766, encoded 2042×1532, H.264 High, 3 seconds.
  This confirms the near-4:3 game source and a working browser encoder, not
  Safari-specific behavior or gameplay frame-rate performance.
- JavaScript syntax and focused diff whitespace checks pass.
- `test/test-web-pinball-assets.js` reaches an unrelated failure at line 203:
  `Bricks should expose brk1.dll as a runtime VFS file`. No Bricks files changed.

The export fits the published [X video upload limits](https://help.x.com/en/using-x/x-videos).

## Missing audio

The recorder previously collected guest AudioContexts exactly once, at Record.
If no guest had requested sound, it constructed a video-only MediaStream and
never checked again. The host deliberately creates audio lazily, so this loses
sound for games launched after recording starts or which initialize it later.

The recorder now creates a dedicated audio mixer and one stable output track
at Record. It discovers guest contexts every 250 ms and bridges their master
outputs into that mixer. Closing a guest context releases its tap without
ending the recording's audio track; stopping recording closes only the private
mixer and taps, preserving guest audio. The initial track carries silence until
a game produces sound. Guest discovery prefers the shell's live app list.

`node test/test-recorder-late-audio-web.js` passes with the real Chrome encoder:
initially silent audio track, late first guest tone, second guest after closing
the first, unchanged track count, and guest audio still running after Record
stops. ffprobe confirms one audio stream, and ffmpeg decoding measures a 0.231
peak in the saved audio. Artifact:
`/private/var/folders/dz/1fqkk_jd4350qkm91pm9_q3c0000gp/T/recorder-late-audio-6CYrg5/capture.mp4`.

The original MP4 has no audio samples to restore; the audio fix applies to new
recordings. These source changes have not been deployed.

Actual Elasto Mania verification: `/private/tmp/elasto-audio-probe.js` launched
the real game, began recording while no guest AudioContext existed, navigated
into Level 16 (New Wave), accelerated and reached the failure screen. The
recorder attached the 44100 Hz guest context after creation. The resulting
`/private/tmp/elasto-audio-real-game.mp4` has a stereo AAC track; full-track
ffmpeg `volumedetect` reports mean −40.8 dB and peak −14.9 dB. The final live
peak probe was zero because it ran on the silent result menu; decoding the
whole recording confirms the earlier real game sound was captured. No tone
was injected into this game run. The executable imports DirectSoundCreate.
