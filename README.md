# Wine-Assembly

Run real Windows 98 executables in your browser. No emulation layer, no porting — just raw WebAssembly interpreting x86 machine code.

<a href="https://www.producthunt.com/products/wine-assembly?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-wine-assembly" target="_blank" rel="noopener noreferrer"><img alt="Wine Assembly - Run Windows apps securely in browser using WebAssembly | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1142094&amp;theme=light&amp;t=1778312100355"></a>

**Live demo:** https://wine-assembly.berrry.app  
**Project story:** [PROJECT_STORY.md](PROJECT_STORY.md) — a retrospective of the first ~810 commits in 34 days.

Wine-Assembly is an x86 PE interpreter written entirely in hand-crafted WebAssembly Text (WAT). It loads unmodified Win32 `.exe` files, decodes x86 instructions into a Forth-style threaded code representation, and executes them while reimplementing the Win32 API surface needed by each application.

## What Works

- **Notepad** — full text editing, menus, help system
- **Calculator** — standard and scientific modes
- **Solitaire, FreeCell** — card games with full GDI rendering
- **Minesweeper** — both Win98 and XP versions
- **SkiFree** — sprite animation, timer-driven gameplay
- **Paint** — basic drawing (NT version via MFC42/MSVCRT DLL loading)
- **Entertainment Pack** — Golf, Reversi, Pegged, Taipei, TicTactics, Rattler Race
- **Space Cadet Pinball** — playable, table renders and physics run
- **Winamp 2.95** — skinned UI, MP3 decode in flight (multi-thread)
- **Plus! 98 screensavers** — Marbles (DirectDraw 8bpp), Organic Art (D3D Retained Mode in progress)
- **MFC apps** — via real msvcrt.dll + mfc42u.dll loaded with relocations

## How It Works

1. **PE Loading** — Parses the PE header, maps sections into WASM linear memory, resolves imports via an FNV-1a hash table mapping API names to handler IDs.

2. **x86 Decoding** — Each basic block of x86 code is decoded into a sequence of `(opcode, operand)` pairs stored in a threaded code cache. The `$next` function dispatches opcodes through an indirect call table.

3. **Lazy Flags** — Instead of computing CPU flags after every instruction, the operands and operation type are saved. Flags are computed on-demand only when actually read (e.g., by a conditional jump).

4. **Win32 API** — Each imported API function is replaced with a thunk. When execution reaches a thunk, a `br_table` dispatches to the corresponding hand-written WAT handler that reimplements the API behavior.

5. **GDI Rendering** — Drawing commands (`TextOut`, `BitBlt`, `FillRect`, etc.) are forwarded to a JS canvas renderer that reproduces the Win98 look and feel, including 3D button borders, window chrome, and menu rendering.

6. **DLL Support** — Real Win32 DLLs (msvcrt.dll, mfc42u.dll) can be loaded with full relocation and import patching, enabling MFC applications.

## Quick Start

### Browser

```bash
bash tools/build.sh
python3 -m http.server 8080
# Open http://localhost:8080/index.html
```

Select an application from the dropdown and click Launch.

On iPhone/iPad, open the live demo in Safari and use **Share → Add to Home Screen** to launch it as a standalone web app without Safari tabs/address bar. Touch input is mapped to the Win98 mouse, and text input uses a hidden keyboard proxy so the iOS software keyboard can type into canvas-backed controls like Notepad.

### CLI

```bash
node test/run.js --exe=test/binaries/notepad.exe
```

Key flags:
- `--trace-api` — log all Win32 API calls
- `--png=output.png` — render final frame to PNG
- `--max-batches=N` — limit execution steps
- `--break=0xADDR` — break at x86 address
- `--break-api=Name` — break on API call
- `--verbose` — detailed logging

## Building

Requires Node.js. The project uses its own JS WAT compiler (`lib/compile-wat.js`) and writes both tail-call and compatibility WASM builds.

```bash
# Build
bash tools/build.sh
```

The build checks the handler table, concatenates `src/*.wat` in filename order for inspection, then compiles `build/wine-assembly.wasm` and `build/wine-assembly.compat.wasm`.

## Architecture

The entire interpreter is written in WAT (WebAssembly Text Format) — no C, no Rust, no compiler toolchain. The host environment (browser or Node.js) provides:

- Canvas rendering (GDI operations)
- File I/O (reading executables, help files, DLLs)
- Input handling (keyboard, mouse, touch, and mobile software-keyboard proxy)
- Timer management

Everything else — x86 decoding, memory management, PE loading, Win32 API implementation, structured exception handling, sprintf — is implemented in ~48,000 lines of hand-written WAT, compiling to a ~230 KB `.wasm` module.

## Project Structure

```
src/                WAT source files (compiled in filename order)
src/api_table.json  Win32 API name -> handler ID mapping
lib/                JS libraries (renderer, resource parser, DLL loader)
index.html, host.js Browser frontend
manifest.webmanifest, icons/
                    PWA/iOS Home Screen metadata and icons
test/               CLI test runner and test binaries
tools/              Build scripts, code generators, debug tools
docs/               Memory map, design notes
apps/               Per-app reverse-engineering progress (pinball.md, screensavers.md, ...)
```

## License

MIT
