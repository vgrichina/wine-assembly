# The Elder Scrolls: Arena (GOG)

## Source and fixture boundary

The local fixture comes from the Internet Archive `gog_collection` item pinned
in `test/candidate-corpus/manifest.json`. Its RAR is 81,068,818 bytes with
SHA-1 `aa8f357433ea5c07a9ebda4c6dd062b53348f57b`; the contained GOG offline
installer is `setup_the_elder_scrolls_arena_1.07_(28043).exe`, 81,068,584
bytes. GOG listed Arena for USD 0.00 when this corpus was verified, but the
package remains proprietary and gitignored. Nothing here grants redistribution
rights for the installer or extracted game.

## Direct installer path

The original PE32 Inno wrapper was executed directly in Wine-Assembly, without
host Wine. It extracted a 1,343,072-byte child and requested this exact command
line:

```text
/SL5="$10001,80468877,192512,C:\setup_the_elder_scrolls_arena_1.07_(28043).exe"
```

Running that child with the original installer mounted at the named `C:` path
found two Wine-Assembly defects:

- Inno called `VirtualQueryEx((HANDLE)-1, 0x00400000, ...)`; Wine-Assembly had
  `VirtualQuery` but no current-process `VirtualQueryEx` wrapper.
- The launcher stages up to 200 command-line bytes at raw WASM address `0x300`.
  That range overlaps the low immutable-string block and changed the bytes at
  `0x36d` from `uxtheme.dll` to part of `/NORESTART`. `LoadLibraryW` therefore
  returned the executable image base for the optional theming DLL, after which
  VCL called a null `IsThemeActive` pointer at installer VA `0x00439550`.

`VirtualQueryEx` now delegates the current-process pseudo handle to
`VirtualQuery` and rejects external handles. Extra command-line staging now
lives in the documented free 256-byte region at `0x07f0a500`. The wide
`uxtheme.dll` check also uses a Boolean non-null predicate; WebAssembly's
`i32.and` is bitwise, so directly ANDing a naturally even UTF-16 pointer with a
successful `1` comparison incorrectly produces zero.

With `--winver=win2k`, the unchanged installer proceeds through the GOG wizard
and extracts its custom UI assets. Full interpreted decompression is extremely
slow: a bounded 300-second run retired 321,772 Win32 API calls and reached the
two slideshow JPEGs, but had not reached the game payload. After proving that
direct path, the existing local `innoextract` build extracted the same package
for the runtime acceptance. This is a throughput workaround, not host Wine.
The ignored extracted tree is about 117 MiB.

## Bundled DOSBox runtime

The package contains the original 32-bit Windows `DOSBOX/DOSBox.exe`, version
0.74-2.1. `test/configs/arena-wine-assembly.conf` deliberately selects
`core=dynamic`, mounts the extracted root as both a writable `C:` drive and a
CD-ROM `D:` drive, then launches `ACD` from `D:` while setting `ARENADATA=C:`.
Launching from `C:` is not equivalent: Arena prints `TES: Arena can only be run
from a CD-ROM drive` and returns to the shell.

The bounded acceptance runs that Windows DOSBox inside Wine-Assembly, retains
`Program: ACD`, and captures a rendered 640x400 game frame. The accepted frame
has at least 50 colors, over 250,000 non-black pixels, and fewer than 5,000
black pixels. The two diagnosed DOS shell/error frames had only 9-10 colors and
about 133,000 black pixels.

```sh
node test/test-arena-dosbox.js
```

