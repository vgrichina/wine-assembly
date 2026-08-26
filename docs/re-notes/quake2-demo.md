# Quake II 3.14 demo

## Package and layout

- Local-only installer: `test/binaries/candidates/quake-2-demo-installer/q2-314-demo-x86.exe`
- Size: 39,015,499 bytes
- SHA-1: `5b4dedc59ceee306956a3e48a8bdf6dd33bc91ed`
- Format: WinZip Self-Extractor around a ZIP containing 277 files,
  59,005,373 uncompressed bytes.
- The installer defaults to
  `C:\WINDOWS\Desktop\Quake2 Demo`; the playable executable is
  `Install\Data\quake2.exe` beneath that directory.

The local dropdown uses a host extraction at
`installed-extracted/Install/Data/`. Its required runtime set is
`quake2.exe`, `ref_soft.dll`, `ref_gl.dll`, `baseq2/gamex86.dll`, and
`baseq2/pak0.pak`. `pak0.pak` is 49,951,322 bytes with SHA-256
`cae257182f34d3913f3d663e1d7cf865d668feda6af393d4ecf3e9e408b48d09`.

## Installer path

The package reaches its WinZip dialog after these formerly missing APIs:

- `OemToCharBuffA`
- `DialogBoxIndirectParamA`
- `GetWindowWord`

Start extraction through the normal guest input path:

```bash
/opt/homebrew/bin/timeout -s KILL 360 node test/run.js \
  --app=quake2_demo_installer --no-build --screen=800x600 \
  --max-batches=1000000 --max-seconds=330 --batch-size=20000 \
  --loop-superops --repaint-every=2000 --quiet-api --quiet-blocks \
  --input=5:0x111:1 --reg-export=/private/tmp/q2-installer-registry.json
```

`5:0x111:1` queues `WM_COMMAND/IDOK` for the guest pump. Do not use
`dlg-click` for this button: it synchronously enters the x86 WndProc from the
host and decompression legitimately exceeds that bridge's 64-round safety
limit.

On 2026-08-25 the run displayed `277 file(s) unzipped successfully`. A
case-insensitive path, length, and SHA-256 comparison against a direct ZIP
extraction reported 277 expected, 277 actual, and no missing, extra, or
mismatched files.

## Registry delta

The completed `--reg-export` snapshot contains 62 entries and is byte-for-byte
identical to a clean pre-extraction snapshot from the same app (SHA-256
`0571abe5d87e78d5934f966882e89710a1d75fbe5c66ddd37db9e1c392eeae1a`).
`tools/registry-snapshot-diff.js` reports no added or removed keys and no added,
changed, or removed values. This WinZip package only unpacks the 277 files; it
does not register Quake II or invoke the nested InstallShield setup. Therefore
the playable `quake2_demo` manifest needs no game-specific `startupRegistry`
entries.

## Launching the installer-produced copy

For an arbitrary extracted path, preload both native game DLLs; the app
registry's `quake2_demo` entry does this automatically for the dropdown:

```bash
/opt/homebrew/bin/timeout -s KILL 140 node test/run.js \
  --exe='/private/tmp/q2-install/windows/desktop/quake2 demo/install/data/quake2.exe' \
  --args='+set vid_ref soft +map demo1' \
  --vfs-include='baseq2/**,ref_soft.dll' \
  --dll-seed='/private/tmp/q2-install/windows/desktop/quake2 demo/install/data/baseq2/gamex86.dll,/private/tmp/q2-install/windows/desktop/quake2 demo/install/data/ref_soft.dll' \
  --no-build --screen=800x600 --max-batches=20000 --max-seconds=100 \
  --batch-size=20000 --no-close --png=/private/tmp/q2-gameplay.png
```

The exact installer-produced files load `gamex86.dll` and `ref_soft.dll`,
create the `Quake 2` window, and render `demo1` in the software renderer at
320x240, 8bpp. Running an arbitrary EXE without preloading `gamex86.dll`
fails with the game's own `FreeLibrary failed for game library` message; that
is an incomplete ad-hoc mount, not an emulator failure.

## Browser black-screen report

The browser must be tested separately from the CLI because DirectDraw pixels
pass through a per-window `_dxFrameLayer`, the desktop compositor, and
optionally the WebGL presentation canvas.

On 2026-08-25 the pre-fix manifest (`+set vid_ref soft`) produced non-black
gameplay in all fresh-profile probes: desktop 2D, desktop SwiftShader, hidden
runtime log, and an iPhone-sized page-fullscreen viewport. The fresh demo
automatically enters its attract map; no menu frame appears. The phone capture
has black top/bottom letterboxing around the 4:3 game, but the game crosses the
visible viewport centre and the canvas itself starts at the top of the
viewport.

The dropdown now passes `+set vid_ref gl +menu_main` so users see Quake's
ordinary main menu through the hardware-accelerated compatibility renderer.
The browser scheduler gives `quake2_demo` a 10,000-block slice. The generic
100,000-block default is unnecessarily coarse during immediate-mode startup;
10,000 keeps the renderer cooperative. The later first-frame exit reproduced
at both slice sizes, proving slice length was not its cause. The exact failure
was a missing dynamically resolved legacy presentation entry point, described
below.
`test/test-quake2-demo-web.js` explicitly overrides that production default to
`+set vid_ref soft +map demo1` inside its fresh page because it is the separate
software/DirectDraw gameplay regression. It drives the actual selector and
trusted Launch button, emulates iPhone page-fullscreen, asserts both Quake's own
DirectDraw layer and the visible browser screenshot are non-black, and compares
two raw game-layer frames to prove the demo world is moving rather than
accepting a menu or frozen loading plaque.

## OpenGL renderer gap

This was measured from `ref_gl.dll` and runtime API traces without consulting
Wine source. `ref_gl.dll` dynamically resolves the complete Windows OpenGL 1.1
table: 336 `gl*` names and 21 `wgl*` names. All 357 currently resolve to zero;
there is no OpenGL/WGL implementation in the runtime. That lookup count greatly
overstates the first playable target, because Quake's generated dispatch table
contains wrappers for every OpenGL 1.1 export.

Filtering those wrappers out of the binary's call sites leaves 48 GL functions
called by Quake's renderer code:

- Frame/state: `glAlphaFunc`, `glBlendFunc`, `glClear`, `glClearColor`,
  `glCullFace`, `glDepthFunc`, `glDepthMask`, `glDepthRange`, `glDisable`,
  `glDrawBuffer`, `glEnable`, `glFinish`, `glGetError`, `glGetFloatv`,
  `glGetString`, `glPointSize`, `glPolygonMode`, `glReadPixels`, `glScissor`,
  `glShadeModel`, `glViewport`.
- Immediate geometry: `glBegin`, `glEnd`, `glColor3f`, `glColor3fv`,
  `glColor4f`, `glColor4fv`, `glColor4ubv`, `glTexCoord2f`, `glVertex2f`,
  `glVertex3f`, `glVertex3fv`.
- Matrices: `glFrustum`, `glLoadIdentity`, `glLoadMatrixf`, `glMatrixMode`,
  `glOrtho`, `glPopMatrix`, `glPushMatrix`, `glRotatef`, `glScalef`,
  `glTranslatef`.
- Textures: `glBindTexture`, `glDeleteTextures`, `glTexEnvf`, `glTexImage2D`,
  `glTexParameterf`, `glTexSubImage2D`.

The platform code references seven standard WGL functions: `wglCreateContext`,
`wglDeleteContext`, `wglGetProcAddress`, `wglMakeCurrent`,
`wglChoosePixelFormat`, `wglDescribePixelFormat`, and `wglSetPixelFormat`.
This particular 1998 renderer additionally calls
`GetProcAddress("wglSwapBuffers")` and stores the result in its EndFrame slot.
That spelling is a legacy compatibility requirement of the shipped binary,
regardless of the normal Win32 `GDI32!SwapBuffers` API. Both names therefore
lower to the same backend-neutral presentation operation. Optional SGIS
multitexture, EXT paletted-texture/point, swap
interval, and NVIDIA gamma-ramp symbols can remain unavailable when the
synthetic `glGetString` advertises no extensions.

A rendered probe gets a valid Quake HWND/HDC and succeeds through the existing
`ChoosePixelFormat`, `SetPixelFormat`, and `DescribePixelFormat` handlers. It
then jumps to EIP zero on the first missing `wglCreateContext` call. The zero
HDC seen with `--no-renderer` is only a headless-canvas artifact, not a browser
blocker.

The implemented browser design is a fixed-function OpenGL 1.x frontend over a
generic WebGL/GLES-shaped backend, not a software renderer. It lowers immediate
mode into vertex batches, matrices into uniforms, texture/state operations into
backend resources, and owns WGL context/DC lifecycle plus per-window GPU
presentation. The reusable backend boundary is intentionally suitable for a
future hardware Direct3D frontend.

The focused backend/fixed-function/presentation tests and full API build pass.
In real Chrome, the authentic `ref_gl.dll` loads and
renders both the textured main menu and the GAME difficulty submenu at 640x480.
The production 10,000-block slice also reaches unmistakable Easy gameplay:
textured world geometry, weapon, crosshair, health, and ammo HUD all render.
A normal forward key changed 11,432 of 307,200 pixels between captured frames;
console scrolling, loading backgrounds, context creation, and menus do not
satisfy that acceptance.

## Runtime renderer switch

The dropdown now starts OpenGL directly. A separate lifecycle regression keeps
the user's reported transition path: it overrides only its test-page command
line to start the software-rendered main menu, opens Quake II's Video menu,
selects OpenGL, and Applies. It will distinguish an intentional renderer-DLL
unload/reload gap from a real `ExitProcess` or last-window teardown before
changing runtime semantics.

The first UI capture pins the important control: Right on the selected `driver`
row changes `[software]` to `[default OpenGL]`. Keyboard-only exploratory
probes initially returned to the main menu without applying. The decoded trace
proves that run only called `LoadLibraryA("ref_soft.dll")`, `ddraw.dll`, and
`dsound.dll`; it never requested `ref_gl.dll`, destroyed the window, or exited.
Per-step captures explain why: at the generic 100,000-block browser slice the
first six Down key pairs had not been observed when photographed, the seventh
finally moved the cursor to Reset, and Enter activated Reset rather than Apply.
Waiting until the host queue drained was still insufficient because Quake polls
key state and an immediate synthetic down/up can be invisible by the time the
guest checks it. Absolute mouse clicks likewise left the selection on `driver`.
The acceptance therefore lowers only the post-menu slice to 10,000 blocks,
holds each key across several cooperative slices, waits until its events drain,
saves all seven cursor positions (Reset is skipped by keyboard navigation), and
presses Enter on the real Apply row. This
changes scheduler granularity, not the production manifest, command line, or
renderer choice.

## First-frame OpenGL exit

The production cold start later regressed to a visible menu followed by
`EIP=0`. Instrumentation ruled out `ExitProcess`, `DestroyWindow`, last-window
grace shutdown, a WebGL exception, and missing optional extensions. The final
512 guest GL calls were valid texture uploads and immediate-mode menu quads;
the final one was `glGetError` returning `GL_NO_ERROR` inside ref_gl's exported
EndFrame routine at original VA `0x1000e060`. The next indirect call at
`0x1000e087` jumped through zero.

Static slot mapping identifies `[0x10052dbc]` as the result of
`GetProcAddress("wglSwapBuffers")`. Removing that legacy alias during an API
cleanup made the first real EndFrame call NULL before any present. Restoring
the name as a one-argument stdcall alias to generic GPU present fixes the exact
failure without a Quake-specific address patch. A focused regression now
asserts that the static GetProcAddress name table exposes it, its stack cleanup
is correct, and both it and `GDI32!SwapBuffers` reach opcode 55.

The next gameplay attempt exposed a separate generic bridge bug at runtime EIP
`0x00cab7d9` (ref_gl original VA `0x1000a7d9`), immediately before its
`glVertex3fv` call. The recorded vertex pointer was `0x4e306050`, in Quake's
high sparse `VirtualAlloc` arena. The old JS bridge subtracted the main image
base directly and produced host offset `0x4df18050`, outside the 512 MiB WASM
memory, causing the reported DataView bounds error. Pointer-bearing GPU calls
now use the emulator's exported canonical `$g2w` translator, which understands
the direct image window, DIB arena, and sparse mappings. The focused regression
maps that exact guest address to backing `0x10006050`, and the real Chrome
gameplay run subsequently renders and moves without the fault.
