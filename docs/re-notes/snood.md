# Snood 2.2W

Local app ids `snood` and `snood_installer`. The original package is
`test/binaries/candidates/snood/SnoodWin22Install.exe`; the optional installed
browser payload is beneath that directory at `installed/` and remains
gitignored.

## Provenance and terms

- Original-disc browser page:
  <https://discmaster.textfiles.com/browse/40163/PCH_1200.iso/program/spel/snood/SnoodWin22Install.exe>
- Direct original installer:
  <https://discmaster.textfiles.com/file/40163/PCH_1200.iso/program/spel/snood/SnoodWin22Install.exe>
- Installer size: 1,450,602 bytes.
- Installer SHA-256:
  `af87ef644d2a8d5a99f160ac522a7d318b0dc378285fd337c53dbf41c70db4ea`.
- Installed `snood.exe` SHA-256:
  `af45b6e77e95a20b26813f2e1a91bdc51cee2ad98b724d66288755f171b47bbd`.

The installed readme identifies this as the demonstration version. It permits
30 days of use and then requires registration or deletion. It does not contain
a public redistribution grant. The source recipe, installer, and installed
payload therefore remain local compatibility fixtures; no Snood binary is
committed or publicly deployed.

## Installer route

The authentic package is an outer Win32 bootstrap around Inno Setup 1.3.16.
The bootstrap writes a temporary installer and launches it with an `/SL2`
argument tied to the original package. This old bootstrap puts the executable
and arguments together in ShellExecute's file field, so the generic
`--capture-launch` detector does not apply. `test/test-snood-candidate.js`
instead parks at the frozen boundary immediately after ShellExecute, exports
the still-live outer-process VFS before cleanup deletes `INS*.tmp`, parses the
logged `/SL2` arguments, and runs that installer-created child inside Wine
Assembly while mounting the original package at the guest path from the
command line. All extraction happens in the emulator. The test clicks every
wizard page and **Finish**, exports the resulting VFS, and checks the installed
executable and trial text.

The installer exposed four emulator gaps: named-file VERSION.DLL resource
lookup, VCL owned-form activation, `FindNextFile` exhaustion setting
`ERROR_NO_MORE_FILES`, and historical unsuffixed Shell32 import aliases.

## Gameplay route

The installed game reaches the real shareware registration page, the optional
Gator offer, the title/high-score screen, and an interactive Medium board. The
game uses only the mouse: click **New Game**, move to aim, and click to fire.
The focused gate runs one frozen stdio-controlled process, starts a game, fires
a shot, requires more than 2,000 changed pixels, and checks that DirectSound
submitted nonempty snapshot voices.

Screenshots are written to `build/snood-candidate/`. To prepare the ignored
localhost browser tree while running the gate:

```bash
PREPARE_SNOOD_DEBUG_WEB=1 node test/test-snood-candidate.js
```
