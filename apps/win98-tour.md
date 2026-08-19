# Win98 Tour — Progress

**Binary:** `test/binaries/win98-apps/tour98.exe`

**Status (2026-06-14):** Still `knownBadRender`, but the first blocker is clearer. The app is `dw98stub`, not the tour payload itself. It now finds the Win98 Setup registry key and reads `SourcePath`, then fails because `Discover.exe` is not present in the checked-in Win98 app bundle.

Current artifact:

- Before the registry seed: message box title `dw98stub -- error opening reg key`, missing `SOFTWARE\Microsoft\Windows\CurrentVersion\Setup`.
- After the registry seed: message box title `Discover Win98 Helper`, reporting that `Discover.exe` was not found under the setup source path.

Next work:

- Add the real `Discover.exe`/tour asset set to the VFS test bundle, or map the original CD `tour` directory if available.
- Keep `Win98 Tour` demoted until it renders the actual tour UI rather than the helper error dialog.
