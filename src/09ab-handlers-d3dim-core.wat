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
    ;; Since we don't track the D3D→DDraw back-reference, scan DX_OBJECTS for
    ;; the first type=1 (DDraw) entry. d3drm.dll uses this to get the DDraw
    ;; back from a D3D interface; failing it causes a NULL-vtable Release crash.
    (if (i32.and (i32.eq (local.get $family) (i32.const 1))
                 (i32.eq (local.get $iid0) (i32.const 0x6C14DB80))) (then
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
      (local.set $obj_wa (call $g2w (local.get $this)))
      (local.set $vtbl (i32.load (local.get $obj_wa)))))
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
    (global.set $eax (i32.const 0)))

  ;; ── State-block forwarders ────────────────────────────────────
  ;; Mirror IDirect3DDevice3_SetTransform / SetRenderState / SetLightState
  ;; bodies inline (we can't easily call the existing handlers because they
  ;; manage ESP themselves).
  (func $d3dim_set_transform (param $this i32) (param $xtype i32) (param $lpmat i32)
    (local $state i32) (local $slot i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0)) (local.get $lpmat)) (then
      (local.set $slot (call $d3ddev_matrix_slot (local.get $xtype)))
      (call $memcpy
        (call $g2w (i32.add (local.get $state) (i32.mul (local.get $slot) (i32.const 64))))
        (call $g2w (local.get $lpmat))
        (i32.const 64))))
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
      (i32.store (i32.add (local.get $state) (global.get $D3DIM_OFF_TEX_STAGE)) (local.get $slot))))
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
    (local $state i32) (local $slot i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.eqz (local.get $state)) (then (global.set $eax (i32.const 0)) (return)))
    (if (local.get $lpVp)
      (then (local.set $slot (call $dx_slot_of (call $dx_from_this (local.get $lpVp)))))
      (else (local.set $slot (i32.const 0))))
    (i32.store (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP)) (local.get $slot))
    (global.set $eax (i32.const 0)))

  (func $d3dim_get_current_viewport (param $this i32) (param $ppVp i32)
    (local $state i32) (local $slot i32) (local $obj_guest i32)
    (local.set $state (call $d3ddev_state (local.get $this)))
    (if (i32.or (i32.eqz (local.get $state)) (i32.eqz (local.get $ppVp)))
      (then (global.set $eax (i32.const 0)) (return)))
    (local.set $slot (i32.load (i32.add (local.get $state) (global.get $D3DIM_OFF_CUR_VP))))
    ;; reconstruct guest ptr from slot: COM_WRAPPERS + slot*8 → guest addr
    (local.set $obj_guest (i32.add
      (i32.sub (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8)))
               (global.get $GUEST_BASE))
      (global.get $image_base)))
    (call $gs32 (local.get $ppVp) (local.get $obj_guest))
    (global.set $eax (i32.const 0)))

  ;; ── Viewport rect get/set ─────────────────────────────────────
  ;; SetViewport(lpD3DVIEWPORT) — D3DVIEWPORT2 is 60 bytes; first 16 are
  ;; dwSize, dwX, dwY, dwWidth (i32 each). We just memcpy 16 bytes into
  ;; the viewport rect slot. SetViewport2 uses the same field layout for
  ;; the rect, so they share this code.
  (func $d3dim_viewport_set (param $this i32) (param $lpVp i32)
    (local $entry i32) (local $vp_slot_state i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    ;; The viewport's "extra state" goes on the device's state block; here
    ;; we simply store the raw lpD3DVIEWPORT-style struct on the viewport
    ;; DX_OBJECTS entry's scratch (entry+12). 16 bytes for now.
    (local.set $entry (call $dx_from_this (local.get $this)))
    (i32.store          (i32.add (local.get $entry) (i32.const 12)) (call $gl32 (local.get $lpVp)))
    (i32.store          (i32.add (local.get $entry) (i32.const 16)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 4))))
    (i32.store          (i32.add (local.get $entry) (i32.const 20)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 8))))
    (i32.store          (i32.add (local.get $entry) (i32.const 24)) (call $gl32 (i32.add (local.get $lpVp) (i32.const 12))))
    (global.set $eax (i32.const 0)))

  (func $d3dim_viewport_get (param $this i32) (param $lpVp i32)
    (local $entry i32)
    (if (i32.eqz (local.get $lpVp)) (then (global.set $eax (i32.const 0)) (return)))
    (local.set $entry (call $dx_from_this (local.get $this)))
    (call $gs32 (local.get $lpVp)                                      (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 4))              (i32.load (i32.add (local.get $entry) (i32.const 16))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 8))              (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (call $gs32 (i32.add (local.get $lpVp) (i32.const 12))             (i32.load (i32.add (local.get $entry) (i32.const 24))))
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
