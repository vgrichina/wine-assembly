# Wine-Assembly

Run real Windows 98 executables in your browser. No source port, recompilation, or OS image — the WebAssembly interpreter executes their x86 machine code directly.

<a href="https://www.producthunt.com/products/wine-assembly?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-wine-assembly" target="_blank" rel="noopener noreferrer"><img alt="Wine Assembly - Run Windows apps securely in browser using WebAssembly | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1142094&amp;theme=light&amp;t=1778312100355"></a>

**Live demo:** https://wine-assembly.berrry.app  
**Project story:** [PROJECT_STORY.md](PROJECT_STORY.md) — the history from the first decoder experiment through the current ~1,400-commit platform, reconstructed from Git and the Claude Code/Codex sessions that built it.

Wine-Assembly is an x86 PE interpreter coded directly in WebAssembly Text (WAT), without compiling the emulator from C or Rust. It loads unmodified Win32 `.exe` files, decodes x86 instructions into a Forth-style threaded code representation, and executes them while reimplementing the Win32 API surface needed by each application. Large parts of the reverse engineering, implementation, testing, and documentation were developed in collaboration with Claude Code and Codex.

## What Works

- **Notepad** — full text editing, menus, help system
- **WordPad** — native RichEdit editing, formatting, find/replace, clipboard, RTF and plain-text file workflows, printing compatibility, and bounded static OLE/DIB image support
- **Calculator** — standard and scientific modes
- **Solitaire, FreeCell** — card games with full GDI rendering
- **Minesweeper** — both Win98 and XP versions
- **SkiFree** — sprite animation, timer-driven gameplay
- **Paint** — Win98 build supports all 16 tools, BMP save/open, dirty-document prompts, large-image scrolling, and focused browser coverage; exact brush-option glyphs and non-antialiased GDI edges remain in progress, and the NT build remains partial
- **Entertainment Pack** — Golf, Reversi, Pegged, Taipei, TicTactics, Rattler Race
- **Space Cadet Pinball** — playable, table renders and physics run
- **Winamp 2.91** — skinned multi-window UI, MP3 playback, visualization, and preferences/about flows; both 2.91 and 2.95 installers have interactive coverage
- **Win98 accessories** — RegEdit with TreeView/ListView and registry enumeration; Sound Recorder with browser microphone capture/playback; Volume Control connected to shared Wave/MIDI buses; Task Manager operating on real multi-app desktop windows
- **DirectDraw / Direct3D** — Marbles, a broad DirectX 5 SDK sample set, nonblank Organic Art screensaver frames, and focused startup/render paths for Age of Empires, RCT, MCM, MW3, and Abe
- **MFC apps** — via real msvcrt.dll + mfc42u.dll loaded with relocations

The full smoke matrix currently tracks 114 binaries. Its latest recorded complete run reported 81 PASS, 29 WARN/known-limited, 4 expected 16-bit skips, and no unexpected crashes; focused tests go much deeper than that startup/frame gate for the apps called out above.

## How It Works

1. **PE Loading** — Parses the PE header, maps sections into WASM linear memory, resolves imports via an FNV-1a hash table mapping API names to handler IDs.

2. **x86 Decoding** — Each basic block of x86 code is decoded into a sequence of `(opcode, operand)` pairs stored in a threaded code cache. The `$next` function dispatches opcodes through an indirect call table.

3. **Lazy Flags** — Instead of computing CPU flags after every instruction, the operands and operation type are saved. Flags are computed on-demand only when actually read (e.g., by a conditional jump).

4. **Win32 API** — Each imported API function is replaced with a thunk. When execution reaches a thunk, a `br_table` dispatches to the corresponding WAT handler that reimplements the API behavior.

5. **GDI Rendering** — Window/control state, regions, clipping, and an increasing share of raster behavior live in WAT. JavaScript resolves browser surfaces, uploads pixels, composites windows, and still provides Canvas text and compatibility paths while deterministic software GDI replaces Canvas vector rasterization incrementally.

6. **DLL and COM/OLE Support** — Real Win32 DLLs (including msvcrt.dll, MFC, common controls, and RichEdit fixtures) load with relocations and import patching. The WAT compatibility layer also implements bounded COM, OLE data transfer, in-memory structured storage, and static-object persistence.

## Quick Start

### Browser

```bash
bash tools/build.sh
python3 -m http.server 8080
# Open http://localhost:8080/index.html
```

Select an application from the dropdown and click Launch.

On iPhone/iPad, open the live demo in Safari and use **Share → Add to Home Screen** to launch it as a standalone web app without Safari tabs/address bar. Touch input is mapped to the Win98 mouse, and text input uses a hidden keyboard proxy so the iOS software keyboard can type into canvas-backed controls like Notepad.

#### Safari Private Browsing

Safari Private Browsing's advanced tracking and fingerprinting protections can make Wasm execution extremely slow. Bricks and Spider may look hung for roughly a minute even though they are still progressing. In Safari, choose **View → Reload Reducing Privacy Protections** for the affected page, or use a non-private window. For measurements, ruled-out causes, and the local probe, see [docs/safari-private-browsing.md](docs/safari-private-browsing.md).

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

The entire interpreter is written directly in WAT (WebAssembly Text Format) — no C/Rust source toolchain. The repository's JavaScript WAT compiler builds the module. The host environment (browser or Node.js) provides:

- Canvas presentation, text rendering, and remaining GDI compatibility paths
- File I/O (reading executables, help files, DLLs)
- Input handling (keyboard, mouse, touch, and mobile software-keyboard proxy)
- Timer management

Everything else — x86 decoding, memory management, PE/DLL loading, Win32 API and COM/OLE implementation, structured exception handling, window/control logic, and software-raster foundations — is implemented in about 80,000 lines of WAT across 32 source parts. The current tail-call and compatibility builds are about 407 KB each. Supporting browser, test, and tooling JavaScript is about 73,000 lines.

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
docs/               Memory map, architecture/design notes, performance work
apps/               Per-app status and reverse-engineering history
```

## License

MIT
