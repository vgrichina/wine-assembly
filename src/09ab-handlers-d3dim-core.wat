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
  ;; (room left up to +4096 for matrix scratch in Step 2)
  (global $D3DIM_OFF_CUR_VP    i32 (i32.const 2816))
  (global $D3DIM_OFF_CUR_MAT   i32 (i32.const 2820))
  (global $D3DIM_OFF_TEX_STAGE i32 (i32.const 2824))
  (global $D3DIM_OFF_ZBUF_SLOT i32 (i32.const 2828))
  (global $D3DIM_OFF_TSS_STATE i32 (i32.const 2832))
  (global $D3DIM_OFF_VP_RECT   i32 (i32.const 3088))
  (global $D3DIM_OFF_VP_SCALE  i32 (i32.const 3104))
  (global $D3DIM_OFF_VP_ORIGIN i32 (i32.const 3120))

  ;; Crash-name strings for unimplemented D3DIM paths. 01-header.wat uses
  ;; 0x100..0x2FB; 0x300..0x4000 is unused before the API hash table.
  (data (i32.const 0x340) "D3DIM:Execute opcode\00")
  (data (i32.const 0x360) "D3DIM:DrawPrimitive vtx/prim\00")
  (global $D3DIM_UNIMPL_EXEC_OP i32 (i32.const 0x340))
  (global $D3DIM_UNIMPL_DRAW    i32 (i32.const 0x360))

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

  (func $d3dim_set_transform (param $this i32) (param $xtype i32) (param $lpmat i32)
    (if (local.get $lpmat) (then
      (call $d3dim_apply_transform (local.get $this) (local.get $xtype)
        (call $g2w (local.get $lpmat)))))
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
    (local $state i32) (local $slot i32) (local $obj_guest i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.or (i32.eqz (local.get $state)) (i32.eqz (local.get $ppVp)))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $slot (call $gl32 (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP))))
    ;; reconstruct guest ptr from slot: COM_WRAPPERS + slot*8 → guest addr
    (local.set $obj_guest (i32.add
      (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (call $gs32 (local.get $ppVp) (local.get $obj_guest))
    (global.set $eax (i32.const 0)))

  ;; ── Viewport rect get/set ─────────────────────────────────────
  ;; SetViewport(lpD3DVIEWPORT) / SetViewport2(lpD3DVIEWPORT2) — first 20
  ;; bytes are identical in both: dwSize, dwX, dwY, dwWidth, dwHeight.
  ;; We stash those 5 dwords in DX_OBJECTS entry+12..+28. entry+8 is already
  ;; used by SetCurrentViewport to stash the parent device pointer, so we
  ;; can't touch it here. Remaining D3DVIEWPORT fields (dvScale/Max or
  ;; dvClip/dvMinZ/MaxZ) are returned zero — callers that care about them
  ;; should SetViewport with complete data first (we only persist the rect).
  (func $d3dim_viewport_set (param $this i32) (param $lpVp i32)
    (local $entry i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (i32.store          (i32.add (local.get $entry) (i32.const 12)) (call $gl32 (local.get $lpVp)))
    (i32.store          (i32.add (local.get $entry) (i32.const 16)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 4))))
    (i32.store          (i32.add (local.get $entry) (i32.const 20)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 8))))
    (i32.store          (i32.add (local.get $entry) (i32.const 24)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 12))))
    (i32.store          (i32.add (local.get $entry) (i32.const 28)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 16))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_get (param $this i32) (param $lpVp i32)
    (local $entry i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (call $gs32 (local.get $lpVp)                                      (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 4))              (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 8))              (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 12))             (i32.load (i32.add (local.get $entry) (i32.const 24))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 16))             (i32.load (i32.add (local.get $entry) (i32.const 28))))
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
    (local $sw i32) (local $tmp i32)
    (if (i32.eqz (local.get $state_guest)) (then (return)))
    (local.set $sw (call $g2w (local.get $state_guest)))
    ;; tmp (slot 3) = world * view ; then slot 3 = tmp * proj.
    (local.set $tmp (i32.add (local.get $sw) (i32.const 192)))
    (call $mat4_mul (local.get $tmp)
      (local.get $sw)                                  ;; world @ +0
      (i32.add (local.get $sw) (i32.const 64)))        ;; view  @ +64
    (call $mat4_mul (local.get $tmp)
      (local.get $tmp)
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

  ;; ── Back-face culling ─────────────────────────────────────────
  ;; D3DRENDERSTATE_CULLMODE (rs=22) stored at state+256+22*4 = state+344.
  ;; 0=uninit → treat as default D3DCULL_CCW. 1=NONE, 2=CW, 3=CCW.
  ;; Screen-space (Y-down) signed cross: >0 → CW on screen, <0 → CCW.
  ;; TLVERTEX are already in screen space, so front-facing = CW = cross>0.
  (func $d3dim_cull_tri (param $this i32)
    (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32) (param $x2 i32) (param $y2 i32)
    (result i32)
    (local $state i32) (local $mode i32) (local $cross i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (return (i32.const 0))))
    (local.set $mode (call $gl32 (i32.add (local.get $state) (i32.const 344))))
    (if (i32.eq (local.get $mode) (i32.const 1)) (then (return (i32.const 0))))
    (local.set $cross
      (i32.sub
        (i32.mul (i32.sub (local.get $x1) (local.get $x0)) (i32.sub (local.get $y2) (local.get $y0)))
        (i32.mul (i32.sub (local.get $x2) (local.get $x0)) (i32.sub (local.get $y1) (local.get $y0)))))
    (if (i32.eq (local.get $mode) (i32.const 2))
      (then (return (i32.gt_s (local.get $cross) (i32.const 0)))))
    (i32.lt_s (local.get $cross) (i32.const 0)))

  (func $d3dim_draw_tri_culled
    (param $this i32) (param $rt i32)
    (param $x0 i32) (param $y0 i32) (param $x1 i32) (param $y1 i32) (param $x2 i32) (param $y2 i32)
    (param $color i32)
    (if (call $d3dim_cull_tri (local.get $this)
          (local.get $x0) (local.get $y0) (local.get $x1) (local.get $y1) (local.get $x2) (local.get $y2))
      (then (return)))
    (call $rasterize_triangle_flat (local.get $rt)
      (local.get $x0) (local.get $y0)
      (local.get $x1) (local.get $y1)
      (local.get $x2) (local.get $y2)
      (local.get $color)))

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
      (call $viewport_fill_rect (local.get $rt_entry)
        (local.get $xl) (local.get $y0)
        (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
        (i32.const 1) (local.get $color))
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
      (call $viewport_fill_rect (local.get $rt_entry)
        (local.get $xl) (local.get $y)
        (i32.add (i32.sub (local.get $xr) (local.get $xl)) (i32.const 1))
        (i32.const 1) (local.get $color))
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
        (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt)
          (local.get $x0) (local.get $y0)
          (local.get $x1) (local.get $y1)
          (local.get $x2) (local.get $y2)
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
            (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt)
              (local.get $x1) (local.get $y1)
              (local.get $x0) (local.get $y0)
              (local.get $x2) (local.get $y2)
              (local.get $col)))
          (else
            (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt)
              (local.get $x0) (local.get $y0)
              (local.get $x1) (local.get $y1)
              (local.get $x2) (local.get $y2)
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
        (call $d3dim_draw_tri_culled (local.get $this) (local.get $rt)
          (i32.trunc_f32_s (f32.load (local.get $v0)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4))))
          (i32.trunc_f32_s (f32.load (local.get $v1)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4))))
          (i32.trunc_f32_s (f32.load (local.get $v2)))
          (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4))))
          (i32.load (i32.add (local.get $v0) (i32.const 16))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $flp))))) )

  ;; ── Execute-buffer triangle rasterizer ─────────────────────────
  ;; Walks wCount D3DTRIANGLE records (8 bytes each: u16 v1,v2,v3,flags) and
  ;; rasterizes each one by indexing into the vertex area of the exec buffer.
  ;; Treats vertices as D3DTLVERTEX (32 bytes) laid out from buf+0. Non-TL
  ;; vertices render with whatever bytes happen to occupy the x/y/color slots —
  ;; acceptable MVP, will be fixed by a proper PROCESSVERTICES cache later.
  (func $d3dim_exec_triangles
    (param $dev_this i32) (param $buf_guest i32) (param $rec_wa i32) (param $wCount i32)
    (local $rt i32) (local $vbase i32) (local $i i32)
    (local $iv0 i32) (local $iv1 i32) (local $iv2 i32)
    (local $v0 i32) (local $v1 i32) (local $v2 i32)
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
      (call $d3dim_draw_tri_culled (local.get $dev_this) (local.get $rt)
        (i32.trunc_f32_s (f32.load (local.get $v0)))
        (i32.trunc_f32_s (f32.load (i32.add (local.get $v0) (i32.const 4))))
        (i32.trunc_f32_s (f32.load (local.get $v1)))
        (i32.trunc_f32_s (f32.load (i32.add (local.get $v1) (i32.const 4))))
        (i32.trunc_f32_s (f32.load (local.get $v2)))
        (i32.trunc_f32_s (f32.load (i32.add (local.get $v2) (i32.const 4))))
        (i32.load (i32.add (local.get $v0) (i32.const 16))))
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
    (local $state_g i32) (local $vbase i32)
    (local $i i32) (local $mode i32) (local $wStart i32) (local $wDest i32) (local $cnt i32)
    (local $j i32) (local $src i32) (local $dst i32) (local $color i32) (local $spec i32)
    (local $tu i32) (local $tv i32)
    (if (i32.or (i32.eqz (local.get $buf_guest)) (i32.eqz (local.get $wCount))) (then (return)))
    (local.set $state_g (call $d3ddev_state (local.get $dev_this)))
    (if (i32.eqz (local.get $state_g)) (then (return)))
    (call $d3ddev_composite_wvp (local.get $state_g))
    (local.set $vbase (call $g2w (local.get $buf_guest)))
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
        (local.set $src (i32.add (local.get $vbase)
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
                (local.set $color (i32.const 0xFFFFFFFF))
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
            (then (call $d3dim_apply_transform
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
