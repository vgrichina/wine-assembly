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

## Gameplay light flashes

The initially reported harsh light flicker is present in the raw WebGL
framebuffer, before the browser compositor sees it, but it is not random state
or presentation corruption. A no-input Chrome probe intercepted 12 consecutive
`SwapBuffers` calls (write sequences 45 through 56), read every 640x480 RGBA
frame directly with `gl.readPixels`, and recorded the complete GL call stream,
texture updates, and terminal raster state for each frame.

The bright sequence visibly contains Quake's scripted opening explosions:
fireball geometry and orange particles enter the scene as mean framebuffer
luma rises from 13.46 to 32.25, then fade as it falls through 29.80, 27.21,
24.48, 21.84, and 19.08. The peak is not an unexplained full-screen toggle. It
coincides with three `glTexSubImage2D` writes to lightmap texture 1024, chiefly
a 128x67 atlas strip; the preceding frames update 128x49 and 128x61 strips as
the same visible blast grows. Captures are under
`scratch/quake2-gl-flicker/flash/`.

The GL state sequence remains structurally stable throughout. Every captured
frame restores depth writes, `GL_LEQUAL`, normal alpha blending, and the same
end-of-frame 2D state; there is no alternating depth, blend, cull, scissor,
texture-enable, or presentation state. Write sequences are consecutive, so
the compositor is neither repeating nor skipping between two surfaces.

A later no-input control captures the explosion disappearing and the same
view settling. Across its final six frames, mean luma stays between 13.99 and
14.12 (under 0.9% spread); remaining changed pixels are the weapon idle
animation and a few particles. Even frames with dozens of small updates to
lightmap textures 1035-1037 remain in that brightness band, which rules out the
subimage path itself randomly corrupting illumination. Those captures and the
per-frame JSON traces are under `scratch/quake2-gl-flicker/settled/`.

That stationary evidence did not cover a separate movement-only presentation
bug. A trusted mouse-look probe caused the compositor to repaint at time
112493.1 after 645 `glEnd` draws of the next frame but before `gpuPresent`
sequence 71 at time 113462.5. The resulting screenshot was a bright,
incomplete base-texture pass with no weapon, HUD, or lightmap. The compositor's
GPU layer directly referenced the WebGL canvas on which the guest was still
drawing; pointer movement merely supplied the otherwise-unrelated repaint
that exposed it.

The generic WebGL/GLES backend now separates its live draw canvas from a
compositor-visible 2D snapshot. Only `present`/`SwapBuffers` flushes and copies
a completed GPU frame into that snapshot, so keyboard, mouse, window, and
desktop repaints between cooperative guest slices retain the preceding whole
frame. This ownership boundary is backend-generic and can also be used by a
future accelerated Direct3D frontend. `test/test-gpu-atomic-present.js` proves
that partial drawing cannot mutate the exposed surface and that explicit
present publishes one complete, correctly resized, pixel-exact snapshot.

The conspicuous no-input explosion flashes remain authentic scene content
made harsher in wall time by the low guest frame rate.
`test/test-opengl-frame-state.js` locks the generic invariants exercised here:
lightmap subimages update only the selected texture, multiplicative blending
and disabled depth writes do not leak past the lightmap pass, sparse bytes are
copied unchanged, and one GPU present produces exactly one repaint and one FPS
event.

## Gameplay input

Quake's keyboard path consumes the Set-1 scan code in Win32 message `lParam`,
not merely the `wParam` virtual-key value. Browser keyboard events now carry
their physical DOM `code` through the renderer so `WM_KEYDOWN`/`WM_KEYUP`
include the scan, extended, previous-state, and transition fields. In the
production GL acceptance, a trusted held `W` reached the host input queue as
`WM_KEYDOWN lParam=0x00110001` and `WM_KEYUP lParam=0xc0110001`; the renderer's
held-key state remained down after the message queue had drained, cleared after
the release was consumed, and the forward step changed 6,660 of 307,200 pixels.

The remaining mouse problem was at the browser boundary. An API trace of real
gameplay shows Quake calling `SetCursorPos(159,119)`, `ClipCursor`, and
`ShowCursor(FALSE)`, then polling `GetCursorPos` continuously. The virtual
Win32 cursor honored those calls, but the physical DOM cursor stayed absolute:
after Quake recentered its virtual point, the next DOM coordinate was measured
against a centre the physical cursor had never visited. Mouse look therefore
accelerated incorrectly and stopped at the browser edge.

The browser now requests pointer lock from a trusted canvas mouse-down only
when an exclusive guest presentation has an active `ClipCursor` region. While
locked, `movementX/Y` is scaled into logical-canvas space and applied relative
to the guest cursor that `SetCursorPos` controls, then passes through the normal
mapped `WM_MOUSEMOVE` path. Releasing `ClipCursor` or running an ordinary
desktop window retains absolute mouse behavior. The renderer regression covers
the inverse transform at 2x scale, explicit guest recentering between samples,
Win32 queue coordinates, and the inactive-clip negative control.

`test/test-quake2-input-web.js` drives the exact dropdown
`+set vid_ref gl +menu_main` path with trusted browser events. Its final run
recorded the active `[0,0,639,480]` clip, acquired real pointer lock, routed six
nonzero relative samples, visibly changed the camera, and saved the input queue,
mouse deltas, and screenshots under `scratch/quake2-input-web/`.

One boundary remained before capture. Pointer Lock requires a trusted click,
but ordinary absolute `mousemove` events were still delivered after Quake hid
and clipped its cursor and before that click occurred. Quake polls the offset
from `(159,119)` and recenters its virtual cursor every frame; the browser's
physical cursor does not follow that guest-only `SetCursorPos`. Each small DOM
move therefore reintroduced the whole physical distance from centre, making
the view rotate faster the farther the pointer wandered. The browser bridge
now holds absolute moves while a relative exclusive guest is awaiting Pointer
Lock. The acquisition click still reaches the guest and starts relative
`movementX/Y`; nonexclusive desktop applications retain their ordinary
absolute hover and move path.

## Threads/OpenGL throughput

The severe slowdown with the browser Threads switch is not a guest lock or a
bad interaction between Quake threads. An isolated-Chrome `+set vid_ref gl
+map demo1` probe on 2026-08-27 found zero `CreateThread` workers: the switch
only moved Quake's one main thread into guest Worker slot 0. The regression is
the synchronous host-import boundary. Every OpenGL entry reaches
`gpu_gl_call`, and in Worker mode each call posts to the browser main thread
and parks in `Atomics.wait` until the WebGL frontend returns.

The settled six-second measurements used the same current worktree, fresh
profiles, 640x480 scene, 10,000 configured block slice, hidden runtime log, and
headless Chrome SwiftShader:

| mode | completed presents | scheduler guest rate | GL calls | sync RPC delta | async RPC delta |
|---|---:|---:|---:|---:|---:|
| cooperative | 36 | 3.85M blocks/s | 786,684 | 0 | 0 |
| guest Worker | 6 | 0.259M blocks/s | 110,493 | 110,358 | 221,136 |

Scene motion makes exact calls per frame vary, but both runs were in the same
range: about 18,000--22,000 GL entries per present. One representative Worker
frame contained about 6,400 `glTexCoord2f`, 6,400 `glVertex3fv`, 2,750
`glColor4f`, and 1,286 `glBegin`/`glEnd` pairs. The sync-RPC delta is one-for-one
with those GL calls. The two async messages per call are dispatch `log` and
`log_api_exit`; their browser handlers are no-ops with runtime logging hidden,
but the generic Worker broker still posts them. This is why changing the Worker
block slice cannot solve the problem. The current adaptive probe fell from the
10,000 configured ceiling to 1,000 blocks, but the per-GL-call rendezvous
remained.

There is a separate non-Threads cost in this software-GPU measurement.
Cooperative `glGetError` took 3.23 seconds across 36 frames, about 90 ms per
frame, because it synchronizes the queued SwiftShader work. That explains why
the cooperative baseline is not fast on this host; it does not explain the
roughly 6x Worker frame loss or 15x scheduler-throughput loss. Real hardware
must be measured independently before quoting those absolute frame rates.

The useful fix boundary is a Worker-side GL command stream, not a larger guest
slice: capture value arguments and copy pointer-backed data while it is valid,
then replay a frame-sized batch on the browser thread. Flush before operations
whose return or output is guest-visible (`glGetError`, `glGetFloatv`,
`glReadPixels`, WGL lifecycle calls), and at `glFinish`/`SwapBuffers`. Suppress
the no-op dispatch-log messages in the same fast path. This removes the
cross-thread rendezvous per vertex/state call. It does not reduce the roughly
1,300 WebGL draw submissions per frame; combining compatible `glBegin`/`glEnd`
batches is a second optimization after the RPC boundary is fixed.

That command stream is now the only normal transport in both modes.
`gpu_gl_call` records arguments into a 2 MiB local buffer; capacity pressure
submits a batch without presenting, while queries/readback, WGL lifecycle,
`glFinish`, and `SwapBuffers` synchronously replay the ordered stream. Worker
dispatch logging for GL stays local unless verbose/API tracing is enabled.
Replay carries the originating Worker slot so concurrent guest GL threads keep
their own WGL current-context binding across delayed batches.
Small client arrays (vertices, colours, matrices, texture-name lists) are copied
at call time because the guest may reuse them before the batch flushes.

Texture images use a different lifetime rule to avoid copying the large payload.
The encoder appends texture metadata naming the original shared guest allocation
to older buffered commands and synchronously submits the combined batch. The
guest remains parked
until browser-thread replay has passed that direct typed-array view to WebGL,
so the allocation cannot be changed or freed while borrowed. A real Chrome
SwiftShader run accepted this SharedArrayBuffer-backed upload path, including
live `glTexSubImage2D` updates; no compatibility copy was needed.

A matched post-change six-second run completed 20 Worker presents versus 26
cooperative presents. The prior matched result was 6 versus 36, so the relative
Worker throughput rose from 17% to 77% of cooperative. The Worker executed
389,533 GL commands in that window without a per-command host round trip and
reported no browser errors. Remaining time is now dominated by the explicit
per-frame `glGetError` barrier under SwiftShader: 4.14 seconds for 21 Worker
calls and 2.95 seconds for 26 cooperative calls. That is a separate GL error
semantics/software-GPU issue, not command transport; removing it would require
maintaining a trustworthy frontend error shadow rather than silently returning
`GL_NO_ERROR`.

The next CPU pass compiles each valid immediate-mode `glBegin`/`glEnd` block in
the encoder. Per-vertex color and texture-coordinate calls update local state;
the resulting positions, colors, and coordinates are emitted as one interleaved
packed draw record. Fans, strips, quads, and line strips/loops are expanded to
independent triangles or lines so adjacent records with unchanged render state
can be concatenated safely. Replay flushes that merged geometry before any
ordinary state command, query, texture operation, context transition, or
presentation. This both removes thousands of small replay operations and
reduces WebGL buffer uploads/draw calls for runs of compatible surfaces.

The WebGL backend now caches the active program, buffer/texture bindings,
uniform values, capability/raster state, enabled attributes, and complete
attribute-pointer layout. The fixed-function frontend independently marks only
changed matrix/scalar shader uniforms dirty. Repeated draws therefore retain
their established program, matrices, scalar uniforms, and three interleaved
attribute pointers rather than reissuing them. Borrowed texture uploads also no
longer pre-flush older commands: the normal case is one ordered synchronous
submission instead of two, while buffer overflow still submits as required.

An isolated SwiftShader verification of this pass rendered the live `demo1`
scene without browser/runtime errors in both cooperative and real Worker modes.
The representative pre-change sample had about 19,353 transport commands and
1,293 WebGL draws per frame. The post-change cooperative sample had about 1,557
commands, 1,297 packed immediate blocks, 58 actual WebGL draws, 31 dirty-uniform
submissions, and 7.8 batches per frame. Worker mode had about 1,540 commands,
1,292 packed blocks, 55 WebGL draws, 30 dirty-uniform submissions, and 5.2
batches per frame. Thus packing removed about 92% of replay commands and
compatible merging removed about 96% of WebGL draw submissions; uniform
submission fell by over 99% from the former ten calls per tiny draw. Batch rate
now follows texture uploads plus the three normal per-frame barriers, without a
second pre-upload batch. A cooperative CPU trace with `glGetError` temporarily
excluded found `uniformMatrix4fv`, `vertexAttribPointer`, attribute enable, and
`drawArrays` reduced from the former prominent samples to collectively below
0.1% of all trace samples. This exclusion was profiling-only; runtime error
semantics remain unchanged.

### Command decode allocation cleanup (2026-08-30)

The OpenGL hot-path item in `fable-review.md` was still current. The Worker-side
encoder's `u32At()` constructed a `DataView` for every 32-bit stack argument,
even though the WebAssembly memory buffer is fixed, and browser-thread replay
did the same in `_u32`, `_f32`, and `_f64`. Both sides now retain one view per
backing buffer. Immediate primitive normalization also writes vertices directly
from source indices instead of allocating `slice()` arrays and then `splice()`ing
flat colors into each triangle. Required expansion of quads/fans/strips and the
command-owned packed-vertex copy remain: the former supplies WebGL-supported
primitive topology and the latter prevents guest scratch reuse from changing an
asynchronous batch.

The identical `test/test-quake2-gl-web.js` gameplay acceptance passed before
and after at 640x480 with textured motion. It reported 13.7 guest fps before and
15.8 after (+15.3%). This is directional only: system load was far above the
project's `<4` validity threshold (roughly 188 falling to 17), and the attract
scene positions differed. The focused command-stream, fixed-function,
frame-state, backend, and atomic-present tests all pass. Re-measure headful on
an idle host before treating the observed delta as a user-visible gain.

The stream is still a single 2 MiB buffer with a synchronous handoff per flush,
not a producer/consumer ring. A multi-slot ring can overlap copied command and
packed-vertex replay with guest encoding, but borrowed texture uploads and all
query/readback/context/finish/present operations must remain fences. Profile
batch replay versus the existing `glGetError`/SwiftShader wait before building
that larger change; prior Quake measurements already found the explicit error
barrier dominating the software-GPU configuration.

## Pointer-lock button release

A cooperative browser regression after the GL optimization exposed a separate
input bug: firing once could leave Quake firing indefinitely. The trusted DOM
`mouseup` was present, and the renderer's host mouse-button mask changed from
one to zero, but pointer lock reported unusable `clientX/clientY` coordinates
at `(0,0)`. That point was outside the exclusive presentation viewport, so
`handleMouseUp` returned before it queued `WM_LBUTTONUP`; Quake retained its
own button-down state.

The browser input bridge now derives pointer-locked button-up coordinates from
the guest's current virtual cursor through the inverse exclusive-presentation
transform. Ordinary unlocked releases still use DOM client coordinates. The
bridge also retires a held guest button when a later pointer-lock move reports
no physical buttons, pointer lock is lost, the window loses focus, the page is
hidden, or another press arrives without an observed release. Those recovery
paths cover browser/OS transitions that can omit `mouseup` entirely. The real
cooperative `test/test-quake2-input-web.js` acceptance now performs twelve
clicks after pointer lock is active and proves every trusted down/up pair
reaches the Win32 queue as `WM_LBUTTONDOWN` followed by `WM_LBUTTONUP`, with the
renderer mask released after every cycle.

The dropdown also mounts a first-launch `baseq2/config.cfg` with WASD movement,
permanent mouse look, mouse-one fire, mouse-two/Space jump, Ctrl/C crouch, mouse
wheel weapon selection, always-run, and a crosshair. The original `default.cfg`
still supplies every binding not explicitly modernized. Browser persistence is
enabled for this config: an existing saved config is restored after the bundled
default is mounted, and later in-game customization is saved, so the defaults
do not overwrite user choices on subsequent launches.
