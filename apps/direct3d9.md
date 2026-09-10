# Direct3D 9 programmable rendering

## Scope and status (2026-09-09)

Black & White 2 Demo is the first measured programmable D3D9 target. It now
loads its genuine game/data/D3DX DLL and reaches the pixel-shader capability
check. Gameplay is **not working**. Existing D3D9 plumbing is not a renderer:
several draws/setters still return success without performing their operation.
Shader capabilities are opt-in (`?d3d9-programmable`) and require a real GPU
shader/texture/indexed-draw pixel probe. This experimental integration profile
does not claim complete shader/resource/raster conformance or game compatibility.

This extends the historical DX8+/shader non-goals in `direct3d-im.md` and
`directx.md`; their old null-backend phases are not acceptance criteria.

## Existing contracts to preserve

- COM dispatch, guest object identity, reference counts, bindings, and resource
  bytes belong to WAT. Reuse the thunk allocator, not JS COM emulation.
- `lib/gpu-backend.js` is explicitly shared by graphics frontends. Extend its
  buffers/textures/programs/state/draw/readback contract rather than introducing
  another WebGL renderer or routing D3D through OpenGL 1.x semantics.
- Shader translation is a backend compiler: bounded immutable bytecode is
  lowered to GLSL. It does not own guest COM objects or device bindings.
- Preserve `software-gdi-design.md`'s authoritative guest-visible surface
  memory. GPU-written resources need an explicit ordered readback before CPU
  access; staging texture writes become visible at Unlock/upload. Never use a
  presentation snapshot as a resource's authoritative bytes.
- Present publishes a completed frame to the existing window compositor, as
  the generic backend already does for OpenGL. A guest scheduling yield does
  not publish a partially drawn frame.
- Worker commands capture source bytes before guest memory can be reused.
  Synchronous readbacks drain preceding commands. Existing GL opcode numbering
  and transport must remain unchanged.

## Implementation sequence and acceptance

1. Bounded shader token decoder/compiler with version, operand, mask, swizzle,
   modifier, constant and instruction validation. Test invalid/truncated input,
   real shader tokens, and GPU compilation/rendered arithmetic independently.
2. D3D9 resource/device backend connection: correct interface vtables for
   surfaces, vertex/index buffers, shaders and declarations; owned allocations,
   Lock/Unlock, binding references, draw validation, and release cleanup.
3. Real indexed/non-indexed programmable draws, texture/sampler upload, depth,
   blending/culling and viewport conversion. Test pixel results through the
   shared backend, including D3D clip-depth and texture-coordinate conventions.
4. Enable only verified capabilities. Rerun the demo, implement measured missing
   operations without substituting fake success, and verify menu-to-game input
   with scene changes across completed frames in the browser.

The demo's `.sdv` files contain candidate VS/PS 1.1, PS 1.4 and VS/PS 2.0 token
headers. Raw header counts alone are not proof of valid shader boundaries or
runtime usage; validate streams and trace actual CreateShader calls.

Unsupported instructions/formats fail explicitly, with bytecode offset and
opcode where applicable. No arbitrary shader is replaced by a flat-color
program. A source-generation unit test alone does not establish shader support.

## Implemented slices (not gameplay completion)

- `lib/d3d9-shader.js`: bounded VS/PS1.1 parser and GLSL compiler, arithmetic,
  masks/modifiers, DEF, declarations, matrix instructions, basic/dependent
  sampling, coissued operand evaluation and VS1.1 relative constant addressing.
  Other profiles and several legacy texture instructions still reject explicitly.
- Chrome compiled 174 accepted shader streams from the demo's SDV assets.
  This is compilation coverage, not proof they are the runtime-selected set.
- `lib/d3d9-backend.js`: immutable draw lowering to the shared GPU backend.
  Indexed draw, depth rejection, alpha blending and separate VS/PS constants
  have real pixel tests, including textures created and locked through WAT.
- WAT device constant banks and shader COM objects own their data. External
  shader references retain the device; internal bindings retain the shader
  allocation without introducing a device-reference cycle.
- `lib/d3d9-host.js` and private GPU opcodes `0x30000..0x30004` connect shader
  validation, programmable draws, Present, Clear and teardown; `0x30005` probes
  the opt-in programmable profile using actual GPU pixel results.
  Worker mode uses the synchronous broker, not the GL command encoder.
- `test-d3d9-pipeline-web.js` verifies actual WAT CreateDevice/CreateShader,
  binding, constants, FVF XYZW/normal/color/texture input and Present against canonical BGRA
  framebuffer pixels, and requires no presentation layer before Present.

- Guest textures have native BGRA mip bytes, rectangle locks, level surfaces,
  shared texture/surface lock state, sampler bindings and explicit mip upload.
- Vertex/index buffers have real COM identity, byte storage, locks, descriptors
  and internal/external lifetime. Stream 0 offsets and signed base vertices
  are validated before indexed/nonindexed GPU draws. UP draws consume source
  memory synchronously; INDEX32 expands without narrowing indices.
- The full WAT GPU test checks UP INDEX16, an INDEX32 value above 65535,
  buffer-bound indexed/nonindexed draws and canonical BGRA pixels, plus
  rejection of locked buffers and out-of-range vertex/index accesses.

- Immutable vertex declarations support stream0 FLOAT1..4/D3DCOLOR, semantic
  shader binding, QueryInterface/GetDeclaration and independent lifetime.
- Selective render/sampler/texture/transform/declaration/shader/float-constant
  state blocks record without mutating live state,
  retain only the final write to each included state, and Capture/Apply only
  that subset. Other recording categories fail explicitly; preset all/pixel/
  vertex block creation is still unimplemented.
- Texture references retained by blocks have explicit replacement/destruction
  lifetime. View/projection, eight texture and 256 world matrices are independent
  identity-initialized device state. Fixed-function transform rendering is not
  implemented. The gamma API retains copied ramp data; display gamma remains
  unsupported and unadvertised.

Current integration limits: one stream, a limited declaration type set,
no render-target switching, incomplete raster-state lowering.
Present reads GPU pixels back to canonical memory; mid-frame surface access
still needs explicit readback fencing. Default shader caps remain disabled. No game
binary patches or capability-only bypass have been used.
