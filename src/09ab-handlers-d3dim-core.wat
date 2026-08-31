  ;; ============================================================
  ;; D3DIM CORE HELPERS — hand-written
  ;; Forwarding helpers shared by the v1/v2/v3/v7 stub handlers in
  ;; 09aa-handlers-d3dim.wat. These give the stubs a single place to
  ;; route into the existing IDirect3DDevice3/IDirect3DViewport3 cores
  ;; in 09a8-handlers-directx.wat without arg-shuffle thunks.
  ;;
  ;; Phases 1+ replace stub bodies and these helpers as real semantics arrive.
  ;; ============================================================

  ;; ── D3DIM extended state-block layout ─────────────────────────
  ;; Existing 09a8 layout:
  ;;   +0     4 matrices × 64 bytes = 256
  ;;   +256   render state (512 i32 slots = 2048 bytes)
  ;;   +2304  light state  (128 i32 slots = 512 bytes)
  ;;   total used: 2816 ; allocated: 4096 ; free: 1280 bytes
  ;; D3DIM additions (Phase 0+) — packed into the spare 1280:
  ;;   +2816  current viewport DX slot                (i32, 4)
  ;;   +2820  current material handle                 (i32, 4)
  ;;   +2824  texture stage 0: bound texture DX slot  (i32, 4)
  ;;   +2828  z-buffer DDSurface DX slot              (i32, 4)  (Phase 3 fills)
  ;;   +2832  texture-stage state[8 stages × 32]      (256 bytes)  → ends 3088
  ;;   +3088  viewport rect: dwX,dwY,dwW,dwH          (16)         → ends 3104
  ;;   +3104  viewport scale: dvScaleX,dvScaleY,dvMinZ,dvMaxZ (16) → ends 3120
  ;;   +3120  viewport offset: dvOriginX,dvOriginY    (8)          → ends 3128
  ;;   +3136  matrix multiply scratch                  (64)
  ;;   +3200  indexed-draw TL vertex scratch           (96)
  ;;   +3296  execute-buffer clipped TL scratch         (64)
  ;;   +3360  v1 STATETRANSFORM matrix handles W,V,P    (12)
  ;;   +3376  current D3DMATERIAL7 copy                 (68)
  ;;   +3448  D3DLIGHT7 table guest ptr                 (i32, 4)
  ;;   +3452  D3DLIGHT7 enable bitmask                  (i32, 4)
  ;;   +3456  D3D7 user clip planes[6]                  (96)
  ;;   +3552  extended texture-stage state[8 × 6]       (192)         → ends 3744
  ;;          types 11,13,14,16,17,18 (TCI/address/filter/mip filter)
  ;;   +3744  direct-primitive clip polygon A (5 × 32)  (160)         → ends 3904
  ;;   +4000  D3DCLIPSTATUS round-trip storage          (24)
  ;;   +4032  vertex_project vec temp                  (16)
  ;;   +4064  vertex_project clip temp                 (16)
  ;; Last (texture slot, resolved?) pair reported through $host_dx_trace kind
  ;; 16. Only a change is logged, so a per-triangle call site stays quiet while
  ;; still showing every rebind. -1 can never collide with a real pair.
  (global $d3dim_dbg_tex_last (mut i32) (i32.const -1))
  ;; Per-instance only. The render Worker points this at its command-owned
  ;; 4KB snapshot while replaying; the guest instance keeps zero and therefore
  ;; continues to use the live device entry.
  (global $d3dim_state_override (mut i32) (i32.const 0))
  (global $D3DIM_OFF_CUR_VP    i32 (i32.const 2816))
  (global $D3DIM_OFF_CUR_MAT   i32 (i32.const 2820))
  (global $D3DIM_OFF_TEX_STAGE i32 (i32.const 2824))
  (global $D3DIM_OFF_ZBUF_SLOT i32 (i32.const 2828))
  (global $D3DIM_OFF_TSS_STATE i32 (i32.const 2832))
  (global $D3DIM_OFF_VP_RECT   i32 (i32.const 3088))
  (global $D3DIM_OFF_VP_SCALE  i32 (i32.const 3104))
  (global $D3DIM_OFF_VP_ORIGIN i32 (i32.const 3120))
  (global $D3DIM_OFF_XFORM_HANDLES i32 (i32.const 3360))
  (global $D3DIM_OFF_D3D7_MAT  i32 (i32.const 3376))
  (global $D3DIM_OFF_D3D7_LIGHTS i32 (i32.const 3448))
  (global $D3DIM_OFF_D3D7_LIGHT_ENABLE i32 (i32.const 3452))
  (global $D3DIM_OFF_D3D7_CLIP_PLANES i32 (i32.const 3456))
  (global $D3DIM_OFF_TSS_EXT i32 (i32.const 3552))
  (global $D3DIM_OFF_CLIP_STATUS i32 (i32.const 4000))
  ;; Producer-only descriptor scratch in the unused gap before CLIP_STATUS.
  (global $D3DIM_OFF_WORKER_DESC i32 (i32.const 3968))

  (func $d3dim_worker_fence
    (drop (call $host_gpu_gl_call (i32.const 0x20001) (i32.const 0) (i32.const 0))))

  ;; Snapshot ownership is established by the JS encoder before this returns.
  ;; Result 1 means a render Worker accepted the draw; 0 selects the existing
  ;; synchronous rasterizer without changing non-Threads behavior.
  (func $d3dim_worker_try_draw
    (param $this i32) (param $primitive i32) (param $vertex_type i32)
    (param $vertices i32) (param $count i32) (result i32)
    (local $state i32) (local $desc i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $desc (i32.add (call $g2w (local.get $state))
      (global.get $D3DIM_OFF_WORKER_DESC)))
    (i32.store offset=0 (local.get $desc) (local.get $this))
    (i32.store offset=4 (local.get $desc) (local.get $primitive))
    (i32.store offset=8 (local.get $desc) (local.get $vertex_type))
    (i32.store offset=12 (local.get $desc) (local.get $vertices))
    (i32.store offset=16 (local.get $desc) (local.get $count))
    (i32.store offset=20 (local.get $desc) (local.get $state))
    (call $host_gpu_gl_call (i32.const 0x20000) (local.get $desc) (i32.const 0)))

  ;; A renderer-only instance needs guest-address translation and a private
  ;; heap arena for its immutable command workspace, but it never decodes or
  ;; executes x86. Do not call init_thread here: that also assigns page/cache
  ;; partitions, and the old experimental slot 63 wrote beyond the eight-slot
  ;; PAGE_DIR arena. The process heap cursor itself is shared and atomically
  ;; hands this instance a non-overlapping arena on its first guest_alloc.
  (func (export "d3dim_worker_init") (param $img_base i32)
    (global.set $image_base (local.get $img_base))
    (global.set $heap_ptr (i32.const 0))
    (global.set $heap_end (i32.const 0))
    (global.set $heap_base
      (i32.load (i32.add (global.get $HEAP_SHARED) (i32.const 4)))))

  (func (export "d3dim_worker_draw")
    (param $this i32) (param $primitive i32) (param $vertex_type i32)
    (param $vertices i32) (param $count i32) (param $state i32)
    (global.set $d3dim_state_override (local.get $state))
    (call $d3dim_draw_primitive (local.get $this) (local.get $primitive)
      (local.get $vertex_type) (local.get $vertices) (local.get $count))
    (global.set $d3dim_state_override (i32.const 0)))

  ;; Crash-name strings for unimplemented D3DIM paths live in the high
  ;; WAT-private scratch area so they cannot collide with low system strings
  ;; or sparse VirtualAlloc map state.
  ;; The encompassing sized region makes the memory-map gate account for the
  ;; strings, execute-buffer pointer cache, state blocks, and matrix-used map.
  (global $D3DIM_AUX i32 (i32.const 0x07FEB000))
  (global $D3DIM_AUX_SIZE i32 (i32.const 0x00001000))
  (data (i32.const 0x07FEB000) "D3DIM:Execute opcode\00")
  (data (i32.const 0x07FEB020) "D3DIM:DrawPrimitive vtx/prim\00")
  (global $D3DIM_UNIMPL_EXEC_OP i32 (i32.const 0x07FEB000))
  (global $D3DIM_UNIMPL_DRAW    i32 (i32.const 0x07FEB020))
  ;; 512 i32 guest pointers, keyed by DX_OBJECTS slot. Each cached execute
  ;; buffer block is [buf_guest, buf_size, D3DSTATUS (24 bytes), original
  ;; bytes...]. D3DRM reads the status extents back through GetExecuteData to
  ;; decide whether its windowed render target needs another primary Blt.
  (global $D3DIM_EB_CACHE_PTRS i32 (i32.const 0x07FEB040))
  (global $D3DIM_EB_CACHE_MAX  i32 (i32.const 512))
  (global $D3DIM_EB_CACHE_HEADER i32 (i32.const 32))
  ;; D3D7 state blocks: 32 entries × [snapshot_guest, dev_slot, reserved].
  (global $D3DIM_STATEBLOCKS i32 (i32.const 0x07FEB840))
  (global $D3DIM_STATEBLOCK_MAX i32 (i32.const 32))
  (global $d3dim_stateblock_record_dev (mut i32) (i32.const 0))
  (global $d3dim_dbg_vproj_count (mut i32) (i32.const 0))

  (func $d3dim_stateblock_entry (param $handle i32) (result i32)
    (if (i32.or
          (i32.eqz (local.get $handle))
          (i32.gt_u (local.get $handle) (global.get $D3DIM_STATEBLOCK_MAX)))
      (then (return (i32.const 0))))
    (i32.add (global.get $D3DIM_STATEBLOCKS)
      (i32.mul (i32.sub (local.get $handle) (i32.const 1)) (i32.const 12))))

  (func $d3dim_stateblock_create (param $dev_this i32) (result i32)
    (local $state_guest i32) (local $snapshot_guest i32) (local $entry i32)
    (local $dev_entry i32) (local $dev_slot i32) (local $i i32)
    (local.set $state_guest (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_guest)) (then (return (i32.const 0))))
    (local.set $dev_entry (call $dx_from_this (local.get $dev_this)))
    (local.set $dev_slot (call $dx_slot_of (local.get $dev_entry)))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $D3DIM_STATEBLOCK_MAX)))
      (local.set $entry (i32.add (global.get $D3DIM_STATEBLOCKS)
        (i32.mul (local.get $i) (i32.const 12))))
      (if (i32.eqz (i32.load (local.get $entry)))
        (then
          (local.set $snapshot_guest (call $heap_alloc (i32.const 4096)))
          (if (i32.eqz (local.get $snapshot_guest)) (then (return (i32.const 0))))
          (call $memcpy
            (call $g2w (local.get $snapshot_guest))
            (call $g2w (local.get $state_guest))
            (i32.const 4096))
          (i32.store (local.get $entry) (local.get $snapshot_guest))
          (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $dev_slot))
          (return (i32.add (local.get $i) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  (func $d3dim_stateblock_apply (param $dev_this i32) (param $handle i32)
    (local $entry i32) (local $snapshot_guest i32) (local $state_guest i32)
    (local.set $entry (call $d3dim_stateblock_entry (local.get $handle)))
    (if (i32.eqz (local.get $entry)) (then (return)))
    (local.set $snapshot_guest (i32.load (local.get $entry)))
    (if (i32.eqz (local.get $snapshot_guest)) (then (return)))
    (local.set $state_guest (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_guest)) (then (return)))
    (call $memcpy
      (call $g2w (local.get $state_guest))
      (call $g2w (local.get $snapshot_guest))
      (i32.const 4096)))

  (func $d3dim_stateblock_capture (param $dev_this i32) (param $handle i32)
    (local $entry i32) (local $snapshot_guest i32) (local $state_guest i32)
    (local.set $entry (call $d3dim_stateblock_entry (local.get $handle)))
    (if (i32.eqz (local.get $entry)) (then (return)))
    (local.set $snapshot_guest (i32.load (local.get $entry)))
    (if (i32.eqz (local.get $snapshot_guest)) (then (return)))
    (local.set $state_guest (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_guest)) (then (return)))
    (call $memcpy
      (call $g2w (local.get $snapshot_guest))
      (call $g2w (local.get $state_guest))
      (i32.const 4096)))

  (func $d3dim_stateblock_delete (param $handle i32)
    (local $entry i32) (local $snapshot_guest i32)
    (local.set $entry (call $d3dim_stateblock_entry (local.get $handle)))
    (if (i32.eqz (local.get $entry)) (then (return)))
    (local.set $snapshot_guest (i32.load (local.get $entry)))
    (if (local.get $snapshot_guest) (then (call $heap_free (local.get $snapshot_guest))))
    (call $zero_memory (local.get $entry) (i32.const 12)))

  ;; ── QueryInterface upgrade routing ────────────────────────────
  ;; Recognizes versioned IIDs by their first DWORD and writes the matching
  ;; vtable to *ppvObj. AddRef the same DX_OBJECTS slot.
  ;;
  ;; family: 0=no upgrade (same vtable), 1=D3D, 2=Device, 3=Viewport,
  ;;         4=Material, 5=Texture, 6=VertexBuffer
  ;;
  ;; Returns S_OK (0) on match (and writes ppvObj), E_NOINTERFACE (0x80004002)
  ;; on miss (and writes NULL to ppvObj).
  (func $d3dim_qi (param $family i32) (param $this i32) (param $riid i32) (param $ppvObj i32) (result i32)
    (local $iid0 i32) (local $entry i32) (local $vtbl i32) (local $obj_wa i32)
    (local $i i32) (local $ptr i32) (local $ddraw_guest i32)
    ;; Sanity: NULL ppvObj ⇒ E_POINTER
    (if (i32.eqz (local.get $ppvObj)) (then (return (i32.const 0x80004003))))
    ;; Read first DWORD of the IID for fast classification.
    (local.set $iid0 (call $gl32 (local.get $riid)))
    ;; Pick target vtable by family + IID-first-DWORD.
    (local.set $vtbl (i32.const 0))
    ;; Always honor IID_IUnknown (00000000-0000-0000-...) by returning the
    ;; same vtable currently bound to `this`.
    (if (i32.eqz (local.get $iid0)) (then
      (local.set $obj_wa (call $g2w (local.get $this)))
      (local.set $vtbl (i32.load (local.get $obj_wa)))))
    ;; D3D family → IID_IDirectDraw (0x6C14DB80): return the parent DDraw.
    ;; Priority 1: read the parent DDraw slot linked at entry+8 (set by
    ;; IDirectDraw::QI when the child D3D was created). This is exact and
    ;; survives Release cycles that would have zeroed the parent's type field.
    ;; Priority 2 fallback: scan DX_OBJECTS for any type=1 (DDraw) entry.
    (if (i32.and (i32.eq (local.get $family) (i32.const 1))
                 (i32.eq (local.get $iid0) (i32.const 0x6C14DB80))) (then
      (local.set $entry (call $dx_from_this (local.get $this)))
      (local.set $i (i32.load (i32.add (local.get $entry) (i32.const 8))))
      (if (i32.ne (local.get $i) (i32.const 0)) (then
        (local.set $ptr (i32.add (global.get $DX_OBJECTS)
          (i32.mul (local.get $i) (i32.const 32))))
        (i32.store (i32.add (local.get $ptr) (i32.const 4))
          (i32.add (i32.load (i32.add (local.get $ptr) (i32.const 4))) (i32.const 1)))
        (local.set $ddraw_guest (i32.add
          (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $i) (i32.const 8)))
                   (global.get $GUEST_BASE))
          (global.get $image_base)))
        (call $gs32 (local.get $ppvObj) (local.get $ddraw_guest))
        (return (i32.const 0))))
      (local.set $i (i32.const 0))
      (block $done (loop $scan
        (br_if $done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
        (local.set $ptr (i32.add (global.get $DX_OBJECTS)
          (i32.mul (local.get $i) (i32.const 32))))
        (if (i32.eq (i32.load (local.get $ptr)) (i32.const 1)) (then
          ;; AddRef the DDraw entry and return its wrapper guest ptr.
          (i32.store (i32.add (local.get $ptr) (i32.const 4))
            (i32.add (i32.load (i32.add (local.get $ptr) (i32.const 4))) (i32.const 1)))
          (local.set $ddraw_guest (i32.add
            (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $i) (i32.const 8)))
                     (global.get $GUEST_BASE))
            (global.get $image_base)))
          (call $gs32 (local.get $ppvObj) (local.get $ddraw_guest))
          (return (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $scan)))
      ;; No DDraw found — fall through to E_NOINTERFACE below.
    ))
    (if (i32.eq (local.get $family) (i32.const 1)) (then
      ;; D3D family
      (if (i32.eq (local.get $iid0) (i32.const 0x3BBA0080)) (then (local.set $vtbl (global.get $DX_VTBL_D3D))))
      (if (i32.eq (local.get $iid0) (i32.const 0x6AAE1EC1)) (then (local.set $vtbl (global.get $DX_VTBL_D3D2))))
      (if (i32.eq (local.get $iid0) (i32.const 0xBB223240)) (then (local.set $vtbl (global.get $DX_VTBL_D3D3))))
      (if (i32.eq (local.get $iid0) (i32.const 0xF5049E77)) (then (local.set $vtbl (global.get $DX_VTBL_D3D7))))))
    ;; Device family → IID_IDirectDrawSurface (0x6C14DB81): return the render
    ;; target surface that was bound at CreateDevice time. d3drm.dll asks for
    ;; this to introspect the back buffer; failing it causes a NULL-vtable
    ;; Release crash in the caller's cleanup path.
    (if (i32.and (i32.eq (local.get $family) (i32.const 2))
                 (i32.eq (local.get $iid0) (i32.const 0x6C14DB81))) (then
      (local.set $entry (call $dx_from_this (local.get $this)))
      (local.set $i (i32.load (i32.add (local.get $entry) (i32.const 8)))) ;; rt_slot
      (if (i32.ne (local.get $i) (i32.const 0)) (then
        (local.set $ptr (i32.add (global.get $DX_OBJECTS)
          (i32.mul (local.get $i) (i32.const 32))))
        (if (i32.ne (i32.load (local.get $ptr)) (i32.const 0)) (then
          (i32.store (i32.add (local.get $ptr) (i32.const 4))
            (i32.add (i32.load (i32.add (local.get $ptr) (i32.const 4))) (i32.const 1)))
          (local.set $ddraw_guest (i32.add
            (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $i) (i32.const 8)))
                     (global.get $GUEST_BASE))
            (global.get $image_base)))
          (call $gs32 (local.get $ppvObj) (local.get $ddraw_guest))
          (return (i32.const 0))))))))
    (if (i32.eq (local.get $family) (i32.const 2)) (then
      ;; Device family
      (if (i32.eq (local.get $iid0) (i32.const 0x64108800)) (then (local.set $vtbl (global.get $DX_VTBL_D3DDEV1))))
      (if (i32.eq (local.get $iid0) (i32.const 0x93281501)) (then (local.set $vtbl (global.get $DX_VTBL_D3DDEV2))))
      (if (i32.eq (local.get $iid0) (i32.const 0xB0AB3B60)) (then (local.set $vtbl (global.get $DX_VTBL_D3DDEV3))))
      (if (i32.eq (local.get $iid0) (i32.const 0xF5049E79)) (then (local.set $vtbl (global.get $DX_VTBL_D3DDEV7))))))
    (if (i32.eq (local.get $family) (i32.const 3)) (then
      ;; Viewport family — IIDs less critical, accept anything that resembles a Viewport
      (local.set $obj_wa (call $g2w (local.get $this)))
      (local.set $vtbl (i32.load (local.get $obj_wa)))))
    (if (i32.eq (local.get $family) (i32.const 4)) (then
      (local.set $obj_wa (call $g2w (local.get $this)))
      (local.set $vtbl (i32.load (local.get $obj_wa)))))
    (if (i32.eq (local.get $family) (i32.const 5)) (then
      ;; Texture family — recognize Texture IIDs and DDSurface IIDs
      ;; (the texture wraps a DDSurface; QI'ing back for a surface IID is a
      ;; common d3drm pattern).
      (if (i32.eq (local.get $iid0) (i32.const 0x2cdcd9e0)) (then (local.set $vtbl (global.get $DX_VTBL_D3DTEX))))
      (if (i32.eq (local.get $iid0) (i32.const 0x93281502)) (then (local.set $vtbl (global.get $DX_VTBL_D3DTEX2))))
      ;; IID_IDirectDrawSurface/2/3/4 all map to DDSURF2 (superset that covers
      ;; their v1..v3 method ranges — we don't expose DDSurface3/4-specific
      ;; methods, so v2 vtable is what callers actually use).
      (if (i32.eq (local.get $iid0) (i32.const 0x6c14db81)) (then (local.set $vtbl (global.get $DX_VTBL_DDSURF2))))
      (if (i32.eq (local.get $iid0) (i32.const 0x57805885)) (then (local.set $vtbl (global.get $DX_VTBL_DDSURF2))))
      (if (i32.eq (local.get $iid0) (i32.const 0xda044e00)) (then (local.set $vtbl (global.get $DX_VTBL_DDSURF2))))
      (if (i32.eq (local.get $iid0) (i32.const 0x0b2b8630)) (then (local.set $vtbl (global.get $DX_VTBL_DDSURF2))))
      (if (i32.eqz (local.get $vtbl)) (then
        ;; Fallback: keep current vtable.
        (local.set $obj_wa (call $g2w (local.get $this)))
        (local.set $vtbl (i32.load (local.get $obj_wa)))))))
    (if (i32.eq (local.get $family) (i32.const 6)) (then
      (local.set $obj_wa (call $g2w (local.get $this)))
      (local.set $vtbl (i32.load (local.get $obj_wa)))))
    ;; Miss → fail.
    (if (i32.eqz (local.get $vtbl)) (then
      (call $gs32 (local.get $ppvObj) (i32.const 0))
      (return (i32.const 0x80004002))))
    ;; Hit → return a wrapper (aux or primary) that reports the requested vtbl
    ;; backed by the same DX_OBJECTS slot. Must NOT mutate the primary wrapper's
    ;; vtbl in place: callers keep the original `this` register alive and
    ;; continue to invoke methods on the original vtbl (observed in d3rm.dll
    ;; Device2::QI→Device1 sequences where [esi] must still resolve to Device2).
    (local.set $entry (call $dx_from_this (local.get $this)))
    (call $gs32 (local.get $ppvObj)
      (call $dx_get_wrapper_for_vtbl
        (call $dx_slot_of (local.get $entry))
        (local.get $vtbl)))
    ;; AddRef the backing slot.
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.const 0))

  ;; ── CreateDevice forwarding (D3D2/D3D7) ───────────────────────
  ;; Matches the IDirect3D3::CreateDevice path in 09a8 (device type 20,
  ;; 4KB state block on guest heap). For D3D2/D3D7 we use the same
  ;; underlying type — the only externally-visible difference is the vtable
  ;; the caller sees on the returned object, and QI handles upgrades.
  ;; Device entry fields: +8 = current render-target slot, +12 = creator
  ;; D3D slot + 1 (0 means no parent, e.g. surface-QI-created device).
  (func $d3dim_create_device (param $this i32) (param $rt_surf i32) (param $ppDev i32) (param $vtbl i32)
    (local $obj i32) (local $entry i32) (local $rt_entry i32) (local $rt_slot i32) (local $state i32)
    (local $parent_entry i32) (local $parent_slot i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 20) (local.get $vtbl)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (if (local.get $this) (then
      (local.set $parent_entry (call $dx_from_this (local.get $this)))
      (if (i32.ne (i32.load (local.get $parent_entry)) (i32.const 0)) (then
        (local.set $parent_slot (call $dx_slot_of (local.get $parent_entry)))
        (i32.store (i32.add (local.get $entry) (i32.const 12))
          (i32.add (local.get $parent_slot) (i32.const 1)))))))
    (if (local.get $rt_surf) (then
      (local.set $rt_entry (call $dx_from_this (local.get $rt_surf)))
      (local.set $rt_slot (call $dx_slot_of (local.get $rt_entry)))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $rt_slot))))
    (local.set $state (call $heap_alloc (i32.const 4096)))
    (call $d3ddev_init_state (local.get $state))
    (i32.store (i32.add (local.get $entry) (i32.const 16)) (local.get $state))
    (call $gs32 (local.get $ppDev) (local.get $obj))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_direct3d (param $this i32) (param $ppD3D i32) (param $vtbl i32)
    (local $entry i32) (local $parent_idx i32) (local $parent_slot i32) (local $parent_entry i32)
    (if (i32.eqz (local.get $ppD3D)) (then
      (global.set $eax (i32.const 0x80004003))
      (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $parent_idx (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (i32.eqz (local.get $parent_idx)) (then
      (call $gs32 (local.get $ppD3D) (i32.const 0))
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $parent_slot (i32.sub (local.get $parent_idx) (i32.const 1)))
    (if (i32.ge_u (local.get $parent_slot) (global.get $DX_MAX)) (then
      (call $gs32 (local.get $ppD3D) (i32.const 0))
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $parent_entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $parent_slot) (i32.const 32))))
    (if (i32.eqz (i32.load (local.get $parent_entry))) (then
      (call $gs32 (local.get $ppD3D) (i32.const 0))
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (i32.store (i32.add (local.get $parent_entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $parent_entry) (i32.const 4))) (i32.const 1)))
    (call $gs32 (local.get $ppD3D)
      (call $dx_get_wrapper_for_vtbl (local.get $parent_slot) (local.get $vtbl)))
    (global.set $eax (i32.const 0)))

  ;; ── BeginScene / EndScene ─────────────────────────────────────
  ;; Phase 0: no-op; Phase 5 will reset/flush the triangle queue here.
  (func $d3dim_begin_scene (param $this i32)
    (global.set $eax (i32.const 0)))
  (func $d3dim_end_scene (param $this i32)
    (local $rt i32)
    ;; If the RT is the primary surface, present it now. d3drm-based apps
    ;; (ARCHITEC, others) never call Flip/Unlock — they rely on EndScene
    ;; to make the frame visible. Non-primary RTs are left untouched; the
    ;; app's own Flip or Blt-to-primary will handle those.
    (local.set $rt (call $d3ddev_rt_entry (local.get $this)))
    (if (local.get $rt) (then
      (if (i32.and (i32.load (i32.add (local.get $rt) (i32.const 28))) (i32.const 1))
        (then (call $dx_present (local.get $rt))))))
    (global.set $eax (i32.const 0)))

  ;; ── State-block forwarders ────────────────────────────────────
  ;; Mirror IDirect3DDevice3_SetTransform / SetRenderState / SetLightState
  ;; bodies inline (we can't easily call the existing handlers because they
  ;; manage ESP themselves).
  ;; Shared core: copy 64-byte matrix from WASM-addr $src_wa into the device's
  ;; per-xtype slot of its state block. Used by SetTransform (which passes a
  ;; guest matrix ptr via $g2w) and the D3DOP_STATETRANSFORM walker (which
  ;; resolves a matrix handle into D3DIM_MATRICES).
  (func $d3dim_apply_transform (param $this i32) (param $xtype i32) (param $src_wa i32)
    (local $state i32) (local $slot i32)
    (if (i32.eqz (local.get $src_wa)) (then (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $slot (call $d3ddev_matrix_slot (local.get $xtype)))
    (call $memcpy
      (call $g2w (i32.add (local.get $state) (i32.mul (local.get $slot) (i32.const 64))))
      (local.get $src_wa)
      (i32.const 64)))

  (func $d3dim_bind_transform_handle (param $this i32) (param $xtype i32) (param $handle i32)
    (local $state i32) (local $sw i32) (local $slot i32)
    (local.set $slot (call $d3ddev_matrix_slot (local.get $xtype)))
    (if (i32.ge_u (local.get $slot) (i32.const 3)) (then (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (i32.store
      (i32.add (local.get $sw)
        (i32.add (global.get $D3DIM_OFF_XFORM_HANDLES)
          (i32.mul (local.get $slot) (i32.const 4))))
      (local.get $handle)))

  (func $d3dim_refresh_bound_matrix (param $this i32) (param $handle i32)
    (local $state i32) (local $sw i32) (local $slot i32) (local $mat_wa i32)
    (if (i32.or (i32.lt_u (local.get $handle) (i32.const 1))
                (i32.gt_u (local.get $handle) (global.get $D3DIM_MATRIX_MAX)))
      (then (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $mat_wa
      (i32.add (global.get $D3DIM_MATRICES)
        (i32.mul (i32.sub (local.get $handle) (i32.const 1)) (i32.const 64))))
    (local.set $slot (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $slot) (i32.const 3)))
      (if (i32.eq
            (i32.load
              (i32.add (local.get $sw)
                (i32.add (global.get $D3DIM_OFF_XFORM_HANDLES)
                  (i32.mul (local.get $slot) (i32.const 4)))))
            (local.get $handle))
        (then
          (call $memcpy
            (call $g2w
              (i32.add (local.get $state)
                (i32.mul (local.get $slot) (i32.const 64))))
            (local.get $mat_wa)
            (i32.const 64))))
      (local.set $slot (i32.add (local.get $slot) (i32.const 1)))
      (br 0))))

  (func $d3dim_set_transform (param $this i32) (param $xtype i32) (param $lpmat i32)
    (if (local.get $lpmat) (then
      (call $d3dim_bind_transform_handle (local.get $this) (local.get $xtype) (i32.const 0))
      (call $d3dim_apply_transform (local.get $this) (local.get $xtype)
        (call $g2w (local.get $lpmat)))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_transform (param $this i32) (param $xtype i32) (param $lpmat i32)
    (local $state i32) (local $slot i32)
    (if (i32.eqz (local.get $lpmat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $slot (call $d3ddev_matrix_slot (local.get $xtype)))
    (call $memcpy
      (call $g2w (local.get $lpmat))
      (call $g2w (i32.add (local.get $state) (i32.mul (local.get $slot) (i32.const 64))))
      (i32.const 64))
    (global.set $eax (i32.const 0)))

  (func $d3dim_multiply_transform (param $this i32) (param $xtype i32) (param $lpmat i32)
    (local $state i32) (local $sw i32) (local $slot i32) (local $dst_wa i32) (local $tmp_wa i32)
    (if (i32.eqz (local.get $lpmat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $slot (call $d3ddev_matrix_slot (local.get $xtype)))
    (local.set $dst_wa (i32.add (local.get $sw) (i32.mul (local.get $slot) (i32.const 64))))
    (local.set $tmp_wa (i32.add (local.get $sw) (i32.const 3136)))
    (call $mat4_mul (local.get $tmp_wa) (local.get $dst_wa) (call $g2w (local.get $lpmat)))
    (call $memcpy (local.get $dst_wa) (local.get $tmp_wa) (i32.const 64))
    (call $d3dim_bind_transform_handle (local.get $this) (local.get $xtype) (i32.const 0))
    (global.set $eax (i32.const 0)))

  (func $d3dim_set_render_state (param $this i32) (param $rs i32) (param $val i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $rs) (i32.const 512)))
      (then (call $gs32
              (i32.add (local.get $state)
                (i32.add (i32.const 256) (i32.mul (local.get $rs) (i32.const 4))))
              (local.get $val))
            ;; D3DRENDERSTATE_TEXTUREHANDLE = 1 in the v1 execute-buffer API.
            (if (i32.eq (local.get $rs) (i32.const 1))
              (then
                (call $gs32
                  (i32.add (local.get $state) (global.get $D3DIM_OFF_TEX_STAGE))
                  (local.get $val))))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_render_state (param $this i32) (param $rs i32) (param $out i32)
    (local $state i32) (local $val i32)
    (if (i32.eqz (local.get $out)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $rs) (i32.const 512)))
      (then (local.set $val
              (call $gl32
                (i32.add (local.get $state)
                  (i32.add (i32.const 256) (i32.mul (local.get $rs) (i32.const 4))))))))
    (call $gs32 (local.get $out) (local.get $val))
    (global.set $eax (i32.const 0)))

  (func $d3dim_set_light_state (param $this i32) (param $ls i32) (param $val i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $ls) (i32.const 128)))
      (then (call $gs32
              (i32.add (local.get $state)
                (i32.add (i32.const 2304) (i32.mul (local.get $ls) (i32.const 4))))
              (local.get $val))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_light_state (param $this i32) (param $ls i32) (param $out i32)
    (local $state i32) (local $val i32)
    (if (i32.eqz (local.get $out)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $ls) (i32.const 128)))
      (then (local.set $val
              (call $gl32
                (i32.add (local.get $state)
                  (i32.add (i32.const 2304) (i32.mul (local.get $ls) (i32.const 4))))))))
    (call $gs32 (local.get $out) (local.get $val))
    (global.set $eax (i32.const 0)))

  (func $d3dim_set_clip_status (param $this i32) (param $lpClip i32)
    (local $state i32)
    (if (i32.eqz (local.get $lpClip)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w (i32.add (local.get $state) (global.get $D3DIM_OFF_CLIP_STATUS)))
              (call $g2w (local.get $lpClip))
              (i32.const 24))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_clip_status (param $this i32) (param $lpClip i32)
    (local $state i32)
    (if (i32.eqz (local.get $lpClip)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w (local.get $lpClip))
              (call $g2w (i32.add (local.get $state) (global.get $D3DIM_OFF_CLIP_STATUS)))
              (i32.const 24))))
    (global.set $eax (i32.const 0)))

  ;; D3D execute buffers may PROCESSVERTICES in-place every frame. Keep the
  ;; original source vertex bytes so repeated transforms do not read TLVERTEX
  ;; output as D3DVERTEX input.
  (func $d3dim_execbuf_source_base (param $buf_guest i32) (result i32)
    (local $i i32) (local $entry i32) (local $tbl i32)
    (local $cache_g i32) (local $cache_wa i32) (local $buf_size i32)
    (if (i32.eqz (local.get $buf_guest)) (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (block $found (loop $scan
      (br_if $found (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (local.set $entry (i32.add (global.get $DX_OBJECTS)
        (i32.mul (local.get $i) (global.get $DX_ENTRY_SIZE))))
      (if (i32.and
            (i32.eq (i32.load (local.get $entry)) (i32.const 21))
            (i32.eq (i32.load (i32.add (local.get $entry) (i32.const 8))) (local.get $buf_guest)))
        (then (br $found)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (if (i32.ge_u (local.get $i) (global.get $D3DIM_EB_CACHE_MAX))
      (then (return (call $g2w (local.get $buf_guest)))))
    (local.set $tbl (i32.add (global.get $D3DIM_EB_CACHE_PTRS)
      (i32.mul (local.get $i) (i32.const 4))))
    (local.set $buf_size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (i32.or (i32.eqz (local.get $buf_size)) (i32.gt_u (local.get $buf_size) (i32.const 0x100000)))
      (then (return (call $g2w (local.get $buf_guest)))))
    (local.set $cache_g (i32.load (local.get $tbl)))
    (if (local.get $cache_g) (then
      (local.set $cache_wa (call $g2w (local.get $cache_g)))
      (if (i32.and
            (i32.eq (i32.load (local.get $cache_wa)) (local.get $buf_guest))
            (i32.eq (i32.load (i32.add (local.get $cache_wa) (i32.const 4))) (local.get $buf_size)))
        (then (return (i32.add (local.get $cache_wa) (global.get $D3DIM_EB_CACHE_HEADER)))))))
    (local.set $cache_g (call $heap_alloc
      (i32.add (local.get $buf_size) (global.get $D3DIM_EB_CACHE_HEADER))))
    (if (i32.eqz (local.get $cache_g))
      (then (return (call $g2w (local.get $buf_guest)))))
    (local.set $cache_wa (call $g2w (local.get $cache_g)))
    (i32.store (local.get $cache_wa) (local.get $buf_guest))
    (i32.store (i32.add (local.get $cache_wa) (i32.const 4)) (local.get $buf_size))
    (call $zero_memory (i32.add (local.get $cache_wa) (i32.const 8)) (i32.const 24))
    (call $memcpy
      (i32.add (local.get $cache_wa) (global.get $D3DIM_EB_CACHE_HEADER))
      (call $g2w (local.get $buf_guest))
      (local.get $buf_size))
    (i32.store (local.get $tbl) (local.get $cache_g))
    (i32.add (local.get $cache_wa) (global.get $D3DIM_EB_CACHE_HEADER)))

  ;; Return the cache header for one execute-buffer COM object. Unlock creates
  ;; this before SetExecuteData, which is the order used by the DX1 runtime.
  (func $d3dim_execbuf_cache_header (param $this i32) (result i32)
    (local $entry i32) (local $slot i32) (local $cache_g i32) (local $cache_wa i32)
    (if (i32.eqz (local.get $this)) (then (return (i32.const 0))))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $slot (call $dx_slot_of (local.get $entry)))
    (if (i32.ge_u (local.get $slot) (global.get $D3DIM_EB_CACHE_MAX))
      (then (return (i32.const 0))))
    (local.set $cache_g (i32.load (i32.add (global.get $D3DIM_EB_CACHE_PTRS)
      (i32.mul (local.get $slot) (i32.const 4)))))
    (if (i32.eqz (local.get $cache_g)) (then (return (i32.const 0))))
    (local.set $cache_wa (call $g2w (local.get $cache_g)))
    (if (i32.or
          (i32.ne (i32.load (local.get $cache_wa))
            (i32.load (i32.add (local.get $entry) (i32.const 8))))
          (i32.ne (i32.load (i32.add (local.get $cache_wa) (i32.const 4)))
            (i32.load (i32.add (local.get $entry) (i32.const 12)))))
      (then (return (i32.const 0))))
    (local.get $cache_wa))

  ;; D3DOP_SETSTATUS seeds dsStatus, then the driver replaces its sentinel
  ;; extent with the pixels affected by the execute buffer. The software
  ;; rasterizer currently draws the complete retained-mode viewport, so its
  ;; viewport rectangle is the conservative dirty extent D3DRM needs.
  (func $d3dim_exec_set_status
    (param $dev_this i32) (param $eb_this i32) (param $rec_wa i32)
    (local $header i32) (local $status i32) (local $state i32) (local $sw i32)
    (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (local.set $header (call $d3dim_execbuf_cache_header (local.get $eb_this)))
    (if (i32.eqz (local.get $header)) (then (return)))
    (local.set $status (i32.add (local.get $header) (i32.const 8)))
    (call $memcpy (local.get $status) (local.get $rec_wa) (i32.const 24))
    ;; D3DSETSTATUS_EXTENTS = 2.
    (if (i32.and (i32.load (local.get $status)) (i32.const 2)) (then
      (local.set $state (call $d3ddev_state (local.get $dev_this)))
      (if (local.get $state) (then
        (local.set $sw (call $g2w (local.get $state)))
        (local.set $x (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT))))
        (local.set $y (i32.load (i32.add (local.get $sw)
          (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4)))))
        (local.set $w (i32.load (i32.add (local.get $sw)
          (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8)))))
        (local.set $h (i32.load (i32.add (local.get $sw)
          (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12)))))
        (i32.store (i32.add (local.get $status) (i32.const 8)) (local.get $x))
        (i32.store (i32.add (local.get $status) (i32.const 12)) (local.get $y))
        (i32.store (i32.add (local.get $status) (i32.const 16))
          (i32.add (local.get $x) (local.get $w)))
        (i32.store (i32.add (local.get $status) (i32.const 20))
          (i32.add (local.get $y) (local.get $h))))))))

  (func $d3dim_execbuf_cache_clear (param $this i32)
    (local $entry i32) (local $slot i32) (local $tbl i32) (local $cache_g i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $slot (call $dx_slot_of (local.get $entry)))
    (if (i32.ge_u (local.get $slot) (global.get $D3DIM_EB_CACHE_MAX)) (then (return)))
    (local.set $tbl (i32.add (global.get $D3DIM_EB_CACHE_PTRS)
      (i32.mul (local.get $slot) (i32.const 4))))
    (local.set $cache_g (i32.load (local.get $tbl)))
    (if (local.get $cache_g) (then
      (call $heap_free (local.get $cache_g))
      (i32.store (local.get $tbl) (i32.const 0)))))

  (func $d3dim_execbuf_cache_refresh (param $this i32)
    (local $entry i32) (local $slot i32) (local $tbl i32)
    (local $buf_guest i32) (local $buf_size i32) (local $cache_g i32) (local $cache_wa i32)
    (if (i32.eqz (local.get $this)) (then (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (return)))
    (local.set $slot (call $dx_slot_of (local.get $entry)))
    (if (i32.ge_u (local.get $slot) (global.get $D3DIM_EB_CACHE_MAX)) (then (return)))
    (local.set $buf_guest (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $buf_size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (i32.or
          (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $buf_size)))
          (i32.gt_u (local.get $buf_size) (i32.const 0x100000)))
      (then (return)))
    (local.set $tbl (i32.add (global.get $D3DIM_EB_CACHE_PTRS)
      (i32.mul (local.get $slot) (i32.const 4))))
    (local.set $cache_g (i32.load (local.get $tbl)))
    (if (local.get $cache_g) (then
      (local.set $cache_wa (call $g2w (local.get $cache_g)))
      (if (i32.or
            (i32.ne (i32.load (local.get $cache_wa)) (local.get $buf_guest))
            (i32.ne (i32.load (i32.add (local.get $cache_wa) (i32.const 4))) (local.get $buf_size)))
        (then
          (call $heap_free (local.get $cache_g))
          (i32.store (local.get $tbl) (i32.const 0))
          (local.set $cache_g (i32.const 0))))))
    (if (i32.eqz (local.get $cache_g)) (then
      (local.set $cache_g (call $heap_alloc
        (i32.add (local.get $buf_size) (global.get $D3DIM_EB_CACHE_HEADER))))
      (if (i32.eqz (local.get $cache_g)) (then (return)))
      (i32.store (local.get $tbl) (local.get $cache_g))
      (local.set $cache_wa (call $g2w (local.get $cache_g)))
      (i32.store (local.get $cache_wa) (local.get $buf_guest))
      (i32.store (i32.add (local.get $cache_wa) (i32.const 4)) (local.get $buf_size))
      (call $zero_memory (i32.add (local.get $cache_wa) (i32.const 8)) (i32.const 24))))
    (if (i32.eqz (local.get $cache_wa)) (then
      (local.set $cache_wa (call $g2w (local.get $cache_g)))))
    (call $memcpy
      (i32.add (local.get $cache_wa) (global.get $D3DIM_EB_CACHE_HEADER))
      (call $g2w (local.get $buf_guest))
      (local.get $buf_size)))

  ;; ── Vertex-buffer backing storage ─────────────────────────────
  ;; DX7 vertex buffers need at least enough guest memory for Lock callers to
  ;; upload vertices. We store data at entry+8, byte size at +12, a copied
  ;; D3DVERTEXBUFFERDESC at +16, and cached FVF/vertex count at +20/+24.
  (func $d3dim_fvf_stride (param $fvf i32) (result i32)
    (local $stride i32) (local $tex i32)
    (if (i32.and (local.get $fvf) (i32.const 0x0004))
      (then (local.set $stride (i32.const 16)))  ;; XYZRHW
      (else
        (if (i32.and (local.get $fvf) (i32.const 0x0002))
          (then (local.set $stride (i32.const 12)))))) ;; XYZ
    (if (i32.and (local.get $fvf) (i32.const 0x0010))
      (then (local.set $stride (i32.add (local.get $stride) (i32.const 12)))))
    (if (i32.and (local.get $fvf) (i32.const 0x0040))
      (then (local.set $stride (i32.add (local.get $stride) (i32.const 4)))))
    (if (i32.and (local.get $fvf) (i32.const 0x0080))
      (then (local.set $stride (i32.add (local.get $stride) (i32.const 4)))))
    (local.set $tex (i32.and (i32.shr_u (local.get $fvf) (i32.const 8)) (i32.const 0xF)))
    (local.set $stride (i32.add (local.get $stride) (i32.mul (local.get $tex) (i32.const 8))))
    (if (i32.eqz (local.get $stride)) (then (local.set $stride (i32.const 32))))
    (local.get $stride))

  (func $d3dim_fvf_vtxtype (param $fvf i32) (result i32)
    (if (i32.and (local.get $fvf) (i32.const 0x0004))
      (then (return (i32.const 3)))) ;; XYZRHW -> TLVERTEX
    (if (i32.and (local.get $fvf) (i32.const 0x0002))
      (then
        (if (i32.or (i32.and (local.get $fvf) (i32.const 0x0040))
                    (i32.and (local.get $fvf) (i32.const 0x0080)))
          (then (return (i32.const 2)))) ;; diffuse/specular -> LVERTEX
        (return (i32.const 1))))         ;; XYZ[/NORMAL] -> VERTEX
    (i32.const 0))

  (func $d3dim_vertex_type_stride (param $vtxType i32) (result i32)
    ;; D3DLVERTEX includes a reserved DWORD between xyz and diffuse:
    ;; {x,y,z,dwReserved,color,specular,tu,tv}. It is therefore the same
    ;; 32-byte size as D3DVERTEX and D3DTLVERTEX, not 28 bytes.
    (i32.const 32))

  (func $d3dim_pack_fvf_vertices
    (param $fvf i32) (param $src_g i32) (param $count i32) (param $tex_index i32) (result i32)
    (local $type i32) (local $stride i32) (local $dst_stride i32) (local $size i32) (local $dst_g i32)
    (local $src_wa i32) (local $dst_wa i32) (local $i i32) (local $src i32) (local $dst i32)
    (local $offset i32) (local $tex_count i32)
    (local $head v128)
    (if (i32.or (i32.eqz (local.get $src_g)) (i32.eqz (local.get $count)))
      (then (return (i32.const 0))))
    (local.set $type (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (if (i32.eqz (local.get $type)) (then (return (i32.const 0))))
    (local.set $stride (call $d3dim_fvf_stride (local.get $fvf)))
    (local.set $tex_count (i32.and (i32.shr_u (local.get $fvf) (i32.const 8)) (i32.const 0xF)))
    (if (i32.ge_u (local.get $tex_index) (local.get $tex_count))
      (then (local.set $tex_index (i32.const 0))))
    (local.set $dst_stride (call $d3dim_vertex_type_stride (local.get $type)))
    (local.set $size (i32.mul (local.get $count) (local.get $dst_stride)))
    (if (i32.or (i32.eqz (local.get $size)) (i32.gt_u (local.get $size) (i32.const 0x400000)))
      (then (return (i32.const 0))))
    (local.set $dst_g (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $dst_g)) (then (return (i32.const 0))))
    (local.set $src_wa (call $g2w (local.get $src_g)))
    (local.set $dst_wa (call $g2w (local.get $dst_g)))
    ;; MW3's dominant format is exactly XYZRHW|DIFFUSE|SPECULAR|TEX3. Avoid
    ;; zeroing and repeatedly decoding that FVF for every vertex: all eight
    ;; canonical dwords are known, with only the selected UV pair non-contiguous.
    (if (i32.eq (local.get $fvf) (i32.const 0x3c4)) (then
      (local.set $i (i32.const 0))
      (block $fast_done (loop $fast_lp
        (br_if $fast_done (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $src (i32.add (local.get $src_wa) (i32.mul (local.get $i) (i32.const 48))))
        (local.set $dst (i32.add (local.get $dst_wa) (i32.shl (local.get $i) (i32.const 5))))
        (local.set $head (v128.load (local.get $src)))
        (v128.store (local.get $dst) (local.get $head))
        (i64.store offset=16 (local.get $dst) (i64.load offset=16 (local.get $src)))
        (local.set $offset (i32.add (i32.const 24) (i32.shl (local.get $tex_index) (i32.const 3))))
        (i32.store offset=24 (local.get $dst) (i32.load (i32.add (local.get $src) (local.get $offset))))
        (i32.store offset=28 (local.get $dst)
          (i32.load offset=4 (i32.add (local.get $src) (local.get $offset))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $fast_lp)))
      (return (local.get $dst_g))))
    (call $zero_memory (local.get $dst_wa) (local.get $size))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $src (i32.add (local.get $src_wa) (i32.mul (local.get $i) (local.get $stride))))
      (local.set $dst (i32.add (local.get $dst_wa) (i32.mul (local.get $i) (local.get $dst_stride))))
      (if (i32.eq (local.get $type) (i32.const 3))
        (then
          (call $memcpy (local.get $dst) (local.get $src) (i32.const 16))
          (local.set $offset (i32.const 16))
          (i32.store (i32.add (local.get $dst) (i32.const 16)) (i32.const 0xFFFFFFFF))
          (if (i32.and (local.get $fvf) (i32.const 0x0040)) (then
            (i32.store (i32.add (local.get $dst) (i32.const 16))
              (i32.load (i32.add (local.get $src) (local.get $offset))))
            (local.set $offset (i32.add (local.get $offset) (i32.const 4)))))
          (if (i32.and (local.get $fvf) (i32.const 0x0080)) (then
            (i32.store (i32.add (local.get $dst) (i32.const 20))
              (i32.load (i32.add (local.get $src) (local.get $offset))))
            (local.set $offset (i32.add (local.get $offset) (i32.const 4)))))
          (if (local.get $tex_count) (then
            (local.set $offset (i32.add (local.get $offset) (i32.shl (local.get $tex_index) (i32.const 3))))
            (i32.store (i32.add (local.get $dst) (i32.const 24))
              (i32.load (i32.add (local.get $src) (local.get $offset))))
            (i32.store (i32.add (local.get $dst) (i32.const 28))
              (i32.load (i32.add (local.get $src) (i32.add (local.get $offset) (i32.const 4))))))))
        (else
          (if (i32.eq (local.get $type) (i32.const 2))
            (then
              (call $memcpy (local.get $dst) (local.get $src) (i32.const 12))
              (local.set $offset (i32.const 12))
              (i32.store (i32.add (local.get $dst) (i32.const 12)) (i32.const 0xFFFFFFFF))
              (i32.store (i32.add (local.get $dst) (i32.const 16)) (i32.const 0))
              (if (i32.and (local.get $fvf) (i32.const 0x0010))
                (then (local.set $offset (i32.add (local.get $offset) (i32.const 12)))))
              (if (i32.and (local.get $fvf) (i32.const 0x0040)) (then
                (i32.store (i32.add (local.get $dst) (i32.const 12))
                  (i32.load (i32.add (local.get $src) (local.get $offset))))
                (local.set $offset (i32.add (local.get $offset) (i32.const 4)))))
              (if (i32.and (local.get $fvf) (i32.const 0x0080)) (then
                (i32.store (i32.add (local.get $dst) (i32.const 16))
                  (i32.load (i32.add (local.get $src) (local.get $offset))))
                (local.set $offset (i32.add (local.get $offset) (i32.const 4)))))
              (if (local.get $tex_count) (then
                (local.set $offset (i32.add (local.get $offset) (i32.shl (local.get $tex_index) (i32.const 3))))
                (i32.store (i32.add (local.get $dst) (i32.const 20))
                  (i32.load (i32.add (local.get $src) (local.get $offset))))
                (i32.store (i32.add (local.get $dst) (i32.const 24))
                  (i32.load (i32.add (local.get $src) (i32.add (local.get $offset) (i32.const 4))))))))
            (else
              (call $memcpy (local.get $dst) (local.get $src) (i32.const 12))
              (local.set $offset (i32.const 12))
              (if (i32.and (local.get $fvf) (i32.const 0x0010))
                (then
                  (call $memcpy (i32.add (local.get $dst) (i32.const 12))
                                (i32.add (local.get $src) (local.get $offset))
                                (i32.const 12))
                  (local.set $offset (i32.add (local.get $offset) (i32.const 12))))
                (else
                  (f32.store (i32.add (local.get $dst) (i32.const 20)) (f32.const 1.0))))
              (if (local.get $tex_count) (then
                (local.set $offset (i32.add (local.get $offset) (i32.shl (local.get $tex_index) (i32.const 3))))
                (i32.store (i32.add (local.get $dst) (i32.const 24))
                  (i32.load (i32.add (local.get $src) (local.get $offset))))
                (i32.store (i32.add (local.get $dst) (i32.const 28))
                  (i32.load (i32.add (local.get $src) (i32.add (local.get $offset) (i32.const 4)))))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $dst_g))

  (func $d3dim_create_vb (param $lpDesc i32) (param $ppVB i32) (param $vtbl i32)
    (local $obj i32) (local $entry i32) (local $desc_g i32) (local $data_g i32)
    (local $desc_size i32) (local $fvf i32) (local $count i32) (local $size i32)
    (if (i32.eqz (local.get $ppVB)) (then (global.set $eax (i32.const 0x80004003)) (return)))
    (local.set $obj (call $dx_create_com_obj (i32.const 22) (local.get $vtbl)))
    (if (i32.eqz (local.get $obj)) (then (global.set $eax (i32.const 0x80004005)) (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (if (local.get $lpDesc) (then
      (local.set $desc_size (call $gl32 (local.get $lpDesc)))
      (if (i32.lt_u (local.get $desc_size) (i32.const 16)) (then (local.set $desc_size (i32.const 16))))
      (if (i32.gt_u (local.get $desc_size) (i32.const 32)) (then (local.set $desc_size (i32.const 32))))
      (local.set $fvf (call $gl32 (i32.add (local.get $lpDesc) (i32.const 8))))
      (local.set $count (call $gl32 (i32.add (local.get $lpDesc) (i32.const 12))))
      (local.set $desc_g (call $heap_alloc (i32.const 32)))
      (if (local.get $desc_g) (then
        (call $zero_memory (call $g2w (local.get $desc_g)) (i32.const 32))
        (call $memcpy (call $g2w (local.get $desc_g)) (call $g2w (local.get $lpDesc)) (local.get $desc_size))
        (call $gs32 (local.get $desc_g) (local.get $desc_size))
        (i32.store (i32.add (local.get $entry) (i32.const 16)) (local.get $desc_g))))))
    (local.set $size (i32.mul (call $d3dim_fvf_stride (local.get $fvf)) (local.get $count)))
    (if (i32.eqz (local.get $size)) (then (local.set $size (i32.const 4096))))
    (if (i32.gt_u (local.get $size) (i32.const 0x400000)) (then (local.set $size (i32.const 0x400000))))
    (local.set $data_g (call $heap_alloc (local.get $size)))
    (if (local.get $data_g) (then
      (call $zero_memory (call $g2w (local.get $data_g)) (local.get $size))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $data_g))))
    (i32.store (i32.add (local.get $entry) (i32.const 12)) (local.get $size))
    (i32.store (i32.add (local.get $entry) (i32.const 20)) (local.get $fvf))
    (i32.store (i32.add (local.get $entry) (i32.const 24)) (local.get $count))
    (call $gs32 (local.get $ppVB) (local.get $obj))
    (global.set $eax (i32.const 0)))

  (func $d3dim_vb_free_entry (param $entry i32)
    (local $ptr i32)
    (local.set $ptr (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (local.set $ptr (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (if (local.get $ptr) (then (call $heap_free (local.get $ptr))))
    (call $dx_free (local.get $entry)))

  (func $d3dim_vb_lock (param $this i32) (param $ppData i32) (param $pSize i32)
    (local $entry i32) (local $data_g i32) (local $size i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $data_g (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (local.get $ppData) (then (call $gs32 (local.get $ppData) (local.get $data_g))))
    (if (local.get $pSize) (then (call $gs32 (local.get $pSize) (local.get $size))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_vb_get_desc (param $this i32) (param $lpDesc i32)
    (local $entry i32) (local $desc_g i32) (local $copy_size i32)
    (if (i32.eqz (local.get $lpDesc)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $desc_g (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (local.set $copy_size (call $gl32 (local.get $lpDesc)))
    (if (i32.lt_u (local.get $copy_size) (i32.const 16)) (then (local.set $copy_size (i32.const 16))))
    (if (i32.gt_u (local.get $copy_size) (i32.const 32)) (then (local.set $copy_size (i32.const 32))))
    (if (local.get $desc_g)
      (then (call $memcpy (call $g2w (local.get $lpDesc)) (call $g2w (local.get $desc_g)) (local.get $copy_size)))
      (else (call $zero_memory (call $g2w (local.get $lpDesc)) (local.get $copy_size))))
    (call $gs32 (local.get $lpDesc) (local.get $copy_size))
    (global.set $eax (i32.const 0)))

  (func $d3dim_vb_draw_primitive
    (param $this i32) (param $primType i32) (param $vb i32) (param $start i32) (param $count i32)
    (local $entry i32) (local $data_g i32) (local $size i32) (local $fvf i32)
    (local $stride i32) (local $max_count i32) (local $vtxType i32) (local $packed i32)
    (if (i32.or (i32.eqz (local.get $vb)) (i32.eqz (local.get $count)))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $vb)))
    (local.set $data_g (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (local.set $fvf (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (local.set $stride (call $d3dim_fvf_stride (local.get $fvf)))
    (local.set $vtxType (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (if (i32.eqz (local.get $vtxType))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $max_count (i32.div_u (local.get $size) (local.get $stride)))
    (if (i32.ge_u (local.get $start) (local.get $max_count))
      (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $max_count) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $max_count) (local.get $start)))))
    (local.set $packed (call $d3dim_pack_fvf_vertices
      (local.get $fvf)
      (i32.add (local.get $data_g) (i32.mul (local.get $start) (local.get $stride)))
      (local.get $count)
      (call $d3dim_texcoord_index (local.get $this))))
    (if (local.get $packed) (then
      (call $d3dim_draw_primitive
        (local.get $this) (local.get $primType) (local.get $vtxType)
        (local.get $packed) (local.get $count))
      (call $heap_free (local.get $packed))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_vb_draw_indexed_primitive
    (param $this i32) (param $primType i32) (param $vb i32) (param $start i32) (param $count i32)
    (param $indices i32) (param $index_count i32)
    (local $entry i32) (local $data_g i32) (local $size i32) (local $fvf i32)
    (local $stride i32) (local $max_count i32) (local $vtxType i32) (local $packed i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $vb)) (i32.eqz (local.get $count)))
          (i32.or (i32.eqz (local.get $indices)) (i32.eqz (local.get $index_count))))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $vb)))
    (local.set $data_g (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (local.set $fvf (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (local.set $stride (call $d3dim_fvf_stride (local.get $fvf)))
    (local.set $vtxType (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (if (i32.eqz (local.get $vtxType))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $max_count (i32.div_u (local.get $size) (local.get $stride)))
    (if (i32.ge_u (local.get $start) (local.get $max_count))
      (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.gt_u (local.get $count) (i32.sub (local.get $max_count) (local.get $start)))
      (then (local.set $count (i32.sub (local.get $max_count) (local.get $start)))))
    (local.set $packed (call $d3dim_pack_fvf_vertices
      (local.get $fvf)
      (i32.add (local.get $data_g) (i32.mul (local.get $start) (local.get $stride)))
      (local.get $count)
      (call $d3dim_texcoord_index (local.get $this))))
    (if (local.get $packed) (then
      (call $d3dim_draw_indexed_primitive
        (local.get $this) (local.get $primType) (local.get $vtxType)
        (local.get $packed) (local.get $count)
        (local.get $indices) (local.get $index_count))
      (call $heap_free (local.get $packed))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_pack_strided_tl
    (param $fvf i32) (param $strided i32) (param $count i32) (param $tex_index i32) (result i32)
    (local $type i32) (local $size i32) (local $dst_g i32) (local $dst_wa i32) (local $i i32)
    (local $pos_g i32) (local $pos_stride i32) (local $pos_wa i32)
    (local $norm_g i32) (local $norm_stride i32) (local $norm_wa i32)
    (local $diff_g i32) (local $diff_stride i32) (local $diff_wa i32)
    (local $spec_g i32) (local $spec_stride i32) (local $spec_wa i32)
    (local $tex_g i32) (local $tex_stride i32) (local $tex_wa i32)
    (local $src i32) (local $dst i32)
    (local.set $type (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (if (i32.or
          (i32.or (i32.eqz (local.get $strided)) (i32.eqz (local.get $count)))
          (i32.eqz (local.get $type)))
      (then (return (i32.const 0))))
    (local.set $pos_g (call $gl32 (local.get $strided)))
    (local.set $pos_stride (call $gl32 (i32.add (local.get $strided) (i32.const 4))))
    (if (i32.eqz (local.get $pos_g)) (then (return (i32.const 0))))
    (if (i32.eqz (local.get $pos_stride)) (then
      (if (i32.eq (local.get $type) (i32.const 3))
        (then (local.set $pos_stride (i32.const 16)))
        (else (local.set $pos_stride (i32.const 12))))))
    (local.set $pos_wa (call $g2w (local.get $pos_g)))
    (if (i32.and (local.get $fvf) (i32.const 0x0010)) (then
      (local.set $norm_g (call $gl32 (i32.add (local.get $strided) (i32.const 8))))
      (local.set $norm_stride (call $gl32 (i32.add (local.get $strided) (i32.const 12))))
      (if (i32.eqz (local.get $norm_stride)) (then (local.set $norm_stride (i32.const 12))))
      (if (local.get $norm_g) (then (local.set $norm_wa (call $g2w (local.get $norm_g)))))))
    (if (i32.and (local.get $fvf) (i32.const 0x0040)) (then
      (local.set $diff_g (call $gl32 (i32.add (local.get $strided) (i32.const 16))))
      (local.set $diff_stride (call $gl32 (i32.add (local.get $strided) (i32.const 20))))
      (if (i32.eqz (local.get $diff_stride)) (then (local.set $diff_stride (i32.const 4))))
      (if (local.get $diff_g) (then (local.set $diff_wa (call $g2w (local.get $diff_g)))))))
    (if (i32.and (local.get $fvf) (i32.const 0x0080)) (then
      (local.set $spec_g (call $gl32 (i32.add (local.get $strided) (i32.const 24))))
      (local.set $spec_stride (call $gl32 (i32.add (local.get $strided) (i32.const 28))))
      (if (i32.eqz (local.get $spec_stride)) (then (local.set $spec_stride (i32.const 4))))
      (if (local.get $spec_g) (then (local.set $spec_wa (call $g2w (local.get $spec_g)))))))
    (if (i32.and (i32.shr_u (local.get $fvf) (i32.const 8)) (i32.const 0xF)) (then
      (if (i32.ge_u (local.get $tex_index)
            (i32.and (i32.shr_u (local.get $fvf) (i32.const 8)) (i32.const 0xF)))
        (then (local.set $tex_index (i32.const 0))))
      (local.set $tex_g (call $gl32 (i32.add (local.get $strided)
        (i32.add (i32.const 32) (i32.shl (local.get $tex_index) (i32.const 3))))))
      (local.set $tex_stride (call $gl32 (i32.add (local.get $strided)
        (i32.add (i32.const 36) (i32.shl (local.get $tex_index) (i32.const 3))))))
      (if (i32.eqz (local.get $tex_stride)) (then (local.set $tex_stride (i32.const 8))))
      (if (local.get $tex_g) (then (local.set $tex_wa (call $g2w (local.get $tex_g)))))))
    (local.set $size (i32.mul (local.get $count) (i32.const 32)))
    (if (i32.or (i32.eqz (local.get $size)) (i32.gt_u (local.get $size) (i32.const 0x400000)))
      (then (return (i32.const 0))))
    (local.set $dst_g (call $heap_alloc (local.get $size)))
    (if (i32.eqz (local.get $dst_g)) (then (return (i32.const 0))))
    (local.set $dst_wa (call $g2w (local.get $dst_g)))
    (call $zero_memory (local.get $dst_wa) (local.get $size))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $dst (i32.add (local.get $dst_wa) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $src (i32.add (local.get $pos_wa) (i32.mul (local.get $i) (local.get $pos_stride))))
      (if (i32.eq (local.get $type) (i32.const 3))
        (then
          (f32.store (local.get $dst) (f32.load (local.get $src)))
          (f32.store (i32.add (local.get $dst) (i32.const 4)) (f32.load (i32.add (local.get $src) (i32.const 4))))
          (f32.store (i32.add (local.get $dst) (i32.const 8)) (f32.load (i32.add (local.get $src) (i32.const 8))))
          (f32.store (i32.add (local.get $dst) (i32.const 12)) (f32.load (i32.add (local.get $src) (i32.const 12)))))
        (else
          (f32.store (local.get $dst) (f32.load (local.get $src)))
          (f32.store (i32.add (local.get $dst) (i32.const 4)) (f32.load (i32.add (local.get $src) (i32.const 4))))
          (f32.store (i32.add (local.get $dst) (i32.const 8)) (f32.load (i32.add (local.get $src) (i32.const 8))))
          (if (local.get $norm_wa)
            (then
              (local.set $src (i32.add (local.get $norm_wa) (i32.mul (local.get $i) (local.get $norm_stride))))
              (call $memcpy (i32.add (local.get $dst) (i32.const 12)) (local.get $src) (i32.const 12)))
            (else
              (f32.store (i32.add (local.get $dst) (i32.const 20)) (f32.const 1.0))))))
      (if (local.get $diff_wa)
        (then
          (i32.store (i32.add (local.get $dst) (i32.const 16))
            (i32.load (i32.add (local.get $diff_wa) (i32.mul (local.get $i) (local.get $diff_stride))))))
        (else (i32.store (i32.add (local.get $dst) (i32.const 16)) (i32.const 0xFFFFFFFF))))
      (if (local.get $spec_wa) (then
        (i32.store (i32.add (local.get $dst) (i32.const 20))
          (i32.load (i32.add (local.get $spec_wa) (i32.mul (local.get $i) (local.get $spec_stride)))))))
      (if (local.get $tex_wa) (then
        (local.set $src (i32.add (local.get $tex_wa) (i32.mul (local.get $i) (local.get $tex_stride))))
        (f32.store (i32.add (local.get $dst) (i32.const 24)) (f32.load (local.get $src)))
        (f32.store (i32.add (local.get $dst) (i32.const 28)) (f32.load (i32.add (local.get $src) (i32.const 4))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $dst_g))

  (func $d3dim_draw_primitive_strided
    (param $this i32) (param $primType i32) (param $fvf i32) (param $strided i32) (param $count i32)
    (local $scratch i32) (local $vtxType i32)
    (local.set $vtxType (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (local.set $scratch (call $d3dim_pack_strided_tl
      (local.get $fvf) (local.get $strided) (local.get $count)
      (call $d3dim_texcoord_index (local.get $this))))
    (if (local.get $scratch) (then
      (call $d3dim_draw_primitive
        (local.get $this) (local.get $primType) (local.get $vtxType)
        (local.get $scratch) (local.get $count))
      (call $heap_free (local.get $scratch))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_draw_indexed_primitive_strided
    (param $this i32) (param $primType i32) (param $fvf i32) (param $strided i32) (param $count i32)
    (param $indices i32) (param $index_count i32)
    (local $scratch i32) (local $vtxType i32)
    (local.set $vtxType (call $d3dim_fvf_vtxtype (local.get $fvf)))
    (local.set $scratch (call $d3dim_pack_strided_tl
      (local.get $fvf) (local.get $strided) (local.get $count)
      (call $d3dim_texcoord_index (local.get $this))))
    (if (local.get $scratch) (then
      (call $d3dim_draw_indexed_primitive
        (local.get $this) (local.get $primType) (local.get $vtxType)
        (local.get $scratch) (local.get $count)
        (local.get $indices) (local.get $index_count))
      (call $heap_free (local.get $scratch))))
    (global.set $eax (i32.const 0)))

  ;; ── Material/background state ─────────────────────────────────
  ;; Material objects keep a private D3DMATERIAL copy at entry+8, with the
  ;; stored byte count at entry+12. Legacy material handles are DX slot ids.
  (func $d3dim_material_set (param $this i32) (param $lpMat i32)
    (local $entry i32) (local $dst i32) (local $sz i32)
    (if (i32.eqz (local.get $lpMat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $sz (call $gl32 (local.get $lpMat)))
    (if (i32.or (i32.eqz (local.get $sz)) (i32.gt_u (local.get $sz) (i32.const 80)))
      (then (local.set $sz (i32.const 80))))
    (if (i32.lt_u (local.get $sz) (i32.const 4)) (then (local.set $sz (i32.const 4))))
    (local.set $dst (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (i32.eqz (local.get $dst)) (then
      (local.set $dst (call $heap_alloc (i32.const 80)))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $dst))))
    (call $zero_memory (call $g2w (local.get $dst)) (i32.const 80))
    (call $memcpy (call $g2w (local.get $dst)) (call $g2w (local.get $lpMat)) (local.get $sz))
    (i32.store (i32.add (local.get $entry) (i32.const 12)) (local.get $sz))
    (global.set $eax (i32.const 0)))

  (func $d3dim_material_get (param $this i32) (param $lpMat i32)
    (local $entry i32) (local $src i32) (local $stored_sz i32) (local $sz i32)
    (if (i32.eqz (local.get $lpMat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $src (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $stored_sz (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (local.set $sz (call $gl32 (local.get $lpMat)))
    (if (i32.eqz (local.get $stored_sz)) (then (local.set $stored_sz (i32.const 80))))
    (if (i32.or (i32.eqz (local.get $sz)) (i32.gt_u (local.get $sz) (local.get $stored_sz)))
      (then (local.set $sz (local.get $stored_sz))))
    (if (i32.gt_u (local.get $sz) (i32.const 80)) (then (local.set $sz (i32.const 80))))
    (if (local.get $src)
      (then (call $memcpy (call $g2w (local.get $lpMat)) (call $g2w (local.get $src)) (local.get $sz)))
      (else (call $zero_memory (call $g2w (local.get $lpMat)) (local.get $sz))))
    (call $gs32 (local.get $lpMat) (local.get $sz))
    (global.set $eax (i32.const 0)))

  (func $d3dim_material_get_handle (param $this i32) (param $lpDev i32) (param $lpHandle i32)
    (local $entry i32)
    (if (local.get $lpHandle) (then
      (local.set $entry (call $dx_from_this (local.get $this)))
      (call $gs32 (local.get $lpHandle) (call $dx_slot_of (local.get $entry)))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_set_material (param $this i32) (param $lpMat i32)
    (local $state i32)
    (if (i32.eqz (local.get $lpMat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w (i32.add (local.get $state) (global.get $D3DIM_OFF_D3D7_MAT)))
              (call $g2w (local.get $lpMat))
              (i32.const 68))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_get_material (param $this i32) (param $lpMat i32)
    (local $state i32)
    (if (i32.eqz (local.get $lpMat)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w (local.get $lpMat))
              (call $g2w (i32.add (local.get $state) (global.get $D3DIM_OFF_D3D7_MAT)))
              (i32.const 68)))
      (else (call $zero_memory (call $g2w (local.get $lpMat)) (i32.const 68))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_light_table (param $state i32) (result i32)
    (local $sw i32) (local $table i32)
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $table (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_D3D7_LIGHTS))))
    (if (i32.eqz (local.get $table)) (then
      (local.set $table (call $heap_alloc (i32.const 832)))
      (if (local.get $table) (then
        (call $zero_memory (call $g2w (local.get $table)) (i32.const 832))
        (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_D3D7_LIGHTS))
          (local.get $table))))))
    (local.get $table))

  (func $d3dim_device7_set_light (param $this i32) (param $idx i32) (param $lpLight i32)
    (local $state i32) (local $table i32)
    (if (i32.eqz (local.get $lpLight)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.ge_u (local.get $idx) (i32.const 8)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (local.set $table (call $d3dim_device7_light_table (local.get $state)))
    (if (local.get $table)
      (then (call $memcpy
              (call $g2w (i32.add (local.get $table) (i32.mul (local.get $idx) (i32.const 104))))
              (call $g2w (local.get $lpLight))
              (i32.const 104))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_get_light (param $this i32) (param $idx i32) (param $lpLight i32)
    (local $state i32) (local $table i32)
    (if (i32.eqz (local.get $lpLight)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.ge_u (local.get $idx) (i32.const 8))
      (then
        (call $zero_memory (call $g2w (local.get $lpLight)) (i32.const 104))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then
        (local.set $table
          (i32.load
            (i32.add (call $g2w (local.get $state)) (global.get $D3DIM_OFF_D3D7_LIGHTS))))))
    (if (local.get $table)
      (then (call $memcpy
              (call $g2w (local.get $lpLight))
              (call $g2w (i32.add (local.get $table) (i32.mul (local.get $idx) (i32.const 104))))
              (i32.const 104)))
      (else (call $zero_memory (call $g2w (local.get $lpLight)) (i32.const 104))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_light_enable (param $this i32) (param $idx i32) (param $enable i32)
    (local $state i32) (local $sw i32) (local $mask i32) (local $bit i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and
          (i32.ne (local.get $state) (i32.const 0))
          (i32.lt_u (local.get $idx) (i32.const 32))) (then
      (local.set $sw (call $g2w (local.get $state)))
      (local.set $mask (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_D3D7_LIGHT_ENABLE))))
      (local.set $bit (i32.shl (i32.const 1) (local.get $idx)))
      (if (local.get $enable)
        (then (local.set $mask (i32.or (local.get $mask) (local.get $bit))))
        (else (local.set $mask (i32.and (local.get $mask) (i32.xor (local.get $bit) (i32.const -1))))))
      (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_D3D7_LIGHT_ENABLE))
        (local.get $mask))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_get_light_enable (param $this i32) (param $idx i32) (param $out i32)
    (local $state i32) (local $mask i32) (local $val i32)
    (if (i32.eqz (local.get $out)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and
          (i32.ne (local.get $state) (i32.const 0))
          (i32.lt_u (local.get $idx) (i32.const 32))) (then
      (local.set $mask
        (i32.load
          (i32.add (call $g2w (local.get $state)) (global.get $D3DIM_OFF_D3D7_LIGHT_ENABLE))))
      (if (i32.and (local.get $mask) (i32.shl (i32.const 1) (local.get $idx)))
        (then (local.set $val (i32.const 1))))))
    (call $gs32 (local.get $out) (local.get $val))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_set_clip_plane (param $this i32) (param $idx i32) (param $plane i32)
    (local $state i32)
    (if (i32.eqz (local.get $plane)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.ge_u (local.get $idx) (i32.const 6)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w
                (i32.add
                  (i32.add (local.get $state) (global.get $D3DIM_OFF_D3D7_CLIP_PLANES))
                  (i32.mul (local.get $idx) (i32.const 16))))
              (call $g2w (local.get $plane))
              (i32.const 16))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_get_clip_plane (param $this i32) (param $idx i32) (param $plane i32)
    (local $state i32)
    (if (i32.eqz (local.get $plane)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.ge_u (local.get $idx) (i32.const 6))
      (then
        (call $zero_memory (call $g2w (local.get $plane)) (i32.const 16))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state)
      (then (call $memcpy
              (call $g2w (local.get $plane))
              (call $g2w
                (i32.add
                  (i32.add (local.get $state) (global.get $D3DIM_OFF_D3D7_CLIP_PLANES))
                  (i32.mul (local.get $idx) (i32.const 16))))
              (i32.const 16)))
      (else (call $zero_memory (call $g2w (local.get $plane)) (i32.const 16))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_material_pack_color (param $mat_wa i32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (local.set $r (i32.trunc_sat_f32_u
      (f32.mul
        (f32.min (f32.max (f32.load (i32.add (local.get $mat_wa) (i32.const 4))) (f32.const 0.0)) (f32.const 1.0))
        (f32.const 255.0))))
    (local.set $g (i32.trunc_sat_f32_u
      (f32.mul
        (f32.min (f32.max (f32.load (i32.add (local.get $mat_wa) (i32.const 8))) (f32.const 0.0)) (f32.const 1.0))
        (f32.const 255.0))))
    (local.set $b (i32.trunc_sat_f32_u
      (f32.mul
        (f32.min (f32.max (f32.load (i32.add (local.get $mat_wa) (i32.const 12))) (f32.const 0.0)) (f32.const 1.0))
        (f32.const 255.0))))
    (i32.or (i32.const 0xFF000000)
      (i32.or
        (i32.shl (local.get $r) (i32.const 16))
        (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))

  (func $d3dim_scale_color (param $color i32) (param $shade f32) (result i32)
    (local $r i32) (local $g i32) (local $b i32)
    (if (f32.lt (local.get $shade) (f32.const 0.0)) (then (local.set $shade (f32.const 0.0))))
    (if (f32.gt (local.get $shade) (f32.const 1.0)) (then (local.set $shade (f32.const 1.0))))
    (local.set $r (i32.trunc_sat_f32_u
      (f32.mul
        (f32.convert_i32_u (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xFF)))
        (local.get $shade))))
    (local.set $g (i32.trunc_sat_f32_u
      (f32.mul
        (f32.convert_i32_u (i32.and (i32.shr_u (local.get $color) (i32.const 8)) (i32.const 0xFF)))
        (local.get $shade))))
    (local.set $b (i32.trunc_sat_f32_u
      (f32.mul
        (f32.convert_i32_u (i32.and (local.get $color) (i32.const 0xFF)))
        (local.get $shade))))
    (i32.or (i32.const 0xFF000000)
      (i32.or
        (i32.shl (local.get $r) (i32.const 16))
        (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))

  (func $d3dim_material_color_from_handle (param $handle i32) (result i32)
    (local $entry i32) (local $mat i32) (local $sz i32)
    (if (i32.or (i32.eqz (local.get $handle))
                (i32.ge_u (local.get $handle) (global.get $DX_MAX)))
      (then (return (i32.const 0xFFFFFFFF))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $handle) (i32.const 32))))
    (if (i32.ne (i32.load (local.get $entry)) (i32.const 25))
      (then (return (i32.const 0xFFFFFFFF))))
    (local.set $mat (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $sz (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (i32.or (i32.eqz (local.get $mat)) (i32.lt_u (local.get $sz) (i32.const 20)))
      (then (return (i32.const 0xFFFFFFFF))))
    (call $d3dim_material_pack_color (call $g2w (local.get $mat))))

  ;; The texture a material carries in D3DMATERIAL.hTexture (+72), resolved to a
  ;; DX surface entry, or 0 when the material is a plain colour.
  ;;
  ;; A viewport background set from a D3DRM scene *image* arrives this way: the
  ;; material's diffuse stays white and the picture hangs off hTexture, so a
  ;; clear that only reads the diffuse paints the whole frame white. That is
  ;; exactly what the Plus! 98 Organic Art screensavers (ROCKROLL, GEOMETRY)
  ;; showed -- correct geometry over a blank white sky.
  (func $d3dim_material_texture_entry (param $handle i32) (result i32)
    (local $entry i32) (local $mat i32) (local $sz i32)
    (if (i32.or (i32.eqz (local.get $handle))
                (i32.ge_u (local.get $handle) (global.get $DX_MAX)))
      (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $handle) (i32.const 32))))
    (if (i32.ne (i32.load (local.get $entry)) (i32.const 25))
      (then (return (i32.const 0))))
    (local.set $mat (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $sz (i32.load (i32.add (local.get $entry) (i32.const 12))))
    ;; hTexture sits at +72, so a material struct shorter than that has none.
    (if (i32.or (i32.eqz (local.get $mat)) (i32.lt_u (local.get $sz) (i32.const 76)))
      (then (return (i32.const 0))))
    (call $d3dim_texture_entry_from_slot
      (call $gl32 (i32.add (local.get $mat) (i32.const 72)))))

  (func $d3dim_current_material_color (param $state_guest i32) (result i32)
    (if (i32.eqz (local.get $state_guest)) (then (return (i32.const 0xFFFFFFFF))))
    ;; D3DLIGHTSTATE_MATERIAL = 1, stored at state+2304+1*4.
    (call $d3dim_material_color_from_handle
      (call $gl32 (i32.add (local.get $state_guest) (i32.const 2308)))))

  ;; The material handle bound via D3DLIGHTSTATE_MATERIAL, as a guest pointer to
  ;; the caller's D3DMATERIAL (dcvDiffuse@4, dcvAmbient@20, dcvEmissive@52).
  ;; 0 when no usable material is bound.
  (func $d3dim_current_material_ptr (param $state_guest i32) (result i32)
    (local $handle i32) (local $entry i32)
    (if (i32.eqz (local.get $state_guest)) (then (return (i32.const 0))))
    (local.set $handle (call $gl32 (i32.add (local.get $state_guest) (i32.const 2308))))
    (if (i32.or (i32.eqz (local.get $handle))
                (i32.ge_u (local.get $handle) (global.get $DX_MAX)))
      (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $handle) (i32.const 32))))
    (if (i32.ne (i32.load (local.get $entry)) (i32.const 25)) (then (return (i32.const 0))))
    (if (i32.lt_u (i32.load (i32.add (local.get $entry) (i32.const 12))) (i32.const 20))
      (then (return (i32.const 0))))
    (i32.load (i32.add (local.get $entry) (i32.const 8))))

  ;; ── Fixed-function lighting ───────────────────────────────────
  ;; IDirect3DLight slots are DX_OBJECTS type 24 with their 76-byte D3DLIGHT
  ;; buffer hanging off entry+8 (see $dx_light_buf). Scanning all 1024 slots per
  ;; vertex would be absurd, so the callers refresh this four-slot cache once per
  ;; draw call — every entry point that lights vertices already calls
  ;; $d3ddev_composite_wvp, and the refresh sits next to it.
  (global $d3dim_light_n (mut i32) (i32.const 0))
  (global $d3dim_light0 (mut i32) (i32.const 0))
  (global $d3dim_light1 (mut i32) (i32.const 0))
  (global $d3dim_light2 (mut i32) (i32.const 0))
  (global $d3dim_light3 (mut i32) (i32.const 0))

  (global $d3dim_dbg_light_last (mut i32) (i32.const -1))

  (func $d3dim_lights_refresh (param $state_guest i32)
    (local $i i32) (local $entry i32) (local $buf i32) (local $n i32) (local $mat i32)
    (local.set $n (i32.const 0))
    (local.set $i (i32.const 1))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (br_if $done (i32.ge_u (local.get $n) (i32.const 4)))
      (local.set $entry (i32.add (global.get $DX_OBJECTS)
        (i32.mul (local.get $i) (i32.const 32))))
      (if (i32.eq (i32.load (local.get $entry)) (i32.const 24)) (then
        (local.set $buf (i32.load (i32.add (local.get $entry) (i32.const 8))))
        ;; dwSize==0 ⇒ CreateLight ran but SetLight never did; nothing to shade with.
        (if (local.get $buf) (then
          (if (call $gl32 (local.get $buf)) (then
            (if (i32.eq (local.get $n) (i32.const 0)) (then (global.set $d3dim_light0 (local.get $buf))))
            (if (i32.eq (local.get $n) (i32.const 1)) (then (global.set $d3dim_light1 (local.get $buf))))
            (if (i32.eq (local.get $n) (i32.const 2)) (then (global.set $d3dim_light2 (local.get $buf))))
            (if (i32.eq (local.get $n) (i32.const 3)) (then (global.set $d3dim_light3 (local.get $buf))))
            (local.set $n (i32.add (local.get $n) (i32.const 1)))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (global.set $d3dim_light_n (local.get $n))
    ;; kind=19 Lights: how many lights are live, plus the first light record and
    ;; the bound material. "White geometry" and "no material bound" render the
    ;; same and cannot be told apart from the API trace.
    (local.set $mat (call $d3dim_current_material_ptr (local.get $state_guest)))
    (local.set $entry (i32.or (i32.shl (local.get $n) (i32.const 1))
                              (i32.ne (local.get $mat) (i32.const 0))))
    (if (i32.ne (local.get $entry) (global.get $d3dim_dbg_light_last)) (then
      (global.set $d3dim_dbg_light_last (local.get $entry))
      (call $host_dx_trace (i32.const 19) (local.get $n)
        (select (call $g2w (call $d3dim_light_slot (i32.const 0))) (i32.const 0)
                (i32.ne (local.get $n) (i32.const 0)))
        (select (call $g2w (local.get $mat)) (i32.const 0)
                (i32.ne (local.get $mat) (i32.const 0)))
        (select (call $gl32 (i32.add (local.get $state_guest) (i32.const 2312))) (i32.const 0)
                (i32.ne (local.get $state_guest) (i32.const 0)))))))

  (func $d3dim_light_slot (param $i i32) (result i32)
    (if (i32.eq (local.get $i) (i32.const 0)) (then (return (global.get $d3dim_light0))))
    (if (i32.eq (local.get $i) (i32.const 1)) (then (return (global.get $d3dim_light1))))
    (if (i32.eq (local.get $i) (i32.const 2)) (then (return (global.get $d3dim_light2))))
    (global.get $d3dim_light3))

  ;; Legacy shape-only shading, kept for meshes drawn with TRANSFORMLIGHT before
  ;; the app has configured a single light: real D3D would render those flat.
  (func $d3dim_vertex_shade_fallback (param $state_guest i32) (param $src_wa i32) (result i32)
    (call $d3dim_scale_color
      (call $d3dim_current_material_color (local.get $state_guest))
      (f32.add (f32.const 0.25)
        (f32.mul (f32.const 0.75)
          (f32.abs (f32.load (i32.add (local.get $src_wa) (i32.const 20))))))))

  ;; D3DVERTEX: position xyz @0, normal xyz @12, tu/tv @24.
  ;; colour = emissive + ambient_light*mat.ambient
  ;;        + Σ light.colour * mat.diffuse * max(0, N·L) * attenuation
  (func $d3dim_vertex_lit_color (param $state_guest i32) (param $src_wa i32) (result i32)
    (local $sw i32) (local $m i32) (local $mat i32) (local $mw i32) (local $msz i32)
    (local $amb i32) (local $i i32) (local $lp i32) (local $lw i32) (local $ltype i32)
    (local $nx f32) (local $ny f32) (local $nz f32) (local $len f32)
    (local $px f32) (local $py f32) (local $pz f32)
    (local $lx f32) (local $ly f32) (local $lz f32) (local $d f32)
    (local $ndl f32) (local $atten f32) (local $a0 f32) (local $a1 f32) (local $a2 f32)
    (local $range f32)
    (local $dr f32) (local $dg f32) (local $db f32)
    (local $ar f32) (local $ag f32) (local $ab f32)
    (local $r f32) (local $g f32) (local $b f32)
    (if (i32.eqz (local.get $state_guest))
      (then (return (call $d3dim_vertex_shade_fallback (local.get $state_guest) (local.get $src_wa)))))
    (if (i32.eqz (global.get $d3dim_light_n))
      (then (return (call $d3dim_vertex_shade_fallback (local.get $state_guest) (local.get $src_wa)))))
    (local.set $sw (call $g2w (local.get $state_guest)))
    (local.set $m (local.get $sw))   ;; world matrix @ state+0

    ;; Material reflectances. With no material bound, D3D's defaults are white
    ;; diffuse and black ambient; we keep white ambient so an ambient-only scene
    ;; is not pitch black.
    (local.set $dr (f32.const 1.0)) (local.set $dg (f32.const 1.0)) (local.set $db (f32.const 1.0))
    (local.set $ar (f32.const 1.0)) (local.set $ag (f32.const 1.0)) (local.set $ab (f32.const 1.0))
    (local.set $r (f32.const 0.0)) (local.set $g (f32.const 0.0)) (local.set $b (f32.const 0.0))
    (local.set $mat (call $d3dim_current_material_ptr (local.get $state_guest)))
    (if (local.get $mat) (then
      (local.set $mw (call $g2w (local.get $mat)))
      (local.set $msz (i32.load (local.get $mw)))
      (local.set $dr (f32.load (i32.add (local.get $mw) (i32.const 4))))
      (local.set $dg (f32.load (i32.add (local.get $mw) (i32.const 8))))
      (local.set $db (f32.load (i32.add (local.get $mw) (i32.const 12))))
      (if (i32.ge_u (local.get $msz) (i32.const 36)) (then
        (local.set $ar (f32.load (i32.add (local.get $mw) (i32.const 20))))
        (local.set $ag (f32.load (i32.add (local.get $mw) (i32.const 24))))
        (local.set $ab (f32.load (i32.add (local.get $mw) (i32.const 28))))))
      ;; dcvEmissive @52 (needs the full 80-byte D3DMATERIAL)
      (if (i32.ge_u (local.get $msz) (i32.const 68)) (then
        (local.set $r (f32.load (i32.add (local.get $mw) (i32.const 52))))
        (local.set $g (f32.load (i32.add (local.get $mw) (i32.const 56))))
        (local.set $b (f32.load (i32.add (local.get $mw) (i32.const 60))))))))

    ;; D3DLIGHTSTATE_AMBIENT = 2 ⇒ state+2304+2*4, a D3DCOLOR.
    (local.set $amb (call $gl32 (i32.add (local.get $state_guest) (i32.const 2312))))
    (local.set $r (f32.add (local.get $r) (f32.mul (local.get $ar)
      (f32.div (f32.convert_i32_u (i32.and (i32.shr_u (local.get $amb) (i32.const 16)) (i32.const 0xFF))) (f32.const 255.0)))))
    (local.set $g (f32.add (local.get $g) (f32.mul (local.get $ag)
      (f32.div (f32.convert_i32_u (i32.and (i32.shr_u (local.get $amb) (i32.const 8)) (i32.const 0xFF))) (f32.const 255.0)))))
    (local.set $b (f32.add (local.get $b) (f32.mul (local.get $ab)
      (f32.div (f32.convert_i32_u (i32.and (local.get $amb) (i32.const 0xFF))) (f32.const 255.0)))))

    ;; Lights live in world space, so take the vertex there too: row-vector
    ;; convention, m[i][j] at (i*4+j)*4.
    (local.set $nx (f32.load (i32.add (local.get $src_wa) (i32.const 12))))
    (local.set $ny (f32.load (i32.add (local.get $src_wa) (i32.const 16))))
    (local.set $nz (f32.load (i32.add (local.get $src_wa) (i32.const 20))))
    (local.set $px (f32.add (f32.add
      (f32.mul (local.get $nx) (f32.load (i32.add (local.get $m) (i32.const 0))))
      (f32.mul (local.get $ny) (f32.load (i32.add (local.get $m) (i32.const 16)))))
      (f32.mul (local.get $nz) (f32.load (i32.add (local.get $m) (i32.const 32))))))
    (local.set $py (f32.add (f32.add
      (f32.mul (local.get $nx) (f32.load (i32.add (local.get $m) (i32.const 4))))
      (f32.mul (local.get $ny) (f32.load (i32.add (local.get $m) (i32.const 20)))))
      (f32.mul (local.get $nz) (f32.load (i32.add (local.get $m) (i32.const 36))))))
    (local.set $pz (f32.add (f32.add
      (f32.mul (local.get $nx) (f32.load (i32.add (local.get $m) (i32.const 8))))
      (f32.mul (local.get $ny) (f32.load (i32.add (local.get $m) (i32.const 24)))))
      (f32.mul (local.get $nz) (f32.load (i32.add (local.get $m) (i32.const 40))))))
    (local.set $nx (local.get $px))
    (local.set $ny (local.get $py))
    (local.set $nz (local.get $pz))
    (local.set $len (f32.sqrt (f32.add (f32.add
      (f32.mul (local.get $nx) (local.get $nx))
      (f32.mul (local.get $ny) (local.get $ny)))
      (f32.mul (local.get $nz) (local.get $nz)))))
    (if (f32.lt (local.get $len) (f32.const 0.000001))
      (then (local.set $nz (f32.const 1.0)) (local.set $nx (f32.const 0.0)) (local.set $ny (f32.const 0.0)))
      (else
        (local.set $nx (f32.div (local.get $nx) (local.get $len)))
        (local.set $ny (f32.div (local.get $ny) (local.get $len)))
        (local.set $nz (f32.div (local.get $nz) (local.get $len)))))

    (local.set $px (f32.add (f32.add (f32.add
      (f32.mul (f32.load (local.get $src_wa)) (f32.load (i32.add (local.get $m) (i32.const 0))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 4))) (f32.load (i32.add (local.get $m) (i32.const 16)))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 8))) (f32.load (i32.add (local.get $m) (i32.const 32)))))
      (f32.load (i32.add (local.get $m) (i32.const 48)))))
    (local.set $py (f32.add (f32.add (f32.add
      (f32.mul (f32.load (local.get $src_wa)) (f32.load (i32.add (local.get $m) (i32.const 4))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 4))) (f32.load (i32.add (local.get $m) (i32.const 20)))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 8))) (f32.load (i32.add (local.get $m) (i32.const 36)))))
      (f32.load (i32.add (local.get $m) (i32.const 52)))))
    (local.set $pz (f32.add (f32.add (f32.add
      (f32.mul (f32.load (local.get $src_wa)) (f32.load (i32.add (local.get $m) (i32.const 8))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 4))) (f32.load (i32.add (local.get $m) (i32.const 24)))))
      (f32.mul (f32.load (i32.add (local.get $src_wa) (i32.const 8))) (f32.load (i32.add (local.get $m) (i32.const 40)))))
      (f32.load (i32.add (local.get $m) (i32.const 56)))))

    (local.set $i (i32.const 0))
    (block $ldone (loop $llp
      (br_if $ldone (i32.ge_u (local.get $i) (global.get $d3dim_light_n)))
      (local.set $lp (call $d3dim_light_slot (local.get $i)))
      (if (local.get $lp) (then
        (local.set $lw (call $g2w (local.get $lp)))
        (local.set $ltype (i32.load (i32.add (local.get $lw) (i32.const 4))))
        (local.set $atten (f32.const 1.0))
        (if (i32.eq (local.get $ltype) (i32.const 3))
          (then
            ;; Directional: dvDirection points the way the light travels, so L is
            ;; its negation.
            (local.set $lx (f32.neg (f32.load (i32.add (local.get $lw) (i32.const 36)))))
            (local.set $ly (f32.neg (f32.load (i32.add (local.get $lw) (i32.const 40)))))
            (local.set $lz (f32.neg (f32.load (i32.add (local.get $lw) (i32.const 44)))))
            (local.set $d (f32.const 0.0)))
          (else
            (local.set $lx (f32.sub (f32.load (i32.add (local.get $lw) (i32.const 24))) (local.get $px)))
            (local.set $ly (f32.sub (f32.load (i32.add (local.get $lw) (i32.const 28))) (local.get $py)))
            (local.set $lz (f32.sub (f32.load (i32.add (local.get $lw) (i32.const 32))) (local.get $pz)))
            (local.set $d (f32.sqrt (f32.add (f32.add
              (f32.mul (local.get $lx) (local.get $lx))
              (f32.mul (local.get $ly) (local.get $ly)))
              (f32.mul (local.get $lz) (local.get $lz)))))))
        (local.set $len (f32.sqrt (f32.add (f32.add
          (f32.mul (local.get $lx) (local.get $lx))
          (f32.mul (local.get $ly) (local.get $ly)))
          (f32.mul (local.get $lz) (local.get $lz)))))
        (if (f32.gt (local.get $len) (f32.const 0.000001)) (then
          (local.set $lx (f32.div (local.get $lx) (local.get $len)))
          (local.set $ly (f32.div (local.get $ly) (local.get $len)))
          (local.set $lz (f32.div (local.get $lz) (local.get $len)))
          (if (i32.ne (local.get $ltype) (i32.const 3)) (then
            (local.set $range (f32.load (i32.add (local.get $lw) (i32.const 48))))
            (if (f32.gt (local.get $range) (f32.const 0.0)) (then
              (if (f32.gt (local.get $d) (local.get $range))
                (then (local.set $atten (f32.const 0.0))))))
            (local.set $a0 (f32.load (i32.add (local.get $lw) (i32.const 56))))
            (local.set $a1 (f32.load (i32.add (local.get $lw) (i32.const 60))))
            (local.set $a2 (f32.load (i32.add (local.get $lw) (i32.const 64))))
            (local.set $len (f32.add (f32.add (local.get $a0)
              (f32.mul (local.get $a1) (local.get $d)))
              (f32.mul (f32.mul (local.get $a2) (local.get $d)) (local.get $d))))
            (if (f32.gt (local.get $len) (f32.const 0.000001)) (then
              (local.set $atten (f32.mul (local.get $atten)
                (f32.min (f32.const 1.0) (f32.div (f32.const 1.0) (local.get $len)))))))))
          (local.set $ndl (f32.add (f32.add
            (f32.mul (local.get $nx) (local.get $lx))
            (f32.mul (local.get $ny) (local.get $ly)))
            (f32.mul (local.get $nz) (local.get $lz))))
          (local.set $ndl (f32.max (local.get $ndl) (f32.const 0.0)))
          (local.set $ndl (f32.mul (local.get $ndl) (local.get $atten)))
          (if (f32.gt (local.get $ndl) (f32.const 0.0)) (then
            (local.set $r (f32.add (local.get $r) (f32.mul (f32.mul (local.get $dr) (local.get $ndl))
              (f32.load (i32.add (local.get $lw) (i32.const 8))))))
            (local.set $g (f32.add (local.get $g) (f32.mul (f32.mul (local.get $dg) (local.get $ndl))
              (f32.load (i32.add (local.get $lw) (i32.const 12))))))
            (local.set $b (f32.add (local.get $b) (f32.mul (f32.mul (local.get $db) (local.get $ndl))
              (f32.load (i32.add (local.get $lw) (i32.const 16))))))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $llp)))

    (i32.or (i32.const 0xFF000000)
      (i32.or
        (i32.shl (i32.trunc_sat_f32_u (f32.mul (f32.min (f32.max (local.get $r) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0))) (i32.const 16))
        (i32.or
          (i32.shl (i32.trunc_sat_f32_u (f32.mul (f32.min (f32.max (local.get $g) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0))) (i32.const 8))
          (i32.trunc_sat_f32_u (f32.mul (f32.min (f32.max (local.get $b) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)))))))

  ;; ── Texture binding ───────────────────────────────────────────
  ;; Expand a 5-bit channel to all eight bits rather than leaving its low bits
  ;; black; this matches fixed-function texture sampling more closely.
  (func $d3dim_expand5 (param $v i32) (result i32)
    (i32.or (i32.shl (local.get $v) (i32.const 3))
            (i32.shr_u (local.get $v) (i32.const 2))))

  (func $d3dim_expand6 (param $v i32) (result i32)
    (i32.or (i32.shl (local.get $v) (i32.const 2))
            (i32.shr_u (local.get $v) (i32.const 4))))

  ;; Decode a native surface pixel to 0xAARRGGBB according to the format that
  ;; CreateSurface retained from DDPIXELFORMAT.
  (func $d3dim_decode_surface_pixel_fmt
    (param $fmt i32) (param $px i32) (param $bpp i32) (result i32)
    (local $a i32) (local $r i32) (local $g i32) (local $b i32)
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (if (i32.eq (local.get $fmt) (i32.const 4)) (then
        (local.set $a (i32.mul (i32.and (i32.shr_u (local.get $px) (i32.const 12)) (i32.const 15)) (i32.const 17)))
        (local.set $r (i32.mul (i32.and (i32.shr_u (local.get $px) (i32.const 8)) (i32.const 15)) (i32.const 17)))
        (local.set $g (i32.mul (i32.and (i32.shr_u (local.get $px) (i32.const 4)) (i32.const 15)) (i32.const 17)))
        (local.set $b (i32.mul (i32.and (local.get $px) (i32.const 15)) (i32.const 17)))
        (return (i32.or (i32.shl (local.get $a) (i32.const 24))
          (i32.or (i32.shl (local.get $r) (i32.const 16))
            (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))))
      (if (i32.or (i32.eq (local.get $fmt) (i32.const 2))
                  (i32.eq (local.get $fmt) (i32.const 3))) (then
        (local.set $a (i32.const 255))
        (if (i32.eq (local.get $fmt) (i32.const 3))
          (then (local.set $a (select (i32.const 255) (i32.const 0)
            (i32.ne (i32.and (local.get $px) (i32.const 0x8000)) (i32.const 0))))))
        (local.set $r (call $d3dim_expand5 (i32.and (i32.shr_u (local.get $px) (i32.const 10)) (i32.const 31))))
        (local.set $g (call $d3dim_expand5 (i32.and (i32.shr_u (local.get $px) (i32.const 5)) (i32.const 31))))
        (local.set $b (call $d3dim_expand5 (i32.and (local.get $px) (i32.const 31))))
        (return (i32.or (i32.shl (local.get $a) (i32.const 24))
          (i32.or (i32.shl (local.get $r) (i32.const 16))
            (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))))
      (local.set $r (call $d3dim_expand5 (i32.and (i32.shr_u (local.get $px) (i32.const 11)) (i32.const 31))))
      (local.set $g (call $d3dim_expand6 (i32.and (i32.shr_u (local.get $px) (i32.const 5)) (i32.const 63))))
      (local.set $b (call $d3dim_expand5 (i32.and (local.get $px) (i32.const 31))))
      (return (i32.or (i32.const 0xFF000000)
        (i32.or (i32.shl (local.get $r) (i32.const 16))
          (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (if (i32.eq (local.get $fmt) (i32.const 5))
        (then (return (local.get $px))))
      (return (i32.or (local.get $px) (i32.const 0xFF000000)))))
    (i32.or (local.get $px) (i32.const 0xFF000000)))

  (func $d3dim_decode_surface_pixel
    (param $entry i32) (param $px i32) (param $bpp i32) (result i32)
    (call $d3dim_decode_surface_pixel_fmt
      (call $dx_surf_fmt_get (local.get $entry)) (local.get $px) (local.get $bpp)))

  ;; Encode 0xAARRGGBB into a native surface pixel.
  (func $d3dim_encode_surface_pixel
    (param $entry i32) (param $argb i32) (param $bpp i32) (result i32)
    (local $fmt i32)
    (local.set $fmt (call $dx_surf_fmt_get (local.get $entry)))
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (if (i32.eq (local.get $fmt) (i32.const 4)) (then
        (return (i32.or
          (i32.and (i32.shr_u (local.get $argb) (i32.const 16)) (i32.const 0xF000))
          (i32.or
            (i32.and (i32.shr_u (local.get $argb) (i32.const 12)) (i32.const 0x0F00))
            (i32.or
              (i32.and (i32.shr_u (local.get $argb) (i32.const 8)) (i32.const 0x00F0))
              (i32.and (i32.shr_u (local.get $argb) (i32.const 4)) (i32.const 0x000F))))))))
      (if (i32.or (i32.eq (local.get $fmt) (i32.const 2))
                  (i32.eq (local.get $fmt) (i32.const 3))) (then
        (return (i32.or
          (select (i32.const 0x8000) (i32.const 0)
            (i32.and (i32.eq (local.get $fmt) (i32.const 3))
                     (i32.ge_u (i32.shr_u (local.get $argb) (i32.const 24)) (i32.const 128))))
          (i32.or
            (i32.and (i32.shr_u (local.get $argb) (i32.const 9)) (i32.const 0x7C00))
            (i32.or
              (i32.and (i32.shr_u (local.get $argb) (i32.const 6)) (i32.const 0x03E0))
              (i32.and (i32.shr_u (local.get $argb) (i32.const 3)) (i32.const 0x001F))))))))
      (return (i32.or
        (i32.and (i32.shr_u (local.get $argb) (i32.const 8)) (i32.const 0xF800))
        (i32.or
          (i32.and (i32.shr_u (local.get $argb) (i32.const 5)) (i32.const 0x07E0))
          (i32.and (i32.shr_u (local.get $argb) (i32.const 3)) (i32.const 0x001F)))))))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (if (i32.eq (local.get $fmt) (i32.const 5))
        (then (return (local.get $argb))))
      (return (i32.or (local.get $argb) (i32.const 0xFF000000)))))
    (i32.and (local.get $argb) (i32.const 0x00FFFFFF)))

  ;; Decode one texel of any surface into 0xAARRGGBB. $entry is only needed for
  ;; the 8bpp case, where the byte is a palette index and the palette hangs off
  ;; the surface rather than the display.
  (func $d3dim_surf_texel_rgb
    (param $entry i32) (param $dib_wa i32) (param $bpp i32) (param $pitch i32)
    (param $x i32) (param $y i32) (result i32)
    (local $ptr i32) (local $px i32) (local $idx i32) (local $pal i32)
    (local.set $ptr (i32.add (local.get $dib_wa) (i32.mul (local.get $y) (local.get $pitch))))
    (if (i32.eq (local.get $bpp) (i32.const 8)) (then
      (local.set $idx (i32.load8_u (i32.add (local.get $ptr) (local.get $x))))
      (local.set $pal (call $dx_surf_pal_get (local.get $entry)))
      (if (local.get $pal) (then
        ;; PALETTEENTRY is (peRed, peGreen, peBlue, peFlags).
        (local.set $px (i32.load (i32.add (local.get $pal) (i32.shl (local.get $idx) (i32.const 2)))))
        (return (i32.or (i32.const 0xFF000000) (i32.or (i32.or
          (i32.shl (i32.and (local.get $px) (i32.const 0xFF)) (i32.const 16))
          (i32.and (local.get $px) (i32.const 0xFF00)))
          (i32.and (i32.shr_u (local.get $px) (i32.const 16)) (i32.const 0xFF)))))))
      (return (i32.or (i32.const 0xFF000000) (i32.or (i32.or
        (i32.shl (local.get $idx) (i32.const 16))
        (i32.shl (local.get $idx) (i32.const 8)))
        (local.get $idx))))))
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (local.set $px (i32.load16_u (i32.add (local.get $ptr) (i32.shl (local.get $x) (i32.const 1)))))
      (return (call $d3dim_decode_surface_pixel (local.get $entry) (local.get $px) (local.get $bpp)))))
    (if (i32.eq (local.get $bpp) (i32.const 24)) (then
      (local.set $ptr (i32.add (local.get $ptr) (i32.mul (local.get $x) (i32.const 3))))
      (return (i32.or (i32.const 0xFF000000) (i32.or (i32.or
        (i32.shl (i32.load8_u (i32.add (local.get $ptr) (i32.const 2))) (i32.const 16))
        (i32.shl (i32.load8_u (i32.add (local.get $ptr) (i32.const 1))) (i32.const 8)))
        (i32.load8_u (local.get $ptr)))))))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (return (call $d3dim_decode_surface_pixel (local.get $entry)
        (i32.load (i32.add (local.get $ptr) (i32.shl (local.get $x) (i32.const 2))))
        (local.get $bpp)))))
    (i32.const 0))

  ;; Store 0xAARRGGBB into a 16/24/32bpp surface. 8bpp destinations are not
  ;; handled here — writing one needs a nearest-entry search against that
  ;; surface's palette, and no caller has needed it yet.
  (func $d3dim_surf_put_texel
    (param $entry i32) (param $dib_wa i32) (param $bpp i32) (param $pitch i32)
    (param $x i32) (param $y i32) (param $rgb i32)
    (local $ptr i32)
    (local.set $ptr (i32.add (local.get $dib_wa) (i32.mul (local.get $y) (local.get $pitch))))
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (i32.store16 (i32.add (local.get $ptr) (i32.shl (local.get $x) (i32.const 1)))
        (call $d3dim_encode_surface_pixel (local.get $entry) (local.get $rgb) (local.get $bpp)))
      (return)))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (i32.store (i32.add (local.get $ptr) (i32.shl (local.get $x) (i32.const 2)))
        (call $d3dim_encode_surface_pixel (local.get $entry) (local.get $rgb) (local.get $bpp)))
      (return)))
    (if (i32.eq (local.get $bpp) (i32.const 24)) (then
      (local.set $ptr (i32.add (local.get $ptr) (i32.mul (local.get $x) (i32.const 3))))
      (i32.store8 (local.get $ptr) (i32.and (local.get $rgb) (i32.const 0xFF)))
      (i32.store8 (i32.add (local.get $ptr) (i32.const 1))
        (i32.and (i32.shr_u (local.get $rgb) (i32.const 8)) (i32.const 0xFF)))
      (i32.store8 (i32.add (local.get $ptr) (i32.const 2))
        (i32.and (i32.shr_u (local.get $rgb) (i32.const 16)) (i32.const 0xFF)))
      (return))))

  (func $d3dim_texture_load (param $dst_this i32) (param $src_this i32)
    (local $dst i32) (local $src i32)
    (local $dw i32) (local $dh i32) (local $dbpp i32) (local $dpitch i32) (local $ddib i32)
    (local $sw i32) (local $sh i32) (local $sbpp i32) (local $spitch i32) (local $sdib i32)
    (local $copy_w i32) (local $copy_h i32) (local $row_bytes i32) (local $row i32) (local $col i32) (local $bytespp i32)
    (local $dfmt i32) (local $sfmt i32) (local $key i32)
    (if (i32.or (i32.eqz (local.get $dst_this)) (i32.eqz (local.get $src_this))) (then (return)))
    (local.set $dst (call $dx_from_this (local.get $dst_this)))
    (local.set $src (call $dx_from_this (local.get $src_this)))
    (if (i32.or (i32.eqz (local.get $dst)) (i32.eqz (local.get $src))) (then (return)))
    (if (i32.or
          (i32.ne (i32.load (local.get $dst)) (i32.const 2))
          (i32.ne (i32.load (local.get $src)) (i32.const 2)))
      (then (return)))
    (call $d3dim_worker_fence)
    (local.set $dw (i32.and (i32.load (i32.add (local.get $dst) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $dh (i32.shr_u (i32.load (i32.add (local.get $dst) (i32.const 12))) (i32.const 16)))
    (local.set $dbpp (i32.and (i32.load (i32.add (local.get $dst) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $dpitch (i32.shr_u (i32.load (i32.add (local.get $dst) (i32.const 16))) (i32.const 16)))
    (local.set $ddib (i32.load (i32.add (local.get $dst) (i32.const 20))))
    (local.set $sw (i32.and (i32.load (i32.add (local.get $src) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $src) (i32.const 12))) (i32.const 16)))
    (local.set $sbpp (i32.and (i32.load (i32.add (local.get $src) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $spitch (i32.shr_u (i32.load (i32.add (local.get $src) (i32.const 16))) (i32.const 16)))
    (local.set $sdib (i32.load (i32.add (local.get $src) (i32.const 20))))
    (local.set $dfmt (call $dx_surf_fmt_get (local.get $dst)))
    (local.set $sfmt (call $dx_surf_fmt_get (local.get $src)))
    ;; Texture::Load copies the source surface's source-blit color key along
    ;; with its pixels. MCM loads a keyed system-memory HUD bitmap into a
    ;; separate video-memory texture and then binds only the destination; if
    ;; the metadata stays behind, the rasterizer paints its 0xf81f backdrop.
    ;; Convert the packed key when the two surface formats differ, just as the
    ;; pixel loop below converts the image itself.
    (if (i32.and (i32.load offset=28 (local.get $src)) (i32.const 0x100)) (then
      (local.set $key (i32.load offset=24 (local.get $src)))
      (if (i32.or (i32.ne (local.get $dbpp) (local.get $sbpp))
                  (i32.ne (local.get $dfmt) (local.get $sfmt))) (then
        (if (i32.or (i32.eq (local.get $dbpp) (i32.const 16))
                    (i32.eq (local.get $dbpp) (i32.const 32))) (then
          (local.set $key (call $d3dim_encode_surface_pixel
            (local.get $dst)
            (call $d3dim_decode_surface_pixel
              (local.get $src) (local.get $key) (local.get $sbpp))
            (local.get $dbpp)))))))
      (i32.store offset=24 (local.get $dst) (local.get $key))
      (i32.store offset=28 (local.get $dst)
        (i32.or (i32.load offset=28 (local.get $dst)) (i32.const 0x100)))))
    (if (i32.or (i32.eqz (local.get $ddib)) (i32.eqz (local.get $sdib))) (then (return)))
    (if (i32.lt_u (local.get $dbpp) (i32.const 8)) (then (return)))
    ;; Format conversion is the whole point of Texture::Load: D3DRM builds the
    ;; system-memory texture in the file's format (8bpp palettized for a GIF)
    ;; and the video-memory destination in the DEVICE's format (RGB565 here),
    ;; then Loads one into the other. Refusing the mismatch left every Organic
    ;; Art screensaver's destination texture uniform, so every textured triangle
    ;; sampled one constant texel and the leaves came out flat blue and black
    ;; with correct geometry. An 8bpp destination still declines — that needs a
    ;; nearest-entry search against the destination palette.
    (if (i32.or (i32.ne (local.get $dbpp) (local.get $sbpp))
                (i32.ne (local.get $dfmt) (local.get $sfmt))) (then
      (if (i32.eq (local.get $dbpp) (i32.const 8)) (then (return)))
      (local.set $copy_w (local.get $dw))
      (if (i32.lt_u (local.get $sw) (local.get $copy_w)) (then (local.set $copy_w (local.get $sw))))
      (local.set $copy_h (local.get $dh))
      (if (i32.lt_u (local.get $sh) (local.get $copy_h)) (then (local.set $copy_h (local.get $sh))))
      (local.set $row (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_u (local.get $row) (local.get $copy_h)))
        (local.set $col (i32.const 0))
        (block $rdone (loop $rlp
          (br_if $rdone (i32.ge_u (local.get $col) (local.get $copy_w)))
          (call $d3dim_surf_put_texel
            (local.get $dst) (local.get $ddib) (local.get $dbpp) (local.get $dpitch)
            (local.get $col) (local.get $row)
            (call $d3dim_surf_texel_rgb
              (local.get $src) (local.get $sdib) (local.get $sbpp) (local.get $spitch)
              (local.get $col) (local.get $row)))
          (local.set $col (i32.add (local.get $col) (i32.const 1)))
          (br $rlp)))
        (local.set $row (i32.add (local.get $row) (i32.const 1)))
        (br $clp)))
      (return)))
    (local.set $bytespp (i32.shr_u (local.get $dbpp) (i32.const 3)))
    (if (i32.eqz (local.get $bytespp)) (then (return)))
    (local.set $copy_w (local.get $dw))
    (if (i32.lt_u (local.get $sw) (local.get $copy_w)) (then (local.set $copy_w (local.get $sw))))
    (local.set $copy_h (local.get $dh))
    (if (i32.lt_u (local.get $sh) (local.get $copy_h)) (then (local.set $copy_h (local.get $sh))))
    (if (i32.or (i32.eqz (local.get $copy_w)) (i32.eqz (local.get $copy_h))) (then (return)))
    (local.set $row_bytes (i32.mul (local.get $copy_w) (local.get $bytespp)))
    (if (i32.gt_u (local.get $row_bytes) (local.get $dpitch)) (then (local.set $row_bytes (local.get $dpitch))))
    (if (i32.gt_u (local.get $row_bytes) (local.get $spitch)) (then (local.set $row_bytes (local.get $spitch))))
    (if (i32.eqz (local.get $row_bytes)) (then (return)))
    (local.set $row (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $row) (local.get $copy_h)))
      (call $memcpy
        (i32.add (local.get $ddib) (i32.mul (local.get $row) (local.get $dpitch)))
        (i32.add (local.get $sdib) (i32.mul (local.get $row) (local.get $spitch)))
        (local.get $row_bytes))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $lp))))

  (func $d3dim_texture_entry_from_slot (param $slot i32) (result i32)
    (local $entry i32) (local $redir i32) (local $src i32)
    (if (i32.or (i32.eqz (local.get $slot)) (i32.ge_u (local.get $slot) (global.get $DX_MAX)))
      (then (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS)
      (i32.mul (local.get $slot) (global.get $DX_ENTRY_SIZE))))
    (if (i32.eqz (i32.load (local.get $entry))) (then (return (i32.const 0))))
    ;; Older builds used DDSurface+12 as a source-surface slot for Texture::Load.
    ;; Accept that shape defensively, but prefer the destination surface when it
    ;; has a real DIB and dimensions.
    (local.set $redir (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (if (i32.and (i32.ne (local.get $redir) (local.get $slot))
                 (i32.lt_u (local.get $redir) (global.get $DX_MAX)))
      (then
        (local.set $src (i32.add (global.get $DX_OBJECTS)
          (i32.mul (local.get $redir) (global.get $DX_ENTRY_SIZE))))
        (if (i32.and
              (i32.eq (i32.load (local.get $src)) (i32.const 2))
              (i32.and
                (i32.ne (i32.load (i32.add (local.get $src) (i32.const 20))) (i32.const 0))
                (i32.ne (i32.load (i32.add (local.get $src) (i32.const 12))) (i32.const 0))))
          (then (return (local.get $src))))))
    (if (i32.and
          (i32.eq (i32.load (local.get $entry)) (i32.const 2))
          (i32.and
            (i32.ne (i32.load (i32.add (local.get $entry) (i32.const 20))) (i32.const 0))
            (i32.ne (i32.load (i32.add (local.get $entry) (i32.const 12))) (i32.const 0))))
      (then (return (local.get $entry))))
    (i32.const 0))

  (func $d3dim_bound_texture_entry (param $this i32) (result i32)
    (local $state i32) (local $slot i32) (local $entry i32) (local $key i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $slot (call $gl32 (i32.add (local.get $state) (global.get $D3DIM_OFF_TEX_STAGE))))
    (local.set $entry (call $d3dim_texture_entry_from_slot (local.get $slot)))
    ;; kind=16 TexBind: slot, resolved entry, packed w|h<<16, packed bpp|pitch<<16.
    ;; A slot that never resolves is the difference between "the app never bound
    ;; a texture" and "it did and we dropped it" -- the two look identical on
    ;; screen (flat vertex colour) and cannot be told apart from the API trace.
    (local.set $key (i32.or (i32.shl (local.get $slot) (i32.const 1))
                            (i32.ne (local.get $entry) (i32.const 0))))
    (if (i32.ne (local.get $key) (global.get $d3dim_dbg_tex_last))
      (then
        (global.set $d3dim_dbg_tex_last (local.get $key))
        (call $host_dx_trace (i32.const 16) (local.get $slot) (local.get $entry)
          (select (i32.load (i32.add (local.get $entry) (i32.const 12))) (i32.const 0)
                  (i32.ne (local.get $entry) (i32.const 0)))
          (select (i32.load (i32.add (local.get $entry) (i32.const 16))) (i32.const 0)
                  (i32.ne (local.get $entry) (i32.const 0))))))
    (local.get $entry))

  ;; SetTexture(stage, lpTex). Phase 0: store DX slot of lpTex on stage 0
  ;; only (multi-stage TSS stored separately by Phase 3).
  (func $d3dim_set_texture (param $this i32) (param $stage i32) (param $lpTex i32)
    (local $state i32) (local $slot i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.eqz (local.get $stage)) (then
      (if (local.get $lpTex)
        (then (local.set $slot (call $dx_slot_of (call $dx_from_this (local.get $lpTex)))))
        (else (local.set $slot (i32.const 0))))
      (call $gs32 (i32.add (local.get $state) (global.get $D3DIM_OFF_TEX_STAGE)) (local.get $slot))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_texture (param $this i32) (param $stage i32) (param $ppTex i32)
    (local $state i32) (local $slot i32) (local $tex_entry i32) (local $tex_guest i32)
    (if (i32.eqz (local.get $ppTex)) (then (global.set $eax (i32.const 0x80004003)) (return)))
    (if (i32.ne (local.get $stage) (i32.const 0)) (then
      (call $gs32 (local.get $ppTex) (i32.const 0))
      (global.set $eax (i32.const 0))
      (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then
      (call $gs32 (local.get $ppTex) (i32.const 0))
      (global.set $eax (i32.const 0))
      (return)))
    (local.set $slot (call $gl32 (i32.add (local.get $state) (global.get $D3DIM_OFF_TEX_STAGE))))
    (if (i32.eqz (local.get $slot)) (then
      (call $gs32 (local.get $ppTex) (i32.const 0))
      (global.set $eax (i32.const 0))
      (return)))
    (local.set $tex_entry (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 32))))
    (if (i32.eqz (i32.load (local.get $tex_entry))) (then
      (call $gs32 (local.get $ppTex) (i32.const 0))
      (global.set $eax (i32.const 0))
      (return)))
    (i32.store (i32.add (local.get $tex_entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $tex_entry) (i32.const 4))) (i32.const 1)))
    (local.set $tex_guest (i32.add
      (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (call $gs32 (local.get $ppTex) (local.get $tex_guest))
    (global.set $eax (i32.const 0)))

  ;; Return the guest address of a texture-stage state slot. The original
  ;; eight states retain their compact per-stage layout. Fixed-function D3D3
  ;; games also depend on coordinate selection, addressing, and filtering;
  ;; those six extended states live in otherwise-unused device-state space.
  (func $d3dim_tss_addr (param $state i32) (param $stage i32) (param $type i32) (result i32)
    (local $ext i32)
    (if (i32.or (i32.eqz (local.get $state)) (i32.ge_u (local.get $stage) (i32.const 8)))
      (then (return (i32.const 0))))
    (if (i32.lt_u (local.get $type) (i32.const 8)) (then
      (return (i32.add (local.get $state)
        (i32.add (global.get $D3DIM_OFF_TSS_STATE)
          (i32.add (i32.mul (local.get $stage) (i32.const 32))
                   (i32.shl (local.get $type) (i32.const 2))))))))
    (if (i32.eq (local.get $type) (i32.const 11)) (then (local.set $ext (i32.const 0)))
      (else (if (i32.eq (local.get $type) (i32.const 13)) (then (local.set $ext (i32.const 1)))
      (else (if (i32.eq (local.get $type) (i32.const 14)) (then (local.set $ext (i32.const 2)))
      (else (if (i32.eq (local.get $type) (i32.const 16)) (then (local.set $ext (i32.const 3)))
      (else (if (i32.eq (local.get $type) (i32.const 17)) (then (local.set $ext (i32.const 4)))
      (else (if (i32.eq (local.get $type) (i32.const 18)) (then (local.set $ext (i32.const 5)))
      (else (return (i32.const 0))))))))))))))
    (i32.add (local.get $state)
      (i32.add (global.get $D3DIM_OFF_TSS_EXT)
        (i32.shl (i32.add (i32.mul (local.get $stage) (i32.const 6)) (local.get $ext)) (i32.const 2)))))

  (func $d3dim_tss_load (param $state i32) (param $stage i32) (param $type i32) (result i32)
    (local $addr i32)
    (local.set $addr (call $d3dim_tss_addr (local.get $state) (local.get $stage) (local.get $type)))
    (if (local.get $addr) (then (return (call $gl32 (local.get $addr)))))
    (i32.const 0))

  ;; A legacy viewport object owns its rectangle.  The device keeps a cached
  ;; copy only for the viewport currently selected for transformation.
  (func $d3dim_viewport_apply_entry (param $state i32) (param $entry i32)
    (local $sw i32) (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (if (i32.or (i32.eqz (local.get $state)) (i32.eqz (local.get $entry)))
      (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $x (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (local.set $y (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (local.set $w (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (local.set $h (i32.load (i32.add (local.get $entry) (i32.const 24))))
    (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT)) (local.get $x))
    (i32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4))) (local.get $y))
    (i32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8))) (local.get $w))
    (i32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12))) (local.get $h))
    (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))
      (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0)))
    (f32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))
      (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0)))
    (f32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 8))) (f32.const 0.0))
    (f32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 12))) (f32.const 1.0))
    (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN))
      (f32.add (f32.convert_i32_s (local.get $x))
               (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0))))
    (f32.store (i32.add (local.get $sw)
      (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4)))
      (f32.add (f32.convert_i32_s (local.get $y))
               (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0)))))

  (func $d3dim_texcoord_index (param $this i32) (result i32)
    (i32.and
      (call $d3dim_tss_load (call $d3ddev_state (local.get $this)) (i32.const 0) (i32.const 11))
      (i32.const 0xffff)))

  ;; SetTextureStageState(stage, type, value).
  (func $d3dim_set_tss (param $this i32) (param $stage i32) (param $type i32) (param $val i32)
    (local $state i32) (local $addr i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $addr (call $d3dim_tss_addr (local.get $state) (local.get $stage) (local.get $type)))
    (if (local.get $addr) (then (call $gs32 (local.get $addr) (local.get $val))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_tss (param $this i32) (param $stage i32) (param $type i32) (param $out i32)
    (local $state i32) (local $val i32)
    (if (i32.eqz (local.get $out)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (local.set $val (call $d3dim_tss_load (local.get $state) (local.get $stage) (local.get $type)))
    (call $gs32 (local.get $out) (local.get $val))
    (global.set $eax (i32.const 0)))

  ;; ── Current viewport binding ──────────────────────────────────
  (func $d3dim_set_current_viewport (param $this i32) (param $lpVp i32)
    (local $state i32) (local $slot i32) (local $vp_entry i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (if (local.get $lpVp)
      (then
        (local.set $vp_entry (call $dx_from_this (local.get $lpVp)))
        (local.set $slot (call $dx_slot_of (local.get $vp_entry)))
        (if (local.get $vp_entry)
          (then (i32.store (i32.add (local.get $vp_entry) (i32.const 8)) (local.get $this)))))
      (else (local.set $slot (i32.const 0))))
    (call $gs32 (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP)) (local.get $slot))
    (if (local.get $vp_entry)
      (then (call $d3dim_viewport_apply_entry (local.get $state) (local.get $vp_entry))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_current_viewport (param $this i32) (param $ppVp i32)
    (local $state i32) (local $slot i32) (local $vp_entry i32) (local $obj_guest i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $ppVp))
      (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.eqz (local.get $state))
      (then
        (call $gs32 (local.get $ppVp) (i32.const 0))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $slot (call $gl32 (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP))))
    (if (i32.eqz (local.get $slot))
      (then
        (call $gs32 (local.get $ppVp) (i32.const 0))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $vp_entry (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 32))))
    (if (i32.eqz (i32.load (local.get $vp_entry)))
      (then
        (call $gs32 (local.get $ppVp) (i32.const 0))
        (global.set $eax (i32.const 0))
        (return)))
    (i32.store (i32.add (local.get $vp_entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $vp_entry) (i32.const 4))) (i32.const 1)))
    ;; reconstruct guest ptr from slot: COM_WRAPPERS + slot*8 → guest addr
    (local.set $obj_guest (i32.add
      (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (call $gs32 (local.get $ppVp) (local.get $obj_guest))
    (global.set $eax (i32.const 0)))

  ;; ── Render-target binding ────────────────────────────────────
  ;; The device entry stores its current DDSurface slot at +8. CreateDevice
  ;; seeds it; SetRenderTarget updates it for apps that switch back buffers.
  (func $d3dim_set_render_target (param $this i32) (param $rt_surf i32)
    (local $entry i32) (local $rt_entry i32) (local $rt_slot i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $rt_surf)) (then
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (i32.const 0))
      (global.set $eax (i32.const 0))
      (return)))
    (local.set $rt_entry (call $dx_from_this (local.get $rt_surf)))
    (if (i32.eqz (i32.load (local.get $rt_entry))) (then
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $rt_slot (call $dx_slot_of (local.get $rt_entry)))
    (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $rt_slot))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_render_target (param $this i32) (param $ppRt i32)
    (local $entry i32) (local $slot i32) (local $rt_entry i32) (local $rt_guest i32)
    (if (i32.eqz (local.get $ppRt))
      (then (global.set $eax (i32.const 0x80004003)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $slot (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (i32.eqz (local.get $slot)) (then
      (call $gs32 (local.get $ppRt) (i32.const 0))
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $rt_entry (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 32))))
    (if (i32.eqz (i32.load (local.get $rt_entry))) (then
      (call $gs32 (local.get $ppRt) (i32.const 0))
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (i32.store (i32.add (local.get $rt_entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $rt_entry) (i32.const 4))) (i32.const 1)))
    (local.set $rt_guest (i32.add
      (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (call $gs32 (local.get $ppRt) (local.get $rt_guest))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_set_background (param $this i32) (param $handle i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (local.get $entry)
      (then (i32.store (i32.add (local.get $entry) (i32.const 28)) (local.get $handle))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_get_background (param $this i32) (param $lpHandle i32) (param $lpValid i32)
    (local $entry i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (local.get $entry)
      (then (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 28))))))
    (if (local.get $lpHandle) (then (call $gs32 (local.get $lpHandle) (local.get $handle))))
    (if (local.get $lpValid) (then (call $gs32 (local.get $lpValid) (i32.ne (local.get $handle) (i32.const 0)))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_background_color (param $this i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (call $d3dim_material_color_from_handle
      (i32.load (i32.add (local.get $entry) (i32.const 28)))))

  ;; The background material's texture, or 0 when the background is flat colour.
  (func $d3dim_viewport_background_texture (param $this i32) (result i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $this)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (call $d3dim_material_texture_entry
      (i32.load (i32.add (local.get $entry) (i32.const 28)))))

  ;; ── Viewport rect get/set ─────────────────────────────────────
  ;; SetViewport(lpD3DVIEWPORT) / SetViewport2(lpD3DVIEWPORT2). Persist the
  ;; rectangle and derive the transform viewport used by vertex_project.
  (func $d3dim_viewport_set (param $this i32) (param $lpVp i32)
    (local $entry i32) (local $dev_this i32) (local $state i32)
    (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $x (call $gl32 (i32.add (local.get $lpVp) (i32.const 4))))
    (local.set $y (call $gl32 (i32.add (local.get $lpVp) (i32.const 8))))
    (local.set $w (call $gl32 (i32.add (local.get $lpVp) (i32.const 12))))
    (local.set $h (call $gl32 (i32.add (local.get $lpVp) (i32.const 16))))
    (i32.store (i32.add (local.get $entry) (i32.const 12)) (local.get $x))
    (i32.store (i32.add (local.get $entry) (i32.const 16)) (local.get $y))
    (i32.store (i32.add (local.get $entry) (i32.const 20)) (local.get $w))
    (i32.store (i32.add (local.get $entry) (i32.const 24)) (local.get $h))
    (local.set $dev_this (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $dev_this) (then
      (local.set $state (call $d3ddev_state (local.get $dev_this)))
      (if (i32.and (i32.ne (local.get $state) (i32.const 0))
            (i32.eq (call $gl32
              (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP)))
              (call $dx_slot_of (local.get $entry))))
        (then (call $d3dim_viewport_apply_entry
          (local.get $state) (local.get $entry))))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_get (param $this i32) (param $lpVp i32)
    (local $entry i32) (local $size i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (local.set $size (call $gl32 (local.get $lpVp)))
    (if (i32.eqz (local.get $size)) (then (local.set $size (i32.const 80))))
    (call $gs32 (local.get $lpVp)                                      (local.get $size))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 4))              (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 8))              (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 12))             (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 16))             (i32.load (i32.add (local.get $entry) (i32.const 24))))
    (global.set $eax (i32.const 0)))

  ;; DX7 stores viewport directly on the device instead of through an
  ;; IDirect3DViewport COM object. D3DVIEWPORT7 is {x,y,w,h,minZ,maxZ}.
  (func $d3dim_device7_set_viewport (param $this i32) (param $lpVp i32)
    (local $state i32) (local $sw i32) (local $vp_wa i32)
    (local $x i32) (local $y i32) (local $w i32) (local $h i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $vp_wa (call $g2w (local.get $lpVp)))
    (local.set $x (i32.load (local.get $vp_wa)))
    (local.set $y (i32.load (i32.add (local.get $vp_wa) (i32.const 4))))
    (local.set $w (i32.load (i32.add (local.get $vp_wa) (i32.const 8))))
    (local.set $h (i32.load (i32.add (local.get $vp_wa) (i32.const 12))))
    (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT)) (local.get $x))
    (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4))) (local.get $y))
    (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8))) (local.get $w))
    (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12))) (local.get $h))
    (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))
      (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0)))
    (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))
      (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0)))
    (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 8)))
      (f32.load (i32.add (local.get $vp_wa) (i32.const 16))))
    (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 12)))
      (f32.load (i32.add (local.get $vp_wa) (i32.const 20))))
    (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN))
      (f32.add (f32.convert_i32_s (local.get $x))
               (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0))))
    (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4)))
      (f32.add (f32.convert_i32_s (local.get $y))
               (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_device7_get_viewport (param $this i32) (param $lpVp i32)
    (local $state i32) (local $sw i32) (local $vp_wa i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $vp_wa (call $g2w (local.get $lpVp)))
    (i32.store (local.get $vp_wa)
      (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT))))
    (i32.store (i32.add (local.get $vp_wa) (i32.const 4))
      (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4)))))
    (i32.store (i32.add (local.get $vp_wa) (i32.const 8))
      (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8)))))
    (i32.store (i32.add (local.get $vp_wa) (i32.const 12))
      (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12)))))
    (f32.store (i32.add (local.get $vp_wa) (i32.const 16))
      (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 8)))))
    (f32.store (i32.add (local.get $vp_wa) (i32.const 20))
      (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 12)))))
    (global.set $eax (i32.const 0)))

  ;; ============================================================
  ;; STEP 2 — Matrix core (4×4 row-major f32)
  ;; ============================================================
  ;; Convention: matrices are 16 f32 in row-major order. For row-vectors
  ;; (D3D-style), the chain is screen = vertex * world * view * proj, so
  ;; mat4_mul computes  out[i][j] = sum_k a[i][k] * b[k][j].

  (func $mat4_mul (param $out_wa i32) (param $a_wa i32) (param $b_wa i32)
    (local $r i32) (local $c i32)
    ;; Fully unrolled 4×4 multiply (16 dots × 4 mads).
    (local.set $r (i32.const 0))
    (block $rdone (loop $rlp
      (br_if $rdone (i32.ge_u (local.get $r) (i32.const 4)))
      (local.set $c (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_u (local.get $c) (i32.const 4)))
        (f32.store
          (i32.add (local.get $out_wa)
            (i32.mul (i32.add (i32.mul (local.get $r) (i32.const 4)) (local.get $c)) (i32.const 4)))
          (f32.add (f32.add (f32.add
            (f32.mul
              (f32.load (i32.add (local.get $a_wa)
                (i32.mul (i32.add (i32.mul (local.get $r) (i32.const 4)) (i32.const 0)) (i32.const 4))))
              (f32.load (i32.add (local.get $b_wa)
                (i32.mul (i32.add (i32.const 0) (local.get $c)) (i32.const 4)))))
            (f32.mul
              (f32.load (i32.add (local.get $a_wa)
                (i32.mul (i32.add (i32.mul (local.get $r) (i32.const 4)) (i32.const 1)) (i32.const 4))))
              (f32.load (i32.add (local.get $b_wa)
                (i32.mul (i32.add (i32.const 4) (local.get $c)) (i32.const 4))))))
            (f32.mul
              (f32.load (i32.add (local.get $a_wa)
                (i32.mul (i32.add (i32.mul (local.get $r) (i32.const 4)) (i32.const 2)) (i32.const 4))))
              (f32.load (i32.add (local.get $b_wa)
                (i32.mul (i32.add (i32.const 8) (local.get $c)) (i32.const 4))))))
            (f32.mul
              (f32.load (i32.add (local.get $a_wa)
                (i32.mul (i32.add (i32.mul (local.get $r) (i32.const 4)) (i32.const 3)) (i32.const 4))))
              (f32.load (i32.add (local.get $b_wa)
                (i32.mul (i32.add (i32.const 12) (local.get $c)) (i32.const 4)))))))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br $clp)))
      (local.set $r (i32.add (local.get $r) (i32.const 1)))
      (br $rlp))))

  ;; out[j] = sum_k v[k] * M[k][j]   (row-vector × matrix)
  (func $mat4_transform_vec4 (param $out_wa i32) (param $mat_wa i32) (param $vec_wa i32)
    (local $j i32)
    (local.set $j (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $j) (i32.const 4)))
      (f32.store
        (i32.add (local.get $out_wa) (i32.mul (local.get $j) (i32.const 4)))
        (f32.add (f32.add (f32.add
          (f32.mul (f32.load (local.get $vec_wa))
                   (f32.load (i32.add (local.get $mat_wa)
                     (i32.mul (i32.add (i32.const 0) (local.get $j)) (i32.const 4)))))
          (f32.mul (f32.load (i32.add (local.get $vec_wa) (i32.const 4)))
                   (f32.load (i32.add (local.get $mat_wa)
                     (i32.mul (i32.add (i32.const 4) (local.get $j)) (i32.const 4))))))
          (f32.mul (f32.load (i32.add (local.get $vec_wa) (i32.const 8)))
                   (f32.load (i32.add (local.get $mat_wa)
                     (i32.mul (i32.add (i32.const 8) (local.get $j)) (i32.const 4))))))
          (f32.mul (f32.load (i32.add (local.get $vec_wa) (i32.const 12)))
                   (f32.load (i32.add (local.get $mat_wa)
                     (i32.mul (i32.add (i32.const 12) (local.get $j)) (i32.const 4)))))))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br $lp))))

  ;; Build composite world*view*proj into the device's scratch matrix slot 3
  ;; ($state +192).  state_guest is the result of $d3ddev_state(this).
  (func $d3ddev_composite_wvp (param $state_guest i32)
    (local $sw i32) (local $tmp i32) (local $mid i32)
    (if (i32.eqz (local.get $state_guest)) (then (return)))
    (local.set $sw (call $g2w (local.get $state_guest)))
    ;; mat4_mul is not alias-safe, so keep world*view in a separate scratch area
    ;; before writing the final world*view*proj matrix into slot 3.
    (local.set $tmp (i32.add (local.get $sw) (i32.const 192)))
    (local.set $mid (i32.add (local.get $sw) (i32.const 3136)))
    (call $mat4_mul (local.get $mid)
      (local.get $sw)                                  ;; world @ +0
      (i32.add (local.get $sw) (i32.const 64)))        ;; view  @ +64
    (call $mat4_mul (local.get $tmp)
      (local.get $mid)
      (i32.add (local.get $sw) (i32.const 128))))      ;; proj  @ +128

  ;; vin_wa: position xyz (12 bytes) at offset 0; FVF tail ignored for now.
  ;; vout_wa: 16-byte (sx, sy, z_ndc, inv_w) f32.
  (func $vertex_project (param $state_guest i32) (param $vin_wa i32) (param $vout_wa i32)
    (local $sw i32) (local $vec_wa i32) (local $clip_wa i32) (local $w f32) (local $inv_w f32)
    (if (i32.eqz (local.get $state_guest)) (then (return)))
    (local.set $sw (call $g2w (local.get $state_guest)))
    ;; Pack input into a 16-byte (x,y,z,1) vec on the call stack region we own.
    ;; We borrow the trailing 32 bytes of scratch slot 3 (only first 64 used by mat).
    ;; Instead use D3DIM_OFF_VP_RECT-32..-16 area which is unused while clearing.
    ;; Simpler: write into vout_wa first (it's caller-owned 16 bytes), then overwrite.
    ;; Use two separate temp buffers within the device state block reserved tail
    ;; (offsets 4032 and 4064 — both within the 4096 alloc, free per layout note).
    (local.set $vec_wa  (i32.add (local.get $sw) (i32.const 4032)))
    (local.set $clip_wa (i32.add (local.get $sw) (i32.const 4064)))
    (f32.store (local.get $vec_wa)                       (f32.load (local.get $vin_wa)))
    (f32.store (i32.add (local.get $vec_wa) (i32.const 4))  (f32.load (i32.add (local.get $vin_wa) (i32.const 4))))
    (f32.store (i32.add (local.get $vec_wa) (i32.const 8))  (f32.load (i32.add (local.get $vin_wa) (i32.const 8))))
    (f32.store (i32.add (local.get $vec_wa) (i32.const 12)) (f32.const 1.0))
    ;; clip = vec * composite (slot 3 @ +192)
    (call $mat4_transform_vec4 (local.get $clip_wa)
      (i32.add (local.get $sw) (i32.const 192))
      (local.get $vec_wa))
    ;; inv_w = 1 / w. Clamp a near-zero divisor while preserving its sign;
    ;; otherwise a vertex on the eye plane produces +/-inf screen coordinates
    ;; and traps the integer scanline rasterizer before clipping can reject it.
    (local.set $w (f32.load (i32.add (local.get $clip_wa) (i32.const 12))))
    (if (f32.lt (f32.abs (local.get $w)) (f32.const 0.001)) (then
      (if (f32.lt (local.get $w) (f32.const 0.0))
        (then (local.set $w (f32.const -0.001)))
        (else (local.set $w (f32.const 0.001))))))
    (local.set $inv_w (f32.div (f32.const 1.0) (local.get $w)))
    ;; NDC: x/w, y/w, z/w
    ;; Screen: sx = origin.x + (x_ndc) * scale.x ; sy = origin.y - (y_ndc) * scale.y
    (f32.store (local.get $vout_wa)
      (f32.add
        (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 0))))
        (f32.mul
          (f32.mul (f32.load (local.get $clip_wa)) (local.get $inv_w))
          (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 0)))))))
    (f32.store (i32.add (local.get $vout_wa) (i32.const 4))
      (f32.sub
        (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4))))
        (f32.mul
          (f32.mul (f32.load (i32.add (local.get $clip_wa) (i32.const 4))) (local.get $inv_w))
          (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))))))
    (f32.store (i32.add (local.get $vout_wa) (i32.const 8))
      (f32.mul (f32.load (i32.add (local.get $clip_wa) (i32.const 8))) (local.get $inv_w)))
    (f32.store (i32.add (local.get $vout_wa) (i32.const 12)) (local.get $inv_w))
    (if (i32.lt_u (global.get $d3dim_dbg_vproj_count) (i32.const 12)) (then
      (call $host_log_i32 (i32.const 0xD3D17000))
      (call $host_log_i32 (global.get $d3dim_dbg_vproj_count))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (local.get $vin_wa))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $vin_wa) (i32.const 4)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $vin_wa) (i32.const 8)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (local.get $clip_wa))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $clip_wa) (i32.const 4)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $clip_wa) (i32.const 8)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $clip_wa) (i32.const 12)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (local.get $vout_wa))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $vout_wa) (i32.const 4)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $vout_wa) (i32.const 8)))))
      (call $host_log_i32 (i32.reinterpret_f32 (f32.load (i32.add (local.get $vout_wa) (i32.const 12)))))
      (global.set $d3dim_dbg_vproj_count (i32.add (global.get $d3dim_dbg_vproj_count) (i32.const 1))))))

  ;; ── Test export: known-answer check helpers ──────────────────
  ;; mat_set_identity(out_wa) and mat_set_translate(out_wa, tx, ty, tz)
  ;; Returns the dest WASM addr to caller.
  (func $test_mat4_identity (export "test_mat4_identity") (param $out_wa i32)
    (local $i i32)
    (call $zero_memory (local.get $out_wa) (i32.const 64))
    (f32.store (i32.add (local.get $out_wa) (i32.const 0))  (f32.const 1.0))
    (f32.store (i32.add (local.get $out_wa) (i32.const 20)) (f32.const 1.0))
    (f32.store (i32.add (local.get $out_wa) (i32.const 40)) (f32.const 1.0))
    (f32.store (i32.add (local.get $out_wa) (i32.const 60)) (f32.const 1.0)))

  (func $test_mat4_mul (export "test_mat4_mul") (param $o i32) (param $a i32) (param $b i32)
    (call $mat4_mul (local.get $o) (local.get $a) (local.get $b)))

  (func $test_mat4_xform (export "test_mat4_xform") (param $o i32) (param $m i32) (param $v i32)
    (call $mat4_transform_vec4 (local.get $o) (local.get $m) (local.get $v)))

  ;; ============================================================
  ;; STEP 3 — Viewport Clear + z-buffer
  ;; ============================================================
  ;; Helper: from a device "this", look up the render-target DDSurface entry.
  (func $d3ddev_rt_entry (param $this_guest i32) (result i32)
    (local $entry i32) (local $rt_slot i32)
    (local.set $entry (call $dx_from_this (local.get $this_guest)))
    (if (i32.eqz (local.get $entry)) (then (return (i32.const 0))))
    (local.set $rt_slot (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $rt_slot) (i32.const 32))))

  ;; Find the DirectDraw Z surface attached to the render target, or allocate a
  ;; private guest-heap f32 plane as a fallback.  The depth handle stored at
  ;; state +D3DIM_OFF_ZBUF_SLOT is therefore either a DX_OBJECTS entry address
  ;; or a guest pointer.  Prefer a newly attached real surface even if an early
  ;; draw caused the fallback plane to be allocated first: DirectDraw clears
  ;; and locks the attached surface, so a private plane would immediately
  ;; diverge from application-visible depth state.
  (func $d3dim_ensure_zbuffer (param $this_guest i32) (result i32)
    (local $state i32) (local $rt i32) (local $w i32) (local $h i32)
    (local $bytes i32) (local $zbuf i32) (local $sw i32)
    (local $rt_slot i32) (local $i i32) (local $candidate i32)
    (local.set $state (call $d3ddev_state (local.get $this_guest)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $zbuf (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_ZBUF_SLOT))))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this_guest)))
    (if (i32.eqz (local.get $rt)) (then (return (i32.const 0))))
    (local.set $w (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then (return (i32.const 0))))
    (local.set $rt_slot (call $dx_slot_of (local.get $rt)))
    (local.set $i (i32.const 1))
    (block $attached_done (loop $attached_scan
      (br_if $attached_done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (local.set $candidate
        (i32.add (global.get $DX_OBJECTS)
          (i32.mul (local.get $i) (global.get $DX_ENTRY_SIZE))))
      (if (i32.and
            (i32.eq (i32.load (local.get $candidate)) (i32.const 2))
            (i32.and
              (i32.eq (i32.load offset=4 (call $dx_surf_meta_ptr (local.get $candidate)))
                (i32.add (local.get $rt_slot) (i32.const 1)))
              (i32.and
                (i32.and
                  (i32.ne
                    (i32.and (i32.load (call $dx_surf_meta_ptr (local.get $candidate)))
                      (i32.const 0x00020000))
                    (i32.const 0))
                  (i32.eq (i32.load offset=12 (local.get $candidate))
                    (i32.load offset=12 (local.get $rt))))
                (i32.and
                  (i32.or
                    (i32.eq (i32.load16_u offset=16 (local.get $candidate)) (i32.const 16))
                    (i32.eq (i32.load16_u offset=16 (local.get $candidate)) (i32.const 32)))
                  (i32.ne (i32.load offset=20 (local.get $candidate)) (i32.const 0))))))
        (then
          (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_ZBUF_SLOT))
            (local.get $candidate))
          (return (local.get $candidate))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $attached_scan)))
    (if (local.get $zbuf) (then (return (local.get $zbuf))))
    (local.set $bytes (i32.mul (i32.mul (local.get $w) (local.get $h)) (i32.const 4)))
    (local.set $zbuf (call $heap_alloc (local.get $bytes)))
    (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_ZBUF_SLOT)) (local.get $zbuf))
    (local.get $zbuf))

  ;; Fill an RT DIB rect with a 32-bit color, dispatching by bpp.
  ;; rt_entry is WASM addr of the DDSurface entry; (x,y,w,h) are the viewport
  ;; rect (caller already clipped to surface bounds — we re-clip defensively).
  (func $viewport_fill_rect (param $rt_entry i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32) (param $color i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $row i32) (local $col i32) (local $row_wa i32) (local $px16 i32)
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 16)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $rt_entry) (i32.const 20))))
    (if (i32.eqz (local.get $dib_wa)) (then (return)))
    ;; Clip
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then
      (local.set $w (i32.add (local.get $w) (local.get $x)))
      (local.set $x (i32.const 0))))
    (if (i32.lt_s (local.get $y) (i32.const 0)) (then
      (local.set $h (i32.add (local.get $h) (local.get $y)))
      (local.set $y (i32.const 0))))
    (if (i32.gt_s (i32.add (local.get $x) (local.get $w)) (local.get $sw))
      (then (local.set $w (i32.sub (local.get $sw) (local.get $x)))))
    (if (i32.gt_s (i32.add (local.get $y) (local.get $h)) (local.get $sh))
      (then (local.set $h (i32.sub (local.get $sh) (local.get $y)))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0)) (i32.le_s (local.get $h) (i32.const 0)))
      (then (return)))
    ;; Convert color to 16-bit 5-6-5 if needed (assumes input is 0x00RRGGBB).
    (local.set $px16 (i32.or (i32.or
      (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 19)) (i32.const 0x1F)) (i32.const 11))
      (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 10)) (i32.const 0x3F)) (i32.const  5)))
      (i32.and (i32.shr_u (local.get $color) (i32.const 3)) (i32.const 0x1F))))
    (local.set $row (i32.const 0))
    (block $rdone (loop $rlp
      (br_if $rdone (i32.ge_s (local.get $row) (local.get $h)))
      (local.set $row_wa (i32.add (local.get $dib_wa)
        (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $pitch))))
      (local.set $col (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_s (local.get $col) (local.get $w)))
        (if (i32.eq (local.get $bpp) (i32.const 32)) (then
          (i32.store
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 4)))
            (local.get $color))))
        (if (i32.eq (local.get $bpp) (i32.const 16)) (then
          (i32.store16
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 2)))
            (local.get $px16))))
        (if (i32.eq (local.get $bpp) (i32.const 8)) (then
          (i32.store8
            (i32.add (local.get $row_wa) (i32.add (local.get $x) (local.get $col)))
            (local.get $color))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $clp)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rlp))))

  ;; Stretch a texture over a rect of an RT DIB (nearest neighbour). Used for a
  ;; viewport background material that carries an image rather than a colour.
  (func $viewport_fill_rect_texture
    (param $rt_entry i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (param $tex_entry i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $row i32) (local $col i32) (local $row_wa i32) (local $color i32) (local $px16 i32)
    (local $fw f32) (local $fh f32)
    (if (i32.or (i32.eqz (local.get $tex_entry))
                (i32.or (i32.le_s (local.get $w) (i32.const 0))
                        (i32.le_s (local.get $h) (i32.const 0))))
      (then (return)))
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 16)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $rt_entry) (i32.const 20))))
    (if (i32.eqz (local.get $dib_wa)) (then (return)))
    (local.set $fw (f32.convert_i32_s (local.get $w)))
    (local.set $fh (f32.convert_i32_s (local.get $h)))
    ;; Clip against the surface; the u/v mapping stays tied to the unclipped
    ;; rect so a partially offscreen viewport still shows the right part.
    (local.set $row (i32.const 0))
    (block $rdone (loop $rlp
      (br_if $rdone (i32.ge_s (local.get $row) (local.get $h)))
      (if (i32.or (i32.lt_s (i32.add (local.get $y) (local.get $row)) (i32.const 0))
                  (i32.ge_s (i32.add (local.get $y) (local.get $row)) (local.get $sh)))
        (then (local.set $row (i32.add (local.get $row) (i32.const 1))) (br $rlp)))
      (local.set $row_wa (i32.add (local.get $dib_wa)
        (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $pitch))))
      (local.set $col (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_s (local.get $col) (local.get $w)))
        (if (i32.or (i32.lt_s (i32.add (local.get $x) (local.get $col)) (i32.const 0))
                    (i32.ge_s (i32.add (local.get $x) (local.get $col)) (local.get $sw)))
          (then (local.set $col (i32.add (local.get $col) (i32.const 1))) (br $clp)))
        (local.set $color (call $d3dim_texture_sample_rgb (local.get $tex_entry)
          (f32.div (f32.add (f32.convert_i32_s (local.get $col)) (f32.const 0.5)) (local.get $fw))
          (f32.div (f32.add (f32.convert_i32_s (local.get $row)) (f32.const 0.5)) (local.get $fh))))
        (if (i32.eq (local.get $bpp) (i32.const 32)) (then
          (i32.store
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 4)))
            (local.get $color))))
        (if (i32.eq (local.get $bpp) (i32.const 16)) (then
          (local.set $px16 (i32.or (i32.or
            (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 19)) (i32.const 0x1F)) (i32.const 11))
            (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 10)) (i32.const 0x3F)) (i32.const  5)))
            (i32.and (i32.shr_u (local.get $color) (i32.const 3)) (i32.const 0x1F))))
          (i32.store16
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 2)))
            (local.get $px16))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $clp)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rlp))))

  ;; Source-alpha blend a rect into an RT DIB. The source color is 0xAARRGGBB.
  (func $viewport_fill_rect_alpha (param $rt_entry i32) (param $x i32) (param $y i32) (param $w i32) (param $h i32) (param $color i32) (param $alpha i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $row i32) (local $col i32) (local $row_wa i32) (local $ptr i32)
    (local $dst16 i32) (local $dst32 i32) (local $ia i32)
    (local $sr i32) (local $sg i32) (local $sb i32)
    (local $dr i32) (local $dg i32) (local $db i32)
    (local $rr i32) (local $gg i32) (local $bb i32) (local $px16 i32)
    (if (i32.eqz (local.get $alpha)) (then (return)))
    (if (i32.ge_u (local.get $alpha) (i32.const 255)) (then
      (call $viewport_fill_rect
        (local.get $rt_entry) (local.get $x) (local.get $y)
        (local.get $w) (local.get $h) (local.get $color))
      (return)))
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 16)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $rt_entry) (i32.const 20))))
    (if (i32.eqz (local.get $dib_wa)) (then (return)))
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then
      (local.set $w (i32.add (local.get $w) (local.get $x)))
      (local.set $x (i32.const 0))))
    (if (i32.lt_s (local.get $y) (i32.const 0)) (then
      (local.set $h (i32.add (local.get $h) (local.get $y)))
      (local.set $y (i32.const 0))))
    (if (i32.gt_s (i32.add (local.get $x) (local.get $w)) (local.get $sw))
      (then (local.set $w (i32.sub (local.get $sw) (local.get $x)))))
    (if (i32.gt_s (i32.add (local.get $y) (local.get $h)) (local.get $sh))
      (then (local.set $h (i32.sub (local.get $sh) (local.get $y)))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0)) (i32.le_s (local.get $h) (i32.const 0)))
      (then (return)))
    (if (i32.eq (local.get $bpp) (i32.const 8)) (then
      (call $viewport_fill_rect
        (local.get $rt_entry) (local.get $x) (local.get $y)
        (local.get $w) (local.get $h) (local.get $color))
      (return)))
    (local.set $ia (i32.sub (i32.const 255) (local.get $alpha)))
    (local.set $sr (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xff)))
    (local.set $sg (i32.and (i32.shr_u (local.get $color) (i32.const 8)) (i32.const 0xff)))
    (local.set $sb (i32.and (local.get $color) (i32.const 0xff)))
    (local.set $row (i32.const 0))
    (block $rdone (loop $rlp
      (br_if $rdone (i32.ge_s (local.get $row) (local.get $h)))
      (local.set $row_wa (i32.add (local.get $dib_wa)
        (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $pitch))))
      (local.set $col (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_s (local.get $col) (local.get $w)))
        (if (i32.eq (local.get $bpp) (i32.const 32)) (then
          (local.set $ptr
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 4))))
          (local.set $dst32 (i32.load (local.get $ptr)))
          (local.set $dr (i32.and (i32.shr_u (local.get $dst32) (i32.const 16)) (i32.const 0xff)))
          (local.set $dg (i32.and (i32.shr_u (local.get $dst32) (i32.const 8)) (i32.const 0xff)))
          (local.set $db (i32.and (local.get $dst32) (i32.const 0xff)))
          (local.set $rr (i32.div_u
            (i32.add (i32.mul (local.get $sr) (local.get $alpha)) (i32.mul (local.get $dr) (local.get $ia)))
            (i32.const 255)))
          (local.set $gg (i32.div_u
            (i32.add (i32.mul (local.get $sg) (local.get $alpha)) (i32.mul (local.get $dg) (local.get $ia)))
            (i32.const 255)))
          (local.set $bb (i32.div_u
            (i32.add (i32.mul (local.get $sb) (local.get $alpha)) (i32.mul (local.get $db) (local.get $ia)))
            (i32.const 255)))
          (i32.store (local.get $ptr)
            (i32.or
              (i32.and (local.get $dst32) (i32.const 0xff000000))
              (i32.or (i32.or
                (i32.shl (local.get $rr) (i32.const 16))
                (i32.shl (local.get $gg) (i32.const 8)))
                (local.get $bb))))))
        (if (i32.eq (local.get $bpp) (i32.const 16)) (then
          (local.set $ptr
            (i32.add (local.get $row_wa)
              (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 2))))
          (local.set $dst16 (i32.load16_u (local.get $ptr)))
          (local.set $dr (i32.shl (i32.and (i32.shr_u (local.get $dst16) (i32.const 11)) (i32.const 0x1f)) (i32.const 3)))
          (local.set $dg (i32.shl (i32.and (i32.shr_u (local.get $dst16) (i32.const 5)) (i32.const 0x3f)) (i32.const 2)))
          (local.set $db (i32.shl (i32.and (local.get $dst16) (i32.const 0x1f)) (i32.const 3)))
          (local.set $rr (i32.div_u
            (i32.add (i32.mul (local.get $sr) (local.get $alpha)) (i32.mul (local.get $dr) (local.get $ia)))
            (i32.const 255)))
          (local.set $gg (i32.div_u
            (i32.add (i32.mul (local.get $sg) (local.get $alpha)) (i32.mul (local.get $dg) (local.get $ia)))
            (i32.const 255)))
          (local.set $bb (i32.div_u
            (i32.add (i32.mul (local.get $sb) (local.get $alpha)) (i32.mul (local.get $db) (local.get $ia)))
            (i32.const 255)))
          (local.set $px16 (i32.or (i32.or
            (i32.shl (i32.and (i32.shr_u (local.get $rr) (i32.const 3)) (i32.const 0x1f)) (i32.const 11))
            (i32.shl (i32.and (i32.shr_u (local.get $gg) (i32.const 2)) (i32.const 0x3f)) (i32.const 5)))
            (i32.and (i32.shr_u (local.get $bb) (i32.const 3)) (i32.const 0x1f))))
          (i32.store16 (local.get $ptr) (local.get $px16))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $clp)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rlp))))

  (func $viewport_fill_rect_z
    (param $rt_entry i32) (param $zbuf_guest i32)
    (param $x i32) (param $y i32) (param $w i32) (param $h i32)
    (param $zval f32) (param $color i32) (param $zfunc i32) (param $zwrite i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $zbuf_wa i32) (local $row i32) (local $col i32) (local $row_wa i32)
    (local $px16 i32) (local $zptr i32) (local $zentry i32) (local $zdib i32)
    (local $zpitch i32) (local $zbpp i32) (local $zraw i32) (local $pass i32)
    (local $ztest f32)
    (if (i32.eqz (local.get $zbuf_guest)) (then
      (call $viewport_fill_rect
        (local.get $rt_entry) (local.get $x) (local.get $y)
        (local.get $w) (local.get $h) (local.get $color))
      (return)))
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 16)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $rt_entry) (i32.const 20))))
    (if (i32.and
          (i32.ge_u (local.get $zbuf_guest) (global.get $DX_OBJECTS))
          (i32.lt_u (local.get $zbuf_guest)
            (i32.add (global.get $DX_OBJECTS) (global.get $DX_OBJECTS_SIZE))))
      (then
        (local.set $zentry (local.get $zbuf_guest))
        (local.set $zdib (i32.load offset=20 (local.get $zentry)))
        (local.set $zpitch (i32.load16_u offset=18 (local.get $zentry)))
        (local.set $zbpp (i32.load16_u offset=16 (local.get $zentry))))
      (else (local.set $zbuf_wa (call $g2w (local.get $zbuf_guest)))))
    (if (i32.or
          (i32.eqz (local.get $dib_wa))
          (i32.and (i32.eqz (local.get $zbuf_wa)) (i32.eqz (local.get $zdib))))
      (then (return)))
    (if (i32.lt_s (local.get $x) (i32.const 0)) (then
      (local.set $w (i32.add (local.get $w) (local.get $x)))
      (local.set $x (i32.const 0))))
    (if (i32.lt_s (local.get $y) (i32.const 0)) (then
      (local.set $h (i32.add (local.get $h) (local.get $y)))
      (local.set $y (i32.const 0))))
    (if (i32.gt_s (i32.add (local.get $x) (local.get $w)) (local.get $sw))
      (then (local.set $w (i32.sub (local.get $sw) (local.get $x)))))
    (if (i32.gt_s (i32.add (local.get $y) (local.get $h)) (local.get $sh))
      (then (local.set $h (i32.sub (local.get $sh) (local.get $y)))))
    (if (i32.or (i32.le_s (local.get $w) (i32.const 0)) (i32.le_s (local.get $h) (i32.const 0)))
      (then (return)))
    (local.set $px16 (i32.or (i32.or
      (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 19)) (i32.const 0x1F)) (i32.const 11))
      (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 10)) (i32.const 0x3F)) (i32.const  5)))
      (i32.and (i32.shr_u (local.get $color) (i32.const 3)) (i32.const 0x1F))))
    (local.set $row (i32.const 0))
    (block $rdone (loop $rlp
      (br_if $rdone (i32.ge_s (local.get $row) (local.get $h)))
      (local.set $row_wa (i32.add (local.get $dib_wa)
        (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $pitch))))
      (local.set $col (i32.const 0))
      (block $cdone (loop $clp
        (br_if $cdone (i32.ge_s (local.get $col) (local.get $w)))
        (local.set $pass (i32.const 0))
        (if (local.get $zentry)
          (then
            (local.set $zptr (i32.add (local.get $zdib)
              (i32.add
                (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $zpitch))
                (i32.mul (i32.add (local.get $x) (local.get $col))
                  (i32.shr_u (local.get $zbpp) (i32.const 3))))))
            (local.set $ztest (local.get $zval))
            ;; A clipped/degenerate triangle can carry NaN depth. Reject it:
            ;; mapping NaN to either endpoint can pass reversed or ALWAYS
            ;; depth modes and poison every pixel in an attached Z surface.
            (if (f32.eq (local.get $ztest) (local.get $ztest))
              (then
                (if (f32.lt (local.get $ztest) (f32.const 0.0)) (then (local.set $ztest (f32.const 0.0))))
                (if (f32.gt (local.get $ztest) (f32.const 1.0)) (then (local.set $ztest (f32.const 1.0))))
                (if (i32.eq (local.get $zbpp) (i32.const 16))
                  (then
                    (local.set $zraw (i32.trunc_sat_f32_u
                      (f32.mul (local.get $ztest) (f32.const 65535.0))))
                    (if (call $d3dim_depth_compare_u
                          (local.get $zraw) (i32.load16_u (local.get $zptr)) (local.get $zfunc))
                      (then
                        (if (local.get $zwrite)
                          (then (i32.store16 (local.get $zptr) (local.get $zraw))))
                        (local.set $pass (i32.const 1)))))
                  (else
                    (if (i32.eq (local.get $zbpp) (i32.const 32))
                      (then
                        (local.set $zraw (i32.trunc_sat_f32_u
                          (f32.mul (local.get $ztest) (f32.const 4294967040.0))))
                        (if (call $d3dim_depth_compare_u
                              (local.get $zraw) (i32.load (local.get $zptr)) (local.get $zfunc))
                          (then
                            (if (local.get $zwrite)
                              (then (i32.store (local.get $zptr) (local.get $zraw))))
                            (local.set $pass (i32.const 1)))))))))))
          (else
            (local.set $zptr (i32.add (local.get $zbuf_wa)
              (i32.mul
                (i32.add
                  (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $sw))
                  (i32.add (local.get $x) (local.get $col)))
                (i32.const 4))))
            (if (f32.eq (local.get $zval) (local.get $zval))
              (then
                (if (call $d3dim_depth_compare_f32
                      (local.get $zval) (f32.load (local.get $zptr)) (local.get $zfunc))
                  (then
                    (if (local.get $zwrite)
                      (then (f32.store (local.get $zptr) (local.get $zval))))
                    (local.set $pass (i32.const 1))))))))
        (if (local.get $pass) (then
          (if (i32.eq (local.get $bpp) (i32.const 32)) (then
            (i32.store
              (i32.add (local.get $row_wa)
                (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 4)))
              (local.get $color))))
          (if (i32.eq (local.get $bpp) (i32.const 16)) (then
            (i32.store16
              (i32.add (local.get $row_wa)
                (i32.mul (i32.add (local.get $x) (local.get $col)) (i32.const 2)))
              (local.get $px16))))
          (if (i32.eq (local.get $bpp) (i32.const 8)) (then
            (i32.store8
              (i32.add (local.get $row_wa) (i32.add (local.get $x) (local.get $col)))
              (local.get $color))))))
        (local.set $col (i32.add (local.get $col) (i32.const 1)))
        (br $clp)))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $rlp))))

  ;; Every screen coordinate that reaches the rasterizer comes from a guest
  ;; float, and a guest is free to hand us a degenerate one: a vertex divided
  ;; by a zero w, an uninitialized buffer, a projection matrix that has not
  ;; been set yet. Plain i32.trunc_f32_s traps on NaN and on anything outside
  ;; i32 range, and a WASM trap is not a dropped triangle -- it kills the whole
  ;; emulator, taking the app and every other thread with it. Real hardware
  ;; just rasterizes garbage and moves on, so clamp instead: NaN lands at 0 via
  ;; trunc_sat, and the +/-1e6 bound keeps the edge-walk arithmetic below the
  ;; point where the span loop's i32 differences would overflow.
  ;; Repro before this existed: the DX SDK viewer.exe on any real Mesh .x file
  ;; crashed in $d3dim_draw_tl_triangle with "float unrepresentable in integer
  ;; range" as soon as d3drm handed the first triangle to Execute.
  (func $d3dim_coord_i (param $f f32) (result i32)
    (i32.trunc_sat_f32_s
      (f32.min (f32.max (local.get $f) (f32.const -1000000.0)) (f32.const 1000000.0))))

  (func $d3dim_texture_sample_rgb (param $tex_entry i32) (param $u f32) (param $v f32) (result i32)
    (local $tw i32) (local $th i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $tx i32) (local $ty i32) (local $ptr i32) (local $px i32) (local $c i32)
    (local $pal i32)
    (if (i32.eqz (local.get $tex_entry)) (then (return (i32.const 0))))
    (local.set $tw (i32.and (i32.load (i32.add (local.get $tex_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $th (i32.shr_u (i32.load (i32.add (local.get $tex_entry) (i32.const 12))) (i32.const 16)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $tex_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $tex_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $tex_entry) (i32.const 20))))
    (if (i32.or
          (i32.or (i32.eqz (local.get $tw)) (i32.eqz (local.get $th)))
          (i32.or (i32.eqz (local.get $pitch)) (i32.eqz (local.get $dib_wa))))
      (then (return (i32.const 0))))
    ;; D3DIM samples commonly use wrapping coordinates.
    (local.set $u (f32.sub (local.get $u) (f32.floor (local.get $u))))
    (local.set $v (f32.sub (local.get $v) (f32.floor (local.get $v))))
    ;; trunc_sat, not trunc: a NaN texture coordinate survives the wrap above
    ;; (NaN - floor(NaN) is still NaN) and would trap the module rather than
    ;; sample a wrong texel. The clamps below already fix up an out-of-range
    ;; result, and trunc_sat sends NaN to 0, which they accept.
    (local.set $tx (i32.trunc_sat_f32_u (f32.mul (local.get $u) (f32.convert_i32_u (local.get $tw)))))
    (local.set $ty (i32.trunc_sat_f32_u (f32.mul (local.get $v) (f32.convert_i32_u (local.get $th)))))
    (if (i32.ge_u (local.get $tx) (local.get $tw)) (then (local.set $tx (i32.sub (local.get $tw) (i32.const 1)))))
    (if (i32.ge_u (local.get $ty) (local.get $th)) (then (local.set $ty (i32.sub (local.get $th) (i32.const 1)))))
    (local.set $ptr (i32.add (local.get $dib_wa) (i32.mul (local.get $ty) (local.get $pitch))))
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (local.set $px (i32.load16_u (i32.add (local.get $ptr) (i32.mul (local.get $tx) (i32.const 2)))))
      (return (call $d3dim_decode_surface_pixel
        (local.get $tex_entry) (local.get $px) (local.get $bpp)))))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (return (call $d3dim_decode_surface_pixel (local.get $tex_entry)
        (i32.load (i32.add (local.get $ptr) (i32.mul (local.get $tx) (i32.const 4))))
        (local.get $bpp)))))
    (if (i32.eq (local.get $bpp) (i32.const 8)) (then
      (local.set $c (i32.load8_u (i32.add (local.get $ptr) (local.get $tx))))
      ;; 8bpp textures are palettized: the byte is an index, not a grey level.
      (local.set $pal (call $dx_surf_pal_get (local.get $tex_entry)))
      (if (local.get $pal) (then
        (local.set $px (i32.load (i32.add (local.get $pal) (i32.shl (local.get $c) (i32.const 2)))))
        ;; PALETTEENTRY is (peRed, peGreen, peBlue, peFlags)
        (return (i32.or (i32.const 0xFF000000) (i32.or (i32.or
          (i32.shl (i32.and (local.get $px) (i32.const 0xFF)) (i32.const 16))
          (i32.and (local.get $px) (i32.const 0xFF00)))
          (i32.and (i32.shr_u (local.get $px) (i32.const 16)) (i32.const 0xFF)))))))
      (return (i32.or (i32.const 0xFF000000)
        (i32.or (i32.or (i32.shl (local.get $c) (i32.const 16))
                        (i32.shl (local.get $c) (i32.const 8))) (local.get $c))))))
    (i32.const 0))

  (func $d3dim_address_texel (param $i i32) (param $size i32) (param $mode i32) (result i32)
    (local $period i32)
    ;; D3DTADDRESS_CLAMP
    (if (i32.eq (local.get $mode) (i32.const 3)) (then
      (if (i32.lt_s (local.get $i) (i32.const 0)) (then (return (i32.const 0))))
      (if (i32.ge_s (local.get $i) (local.get $size))
        (then (return (i32.sub (local.get $size) (i32.const 1)))))
      (return (local.get $i))))
    ;; D3DTADDRESS_MIRROR
    (if (i32.eq (local.get $mode) (i32.const 2)) (then
      (local.set $period (i32.shl (local.get $size) (i32.const 1)))
      (local.set $i (i32.rem_s (local.get $i) (local.get $period)))
      (if (i32.lt_s (local.get $i) (i32.const 0))
        (then (local.set $i (i32.add (local.get $i) (local.get $period)))))
      (if (i32.ge_s (local.get $i) (local.get $size))
        (then (local.set $i (i32.sub (i32.sub (local.get $period) (i32.const 1)) (local.get $i)))))
      (return (local.get $i))))
    ;; D3DTADDRESS_WRAP, and the legacy zero/default state.
    ;; D3D3 content overwhelmingly uses power-of-two textures. For those,
    ;; two's-complement AND is the exact wrapped remainder for positive and
    ;; negative coordinates and avoids a signed integer divide for each of the
    ;; four bilinear neighbours.
    (if (i32.eqz
          (i32.and (local.get $size) (i32.sub (local.get $size) (i32.const 1))))
      (then (return (i32.and (local.get $i) (i32.sub (local.get $size) (i32.const 1))))))
    (local.set $i (i32.rem_s (local.get $i) (local.get $size)))
    (if (i32.lt_s (local.get $i) (i32.const 0))
      (then (local.set $i (i32.add (local.get $i) (local.get $size)))))
    (local.get $i))

  (func $d3dim_texture_fetch_prepared
    (param $bpp i32) (param $pitch i32) (param $dib_wa i32) (param $fmt i32) (param $pal i32)
    (param $tx i32) (param $ty i32) (result i32)
    (local $ptr i32) (local $px i32) (local $c i32)
    (local.set $ptr (i32.add (local.get $dib_wa) (i32.mul (local.get $ty) (local.get $pitch))))
    (if (i32.eq (local.get $bpp) (i32.const 16)) (then
      (local.set $px (i32.load16_u
        (i32.add (local.get $ptr) (i32.shl (local.get $tx) (i32.const 1)))))
      (return (call $d3dim_decode_surface_pixel_fmt
        (local.get $fmt) (local.get $px) (local.get $bpp)))))
    (if (i32.eq (local.get $bpp) (i32.const 32)) (then
      (return (call $d3dim_decode_surface_pixel_fmt (local.get $fmt)
        (i32.load (i32.add (local.get $ptr) (i32.shl (local.get $tx) (i32.const 2))))
        (local.get $bpp)))))
    (if (i32.eq (local.get $bpp) (i32.const 8)) (then
      (local.set $c (i32.load8_u (i32.add (local.get $ptr) (local.get $tx))))
      (if (local.get $pal) (then
        (local.set $px (i32.load
          (i32.add (local.get $pal) (i32.shl (local.get $c) (i32.const 2)))))
        (return (i32.or (i32.const 0xFF000000) (i32.or
          (i32.or
            (i32.shl (i32.and (local.get $px) (i32.const 0xFF)) (i32.const 16))
            (i32.and (local.get $px) (i32.const 0xFF00)))
          (i32.and (i32.shr_u (local.get $px) (i32.const 16)) (i32.const 0xFF))))))
        ;; No palette bound: sample the index as greyscale rather than as
        ;; transparent black.
        (else (return (i32.or (i32.const 0xFF000000)
          (i32.or (i32.shl (local.get $c) (i32.const 16))
            (i32.or (i32.shl (local.get $c) (i32.const 8)) (local.get $c)))))))))
    (i32.const 0))

  ;; Hot span sampler with immutable surface metadata already loaded by the
  ;; caller. Supports the fixed-function point/linear and wrap/mirror/clamp
  ;; states used by D3D3 games.
  (func $d3dim_texture_sample_prepared
    (param $tw i32) (param $th i32) (param $bpp i32) (param $pitch i32)
    (param $dib_wa i32) (param $fmt i32) (param $pal i32)
    (param $u f32) (param $v f32) (param $address_u i32) (param $address_v i32)
    (param $linear i32) (result i32)
    (local $sx f32) (local $sy f32) (local $fx f32) (local $fy f32)
    (local $x0 i32) (local $x1 i32) (local $y0 i32) (local $y1 i32)
    (local $c00 i32) (local $c10 i32) (local $c01 i32) (local $c11 i32)
    ;; Legacy hardware converts non-finite texture coordinates to its integer
    ;; indefinite value before addressing; for the power-of-two WRAP textures
    ;; used here that selects texel zero.  Canonicalize both coordinates before
    ;; the linear footprint math as well: leaving NaN in the fractional weights
    ;; makes four valid (even identical) samples interpolate to black through
    ;; trunc_sat. MW3's third terrain pass deliberately leaves TEX2 as NaN/Inf
    ;; while binding an all-white no-op lightmap, so that bug erased the entire
    ;; camera-near polygon after its correctly textured base pass.
    (if (f32.ne (f32.mul (local.get $u) (f32.const 0.0)) (f32.const 0.0))
      (then (local.set $u (f32.const 0.0))))
    (if (f32.ne (f32.mul (local.get $v) (f32.const 0.0)) (f32.const 0.0))
      (then (local.set $v (f32.const 0.0))))
    (if (i32.eqz (local.get $linear)) (then
      (local.set $x0 (call $d3dim_address_texel
        (i32.trunc_sat_f32_s (f32.floor (f32.mul (local.get $u) (f32.convert_i32_u (local.get $tw)))))
        (local.get $tw) (local.get $address_u)))
      (local.set $y0 (call $d3dim_address_texel
        (i32.trunc_sat_f32_s (f32.floor (f32.mul (local.get $v) (f32.convert_i32_u (local.get $th)))))
        (local.get $th) (local.get $address_v)))
      (return (call $d3dim_texture_fetch_prepared
        (local.get $bpp) (local.get $pitch) (local.get $dib_wa) (local.get $fmt) (local.get $pal)
        (local.get $x0) (local.get $y0)))))
    ;; D3D's linear footprint is centred on the texel, hence the half-texel
    ;; offset before choosing and addressing the four neighbours.
    (local.set $sx (f32.sub (f32.mul (local.get $u) (f32.convert_i32_u (local.get $tw))) (f32.const 0.5)))
    (local.set $sy (f32.sub (f32.mul (local.get $v) (f32.convert_i32_u (local.get $th))) (f32.const 0.5)))
    (local.set $x0 (i32.trunc_sat_f32_s (f32.floor (local.get $sx))))
    (local.set $y0 (i32.trunc_sat_f32_s (f32.floor (local.get $sy))))
    (local.set $fx (f32.sub (local.get $sx) (f32.floor (local.get $sx))))
    (local.set $fy (f32.sub (local.get $sy) (f32.floor (local.get $sy))))
    (local.set $x1 (call $d3dim_address_texel (i32.add (local.get $x0) (i32.const 1)) (local.get $tw) (local.get $address_u)))
    (local.set $y1 (call $d3dim_address_texel (i32.add (local.get $y0) (i32.const 1)) (local.get $th) (local.get $address_v)))
    (local.set $x0 (call $d3dim_address_texel (local.get $x0) (local.get $tw) (local.get $address_u)))
    (local.set $y0 (call $d3dim_address_texel (local.get $y0) (local.get $th) (local.get $address_v)))
    (local.set $c00 (call $d3dim_texture_fetch_prepared
      (local.get $bpp) (local.get $pitch) (local.get $dib_wa) (local.get $fmt) (local.get $pal)
      (local.get $x0) (local.get $y0)))
    (local.set $c10 (call $d3dim_texture_fetch_prepared
      (local.get $bpp) (local.get $pitch) (local.get $dib_wa) (local.get $fmt) (local.get $pal)
      (local.get $x1) (local.get $y0)))
    (local.set $c01 (call $d3dim_texture_fetch_prepared
      (local.get $bpp) (local.get $pitch) (local.get $dib_wa) (local.get $fmt) (local.get $pal)
      (local.get $x0) (local.get $y1)))
    (local.set $c11 (call $d3dim_texture_fetch_prepared
      (local.get $bpp) (local.get $pitch) (local.get $dib_wa) (local.get $fmt) (local.get $pal)
      (local.get $x1) (local.get $y1)))
    (call $d3dim_color_lerp
      (call $d3dim_color_lerp (local.get $c00) (local.get $c10) (local.get $fx))
      (call $d3dim_color_lerp (local.get $c01) (local.get $c11) (local.get $fx))
      (local.get $fy)))

  ;; Fixed-function stage 0 defaults to MODULATE: texture RGB is multiplied by
  ;; the Gouraud-interpolated diffuse colour produced by lighting (or supplied
  ;; by an L/TL vertex). Keep the interpolation in packed 0xAARRGGBB form so
  ;; the scan converter only carries one additional value per edge.
  (func $d3dim_color_lerp (param $a i32) (param $b i32) (param $t f32) (result i32)
    (local $va v128) (local $vb v128) (local $vr v128) (local $v16 v128)
    ;; A splatted packed pixel repeats BGRA bytes on little-endian Wasm.
    ;; Widen its first four bytes to i32 lanes, interpolate all channels with
    ;; the same f32/trunc_sat semantics as the former scalar path, then narrow
    ;; BGRA back into lane zero. Bilinear filtering calls this three times per
    ;; output pixel; doing four channels in parallel removes twelve scalar
    ;; int<->float conversions and the associated extract/repack chain.
    (local.set $va
      (i32x4.extend_low_i16x8_u
        (i16x8.extend_low_i8x16_u (i32x4.splat (local.get $a)))))
    (local.set $vb
      (i32x4.extend_low_i16x8_u
        (i16x8.extend_low_i8x16_u (i32x4.splat (local.get $b)))))
    (local.set $vr
      (i32x4.trunc_sat_f32x4_u
        (f32x4.add
          (f32x4.convert_i32x4_u (local.get $va))
          (f32x4.mul
            (f32x4.sub
              (f32x4.convert_i32x4_u (local.get $vb))
              (f32x4.convert_i32x4_u (local.get $va)))
            (f32x4.splat (local.get $t))))))
    (local.set $v16
      (i16x8.narrow_i32x4_u (local.get $vr) (i32x4.splat (i32.const 0))))
    (i32x4.extract_lane 0
      (i8x16.narrow_i16x8_u (local.get $v16) (i16x8.splat (i32.const 0)))))

  ;; Exact floor(x/255) through 65534 without integer division. Texture colour
  ;; products and the rounded convex blend numerator stay in that range.
  (func $d3dim_div255 (param $x i32) (result i32)
    (i32.shr_u
      (i32.add (i32.add (local.get $x) (i32.const 1))
               (i32.shr_u (local.get $x) (i32.const 8)))
      (i32.const 8)))

  (func $d3dim_modulate_rgb (param $tex i32) (param $diffuse i32) (result i32)
    (local $alpha i32) (local $r i32) (local $g i32) (local $b i32)
    (local.set $alpha (call $d3dim_div255
      (i32.mul (i32.shr_u (local.get $tex) (i32.const 24))
               (i32.shr_u (local.get $diffuse) (i32.const 24)))))
    (local.set $r (call $d3dim_div255
      (i32.mul (i32.and (i32.shr_u (local.get $tex) (i32.const 16)) (i32.const 0xff))
               (i32.and (i32.shr_u (local.get $diffuse) (i32.const 16)) (i32.const 0xff)))))
    (local.set $g (call $d3dim_div255
      (i32.mul (i32.and (i32.shr_u (local.get $tex) (i32.const 8)) (i32.const 0xff))
               (i32.and (i32.shr_u (local.get $diffuse) (i32.const 8)) (i32.const 0xff)))))
    (local.set $b (call $d3dim_div255
      (i32.mul (i32.and (local.get $tex) (i32.const 0xff))
               (i32.and (local.get $diffuse) (i32.const 0xff)))))
    (i32.or (i32.shl (local.get $alpha) (i32.const 24))
      (i32.or (i32.shl (local.get $r) (i32.const 16))
        (i32.or (i32.shl (local.get $g) (i32.const 8)) (local.get $b)))))

  ;; D3DTOP_SELECTARG1=2, SELECTARG2=3, MODULATE=4. MW3 supplies TEXTURE as
  ;; ARG1 and DIFFUSE as ARG2, switching SELECTARG1/MODULATE between passes.
  (func $d3dim_texture_stage_combine
    (param $tex i32) (param $diffuse i32) (param $colorop i32) (param $alphaop i32)
    (result i32)
    (local $mod i32) (local $rgb i32) (local $alpha i32)
    (if (i32.eqz (local.get $colorop)) (then (local.set $colorop (i32.const 4))))
    (if (i32.eqz (local.get $alphaop)) (then (local.set $alphaop (i32.const 4))))
    (local.set $mod (call $d3dim_modulate_rgb (local.get $tex) (local.get $diffuse)))
    (local.set $rgb (i32.and (local.get $mod) (i32.const 0x00ffffff)))
    (if (i32.eq (local.get $colorop) (i32.const 2))
      (then (local.set $rgb (i32.and (local.get $tex) (i32.const 0x00ffffff)))))
    (if (i32.eq (local.get $colorop) (i32.const 3))
      (then (local.set $rgb (i32.and (local.get $diffuse) (i32.const 0x00ffffff)))))
    (local.set $alpha (i32.and (local.get $mod) (i32.const 0xff000000)))
    (if (i32.eq (local.get $alphaop) (i32.const 2))
      (then (local.set $alpha (i32.and (local.get $tex) (i32.const 0xff000000)))))
    (if (i32.eq (local.get $alphaop) (i32.const 3))
      (then (local.set $alpha (i32.and (local.get $diffuse) (i32.const 0xff000000)))))
    (i32.or (local.get $alpha) (local.get $rgb)))

  ;; One fixed-function framebuffer blend channel. D3DBLEND values used by
  ;; MW3 are ZERO/ONE/SRCCOLOR and SRCALPHA/INVSRCALPHA; the remaining legacy
  ;; color factors are cheap to cover here and keep the helper generally sane.
  (func $d3dim_blend_channel
    (param $src i32) (param $dst i32) (param $alpha i32)
    (param $src_blend i32) (param $dst_blend i32) (result i32)
    (local $sf i32) (local $df i32) (local $out i32) (local $numerator i32)
    (local.set $sf (i32.const 255))
    (if (i32.eq (local.get $src_blend) (i32.const 1)) (then (local.set $sf (i32.const 0))))
    (if (i32.eq (local.get $src_blend) (i32.const 3)) (then (local.set $sf (local.get $src))))
    (if (i32.eq (local.get $src_blend) (i32.const 4)) (then (local.set $sf (i32.sub (i32.const 255) (local.get $src)))))
    (if (i32.eq (local.get $src_blend) (i32.const 5)) (then (local.set $sf (local.get $alpha))))
    (if (i32.eq (local.get $src_blend) (i32.const 6)) (then (local.set $sf (i32.sub (i32.const 255) (local.get $alpha)))))
    (if (i32.eq (local.get $src_blend) (i32.const 8)) (then (local.set $sf (i32.const 0))))
    (if (i32.eq (local.get $src_blend) (i32.const 9)) (then (local.set $sf (local.get $dst))))
    (if (i32.eq (local.get $src_blend) (i32.const 10)) (then (local.set $sf (i32.sub (i32.const 255) (local.get $dst)))))
    (if (i32.eq (local.get $src_blend) (i32.const 11)) (then (local.set $sf (i32.const 0))))
    (local.set $df (i32.const 255))
    (if (i32.eq (local.get $dst_blend) (i32.const 1)) (then (local.set $df (i32.const 0))))
    (if (i32.eq (local.get $dst_blend) (i32.const 3)) (then (local.set $df (local.get $src))))
    (if (i32.eq (local.get $dst_blend) (i32.const 4)) (then (local.set $df (i32.sub (i32.const 255) (local.get $src)))))
    (if (i32.eq (local.get $dst_blend) (i32.const 5)) (then (local.set $df (local.get $alpha))))
    (if (i32.eq (local.get $dst_blend) (i32.const 6)) (then (local.set $df (i32.sub (i32.const 255) (local.get $alpha)))))
    (if (i32.eq (local.get $dst_blend) (i32.const 8)) (then (local.set $df (i32.const 0))))
    (if (i32.eq (local.get $dst_blend) (i32.const 9)) (then (local.set $df (local.get $dst))))
    (if (i32.eq (local.get $dst_blend) (i32.const 10)) (then (local.set $df (i32.sub (i32.const 255) (local.get $dst)))))
    (if (i32.eq (local.get $dst_blend) (i32.const 11)) (then (local.set $df (i32.const 0))))
    (local.set $numerator
      (i32.add (i32.mul (local.get $src) (local.get $sf))
               (i32.mul (local.get $dst) (local.get $df))))
    ;; The legacy formula rounds by adding 127, then clamps. Values at or
    ;; above 64898 therefore saturate without needing the divide.
    (if (i32.ge_u (local.get $numerator) (i32.const 64898))
      (then (return (i32.const 255))))
    (local.set $out (call $d3dim_div255
      (i32.add (local.get $numerator) (i32.const 127))))
    (local.get $out))

  (func $d3dim_blend_rgb
    (param $src i32) (param $dst i32) (param $src_blend i32) (param $dst_blend i32)
    (result i32)
    (local $alpha i32) (local $inv_alpha i32)
    (local.set $alpha (i32.shr_u (local.get $src) (i32.const 24)))
    ;; MW3's light-map pass: destination *= source colour.
    (if (i32.and (i32.eq (local.get $src_blend) (i32.const 1))
                 (i32.eq (local.get $dst_blend) (i32.const 3))) (then
      (return (i32.or
        (i32.shl (call $d3dim_div255
          (i32.mul
            (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 255))
            (i32.and (i32.shr_u (local.get $dst) (i32.const 16)) (i32.const 255))))
          (i32.const 16))
        (i32.or
          (i32.shl (call $d3dim_div255
            (i32.mul
              (i32.and (i32.shr_u (local.get $src) (i32.const 8)) (i32.const 255))
              (i32.and (i32.shr_u (local.get $dst) (i32.const 8)) (i32.const 255))))
            (i32.const 8))
          (call $d3dim_div255
            (i32.mul (i32.and (local.get $src) (i32.const 255))
                     (i32.and (local.get $dst) (i32.const 255)))))))))
    ;; MW3's alpha/fade pass. Each channel is a convex combination, so the
    ;; rounded numerator remains in the non-saturating div255 range.
    (if (i32.and (i32.eq (local.get $src_blend) (i32.const 5))
                 (i32.eq (local.get $dst_blend) (i32.const 6))) (then
      (local.set $inv_alpha (i32.sub (i32.const 255) (local.get $alpha)))
      (return (i32.or
        (i32.shl (call $d3dim_div255 (i32.add (i32.const 127)
          (i32.add
            (i32.mul (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 255)) (local.get $alpha))
            (i32.mul (i32.and (i32.shr_u (local.get $dst) (i32.const 16)) (i32.const 255)) (local.get $inv_alpha)))))
          (i32.const 16))
        (i32.or
          (i32.shl (call $d3dim_div255 (i32.add (i32.const 127)
            (i32.add
              (i32.mul (i32.and (i32.shr_u (local.get $src) (i32.const 8)) (i32.const 255)) (local.get $alpha))
              (i32.mul (i32.and (i32.shr_u (local.get $dst) (i32.const 8)) (i32.const 255)) (local.get $inv_alpha)))))
            (i32.const 8))
          (call $d3dim_div255 (i32.add (i32.const 127)
            (i32.add
              (i32.mul (i32.and (local.get $src) (i32.const 255)) (local.get $alpha))
              (i32.mul (i32.and (local.get $dst) (i32.const 255)) (local.get $inv_alpha))))))))))
    (i32.or
      (i32.shl (call $d3dim_blend_channel
        (i32.and (i32.shr_u (local.get $src) (i32.const 16)) (i32.const 255))
        (i32.and (i32.shr_u (local.get $dst) (i32.const 16)) (i32.const 255))
        (local.get $alpha) (local.get $src_blend) (local.get $dst_blend)) (i32.const 16))
      (i32.or
        (i32.shl (call $d3dim_blend_channel
          (i32.and (i32.shr_u (local.get $src) (i32.const 8)) (i32.const 255))
          (i32.and (i32.shr_u (local.get $dst) (i32.const 8)) (i32.const 255))
          (local.get $alpha) (local.get $src_blend) (local.get $dst_blend)) (i32.const 8))
        (call $d3dim_blend_channel
          (i32.and (local.get $src) (i32.const 255))
          (i32.and (local.get $dst) (i32.const 255))
          (local.get $alpha) (local.get $src_blend) (local.get $dst_blend)))))

  ;; D3DCMPFUNC: 1 NEVER, 2 LESS, 3 EQUAL, 4 LESSEQUAL, 5 GREATER,
  ;; 6 NOTEQUAL, 7 GREATEREQUAL, 8 ALWAYS.  Use unsigned comparisons for
  ;; packed 16/32-bit depth because both formats map [0,1] monotonically.
  (func $d3dim_depth_compare_u
    (param $incoming i32) (param $stored i32) (param $func i32) (result i32)
    ;; Hot legacy paths overwhelmingly use ALWAYS for overlays and
    ;; GREATEREQUAL for reversed depth. Keep those ahead of the uncommon
    ;; comparisons so the scalar per-pixel loop does not walk seven branches.
    (if (i32.eq (local.get $func) (i32.const 8)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $func) (i32.const 7))
      (then (return (i32.ge_u (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 4))
      (then (return (i32.le_u (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $func) (i32.const 2))
      (then (return (i32.lt_u (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 3))
      (then (return (i32.eq (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 5))
      (then (return (i32.gt_u (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 6))
      (then (return (i32.ne (local.get $incoming) (local.get $stored)))))
    (i32.const 0))

  (func $d3dim_depth_compare_f32
    (param $incoming f32) (param $stored f32) (param $func i32) (result i32)
    (if (i32.eq (local.get $func) (i32.const 8)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $func) (i32.const 7))
      (then (return (f32.ge (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 4))
      (then (return (f32.le (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 1)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $func) (i32.const 2))
      (then (return (f32.lt (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 3))
      (then (return (f32.eq (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 5))
      (then (return (f32.gt (local.get $incoming) (local.get $stored)))))
    (if (i32.eq (local.get $func) (i32.const 6))
      (then (return (f32.ne (local.get $incoming) (local.get $stored)))))
    (i32.const 0))

  ;; Quantize 0xAARRGGBB to RGB565. D3DRENDERSTATE_DITHERENABLE uses a 4x4
  ;; Bayer matrix before the low colour bits are discarded; keeping that work
  ;; in this helper leaves the overwhelmingly common non-dithered path as the
  ;; same three shifts/masks it used before.
  (func $d3dim_pack_rgb565
    (param $color i32) (param $x i32) (param $y i32)
    (result i32)
    (local $r i32) (local $g i32) (local $b i32) (local $t i32) (local $row i32)
    (local.set $r (i32.and (i32.shr_u (local.get $color) (i32.const 16)) (i32.const 0xff)))
    (local.set $g (i32.and (i32.shr_u (local.get $color) (i32.const 8)) (i32.const 0xff)))
    (local.set $b (i32.and (local.get $color) (i32.const 0xff)))
    (local.set $row (i32.and (local.get $y) (i32.const 3)))
      ;; Rows are 0,8,2,10 / 12,4,14,6 / 3,11,1,9 / 15,7,13,5.
      (if (i32.eq (local.get $row) (i32.const 0))
        (then
          (local.set $t (select (i32.const 0) (i32.const 8)
            (i32.eqz (i32.and (local.get $x) (i32.const 1)))))
          (if (i32.and (local.get $x) (i32.const 2))
            (then (local.set $t (i32.add (local.get $t) (i32.const 2))))))
        (else (if (i32.eq (local.get $row) (i32.const 1))
          (then
            (local.set $t (select (i32.const 12) (i32.const 4)
              (i32.eqz (i32.and (local.get $x) (i32.const 1)))))
            (if (i32.and (local.get $x) (i32.const 2))
              (then (local.set $t (i32.add (local.get $t) (i32.const 2))))))
          (else (if (i32.eq (local.get $row) (i32.const 2))
            (then
              (local.set $t (select (i32.const 3) (i32.const 11)
                (i32.eqz (i32.and (local.get $x) (i32.const 1)))))
              (if (i32.and (local.get $x) (i32.const 2))
                (then (local.set $t (i32.sub (local.get $t) (i32.const 2))))))
            (else
              (local.set $t (select (i32.const 15) (i32.const 7)
                (i32.eqz (i32.and (local.get $x) (i32.const 1)))))
              (if (i32.and (local.get $x) (i32.const 2))
                (then (local.set $t (i32.sub (local.get $t) (i32.const 2)))))))))))
      ;; Centre the threshold around zero. RGB565 steps are 8/4/8 levels.
      (local.set $t (i32.sub (local.get $t) (i32.const 8)))
      (local.set $r (i32.add (local.get $r) (i32.shr_s (local.get $t) (i32.const 1))))
      (local.set $g (i32.add (local.get $g) (i32.shr_s (local.get $t) (i32.const 2))))
      (local.set $b (i32.add (local.get $b) (i32.shr_s (local.get $t) (i32.const 1))))
      (if (i32.lt_s (local.get $r) (i32.const 0)) (then (local.set $r (i32.const 0))))
      (if (i32.gt_s (local.get $r) (i32.const 255)) (then (local.set $r (i32.const 255))))
      (if (i32.lt_s (local.get $g) (i32.const 0)) (then (local.set $g (i32.const 0))))
      (if (i32.gt_s (local.get $g) (i32.const 255)) (then (local.set $g (i32.const 255))))
      (if (i32.lt_s (local.get $b) (i32.const 0)) (then (local.set $b (i32.const 0))))
    (if (i32.gt_s (local.get $b) (i32.const 255)) (then (local.set $b (i32.const 255))))
    (i32.or
      (i32.or
        (i32.shl (i32.shr_u (local.get $r) (i32.const 3)) (i32.const 11))
        (i32.shl (i32.shr_u (local.get $g) (i32.const 2)) (i32.const 5)))
      (i32.shr_u (local.get $b) (i32.const 3))))

  (func $viewport_draw_textured_span
    (param $rt_entry i32) (param $tex_entry i32)
    (param $blend i32) (param $src_blend i32) (param $dst_blend i32)
    (param $address_u i32) (param $address_v i32) (param $linear i32)
    (param $colorop i32) (param $alphaop i32) (param $color_key_enable i32)
    (param $dither i32) (param $antialias i32)
    (param $y i32)
    (param $x0 i32) (param $u0 f32) (param $v0 f32) (param $q0 f32) (param $c0 i32) (param $z0 f32)
    (param $x1 i32) (param $u1 f32) (param $v1 f32) (param $q1 f32) (param $c1 i32) (param $z1 f32)
    (param $zbuf_guest i32) (param $zfunc i32) (param $zwrite i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $tx i32) (local $xs i32) (local $xe i32) (local $x i32)
    (local $tu f32) (local $tv f32) (local $tq f32) (local $tz f32)
    (local $den f32) (local $invden f32) (local $t f32)
    (local $color i32) (local $sample i32) (local $diffuse i32) (local $dst i32) (local $px16 i32) (local $row_wa i32) (local $ptr i32)
    (local $zbuf_wa i32) (local $zentry i32) (local $zdib i32) (local $zpitch i32) (local $zbpp i32)
    (local $zptr i32) (local $zraw i32) (local $draw i32) (local $ztest f32)
    (local $tw i32) (local $th i32) (local $tbpp i32) (local $tpitch i32)
    (local $tdib i32) (local $tfmt i32) (local $tpal i32)
    (local $key_active i32) (local $key_rgb i32)
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 12))) (i32.const 16)))
    (if (i32.or (i32.lt_s (local.get $y) (i32.const 0)) (i32.ge_s (local.get $y) (local.get $sh)))
      (then (return)))
    (if (i32.gt_s (local.get $x0) (local.get $x1)) (then
      (local.set $tx (local.get $x0))
      (local.set $tu (local.get $u0))
      (local.set $tv (local.get $v0))
      (local.set $tq (local.get $q0))
      (local.set $tz (local.get $z0))
      (local.set $diffuse (local.get $c0))
      (local.set $x0 (local.get $x1))
      (local.set $u0 (local.get $u1))
      (local.set $v0 (local.get $v1))
      (local.set $q0 (local.get $q1))
      (local.set $z0 (local.get $z1))
      (local.set $c0 (local.get $c1))
      (local.set $x1 (local.get $tx))
      (local.set $u1 (local.get $tu))
      (local.set $v1 (local.get $tv))
      (local.set $q1 (local.get $tq))
      (local.set $z1 (local.get $tz))
      (local.set $c1 (local.get $diffuse))))
    (if (i32.or (i32.lt_s (local.get $x1) (i32.const 0)) (i32.ge_s (local.get $x0) (local.get $sw)))
      (then (return)))
    (local.set $bpp (i32.and (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 0xFFFF)))
    (local.set $pitch (i32.shr_u (i32.load (i32.add (local.get $rt_entry) (i32.const 16))) (i32.const 16)))
    (local.set $dib_wa (i32.load (i32.add (local.get $rt_entry) (i32.const 20))))
    (if (i32.eqz (local.get $dib_wa)) (then (return)))
    (local.set $tw (i32.load16_u offset=12 (local.get $tex_entry)))
    (local.set $th (i32.load16_u offset=14 (local.get $tex_entry)))
    (local.set $tbpp (i32.load16_u offset=16 (local.get $tex_entry)))
    (local.set $tpitch (i32.load16_u offset=18 (local.get $tex_entry)))
    (local.set $tdib (i32.load offset=20 (local.get $tex_entry)))
    (if (i32.or (i32.or (i32.eqz (local.get $tw)) (i32.eqz (local.get $th)))
                (i32.or (i32.eqz (local.get $tpitch)) (i32.eqz (local.get $tdib))))
      (then (return)))
    (local.set $tfmt (call $dx_surf_fmt_get (local.get $tex_entry)))
    (if (i32.eq (local.get $tbpp) (i32.const 8))
      (then (local.set $tpal (call $dx_surf_pal_get (local.get $tex_entry)))))
    (local.set $key_active
      (i32.and
        (i32.ne (local.get $color_key_enable) (i32.const 0))
        (i32.ne
          (i32.and (i32.load offset=28 (local.get $tex_entry)) (i32.const 0x100))
          (i32.const 0))))
    (if (local.get $key_active) (then
      (local.set $key_rgb (call $d3dim_decode_surface_pixel
        (local.get $tex_entry) (i32.load offset=24 (local.get $tex_entry)) (local.get $tbpp)))))
    (local.set $xs (local.get $x0))
    (local.set $xe (local.get $x1))
    ;; Raster coverage is right-exclusive.  Sampling the geometric endpoint
    ;; made a screen-aligned 0..128 quad draw pixel 128 with u=1.0; WRAP then
    ;; aliases that sample to texture column zero, leaving an opaque vertical
    ;; seam beside otherwise transparent HUD fades (MCM's race overlay).
    ;; Preserve a one-pixel/degenerate span while excluding the far endpoint
    ;; from every span that has positive width.
    (if (i32.gt_s (local.get $xe) (local.get $xs))
      (then (local.set $xe (i32.sub (local.get $xe) (i32.const 1)))))
    (if (i32.lt_s (local.get $xs) (i32.const 0)) (then (local.set $xs (i32.const 0))))
    (if (i32.ge_s (local.get $xe) (local.get $sw)) (then (local.set $xe (i32.sub (local.get $sw) (i32.const 1)))))
    (if (i32.lt_s (local.get $xe) (local.get $xs)) (then (return)))
    (local.set $den (f32.convert_i32_s (i32.sub (local.get $x1) (local.get $x0))))
    (if (f32.eq (local.get $den) (f32.const 0.0)) (then (local.set $den (f32.const 1.0))))
    (local.set $invden (f32.div (f32.const 1.0) (local.get $den)))
    (if (local.get $zbuf_guest) (then
      (if (i32.and
            (i32.ge_u (local.get $zbuf_guest) (global.get $DX_OBJECTS))
            (i32.lt_u (local.get $zbuf_guest)
              (i32.add (global.get $DX_OBJECTS) (global.get $DX_OBJECTS_SIZE))))
        (then
          (local.set $zentry (local.get $zbuf_guest))
          (local.set $zdib (i32.load offset=20 (local.get $zentry)))
          (local.set $zpitch (i32.load16_u offset=18 (local.get $zentry)))
          (local.set $zbpp (i32.load16_u offset=16 (local.get $zentry))))
        (else (local.set $zbuf_wa (call $g2w (local.get $zbuf_guest)))))))
    (local.set $row_wa (i32.add (local.get $dib_wa) (i32.mul (local.get $y) (local.get $pitch))))
    (local.set $x (local.get $xs))
    (block $done (loop $lp
      (br_if $done (i32.gt_s (local.get $x) (local.get $xe)))
      (local.set $t (f32.mul
        (f32.convert_i32_s (i32.sub (local.get $x) (local.get $x0)))
        (local.get $invden)))
      (local.set $tu (f32.add (local.get $u0) (f32.mul (f32.sub (local.get $u1) (local.get $u0)) (local.get $t))))
      (local.set $tv (f32.add (local.get $v0) (f32.mul (f32.sub (local.get $v1) (local.get $v0)) (local.get $t))))
      (local.set $tq (f32.add (local.get $q0) (f32.mul (f32.sub (local.get $q1) (local.get $q0)) (local.get $t))))
      (if (f32.gt (f32.abs (local.get $tq)) (f32.const 0.000000000001)) (then
        (local.set $tu (f32.div (local.get $tu) (local.get $tq)))
        (local.set $tv (f32.div (local.get $tv) (local.get $tq)))))
      (local.set $tz (f32.add (local.get $z0) (f32.mul (f32.sub (local.get $z1) (local.get $z0)) (local.get $t))))
      (local.set $diffuse (call $d3dim_color_lerp (local.get $c0) (local.get $c1) (local.get $t)))
      (local.set $sample (call $d3dim_texture_sample_prepared
        (local.get $tw) (local.get $th) (local.get $tbpp) (local.get $tpitch)
        (local.get $tdib) (local.get $tfmt) (local.get $tpal)
        (local.get $tu) (local.get $tv)
        (local.get $address_u) (local.get $address_v) (local.get $linear)))
      (local.set $draw (i32.const 1))
      ;; D3DRENDERSTATE_COLORKEYENABLE discards a matching texture sample.
      ;; It must happen before depth testing/writes: transparent HUD texels
      ;; neither paint their magenta key nor occlude later geometry.
      (if (i32.and
            (local.get $key_active)
            (i32.eq
              (i32.and (local.get $sample) (i32.const 0x00ffffff))
              (i32.and (local.get $key_rgb) (i32.const 0x00ffffff))))
        (then (local.set $draw (i32.const 0))))
      (if (i32.and (local.get $draw) (i32.ne (local.get $zentry) (i32.const 0)))
        (then
          (local.set $zptr (i32.add (local.get $zdib)
            (i32.add (i32.mul (local.get $y) (local.get $zpitch))
              (i32.mul (local.get $x) (i32.shr_u (local.get $zbpp) (i32.const 3))))))
          (local.set $ztest (local.get $tz))
          ;; Reject non-finite depth rather than mapping it to an endpoint:
          ;; MW3 uses reversed GREATEREQUAL and ALWAYS states, so an endpoint
          ;; substitution can pass and then corrupt the attached Z surface.
          (if (f32.ne (local.get $ztest) (local.get $ztest))
            (then (local.set $draw (i32.const 0)))
            (else
              (if (f32.lt (local.get $ztest) (f32.const 0.0)) (then (local.set $ztest (f32.const 0.0))))
              (if (f32.gt (local.get $ztest) (f32.const 1.0)) (then (local.set $ztest (f32.const 1.0))))
              (if (i32.eq (local.get $zbpp) (i32.const 16))
                (then
                  (local.set $zraw (i32.trunc_sat_f32_u (f32.mul (local.get $ztest) (f32.const 65535.0))))
                  (if (call $d3dim_depth_compare_u
                        (local.get $zraw) (i32.load16_u (local.get $zptr)) (local.get $zfunc))
                    (then (if (local.get $zwrite)
                      (then (i32.store16 (local.get $zptr) (local.get $zraw)))))
                    (else (local.set $draw (i32.const 0)))))
                (else
                  (if (i32.eq (local.get $zbpp) (i32.const 32))
                    (then
                      (local.set $zraw (i32.trunc_sat_f32_u
                        (f32.mul (local.get $ztest) (f32.const 4294967040.0))))
                      (if (call $d3dim_depth_compare_u
                            (local.get $zraw) (i32.load (local.get $zptr)) (local.get $zfunc))
                        (then (if (local.get $zwrite)
                          (then (i32.store (local.get $zptr) (local.get $zraw)))))
                        (else (local.set $draw (i32.const 0)))))))))))
        (else
          (if (i32.and (local.get $draw) (i32.ne (local.get $zbuf_wa) (i32.const 0))) (then
            (local.set $zptr (i32.add (local.get $zbuf_wa)
              (i32.mul (i32.add (i32.mul (local.get $y) (local.get $sw)) (local.get $x)) (i32.const 4))))
            (if (f32.ne (local.get $tz) (local.get $tz))
              (then (local.set $draw (i32.const 0)))
              (else
                (if (call $d3dim_depth_compare_f32
                      (local.get $tz) (f32.load (local.get $zptr)) (local.get $zfunc))
                  (then (if (local.get $zwrite)
                    (then (f32.store (local.get $zptr) (local.get $tz)))))
                  (else (local.set $draw (i32.const 0))))))))))
      (if (local.get $draw) (then
        (local.set $color (call $d3dim_texture_stage_combine
          (local.get $sample)
          (local.get $diffuse) (local.get $colorop) (local.get $alphaop)))
        (if (local.get $blend) (then
          (local.set $ptr (i32.add (local.get $row_wa)
            (i32.mul (local.get $x) (i32.div_u (local.get $bpp) (i32.const 8)))))
          (if (i32.eq (local.get $bpp) (i32.const 32))
            (then (local.set $dst (i32.load (local.get $ptr))))
            (else
              (local.set $px16 (i32.load16_u (local.get $ptr)))
              (local.set $dst (i32.or
                (i32.or
                  (i32.shl (i32.shl (i32.and (i32.shr_u (local.get $px16) (i32.const 11)) (i32.const 31)) (i32.const 3)) (i32.const 16))
                  (i32.shl (i32.shl (i32.and (i32.shr_u (local.get $px16) (i32.const 5)) (i32.const 63)) (i32.const 2)) (i32.const 8)))
                (i32.shl (i32.and (local.get $px16) (i32.const 31)) (i32.const 3))))))
          (local.set $color (call $d3dim_blend_rgb
            (local.get $color) (local.get $dst) (local.get $src_blend) (local.get $dst_blend)))))
        ;; D3DANTIALIAS_SORTDEPENDENT smooths polygon boundaries against the
        ;; colour already in the render target. Interior pixels keep the hot
        ;; opaque path; only the two scanline edge samples need a destination
        ;; read and blend.
        (if (i32.and
              (i32.ne (local.get $antialias) (i32.const 0))
              (i32.or (i32.eq (local.get $x) (local.get $xs))
                      (i32.eq (local.get $x) (local.get $xe))))
          (then
            (local.set $ptr (i32.add (local.get $row_wa)
              (i32.mul (local.get $x) (i32.div_u (local.get $bpp) (i32.const 8)))))
            (if (i32.eq (local.get $bpp) (i32.const 32))
              (then (local.set $dst (i32.load (local.get $ptr))))
              (else (if (i32.eq (local.get $bpp) (i32.const 16))
                (then
                  (local.set $px16 (i32.load16_u (local.get $ptr)))
                  (local.set $dst (i32.or
                    (i32.or
                      (i32.shl (i32.shl (i32.and (i32.shr_u (local.get $px16) (i32.const 11)) (i32.const 31)) (i32.const 3)) (i32.const 16))
                      (i32.shl (i32.shl (i32.and (i32.shr_u (local.get $px16) (i32.const 5)) (i32.const 63)) (i32.const 2)) (i32.const 8)))
                    (i32.shl (i32.and (local.get $px16) (i32.const 31)) (i32.const 3))))))))
            (if (i32.or (i32.eq (local.get $bpp) (i32.const 32))
                        (i32.eq (local.get $bpp) (i32.const 16)))
              (then (local.set $color (call $d3dim_color_lerp
                (local.get $dst) (local.get $color) (f32.const 0.5)))))))
        (if (i32.eq (local.get $bpp) (i32.const 32)) (then
          (i32.store (i32.add (local.get $row_wa) (i32.mul (local.get $x) (i32.const 4))) (local.get $color))))
        (if (i32.eq (local.get $bpp) (i32.const 16)) (then
          (if (local.get $dither)
            (then
              (local.set $px16 (call $d3dim_pack_rgb565
                (local.get $color) (local.get $x) (local.get $y))))
            (else
              (local.set $px16 (i32.or (i32.or
                (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 19)) (i32.const 0x1F)) (i32.const 11))
                (i32.shl (i32.and (i32.shr_u (local.get $color) (i32.const 10)) (i32.const 0x3F)) (i32.const 5)))
                (i32.and (i32.shr_u (local.get $color) (i32.const 3)) (i32.const 0x1F))))))
          (i32.store16 (i32.add (local.get $row_wa) (i32.mul (local.get $x) (i32.const 2))) (local.get $px16))))
        (if (i32.eq (local.get $bpp) (i32.const 8)) (then
          (i32.store8 (i32.add (local.get $row_wa) (local.get $x)) (local.get $color))))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $lp))))

  ;; Fill either a private f32 depth plane or an attached 16/32-bit DirectDraw
  ;; Z surface with `zval`.
  (func $zbuffer_fill (param $zbuf_guest i32) (param $w i32) (param $h i32) (param $zval f32)
    (local $i i32) (local $n i32) (local $wa i32)
    (local $entry i32) (local $dib i32) (local $pitch i32) (local $bpp i32)
    (local $x i32) (local $y i32) (local $raw i32) (local $z f32)
    (if (i32.eqz (local.get $zbuf_guest)) (then (return)))
    (if (i32.and
          (i32.ge_u (local.get $zbuf_guest) (global.get $DX_OBJECTS))
          (i32.lt_u (local.get $zbuf_guest)
            (i32.add (global.get $DX_OBJECTS) (global.get $DX_OBJECTS_SIZE))))
      (then
        (local.set $entry (local.get $zbuf_guest))
        (local.set $dib (i32.load offset=20 (local.get $entry)))
        (local.set $pitch (i32.load16_u offset=18 (local.get $entry)))
        (local.set $bpp (i32.load16_u offset=16 (local.get $entry)))
        (local.set $z (local.get $zval))
        (if (f32.ne (local.get $z) (local.get $z)) (then (local.set $z (f32.const 1.0))))
        (if (f32.lt (local.get $z) (f32.const 0.0)) (then (local.set $z (f32.const 0.0))))
        (if (f32.gt (local.get $z) (f32.const 1.0)) (then (local.set $z (f32.const 1.0))))
        (if (i32.eq (local.get $bpp) (i32.const 16))
          (then (local.set $raw (i32.trunc_sat_f32_u (f32.mul (local.get $z) (f32.const 65535.0)))))
          (else (local.set $raw (i32.trunc_sat_f32_u
            (f32.mul (local.get $z) (f32.const 4294967040.0))))))
        (local.set $y (i32.const 0))
        (block $zdone (loop $zrows
          (br_if $zdone (i32.ge_u (local.get $y) (local.get $h)))
          (local.set $x (i32.const 0))
          (block $xdone (loop $zcols
            (br_if $xdone (i32.ge_u (local.get $x) (local.get $w)))
            (if (i32.eq (local.get $bpp) (i32.const 16))
              (then (i32.store16
                (i32.add (local.get $dib)
                  (i32.add (i32.mul (local.get $y) (local.get $pitch))
                           (i32.shl (local.get $x) (i32.const 1))))
                (local.get $raw)))
              (else (i32.store
                (i32.add (local.get $dib)
                  (i32.add (i32.mul (local.get $y) (local.get $pitch))
                           (i32.shl (local.get $x) (i32.const 2))))
                (local.get $raw))))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $zcols)))
          (local.set $y (i32.add (local.get $y) (i32.const 1)))
          (br $zrows)))
        (return)))
    (local.set $wa (call $g2w (local.get $zbuf_guest)))
    (local.set $n (i32.mul (local.get $w) (local.get $h)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (f32.store (i32.add (local.get $wa) (i32.mul (local.get $i) (i32.const 4))) (local.get $zval))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; Main viewport clear: parse D3DRECT* (or whole viewport rect if NULL),
  ;; clear color and/or z per dwFlags. D3DCLEAR_TARGET=1, ZBUFFER=2, STENCIL=4.
  ;; For Phase 0 we ignore lpRects and clear the device's whole viewport rect
  ;; recorded at state +D3DIM_OFF_VP_RECT.
  (func $d3dim_viewport_clear (param $this i32) (param $dwCount i32) (param $lpRects i32) (param $dwFlags i32)
    (global.set $eax (i32.const 0)))

  ;; Real "Clear2" called from $handle_IDirect3DViewport3_Clear/Clear2 once
  ;; the viewport is associated with a device. For now those handlers in 09a8
  ;; return S_OK without painting; we expose a richer worker for the rasterizer
  ;; to call once Phase 1 lands. Keeping it a no-op-callable stub.
  (func $d3dim_viewport_clear_full
    (param $vp_this i32)
    (param $dwFlags i32) (param $color i32) (param $zval f32)
    (local $rt i32) (local $dev_this i32) (local $vp_entry i32)
    (local $vx i32) (local $vy i32) (local $vw i32) (local $vh i32)
    (local $zbuf i32) (local $rtw i32) (local $rth i32) (local $bgtex i32)
    (if (i32.eqz (local.get $vp_this)) (then (return)))
    (local.set $vp_entry (call $dx_from_this (local.get $vp_this)))
    (if (i32.eqz (local.get $vp_entry)) (then (return)))
    (local.set $dev_this (i32.load (i32.add (local.get $vp_entry) (i32.const 8))))
    (if (i32.eqz (local.get $dev_this)) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $dev_this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $vx (i32.load (i32.add (local.get $vp_entry) (i32.const 12))))
    (local.set $vy (i32.load (i32.add (local.get $vp_entry) (i32.const 16))))
    (local.set $vw (i32.load (i32.add (local.get $vp_entry) (i32.const 20))))
    (local.set $vh (i32.load (i32.add (local.get $vp_entry) (i32.const 24))))
    ;; Fall back to full RT if viewport rect is unset.
    (if (i32.or (i32.eqz (local.get $vw)) (i32.eqz (local.get $vh))) (then
      (local.set $vx (i32.const 0))
      (local.set $vy (i32.const 0))
      (local.set $vw (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
      (local.set $vh (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))))
    (if (i32.and (local.get $dwFlags) (i32.const 1)) (then
      ;; A background material carrying an image wins over its (usually white)
      ;; diffuse. 8bpp targets stay on the colour path -- sampling RGB into a
      ;; palettized surface would need an inverse-palette lookup we don't have.
      (local.set $bgtex (call $d3dim_viewport_background_texture (local.get $vp_this)))
      (if (i32.and (i32.ne (local.get $bgtex) (i32.const 0))
                   (i32.ne (i32.and (i32.load (i32.add (local.get $rt) (i32.const 16)))
                                    (i32.const 0xFFFF))
                           (i32.const 8)))
        (then (call $viewport_fill_rect_texture (local.get $rt) (local.get $vx) (local.get $vy)
                (local.get $vw) (local.get $vh) (local.get $bgtex)))
        (else (call $viewport_fill_rect (local.get $rt) (local.get $vx) (local.get $vy)
                (local.get $vw) (local.get $vh) (local.get $color))))))
    (if (i32.and (local.get $dwFlags) (i32.const 2)) (then
      (local.set $zbuf (call $d3dim_ensure_zbuffer (local.get $dev_this)))
      (local.set $rtw (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
      (local.set $rth (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))
      (call $zbuffer_fill (local.get $zbuf) (local.get $rtw) (local.get $rth) (local.get $zval)))))

  (func $d3dim_device7_clear
    (param $this i32)
    (param $dwFlags i32) (param $color i32) (param $zval f32)
    (local $state i32) (local $sw i32) (local $rt i32)
    (local $vx i32) (local $vy i32) (local $vw i32) (local $vh i32)
    (local $zbuf i32) (local $rtw i32) (local $rth i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $vx (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT))))
    (local.set $vy (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4)))))
    (local.set $vw (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8)))))
    (local.set $vh (i32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12)))))
    ;; Fall back to full RT if the app has not called SetViewport yet.
    (if (i32.or (i32.eqz (local.get $vw)) (i32.eqz (local.get $vh))) (then
      (local.set $vx (i32.const 0))
      (local.set $vy (i32.const 0))
      (local.set $vw (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
      (local.set $vh (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))))
    (if (i32.and (local.get $dwFlags) (i32.const 1)) (then
      (call $viewport_fill_rect (local.get $rt) (local.get $vx) (local.get $vy)
        (local.get $vw) (local.get $vh) (local.get $color))))
    (if (i32.and (local.get $dwFlags) (i32.const 2)) (then
      (local.set $zbuf (call $d3dim_ensure_zbuffer (local.get $this)))
      (local.set $rtw (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
      (local.set $rth (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))
      (call $zbuffer_fill (local.get $zbuf) (local.get $rtw) (local.get $rth) (local.get $zval)))))

  ;; ── Back-face culling ─────────────────────────────────────────
  ;; D3DRENDERSTATE_CULLMODE (rs=22) stored at state+256+22*4 = state+344.
  ;; 0=uninit, 1=NONE, 2=CW, 3=CCW. Treat uninitialized as no cull until
  ;; our transformed winding/clip path is precise enough for the D3D default.
  ;; Screen-space (Y-down) signed cross: >0 → CW on screen, <0 → CCW.
  ;; TLVERTEX are already in screen space, so front-facing = CW = cross>0.
  (func $d3dim_cull_tri (param $this i32)
    (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32) (param $x2 i32) (param $y2 i32)
    (result i32)
    (local $state i32) (local $mode i32) (local $cross i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $mode (call $gl32 (i32.add (local.get $state) (i32.const 344))))
    (if (i32.eqz (local.get $mode)) (then (return (i32.const 0))))
    (if (i32.eq (local.get $mode) (i32.const 1)) (then (return (i32.const 0))))
    (local.set $cross
      (i32.sub
        (i32.mul (i32.sub (local.get $x1) (local.get $x0)) (i32.sub (local.get $y2) (local.get $y0)))
        (i32.mul (i32.sub (local.get $x2) (local.get $x0)) (i32.sub (local.get $y1) (local.get $y0)))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (return (i32.gt_s (local.get $cross) (i32.const 0)))))
    (i32.lt_s (local.get $cross) (i32.const 0)))

  (func $d3dim_draw_tri_culled
    (param $this i32) (param $rt i32) (param $use_z i32) (param $honor_cull i32)
    (param $x0 i32) (param $y0 i32) (param $z0 f32)
    (param $x1 i32) (param $y1 i32) (param $z1 f32)
    (param $x2 i32) (param $y2 i32) (param $z2 f32)
    (param $color i32)
    (local $state i32) (local $zbuf i32) (local $zval f32) (local $alpha i32) (local $blend i32)
    (local $zfunc i32) (local $zwrite i32)
    ;; Direct DrawPrimitive callers rely on culling when they do not use a
    ;; z-buffer: otherwise later back faces overwrite the visible faces.  Keep
    ;; the old no-cull workaround scoped to execute-buffer/D3DRM triangles,
    ;; whose transformed winding still does not have full clip parity.
    (if (local.get $honor_cull) (then
      (if (call $d3dim_cull_tri (local.get $this)
            (local.get $x0) (local.get $y0)
            (local.get $x1) (local.get $y1)
            (local.get $x2) (local.get $y2))
        (then (return)))))
    (if (local.get $use_z) (then
      (local.set $state (call $d3ddev_state (local.get $this)))
      (if (local.get $state) (then
        (if (call $gl32 (i32.add (local.get $state) (i32.const 284))) (then
          (local.set $zbuf (call $d3dim_ensure_zbuffer (local.get $this)))
          (local.set $zfunc (call $gl32 (i32.add (local.get $state) (i32.const 348))))
          (local.set $zwrite (call $gl32 (i32.add (local.get $state) (i32.const 312))))))))))
    (if (i32.eqz (local.get $zfunc)) (then (local.set $zfunc (i32.const 4))))
    ;; ALWAYS with writes disabled is exactly the no-depth path. This is MW3's
    ;; common blended-overlay state and avoiding an attached-Z load/compare on
    ;; every covered pixel is both semantically exact and materially cheaper.
    (if (i32.and
          (i32.eq (local.get $zfunc) (i32.const 8))
          (i32.eqz (local.get $zwrite)))
      (then (local.set $zbuf (i32.const 0))))
    (local.set $alpha (i32.shr_u (local.get $color) (i32.const 24)))
    (if (i32.lt_u (local.get $alpha) (i32.const 255)) (then
      (if (i32.eqz (local.get $state)) (then
        (local.set $state (call $d3ddev_state (local.get $this)))))
      (if (local.get $state) (then
        ;; D3DRENDERSTATE_ALPHABLENDENABLE = 27.
        (if (call $gl32 (i32.add (local.get $state) (i32.const 364))) (then
          (local.set $blend (i32.const 1))))))))
    (local.set $zval
      (f32.div
        (f32.add (f32.add (local.get $z0) (local.get $z1)) (local.get $z2))
        (f32.const 3.0)))
    (call $rasterize_triangle_flat (local.get $rt)
      (local.get $x0) (local.get $y0)
      (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2)
      (local.get $color)
      (local.get $blend)
      (local.get $zbuf) (local.get $zval) (local.get $zfunc) (local.get $zwrite)))

  ;; ============================================================
  ;; PHASE 2 — Flat-shaded triangle rasterizer (TLVERTEX fast path)
  ;; ============================================================
  ;; Rasterize a single triangle with a uniform color. Integer screen coords.
  ;; Uses the "split at middle vertex" scheme: sort y0≤y1≤y2, then for every
  ;; scanline y in [y0..y2] compute left/right x on the two active edges and
  ;; emit one 1-tall fill_rect. Degenerate (zero-area) triangles are skipped.
  (func $rasterize_triangle_flat
    (param $rt_entry i32)
    (param $x0 i32) (param $y0 i32)
    (param $x1 i32) (param $y1 i32)
    (param $x2 i32) (param $y2 i32)
    (param $color i32)
    (param $blend i32)
    (param $zbuf_guest i32) (param $zval f32) (param $zfunc i32) (param $zwrite i32)
    (local $tx i32) (local $ty i32)
    (local $y i32) (local $xa i32) (local $xb i32) (local $xl i32) (local $xr i32)
    (local $dy_tot i32) (local $dy_upper i32) (local $dy_lower i32)
    ;; Sort by y (bubble).
    (if (i32.gt_s (local.get $y0) (local.get $y1)) (then
      (local.set $tx (local.get $x0)) (local.set $ty (local.get $y0))
      (local.set $x0 (local.get $x1)) (local.set $y0 (local.get $y1))
      (local.set $x1 (local.get $tx)) (local.set $y1 (local.get $ty))))
    (if (i32.gt_s (local.get $y1) (local.get $y2)) (then
      (local.set $tx (local.get $x1)) (local.set $ty (local.get $y1))
      (local.set $x1 (local.get $x2)) (local.set $y1 (local.get $y2))
      (local.set $x2 (local.get $tx)) (local.set $y2 (local.get $ty))))
    (if (i32.gt_s (local.get $y0) (local.get $y1)) (then
      (local.set $tx (local.get $x0)) (local.set $ty (local.get $y0))
      (local.set $x0 (local.get $x1)) (local.set $y0 (local.get $y1))
      (local.set $x1 (local.get $tx)) (local.set $y1 (local.get $ty))))
    (local.set $dy_tot   (i32.sub (local.get $y2) (local.get $y0)))
    (local.set $dy_upper (i32.sub (local.get $y1) (local.get $y0)))
    (local.set $dy_lower (i32.sub (local.get $y2) (local.get $y1)))
    (if (i32.le_s (local.get $dy_tot) (i32.const 0)) (then
      ;; Fully-flat triangle: emit a thin horizontal bar on y0 from min(x) to max(x)
      (local.set $xl (local.get $x0))
      (if (i32.lt_s (local.get $x1) (local.get $xl)) (then (local.set $xl (local.get $x1))))
      (if (i32.lt_s (local.get $x2) (local.get $xl)) (then (local.set $xl (local.get $x2))))
      (local.set $xr (local.get $x0))
      (if (i32.gt_s (local.get $x1) (local.get $xr)) (then (local.set $xr (local.get $x1))))
      (if (i32.gt_s (local.get $x2) (local.get $xr)) (then (local.set $xr (local.get $x2))))
      (if (local.get $zbuf_guest)
        (then (call $viewport_fill_rect_z (local.get $rt_entry) (local.get $zbuf_guest)
          (local.get $xl) (local.get $y0)
          (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
          (i32.const 1) (local.get $zval) (local.get $color)
          (local.get $zfunc) (local.get $zwrite)))
        (else
          (if (local.get $blend)
            (then (call $viewport_fill_rect_alpha (local.get $rt_entry)
              (local.get $xl) (local.get $y0)
              (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
              (i32.const 1) (local.get $color)
              (i32.shr_u (local.get $color) (i32.const 24))))
            (else (call $viewport_fill_rect (local.get $rt_entry)
              (local.get $xl) (local.get $y0)
              (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
              (i32.const 1) (local.get $color))))))
      (return)))
    (local.set $y (local.get $y0))
    (block $done (loop $lp
      (br_if $done (i32.gt_s (local.get $y) (local.get $y2)))
      ;; Long edge: x0→x2 parameterized by dy_tot.
      (local.set $xb (i32.add (local.get $x0)
        (i32.div_s (i32.mul (i32.sub (local.get $x2) (local.get $x0))
                            (i32.sub (local.get $y)  (local.get $y0)))
                   (local.get $dy_tot))))
      (if (i32.lt_s (local.get $y) (local.get $y1))
        (then
          (if (i32.gt_s (local.get $dy_upper) (i32.const 0))
            (then (local.set $xa (i32.add (local.get $x0)
              (i32.div_s (i32.mul (i32.sub (local.get $x1) (local.get $x0))
                                  (i32.sub (local.get $y)  (local.get $y0)))
                         (local.get $dy_upper)))))
            (else (local.set $xa (local.get $x0)))))
        (else
          (if (i32.gt_s (local.get $dy_lower) (i32.const 0))
            (then (local.set $xa (i32.add (local.get $x1)
              (i32.div_s (i32.mul (i32.sub (local.get $x2) (local.get $x1))
                                  (i32.sub (local.get $y)  (local.get $y1)))
                         (local.get $dy_lower)))))
            (else (local.set $xa (local.get $x1))))))
      (local.set $xl (local.get $xa))
      (local.set $xr (local.get $xb))
      (if (i32.gt_s (local.get $xl) (local.get $xr)) (then
        (local.set $xl (local.get $xb))
        (local.set $xr (local.get $xa))))
      (if (local.get $zbuf_guest)
        (then (call $viewport_fill_rect_z (local.get $rt_entry) (local.get $zbuf_guest)
          (local.get $xl) (local.get $y)
          (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
          (i32.const 1) (local.get $zval) (local.get $color)
          (local.get $zfunc) (local.get $zwrite)))
        (else
          (if (local.get $blend)
            (then (call $viewport_fill_rect_alpha (local.get $rt_entry)
              (local.get $xl) (local.get $y)
              (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
              (i32.const 1) (local.get $color)
              (i32.shr_u (local.get $color) (i32.const 24))))
            (else (call $viewport_fill_rect (local.get $rt_entry)
              (local.get $xl) (local.get $y)
              (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
              (i32.const 1) (local.get $color))))))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $lp))))

  (func $rasterize_triangle_textured
    (param $rt_entry i32) (param $tex_entry i32)
    (param $blend i32) (param $src_blend i32) (param $dst_blend i32)
    (param $address_u i32) (param $address_v i32) (param $linear i32)
    (param $colorop i32) (param $alphaop i32) (param $color_key_enable i32)
    (param $dither i32) (param $antialias i32)
    (param $x0 i32) (param $y0 i32) (param $u0 f32) (param $v0 f32) (param $q0 f32) (param $c0 i32) (param $z0 f32)
    (param $x1 i32) (param $y1 i32) (param $u1 f32) (param $v1 f32) (param $q1 f32) (param $c1 i32) (param $z1 f32)
    (param $x2 i32) (param $y2 i32) (param $u2 f32) (param $v2 f32) (param $q2 f32) (param $c2 i32) (param $z2 f32)
    (param $zbuf_guest i32) (param $zfunc i32) (param $zwrite i32)
    (local $tx i32) (local $ty i32) (local $tc i32) (local $tu f32) (local $tv f32) (local $tq f32) (local $tz f32)
    (local $y i32) (local $xa i32) (local $xb i32)
    (local $ua f32) (local $va f32) (local $qa f32) (local $za f32)
    (local $ub f32) (local $vb f32) (local $qb f32) (local $zb f32)
    (local $ca i32) (local $cb i32)
    (local $dy_tot i32) (local $dy_upper i32) (local $dy_lower i32) (local $t f32)
    ;; Carry u*rhw, v*rhw, and rhw through the affine edge walker. The span
    ;; divides by interpolated rhw, restoring perspective-correct UVs.
    (if (i32.or (f32.ne (local.get $q0) (local.get $q0))
          (f32.le (f32.abs (local.get $q0)) (f32.const 0.000000000001)))
      (then (local.set $q0 (f32.const 1.0))))
    (if (i32.or (f32.ne (local.get $q1) (local.get $q1))
          (f32.le (f32.abs (local.get $q1)) (f32.const 0.000000000001)))
      (then (local.set $q1 (f32.const 1.0))))
    (if (i32.or (f32.ne (local.get $q2) (local.get $q2))
          (f32.le (f32.abs (local.get $q2)) (f32.const 0.000000000001)))
      (then (local.set $q2 (f32.const 1.0))))
    (local.set $u0 (f32.mul (local.get $u0) (local.get $q0)))
    (local.set $v0 (f32.mul (local.get $v0) (local.get $q0)))
    (local.set $u1 (f32.mul (local.get $u1) (local.get $q1)))
    (local.set $v1 (f32.mul (local.get $v1) (local.get $q1)))
    (local.set $u2 (f32.mul (local.get $u2) (local.get $q2)))
    (local.set $v2 (f32.mul (local.get $v2) (local.get $q2)))
    ;; Sort by y, carrying all attributes with the screen-space vertices.
    (if (i32.gt_s (local.get $y0) (local.get $y1)) (then
      (local.set $tx (local.get $x0)) (local.set $ty (local.get $y0))
      (local.set $tu (local.get $u0)) (local.set $tv (local.get $v0)) (local.set $tq (local.get $q0)) (local.set $tz (local.get $z0)) (local.set $tc (local.get $c0))
      (local.set $x0 (local.get $x1)) (local.set $y0 (local.get $y1))
      (local.set $u0 (local.get $u1)) (local.set $v0 (local.get $v1)) (local.set $q0 (local.get $q1)) (local.set $z0 (local.get $z1)) (local.set $c0 (local.get $c1))
      (local.set $x1 (local.get $tx)) (local.set $y1 (local.get $ty))
      (local.set $u1 (local.get $tu)) (local.set $v1 (local.get $tv)) (local.set $q1 (local.get $tq)) (local.set $z1 (local.get $tz)) (local.set $c1 (local.get $tc))))
    (if (i32.gt_s (local.get $y1) (local.get $y2)) (then
      (local.set $tx (local.get $x1)) (local.set $ty (local.get $y1))
      (local.set $tu (local.get $u1)) (local.set $tv (local.get $v1)) (local.set $tq (local.get $q1)) (local.set $tz (local.get $z1)) (local.set $tc (local.get $c1))
      (local.set $x1 (local.get $x2)) (local.set $y1 (local.get $y2))
      (local.set $u1 (local.get $u2)) (local.set $v1 (local.get $v2)) (local.set $q1 (local.get $q2)) (local.set $z1 (local.get $z2)) (local.set $c1 (local.get $c2))
      (local.set $x2 (local.get $tx)) (local.set $y2 (local.get $ty))
      (local.set $u2 (local.get $tu)) (local.set $v2 (local.get $tv)) (local.set $q2 (local.get $tq)) (local.set $z2 (local.get $tz)) (local.set $c2 (local.get $tc))))
    (if (i32.gt_s (local.get $y0) (local.get $y1)) (then
      (local.set $tx (local.get $x0)) (local.set $ty (local.get $y0))
      (local.set $tu (local.get $u0)) (local.set $tv (local.get $v0)) (local.set $tq (local.get $q0)) (local.set $tz (local.get $z0)) (local.set $tc (local.get $c0))
      (local.set $x0 (local.get $x1)) (local.set $y0 (local.get $y1))
      (local.set $u0 (local.get $u1)) (local.set $v0 (local.get $v1)) (local.set $q0 (local.get $q1)) (local.set $z0 (local.get $z1)) (local.set $c0 (local.get $c1))
      (local.set $x1 (local.get $tx)) (local.set $y1 (local.get $ty))
      (local.set $u1 (local.get $tu)) (local.set $v1 (local.get $tv)) (local.set $q1 (local.get $tq)) (local.set $z1 (local.get $tz)) (local.set $c1 (local.get $tc))))
    (local.set $dy_tot   (i32.sub (local.get $y2) (local.get $y0)))
    (local.set $dy_upper (i32.sub (local.get $y1) (local.get $y0)))
    (local.set $dy_lower (i32.sub (local.get $y2) (local.get $y1)))
    (if (i32.le_s (local.get $dy_tot) (i32.const 0)) (then
      (call $viewport_draw_textured_span
        (local.get $rt_entry) (local.get $tex_entry)
        (local.get $blend) (local.get $src_blend) (local.get $dst_blend)
        (local.get $address_u) (local.get $address_v) (local.get $linear) (local.get $colorop) (local.get $alphaop)
        (local.get $color_key_enable)
        (local.get $dither) (local.get $antialias)
        (local.get $y0)
        (local.get $x0) (local.get $u0) (local.get $v0) (local.get $q0) (local.get $c0) (local.get $z0)
        (local.get $x1) (local.get $u1) (local.get $v1) (local.get $q1) (local.get $c1) (local.get $z1)
        (local.get $zbuf_guest) (local.get $zfunc) (local.get $zwrite))
      (call $viewport_draw_textured_span
        (local.get $rt_entry) (local.get $tex_entry)
        (local.get $blend) (local.get $src_blend) (local.get $dst_blend)
        (local.get $address_u) (local.get $address_v) (local.get $linear) (local.get $colorop) (local.get $alphaop)
        (local.get $color_key_enable)
        (local.get $dither) (local.get $antialias)
        (local.get $y0)
        (local.get $x1) (local.get $u1) (local.get $v1) (local.get $q1) (local.get $c1) (local.get $z1)
        (local.get $x2) (local.get $u2) (local.get $v2) (local.get $q2) (local.get $c2) (local.get $z2)
        (local.get $zbuf_guest) (local.get $zfunc) (local.get $zwrite))
      (return)))
    (local.set $y (local.get $y0))
    (block $done (loop $lp
      (br_if $done (i32.gt_s (local.get $y) (local.get $y2)))
      (local.set $t (f32.div
        (f32.convert_i32_s (i32.sub (local.get $y) (local.get $y0)))
        (f32.convert_i32_s (local.get $dy_tot))))
      (local.set $xb (call $d3dim_coord_i (f32.add
        (f32.convert_i32_s (local.get $x0))
        (f32.mul (f32.convert_i32_s (i32.sub (local.get $x2) (local.get $x0))) (local.get $t)))))
      (local.set $ub (f32.add (local.get $u0) (f32.mul (f32.sub (local.get $u2) (local.get $u0)) (local.get $t))))
      (local.set $vb (f32.add (local.get $v0) (f32.mul (f32.sub (local.get $v2) (local.get $v0)) (local.get $t))))
      (local.set $qb (f32.add (local.get $q0) (f32.mul (f32.sub (local.get $q2) (local.get $q0)) (local.get $t))))
      (local.set $zb (f32.add (local.get $z0) (f32.mul (f32.sub (local.get $z2) (local.get $z0)) (local.get $t))))
      (local.set $cb (call $d3dim_color_lerp (local.get $c0) (local.get $c2) (local.get $t)))
      (if (i32.lt_s (local.get $y) (local.get $y1))
        (then
          (if (i32.gt_s (local.get $dy_upper) (i32.const 0))
            (then
              (local.set $t (f32.div
                (f32.convert_i32_s (i32.sub (local.get $y) (local.get $y0)))
                (f32.convert_i32_s (local.get $dy_upper))))
              (local.set $xa (call $d3dim_coord_i (f32.add
                (f32.convert_i32_s (local.get $x0))
                (f32.mul (f32.convert_i32_s (i32.sub (local.get $x1) (local.get $x0))) (local.get $t)))))
              (local.set $ua (f32.add (local.get $u0) (f32.mul (f32.sub (local.get $u1) (local.get $u0)) (local.get $t))))
              (local.set $va (f32.add (local.get $v0) (f32.mul (f32.sub (local.get $v1) (local.get $v0)) (local.get $t))))
              (local.set $qa (f32.add (local.get $q0) (f32.mul (f32.sub (local.get $q1) (local.get $q0)) (local.get $t))))
              (local.set $za (f32.add (local.get $z0) (f32.mul (f32.sub (local.get $z1) (local.get $z0)) (local.get $t))))
              (local.set $ca (call $d3dim_color_lerp (local.get $c0) (local.get $c1) (local.get $t))))
            (else
              (local.set $xa (local.get $x0))
              (local.set $ua (local.get $u0))
              (local.set $va (local.get $v0))
              (local.set $qa (local.get $q0))
              (local.set $za (local.get $z0))
              (local.set $ca (local.get $c0)))))
        (else
          (if (i32.gt_s (local.get $dy_lower) (i32.const 0))
            (then
              (local.set $t (f32.div
                (f32.convert_i32_s (i32.sub (local.get $y) (local.get $y1)))
                (f32.convert_i32_s (local.get $dy_lower))))
              (local.set $xa (call $d3dim_coord_i (f32.add
                (f32.convert_i32_s (local.get $x1))
                (f32.mul (f32.convert_i32_s (i32.sub (local.get $x2) (local.get $x1))) (local.get $t)))))
              (local.set $ua (f32.add (local.get $u1) (f32.mul (f32.sub (local.get $u2) (local.get $u1)) (local.get $t))))
              (local.set $va (f32.add (local.get $v1) (f32.mul (f32.sub (local.get $v2) (local.get $v1)) (local.get $t))))
              (local.set $qa (f32.add (local.get $q1) (f32.mul (f32.sub (local.get $q2) (local.get $q1)) (local.get $t))))
              (local.set $za (f32.add (local.get $z1) (f32.mul (f32.sub (local.get $z2) (local.get $z1)) (local.get $t))))
              (local.set $ca (call $d3dim_color_lerp (local.get $c1) (local.get $c2) (local.get $t))))
            (else
              (local.set $xa (local.get $x1))
              (local.set $ua (local.get $u1))
              (local.set $va (local.get $v1))
              (local.set $qa (local.get $q1))
              (local.set $za (local.get $z1))
              (local.set $ca (local.get $c1))))))
      (call $viewport_draw_textured_span
        (local.get $rt_entry) (local.get $tex_entry)
        (local.get $blend) (local.get $src_blend) (local.get $dst_blend)
        (local.get $address_u) (local.get $address_v) (local.get $linear) (local.get $colorop) (local.get $alphaop)
        (local.get $color_key_enable)
        (local.get $dither) (local.get $antialias)
        (local.get $y)
        (local.get $xa) (local.get $ua) (local.get $va) (local.get $qa) (local.get $ca) (local.get $za)
        (local.get $xb) (local.get $ub) (local.get $vb) (local.get $qb) (local.get $cb) (local.get $zb)
        (local.get $zbuf_guest) (local.get $zfunc) (local.get $zwrite))
      (local.set $y (i32.add (local.get $y) (i32.const 1)))
      (br $lp))))

  ;; ── DrawPrimitive core (TLVERTEX) ──────────────────────────────
  ;; TLVERTEX layout (32 bytes): +0 sx f32, +4 sy f32, +8 sz f32, +12 rhw f32,
  ;;                             +16 color 0xAARRGGBB, +20 spec, +24 tu, +28 tv.
  ;; primType: 1=POINTLIST, 2=LINELIST, 3=LINESTRIP, 4=TRIANGLELIST,
  ;;           5=TRIANGLESTRIP, 6=TRIANGLEFAN.
  ;; vtxType:  1=VERTEX, 2=LVERTEX, 3=TLVERTEX.
  ;; Phase 2 supports only vtxType=TLVERTEX. Points still plot as 2×2 dots.
  (func $d3dim_draw_primitive
    (param $this i32) (param $primType i32) (param $vtxType i32)
    (param $lpvVertices i32) (param $dwVertexCount i32)
    (local $rt i32) (local $v_wa i32) (local $i i32) (local $n i32)
    (local $v0 i32) (local $v1 i32) (local $v2 i32)
    (local $x0 i32) (local $y0 i32) (local $x1 i32) (local $y1 i32) (local $x2 i32) (local $y2 i32)
    (local $col i32) (local $state_guest i32) (local $scratch_g i32) (local $scratch_wa i32) (local $src_wa i32)
    (local $size i32) (local $src_stride i32) (local $scratch_tl i32)
    (if (i32.or (i32.eqz (local.get $lpvVertices)) (i32.eqz (local.get $dwVertexCount)))
      (then (return)))
    (if (i32.or (i32.lt_u (local.get $vtxType) (i32.const 1))
                (i32.gt_u (local.get $vtxType) (i32.const 3)))
      (then (return)))
    (if (i32.ne (local.get $vtxType) (i32.const 3))
      (then
        (local.set $state_guest (call $d3ddev_state (local.get $this)))
        (if (i32.eqz (local.get $state_guest)) (then (return)))
        (local.set $size (i32.mul (local.get $dwVertexCount) (i32.const 32)))
        (if (i32.or (i32.eqz (local.get $size)) (i32.gt_u (local.get $size) (i32.const 0x400000)))
          (then (return)))
        (local.set $scratch_g (call $heap_alloc (local.get $size)))
        (if (i32.eqz (local.get $scratch_g)) (then (return)))
        (call $d3ddev_composite_wvp (local.get $state_guest))
        (call $d3dim_lights_refresh (local.get $state_guest))
        (local.set $src_stride (call $d3dim_vertex_type_stride (local.get $vtxType)))
        (local.set $src_wa (call $g2w (local.get $lpvVertices)))
        (local.set $scratch_wa (call $g2w (local.get $scratch_g)))
        (local.set $i (i32.const 0))
        (block $pdone (loop $plp
          (br_if $pdone (i32.ge_u (local.get $i) (local.get $dwVertexCount)))
          (call $d3dim_prepare_draw_vertex
            (local.get $state_guest)
            (local.get $vtxType)
            (i32.add (local.get $src_wa) (i32.mul (local.get $i) (local.get $src_stride)))
            (i32.add (local.get $scratch_wa) (i32.mul (local.get $i) (i32.const 32))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $plp)))
        (call $d3dim_draw_primitive
          (local.get $this) (local.get $primType) (i32.const 3)
          (local.get $scratch_g) (local.get $dwVertexCount))
        (call $heap_free (local.get $scratch_g))
        (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $v_wa (call $g2w (local.get $lpvVertices)))
    ;; kind=17 DPBlend: v0 diffuse + the blend state in force. A full-screen
    ;; quad drawn with no texture looks identical in the API trace whether it is
    ;; an opaque fill or a translucent overlay we painted opaque -- only the
    ;; vertex alpha and SRCBLEND/DESTBLEND separate the two, and the JS tracer
    ;; cannot read a VirtualAlloc'd vertex pointer to find them.
    (local.set $state_guest (call $d3ddev_state (local.get $this)))
    ;; Near-plane clip scratch for the line paths. t0/t1/t2 in the state block
    ;; belong to the indexed helpers, which never run on this path.
    (if (local.get $state_guest) (then
      (local.set $scratch_tl (i32.add (call $g2w (local.get $state_guest)) (i32.const 3200)))))
    (if (local.get $state_guest)
      (then
        (call $host_dx_trace (i32.const 17) (local.get $primType)
          (i32.load (i32.add (local.get $v_wa) (i32.const 16)))
          (call $gl32 (i32.add (local.get $state_guest) (i32.const 364)))
          (i32.or (call $gl32 (i32.add (local.get $state_guest) (i32.const 332)))
                  (i32.shl (call $gl32 (i32.add (local.get $state_guest) (i32.const 336)))
                           (i32.const 16))))
        ;; kind=18 DPVtx: one line per vertex for small batches. A full-screen
        ;; quad and a degenerate off-screen one are the same four trace numbers
        ;; until the actual screen coords are visible.
        (if (i32.le_u (local.get $dwVertexCount) (i32.const 8))
          (then
            (local.set $i (i32.const 0))
            (block $vdone (loop $vlp
              (br_if $vdone (i32.ge_u (local.get $i) (local.get $dwVertexCount)))
              (call $host_dx_trace (i32.const 18) (local.get $i)
                (i32.load (i32.add (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))) (i32.const 0)))
                (i32.load (i32.add (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))) (i32.const 4)))
                (i32.load (i32.add (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))) (i32.const 16))))
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br $vlp)))))))
    (if (i32.eq (local.get $primType) (i32.const 1)) (then
      ;; POINTLIST — keep prior dot-plot behavior
      (local.set $i (i32.const 0))
      (block $pdone (loop $plp
        (br_if $pdone (i32.ge_u (local.get $i) (local.get $dwVertexCount)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))))
        (call $viewport_fill_rect (local.get $rt)
          (call $d3dim_coord_i (f32.load (local.get $v0)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (i32.const 2) (i32.const 2)
          (i32.load (i32.add (local.get $v0) (i32.const 16))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $plp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 2)) (then
      ;; LINELIST — disjoint vertex pairs
      (local.set $n (i32.div_u (local.get $dwVertexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (block $lldone (loop $lllp
        (br_if $lldone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (i32.mul (local.get $i) (i32.const 2)) (i32.const 32))))
        (call $d3dim_draw_tl_line (local.get $rt) (local.get $v0) (i32.add (local.get $v0) (i32.const 32)) (local.get $scratch_tl))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lllp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 3)) (then
      ;; LINESTRIP — every consecutive vertex pair
      (if (i32.lt_u (local.get $dwVertexCount) (i32.const 2)) (then (return)))
      (local.set $n (i32.sub (local.get $dwVertexCount) (i32.const 1)))
      (local.set $i (i32.const 0))
      (block $lsdone (loop $lslp
        (br_if $lsdone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))))
        (call $d3dim_draw_tl_line (local.get $rt) (local.get $v0) (i32.add (local.get $v0) (i32.const 32)) (local.get $scratch_tl))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lslp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 4)) (then
      ;; TRIANGLELIST
      (local.set $n (i32.div_u (local.get $dwVertexCount) (i32.const 3)))
      (local.set $i (i32.const 0))
      (block $tdone (loop $tlp
        (br_if $tdone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (i32.mul (local.get $i) (i32.const 3)) (i32.const 32))))
        (local.set $v1 (i32.add (local.get $v0) (i32.const 32)))
        (local.set $v2 (i32.add (local.get $v0) (i32.const 64)))
        (call $d3dim_draw_tl_triangle_dp (local.get $this) (local.get $rt) (i32.const 1)
          (local.get $v0) (local.get $v1) (local.get $v2))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $tlp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 5)) (then
      ;; TRIANGLESTRIP: indices (0,1,2),(1,2,3)…  (alternating winding ignored — flat fill)
      (if (i32.lt_u (local.get $dwVertexCount) (i32.const 3)) (then (return)))
      (local.set $n (i32.sub (local.get $dwVertexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (block $sdone (loop $slp
        (br_if $sdone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))))
        (local.set $v1 (i32.add (local.get $v0) (i32.const 32)))
        (local.set $v2 (i32.add (local.get $v0) (i32.const 64)))
        ;; Odd i in a strip has inverted winding — swap v0/v1 so the cull test
        ;; sees a consistent front/back sign.
        (if (i32.and (local.get $i) (i32.const 1))
          (then
            (call $d3dim_draw_tl_triangle_dp (local.get $this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $v0) (local.get $v2)))
          (else
            (call $d3dim_draw_tl_triangle_dp (local.get $this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $v1) (local.get $v2))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $slp)))
      (return)))
    (if (i32.and
           (i32.ne (local.get $primType) (i32.const 6))
           (i32.and
             (i32.ne (local.get $primType) (i32.const 5))
             (i32.ne (local.get $primType) (i32.const 4))))
      (then
        (if (i32.ne (local.get $primType) (i32.const 1))
          (then (call $crash_unimplemented (global.get $D3DIM_UNIMPL_DRAW))))))
    (if (i32.eq (local.get $primType) (i32.const 6)) (then
      ;; TRIANGLEFAN: (0,1,2),(0,2,3)…
      (if (i32.lt_u (local.get $dwVertexCount) (i32.const 3)) (then (return)))
      (local.set $n (i32.sub (local.get $dwVertexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (local.set $v0 (local.get $v_wa))
      (block $fdone (loop $flp
        (br_if $fdone (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $v1 (i32.add (local.get $v_wa) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 32))))
        (local.set $v2 (i32.add (local.get $v1) (i32.const 32)))
        (call $d3dim_draw_tl_triangle_dp (local.get $this) (local.get $rt) (i32.const 1)
          (local.get $v0) (local.get $v1) (local.get $v2))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $flp))))) )

  ;; ── DrawIndexedPrimitive core (fixed-pipeline vertex transform) ─
  ;; Legacy DrawIndexedPrimitive commonly feeds D3DVERTEX/LVERTEX arrays and
  ;; relies on the device transforms instead of prebuilt TLVERTEX data.
  (func $d3dim_prepare_draw_vertex
    (param $state_guest i32) (param $vtxType i32) (param $src_wa i32) (param $dst_wa i32)
    (local $color i32) (local $spec i32) (local $tu i32) (local $tv i32)
    (if (i32.eq (local.get $vtxType) (i32.const 3)) (then
      (call $memcpy (local.get $dst_wa) (local.get $src_wa) (i32.const 32))
      (return)))
    (if (i32.eq (local.get $vtxType) (i32.const 2))
      (then
        (local.set $color (i32.load (i32.add (local.get $src_wa) (i32.const 16))))
        (local.set $spec  (i32.load (i32.add (local.get $src_wa) (i32.const 20))))
        (local.set $tu    (i32.load (i32.add (local.get $src_wa) (i32.const 24))))
        (local.set $tv    (i32.load (i32.add (local.get $src_wa) (i32.const 28)))))
      (else
        (local.set $color (call $d3dim_vertex_lit_color (local.get $state_guest) (local.get $src_wa)))
        (local.set $spec  (i32.const 0))
        (local.set $tu    (i32.load (i32.add (local.get $src_wa) (i32.const 24))))
        (local.set $tv    (i32.load (i32.add (local.get $src_wa) (i32.const 28))))))
    (call $vertex_project (local.get $state_guest) (local.get $src_wa) (local.get $dst_wa))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 16)) (local.get $color))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 20)) (local.get $spec))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 24)) (local.get $tu))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 28)) (local.get $tv)))

  (func $d3dim_prepare_indexed_vertex
    (param $state_guest i32) (param $vbase_wa i32) (param $ibase_wa i32)
    (param $dwVertexCount i32) (param $vtxType i32) (param $idx_pos i32) (param $dst_wa i32)
    (result i32)
    (local $idx i32) (local $src i32) (local $src_stride i32)
    (local.set $idx
      (i32.load16_u (i32.add (local.get $ibase_wa) (i32.mul (local.get $idx_pos) (i32.const 2)))))
    (if (i32.ge_u (local.get $idx) (local.get $dwVertexCount)) (then (return (i32.const 0))))
    (local.set $src_stride (call $d3dim_vertex_type_stride (local.get $vtxType)))
    (local.set $src (i32.add (local.get $vbase_wa) (i32.mul (local.get $idx) (local.get $src_stride))))
    (call $d3dim_prepare_draw_vertex
      (local.get $state_guest) (local.get $vtxType) (local.get $src) (local.get $dst_wa))
    (i32.const 1))

  (func $d3dim_draw_indexed_triangle
    (param $this i32) (param $rt i32) (param $state_guest i32)
    (param $vbase_wa i32) (param $ibase_wa i32)
    (param $dwVertexCount i32) (param $vtxType i32)
    (param $idx0 i32) (param $idx1 i32) (param $idx2 i32)
    (local $sw i32) (local $t0 i32) (local $t1 i32) (local $t2 i32)
    (local.set $sw (call $g2w (local.get $state_guest)))
    (local.set $t0 (i32.add (local.get $sw) (i32.const 3200)))
    (local.set $t1 (i32.add (local.get $sw) (i32.const 3232)))
    (local.set $t2 (i32.add (local.get $sw) (i32.const 3264)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx0) (local.get $t0)))
      (then (return)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx1) (local.get $t1)))
      (then (return)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx2) (local.get $t2)))
      (then (return)))
    ;; Indexed and unindexed triangles share the same terminal decision.  The
    ;; prepared TL vertices still need ordinary culling, but when stage 0 has a
    ;; live DirectDraw texture the rasterizer must consume their tu/tv fields.
    ;; Calling $d3dim_draw_tri_culled directly here discarded the binding and
    ;; flattened MW3's entire world to vertex diffuse colours.
    (call $d3dim_draw_tl_triangle_dp
      (local.get $this) (local.get $rt) (i32.const 1)
      (local.get $t0) (local.get $t1) (local.get $t2)))

  ;; ── Line and point primitives ─────────────────────────────────
  ;; D3DPT_LINELIST(2) and D3DPT_LINESTRIP(3) were never rasterized:
  ;; $d3dim_draw_primitive implemented POINTLIST and the three triangle types,
  ;; $d3dim_draw_indexed_primitive only the triangles, and every other primType
  ;; fell out the bottom of the if-chain having drawn nothing. The DX SDK
  ;; boids.exe draws its entire flock as indexed LINESTRIPs, so all ~7500 of its
  ;; draw calls per run were discarded and the frame stayed at the viewport
  ;; clear colour — a primary reading nonZero=1850/1850 but colors=1.
  ;;
  ;; Cohen-Sutherland clip to the render target, then Bresenham one pixel at a
  ;; time through $viewport_fill_rect so clipping, pitch and the 32/16/8bpp
  ;; store stay in exactly one place. Clipping first is what bounds the walk:
  ;; $d3dim_coord_i clamps to +/-1e6, and an off-screen segment between two such
  ;; extremes would otherwise step two million times to plot nothing. The
  ;; parametric intersections go through i64 because that same clamp makes the
  ;; (dx * dy) products overflow i32.
  (func $d3dim_line_i (param $rt i32) (param $x0 i32) (param $y0 i32)
        (param $x1 i32) (param $y1 i32) (param $color i32)
    (local $sw i32) (local $sh i32) (local $xmax i32) (local $ymax i32)
    (local $oc0 i32) (local $oc1 i32) (local $oc i32)
    (local $cx i32) (local $cy i32) (local $rounds i32)
    (local $dx i32) (local $dy i32) (local $sx i32) (local $sy i32)
    (local $err i32) (local $e2 i32)
    (local.set $sw (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $sh (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $sw)) (i32.eqz (local.get $sh))) (then (return)))
    (local.set $xmax (i32.sub (local.get $sw) (i32.const 1)))
    (local.set $ymax (i32.sub (local.get $sh) (i32.const 1)))
    ;; Clip. Each round moves one endpoint onto one edge, so four rounds is the
    ;; exact worst case; the counter is a belt-and-braces stop, not a policy.
    (local.set $rounds (i32.const 0))
    (block $clipped (loop $cliplp
      (local.set $oc0 (call $d3dim_line_outcode
        (local.get $x0) (local.get $y0) (local.get $xmax) (local.get $ymax)))
      (local.set $oc1 (call $d3dim_line_outcode
        (local.get $x1) (local.get $y1) (local.get $xmax) (local.get $ymax)))
      (br_if $clipped (i32.eqz (i32.or (local.get $oc0) (local.get $oc1))))
      ;; Both endpoints outside the same edge: the segment cannot cross the RT.
      (if (i32.and (local.get $oc0) (local.get $oc1)) (then (return)))
      (if (i32.ge_u (local.get $rounds) (i32.const 4)) (then (return)))
      (local.set $rounds (i32.add (local.get $rounds) (i32.const 1)))
      (local.set $oc (select (local.get $oc0) (local.get $oc1) (local.get $oc0)))
      (if (i32.and (local.get $oc) (i32.const 8))
        (then ;; below ymax
          (if (i32.eq (local.get $y1) (local.get $y0)) (then (return)))
          (local.set $cx (i32.add (local.get $x0) (i32.wrap_i64 (i64.div_s
            (i64.mul (i64.extend_i32_s (i32.sub (local.get $x1) (local.get $x0)))
                     (i64.extend_i32_s (i32.sub (local.get $ymax) (local.get $y0))))
            (i64.extend_i32_s (i32.sub (local.get $y1) (local.get $y0)))))))
          (local.set $cy (local.get $ymax)))
        (else (if (i32.and (local.get $oc) (i32.const 4))
          (then ;; above 0
            (if (i32.eq (local.get $y1) (local.get $y0)) (then (return)))
            (local.set $cx (i32.add (local.get $x0) (i32.wrap_i64 (i64.div_s
              (i64.mul (i64.extend_i32_s (i32.sub (local.get $x1) (local.get $x0)))
                       (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $y0))))
              (i64.extend_i32_s (i32.sub (local.get $y1) (local.get $y0)))))))
            (local.set $cy (i32.const 0)))
          (else (if (i32.and (local.get $oc) (i32.const 2))
            (then ;; right of xmax
              (if (i32.eq (local.get $x1) (local.get $x0)) (then (return)))
              (local.set $cy (i32.add (local.get $y0) (i32.wrap_i64 (i64.div_s
                (i64.mul (i64.extend_i32_s (i32.sub (local.get $y1) (local.get $y0)))
                         (i64.extend_i32_s (i32.sub (local.get $xmax) (local.get $x0))))
                (i64.extend_i32_s (i32.sub (local.get $x1) (local.get $x0)))))))
              (local.set $cx (local.get $xmax)))
            (else ;; left of 0
              (if (i32.eq (local.get $x1) (local.get $x0)) (then (return)))
              (local.set $cy (i32.add (local.get $y0) (i32.wrap_i64 (i64.div_s
                (i64.mul (i64.extend_i32_s (i32.sub (local.get $y1) (local.get $y0)))
                         (i64.extend_i32_s (i32.sub (i32.const 0) (local.get $x0))))
                (i64.extend_i32_s (i32.sub (local.get $x1) (local.get $x0)))))))
              (local.set $cx (i32.const 0))))))))
      (if (local.get $oc0)
        (then (local.set $x0 (local.get $cx)) (local.set $y0 (local.get $cy)))
        (else (local.set $x1 (local.get $cx)) (local.set $y1 (local.get $cy))))
      (br $cliplp)))
    ;; Bresenham over the clipped segment.
    (local.set $dx (i32.sub (local.get $x1) (local.get $x0)))
    (if (i32.lt_s (local.get $dx) (i32.const 0))
      (then (local.set $dx (i32.sub (i32.const 0) (local.get $dx))) (local.set $sx (i32.const -1)))
      (else (local.set $sx (i32.const 1))))
    (local.set $dy (i32.sub (local.get $y1) (local.get $y0)))
    (if (i32.lt_s (local.get $dy) (i32.const 0))
      (then (local.set $sy (i32.const -1)))
      (else (local.set $dy (i32.sub (i32.const 0) (local.get $dy))) (local.set $sy (i32.const 1))))
    (local.set $err (i32.add (local.get $dx) (local.get $dy)))
    (block $done (loop $lp
      (call $viewport_fill_rect (local.get $rt)
        (local.get $x0) (local.get $y0) (i32.const 1) (i32.const 1) (local.get $color))
      (br_if $done (i32.and (i32.eq (local.get $x0) (local.get $x1))
                            (i32.eq (local.get $y0) (local.get $y1))))
      (local.set $e2 (i32.shl (local.get $err) (i32.const 1)))
      (if (i32.ge_s (local.get $e2) (local.get $dy)) (then
        (local.set $err (i32.add (local.get $err) (local.get $dy)))
        (local.set $x0 (i32.add (local.get $x0) (local.get $sx)))))
      (if (i32.le_s (local.get $e2) (local.get $dx)) (then
        (local.set $err (i32.add (local.get $err) (local.get $dx)))
        (local.set $y0 (i32.add (local.get $y0) (local.get $sy)))))
      (br $lp))))

  ;; bit0 left of 0, bit1 right of xmax, bit2 above 0, bit3 below ymax
  (func $d3dim_line_outcode (param $x i32) (param $y i32) (param $xmax i32) (param $ymax i32)
    (result i32)
    (i32.or
      (i32.or (select (i32.const 1) (i32.const 0) (i32.lt_s (local.get $x) (i32.const 0)))
              (select (i32.const 2) (i32.const 0) (i32.gt_s (local.get $x) (local.get $xmax))))
      (i32.or (select (i32.const 4) (i32.const 0) (i32.lt_s (local.get $y) (i32.const 0)))
              (select (i32.const 8) (i32.const 0) (i32.gt_s (local.get $y) (local.get $ymax))))))

  ;; Two TL vertices -> one screen-space line. Flat-shaded from v0's diffuse,
  ;; matching what the triangle path does with its own first vertex.
  ;;
  ;; Near-plane clip first, exactly as $d3dim_clip_tl_triangle does for its
  ;; three edges: rhw is 1/w, and a vertex at or behind the eye plane projects
  ;; to a screen coordinate with no bearing on where the segment actually goes.
  ;; Drawing those raw turns boids' flock into red and blue streaks across the
  ;; whole 640x480 frame, because a clipped-but-nonsense endpoint is still a
  ;; perfectly drawable line. $scratch is a 32-byte TL vertex slot, or 0 when
  ;; the caller has none — with no slot the only safe move is to drop the line.
  (func $d3dim_draw_tl_line (param $rt i32) (param $va i32) (param $vb i32) (param $scratch i32)
    (local $pa i32) (local $pb i32)
    (local.set $pa (f32.gt (f32.load (i32.add (local.get $va) (i32.const 12))) (f32.const 0.0)))
    (local.set $pb (f32.gt (f32.load (i32.add (local.get $vb) (i32.const 12))) (f32.const 0.0)))
    (if (i32.eqz (i32.or (local.get $pa) (local.get $pb))) (then (return)))
    (if (i32.eqz (i32.and (local.get $pa) (local.get $pb)))
      (then
        (if (i32.eqz (local.get $scratch)) (then (return)))
        ;; Interpolate the off-plane endpoint back onto the near plane. The
        ;; helper takes (kept, dropped, out) and walks the edge from the kept
        ;; vertex, so the argument order carries which of the two survived.
        (if (local.get $pa)
          (then
            (call $d3dim_interp_tl_vertex (local.get $va) (local.get $vb) (local.get $scratch))
            (local.set $vb (local.get $scratch)))
          (else
            (call $d3dim_interp_tl_vertex (local.get $vb) (local.get $va) (local.get $scratch))
            (local.set $va (local.get $scratch))))))
    (call $d3dim_line_i (local.get $rt)
      (call $d3dim_coord_i (f32.load (local.get $va)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $va) (i32.const 4))))
      (call $d3dim_coord_i (f32.load (local.get $vb)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $vb) (i32.const 4))))
      (i32.load (i32.add (local.get $va) (i32.const 16)))))

  (func $d3dim_draw_indexed_line
    (param $this i32) (param $rt i32) (param $state_guest i32)
    (param $vbase_wa i32) (param $ibase_wa i32)
    (param $dwVertexCount i32) (param $vtxType i32)
    (param $idx0 i32) (param $idx1 i32)
    (local $sw i32) (local $t0 i32) (local $t1 i32)
    (local.set $sw (call $g2w (local.get $state_guest)))
    (local.set $t0 (i32.add (local.get $sw) (i32.const 3200)))
    (local.set $t1 (i32.add (local.get $sw) (i32.const 3232)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx0) (local.get $t0)))
      (then (return)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx1) (local.get $t1)))
      (then (return)))
    (call $d3dim_draw_tl_line (local.get $rt) (local.get $t0) (local.get $t1)
      (i32.add (local.get $sw) (i32.const 3264))))

  ;; Indexed POINTLIST, matching the 2x2 dot the unindexed path plots.
  (func $d3dim_draw_indexed_point
    (param $this i32) (param $rt i32) (param $state_guest i32)
    (param $vbase_wa i32) (param $ibase_wa i32)
    (param $dwVertexCount i32) (param $vtxType i32) (param $idx0 i32)
    (local $t0 i32)
    (local.set $t0 (i32.add (call $g2w (local.get $state_guest)) (i32.const 3200)))
    (if (i32.eqz (call $d3dim_prepare_indexed_vertex
          (local.get $state_guest) (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $idx0) (local.get $t0)))
      (then (return)))
    (call $viewport_fill_rect (local.get $rt)
      (call $d3dim_coord_i (f32.load (local.get $t0)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $t0) (i32.const 4))))
      (i32.const 2) (i32.const 2)
      (i32.load (i32.add (local.get $t0) (i32.const 16)))))

  (func $d3dim_draw_indexed_primitive
    (param $this i32) (param $primType i32) (param $vtxType i32)
    (param $lpvVertices i32) (param $dwVertexCount i32)
    (param $lpwIndices i32) (param $dwIndexCount i32)
    (local $rt i32) (local $state_guest i32) (local $vbase_wa i32) (local $ibase_wa i32)
    (local $i i32) (local $n i32)
    (if (i32.or
          (i32.or (i32.eqz (local.get $lpvVertices)) (i32.eqz (local.get $dwVertexCount)))
          (i32.or (i32.eqz (local.get $lpwIndices)) (i32.eqz (local.get $dwIndexCount))))
      (then (return)))
    (if (i32.or (i32.lt_u (local.get $vtxType) (i32.const 1))
                (i32.gt_u (local.get $vtxType) (i32.const 3)))
      (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this)))
    (local.set $state_guest (call $d3ddev_state (local.get $this)))
    (if (i32.or (i32.eqz (local.get $rt)) (i32.eqz (local.get $state_guest))) (then (return)))
    (call $d3ddev_composite_wvp (local.get $state_guest))
    (call $d3dim_lights_refresh (local.get $state_guest))
    (local.set $vbase_wa (call $g2w (local.get $lpvVertices)))
    (local.set $ibase_wa (call $g2w (local.get $lpwIndices)))
    (if (i32.eq (local.get $primType) (i32.const 1)) (then
      ;; POINTLIST
      (local.set $i (i32.const 0))
      (block $ipdone (loop $iplp
        (br_if $ipdone (i32.ge_u (local.get $i) (local.get $dwIndexCount)))
        (call $d3dim_draw_indexed_point
          (local.get $this) (local.get $rt) (local.get $state_guest)
          (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType) (local.get $i))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $iplp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 2)) (then
      ;; LINELIST — disjoint index pairs
      (local.set $n (i32.div_u (local.get $dwIndexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (block $ildone (loop $illp
        (br_if $ildone (i32.ge_u (local.get $i) (local.get $n)))
        (call $d3dim_draw_indexed_line
          (local.get $this) (local.get $rt) (local.get $state_guest)
          (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType)
          (i32.mul (local.get $i) (i32.const 2))
          (i32.add (i32.mul (local.get $i) (i32.const 2)) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $illp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 3)) (then
      ;; LINESTRIP — every consecutive index pair
      (if (i32.lt_u (local.get $dwIndexCount) (i32.const 2)) (then (return)))
      (local.set $n (i32.sub (local.get $dwIndexCount) (i32.const 1)))
      (local.set $i (i32.const 0))
      (block $isdone (loop $islp
        (br_if $isdone (i32.ge_u (local.get $i) (local.get $n)))
        (call $d3dim_draw_indexed_line
          (local.get $this) (local.get $rt) (local.get $state_guest)
          (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType)
          (local.get $i) (i32.add (local.get $i) (i32.const 1)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $islp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 4)) (then
      ;; TRIANGLELIST
      (local.set $n (i32.div_u (local.get $dwIndexCount) (i32.const 3)))
      (local.set $i (i32.const 0))
      (block $tdone (loop $tlp
        (br_if $tdone (i32.ge_u (local.get $i) (local.get $n)))
        (call $d3dim_draw_indexed_triangle
          (local.get $this) (local.get $rt) (local.get $state_guest)
          (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType)
          (i32.mul (local.get $i) (i32.const 3))
          (i32.add (i32.mul (local.get $i) (i32.const 3)) (i32.const 1))
          (i32.add (i32.mul (local.get $i) (i32.const 3)) (i32.const 2)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $tlp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 5)) (then
      ;; TRIANGLESTRIP
      (if (i32.lt_u (local.get $dwIndexCount) (i32.const 3)) (then (return)))
      (local.set $n (i32.sub (local.get $dwIndexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (block $sdone (loop $slp
        (br_if $sdone (i32.ge_u (local.get $i) (local.get $n)))
        (if (i32.and (local.get $i) (i32.const 1))
          (then
            (call $d3dim_draw_indexed_triangle
              (local.get $this) (local.get $rt) (local.get $state_guest)
              (local.get $vbase_wa) (local.get $ibase_wa)
              (local.get $dwVertexCount) (local.get $vtxType)
              (i32.add (local.get $i) (i32.const 1))
              (local.get $i)
              (i32.add (local.get $i) (i32.const 2))))
          (else
            (call $d3dim_draw_indexed_triangle
              (local.get $this) (local.get $rt) (local.get $state_guest)
              (local.get $vbase_wa) (local.get $ibase_wa)
              (local.get $dwVertexCount) (local.get $vtxType)
              (local.get $i)
              (i32.add (local.get $i) (i32.const 1))
              (i32.add (local.get $i) (i32.const 2)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $slp)))
      (return)))
    (if (i32.eq (local.get $primType) (i32.const 6)) (then
      ;; TRIANGLEFAN
      (if (i32.lt_u (local.get $dwIndexCount) (i32.const 3)) (then (return)))
      (local.set $n (i32.sub (local.get $dwIndexCount) (i32.const 2)))
      (local.set $i (i32.const 0))
      (block $fdone (loop $flp
        (br_if $fdone (i32.ge_u (local.get $i) (local.get $n)))
        (call $d3dim_draw_indexed_triangle
          (local.get $this) (local.get $rt) (local.get $state_guest)
          (local.get $vbase_wa) (local.get $ibase_wa)
          (local.get $dwVertexCount) (local.get $vtxType)
          (i32.const 0)
          (i32.add (local.get $i) (i32.const 1))
          (i32.add (local.get $i) (i32.const 2)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $flp))))))

  (func $d3dim_interp_tl_vertex (param $a i32) (param $b i32) (param $out i32)
    (local $t f32) (local $av f32) (local $bv f32)
    ;; Approximate homogeneous near-plane clipping in TL space. rhw is 1/w;
    ;; crossing through <=0 produces the giant screen-space bands seen in
    ;; D3DRM Globe. Intersect edges at a tiny positive rhw.
    (local.set $t
      (f32.div
        (f32.sub (f32.const 0.05) (f32.load (i32.add (local.get $a) (i32.const 12))))
        (f32.sub (f32.load (i32.add (local.get $b) (i32.const 12)))
                 (f32.load (i32.add (local.get $a) (i32.const 12))))))
    ;; This is an approximation in already-projected TL space. Keep its edge
    ;; parameter on the actual segment so nearly parallel eye-plane crossings
    ;; cannot generate NaN/inf or enormous coordinates.
    (if (f32.ne (local.get $t) (local.get $t)) (then (local.set $t (f32.const 0.0))))
    (if (f32.lt (local.get $t) (f32.const 0.0)) (then (local.set $t (f32.const 0.0))))
    (if (f32.gt (local.get $t) (f32.const 1.0)) (then (local.set $t (f32.const 1.0))))
    (local.set $av (f32.load (local.get $a)))
    (local.set $bv (f32.load (local.get $b)))
    (f32.store (local.get $out) (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 4))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 4))))
    (f32.store (i32.add (local.get $out) (i32.const 4))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 8))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 8))))
    (f32.store (i32.add (local.get $out) (i32.const 8))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (f32.store (i32.add (local.get $out) (i32.const 12)) (f32.const 0.05))
    (i32.store (i32.add (local.get $out) (i32.const 16))
      (call $d3dim_color_lerp
        (i32.load (i32.add (local.get $a) (i32.const 16)))
        (i32.load (i32.add (local.get $b) (i32.const 16))) (local.get $t)))
    (i32.store (i32.add (local.get $out) (i32.const 20))
      (call $d3dim_color_lerp
        (i32.load (i32.add (local.get $a) (i32.const 20)))
        (i32.load (i32.add (local.get $b) (i32.const 20))) (local.get $t)))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 24))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 24))))
    (f32.store (i32.add (local.get $out) (i32.const 24))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 28))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 28))))
    (f32.store (i32.add (local.get $out) (i32.const 28))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t)))))

  (func $d3dim_draw_tl_triangle
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (local.get $use_z) (i32.const 0)
      (call $d3dim_coord_i (f32.load (local.get $v0)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
      (f32.load (i32.add (local.get $v0) (i32.const 8)))
      (call $d3dim_coord_i (f32.load (local.get $v1)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
      (f32.load (i32.add (local.get $v1) (i32.const 8)))
      (call $d3dim_coord_i (f32.load (local.get $v2)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4))))
      (f32.load (i32.add (local.get $v2) (i32.const 8)))
      (i32.load (i32.add (local.get $v0) (i32.const 16)))))

  (func $d3dim_draw_tl_triangle_textured
    (param $this i32) (param $rt i32) (param $tex i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (local $state i32) (local $zbuf i32) (local $zfunc i32) (local $zwrite i32)
    (local $blend i32) (local $src_blend i32) (local $dst_blend i32)
    (local $address_u i32) (local $address_v i32) (local $linear i32)
    (local $colorop i32) (local $alphaop i32) (local $filter i32) (local $shade i32)
    (local $dither i32) (local $antialias i32)
    (local $c0 i32) (local $c1 i32) (local $c2 i32)
    (local $color_key_enable i32)
    (if (i32.eqz (local.get $tex)) (then
      (call $d3dim_draw_tl_triangle
        (local.get $this) (local.get $rt) (local.get $use_z)
        (local.get $v0) (local.get $v1) (local.get $v2))
      (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (local.get $state) (then
      (local.set $blend (call $gl32 (i32.add (local.get $state) (i32.const 364))))
      (local.set $src_blend (call $gl32 (i32.add (local.get $state) (i32.const 332))))
      (local.set $dst_blend (call $gl32 (i32.add (local.get $state) (i32.const 336))))
      (local.set $color_key_enable (call $gl32 (i32.add (local.get $state) (i32.const 420))))
      ;; D3DRENDERSTATE_DITHERENABLE=26, ANTIALIAS=2.
      (local.set $dither (call $gl32 (i32.add (local.get $state) (i32.const 360))))
      (local.set $antialias (call $gl32 (i32.add (local.get $state) (i32.const 264))))
      (local.set $colorop (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 1)))
      (local.set $alphaop (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 4)))
      (local.set $address_u (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 13)))
      (local.set $address_v (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 14)))
      (local.set $filter (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 16)))
      (if (i32.eqz (local.get $filter))
        (then (local.set $filter (call $d3dim_tss_load (local.get $state) (i32.const 0) (i32.const 17)))))
      ;; DX1 execute buffers predate texture-stage state. Their filtering
      ;; controls are D3DRENDERSTATE_TEXTUREMAG/MIN (17/18), which is exactly
      ;; what the retained-mode Render menu emits.
      (if (i32.eqz (local.get $filter))
        (then (local.set $filter (call $gl32 (i32.add (local.get $state) (i32.const 324))))))
      (if (i32.eqz (local.get $filter))
        (then (local.set $filter (call $gl32 (i32.add (local.get $state) (i32.const 328))))))
      (local.set $shade (call $gl32 (i32.add (local.get $state) (i32.const 292))))
      (if (i32.eq (local.get $filter) (i32.const 2)) (then (local.set $linear (i32.const 1))))))
    (if (i32.eqz (local.get $address_u)) (then (local.set $address_u (i32.const 1))))
    (if (i32.eqz (local.get $address_v)) (then (local.set $address_v (i32.const 1))))
    (if (i32.eqz (local.get $src_blend)) (then (local.set $src_blend (i32.const 2))))
    (if (i32.eqz (local.get $dst_blend)) (then (local.set $dst_blend (i32.const 1))))
    (if (local.get $use_z) (then
      (if (local.get $state) (then
        (if (call $gl32 (i32.add (local.get $state) (i32.const 284))) (then
          (local.set $zbuf (call $d3dim_ensure_zbuffer (local.get $this)))
          (local.set $zfunc (call $gl32 (i32.add (local.get $state) (i32.const 348))))
          (local.set $zwrite (call $gl32 (i32.add (local.get $state) (i32.const 312))))))))))
    (if (i32.eqz (local.get $zfunc)) (then (local.set $zfunc (i32.const 4))))
    (if (i32.and
          (i32.eq (local.get $zfunc) (i32.const 8))
          (i32.eqz (local.get $zwrite)))
      (then (local.set $zbuf (i32.const 0))))
    (local.set $c0 (i32.load (i32.add (local.get $v0) (i32.const 16))))
    (local.set $c1 (i32.load (i32.add (local.get $v1) (i32.const 16))))
    (local.set $c2 (i32.load (i32.add (local.get $v2) (i32.const 16))))
    ;; D3DSHADE_FLAT = 1. The provoking vertex supplies the face colour;
    ;; Gouraud and legacy Phong quality continue through the interpolator.
    (if (i32.eq (local.get $shade) (i32.const 1)) (then
      (local.set $c1 (local.get $c0))
      (local.set $c2 (local.get $c0))))
    (call $rasterize_triangle_textured
      (local.get $rt) (local.get $tex)
      (local.get $blend) (local.get $src_blend) (local.get $dst_blend)
      (local.get $address_u) (local.get $address_v) (local.get $linear)
      (local.get $colorop) (local.get $alphaop) (local.get $color_key_enable)
      (local.get $dither) (local.get $antialias)
      (call $d3dim_coord_i (f32.load (local.get $v0)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
      (f32.load (i32.add (local.get $v0) (i32.const 24)))
      (f32.load (i32.add (local.get $v0) (i32.const 28)))
      (f32.load (i32.add (local.get $v0) (i32.const 12)))
      (local.get $c0)
      (f32.load (i32.add (local.get $v0) (i32.const 8)))
      (call $d3dim_coord_i (f32.load (local.get $v1)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
      (f32.load (i32.add (local.get $v1) (i32.const 24)))
      (f32.load (i32.add (local.get $v1) (i32.const 28)))
      (f32.load (i32.add (local.get $v1) (i32.const 12)))
      (local.get $c1)
      (f32.load (i32.add (local.get $v1) (i32.const 8)))
      (call $d3dim_coord_i (f32.load (local.get $v2)))
      (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4))))
      (f32.load (i32.add (local.get $v2) (i32.const 24)))
      (f32.load (i32.add (local.get $v2) (i32.const 28)))
      (f32.load (i32.add (local.get $v2) (i32.const 12)))
      (local.get $c2)
      (f32.load (i32.add (local.get $v2) (i32.const 8)))
      (local.get $zbuf) (local.get $zfunc) (local.get $zwrite)))

  (func $d3dim_draw_tl_triangle_maybe_textured
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (local $tex i32)
    (local.set $tex (call $d3dim_bound_texture_entry (local.get $this)))
    (if (local.get $tex)
      (then
        (call $d3dim_draw_tl_triangle_textured
          (local.get $this) (local.get $rt) (local.get $tex) (local.get $use_z)
          (local.get $v0) (local.get $v1) (local.get $v2)))
      (else
        (call $d3dim_draw_tl_triangle
          (local.get $this) (local.get $rt) (local.get $use_z)
          (local.get $v0) (local.get $v1) (local.get $v2)))))

  ;; Signed homogeneous clip distance reconstructed from a projected TL
  ;; vertex. Plane 0 is D3D's near plane z>=0; plane 1 is its far plane z<=w.
  ;; Both inequalities together imply positive w, so a behind-eye endpoint can
  ;; enter through either plane and must not be forced onto z=0.
  (func $d3dim_tl_clip_distance (param $v i32) (param $plane i32) (result f32)
    (local $q f32) (local $z f32)
    (local.set $q (f32.load (i32.add (local.get $v) (i32.const 12))))
    (local.set $z (f32.load (i32.add (local.get $v) (i32.const 8))))
    (if (i32.eqz (local.get $plane))
      (then (return (f32.div (local.get $z) (local.get $q)))))
    (f32.div (f32.sub (f32.const 1.0) (local.get $z)) (local.get $q)))

  ;; Intersect a projected edge with one of the homogeneous depth planes.
  ;; vertex_project retains screen x/y, z/w, and 1/w. Reconstruct clip x/y/w,
  ;; interpolate there, then project the generated TL vertex back to screen.
  (func $d3dim_interp_tl_clip_vertex
    (param $state i32) (param $a i32) (param $b i32) (param $out i32) (param $plane i32)
    (local $sw i32) (local $qa f32) (local $qb f32)
    (local $wa f32) (local $wb f32) (local $da f32) (local $db f32)
    (local $t f32) (local $w f32) (local $cx f32) (local $cy f32)
    (local $av f32) (local $bv f32)
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $qa (f32.load (i32.add (local.get $a) (i32.const 12))))
    (local.set $qb (f32.load (i32.add (local.get $b) (i32.const 12))))
    (local.set $wa (f32.div (f32.const 1.0) (local.get $qa)))
    (local.set $wb (f32.div (f32.const 1.0) (local.get $qb)))
    (local.set $da (call $d3dim_tl_clip_distance (local.get $a) (local.get $plane)))
    (local.set $db (call $d3dim_tl_clip_distance (local.get $b) (local.get $plane)))
    (local.set $t (f32.div (local.get $da) (f32.sub (local.get $da) (local.get $db))))
    (if (f32.ne (local.get $t) (local.get $t)) (then (local.set $t (f32.const 0.0))))
    (if (f32.lt (local.get $t) (f32.const 0.0)) (then (local.set $t (f32.const 0.0))))
    (if (f32.gt (local.get $t) (f32.const 1.0)) (then (local.set $t (f32.const 1.0))))
    (local.set $w (f32.add (local.get $wa)
      (f32.mul (f32.sub (local.get $wb) (local.get $wa)) (local.get $t))))
    (if (f32.lt (f32.abs (local.get $w)) (f32.const 0.001))
      (then (local.set $w (f32.const 0.001))))
    ;; clip x = ((screen x - origin x) / scale x) * w
    (local.set $av (f32.mul
      (f32.div
        (f32.sub (f32.load (local.get $a))
          (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN))))
        (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))))
      (local.get $wa)))
    (local.set $bv (f32.mul
      (f32.div
        (f32.sub (f32.load (local.get $b))
          (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN))))
        (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))))
      (local.get $wb)))
    (local.set $cx (f32.add (local.get $av)
      (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    ;; Screen y used origin - ndc*scale, hence the reversed numerator.
    (local.set $av (f32.mul
      (f32.div
        (f32.sub
          (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4))))
          (f32.load (i32.add (local.get $a) (i32.const 4))))
        (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))))
      (local.get $wa)))
    (local.set $bv (f32.mul
      (f32.div
        (f32.sub
          (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4))))
          (f32.load (i32.add (local.get $b) (i32.const 4))))
        (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))))
      (local.get $wb)))
    (local.set $cy (f32.add (local.get $av)
      (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (f32.store (local.get $out)
      (f32.add
        (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN)))
        (f32.mul (f32.div (local.get $cx) (local.get $w))
          (f32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))))))
    (f32.store (i32.add (local.get $out) (i32.const 4))
      (f32.sub
        (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4))))
        (f32.mul (f32.div (local.get $cy) (local.get $w))
          (f32.load (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))))))
    (f32.store (i32.add (local.get $out) (i32.const 8))
      (if (result f32) (i32.eqz (local.get $plane))
        (then (f32.const 0.0))
        (else (f32.const 1.0))))
    (f32.store (i32.add (local.get $out) (i32.const 12)) (f32.div (f32.const 1.0) (local.get $w)))
    (i32.store (i32.add (local.get $out) (i32.const 16))
      (call $d3dim_color_lerp
        (i32.load (i32.add (local.get $a) (i32.const 16)))
        (i32.load (i32.add (local.get $b) (i32.const 16))) (local.get $t)))
    (i32.store (i32.add (local.get $out) (i32.const 20))
      (call $d3dim_color_lerp
        (i32.load (i32.add (local.get $a) (i32.const 20)))
        (i32.load (i32.add (local.get $b) (i32.const 20))) (local.get $t)))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 24))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 24))))
    (f32.store (i32.add (local.get $out) (i32.const 24))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t))))
    (local.set $av (f32.load (i32.add (local.get $a) (i32.const 28))))
    (local.set $bv (f32.load (i32.add (local.get $b) (i32.const 28))))
    (f32.store (i32.add (local.get $out) (i32.const 28))
      (f32.add (local.get $av) (f32.mul (f32.sub (local.get $bv) (local.get $av)) (local.get $t)))))

  ;; Clip one convex TL polygon against one depth plane. The direct path starts
  ;; with three vertices; one plane can add at most one, and the second can add
  ;; at most one more, so both caller-owned arrays are bounded to five records.
  (func $d3dim_clip_tl_polygon
    (param $state i32) (param $in i32) (param $count i32)
    (param $out i32) (param $plane i32) (result i32)
    (local $i i32) (local $prev i32) (local $cur i32) (local $dst i32)
    (local $prev_d f32) (local $cur_d f32)
    (local $prev_in i32) (local $cur_in i32) (local $out_count i32)
    (if (i32.eqz (local.get $count)) (then (return (i32.const 0))))
    (local.set $prev (i32.add (local.get $in)
      (i32.mul (i32.sub (local.get $count) (i32.const 1)) (i32.const 32))))
    (local.set $prev_d (call $d3dim_tl_clip_distance (local.get $prev) (local.get $plane)))
    (local.set $prev_in (f32.ge (local.get $prev_d) (f32.const 0.0)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      (local.set $cur (i32.add (local.get $in) (i32.mul (local.get $i) (i32.const 32))))
      (local.set $cur_d (call $d3dim_tl_clip_distance (local.get $cur) (local.get $plane)))
      (local.set $cur_in (f32.ge (local.get $cur_d) (f32.const 0.0)))
      (if (local.get $cur_in) (then
        (if (i32.eqz (local.get $prev_in)) (then
          (local.set $dst (i32.add (local.get $out) (i32.mul (local.get $out_count) (i32.const 32))))
          (call $d3dim_interp_tl_clip_vertex
            (local.get $state) (local.get $prev) (local.get $cur) (local.get $dst) (local.get $plane))
          (local.set $out_count (i32.add (local.get $out_count) (i32.const 1)))))
        (local.set $dst (i32.add (local.get $out) (i32.mul (local.get $out_count) (i32.const 32))))
        (call $memcpy (local.get $dst) (local.get $cur) (i32.const 32))
        (local.set $out_count (i32.add (local.get $out_count) (i32.const 1))))
      (else
        (if (local.get $prev_in) (then
          (local.set $dst (i32.add (local.get $out) (i32.mul (local.get $out_count) (i32.const 32))))
          (call $d3dim_interp_tl_clip_vertex
            (local.get $state) (local.get $prev) (local.get $cur) (local.get $dst) (local.get $plane))
          (local.set $out_count (i32.add (local.get $out_count) (i32.const 1)))))))
      (local.set $prev (local.get $cur))
      (local.set $prev_d (local.get $cur_d))
      (local.set $prev_in (local.get $cur_in))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (local.get $out_count))

  ;; DrawPrimitive triangles take the same textured/flat decision as the
  ;; execute-buffer path, but they must still honour backface culling: direct
  ;; DrawPrimitive callers usually run without a z-buffer, so an unculled back
  ;; face overwrites the visible one. Before this existed the whole
  ;; DrawPrimitive family flat-filled every triangle with v0's diffuse, which
  ;; is why Organic Art's textured sky quad came out solid white.
  (func $d3dim_draw_tl_triangle_dp_raw
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (local $tex i32)
    (local.set $tex (call $d3dim_bound_texture_entry (local.get $this)))
    (if (i32.eqz (local.get $tex))
      (then
        (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (local.get $use_z) (i32.const 1)
          (call $d3dim_coord_i (f32.load (local.get $v0)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (f32.load (i32.add (local.get $v0) (i32.const 8)))
          (call $d3dim_coord_i (f32.load (local.get $v1)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
          (f32.load (i32.add (local.get $v1) (i32.const 8)))
          (call $d3dim_coord_i (f32.load (local.get $v2)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4))))
          (f32.load (i32.add (local.get $v2) (i32.const 8)))
          (i32.load (i32.add (local.get $v0) (i32.const 16))))
        (return)))
    (if (call $d3dim_cull_tri (local.get $this)
          (call $d3dim_coord_i (f32.load (local.get $v0)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (call $d3dim_coord_i (f32.load (local.get $v1)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
          (call $d3dim_coord_i (f32.load (local.get $v2)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4)))))
      (then (return)))
    (call $d3dim_draw_tl_triangle_textured
      (local.get $this) (local.get $rt) (local.get $tex) (local.get $use_z)
      (local.get $v0) (local.get $v1) (local.get $v2)))

  ;; Direct primitive vertices still carry homogeneous 1/w. Clip transformed
  ;; triangles to D3D's complete depth interval 0<=z<=w before integer
  ;; rasterization. A behind-eye endpoint may cross z=0 or z=w depending on
  ;; clip-z's sign; forcing both cases through z=0 collapses terrain and
  ;; billboard edges into the long screen-space fans seen in MCM.
  (func $d3dim_draw_tl_triangle_dp
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (local $q0 f32) (local $q1 f32) (local $q2 f32)
    (local $z0 f32) (local $z1 f32) (local $z2 f32)
    (local $state i32) (local $sw i32) (local $a i32) (local $b i32)
    (local $count i32) (local $i i32)
    (local.set $q0 (f32.load (i32.add (local.get $v0) (i32.const 12))))
    (local.set $q1 (f32.load (i32.add (local.get $v1) (i32.const 12))))
    (local.set $q2 (f32.load (i32.add (local.get $v2) (i32.const 12))))
    (local.set $z0 (f32.load (i32.add (local.get $v0) (i32.const 8))))
    (local.set $z1 (f32.load (i32.add (local.get $v1) (i32.const 8))))
    (local.set $z2 (f32.load (i32.add (local.get $v2) (i32.const 8))))
    ;; Some DX5-era pre-transformed samples use the old viewport-space depth
    ;; convention: every vertex in a face carries the same positive viewport
    ;; depth instead of normalized z/w. Flip3DTL uses sz=300 throughout. Real
    ;; hardware rasterizes those faces; treating 300 as homogeneous far-plane
    ;; overflow discards its whole animated cube. Keep the exception narrow to
    ;; one constant, positive, out-of-range plane so genuine crossing geometry
    ;; still takes the complete near/far clipping path below.
    (if (i32.and
          (i32.and (f32.gt (local.get $z0) (f32.const 1.0))
                   (f32.eq (local.get $z0) (local.get $z1)))
          (f32.eq (local.get $z1) (local.get $z2)))
      (then
        (call $d3dim_draw_tl_triangle_dp_raw
          (local.get $this) (local.get $rt) (local.get $use_z)
          (local.get $v0) (local.get $v1) (local.get $v2))
        (return)))
    ;; Pre-transformed UI commonly supplies rhw=0, which has no recoverable
    ;; homogeneous w. Preserve that established screen-space path. A mixed
    ;; triangle is equally unreconstructable, so leave it to viewport clipping.
    (if (i32.or
          (i32.or (f32.eq (local.get $q0) (f32.const 0.0))
                  (f32.eq (local.get $q1) (f32.const 0.0)))
          (f32.eq (local.get $q2) (f32.const 0.0)))
      (then
        (call $d3dim_draw_tl_triangle_dp_raw
          (local.get $this) (local.get $rt) (local.get $use_z)
          (local.get $v0) (local.get $v1) (local.get $v2))
        (return)))
    ;; Keep the overwhelmingly common fully-visible path allocation-free and
    ;; bit-identical. q>0 plus 0<=z/w<=1 is equivalent to 0<=clip-z<=w.
    (if (i32.and
          (i32.and
            (i32.and (f32.gt (local.get $q0) (f32.const 0.0))
                     (f32.ge (local.get $z0) (f32.const 0.0)))
            (f32.le (local.get $z0) (f32.const 1.0)))
          (i32.and
            (i32.and
              (i32.and (f32.gt (local.get $q1) (f32.const 0.0))
                       (f32.ge (local.get $z1) (f32.const 0.0)))
              (f32.le (local.get $z1) (f32.const 1.0)))
            (i32.and
              (i32.and (f32.gt (local.get $q2) (f32.const 0.0))
                       (f32.ge (local.get $z2) (f32.const 0.0)))
              (f32.le (local.get $z2) (f32.const 1.0)))))
      (then
        (call $d3dim_draw_tl_triangle_dp_raw
          (local.get $this) (local.get $rt) (local.get $use_z)
          (local.get $v0) (local.get $v1) (local.get $v2))
        (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return)))
    (local.set $sw (call $g2w (local.get $state)))
    ;; A reuses the otherwise-free tail; B reuses indexed-draw scratch only
    ;; after all three caller vertices have been copied away from it.
    (local.set $a (i32.add (local.get $sw) (i32.const 3744)))
    (local.set $b (i32.add (local.get $sw) (i32.const 3200)))
    (call $memcpy (local.get $a) (local.get $v0) (i32.const 32))
    (call $memcpy (i32.add (local.get $a) (i32.const 32)) (local.get $v1) (i32.const 32))
    (call $memcpy (i32.add (local.get $a) (i32.const 64)) (local.get $v2) (i32.const 32))
    (local.set $count (call $d3dim_clip_tl_polygon
      (local.get $state) (local.get $a) (i32.const 3) (local.get $b) (i32.const 0)))
    (if (i32.lt_u (local.get $count) (i32.const 3)) (then (return)))
    (local.set $count (call $d3dim_clip_tl_polygon
      (local.get $state) (local.get $b) (local.get $count) (local.get $a) (i32.const 1)))
    (if (i32.lt_u (local.get $count) (i32.const 3)) (then (return)))
    (local.set $i (i32.const 1))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (i32.add (local.get $i) (i32.const 1)) (local.get $count)))
      (call $d3dim_draw_tl_triangle_dp_raw
        (local.get $this) (local.get $rt) (local.get $use_z)
        (local.get $a)
        (i32.add (local.get $a) (i32.mul (local.get $i) (i32.const 32)))
        (i32.add (local.get $a) (i32.mul (i32.add (local.get $i) (i32.const 1)) (i32.const 32))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer triangle rasterizer ─────────────────────────
  ;; Walks wCount D3DTRIANGLE records (8 bytes each: u16 v1,v2,v3,flags) and
  ;; rasterizes each one by indexing into the vertex area of the exec buffer.
  ;; Treats vertices as D3DTLVERTEX (32 bytes) laid out from buf+0. The
  ;; PROCESSVERTICES path preserves original source bytes in a side cache while
  ;; writing transformed TL vertices back into this live buffer.
  (func $d3dim_exec_triangles
    (param $dev_this i32) (param $buf_guest i32) (param $rec_wa i32) (param $wCount i32)
    (local $rt i32) (local $vbase i32) (local $i i32)
    (local $iv0 i32) (local $iv1 i32) (local $iv2 i32)
    (local $v0 i32) (local $v1 i32) (local $v2 i32)
    (local $p0 i32) (local $p1 i32) (local $p2 i32) (local $pos i32)
    (local $state i32) (local $sw i32) (local $c0 i32) (local $c1 i32)
    (local $fillmode i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $dev_this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
    (local.set $state (call $d3ddev_state (local.get $dev_this)))
    (if (local.get $state) (then
      (local.set $sw (call $g2w (local.get $state)))
      (local.set $c0 (i32.add (local.get $sw) (i32.const 3296)))
      ;; D3DRENDERSTATE_FILLMODE = 8; 1 point, 2 wireframe, 3 solid.
      (local.set $fillmode (call $gl32 (i32.add (local.get $state) (i32.const 288))))))
    (if (i32.eqz (local.get $fillmode)) (then (local.set $fillmode (i32.const 3))))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $iv0 (i32.load16_u (local.get $rec_wa)))
      (local.set $iv1 (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 2))))
      (local.set $iv2 (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 4))))
      (local.set $v0 (i32.add (local.get $vbase) (i32.mul (local.get $iv0) (i32.const 32))))
      (local.set $v1 (i32.add (local.get $vbase) (i32.mul (local.get $iv1) (i32.const 32))))
      (local.set $v2 (i32.add (local.get $vbase) (i32.mul (local.get $iv2) (i32.const 32))))
      (local.set $p0 (f32.gt (f32.load (i32.add (local.get $v0) (i32.const 12))) (f32.const 0.0)))
      (local.set $p1 (f32.gt (f32.load (i32.add (local.get $v1) (i32.const 12))) (f32.const 0.0)))
      (local.set $p2 (f32.gt (f32.load (i32.add (local.get $v2) (i32.const 12))) (f32.const 0.0)))
      (local.set $pos (i32.add (local.get $p0) (i32.add (local.get $p1) (local.get $p2))))
      (if (i32.eqz (local.get $pos)) (then
        (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))
      (if (i32.eq (local.get $fillmode) (i32.const 1)) (then
        ;; Point fill mode plots each visible triangle vertex. Shared vertices
        ;; may be written more than once, matching immediate-mode overdraw.
        (if (local.get $p0) (then (call $viewport_fill_rect (local.get $rt)
          (call $d3dim_coord_i (f32.load (local.get $v0)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (i32.const 2) (i32.const 2) (i32.load (i32.add (local.get $v0) (i32.const 16))))))
        (if (local.get $p1) (then (call $viewport_fill_rect (local.get $rt)
          (call $d3dim_coord_i (f32.load (local.get $v1)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
          (i32.const 2) (i32.const 2) (i32.load (i32.add (local.get $v1) (i32.const 16))))))
        (if (local.get $p2) (then (call $viewport_fill_rect (local.get $rt)
          (call $d3dim_coord_i (f32.load (local.get $v2)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4))))
          (i32.const 2) (i32.const 2) (i32.load (i32.add (local.get $v2) (i32.const 16))))))
        (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))
      (if (i32.eq (local.get $fillmode) (i32.const 2)) (then
        ;; The line helper clips edges crossing the retained-mode near plane.
        (call $d3dim_draw_tl_line (local.get $rt) (local.get $v0) (local.get $v1) (local.get $c0))
        (call $d3dim_draw_tl_line (local.get $rt) (local.get $v1) (local.get $v2) (local.get $c0))
        (call $d3dim_draw_tl_line (local.get $rt) (local.get $v2) (local.get $v0) (local.get $c0))
        (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $lp)))
      (if (i32.eq (local.get $pos) (i32.const 3)) (then
        (call $d3dim_draw_tl_triangle_maybe_textured
          (local.get $dev_this) (local.get $rt) (i32.const 1)
          (local.get $v0) (local.get $v1) (local.get $v2))))
      (if (i32.ne (local.get $pos) (i32.const 3)) (then
        (if (i32.eqz (local.get $state)) (then
          (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lp)))
        (local.set $c0 (i32.add (local.get $sw) (i32.const 3296)))
        (local.set $c1 (i32.add (local.get $sw) (i32.const 3328)))
        (if (i32.eq (local.get $pos) (i32.const 1)) (then
          (if (local.get $p0) (then
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v1) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $c0) (local.get $c1))))
          (if (local.get $p1) (then
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v2) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $c0) (local.get $c1))))
          (if (local.get $p2) (then
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v0) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $c0) (local.get $c1))))))
        (if (i32.eq (local.get $pos) (i32.const 2)) (then
          (if (i32.eqz (local.get $p0)) (then
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v0) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $c1) (local.get $c0))))
          (if (i32.eqz (local.get $p1)) (then
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v1) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $c1) (local.get $c0))))
          (if (i32.eqz (local.get $p2)) (then
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v2) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle_maybe_textured
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $c1) (local.get $c0))))))))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer: POINT (op=1) ──────────────────────────────
  ;; Walks `wCount` D3DPOINT records {u16 wCount, u16 wFirst}.
  ;; Each record draws `wCount` consecutive vertices as 2×2 dots starting
  ;; at index `wFirst`. Vertices treated as TLVERTEX (32 bytes).
  (func $d3dim_exec_points
    (param $dev_this i32) (param $buf_guest i32) (param $rec_wa i32) (param $wCount i32)
    (local $rt i32) (local $vbase i32) (local $i i32)
    (local $pcount i32) (local $pfirst i32) (local $j i32) (local $v i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $dev_this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $pcount (i32.load16_u (local.get $rec_wa)))
      (local.set $pfirst (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 2))))
      (local.set $j (i32.const 0))
      (block $pdone (loop $plp
        (br_if $pdone (i32.ge_u (local.get $j) (local.get $pcount)))
        (local.set $v (i32.add (local.get $vbase)
          (i32.mul (i32.add (local.get $pfirst) (local.get $j)) (i32.const 32))))
        (call $viewport_fill_rect (local.get $rt)
          (call $d3dim_coord_i (f32.load (local.get $v)))
          (call $d3dim_coord_i (f32.load (i32.add (local.get $v) (i32.const 4))))
          (i32.const 2) (i32.const 2)
          (i32.load (i32.add (local.get $v) (i32.const 16))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $plp)))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 4)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Bresenham 1-pixel flat-color line rasterizer ──────────────
  (func $rasterize_line_flat
    (param $rt_entry i32)
    (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32)
    (param $color i32)
    (local $dx i32) (local $dy i32) (local $sx i32) (local $sy i32)
    (local $err i32) (local $e2 i32) (local $guard i32)
    (if (i32.ge_s (local.get $x1) (local.get $x0))
      (then (local.set $dx (i32.sub (local.get $x1) (local.get $x0))) (local.set $sx (i32.const 1)))
      (else (local.set $dx (i32.sub (local.get $x0) (local.get $x1))) (local.set $sx (i32.const -1))))
    ;; dy encoded negative: standard Bresenham uses dy = -|Δy|.
    (if (i32.ge_s (local.get $y1) (local.get $y0))
      (then (local.set $dy (i32.sub (local.get $y0) (local.get $y1))) (local.set $sy (i32.const 1)))
      (else (local.set $dy (i32.sub (local.get $y1) (local.get $y0))) (local.set $sy (i32.const -1))))
    (local.set $err (i32.add (local.get $dx) (local.get $dy)))
    (local.set $guard (i32.const 0))
    (block $done (loop $lp
      (call $viewport_fill_rect (local.get $rt_entry)
        (local.get $x0) (local.get $y0) (i32.const 1) (i32.const 1) (local.get $color))
      (br_if $done (i32.and (i32.eq (local.get $x0) (local.get $x1))
                            (i32.eq (local.get $y0) (local.get $y1))))
      ;; Guard against runaway (malformed coords) — 8192 pixels is plenty.
      (local.set $guard (i32.add (local.get $guard) (i32.const 1)))
      (br_if $done (i32.gt_u (local.get $guard) (i32.const 8192)))
      (local.set $e2 (i32.mul (local.get $err) (i32.const 2)))
      (if (i32.ge_s (local.get $e2) (local.get $dy)) (then
        (local.set $err (i32.add (local.get $err) (local.get $dy)))
        (local.set $x0  (i32.add (local.get $x0)  (local.get $sx)))))
      (if (i32.le_s (local.get $e2) (local.get $dx)) (then
        (local.set $err (i32.add (local.get $err) (local.get $dx)))
        (local.set $y0  (i32.add (local.get $y0)  (local.get $sy)))))
      (br $lp))))

  ;; ── Execute-buffer: LINE (op=2) ───────────────────────────────
  ;; Walks `wCount` D3DLINE records {u16 v1, u16 v2}.
  (func $d3dim_exec_lines
    (param $dev_this i32) (param $buf_guest i32) (param $rec_wa i32) (param $wCount i32)
    (local $rt i32) (local $vbase i32) (local $i i32)
    (local $iv1 i32) (local $iv2 i32) (local $v1 i32) (local $v2 i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $dev_this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $iv1 (i32.load16_u (local.get $rec_wa)))
      (local.set $iv2 (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 2))))
      (local.set $v1 (i32.add (local.get $vbase) (i32.mul (local.get $iv1) (i32.const 32))))
      (local.set $v2 (i32.add (local.get $vbase) (i32.mul (local.get $iv2) (i32.const 32))))
      (call $rasterize_line_flat (local.get $rt)
        (call $d3dim_coord_i (f32.load (local.get $v1)))
        (call $d3dim_coord_i (f32.load (i32.add (local.get $v1) (i32.const 4))))
        (call $d3dim_coord_i (f32.load (local.get $v2)))
        (call $d3dim_coord_i (f32.load (i32.add (local.get $v2) (i32.const 4))))
        (i32.load (i32.add (local.get $v1) (i32.const 16))))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 4)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer: MATRIXLOAD (op=4) ─────────────────────────
  ;; Each D3DMATRIXLOAD record (8B): {DWORD hDest, DWORD hSrc}. Copies 64B.
  (func $d3dim_exec_matrix_load
    (param $rec_wa i32) (param $wCount i32)
    (local $i i32) (local $hD i32) (local $hS i32)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $hD (i32.load (local.get $rec_wa)))
      (local.set $hS (i32.load (i32.add (local.get $rec_wa) (i32.const 4))))
      (if (i32.and
            (i32.and (i32.ge_u (local.get $hD) (i32.const 1))
                     (i32.le_u (local.get $hD) (global.get $D3DIM_MATRIX_MAX)))
            (i32.and (i32.ge_u (local.get $hS) (i32.const 1))
                     (i32.le_u (local.get $hS) (global.get $D3DIM_MATRIX_MAX))))
        (then
          (call $memcpy
            (i32.add (global.get $D3DIM_MATRICES)
                     (i32.mul (i32.sub (local.get $hD) (i32.const 1)) (i32.const 64)))
            (i32.add (global.get $D3DIM_MATRICES)
                     (i32.mul (i32.sub (local.get $hS) (i32.const 1)) (i32.const 64)))
            (i32.const 64))))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer: MATRIXMULTIPLY (op=5) ─────────────────────
  ;; Each D3DMATRIXMULTIPLY record (12B): {DWORD hDest, hSrc1, hSrc2}.
  ;; out = src1 * src2 via the row-major multiply shared with WVP compose.
  (func $d3dim_exec_matrix_multiply
    (param $rec_wa i32) (param $wCount i32)
    (local $i i32) (local $hD i32) (local $h1 i32) (local $h2 i32)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $hD (i32.load (local.get $rec_wa)))
      (local.set $h1 (i32.load (i32.add (local.get $rec_wa) (i32.const 4))))
      (local.set $h2 (i32.load (i32.add (local.get $rec_wa) (i32.const 8))))
      (if (i32.and (i32.and
            (i32.and (i32.ge_u (local.get $hD) (i32.const 1))
                     (i32.le_u (local.get $hD) (global.get $D3DIM_MATRIX_MAX)))
            (i32.and (i32.ge_u (local.get $h1) (i32.const 1))
                     (i32.le_u (local.get $h1) (global.get $D3DIM_MATRIX_MAX))))
            (i32.and (i32.ge_u (local.get $h2) (i32.const 1))
                     (i32.le_u (local.get $h2) (global.get $D3DIM_MATRIX_MAX))))
        (then
          (call $mat4_mul
            (i32.add (global.get $D3DIM_MATRICES)
                     (i32.mul (i32.sub (local.get $hD) (i32.const 1)) (i32.const 64)))
            (i32.add (global.get $D3DIM_MATRICES)
                     (i32.mul (i32.sub (local.get $h1) (i32.const 1)) (i32.const 64)))
            (i32.add (global.get $D3DIM_MATRICES)
                     (i32.mul (i32.sub (local.get $h2) (i32.const 1)) (i32.const 64))))))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 12)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer: PROCESSVERTICES (op=9) ────────────────────
  ;; D3DPROCESSVERTICES (16B): DWORD dwFlags; WORD wStart; WORD wDest;
  ;;                           DWORD dwCount; DWORD dwReserved.
  ;; Low 3 bits of dwFlags: 0=TRANSFORMLIGHT (src=D3DVERTEX),
  ;; 1=TRANSFORM (src=D3DLVERTEX), 2=COPY (src=D3DTLVERTEX).
  ;; Composes WORLD*VIEW*PROJ into scratch slot 3, then projects each source
  ;; vertex's xyz into TLVERTEX sx/sy/z/rhw at dest. Color: LVERTEX passes
  ;; through; VERTEX has no color → write white 0xFFFFFFFF. Lighting is not
  ;; yet implemented; TRANSFORMLIGHT degenerates to TRANSFORM + default color.
  (func $d3dim_exec_process_vertices
    (param $dev_this i32) (param $buf_guest i32) (param $rec_wa i32) (param $wCount i32)
    (local $state_g i32) (local $vbase i32) (local $srcbase i32)
    (local $i i32) (local $mode i32) (local $wStart i32) (local $wDest i32) (local $cnt i32)
    (local $j i32) (local $src i32) (local $dst i32) (local $color i32) (local $spec i32)
    (local $tu i32) (local $tv i32) (local $src_stride i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $state_g (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_g)) (then (return)))
    (call $d3ddev_composite_wvp (local.get $state_g))
    (call $d3dim_lights_refresh (local.get $state_g))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
    (local.set $srcbase (call $d3dim_execbuf_source_base (local.get $buf_guest)))
    (if (i32.eqz (local.get $srcbase)) (then (local.set $srcbase (local.get $vbase))))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $mode   (i32.and (i32.load (local.get $rec_wa)) (i32.const 7)))
      (local.set $wStart (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 4))))
      (local.set $wDest  (i32.load16_u (i32.add (local.get $rec_wa) (i32.const 6))))
      (local.set $cnt    (i32.load        (i32.add (local.get $rec_wa) (i32.const 8))))
      (local.set $src_stride (i32.const 32))
      (local.set $j (i32.const 0))
      (block $vdone (loop $vlp
        (br_if $vdone (i32.ge_u (local.get $j) (local.get $cnt)))
        (local.set $src (i32.add (local.get $srcbase)
          (i32.mul (i32.add (local.get $wStart) (local.get $j)) (local.get $src_stride))))
        (local.set $dst (i32.add (local.get $vbase)
          (i32.mul (i32.add (local.get $wDest)  (local.get $j)) (i32.const 32))))
        (if (i32.eq (local.get $mode) (i32.const 2))
          (then
            (if (i32.ne (local.get $src) (local.get $dst))
              (then (call $memcpy (local.get $dst) (local.get $src) (i32.const 32)))))
          (else
            ;; Buffer trailing LVERTEX fields before vertex_project writes dst.
            (if (i32.eq (local.get $mode) (i32.const 1))
              (then
                (local.set $color (i32.load (i32.add (local.get $src) (i32.const 16))))
                (local.set $spec  (i32.load (i32.add (local.get $src) (i32.const 20))))
                (local.set $tu    (i32.load (i32.add (local.get $src) (i32.const 24))))
                (local.set $tv    (i32.load (i32.add (local.get $src) (i32.const 28)))))
              (else
                (local.set $color (call $d3dim_vertex_lit_color (local.get $state_g) (local.get $src)))
                (local.set $spec  (i32.const 0))
                (local.set $tu    (i32.load (i32.add (local.get $src) (i32.const 24))))
                (local.set $tv    (i32.load (i32.add (local.get $src) (i32.const 28))))))
            (call $vertex_project (local.get $state_g) (local.get $src) (local.get $dst))
            (i32.store (i32.add (local.get $dst) (i32.const 16)) (local.get $color))
            (i32.store (i32.add (local.get $dst) (i32.const 20)) (local.get $spec))
            (i32.store (i32.add (local.get $dst) (i32.const 24)) (local.get $tu))
            (i32.store (i32.add (local.get $dst) (i32.const 28)) (local.get $tv))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $vlp)))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 16)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── Execute-buffer: BRANCHFORWARD (op=12) ─────────────────────
  ;; Evaluates one D3DBRANCH record (16B: dwMask, dwValue, bNegate, dwOffset).
  ;; Returns:
  ;;   -1 ⇒ fall through (branch not taken; caller advances normally)
  ;;    0 ⇒ terminate execute loop (branch taken, offset==0 per spec)
  ;;   N  ⇒ resume at WASM addr N (= instr_start + dwOffset, per Wine's reading)
  ;; Status is not yet tracked; assume 0 — so condition reduces to (value==0).
  (func $d3dim_exec_branch (param $rec_wa i32) (param $instr_start i32) (result i32)
    (local $value i32) (local $negate i32) (local $offset i32) (local $taken i32)
    (local.set $value  (i32.load (i32.add (local.get $rec_wa) (i32.const 4))))
    (local.set $negate (i32.load (i32.add (local.get $rec_wa) (i32.const 8))))
    (local.set $offset (i32.load (i32.add (local.get $rec_wa) (i32.const 12))))
    (local.set $taken (i32.eqz (local.get $value)))
    (if (local.get $negate) (then (local.set $taken (i32.eqz (local.get $taken)))))
    (if (i32.eqz (local.get $taken)) (then (return (i32.const -1))))
    (if (i32.eqz (local.get $offset)) (then (return (i32.const 0))))
    (return (i32.add (local.get $instr_start) (local.get $offset))))

  ;; ── D3DSTATE walker ────────────────────────────────────────────
  ;; Apply `wCount` consecutive 8-byte D3DSTATE records (dwArg, dwValue) through
  ;; the supplied per-state forwarder. kind: 7=light, 8=render, 6=transform
  ;; (matches D3DOP_LIGHTSTATE/RENDERSTATE/STATETRANSFORM opcode values).
  (func $d3dim_exec_state_walk
    (param $dev_this i32) (param $kind i32) (param $rec_wa i32) (param $wCount i32)
    (local $i i32) (local $a i32) (local $v i32)
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $wCount)))
      (local.set $a (i32.load (local.get $rec_wa)))
      (local.set $v (i32.load (i32.add (local.get $rec_wa) (i32.const 4))))
      (if (i32.eq (local.get $kind) (i32.const 8))
        (then (call $d3dim_set_render_state (local.get $dev_this) (local.get $a) (local.get $v))))
      (if (i32.eq (local.get $kind) (i32.const 7))
        (then (call $d3dim_set_light_state  (local.get $dev_this) (local.get $a) (local.get $v))))
      ;; D3DOP_STATETRANSFORM: $a = D3DTRANSFORMSTATETYPE, $v = matrix handle.
      ;; Resolve handle → D3DIM_MATRICES + (v-1)*64 and route through the
      ;; shared SetTransform core so the per-device state block is the
      ;; single source of truth for matrices.
      (if (i32.eq (local.get $kind) (i32.const 6))
        (then
          (if (i32.and (i32.ge_u (local.get $v) (i32.const 1))
                       (i32.le_u (local.get $v) (global.get $D3DIM_MATRIX_MAX)))
            (then
              (call $d3dim_bind_transform_handle
                (local.get $dev_this) (local.get $a) (local.get $v))
              (call $d3dim_apply_transform
                (local.get $dev_this) (local.get $a)
                (i32.add (global.get $D3DIM_MATRICES)
                         (i32.mul (i32.sub (local.get $v) (i32.const 1)) (i32.const 64))))))))
      (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; ── D3DDEVICEDESC population (used by IDirect3DDevice{,2,3}_GetCaps) ──
  ;; Thin wrapper around $fill_d3d_device_desc that respects the caller's
  ;; dwSize to avoid clobbering their stack frame. EnumDevices allocates
  ;; 252-byte heap buffers so it can call the fill directly; GetCaps
  ;; receives a caller-supplied buffer whose dwSize varies by DX version
  ;; (DX3=172, DX5=0xCC=204, DX6/7=252).
  (func $d3dim_fill_device_desc (param $desc i32)
    (local $wa i32) (local $sz i32)
    (if (i32.eqz (local.get $desc)) (then (return)))
    (local.set $wa (call $g2w (local.get $desc)))
    (local.set $sz (i32.load (local.get $wa)))
    ;; Only populate when dwSize is a plausible D3DDEVICEDESC size.
    (if (i32.lt_u (local.get $sz) (i32.const 172)) (then (return)))
    (if (i32.gt_u (local.get $sz) (i32.const 252)) (then (return)))
    ;; Fill the whole 252 bytes into scratch, then copy back only dwSize bytes.
    ;; Cheapest safe approach: if dwSize >= 252, fill in place; else use the
    ;; caller's buffer but only clamp the far end of $fill_d3d_device_desc's
    ;; writes by not invoking it and falling back to a dwSize-aware stub.
    (if (i32.ge_u (local.get $sz) (i32.const 252))
      (then
        (call $fill_d3d_device_desc (local.get $desc) (i32.const 0))
        (return)))
    ;; dwSize 172..251 — write fields that fit, leaving the rest zero.
    ;; dwFlags, dcmColorModel, dwDevCaps are the minimum for passing the
    ;; common "has HW color model" check pattern.
    (i32.store (i32.add (local.get $wa) (i32.const 4))  (i32.const 0x7FF))     ;; dwFlags
    (i32.store (i32.add (local.get $wa) (i32.const 8))  (i32.const 2))          ;; RGB color model
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x02A50))    ;; HEL-style devcaps
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.const 8))          ;; transform.dwSize
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 1))          ;; transform.dwCaps=CLIP
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 1))          ;; bClipping
    (i32.store (i32.add (local.get $wa) (i32.const 28)) (i32.const 16))         ;; lighting.dwSize
    (i32.store (i32.add (local.get $wa) (i32.const 32)) (i32.const 7))          ;; POINT|SPOT|DIRECTIONAL
    (i32.store (i32.add (local.get $wa) (i32.const 36)) (i32.const 1))          ;; RGB lighting model
    (i32.store (i32.add (local.get $wa) (i32.const 40)) (i32.const 8))          ;; numLights
    ;; dpcLineCaps and dpcTriCaps full body (56 bytes each) — both ranges
    ;; fit inside the smallest valid dwSize (172). d3rm gates the triangle
    ;; emit path on dpcTriCaps.dwShadeCaps != 0; leaving zero makes it skip
    ;; geometry submission entirely.
    (call $fill_primcaps (i32.add (local.get $desc) (i32.const 44)))
    (call $fill_primcaps (i32.add (local.get $desc) (i32.const 100)))
    (i32.store (i32.add (local.get $wa) (i32.const 156)) (i32.const 0xD00))     ;; DeviceRenderBitDepth
    (i32.store (i32.add (local.get $wa) (i32.const 160)) (i32.const 0x500))     ;; DeviceZBufferBitDepth
    (i32.store (i32.add (local.get $wa) (i32.const 168)) (i32.const 0xFFFF))    ;; dwMaxVertexCount
    (if (i32.ge_u (local.get $sz) (i32.const 188)) (then
      (i32.store (i32.add (local.get $wa) (i32.const 172)) (i32.const 1))       ;; dwMinTextureWidth
      (i32.store (i32.add (local.get $wa) (i32.const 176)) (i32.const 1))
      (i32.store (i32.add (local.get $wa) (i32.const 180)) (i32.const 2048))
      (i32.store (i32.add (local.get $wa) (i32.const 184)) (i32.const 2048)))))

  ;; D3DDEVICEDESC7 has no dwSize member; IDirect3DDevice7::GetCaps receives
  ;; a fixed 236-byte buffer. Keep the values close to the legacy HEL caps but
  ;; include the DX7-only texture/FVF limits that samples commonly probe.
  (func $d3dim_fill_device_desc7 (param $desc i32)
    (local $wa i32)
    (if (i32.eqz (local.get $desc)) (then (return)))
    (local.set $wa (call $g2w (local.get $desc)))
    (call $zero_memory (local.get $wa) (i32.const 236))
    (i32.store (local.get $wa) (i32.const 0x02A50))                         ;; dwDevCaps
    (call $fill_primcaps (i32.add (local.get $desc) (i32.const 4)))          ;; dpcLineCaps
    (call $fill_primcaps (i32.add (local.get $desc) (i32.const 60)))         ;; dpcTriCaps
    (i32.store (i32.add (local.get $wa) (i32.const 116)) (i32.const 0xD00))  ;; DeviceRenderBitDepth
    (i32.store (i32.add (local.get $wa) (i32.const 120)) (i32.const 0x500))  ;; DeviceZBufferBitDepth
    (i32.store (i32.add (local.get $wa) (i32.const 124)) (i32.const 1))      ;; dwMinTextureWidth
    (i32.store (i32.add (local.get $wa) (i32.const 128)) (i32.const 1))      ;; dwMinTextureHeight
    (i32.store (i32.add (local.get $wa) (i32.const 132)) (i32.const 2048))   ;; dwMaxTextureWidth
    (i32.store (i32.add (local.get $wa) (i32.const 136)) (i32.const 2048))   ;; dwMaxTextureHeight
    (i32.store (i32.add (local.get $wa) (i32.const 140)) (i32.const 2048))   ;; dwMaxTextureRepeat
    (i32.store (i32.add (local.get $wa) (i32.const 144)) (i32.const 2048))   ;; dwMaxTextureAspectRatio
    (i32.store (i32.add (local.get $wa) (i32.const 148)) (i32.const 1))      ;; dwMaxAnisotropy
    (f32.store (i32.add (local.get $wa) (i32.const 152)) (f32.const -8192.0))
    (f32.store (i32.add (local.get $wa) (i32.const 156)) (f32.const -8192.0))
    (f32.store (i32.add (local.get $wa) (i32.const 160)) (f32.const 8192.0))
    (f32.store (i32.add (local.get $wa) (i32.const 164)) (f32.const 8192.0))
    (f32.store (i32.add (local.get $wa) (i32.const 168)) (f32.const 0.0))
    (i32.store (i32.add (local.get $wa) (i32.const 176)) (i32.const 8))       ;; dwFVFCaps: 8 texcoord sets
    (i32.store (i32.add (local.get $wa) (i32.const 180)) (i32.const 0x003FF));; dwTextureOpCaps
    (i32.store16 (i32.add (local.get $wa) (i32.const 184)) (i32.const 1))    ;; wMaxTextureBlendStages
    (i32.store16 (i32.add (local.get $wa) (i32.const 186)) (i32.const 1))    ;; wMaxSimultaneousTextures
    (i32.store (i32.add (local.get $wa) (i32.const 188)) (i32.const 8))      ;; dwMaxActiveLights
    (f32.store (i32.add (local.get $wa) (i32.const 192)) (f32.const 1.0)))
