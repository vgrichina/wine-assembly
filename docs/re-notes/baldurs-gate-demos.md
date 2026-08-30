# Baldur's Gate previews

Three distinct official previews are useful local-only Infinity Engine
fixtures. None of their payloads may be committed to this repository; their
pinned sources and extraction recipes live in `test/candidate-corpus/manifest.json`.

| Candidate | Executable | SHA-256 | Acceptance target |
|---|---|---|---|
| 1998 non-interactive demo | `BALDUR.EXE` | `0990036bae224526a535d3df9deacc306cb87add6f02b34342934ae43ce25caa` | 640x480 rendered promotional cinematic |
| Interactive demo 1.0.0 | `BGDemo.exe` | `ed7f1efd9df8d9a62c1a32f2598e8cc19e5dc601689aeebb72a3bc835db343d9` | create a character and reach selected-character Candlekeep gameplay |
| Chapters I & II 1.1.0003 | `BGMain.exe` | `af46f2dfa8a7637a4f55b9d77024e17e5fa02a1b0ff11838ba7473adb163c10f` | create a character and reach selected-character Candlekeep gameplay |

## Runtime findings

The Chapters build has two startup gates absent from the other packages:

- It calls `GetSystemDefaultLangID`, then
  `GetLocaleInfoA(LOCALE_SYSTEM_DEFAULT, LOCALE_SENGCOUNTRY, ...)`, and rejects
  any result other than `United States` or `Canada`. Returning the old generic
  locale placeholder therefore produced its genuine **Wrong Version** dialog.
  `LOCALE_SENGCOUNTRY` now follows Win32's size-query and insufficient-buffer
  contracts and returns `United States` in both ANSI and UTF-16 forms.
- It imports WinSock 1.1 through `WS2_32.dll` by ordinal. Ordinals 115 and 116
  are `WSAStartup` and `WSACleanup`; the loader previously exposed that ordinal
  table only for `WSOCK32.dll`. Treating both basenames as aliases clears the
  `<ord>` dispatch failure and reaches the real `JigSawedME` Infinity window.

Both playable builds use a borderless 640x480 DirectDraw window positioned at
`0,-23`. Their cinematics accept Escape/Space through the ordinary renderer
keyboard path. The interactive demo's main menu changes from `SINGLE PLAYER /
MOVIES / QUIT` to `NEW GAME / LOAD GAME / BACK` after a click at `(320,265)`;
the Chapters preview exposes the same interaction under its "Baldur's Gate
Abridged Chapters I & II" artwork.

Starting New Game in these old builds performs a large synchronous first load
of `Gui.bif`, `Creature.bif`, `CHAAnim.bif`, and the script resources. The
decoder thread also suspends itself while idle; self-suspension now yields to
the scheduler and resumes only after another thread calls `ResumeThread`.

Two Infinity Engine request handlers set a state-transition flag and then wait
for the outer game loop to clear it. A cooperative guest cannot run that outer
loop until the handler returns, so each preview has two verified executable
patches that jump over only those waits: one for New Game / Character
Generation and one for Accept / area entry. The outer loop then performs the
requested transition normally. The patches are executable-hash-specific in
practice and byte-verified before application; a different build is rejected.

The local acceptance walks Gender, portrait, Race, Class, Alignment,
Abilities, Skills, Appearance, Sound, and Name; accepts the character; dismisses
the Prologue panel; and captures Candlekeep. Its in-world assertion requires a
detailed 640x480 frame plus the selected character's green circle in the play
area, so a cinematic, main menu, or Character Generation panel cannot pass.

## Reproduction

Fetch all three candidate IDs, then run:

```sh
node test/test-baldurs-gate-demos.js
```

The test compiles one source snapshot, pins each executable hash, rejects
runtime failure markers, checks detailed 640x480 output, and requires both
playable builds to reach the in-world scene after injected keyboard and mouse
input. Screenshots are written under
`build/local-candidate-smoke/baldurs-gate-demos/`.
