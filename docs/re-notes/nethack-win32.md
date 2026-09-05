# NetHack 3.4.3 for Windows

This target is the native Win32 graphical build, `NetHackW.exe`, from the
official NetHack 3.4.3 package. The official download page identifies this
package for Windows 95/98 as well as later Windows versions. It is not a DOS
build.

## Original package

- Download page: <https://www.nethack.org/v343/ports/download-win.html>
- Official archive: <https://www.nethack.org/download/3.4.3/nethack-343-win.zip>
- Size: `2,046,488` bytes
- MD5: `b91739c9f101a787220853eae904941d`
- SHA-1: `5b8e4717fb18d7888678f54b47aafd0060bf576b`
- SHA-256: `c067acbca513961640e0064da21ec41359fda5150533ed53132012d188184ff7`
- `NetHackW.exe` SHA-256:
  `0da7a494f0f3c87b20227d4ff77f5e0964609efa3d43b70e11fea87e6adcb951`
- `nhdat` SHA-256:
  `ab99c6962e4e1057390c9916f9e99a1afc887f37e2cc3b17a5b96954217d03b1`

The archive contains the graphical and console executables plus 11 companion
files. It has no installer: its own `README` instructs users to unzip every
file into one directory. The candidate fetch recipe performs that documented
installation step on the unchanged official ZIP.

The included NetHack General Public License permits verbatim redistribution
when the copyright, warranty, and license notices remain intact and the stated
source-access conditions are met. The Sources page links the official package;
the fetched runtime remains a local, gitignored compatibility fixture.

## Compatibility fixes

NetHack opens files using drive-relative names such as `C:defaults.nh` and
`C:user-Codex.0`. Win32 resolves these against that drive's current directory.
The VFS previously treated the colon-relative spelling as a literal path, so it
could not find files mounted at `C:\`.

After that path fix, a missing save file still produced NetHack's **Bad
directory or name** error. `CreateFileA/W` returned `INVALID_HANDLE_VALUE` but
left `GetLastError()` at zero. The statically linked CRT translated that stale
value to `EINVAL`. Failed opens now publish `ERROR_FILE_NOT_FOUND`, allowing the
normal new-game path to continue.

The app also needs `HACKDIR=C:\`. Registered app environments are now applied
before DLL loading in both browser guest modes and by the CLI. An explicit CLI
`--env` value overrides the registered default.

## Gameplay gate

The gate selects a random character, dismisses the release notes and character
story, captures the tile dungeon, then sends cursor movement and requires a
pixel change inside the map. It launches one frozen CLI process, controls it by
streaming JSON over stdio, and relies on the CLI's own `--max-seconds` guard.

```bash
node tools/fetch-candidate-corpus.js --id=nethack-win32
bash tools/build.sh
NETHACK_SCREENSHOT=/private/tmp/nethack-gameplay.png \
  node test/test-nethack-win32.js
```
