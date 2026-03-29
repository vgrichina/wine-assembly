# Wine-Assembly

x86 Windows 98 emulator in WebAssembly (WAT).

## Build

```bash
bash tools/build.sh
```

This concatenates `src/parts/*.wat` (alphabetical order) into `build/combined.wat`, then compiles with `wat2wasm` to `build/wine-assembly.wasm`.

When adding new handler opcodes to the thread table (`02-thread-table.wat`), remember to increase the `(table $handlers N funcref)` size to match the number of entries.

## Run

Open `host/index.html` in a browser. The WASM file is fetched from `../build/wine-assembly.wasm`.

## Architecture

- `src/parts/` — WAT source files, concatenated alphabetically
- `host/host.js` — JS host providing Win32 API imports
- `lib/renderer.js` — Win98 GUI renderer
- `lib/resources.js` — PE resource parser (menus, dialogs, strings, bitmaps)
- `lib/dll-loader.js` — DLL loading orchestrator
- `test/binaries/` — Windows executables for testing
