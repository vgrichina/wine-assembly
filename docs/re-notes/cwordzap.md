# Classic WordZap local idle audit

2026-09-10, source304, headful Chrome,1280x900. Game/Start command40003 alone
is not proof of a running round: it shows the startup art/instruction overlay.
Use the actual ready click at285,455 after Start (same route as the existing
desktop playability test). Game/Pause is command40004, from the actual menu.

After that route the board shows blank letter tiles and a **Resume** button;
before/after client images are pixel-identical over15s. Renderer CPU1.40%,
main slices332 ->634 (about20 queue parks/s), no errors. Host load10.71 means
no-spin evidence, not precise quiet-machine timing. Raw screenshots/JSON:
`/private/tmp/wa-idle-cwordzap-pause304`. Startup/Start-only sample0.98% in
`wa-idle-puzzles-start304` is deliberately not counted as an active board.

The real title labels it "The Action Word Game"; paused-state verification
avoids treating its competitive word generation as a static turn-based wait.
Existing `test/test-cwordzap-gameplay.js` covers actual valid/invalid submissions
and dialog recovery through deterministic CLI coordinates.
