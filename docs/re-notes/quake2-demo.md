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
`quake2.exe`, `ref_soft.dll`, `baseq2/gamex86.dll`, and
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

The unforced launch still depended on Quake's persisted `config.cfg` and
attract state. The dropdown now passes `+map demo1`, preserving the same fresh
profile outcome while making relaunches deterministic. The forced browser
frame was 320x240 with 135 colors and only 1,598/76,800 black pixels.
`test/test-quake2-demo-web.js` drives the actual selector and trusted Launch
button, emulates iPhone page-fullscreen, and asserts both Quake's own
DirectDraw layer and the centre of the visible browser screenshot are
non-black.

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

The platform code references eight WGL functions: `wglCreateContext`,
`wglDeleteContext`, `wglGetProcAddress`, `wglMakeCurrent`,
`wglChoosePixelFormat`, `wglDescribePixelFormat`, `wglSetPixelFormat`, and
`wglSwapBuffers`. Optional SGIS multitexture, EXT paletted-texture/point, swap
interval, and NVIDIA gamma-ramp symbols can remain unavailable when the
synthetic `glGetString` advertises no extensions.

A rendered probe gets a valid Quake HWND/HDC and succeeds through the existing
`ChoosePixelFormat`, `SetPixelFormat`, and `DescribePixelFormat` handlers. It
then jumps to EIP zero on the first missing `wglCreateContext` call. The zero
HDC seen with `--no-renderer` is only a headless-canvas artifact, not a browser
blocker.

The viable browser design is a fixed-function OpenGL 1.x compatibility layer
over WebGL, not a software renderer. Texture upload, clear, blend, depth,
scissor, viewport, and readback mostly map to WebGL. Immediate mode must batch
`glBegin`/vertex/color/texcoord calls into vertex buffers; matrix stacks become
uniforms; alpha test, shade mode, and texture environment select shader state.
The renderer also needs a per-window WebGL presentation layer analogous to the
existing DirectDraw frame layer, plus WGL context/DC ownership and dynamic API
thunks. The first Quake target is therefore about 56 guest entry points and one
real state/shader bridge, not 357 independent implementations.
