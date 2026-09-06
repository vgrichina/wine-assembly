# Wine-Assembly articles: how a Windows 98 emulator in WebAssembly works
<!-- description: Short articles on how a Windows 98 emulator in WebAssembly Text works: the x86 interpreter, lazy flags, real DLLs, the Win32 API, GDI, DirectX, Win16 and more. -->

Wine-Assembly runs real Windows 98 programs in the browser: an x86 interpreter, a Win32 API layer, a software GDI, DirectX and a 16-bit loader, all written directly in WebAssembly Text. These articles each answer one question about how it is built. They are drawn from [the full project story](/story.html) and the [design docs](/docs/), and are shorter than either.

## The machine

- [How to write an x86 interpreter in raw WebAssembly Text](/articles/x86-interpreter-in-webassembly-text.md)  
  <small>Threaded code through `call_indirect`, the block cache, what a dispatch costs, loop super-ops, and the optimisations that measured as nothing.</small>
- [Lazy flags: how an x86 emulator avoids computing EFLAGS after every instruction](/articles/lazy-flags-x86-emulator.md)  
  <small>Four globals instead of a flags register, the bugs the scheme produced, and a second implementation's numbers.</small>
- [Letting the compiler own the memory map: WATX](/articles/watx-compiler-allocated-memory-map.md)  
  <small>Why 170 hand-placed hex bases became untenable, what the extended WAT adds, and how the cutover was verified.</small>
- [A DOS emulator in WebAssembly built to answer interpreter-design questions](/articles/dos-emulator-in-webassembly-toy-vm.md)  
  <small>The toy VM: 199 DOS programs, three execution tiers, and what a region JIT found.</small>

## The operating system

- [Loading real Windows DLLs in the browser](/articles/loading-real-windows-dlls-in-the-browser.md)  
  <small>MFC42, msvcrt, d3drm: relocations, ordinal imports, DllMain, and the runtime patches that were not obvious.</small>
- [Implementing the Win32 API in WebAssembly](/articles/win32-api-in-webassembly.md)  
  <small>3,300 handlers, one generated dispatch table, continuation thunks for calls that call back, and the no-silent-stubs rule.</small>
- [A software GDI in WebAssembly](/articles/software-gdi-in-webassembly.md)  
  <small>Why the canvas 2D API was the wrong target, and the rasteriser, regions, paths and fonts that replaced it.</small>
- [DirectDraw and Direct3D in the browser](/articles/directdraw-direct3d-in-the-browser.md)  
  <small>COM vtables through the thunk zone, surfaces as memory, palettes, and three generations of Direct3D.</small>
- [Running 16-bit Windows 3.x programs in the browser](/articles/running-16-bit-windows-apps-in-webassembly.md)  
  <small>An NE loader, segmented execution, and Pascal-convention Win16 dispatch.</small>
- [A virtual LAN for Windows 98 multiplayer games](/articles/virtual-lan-multiplayer-in-the-browser.md)  
  <small>Winsock in WAT over a frame wire, and what Hearts and Liquid War needed.</small>

## The process

- [Driving a Windows 98 emulator from a script](/articles/driving-a-windows-98-emulator-from-a-script.md)  
  <small>Headless runs, frozen mode, the JSON control channel, agent handoff, and bring-your-own media.</small>
- [Building an emulator with AI coding agents](/articles/building-an-emulator-with-ai-coding-agents.md)  
  <small>What 3,700 commits with Claude Code and Codex taught about crashes, tracing, negative results and shared trees.</small>
