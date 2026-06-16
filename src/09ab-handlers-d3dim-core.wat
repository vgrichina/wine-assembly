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
  ;;   +4000  D3DCLIPSTATUS round-trip storage          (24)
  ;;   +4032  vertex_project vec temp                  (16)
  ;;   +4064  vertex_project clip temp                 (16)
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
  (global $D3DIM_OFF_CLIP_STATUS i32 (i32.const 4000))

  ;; Crash-name strings for unimplemented D3DIM paths live in the high
  ;; WAT-private scratch area so they cannot collide with low system strings
  ;; or sparse VirtualAlloc map state.
  (data (i32.const 0x07FEB000) "D3DIM:Execute opcode\00")
  (data (i32.const 0x07FEB020) "D3DIM:DrawPrimitive vtx/prim\00")
  (global $D3DIM_UNIMPL_EXEC_OP i32 (i32.const 0x07FEB000))
  (global $D3DIM_UNIMPL_DRAW    i32 (i32.const 0x07FEB020))
  ;; 512 i32 guest pointers, keyed by DX_OBJECTS slot. Each cached execute
  ;; buffer block is [buf_guest, buf_size, reserved, reserved, original bytes...].
  (global $D3DIM_EB_CACHE_PTRS i32 (i32.const 0x07FEB040))
  (global $D3DIM_EB_CACHE_MAX  i32 (i32.const 512))

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
  (func $d3dim_create_device (param $this i32) (param $rt_surf i32) (param $ppDev i32) (param $vtbl i32)
    (local $obj i32) (local $entry i32) (local $rt_entry i32) (local $rt_slot i32) (local $state i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 20) (local.get $vtbl)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (if (local.get $rt_surf) (then
      (local.set $rt_entry (call $dx_from_this (local.get $rt_surf)))
      (local.set $rt_slot (call $dx_slot_of (local.get $rt_entry)))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $rt_slot))))
    (local.set $state (call $heap_alloc (i32.const 4096)))
    (call $d3ddev_init_state (local.get $state))
    (i32.store (i32.add (local.get $entry) (i32.const 16)) (local.get $state))
    (call $gs32 (local.get $ppDev) (local.get $obj))
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
              (local.get $val))))
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
        (then (return (i32.add (local.get $cache_wa) (i32.const 16)))))))
    (local.set $cache_g (call $heap_alloc (i32.add (local.get $buf_size) (i32.const 16))))
    (if (i32.eqz (local.get $cache_g))
      (then (return (call $g2w (local.get $buf_guest)))))
    (local.set $cache_wa (call $g2w (local.get $cache_g)))
    (i32.store (local.get $cache_wa) (local.get $buf_guest))
    (i32.store (i32.add (local.get $cache_wa) (i32.const 4)) (local.get $buf_size))
    (i32.store (i32.add (local.get $cache_wa) (i32.const 8)) (i32.const 0))
    (i32.store (i32.add (local.get $cache_wa) (i32.const 12)) (i32.const 0))
    (call $memcpy
      (i32.add (local.get $cache_wa) (i32.const 16))
      (call $g2w (local.get $buf_guest))
      (local.get $buf_size))
    (i32.store (local.get $tbl) (local.get $cache_g))
    (i32.add (local.get $cache_wa) (i32.const 16)))

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

  (func $d3dim_current_material_color (param $state_guest i32) (result i32)
    (if (i32.eqz (local.get $state_guest)) (then (return (i32.const 0xFFFFFFFF))))
    ;; D3DLIGHTSTATE_MATERIAL = 1, stored at state+2304+1*4.
    (call $d3dim_material_color_from_handle
      (call $gl32 (i32.add (local.get $state_guest) (i32.const 2308)))))

  (func $d3dim_vertex_lit_color (param $state_guest i32) (param $src_wa i32) (result i32)
    (local $shade f32)
    ;; D3DVERTEX: xyz, normal xyz, tu/tv. This is not full D3D lighting, but it
    ;; gives legacy TRANSFORMLIGHT meshes useful shape until lights are modeled.
    (local.set $shade
      (f32.add (f32.const 0.25)
        (f32.mul (f32.const 0.75)
          (f32.abs (f32.load (i32.add (local.get $src_wa) (i32.const 20)))))))
    (call $d3dim_scale_color
      (call $d3dim_current_material_color (local.get $state_guest))
      (local.get $shade)))

  ;; ── Texture binding ───────────────────────────────────────────
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

  ;; SetTextureStageState(stage, type, value). Stored at +D3DIM_OFF_TSS_STATE
  ;; in 32-byte per-stage blocks (8 stages × 32 bytes = 256, indexed by `type`).
  (func $d3dim_set_tss (param $this i32) (param $stage i32) (param $type i32) (param $val i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (if (i32.and (i32.lt_u (local.get $stage) (i32.const 8))
                 (i32.lt_u (local.get $type) (i32.const 8)))
      (then (call $gs32
              (i32.add (local.get $state)
                (i32.add (global.get $D3DIM_OFF_TSS_STATE)
                  (i32.add (i32.mul (local.get $stage) (i32.const 32))
                           (i32.mul (local.get $type) (i32.const 4)))))
              (local.get $val))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_tss (param $this i32) (param $stage i32) (param $type i32) (param $out i32)
    (local $state i32) (local $val i32)
    (if (i32.eqz (local.get $out)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and
          (i32.and (i32.ne (local.get $state) (i32.const 0))
                   (i32.lt_u (local.get $stage) (i32.const 8)))
          (i32.lt_u (local.get $type) (i32.const 8)))
      (then (local.set $val
              (call $gl32
                (i32.add (local.get $state)
                  (i32.add (global.get $D3DIM_OFF_TSS_STATE)
                    (i32.add (i32.mul (local.get $stage) (i32.const 32))
                             (i32.mul (local.get $type) (i32.const 4)))))))))
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

  ;; ── Viewport rect get/set ─────────────────────────────────────
  ;; SetViewport(lpD3DVIEWPORT) / SetViewport2(lpD3DVIEWPORT2). Persist the
  ;; rectangle and derive the transform viewport used by vertex_project.
  (func $d3dim_viewport_set (param $this i32) (param $lpVp i32)
    (local $entry i32) (local $dev_this i32) (local $state i32) (local $sw i32)
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
      (if (local.get $state) (then
        (local.set $sw (call $g2w (local.get $state)))
        (i32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_RECT)) (local.get $x))
        (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 4))) (local.get $y))
        (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 8))) (local.get $w))
        (i32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_RECT) (i32.const 12))) (local.get $h))
        (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_SCALE))
          (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0)))
        (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 4)))
          (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0)))
        (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 8))) (f32.const 0.0))
        (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_SCALE) (i32.const 12))) (f32.const 1.0))
        (f32.store (i32.add (local.get $sw) (global.get $D3DIM_OFF_VP_ORIGIN))
          (f32.add (f32.convert_i32_s (local.get $x))
                   (f32.div (f32.convert_i32_s (local.get $w)) (f32.const 2.0))))
        (f32.store (i32.add (local.get $sw) (i32.add (global.get $D3DIM_OFF_VP_ORIGIN) (i32.const 4)))
          (f32.add (f32.convert_i32_s (local.get $y))
                   (f32.div (f32.convert_i32_s (local.get $h)) (f32.const 2.0))))))))
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
    (local $sw i32) (local $vec_wa i32) (local $clip_wa i32) (local $inv_w f32)
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
    ;; inv_w = 1 / w  (guard against w==0 with a tiny epsilon)
    (local.set $inv_w (f32.load (i32.add (local.get $clip_wa) (i32.const 12))))
    (if (f32.eq (local.get $inv_w) (f32.const 0)) (then (local.set $inv_w (f32.const 0.0000001))))
    (local.set $inv_w (f32.div (f32.const 1.0) (local.get $inv_w)))
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
    (f32.store (i32.add (local.get $vout_wa) (i32.const 12)) (local.get $inv_w)))

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

  ;; Allocate (or reuse) a guest-heap z-buffer sized to RT (f32 per pixel).
  ;; Stored at state +D3DIM_OFF_ZBUF_SLOT (we store guest ptr, NOT a DX slot —
  ;; rename meaning: now ZBUF_PTR). Returns guest ptr (or 0 if no RT).
  (func $d3dim_ensure_zbuffer (param $this_guest i32) (result i32)
    (local $state i32) (local $rt i32) (local $w i32) (local $h i32)
    (local $bytes i32) (local $zbuf i32) (local $sw i32)
    (local.set $state (call $d3ddev_state (local.get $this_guest)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $sw (call $g2w (local.get $state)))
    (local.set $zbuf (i32.load (i32.add (local.get $sw) (global.get $D3DIM_OFF_ZBUF_SLOT))))
    (if (local.get $zbuf) (then (return (local.get $zbuf))))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this_guest)))
    (if (i32.eqz (local.get $rt)) (then (return (i32.const 0))))
    (local.set $w (i32.and (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 0xFFFF)))
    (local.set $h (i32.shr_u (i32.load (i32.add (local.get $rt) (i32.const 12))) (i32.const 16)))
    (if (i32.or (i32.eqz (local.get $w)) (i32.eqz (local.get $h)))
      (then (return (i32.const 0))))
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
    (param $zval f32) (param $color i32)
    (local $sw i32) (local $sh i32) (local $bpp i32) (local $pitch i32) (local $dib_wa i32)
    (local $zbuf_wa i32) (local $row i32) (local $col i32) (local $row_wa i32)
    (local $px16 i32) (local $zptr i32)
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
    (local.set $zbuf_wa (call $g2w (local.get $zbuf_guest)))
    (if (i32.or (i32.eqz (local.get $dib_wa)) (i32.eqz (local.get $zbuf_wa))) (then (return)))
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
        (local.set $zptr (i32.add (local.get $zbuf_wa)
          (i32.mul
            (i32.add
              (i32.mul (i32.add (local.get $y) (local.get $row)) (local.get $sw))
              (i32.add (local.get $x) (local.get $col)))
            (i32.const 4))))
        (if (f32.lt (local.get $zval) (f32.load (local.get $zptr))) (then
          (f32.store (local.get $zptr) (local.get $zval))
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

  ;; Fill the z-buffer (whole RT-sized f32 plane) with `zval`.
  (func $zbuffer_fill (param $zbuf_guest i32) (param $w i32) (param $h i32) (param $zval f32)
    (local $i i32) (local $n i32) (local $wa i32)
    (if (i32.eqz (local.get $zbuf_guest)) (then (return)))
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
    (local $zbuf i32) (local $rtw i32) (local $rth i32)
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
      (call $viewport_fill_rect (local.get $rt) (local.get $vx) (local.get $vy)
        (local.get $vw) (local.get $vh) (local.get $color))))
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
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $x0 i32) (param $y0 i32) (param $z0 f32)
    (param $x1 i32) (param $y1 i32) (param $z1 f32)
    (param $x2 i32) (param $y2 i32) (param $z2 f32)
    (param $color i32)
    (local $state i32) (local $zbuf i32) (local $zval f32) (local $alpha i32) (local $blend i32)
    ;; Disable culling until the software path has full clip/winding parity.
    ;; D3DRM meshes otherwise disappear when their explicit cull mode disagrees
    ;; with our current screen-space winding convention.
    (if (local.get $use_z) (then
      (local.set $state (call $d3ddev_state (local.get $this)))
      (if (local.get $state) (then
        (if (call $gl32 (i32.add (local.get $state) (i32.const 284))) (then
          (local.set $zbuf
            (i32.load (i32.add (call $g2w (local.get $state)) (global.get $D3DIM_OFF_ZBUF_SLOT))))))))))
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
      (local.get $zbuf) (local.get $zval)))

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
    (param $zbuf_guest i32) (param $zval f32)
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
          (i32.const 1) (local.get $zval) (local.get $color)))
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
          (i32.const 1) (local.get $zval) (local.get $color)))
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
    (local $col i32)
    (if (i32.or (i32.eqz (local.get $lpvVertices)) (i32.eqz (local.get $dwVertexCount)))
      (then (return)))
    ;; Fail-fast on non-TLVERTEX — until the WVP pipeline is wired into
    ;; DrawPrimitive, untransformed vertices would render as noise. The
    ;; crash_unimplemented log names which app hit it and at what EIP.
    (if (i32.ne (local.get $vtxType) (i32.const 3))
      (then (call $crash_unimplemented (global.get $D3DIM_UNIMPL_DRAW))))
    (local.set $rt (call $d3ddev_rt_entry (local.get $this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $v_wa (call $g2w (local.get $lpvVertices)))
    (if (i32.eq (local.get $primType) (i32.const 1)) (then
      ;; POINTLIST — keep prior dot-plot behavior
      (local.set $i (i32.const 0))
      (block $pdone (loop $plp
        (br_if $pdone (i32.ge_u (local.get $i) (local.get $dwVertexCount)))
        (local.set $v0 (i32.add (local.get $v_wa) (i32.mul (local.get $i) (i32.const 32))))
        (call $viewport_fill_rect (local.get $rt)
          (i32.trunc_f32_s (f32.load (local.get $v0)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (i32.const 2) (i32.const 2)
          (i32.load (i32.add (local.get $v0) (i32.const 16))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $plp)))
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
        (local.set $x0 (i32.trunc_f32_s (f32.load (local.get $v0))))
        (local.set $y0 (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4)))))
        (local.set $x1 (i32.trunc_f32_s (f32.load (local.get $v1))))
        (local.set $y1 (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4)))))
        (local.set $x2 (i32.trunc_f32_s (f32.load (local.get $v2))))
        (local.set $y2 (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4)))))
        (local.set $col (i32.load (i32.add (local.get $v0) (i32.const 16))))
        (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (i32.const 0)
          (local.get $x0) (local.get $y0)
          (f32.load (i32.add (local.get $v0) (i32.const 8)))
          (local.get $x1) (local.get $y1)
          (f32.load (i32.add (local.get $v1) (i32.const 8)))
          (local.get $x2) (local.get $y2)
          (f32.load (i32.add (local.get $v2) (i32.const 8)))
          (local.get $col))
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
        (local.set $x0 (i32.trunc_f32_s (f32.load (local.get $v0))))
        (local.set $y0 (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4)))))
        (local.set $x1 (i32.trunc_f32_s (f32.load (local.get $v1))))
        (local.set $y1 (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4)))))
        (local.set $x2 (i32.trunc_f32_s (f32.load (local.get $v2))))
        (local.set $y2 (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4)))))
        (local.set $col (i32.load (i32.add (local.get $v0) (i32.const 16))))
        ;; Odd i in a strip has inverted winding — swap v0/v1 so the cull test
        ;; sees a consistent front/back sign.
        (if (i32.and (local.get $i) (i32.const 1))
          (then
            (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (i32.const 0)
              (local.get $x1) (local.get $y1)
              (f32.load (i32.add (local.get $v1) (i32.const 8)))
              (local.get $x0) (local.get $y0)
              (f32.load (i32.add (local.get $v0) (i32.const 8)))
              (local.get $x2) (local.get $y2)
              (f32.load (i32.add (local.get $v2) (i32.const 8)))
              (local.get $col)))
          (else
            (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (i32.const 0)
              (local.get $x0) (local.get $y0)
              (f32.load (i32.add (local.get $v0) (i32.const 8)))
              (local.get $x1) (local.get $y1)
              (f32.load (i32.add (local.get $v1) (i32.const 8)))
              (local.get $x2) (local.get $y2)
              (f32.load (i32.add (local.get $v2) (i32.const 8)))
              (local.get $col))))
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
        (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (i32.const 0)
          (i32.trunc_f32_s (f32.load (local.get $v0)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (f32.load (i32.add (local.get $v0) (i32.const 8)))
          (i32.trunc_f32_s (f32.load (local.get $v1)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4))))
          (f32.load (i32.add (local.get $v1) (i32.const 8)))
          (i32.trunc_f32_s (f32.load (local.get $v2)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4))))
          (f32.load (i32.add (local.get $v2) (i32.const 8)))
          (i32.load (i32.add (local.get $v0) (i32.const 16))))
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
        (local.set $spec  (i32.load (i32.add (local.get $src_wa) (i32.const 20)))))
      (else
        (local.set $color (call $d3dim_vertex_lit_color (local.get $state_guest) (local.get $src_wa)))
        (local.set $spec  (i32.const 0))))
    (local.set $tu (i32.load (i32.add (local.get $src_wa) (i32.const 24))))
    (local.set $tv (i32.load (i32.add (local.get $src_wa) (i32.const 28))))
    (call $vertex_project (local.get $state_guest) (local.get $src_wa) (local.get $dst_wa))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 16)) (local.get $color))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 20)) (local.get $spec))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 24)) (local.get $tu))
    (i32.store (i32.add (local.get $dst_wa) (i32.const 28)) (local.get $tv)))

  (func $d3dim_prepare_indexed_vertex
    (param $state_guest i32) (param $vbase_wa i32) (param $ibase_wa i32)
    (param $dwVertexCount i32) (param $vtxType i32) (param $idx_pos i32) (param $dst_wa i32)
    (result i32)
    (local $idx i32) (local $src i32)
    (local.set $idx
      (i32.load16_u (i32.add (local.get $ibase_wa) (i32.mul (local.get $idx_pos) (i32.const 2)))))
    (if (i32.ge_u (local.get $idx) (local.get $dwVertexCount)) (then (return (i32.const 0))))
    (local.set $src (i32.add (local.get $vbase_wa) (i32.mul (local.get $idx) (i32.const 32))))
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
    (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (i32.const 0)
      (i32.trunc_f32_s (f32.load (local.get $t0)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $t0) (i32.const 4))))
      (f32.load (i32.add (local.get $t0) (i32.const 8)))
      (i32.trunc_f32_s (f32.load (local.get $t1)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $t1) (i32.const 4))))
      (f32.load (i32.add (local.get $t1) (i32.const 8)))
      (i32.trunc_f32_s (f32.load (local.get $t2)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $t2) (i32.const 4))))
      (f32.load (i32.add (local.get $t2) (i32.const 8)))
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
    (local.set $vbase_wa (call $g2w (local.get $lpvVertices)))
    (local.set $ibase_wa (call $g2w (local.get $lpwIndices)))
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
    (i32.store (i32.add (local.get $out) (i32.const 16)) (i32.load (i32.add (local.get $a) (i32.const 16))))
    (i32.store (i32.add (local.get $out) (i32.const 20)) (i32.load (i32.add (local.get $a) (i32.const 20))))
    (i32.store (i32.add (local.get $out) (i32.const 24)) (i32.load (i32.add (local.get $a) (i32.const 24))))
    (i32.store (i32.add (local.get $out) (i32.const 28)) (i32.load (i32.add (local.get $a) (i32.const 28)))))

  (func $d3dim_draw_tl_triangle
    (param $this i32) (param $rt i32) (param $use_z i32)
    (param $v0 i32) (param $v1 i32) (param $v2 i32)
    (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt) (local.get $use_z)
      (i32.trunc_f32_s (f32.load (local.get $v0)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4))))
      (f32.load (i32.add (local.get $v0) (i32.const 8)))
      (i32.trunc_f32_s (f32.load (local.get $v1)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4))))
      (f32.load (i32.add (local.get $v1) (i32.const 8)))
      (i32.trunc_f32_s (f32.load (local.get $v2)))
      (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4))))
      (f32.load (i32.add (local.get $v2) (i32.const 8)))
      (i32.load (i32.add (local.get $v0) (i32.const 16)))))

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
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $rt (call $d3ddev_rt_entry (local.get $dev_this)))
    (if (i32.eqz (local.get $rt)) (then (return)))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
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
      (if (i32.eq (local.get $pos) (i32.const 3)) (then
        (call $d3dim_draw_tl_triangle
          (local.get $dev_this) (local.get $rt) (i32.const 1)
          (local.get $v0) (local.get $v1) (local.get $v2))))
      (if (i32.ne (local.get $pos) (i32.const 3)) (then
        (local.set $state (call $d3ddev_state (local.get $dev_this)))
        (if (i32.eqz (local.get $state)) (then
          (local.set $rec_wa (i32.add (local.get $rec_wa) (i32.const 8)))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $lp)))
        (local.set $sw (call $g2w (local.get $state)))
        (local.set $c0 (i32.add (local.get $sw) (i32.const 3296)))
        (local.set $c1 (i32.add (local.get $sw) (i32.const 3328)))
        (if (i32.eq (local.get $pos) (i32.const 1)) (then
          (if (local.get $p0) (then
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v1) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $c0) (local.get $c1))))
          (if (local.get $p1) (then
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v2) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $c0) (local.get $c1))))
          (if (local.get $p2) (then
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v0) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $c0) (local.get $c1))))))
        (if (i32.eq (local.get $pos) (i32.const 2)) (then
          (if (i32.eqz (local.get $p0)) (then
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v0) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v1) (local.get $c1) (local.get $c0))))
          (if (i32.eqz (local.get $p1)) (then
            (call $d3dim_interp_tl_vertex (local.get $v2) (local.get $v1) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $v0) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v2) (local.get $c1) (local.get $c0))))
          (if (i32.eqz (local.get $p2)) (then
            (call $d3dim_interp_tl_vertex (local.get $v0) (local.get $v2) (local.get $c0))
            (call $d3dim_interp_tl_vertex (local.get $v1) (local.get $v2) (local.get $c1))
            (call $d3dim_draw_tl_triangle
              (local.get $dev_this) (local.get $rt) (i32.const 1)
              (local.get $v0) (local.get $v1) (local.get $c1))
            (call $d3dim_draw_tl_triangle
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
          (i32.trunc_f32_s (f32.load (local.get $v)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v) (i32.const 4))))
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
        (i32.trunc_f32_s (f32.load (local.get $v1)))
        (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4))))
        (i32.trunc_f32_s (f32.load (local.get $v2)))
        (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4))))
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
    (local $tu i32) (local $tv i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $state_g (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_g)) (then (return)))
    (call $d3ddev_composite_wvp (local.get $state_g))
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
      (local.set $j (i32.const 0))
      (block $vdone (loop $vlp
        (br_if $vdone (i32.ge_u (local.get $j) (local.get $cnt)))
        (local.set $src (i32.add (local.get $srcbase)
          (i32.mul (i32.add (local.get $wStart) (local.get $j)) (i32.const 32))))
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
                (local.set $spec  (i32.load (i32.add (local.get $src) (i32.const 20)))))
              (else
                (local.set $color (call $d3dim_vertex_lit_color (local.get $state_g) (local.get $src)))
                (local.set $spec  (i32.const 0))))
            (local.set $tu (i32.load (i32.add (local.get $src) (i32.const 24))))
            (local.set $tv (i32.load (i32.add (local.get $src) (i32.const 28))))
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
