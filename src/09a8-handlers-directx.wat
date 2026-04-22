  ;; ============================================================
  ;; DIRECTX HANDLERS — DirectDraw, DirectSound, DirectInput
  ;; COM vtable dispatch via thunk zone (reuses existing IAT infra)
  ;; ============================================================

  ;; ── DX_OBJECTS table ─────────────────────────────────────────
  ;; 256 entries × 32 bytes at 0x07FF0000 (high memory, safe from guest writes)
  ;; +0  type: 0=free,1=DDraw,2=DDSurface,3=DDPalette,4=DSound,5=DSBuffer,6=DInput,7=DIDev
  ;; +4  refcount
  ;; +8  misc0 (DDraw: hwnd, DSBuffer: wave_handle, DIDev: device_type 1=kbd 2=mouse)
  ;; +12 width (u16) | height (u16)
  ;; +16 bpp (u16) | pitch (u16)
  ;; +20 dib_ptr (WASM addr of pixel data, 0 if none)
  ;; +24 color_key_low
  ;; +28 flags (surface type: 1=primary,2=backbuf,4=offscreen; 0x100=has_colorkey)
  (global $DX_OBJECTS i32 (i32.const 0x07FF0000))
  (global $DX_MAX i32 (i32.const 1024))
  (global $DX_ENTRY_SIZE i32 (i32.const 32))
  ;; COM wrapper stubs: DX_MAX × 8 bytes in high memory (safe from guest address collision)
  (global $COM_WRAPPERS i32 (i32.const 0x07FF8000))
  ;; Auxiliary wrappers for QueryInterface results that need a different vtable
  ;; than the primary wrapper. Each entry is [vtbl, slot], same shape as the
  ;; primary wrappers so $dx_from_this works for aux guest ptrs too. Dedup'd
  ;; by (slot, vtbl) via linear scan.
  (global $COM_WRAPPERS_AUX  i32 (i32.const 0x07FFA000))
  (global $COM_WRAPPERS_AUX_MAX i32 (i32.const 2048))
  (global $com_aux_next (mut i32) (i32.const 0))

  ;; Vtable blocks — arrays of thunk guest-addrs, one per interface type.
  ;; Must be in guest-reachable memory (above image_base), so allocated from heap.
  ;; These globals store the GUEST address of each vtable block (set by init_dx_com_thunks).
  (global $DX_VTBL_DDRAW      (mut i32) (i32.const 0))
  (global $DX_VTBL_DDSURF     (mut i32) (i32.const 0))
  (global $DX_VTBL_DDPAL      (mut i32) (i32.const 0))
  (global $DX_VTBL_DSOUND     (mut i32) (i32.const 0))
  (global $DX_VTBL_DSBUF      (mut i32) (i32.const 0))
  (global $DX_VTBL_DINPUT     (mut i32) (i32.const 0))
  (global $DX_VTBL_DIDEV      (mut i32) (i32.const 0))
  (global $DX_VTBL_D3D        (mut i32) (i32.const 0))
  (global $DX_VTBL_D3D3       (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DDEV3    (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DVP3     (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DLIGHT   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DMAT3    (mut i32) (i32.const 0))
  (global $DX_VTBL_DDFACTORY  (mut i32) (i32.const 0))
  (global $DX_VTBL_DDRAW2    (mut i32) (i32.const 0))
  (global $DX_VTBL_DDSURF2   (mut i32) (i32.const 0))
  (global $DX_VTBL_DDCLIP    (mut i32) (i32.const 0))
  ;; Direct3D Immediate Mode vtables (Phase 0+ — populated by $init_dx_com_thunks)
  (global $DX_VTBL_D3D2      (mut i32) (i32.const 0))
  (global $DX_VTBL_D3D7      (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DDEV1   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DDEV2   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DDEV7   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DVP1    (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DVP2    (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DMAT1   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DMAT2   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DEXEC   (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DVB     (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DVB7    (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DTEX    (mut i32) (i32.const 0))
  (global $DX_VTBL_D3DTEX2   (mut i32) (i32.const 0))

  ;; DirectDraw display mode (set by SetDisplayMode)
  (global $dx_display_w (mut i32) (i32.const 640))
  (global $dx_display_h (mut i32) (i32.const 480))
  (global $dx_display_bpp (mut i32) (i32.const 16))

  ;; Running tally of bytes allocated to DirectDraw surfaces. MCM measures
  ;; GetAvailableVidMem delta across CreateSurface/Release to detect texture
  ;; footprint; must move in response to allocations.
  (global $dx_vidmem_used (mut i32) (i32.const 0))

  ;; Most-recently-created IDirectDraw guest ptr; IDirectDrawSurface2::GetDDInterface
  ;; returns it so apps like flip3dtl can navigate from RT surface back to DDraw.
  (global $dx_ddraw_this (mut i32) (i32.const 0))

  ;; DirectInput mouse tracking (for relative dx/dy)
  (global $di_mouse_last_x (mut i32) (i32.const 0))
  (global $di_mouse_last_y (mut i32) (i32.const 0))

  ;; WASM address of the palette data for the primary surface (256 RGBQUAD entries)
  ;; Set by IDirectDrawSurface::SetPalette
  (global $dx_primary_pal_wa (mut i32) (i32.const 0))

  ;; EnumDisplayModes continuation state
  (global $enum_modes_idx (mut i32) (i32.const 0))       ;; current mode index
  (global $enum_modes_callback (mut i32) (i32.const 0))  ;; callback guest addr
  (global $enum_modes_context (mut i32) (i32.const 0))   ;; lpContext
  (global $enum_modes_ddsd (mut i32) (i32.const 0))      ;; DDSURFACEDESC guest addr
  (global $enum_modes_ret (mut i32) (i32.const 0))       ;; saved caller return addr
  (global $enum_modes_thunk (mut i32) (i32.const 0))     ;; CACA0008 thunk guest addr

  ;; ── Helper: allocate a DX object ─────────────────────────────
  ;; Returns WASM addr of entry, or 0 if full
  (func $dx_alloc (param $type i32) (result i32)
    (local $i i32) (local $ptr i32) (local $wrapper_wa i32)
    (local.set $i (i32.const 0))
    (block $done (loop $scan
      (br_if $done (i32.ge_u (local.get $i) (global.get $DX_MAX)))
      (local.set $ptr (i32.add (global.get $DX_OBJECTS)
        (i32.mul (local.get $i) (i32.const 32))))
      ;; Slot must be free (type==0) AND have no live COM wrapper (we never
      ;; reuse a slot whose wrapper was ever handed to the guest, to avoid
      ;; ABA bugs — some DX APIs AddRef refs we don't track, so dangling
      ;; guest pointers can outlive our refcount).
      (local.set $wrapper_wa (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.and (i32.eqz (i32.load (local.get $ptr)))
                   (i32.eqz (i32.load (local.get $wrapper_wa))))
        (then
          (call $zero_memory (local.get $ptr) (i32.const 32))
          (i32.store (local.get $ptr) (local.get $type))
          (i32.store (i32.add (local.get $ptr) (i32.const 4)) (i32.const 1)) ;; refcount=1
          (return (local.get $ptr))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)))
    (i32.const 0))

  ;; ── Helper: find DX object by guest ptr ──────────────────────
  ;; The guest ptr IS the DX_OBJECTS WASM addr (objects live below GUEST_BASE
  ;; so guest addresses equal WASM addresses in our flat model).
  ;; Wait — objects are below GUEST_BASE, so they don't have a guest address.
  ;; We need to give the guest a *guest-space* pointer. Let's use heap_alloc
  ;; for the COM object wrapper (just [lpVtbl] at offset 0) and store the
  ;; DX_OBJECTS slot index at wrapper+4 (or in the DX_OBJECTS entry itself).
  ;;
  ;; Actually simpler: the "guest object" is a tiny heap block:
  ;;   +0: lpVtbl (guest addr of vtable)
  ;;   +4: dx_slot (index 0..31 into DX_OBJECTS)
  ;; When the guest calls a COM method, "this" is arg0 on the stack.
  ;; We read dx_slot from this+4 to find the DX_OBJECTS entry.

  ;; Look up DX_OBJECTS entry from guest "this" pointer
  (func $dx_from_this (param $this_guest i32) (result i32)
    (local $wa i32) (local $slot i32)
    (local.set $wa (call $g2w (local.get $this_guest)))
    (local.set $slot (i32.load (i32.add (local.get $wa) (i32.const 4))))
    ;; Sanity: if slot is wild, log this+slot and clamp to 0 to avoid OOB trap.
    (if (i32.ge_u (local.get $slot) (global.get $DX_MAX)) (then
      (call $host_log_i32 (i32.const 0xDEADC0DE))
      (call $host_log_i32 (local.get $this_guest))
      (call $host_log_i32 (local.get $slot))
      (local.set $slot (i32.const 0))))
    (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 32))))

  ;; Compute slot index from a DX_OBJECTS entry WASM address.
  (func $dx_slot_of (param $entry_wa i32) (result i32)
    (i32.div_u (i32.sub (local.get $entry_wa) (global.get $DX_OBJECTS)) (i32.const 32)))

  ;; Return a guest pointer to a COM wrapper that reports the given vtbl and
  ;; points to the given DX_OBJECTS slot. If slot's primary wrapper already
  ;; has that vtbl, return it; otherwise find/alloc an aux wrapper with it.
  ;; Never mutates the primary wrapper's vtbl (callers may hold cached copies
  ;; of the primary wrapper pointer and expect its vtbl to be stable).
  (func $dx_get_wrapper_for_vtbl (param $slot i32) (param $vtbl_guest i32) (result i32)
    (local $primary_wa i32) (local $aux_wa i32) (local $i i32) (local $n i32)
    (local.set $primary_wa (i32.add (global.get $COM_WRAPPERS)
      (i32.mul (local.get $slot) (i32.const 8))))
    ;; Primary hit?
    (if (i32.eq (i32.load (local.get $primary_wa)) (local.get $vtbl_guest)) (then
      (return (i32.add (i32.sub (local.get $primary_wa) (global.get $GUEST_BASE))
                       (global.get $image_base)))))
    ;; Scan aux pool for (vtbl, slot) match.
    (local.set $n (global.get $com_aux_next))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $aux_wa (i32.add (global.get $COM_WRAPPERS_AUX)
        (i32.mul (local.get $i) (i32.const 8))))
      (if (i32.and
            (i32.eq (i32.load (local.get $aux_wa)) (local.get $vtbl_guest))
            (i32.eq (i32.load (i32.add (local.get $aux_wa) (i32.const 4))) (local.get $slot)))
        (then (return (i32.add (i32.sub (local.get $aux_wa) (global.get $GUEST_BASE))
                               (global.get $image_base)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    ;; Miss — bump allocate.
    (if (i32.ge_u (local.get $n) (global.get $COM_WRAPPERS_AUX_MAX)) (then
      ;; Pool exhausted; fall back to primary and mutate (legacy behavior).
      (i32.store (local.get $primary_wa) (local.get $vtbl_guest))
      (return (i32.add (i32.sub (local.get $primary_wa) (global.get $GUEST_BASE))
                       (global.get $image_base)))))
    (local.set $aux_wa (i32.add (global.get $COM_WRAPPERS_AUX)
      (i32.mul (local.get $n) (i32.const 8))))
    (i32.store (local.get $aux_wa) (local.get $vtbl_guest))
    (i32.store (i32.add (local.get $aux_wa) (i32.const 4)) (local.get $slot))
    (global.set $com_aux_next (i32.add (local.get $n) (i32.const 1)))
    (i32.add (i32.sub (local.get $aux_wa) (global.get $GUEST_BASE))
             (global.get $image_base)))

  ;; Create a guest COM object using fixed COM_WRAPPERS area (not guest heap).
  ;; vtbl_guest is the guest address of the vtable (from DX_VTBL_* globals)
  ;; Returns guest address of the object
  (func $dx_create_com_obj (param $type i32) (param $vtbl_guest i32) (result i32)
    (local $entry_wa i32) (local $slot i32) (local $obj_wa i32)
    ;; Allocate DX_OBJECTS entry
    (local.set $entry_wa (call $dx_alloc (local.get $type)))
    (if (i32.eqz (local.get $entry_wa)) (then (return (i32.const 0))))
    ;; Compute slot index
    (local.set $slot (i32.div_u
      (i32.sub (local.get $entry_wa) (global.get $DX_OBJECTS))
      (i32.const 32)))
    ;; COM wrapper at fixed WASM address: COM_WRAPPERS + slot * 8
    (local.set $obj_wa (i32.add (global.get $COM_WRAPPERS) (i32.mul (local.get $slot) (i32.const 8))))
    ;; Write lpVtbl (already a guest address)
    (i32.store (local.get $obj_wa) (local.get $vtbl_guest))
    ;; Write slot index
    (i32.store (i32.add (local.get $obj_wa) (i32.const 4)) (local.get $slot))
    ;; Return guest address: WASM_addr - GUEST_BASE + image_base
    (i32.add (i32.sub (local.get $obj_wa) (global.get $GUEST_BASE)) (global.get $image_base)))

  ;; Free a DX object. Keeps the COM wrapper (vtbl+slot) intact so dangling
  ;; guest ptrs still dispatch to valid handlers — some DX apps hold refs we
  ;; don't track (AddRef not propagated by every handler yet). The slot is
  ;; permanently retired: $dx_alloc skips slots with a live wrapper, even
  ;; when the DX_OBJECTS entry type is 0.
  (func $dx_free (param $entry_wa i32)
    ;; Zero the DX_OBJECTS entry type (marks it logically freed; wrapper stays).
    (i32.store (local.get $entry_wa) (i32.const 0)))

  ;; ── Init COM vtables ─────────────────────────────────────────
  ;; Allocate thunks for each COM method and populate the vtable blocks.
  ;; Called once from JS before guest code runs (via an exported init fn).
  ;; Each vtable entry gets a thunk in THUNK_BASE with:
  ;;   thunk+0 = marker 0xCACA0010 (COM method marker)
  ;;   thunk+4 = api_id of the COM method
  ;; $win32_dispatch reads the api_id and dispatches normally.

  ;; Allocate a vtable block from heap and fill it with thunk addresses.
  ;; Returns the guest address of the vtable.
  (func $init_com_vtable (param $base_api_id i32) (param $count i32) (result i32)
    (local $i i32) (local $thunk_wa i32) (local $thunk_guest i32)
    (local $vtbl_guest i32) (local $vtbl_wa i32)
    ;; Allocate vtable from heap (count * 4 bytes)
    (local.set $vtbl_guest (call $heap_alloc (i32.mul (local.get $count) (i32.const 4))))
    (local.set $vtbl_wa (call $g2w (local.get $vtbl_guest)))
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $count)))
      ;; Compute thunk WASM addr
      (local.set $thunk_wa (i32.add (global.get $THUNK_BASE)
        (i32.mul (global.get $num_thunks) (i32.const 8))))
      ;; Write COM marker as name_rva
      (i32.store (local.get $thunk_wa) (i32.const 0xCACA0010))
      ;; Write api_id
      (i32.store (i32.add (local.get $thunk_wa) (i32.const 4))
        (i32.add (local.get $base_api_id) (local.get $i)))
      ;; Compute guest address of this thunk
      (local.set $thunk_guest (i32.add
        (i32.sub (local.get $thunk_wa) (global.get $GUEST_BASE))
        (global.get $image_base)))
      ;; Write guest thunk addr into vtable slot
      (i32.store (i32.add (local.get $vtbl_wa) (i32.mul (local.get $i) (i32.const 4)))
        (local.get $thunk_guest))
      (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (call $update_thunk_end)
    (local.get $vtbl_guest))

  ;; Extend a parent vtable: copy parent entries, append new thunks for extra methods.
  (func $extend_com_vtable (param $parent_vtbl i32) (param $parent_count i32)
                           (param $ext_api_id i32) (param $total_count i32) (result i32)
    (local $vtbl_guest i32) (local $vtbl_wa i32) (local $parent_wa i32)
    (local $i i32) (local $thunk_wa i32) (local $thunk_guest i32)
    (local.set $vtbl_guest (call $heap_alloc (i32.mul (local.get $total_count) (i32.const 4))))
    (local.set $vtbl_wa (call $g2w (local.get $vtbl_guest)))
    (local.set $parent_wa (call $g2w (local.get $parent_vtbl)))
    (call $memcpy (local.get $vtbl_wa) (local.get $parent_wa)
      (i32.mul (local.get $parent_count) (i32.const 4)))
    (local.set $i (local.get $parent_count))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (local.get $total_count)))
      (local.set $thunk_wa (i32.add (global.get $THUNK_BASE)
        (i32.mul (global.get $num_thunks) (i32.const 8))))
      (i32.store (local.get $thunk_wa) (i32.const 0xCACA0010))
      (i32.store (i32.add (local.get $thunk_wa) (i32.const 4))
        (i32.add (local.get $ext_api_id) (i32.sub (local.get $i) (local.get $parent_count))))
      (local.set $thunk_guest (i32.add
        (i32.sub (local.get $thunk_wa) (global.get $GUEST_BASE))
        (global.get $image_base)))
      (i32.store (i32.add (local.get $vtbl_wa) (i32.mul (local.get $i) (i32.const 4)))
        (local.get $thunk_guest))
      (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp)))
    (call $update_thunk_end)
    (local.get $vtbl_guest))

  ;; $init_dx_com_thunks is now auto-generated in 09b2-dispatch-table.generated.wat
  ;; by tools/gen_dispatch.js — COM vtable start IDs are computed from api_table.json

  ;; ════════════════════════════════════════════════════════════
  ;; CREATORS
  ;; ════════════════════════════════════════════════════════════

  ;; DirectDrawEnumerateA(lpCallback, lpContext) → HRESULT
  ;; Calls the callback once for the primary display driver, then returns DD_OK.
  ;; Callback: BOOL WINAPI cb(GUID *lpGUID, LPSTR lpDesc, LPSTR lpName, LPVOID lpCtx)
  (func $handle_DirectDrawEnumerateA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $name i32) (local $ret_addr i32)
    ;; Save the original return address (on stack before our args)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Clean up stdcall args: 2 args + ret
    (global.set $esp (i32.add (global.get $esp) (i32.const 12)))
    ;; Allocate strings for description and driver name
    (local.set $desc (call $heap_alloc (i32.const 32)))
    (local.set $name (call $heap_alloc (i32.const 16)))
    ;; Write "Primary Display Driver\0"
    (i32.store (call $g2w (local.get $desc)) (i32.const 0x6d697250))  ;; "Prim"
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4))) (i32.const 0x20797261)) ;; "ary "
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8))) (i32.const 0x70736944)) ;; "Disp"
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12))) (i32.const 0x2079616c)) ;; "lay "
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 16))) (i32.const 0x76697244)) ;; "Driv"
    (i32.store16 (call $g2w (i32.add (local.get $desc) (i32.const 20))) (i32.const 0x7265)) ;; "er"
    (i32.store8 (call $g2w (i32.add (local.get $desc) (i32.const 22))) (i32.const 0))
    ;; Write "display\0"
    (i32.store (call $g2w (local.get $name)) (i32.const 0x70736964))  ;; "disp"
    (i32.store (call $g2w (i32.add (local.get $name) (i32.const 4))) (i32.const 0x0079616c)) ;; "lay\0"
    ;; Save original return address first (highest on stack, popped by CACA0007 after callback ret)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Push callback args (right-to-left): lpContext, lpName, lpDesc, lpGUID(=NULL)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))  ;; lpContext
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $name))  ;; lpDriverName
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $desc))  ;; lpDriverDescription
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))  ;; lpGUID = NULL (primary)
    ;; Push continuation thunk as return address (lowest on stack = callback's return addr)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ddenum_ret_thunk))
    ;; Jump to callback
    (global.set $eip (local.get $arg0))
    (global.set $steps (i32.const 0)))

  ;; DirectDrawEnumerateExA(lpCallback, lpContext, dwFlags) → HRESULT
  ;; Callback: BOOL WINAPI cb(GUID *lpGUID, LPSTR lpDesc, LPSTR lpName, LPVOID lpCtx, HMONITOR hm)
  (func $handle_DirectDrawEnumerateExA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $name i32) (local $ret_addr i32)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Clean up stdcall args: 3 args + ret
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    ;; Allocate strings for description and driver name
    (local.set $desc (call $heap_alloc (i32.const 32)))
    (local.set $name (call $heap_alloc (i32.const 16)))
    ;; Write "Primary Display Driver\0"
    (i32.store (call $g2w (local.get $desc)) (i32.const 0x6d697250))
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4))) (i32.const 0x20797261))
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8))) (i32.const 0x70736944))
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12))) (i32.const 0x2079616c))
    (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 16))) (i32.const 0x76697244))
    (i32.store16 (call $g2w (i32.add (local.get $desc) (i32.const 20))) (i32.const 0x7265))
    (i32.store8 (call $g2w (i32.add (local.get $desc) (i32.const 22))) (i32.const 0))
    ;; Write "display\0"
    (i32.store (call $g2w (local.get $name)) (i32.const 0x70736964))
    (i32.store (call $g2w (i32.add (local.get $name) (i32.const 4))) (i32.const 0x0079616c))
    ;; Save original return address first (highest on stack, popped by CACA0007 after callback ret)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Push callback args (right-to-left): hMonitor, lpContext, lpName, lpDesc, lpGUID(=NULL)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))  ;; hMonitor = NULL
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg1))  ;; lpContext
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $name))  ;; lpDriverName
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $desc))  ;; lpDriverDescription
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0))  ;; lpGUID = NULL (primary)
    ;; Push continuation thunk as return address (lowest on stack = callback's return addr)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ddenum_ret_thunk))
    ;; Jump to callback
    (global.set $eip (local.get $arg0))
    (global.set $steps (i32.const 0)))

  ;; DirectDrawCreate(lpGUID, lplpDD, pUnkOuter) → HRESULT
  (func $handle_DirectDrawCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (global.set $eax (i32.const 0x80004005)) ;; E_FAIL
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; *lplpDD = obj_guest
    (call $gs32 (local.get $arg1) (local.get $obj_guest))
    (global.set $dx_ddraw_this (local.get $obj_guest))
    (global.set $eax (i32.const 0)) ;; DD_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))) ;; stdcall 3 args

  ;; DirectDrawCreateClipper(dwFlags, lplpDDClipper, pUnkOuter) → HRESULT
  ;; Standalone clipper factory — equivalent to IDirectDraw_CreateClipper.
  (func $handle_DirectDrawCreateClipper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 10) (global.get $DX_VTBL_DDCLIP)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; DirectSoundCreate(lpGUID, lplpDS, pUnkOuter) → HRESULT
  (func $handle_DirectSoundCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 4) (global.get $DX_VTBL_DSOUND)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (call $gs32 (local.get $arg1) (local.get $obj_guest))
    (global.set $eax (i32.const 0)) ;; DS_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; DirectInputCreateA(hInstance, dwVersion, lplpDI, pUnkOuter) → HRESULT
  (func $handle_DirectInputCreateA (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 6) (global.get $DX_VTBL_DINPUT)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (call $gs32 (local.get $arg2) (local.get $obj_guest))
    (global.set $eax (i32.const 0)) ;; DI_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))) ;; stdcall 4 args

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectDraw methods
  ;; ════════════════════════════════════════════════════════════

  ;; All COM methods: arg0=this, arg1..arg4 from stack.
  ;; Stack layout: [ESP]=ret, [ESP+4]=this, [ESP+8]=arg1, ...
  ;; The dispatch already loaded 5 args from ESP+4..ESP+24.

  ;; QueryInterface(this, riid, ppvObj)
  ;; Accept DDraw and D3D family interfaces with proper vtables
  (func $handle_IDirectDraw_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $iid_dword i32) (local $obj i32)
    (local.set $iid_dword (call $gl32 (local.get $arg1)))
    ;; IUnknown / IDirectDraw — return same object
    (if (i32.or (i32.eqz (local.get $iid_dword))
                (i32.eq (local.get $iid_dword) (i32.const 0x6C14DB80)))
      (then
        (call $gs32 (local.get $arg2) (local.get $arg0))
        (local.set $obj (call $dx_from_this (local.get $arg0)))
        (i32.store (i32.add (local.get $obj) (i32.const 4))
          (i32.add (i32.load (i32.add (local.get $obj) (i32.const 4))) (i32.const 1)))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; IDirectDraw2/4/7 — return a distinct wrapper with DDRAW2 vtable.
    ;; Must NOT mutate the primary wrapper: apps like foxbear QI for
    ;; IDirectDraw2 but continue using the original pointer with v1-signature
    ;; calls (SetDisplayMode with 3 args, not 5). Upgrading in-place then
    ;; made SetDisplayMode pop 28 bytes (v2) when only 20 were pushed (v1),
    ;; corrupting ESP and jumping to 0.
    (if (i32.or (i32.eq (local.get $iid_dword) (i32.const 0xB3A6F3E0))
        (i32.or (i32.eq (local.get $iid_dword) (i32.const 0x9C59509A))
                (i32.eq (local.get $iid_dword) (i32.const 0x15E65EC0))))
      (then
        (local.set $obj (call $dx_from_this (local.get $arg0)))
        (call $gs32 (local.get $arg2)
          (call $dx_get_wrapper_for_vtbl
            (call $dx_slot_of (local.get $obj))
            (global.get $DX_VTBL_DDRAW2)))
        (i32.store (i32.add (local.get $obj) (i32.const 4))
          (i32.add (i32.load (i32.add (local.get $obj) (i32.const 4))) (i32.const 1)))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; IDirect3D {3BBA0080-...}
    (if (i32.eq (local.get $iid_dword) (i32.const 0x3BBA0080))
      (then
        (local.set $obj (call $dx_create_com_obj (i32.const 8) (global.get $DX_VTBL_D3D)))
        (call $gs32 (local.get $arg2) (local.get $obj))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; IDirect3D2 {6AAE1EC1-29BD-11D0-8B4E-00A0C905AB10} — uses D3D2 vtable (9 slots,
    ;; CreateDevice takes 3 COM args, not 4). Previously we returned D3D3 vtable here,
    ;; which mislabeled CreateDevice thunks and caused a 4-byte stack drift when the
    ;; caller pushed only IDirect3D2 args (observed in Borland-compiled screensavers).
    (if (i32.eq (local.get $iid_dword) (i32.const 0x6AAE1EC1))
      (then
        (local.set $obj (call $dx_create_com_obj (i32.const 9) (global.get $DX_VTBL_D3D2)))
        (call $gs32 (local.get $arg2) (local.get $obj))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; IDirect3D3 {BB223240-E72B-11D0-A9B4-00AA00C0993E}
    (if (i32.eq (local.get $iid_dword) (i32.const 0xBB223240))
      (then
        (local.set $obj (call $dx_create_com_obj (i32.const 9) (global.get $DX_VTBL_D3D3)))
        (call $gs32 (local.get $arg2) (local.get $obj))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    ;; Unsupported interface — *ppvObj = NULL, return E_NOINTERFACE
    (call $gs32 (local.get $arg2) (i32.const 0))
    (global.set $eax (i32.const 0x80004002))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDraw_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8)))) ;; 1 arg

  (func $handle_IDirectDraw_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Compact — no-op
  (func $handle_IDirectDraw_Compact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; CreateClipper — stub
  ;; CreateClipper(this, dwFlags, lplpDDClipper, pUnkOuter) — type 10 = DDClipper
  (func $handle_IDirectDraw_CreateClipper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 10) (global.get $DX_VTBL_DDCLIP)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005)) ;; E_FAIL
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (call $gs32 (local.get $arg2) (local.get $obj))
    (global.set $eax (i32.const 0)) ;; DD_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; CreatePalette(this, dwFlags, lpDDColorArray, lplpDDPalette, pUnkOuter)
  (func $handle_IDirectDraw_CreatePalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32) (local $entry i32) (local $pal_wa i32) (local $pal_copy i32)
    ;; Allocate a DDPalette object
    (local.set $obj (call $dx_create_com_obj (i32.const 3) (global.get $DX_VTBL_DDPAL)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
        (return)))
    ;; Copy 256 PALETTEENTRY entries (1024 bytes) to heap
    (local.set $entry (call $dx_from_this (local.get $obj)))
    (local.set $pal_copy (call $heap_alloc (i32.const 1024)))
    (call $memcpy (call $g2w (local.get $pal_copy)) (call $g2w (local.get $arg2)) (i32.const 1024))
    (i32.store (i32.add (local.get $entry) (i32.const 20)) (call $g2w (local.get $pal_copy))) ;; dib_ptr = palette data WASM addr
    ;; *lplpDDPalette = obj
    (call $gs32 (local.get $arg3) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))) ;; 5 args (this + 4)

  ;; CreateSurface(this, lpDDSD, lplpDDSurface, pUnkOuter)
  (func $handle_IDirectDraw_CreateSurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ddsd_wa i32) (local $caps i32) (local $w i32) (local $h i32) (local $bpp i32)
    (local $pitch i32) (local $dib_size i32) (local $dib_guest i32)
    (local $obj i32) (local $entry i32) (local $flags i32)
    (local $back_obj i32) (local $back_entry i32) (local $vidmem_bytes i32)
    (local.set $ddsd_wa (call $g2w (local.get $arg1)))
    ;; DDSURFACEDESC:
    ;;   +0  dwSize (4)
    ;;   +4  dwFlags (4)
    ;;   +8  dwHeight (4)
    ;;   +12 dwWidth (4)
    ;;   +16 lPitch / dwLinearSize (4)
    ;;   +20 dwBackBufferCount (4)
    ;;   +24 dwMipMapCount / dwZBufferBitDepth / dwRefreshRate (4)
    ;;   +28 dwAlphaBitDepth (4)
    ;;   +32 dwReserved (4)
    ;;   +36 lpSurface (4)
    ;;   +40 ddckCKDestOverlay (8)
    ;;   +48 ddckCKDestBlt (8)
    ;;   +56 ddckCKSrcOverlay (8)
    ;;   +64 ddckCKSrcBlt (8)
    ;;   +72 ddpfPixelFormat (32)
    ;;   +104 ddsCaps (4)
    ;; ddsCaps flags: DDSCAPS_PRIMARYSURFACE=0x200, DDSCAPS_BACKBUFFER=0x4,
    ;;               DDSCAPS_OFFSCREENPLAIN=0x40, DDSCAPS_SYSTEMMEMORY=0x800,
    ;;               DDSCAPS_FLIP=0x10, DDSCAPS_COMPLEX=0x8
    (local.set $caps (i32.load (i32.add (local.get $ddsd_wa) (i32.const 104))))
    ;; Determine surface dimensions
    (if (i32.and (local.get $caps) (i32.const 0x200)) ;; PRIMARY
      (then
        (local.set $w (global.get $dx_display_w))
        (local.set $h (global.get $dx_display_h))
        (local.set $bpp (global.get $dx_display_bpp))
        (local.set $flags (i32.const 1))) ;; flag=primary
      (else
        ;; Use dimensions from DDSURFACEDESC if provided
        (local.set $w (i32.load (i32.add (local.get $ddsd_wa) (i32.const 12))))
        (local.set $h (i32.load (i32.add (local.get $ddsd_wa) (i32.const 8))))
        (if (i32.eqz (local.get $w)) (then (local.set $w (global.get $dx_display_w))))
        (if (i32.eqz (local.get $h)) (then (local.set $h (global.get $dx_display_h))))
        ;; Use pixel format bpp from DDSURFACEDESC if DDSD_PIXELFORMAT (0x1000) is set
        (if (i32.and (i32.load (i32.add (local.get $ddsd_wa) (i32.const 4))) (i32.const 0x1000))
          (then
            (local.set $bpp (i32.load (i32.add (local.get $ddsd_wa) (i32.const 84)))))
          (else
            (local.set $bpp (global.get $dx_display_bpp))))
        ;; Fallback: textures built from our (stub) EnumTextureFormats have ddpf
        ;; populated with zeros, so dwRGBBitCount=0. Use display bpp.
        (if (i32.eqz (local.get $bpp)) (then (local.set $bpp (global.get $dx_display_bpp))))
        (local.set $flags (i32.const 4)))) ;; flag=offscreen
    ;; Compute pitch (bytes per row, DWORD-aligned)
    (local.set $pitch (i32.and
      (i32.add (i32.mul (local.get $w) (i32.div_u (local.get $bpp) (i32.const 8))) (i32.const 3))
      (i32.const 0xFFFFFFFC)))
    ;; Allocate DIB
    (local.set $dib_size (i32.mul (local.get $pitch) (local.get $h)))
    (local.set $dib_guest (call $heap_alloc (local.get $dib_size)))
    (call $zero_memory (call $g2w (local.get $dib_guest)) (local.get $dib_size))
    ;; Mipmap: the pyramid adds ~1/3 of level-0 bytes. DDSCAPS_MIPMAP=0x400000.
    ;; Only level 0 is allocated in RAM; extra pyramid bytes are accounted in
    ;; vidmem only so MCM's GetAvailableVidMem-delta footprint check matches.
    (local.set $vidmem_bytes (local.get $dib_size))
    (if (i32.and (local.get $caps) (i32.const 0x400000))
      (then (local.set $vidmem_bytes
        (i32.div_u (i32.mul (local.get $dib_size) (i32.const 4)) (i32.const 3)))))
    (global.set $dx_vidmem_used (i32.add (global.get $dx_vidmem_used) (local.get $vidmem_bytes)))
    ;; Create COM object
    (local.set $obj (call $dx_create_com_obj (i32.const 2) (global.get $DX_VTBL_DDSURF2)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    ;; Fill entry
    (i32.store16 (i32.add (local.get $entry) (i32.const 12)) (local.get $w))
    (i32.store16 (i32.add (local.get $entry) (i32.const 14)) (local.get $h))
    (i32.store16 (i32.add (local.get $entry) (i32.const 16)) (local.get $bpp))
    (i32.store16 (i32.add (local.get $entry) (i32.const 18)) (local.get $pitch))
    (i32.store (i32.add (local.get $entry) (i32.const 20)) (call $g2w (local.get $dib_guest)))
    (i32.store (i32.add (local.get $entry) (i32.const 24)) (local.get $vidmem_bytes))
    (i32.store (i32.add (local.get $entry) (i32.const 28)) (local.get $flags))
    ;; *lplpDDSurface = obj
    (call $gs32 (local.get $arg2) (local.get $obj))
    ;; Primary surface → resize main window so back-canvas matches primary dims.
    ;; Apps like donut create a WS_POPUP window at size 0,0 and never call
    ;; SetDisplayMode — without this, SetDIBitsToDevice clips to the 1x1 back-canvas.
    (if (i32.and (local.get $caps) (i32.const 0x200))
      (then (if (global.get $main_hwnd) (then
        (call $host_move_window (global.get $main_hwnd)
          (i32.const 0) (i32.const 0)
          (local.get $w) (local.get $h) (i32.const 0))))))
    ;; If primary with back buffer count > 0, create back buffer and link it
    (if (i32.and
          (i32.ne (i32.and (local.get $caps) (i32.const 0x200)) (i32.const 0))  ;; PRIMARY
          (i32.gt_u (i32.load (i32.add (local.get $ddsd_wa) (i32.const 20))) (i32.const 0))) ;; backbuf count
      (then
        (local.set $back_obj (call $dx_create_com_obj (i32.const 2) (global.get $DX_VTBL_DDSURF2)))
        (if (local.get $back_obj) (then
          (local.set $back_entry (call $dx_from_this (local.get $back_obj)))
          (i32.store16 (i32.add (local.get $back_entry) (i32.const 12)) (local.get $w))
          (i32.store16 (i32.add (local.get $back_entry) (i32.const 14)) (local.get $h))
          (i32.store16 (i32.add (local.get $back_entry) (i32.const 16)) (local.get $bpp))
          (i32.store16 (i32.add (local.get $back_entry) (i32.const 18)) (local.get $pitch))
          ;; Allocate separate DIB for back buffer
          (local.set $dib_guest (call $heap_alloc (local.get $dib_size)))
          (call $zero_memory (call $g2w (local.get $dib_guest)) (local.get $dib_size))
          (global.set $dx_vidmem_used (i32.add (global.get $dx_vidmem_used) (local.get $dib_size)))
          (i32.store (i32.add (local.get $back_entry) (i32.const 20)) (call $g2w (local.get $dib_guest)))
          (i32.store (i32.add (local.get $back_entry) (i32.const 24)) (local.get $dib_size))
          (i32.store (i32.add (local.get $back_entry) (i32.const 28)) (i32.const 2)) ;; flag=backbuf
          ;; Store back buffer guest ptr in primary's misc0 field for GetAttachedSurface
          (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $back_obj))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20)))) ;; 4 args (this+3)

  ;; DuplicateSurface — stub
  (func $handle_IDirectDraw_DuplicateSurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr)))

  ;; EnumDisplayModes(this, dwFlags, lpDDSD, lpContext, lpEnumModesCallback)
  ;; Uses continuation thunk CACA0008 to iterate through a table of modes.
  ;; Mode table: (w, h, bpp) tuples — common Win98 modes.
  (func $handle_IDirectDraw_EnumDisplayModes (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    ;; Save state for continuation
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Clean up stdcall args: 5 args + ret = 24 bytes
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
    ;; Allocate a DDSURFACEDESC on the heap (reused for each callback)
    (global.set $enum_modes_ddsd (call $heap_alloc (i32.const 108)))
    (global.set $enum_modes_callback (local.get $arg4))
    (global.set $enum_modes_context (local.get $arg3))
    (global.set $enum_modes_ret (local.get $ret_addr))
    (global.set $enum_modes_idx (i32.const 0))
    ;; Start enumeration — call $enum_modes_dispatch for the first mode
    (call $enum_modes_dispatch))

  ;; Helper: fill DDSD for mode index $enum_modes_idx and jump to callback.
  ;; Mode table: 640x480 and 800x600 in 8/16/32 bpp.
  (func $enum_modes_dispatch
    (local $ddsd_wa i32) (local $w i32) (local $h i32) (local $bpp i32)
    (local $pitch i32) (local $idx i32)
    (local.set $idx (global.get $enum_modes_idx))
    ;; Mode table
    (if (i32.eq (local.get $idx) (i32.const 0))
      (then (local.set $w (i32.const 640)) (local.set $h (i32.const 480)) (local.set $bpp (i32.const 8))))
    (if (i32.eq (local.get $idx) (i32.const 1))
      (then (local.set $w (i32.const 640)) (local.set $h (i32.const 480)) (local.set $bpp (i32.const 16))))
    (if (i32.eq (local.get $idx) (i32.const 2))
      (then (local.set $w (i32.const 640)) (local.set $h (i32.const 480)) (local.set $bpp (i32.const 32))))
    (if (i32.eq (local.get $idx) (i32.const 3))
      (then (local.set $w (i32.const 800)) (local.set $h (i32.const 600)) (local.set $bpp (i32.const 8))))
    (if (i32.eq (local.get $idx) (i32.const 4))
      (then (local.set $w (i32.const 800)) (local.set $h (i32.const 600)) (local.set $bpp (i32.const 16))))
    (if (i32.eq (local.get $idx) (i32.const 5))
      (then (local.set $w (i32.const 800)) (local.set $h (i32.const 600)) (local.set $bpp (i32.const 32))))
    ;; If past end of table, done — return DD_OK to caller
    (if (i32.ge_u (local.get $idx) (i32.const 6))
      (then
        (global.set $eip (global.get $enum_modes_ret))
        (global.set $eax (i32.const 0))  ;; DD_OK
        (return)))
    ;; Compute pitch: align (w * bytes_per_pixel) to 4 bytes
    (if (i32.eq (local.get $bpp) (i32.const 8))
      (then (local.set $pitch (i32.and (i32.add (local.get $w) (i32.const 3)) (i32.const 0xFFFFFFFC))))
      (else (if (i32.eq (local.get $bpp) (i32.const 16))
        (then (local.set $pitch (i32.and (i32.add (i32.mul (local.get $w) (i32.const 2)) (i32.const 3)) (i32.const 0xFFFFFFFC))))
        (else (local.set $pitch (i32.mul (local.get $w) (i32.const 4)))))))
    ;; Fill DDSURFACEDESC
    (local.set $ddsd_wa (call $g2w (global.get $enum_modes_ddsd)))
    (call $zero_memory (local.get $ddsd_wa) (i32.const 108))
    (i32.store (local.get $ddsd_wa) (i32.const 108))  ;; dwSize
    ;; dwFlags = DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_PITCH
    (i32.store (i32.add (local.get $ddsd_wa) (i32.const 4)) (i32.const 0x1006))
    (i32.store (i32.add (local.get $ddsd_wa) (i32.const 8)) (local.get $h))     ;; dwHeight
    (i32.store (i32.add (local.get $ddsd_wa) (i32.const 12)) (local.get $w))    ;; dwWidth
    (i32.store (i32.add (local.get $ddsd_wa) (i32.const 16)) (local.get $pitch)) ;; lPitch
    ;; ddpfPixelFormat at offset 72
    (i32.store (i32.add (local.get $ddsd_wa) (i32.const 72)) (i32.const 32))  ;; dwSize
    (if (i32.eq (local.get $bpp) (i32.const 8))
      (then
        ;; 8bpp palettized: DDPF_RGB | DDPF_PALETTEINDEXED8
        (i32.store (i32.add (local.get $ddsd_wa) (i32.const 76)) (i32.const 0x60))
        (i32.store (i32.add (local.get $ddsd_wa) (i32.const 84)) (i32.const 8)))
      (else (if (i32.eq (local.get $bpp) (i32.const 16))
        (then
          ;; 16bpp RGB565
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 76)) (i32.const 0x40))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 84)) (i32.const 16))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 88)) (i32.const 0xF800))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 92)) (i32.const 0x07E0))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 96)) (i32.const 0x001F)))
        (else
          ;; 32bpp XRGB8888
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 76)) (i32.const 0x40))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 84)) (i32.const 32))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 88)) (i32.const 0x00FF0000))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 92)) (i32.const 0x0000FF00))
          (i32.store (i32.add (local.get $ddsd_wa) (i32.const 96)) (i32.const 0x000000FF))))))
    ;; Push saved caller return addr (popped on enum complete)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_modes_ret))
    ;; Push callback args: lpContext, lpDDSD (right to left, __stdcall)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_modes_context))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_modes_ddsd))
    ;; Push continuation thunk as callback's return address
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $enum_modes_thunk))
    ;; Jump to callback
    (global.set $eip (global.get $enum_modes_callback))
    (global.set $steps (i32.const 0)))

  ;; CACA0008 continuation: callback returned, advance to next mode
  (func $enum_modes_continue
    ;; The callback is __stdcall(2 args), so it already popped lpDDSD + lpContext (8 bytes).
    ;; Stack now has [saved_caller_ret] at ESP.
    (call $host_log_i32 (i32.or (i32.const 0xED00000)
      (i32.or (i32.shl (global.get $enum_modes_idx) (i32.const 8))
              (i32.and (global.get $eax) (i32.const 0xFF)))))
    ;; Pop the saved caller return addr
    (global.set $enum_modes_ret (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))
    ;; If callback returned 0 (DDENUMRET_CANCEL), stop enumeration
    (if (i32.eqz (global.get $eax))
      (then
        (global.set $eip (global.get $enum_modes_ret))
        (global.set $eax (i32.const 0))  ;; DD_OK
        (return)))
    ;; Advance to next mode
    (global.set $enum_modes_idx (i32.add (global.get $enum_modes_idx) (i32.const 1)))
    ;; Dispatch next mode (or finish if past end)
    (call $enum_modes_dispatch))

  ;; ── IDirect3D{1,2,3}::EnumDevices — enumerates Ramp/HAL/MMX/TnLHal ──
  ;; Caller has captured the saved return addr and already popped stdcall args.
  ;; Dispatches callback N times via CACA000B continuation thunk.
  (func $d3d_enum_devices_invoke (param $cb i32) (param $ctx i32) (param $ret_addr i32)
    ;; Push saved caller ret once (stays on stack across all iterations).
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    (global.set $d3d_enum_dev_cb  (local.get $cb))
    (global.set $d3d_enum_dev_ctx (local.get $ctx))
    (global.set $d3d_enum_dev_ret (local.get $ret_addr))
    (global.set $d3d_enum_dev_idx (i32.const 0))
    (call $d3d_enum_devices_dispatch))

  ;; Fills per-device GUID/desc/name and invokes the guest callback.
  ;; If idx past end, pops saved ret + sets EAX=DD_OK and returns to caller.
  (func $d3d_enum_devices_dispatch
    (local $idx i32) (local $guid i32) (local $desc i32) (local $name i32)
    (local $hw i32) (local $hel i32) (local $wa i32) (local $is_hal i32)
    (local.set $idx (global.get $d3d_enum_dev_idx))
    ;; 4 devices: 0=Ramp, 1=RGB, 2=HAL, 3=MMX. (Framework-preferred order.)
    (if (i32.ge_u (local.get $idx) (i32.const 4))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) ;; pop saved ret
        (global.set $eip (global.get $d3d_enum_dev_ret))
        (global.set $eax (i32.const 0))
        (return)))
    (local.set $guid (call $heap_alloc (i32.const 16)))
    (local.set $wa (call $g2w (local.get $guid)))
    (local.set $desc (call $heap_alloc (i32.const 32)))
    (local.set $name (call $heap_alloc (i32.const 16)))
    (local.set $is_hal (i32.const 0))
    (if (i32.eq (local.get $idx) (i32.const 0))
      (then
        ;; IID_IDirect3DRampDevice {F2086B20-259F-11CF-A31A-00AA00B93356}
        (i32.store (local.get $wa)                      (i32.const 0xF2086B20))
        (i32.store (i32.add (local.get $wa) (i32.const 4))  (i32.const 0x11CF259F))
        (i32.store (i32.add (local.get $wa) (i32.const 8))  (i32.const 0xAA001AA3))
        (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x5633B900))
        ;; "Ramp Emulation\0"
        (i32.store (call $g2w (local.get $desc))                           (i32.const 0x706D6152))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4)))   (i32.const 0x6D452061))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8)))   (i32.const 0x74616C75))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12)))  (i32.const 0x006E6F69))
        ;; "ramp\0"
        (i32.store (call $g2w (local.get $name)) (i32.const 0x706D6172))
        (i32.store8 (i32.add (call $g2w (local.get $name)) (i32.const 4)) (i32.const 0))))
    (if (i32.eq (local.get $idx) (i32.const 1))
      (then
        ;; IID_IDirect3DRGBDevice {A4665C60-2673-11CF-A31A-00AA00B93356}
        (i32.store (local.get $wa)                      (i32.const 0xA4665C60))
        (i32.store (i32.add (local.get $wa) (i32.const 4))  (i32.const 0x11CF2673))
        (i32.store (i32.add (local.get $wa) (i32.const 8))  (i32.const 0xAA001AA3))
        (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x5633B900))
        ;; "RGB Emulation\0"
        (i32.store (call $g2w (local.get $desc))                           (i32.const 0x20424752))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4)))   (i32.const 0x6C756D45))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8)))   (i32.const 0x6F697461))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12)))  (i32.const 0x0000006E))
        ;; "rgb\0"
        (i32.store (call $g2w (local.get $name)) (i32.const 0x00626772))))
    (if (i32.eq (local.get $idx) (i32.const 2))
      (then
        ;; IID_IDirect3DHALDevice {84E63DE0-46AA-11CF-816F-0000C020156E}
        (i32.store (local.get $wa)                      (i32.const 0x84E63DE0))
        (i32.store (i32.add (local.get $wa) (i32.const 4))  (i32.const 0x11CF46AA))
        (i32.store (i32.add (local.get $wa) (i32.const 8))  (i32.const 0x00006F81))
        (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x6E1520C0))
        ;; "Direct3D HAL\0"
        (i32.store (call $g2w (local.get $desc))                           (i32.const 0x65726944))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4)))   (i32.const 0x44337463))
        (i32.store (i32.add (call $g2w (local.get $desc)) (i32.const 8))   (i32.const 0x4C414820))
        (i32.store8 (i32.add (call $g2w (local.get $desc)) (i32.const 12)) (i32.const 0))
        ;; "hal\0"
        (i32.store (call $g2w (local.get $name)) (i32.const 0x0000006C61681))
        (local.set $is_hal (i32.const 1))))
    (if (i32.eq (local.get $idx) (i32.const 3))
      (then
        ;; IID_IDirect3DMMXDevice {881949A1-D6F3-11D0-89AB-00A0C9054129}
        (i32.store (local.get $wa)                      (i32.const 0x881949A1))
        (i32.store (i32.add (local.get $wa) (i32.const 4))  (i32.const 0x11D0D6F3))
        (i32.store (i32.add (local.get $wa) (i32.const 8))  (i32.const 0xA000AB89))
        (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x294105C9))
        ;; "MMX Emulation\0"
        (i32.store (call $g2w (local.get $desc))                           (i32.const 0x20584D4D))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 4)))   (i32.const 0x6C756D45))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 8)))   (i32.const 0x6F697461))
        (i32.store (call $g2w (i32.add (local.get $desc) (i32.const 12)))  (i32.const 0x0000006E))
        ;; "mmx\0"
        (i32.store (call $g2w (local.get $name)) (i32.const 0x00786D6D))))
    ;; HW + HEL descs
    (local.set $hw  (call $heap_alloc (i32.const 252)))
    (call $fill_d3d_device_desc (local.get $hw)  (local.get $is_hal))
    (local.set $hel (call $heap_alloc (i32.const 252)))
    (call $fill_d3d_device_desc (local.get $hel) (i32.const 0))
    ;; Push callback args right-to-left: ctx, helDesc, hwDesc, name, desc, guid
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $d3d_enum_dev_ctx))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $hel))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $hw))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $name))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $desc))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $guid))
    ;; Push callback return = CACA000B
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $d3d_enum_dev_thunk))
    (global.set $eip (global.get $d3d_enum_dev_cb))
    (global.set $steps (i32.const 0)))

  ;; CACA000B: callback returned; callback popped its 6 args via `ret 0x18`.
  ;; If callback returned DDENUMRET_CANCEL (0), stop; else advance idx.
  (func $d3d_enum_devices_continue
    (if (i32.eqz (global.get $eax))
      (then
        (global.set $esp (i32.add (global.get $esp) (i32.const 4))) ;; pop saved ret
        (global.set $eip (global.get $d3d_enum_dev_ret))
        (global.set $eax (i32.const 0))
        (return)))
    (global.set $d3d_enum_dev_idx (i32.add (global.get $d3d_enum_dev_idx) (i32.const 1)))
    (call $d3d_enum_devices_dispatch))

  ;; Fill D3DDEVICEDESC (DX5-style 252-byte layout).
  ;; is_hal=1 sets HWRASTERIZATION + vidmem caps; is_hal=0 is HEL (software).
  (func $fill_d3d_device_desc (param $p i32) (param $is_hal i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $p)))
    (call $zero_memory (local.get $wa) (i32.const 252))
    (i32.store (local.get $wa)                         (i32.const 252))       ;; dwSize
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x7FF))     ;; dwFlags: all v3 fields valid
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 2))         ;; dcmColorModel = RGB
    ;; dwDevCaps
    (if (local.get $is_hal)
      (then (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x8AEA0))) ;; HWRAST|DP2EX|DP2|DPTLV|TEXVID|EXECVID|TLVERTEXVID
      (else (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0x02A50))))  ;; DP2|DPTLV|TEXSYS|EXECSYS|TLVERTEXSYS
    ;; dtcTransformCaps (8 bytes) at +16
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.const 8))
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 1))        ;; D3DTRANSFORMCAPS_CLIP
    ;; bClipping at +24
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 1))
    ;; dlcLightingCaps (16) at +28
    (i32.store (i32.add (local.get $wa) (i32.const 28)) (i32.const 16))
    (i32.store (i32.add (local.get $wa) (i32.const 32)) (i32.const 7))        ;; POINT|SPOT|DIRECTIONAL
    (i32.store (i32.add (local.get $wa) (i32.const 36)) (i32.const 1))        ;; RGB lighting
    (i32.store (i32.add (local.get $wa) (i32.const 40)) (i32.const 8))        ;; num lights
    ;; dpcLineCaps (56) at +44
    (call $fill_primcaps (i32.add (local.get $p) (i32.const 44)))
    ;; dpcTriCaps (56) at +100
    (call $fill_primcaps (i32.add (local.get $p) (i32.const 100)))
    ;; Tail fields at +156
    (i32.store (i32.add (local.get $wa) (i32.const 156)) (i32.const 0xD00))   ;; DeviceRenderBitDepth = DDBD_8|16|32 (0x800|0x400|0x100)
    (i32.store (i32.add (local.get $wa) (i32.const 160)) (i32.const 0x500))   ;; DeviceZBufferBitDepth = DDBD_16|32
    (i32.store (i32.add (local.get $wa) (i32.const 164)) (i32.const 0))       ;; dwMaxBufferSize
    (i32.store (i32.add (local.get $wa) (i32.const 168)) (i32.const 0xFFFF))  ;; dwMaxVertexCount
    ;; DX5 extensions (+172..)
    (i32.store (i32.add (local.get $wa) (i32.const 172)) (i32.const 1))       ;; dwMinTextureWidth
    (i32.store (i32.add (local.get $wa) (i32.const 176)) (i32.const 1))       ;; dwMinTextureHeight
    (i32.store (i32.add (local.get $wa) (i32.const 180)) (i32.const 2048))    ;; dwMaxTextureWidth
    (i32.store (i32.add (local.get $wa) (i32.const 184)) (i32.const 2048)))   ;; dwMaxTextureHeight

  (func $fill_primcaps (param $p i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $p)))
    (i32.store (local.get $wa)                         (i32.const 56))        ;; dwSize
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x3F))      ;; dwMiscCaps
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x07FF))    ;; dwRasterCaps
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 0xFF))     ;; dwZCmpCaps (all 8)
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.const 0x1FFF))   ;; dwSrcBlendCaps
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 0x1FFF))   ;; dwDestBlendCaps
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 0xFF))     ;; dwAlphaCmpCaps
    (i32.store (i32.add (local.get $wa) (i32.const 28)) (i32.const 0x1FFFF))  ;; dwShadeCaps
    (i32.store (i32.add (local.get $wa) (i32.const 32)) (i32.const 0xFFFF))   ;; dwTextureCaps
    (i32.store (i32.add (local.get $wa) (i32.const 36)) (i32.const 0xFF))     ;; dwTextureFilterCaps
    (i32.store (i32.add (local.get $wa) (i32.const 40)) (i32.const 0xFFFF))   ;; dwTextureBlendCaps
    (i32.store (i32.add (local.get $wa) (i32.const 44)) (i32.const 0xFF))     ;; dwTextureAddressCaps
    (i32.store (i32.add (local.get $wa) (i32.const 48)) (i32.const 1))        ;; dwStippleWidth
    (i32.store (i32.add (local.get $wa) (i32.const 52)) (i32.const 1)))       ;; dwStippleHeight

  ;; EnumSurfaces — stub
  (func $handle_IDirectDraw_EnumSurfaces (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; FlipToGDISurface — no-op
  (func $handle_IDirectDraw_FlipToGDISurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetCaps(this, lpDDDriverCaps, lpDDHELCaps)
  (func $handle_IDirectDraw_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $sz i32)
    ;; Fill driver caps if requested. CRITICAL: respect caller's dwSize —
    ;; DDraw v1 = 316, DDraw v5 = 380. Writing past it clobbers the caller's
    ;; stack frame (and return address). Read dwSize from [arg1], clamp.
    (if (local.get $arg1) (then
      (local.set $wa (call $g2w (local.get $arg1)))
      (local.set $sz (i32.load (local.get $wa)))
      (if (i32.or (i32.lt_u (local.get $sz) (i32.const 16))
                  (i32.gt_u (local.get $sz) (i32.const 380)))
        (then (local.set $sz (i32.const 380))))
      (call $zero_memory (local.get $wa) (local.get $sz))
      (i32.store (local.get $wa) (local.get $sz)) ;; preserve dwSize
      ;; dwCaps = DDCAPS_3D | DDCAPS_BLT | DDCAPS_BLTCOLORFILL | DDCAPS_COLORKEY.
      ;; DDCAPS_3D (bit 0) is required — MCM's acceptability gate at 0x00465441
      ;; tests `[DDCAPS.dwCaps] & 1` to decide whether the driver offers 3D.
      (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x24041))
      ;; dwZBufferBitDepths = DDBD_16 (0x400) — MCM checks
      (if (i32.gt_u (local.get $sz) (i32.const 0x38))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x38)) (i32.const 0x400))))
      ;; dwVidMemTotal / dwVidMemFree — MCM caches [caps+0x3c] as budget
      (if (i32.gt_u (local.get $sz) (i32.const 0x3c))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x3c)) (i32.const 0x00800000))))
      (if (i32.gt_u (local.get $sz) (i32.const 0x40))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x40)) (i32.const 0x00800000))))))
    ;; Same for HEL caps
    (if (local.get $arg2) (then
      (local.set $wa (call $g2w (local.get $arg2)))
      (local.set $sz (i32.load (local.get $wa)))
      (if (i32.or (i32.lt_u (local.get $sz) (i32.const 16))
                  (i32.gt_u (local.get $sz) (i32.const 380)))
        (then (local.set $sz (i32.const 380))))
      (call $zero_memory (local.get $wa) (local.get $sz))
      (i32.store (local.get $wa) (local.get $sz))
      (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x24041))
      (if (i32.gt_u (local.get $sz) (i32.const 0x38))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x38)) (i32.const 0x400))))
      (if (i32.gt_u (local.get $sz) (i32.const 0x3c))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x3c)) (i32.const 0x00800000))))
      (if (i32.gt_u (local.get $sz) (i32.const 0x40))
        (then (i32.store (i32.add (local.get $wa) (i32.const 0x40)) (i32.const 0x00800000))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetDisplayMode(this, lpDDSD) — return current display mode
  (func $handle_IDirectDraw_GetDisplayMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $wa) (i32.const 108))
    (i32.store (local.get $wa) (i32.const 108))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x1006))
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (global.get $dx_display_h))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (global.get $dx_display_w))
    (i32.store (i32.add (local.get $wa) (i32.const 16))
      (i32.and (i32.add (i32.mul (global.get $dx_display_w) (i32.const 2)) (i32.const 3)) (i32.const 0xFFFFFFFC)))
    ;; Pixel format
    (i32.store (i32.add (local.get $wa) (i32.const 72)) (i32.const 32))
    (i32.store (i32.add (local.get $wa) (i32.const 76)) (i32.const 0x40))
    (i32.store (i32.add (local.get $wa) (i32.const 84)) (global.get $dx_display_bpp))
    (i32.store (i32.add (local.get $wa) (i32.const 88)) (i32.const 0xF800))
    (i32.store (i32.add (local.get $wa) (i32.const 92)) (i32.const 0x07E0))
    (i32.store (i32.add (local.get $wa) (i32.const 96)) (i32.const 0x001F))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetFourCCCodes — return 0 codes
  (func $handle_IDirectDraw_GetFourCCCodes (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetGDISurface — stub
  (func $handle_IDirectDraw_GetGDISurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $crash_unimplemented (local.get $name_ptr)))

  ;; GetMonitorFrequency(this, lpdwFreq)
  (func $handle_IDirectDraw_GetMonitorFrequency (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 60))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetScanLine — return 0
  (func $handle_IDirectDraw_GetScanLine (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetVerticalBlankStatus(this, lpbIsInVB) — always TRUE
  (func $handle_IDirectDraw_GetVerticalBlankStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 1))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Initialize — no-op
  (func $handle_IDirectDraw_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; RestoreDisplayMode — no-op
  (func $handle_IDirectDraw_RestoreDisplayMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetCooperativeLevel(this, hwnd, dwFlags) — no-op, store hwnd
  (func $handle_IDirectDraw_SetCooperativeLevel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $arg1)) ;; store hwnd
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetDisplayMode(this, dwWidth, dwHeight, dwBPP, [dwRefreshRate, dwFlags])
  ;; IDirectDraw v1: 4 args (this+3). IDirectDraw2+: 6 args (this+5).
  ;; Method 21 is shared between both vtables, so we disambiguate at call
  ;; time by reading the object's vtable pointer [arg0]. Mispopping 8 bytes
  ;; corrupts ESP and the caller's return chain (see apps/mcm.md MCM-1).
  ;; Default 8bpp palette: 6×6×6 RGB cube (indexes 0..215) + 40-step grayscale ramp
  ;; (216..255). Installed when SetDisplayMode selects a ≤8bpp mode and the app
  ;; hasn't attached its own palette yet — DX samples like ddex1 use GetDC/TextOut
  ;; without calling CreatePalette and would otherwise render black.
  (func $install_default_dx_palette
    (local $pal_guest i32) (local $pal_wa i32) (local $i i32)
    (local $r i32) (local $g i32) (local $b i32) (local $lum i32)
    (if (i32.ne (global.get $dx_primary_pal_wa) (i32.const 0)) (then (return)))
    (local.set $pal_guest (call $heap_alloc (i32.const 1024)))
    (local.set $pal_wa (call $g2w (local.get $pal_guest)))
    (call $zero_memory (local.get $pal_wa) (i32.const 1024))
    ;; Cube: idx = r*36 + g*6 + b, each channel ∈ {0,51,102,153,204,255}
    (local.set $i (i32.const 0))
    (block $cd (loop $cl
      (br_if $cd (i32.ge_u (local.get $i) (i32.const 216)))
      (local.set $r (i32.mul (i32.div_u (local.get $i) (i32.const 36)) (i32.const 51)))
      (local.set $g (i32.mul (i32.rem_u (i32.div_u (local.get $i) (i32.const 6)) (i32.const 6)) (i32.const 51)))
      (local.set $b (i32.mul (i32.rem_u (local.get $i) (i32.const 6)) (i32.const 51)))
      (i32.store8 (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (local.get $r))
      (i32.store8 (i32.add (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (i32.const 1)) (local.get $g))
      (i32.store8 (i32.add (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (i32.const 2)) (local.get $b))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $cl)))
    ;; Grayscale ramp for remaining 40 slots
    (local.set $i (i32.const 216))
    (block $gd (loop $gl
      (br_if $gd (i32.ge_u (local.get $i) (i32.const 256)))
      (local.set $lum (i32.div_u (i32.mul (i32.sub (local.get $i) (i32.const 216)) (i32.const 255)) (i32.const 39)))
      (i32.store8 (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (local.get $lum))
      (i32.store8 (i32.add (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (i32.const 1)) (local.get $lum))
      (i32.store8 (i32.add (i32.add (local.get $pal_wa) (i32.shl (local.get $i) (i32.const 2))) (i32.const 2)) (local.get $lum))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $gl)))
    (global.set $dx_primary_pal_wa (local.get $pal_wa)))

  (func $handle_IDirectDraw_SetDisplayMode (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vtbl i32)
    (global.set $dx_display_w (local.get $arg1))
    (global.set $dx_display_h (local.get $arg2))
    (global.set $dx_display_bpp (local.get $arg3))
    (if (i32.le_u (local.get $arg3) (i32.const 8))
      (then (call $install_default_dx_palette)))
    ;; Resize the main window to match the display mode so the back-canvas
    ;; matches the primary-surface dims. Without this, fullscreen DDraw apps
    ;; (MCM) that issued an earlier SetWindowPos to a chrome-only size end up
    ;; with an 8×47 back-canvas and nothing visible lands on it.
    ;; flags=0: apply both position (0,0) and size (arg1, arg2) — earlier
    ;; code passed 1 (SWP_NOSIZE) which actively dropped the size update.
    (if (global.get $main_hwnd) (then
      (call $host_move_window (global.get $main_hwnd)
        (i32.const 0) (i32.const 0)
        (local.get $arg1) (local.get $arg2) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (local.set $vtbl (call $gl32 (local.get $arg0)))
    (if (i32.eq (local.get $vtbl) (global.get $DX_VTBL_DDRAW2))
      (then (global.set $esp (i32.add (global.get $esp) (i32.const 28)))) ;; v2: this + 5 args
      (else (global.set $esp (i32.add (global.get $esp) (i32.const 20)))))) ;; v1: this + 3 args

  ;; WaitForVerticalBlank — no-op
  (func $handle_IDirectDraw_WaitForVerticalBlank (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetAvailableVidMem(this, lpDDSCaps, lpdwTotal, lpdwFree) — IDirectDraw2+ only
  ;; Total = 8 MB (matches GetCaps dwVidMemTotal). Free = Total - $dx_vidmem_used;
  ;; MCM uses the delta across CreateSurface/Release to measure texture bytes.
  (func $handle_IDirectDraw2_GetAvailableVidMem (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $free i32)
    (local.set $free (i32.sub (i32.const 0x00800000) (global.get $dx_vidmem_used)))
    (if (i32.lt_s (local.get $free) (i32.const 0)) (then (local.set $free (i32.const 0))))
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (i32.const 0x00800000))))
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (local.get $free))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectDrawSurface methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectDrawSurface_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    ;; Return same object for any QI (DX3 compat)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    ;; COM rule: QI must AddRef the returned interface
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawSurface_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectDrawSurface_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32) (local $surf_bytes i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then
        (local.set $surf_bytes (i32.load (i32.add (local.get $entry) (i32.const 24))))
        (global.set $dx_vidmem_used (i32.sub (global.get $dx_vidmem_used) (local.get $surf_bytes)))
        (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; AddAttachedSurface — no-op
  (func $handle_IDirectDrawSurface_AddAttachedSurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectDrawSurface_AddOverlayDirtyRect (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001)) ;; DDERR_UNSUPPORTED
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Blt(this, lpDestRect, lpDDSrcSurface, lpSrcRect, dwFlags, lpDDBltFx)
  ;; Note: 6 args but we only get 5 from dispatch; 6th is at ESP+24
  (func $handle_IDirectDrawSurface_Blt (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst_entry i32) (local $src_entry i32)
    (local $dst_dib i32) (local $src_dib i32)
    (local $dst_w i32) (local $dst_h i32) (local $dst_pitch i32)
    (local $src_w i32) (local $src_h i32) (local $src_pitch i32)
    (local $dx i32) (local $dy i32) (local $dw i32) (local $dh i32)
    (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $bpp i32) (local $bps i32) (local $row i32)
    (local $drblt_flags i32)
    (local.set $dst_entry (call $dx_from_this (local.get $arg0)))
    (call $host_dx_trace (i32.const 3) (call $dx_slot_of (local.get $dst_entry))
      (if (result i32) (local.get $arg2)
        (then (call $dx_slot_of (call $dx_from_this (local.get $arg2))))
        (else (i32.const -1)))
      (i32.load (i32.add (local.get $dst_entry) (i32.const 20)))
      (local.get $arg4))
    (local.set $dst_dib (i32.load (i32.add (local.get $dst_entry) (i32.const 20))))
    (local.set $dst_w (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 12))))
    (local.set $dst_h (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 14))))
    (local.set $dst_pitch (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 18))))
    (local.set $bpp (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 16))))
    (local.set $bps (i32.div_u (local.get $bpp) (i32.const 8)))
    (local.set $drblt_flags (local.get $arg4))
    ;; Parse dest rect
    (if (local.get $arg1)
      (then
        (local.set $dx (call $gl32 (local.get $arg1)))
        (local.set $dy (call $gl32 (i32.add (local.get $arg1) (i32.const 4))))
        (local.set $dw (i32.sub (call $gl32 (i32.add (local.get $arg1) (i32.const 8))) (local.get $dx)))
        (local.set $dh (i32.sub (call $gl32 (i32.add (local.get $arg1) (i32.const 12))) (local.get $dy))))
      (else
        (local.set $dx (i32.const 0)) (local.set $dy (i32.const 0))
        (local.set $dw (local.get $dst_w)) (local.set $dh (local.get $dst_h))))
    ;; If DDBLT_COLORFILL (0x400), fill with color from DDBLTFX
    (if (i32.and (local.get $drblt_flags) (i32.const 0x400))
      (then
        (local.set $row (call $gl32 (i32.add
          (call $gl32 (i32.add (global.get $esp) (i32.const 24))) ;; lpDDBltFx arg6
          (i32.const 36)))) ;; DDBLTFX.dwFillColor at offset 36
        ;; Fill destination rect
        (block $fill_done
          (local.set $sy (i32.const 0))
          (loop $fill_row
            (br_if $fill_done (i32.ge_u (local.get $sy) (local.get $dh)))
            (local.set $sx (i32.const 0))
            (loop $fill_col
              (if (i32.lt_u (local.get $sx) (local.get $dw)) (then
                (if (i32.eq (local.get $bps) (i32.const 1))
                  (then
                    (i32.store8 (i32.add (local.get $dst_dib)
                      (i32.add (i32.mul (i32.add (local.get $dy) (local.get $sy)) (local.get $dst_pitch))
                               (i32.add (local.get $dx) (local.get $sx))))
                      (local.get $row)))
                  (else (if (i32.eq (local.get $bps) (i32.const 2))
                    (then
                      (i32.store16 (i32.add (local.get $dst_dib)
                        (i32.add (i32.mul (i32.add (local.get $dy) (local.get $sy)) (local.get $dst_pitch))
                                 (i32.mul (i32.add (local.get $dx) (local.get $sx)) (i32.const 2))))
                        (local.get $row)))
                    (else
                      (i32.store (i32.add (local.get $dst_dib)
                        (i32.add (i32.mul (i32.add (local.get $dy) (local.get $sy)) (local.get $dst_pitch))
                                 (i32.mul (i32.add (local.get $dx) (local.get $sx)) (i32.const 4))))
                        (local.get $row))))))
                (local.set $sx (i32.add (local.get $sx) (i32.const 1)))
                (br $fill_col))))
            (local.set $sy (i32.add (local.get $sy) (i32.const 1)))
            (br $fill_row)))
        ;; If dest is primary, present
        (if (i32.and (i32.load (i32.add (local.get $dst_entry) (i32.const 28))) (i32.const 1))
          (then (call $dx_present (local.get $dst_entry))))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) ;; 6 args + ret
        (return)))
    ;; Source surface blit
    (if (i32.eqz (local.get $arg2))
      (then
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28)))
        (return)))
    (local.set $src_entry (call $dx_from_this (local.get $arg2)))
    (local.set $src_dib (i32.load (i32.add (local.get $src_entry) (i32.const 20))))
    (local.set $src_pitch (i32.load16_u (i32.add (local.get $src_entry) (i32.const 18))))
    ;; Parse source rect
    (if (local.get $arg3)
      (then
        (local.set $sx (call $gl32 (local.get $arg3)))
        (local.set $sy (call $gl32 (i32.add (local.get $arg3) (i32.const 4))))
        (local.set $sw (i32.sub (call $gl32 (i32.add (local.get $arg3) (i32.const 8))) (local.get $sx)))
        (local.set $sh (i32.sub (call $gl32 (i32.add (local.get $arg3) (i32.const 12))) (local.get $sy))))
      (else
        (local.set $sx (i32.const 0)) (local.set $sy (i32.const 0))
        (local.set $sw (i32.load16_u (i32.add (local.get $src_entry) (i32.const 12))))
        (local.set $sh (i32.load16_u (i32.add (local.get $src_entry) (i32.const 14))))))
    ;; Row-copy (no stretch, no color key for now — simple case)
    (local.set $row (i32.const 0))
    (block $blit_done (loop $blit_row
      (br_if $blit_done (i32.ge_u (local.get $row) (local.get $dh)))
      (if (i32.lt_u (local.get $row) (local.get $sh)) (then
        (call $memcpy
          (i32.add (local.get $dst_dib)
            (i32.add (i32.mul (i32.add (local.get $dy) (local.get $row)) (local.get $dst_pitch))
                     (i32.mul (local.get $dx) (local.get $bps))))
          (i32.add (local.get $src_dib)
            (i32.add (i32.mul (i32.add (local.get $sy) (local.get $row)) (local.get $src_pitch))
                     (i32.mul (local.get $sx) (local.get $bps))))
          (i32.mul (local.get $dw) (local.get $bps)))))
      (local.set $row (i32.add (local.get $row) (i32.const 1)))
      (br $blit_row)))
    ;; If dest is primary, present
    (if (i32.and (i32.load (i32.add (local.get $dst_entry) (i32.const 28))) (i32.const 1))
      (then (call $dx_present (local.get $dst_entry))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; BltBatch — stub
  (func $handle_IDirectDrawSurface_BltBatch (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; BltFast(this, dwX, dwY, lpDDSrcSurface, lpSrcRect, dwTrans)
  (func $handle_IDirectDrawSurface_BltFast (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dst_entry i32) (local $src_entry i32)
    (local $dst_dib i32) (local $src_dib i32)
    (local $dst_pitch i32) (local $src_pitch i32)
    (local $sx i32) (local $sy i32) (local $sw i32) (local $sh i32)
    (local $bps i32) (local $row i32) (local $trans i32)
    (local $ckey i32) (local $col i32) (local $x i32)
    (local.set $dst_entry (call $dx_from_this (local.get $arg0)))
    (local.set $dst_dib (i32.load (i32.add (local.get $dst_entry) (i32.const 20))))
    (local.set $dst_pitch (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 18))))
    (local.set $bps (i32.div_u (i32.load16_u (i32.add (local.get $dst_entry) (i32.const 16))) (i32.const 8)))
    (local.set $src_entry (call $dx_from_this (local.get $arg3)))
    (local.set $src_dib (i32.load (i32.add (local.get $src_entry) (i32.const 20))))
    (local.set $src_pitch (i32.load16_u (i32.add (local.get $src_entry) (i32.const 18))))
    (local.set $trans (call $gl32 (i32.add (global.get $esp) (i32.const 24)))) ;; dwTrans (6th arg)
    ;; Parse source rect
    (if (local.get $arg4)
      (then
        (local.set $sx (call $gl32 (local.get $arg4)))
        (local.set $sy (call $gl32 (i32.add (local.get $arg4) (i32.const 4))))
        (local.set $sw (i32.sub (call $gl32 (i32.add (local.get $arg4) (i32.const 8))) (local.get $sx)))
        (local.set $sh (i32.sub (call $gl32 (i32.add (local.get $arg4) (i32.const 12))) (local.get $sy))))
      (else
        (local.set $sx (i32.const 0)) (local.set $sy (i32.const 0))
        (local.set $sw (i32.load16_u (i32.add (local.get $src_entry) (i32.const 12))))
        (local.set $sh (i32.load16_u (i32.add (local.get $src_entry) (i32.const 14))))))
    ;; DDBLTFAST_SRCCOLORKEY = 0x1, DDBLTFAST_DESTCOLORKEY = 0x2
    (if (i32.and (local.get $trans) (i32.const 0x01))
      (then
        ;; Source color key blit — per-pixel compare
        (local.set $ckey (i32.load (i32.add (local.get $src_entry) (i32.const 24))))
        (local.set $row (i32.const 0))
        (block $ck_done (loop $ck_row
          (br_if $ck_done (i32.ge_u (local.get $row) (local.get $sh)))
          (local.set $x (i32.const 0))
          (block $ck_col_done (loop $ck_col
            (br_if $ck_col_done (i32.ge_u (local.get $x) (local.get $sw)))
            (if (i32.eq (local.get $bps) (i32.const 1))
              (then
                (local.set $col (i32.load8_u (i32.add (local.get $src_dib)
                  (i32.add (i32.mul (i32.add (local.get $sy) (local.get $row)) (local.get $src_pitch))
                           (i32.add (local.get $sx) (local.get $x))))))
                (if (i32.ne (local.get $col) (local.get $ckey))
                  (then
                    (i32.store8 (i32.add (local.get $dst_dib)
                      (i32.add (i32.mul (i32.add (local.get $arg2) (local.get $row)) (local.get $dst_pitch))
                               (i32.add (local.get $arg1) (local.get $x))))
                      (local.get $col)))))
              (else (if (i32.eq (local.get $bps) (i32.const 2))
              (then
                (local.set $col (i32.load16_u (i32.add (local.get $src_dib)
                  (i32.add (i32.mul (i32.add (local.get $sy) (local.get $row)) (local.get $src_pitch))
                           (i32.mul (i32.add (local.get $sx) (local.get $x)) (i32.const 2))))))
                (if (i32.ne (local.get $col) (local.get $ckey))
                  (then
                    (i32.store16 (i32.add (local.get $dst_dib)
                      (i32.add (i32.mul (i32.add (local.get $arg2) (local.get $row)) (local.get $dst_pitch))
                               (i32.mul (i32.add (local.get $arg1) (local.get $x)) (i32.const 2))))
                      (local.get $col)))))
              (else
                (local.set $col (i32.load (i32.add (local.get $src_dib)
                  (i32.add (i32.mul (i32.add (local.get $sy) (local.get $row)) (local.get $src_pitch))
                           (i32.mul (i32.add (local.get $sx) (local.get $x)) (i32.const 4))))))
                (if (i32.ne (local.get $col) (local.get $ckey))
                  (then
                    (i32.store (i32.add (local.get $dst_dib)
                      (i32.add (i32.mul (i32.add (local.get $arg2) (local.get $row)) (local.get $dst_pitch))
                               (i32.mul (i32.add (local.get $arg1) (local.get $x)) (i32.const 4))))
                      (local.get $col))))))))
            (local.set $x (i32.add (local.get $x) (i32.const 1)))
            (br $ck_col)))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $ck_row))))
      (else
        ;; No color key — fast row copies
        (local.set $row (i32.const 0))
        (block $bf_done (loop $bf_row
          (br_if $bf_done (i32.ge_u (local.get $row) (local.get $sh)))
          (call $memcpy
            (i32.add (local.get $dst_dib)
              (i32.add (i32.mul (i32.add (local.get $arg2) (local.get $row)) (local.get $dst_pitch))
                       (i32.mul (local.get $arg1) (local.get $bps))))
            (i32.add (local.get $src_dib)
              (i32.add (i32.mul (i32.add (local.get $sy) (local.get $row)) (local.get $src_pitch))
                       (i32.mul (local.get $sx) (local.get $bps))))
            (i32.mul (local.get $sw) (local.get $bps)))
          (local.set $row (i32.add (local.get $row) (i32.const 1)))
          (br $bf_row)))))
    ;; If dest is primary, present
    (if (i32.and (i32.load (i32.add (local.get $dst_entry) (i32.const 28))) (i32.const 1))
      (then (call $dx_present (local.get $dst_entry))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28)))) ;; 6 args

  ;; DeleteAttachedSurface — no-op
  (func $handle_IDirectDrawSurface_DeleteAttachedSurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; EnumAttachedSurfaces — no-op (return immediately)
  (func $handle_IDirectDrawSurface_EnumAttachedSurfaces (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawSurface_EnumOverlayZOrders (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; Flip(this, lpDDSurfaceTargetOverride, dwFlags)
  (func $handle_IDirectDrawSurface_Flip (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $back_guest i32) (local $back_entry i32)
    (local $tmp_dib i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $back_guest (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $back_guest)
      (then
        (local.set $back_entry (call $dx_from_this (local.get $back_guest)))
        ;; Swap DIB pointers
        (local.set $tmp_dib (i32.load (i32.add (local.get $entry) (i32.const 20))))
        (i32.store (i32.add (local.get $entry) (i32.const 20))
          (i32.load (i32.add (local.get $back_entry) (i32.const 20))))
        (i32.store (i32.add (local.get $back_entry) (i32.const 20)) (local.get $tmp_dib))
        (call $host_dx_trace (i32.const 6) (call $dx_slot_of (local.get $entry))
          (call $dx_slot_of (local.get $back_entry))
          (i32.load (i32.add (local.get $entry) (i32.const 20)))
          (local.get $tmp_dib))
        ;; Present front buffer
        (call $dx_present (local.get $entry))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetAttachedSurface(this, lpDDSCaps, lplpDDAttachedSurface)
  (func $handle_IDirectDrawSurface_GetAttachedSurface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    ;; misc0 stores the back buffer guest ptr (or 0)
    (if (i32.load (i32.add (local.get $entry) (i32.const 8)))
      (then
        (call $gs32 (local.get $arg2) (i32.load (i32.add (local.get $entry) (i32.const 8))))
        (global.set $eax (i32.const 0)))
      (else
        (global.set $eax (i32.const 0x887601FF)))) ;; DDERR_NOTFOUND
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetBltStatus — always DD_OK (blit is complete)
  (func $handle_IDirectDrawSurface_GetBltStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetCaps(this, lpDDSCaps)
  (func $handle_IDirectDrawSurface_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $flags i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $flags (i32.load (i32.add (local.get $entry) (i32.const 28))))
    ;; Write DDSCAPS.dwCaps
    (if (i32.and (local.get $flags) (i32.const 1))
      (then (call $gs32 (local.get $arg1) (i32.const 0x200))) ;; PRIMARY
      (else (call $gs32 (local.get $arg1) (i32.const 0x840)))) ;; OFFSCREEN|SYSTEMMEMORY
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetClipper — not supported
  (func $handle_IDirectDrawSurface_GetClipper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x887601FF))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetColorKey(this, dwFlags, lpDDColorKey)
  (func $handle_IDirectDrawSurface_GetColorKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (if (i32.and (i32.load (i32.add (local.get $entry) (i32.const 28))) (i32.const 0x100))
      (then
        (call $gs32 (local.get $arg2) (i32.load (i32.add (local.get $entry) (i32.const 24))))
        (call $gs32 (i32.add (local.get $arg2) (i32.const 4)) (i32.load (i32.add (local.get $entry) (i32.const 24))))
        (global.set $eax (i32.const 0)))
      (else
        (global.set $eax (i32.const 0x887601FF))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetDC(this, lphDC) — return a synthetic HDC for GDI operations on the surface
  ;; HDC = 0x200000 + slot_index (unique range, doesn't conflict with hwnd-based DCs)
  (func $handle_IDirectDrawSurface_GetDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $slot i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $slot (i32.div_u
      (i32.sub (local.get $entry) (global.get $DX_OBJECTS))
      (i32.const 32)))
    ;; Write *lphDC = 0x200000 + slot
    (call $gs32 (local.get $arg1) (i32.add (i32.const 0x200000) (local.get $slot)))
    ;; Fresh DIB → canvas snapshot so GDI draws see current pixels.
    (call $host_dx_surface_sync (local.get $slot) (i32.const 0))
    (global.set $eax (i32.const 0)) ;; DD_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetFlipStatus — always DD_OK
  (func $handle_IDirectDrawSurface_GetFlipStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectDrawSurface_GetOverlayPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetPalette — return a fresh palette COM wrapper (d3drm dereferences the pointer, so null isn't safe;
  ;; and DDERR_NOPALETTEATTACHED propagates up as a fatal DXException in d3drm-based screensavers).
  (func $handle_IDirectDrawSurface_GetPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32)
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 3) (global.get $DX_VTBL_DDPAL)))
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (local.get $obj_guest))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetPixelFormat(this, lpDDPixelFormat)
  (func $handle_IDirectDrawSurface_GetPixelFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $wa) (i32.const 32))
    (i32.store (local.get $wa) (i32.const 32))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x40)) ;; DDPF_RGB
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 16)) ;; 16bpp
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.const 0xF800))
    (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 0x07E0))
    (i32.store (i32.add (local.get $wa) (i32.const 24)) (i32.const 0x001F))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetSurfaceDesc(this, lpDDSD)
  (func $handle_IDirectDrawSurface_GetSurfaceDesc (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $wa i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $wa) (i32.const 108))
    (i32.store (local.get $wa) (i32.const 108))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x100F)) ;; DDSD_CAPS|HEIGHT|WIDTH|PITCH|PIXELFORMAT
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.load16_u (i32.add (local.get $entry) (i32.const 14))))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.load16_u (i32.add (local.get $entry) (i32.const 12))))
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.load16_u (i32.add (local.get $entry) (i32.const 18))))
    ;; Pixel format — set masks based on surface bpp
    (i32.store (i32.add (local.get $wa) (i32.const 72)) (i32.const 32))
    (i32.store (i32.add (local.get $wa) (i32.const 76)) (i32.const 0x40))
    (i32.store (i32.add (local.get $wa) (i32.const 84)) (i32.load16_u (i32.add (local.get $entry) (i32.const 16))))
    (if (i32.eq (i32.load16_u (i32.add (local.get $entry) (i32.const 16))) (i32.const 32))
      (then
        (i32.store (i32.add (local.get $wa) (i32.const 88)) (i32.const 0x00FF0000))
        (i32.store (i32.add (local.get $wa) (i32.const 92)) (i32.const 0x0000FF00))
        (i32.store (i32.add (local.get $wa) (i32.const 96)) (i32.const 0x000000FF)))
      (else
        (i32.store (i32.add (local.get $wa) (i32.const 88)) (i32.const 0xF800))
        (i32.store (i32.add (local.get $wa) (i32.const 92)) (i32.const 0x07E0))
        (i32.store (i32.add (local.get $wa) (i32.const 96)) (i32.const 0x001F))))
    ;; Caps — DDSCAPS_PRIMARYSURFACE for primary; else DDSCAPS_VIDEOMEMORY|DDSCAPS_OFFSCREENPLAIN.
    ;; Apps gate z-buffer / render-target acceptance on DDSCAPS_VIDEOMEMORY when a hardware
    ;; device is selected — returning SYSTEMMEMORY would cause CreateZBuffer to reject.
    (if (i32.and (i32.load (i32.add (local.get $entry) (i32.const 28))) (i32.const 1))
      (then (i32.store (i32.add (local.get $wa) (i32.const 104)) (i32.const 0x200)))
      (else (i32.store (i32.add (local.get $wa) (i32.const 104)) (i32.const 0x4040))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Initialize — no-op
  (func $handle_IDirectDrawSurface_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IsLost — never lost
  (func $handle_IDirectDrawSurface_IsLost (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Lock(this, lpDestRect, lpDDSD, dwFlags, hEvent) — 5 args
  (func $handle_IDirectDrawSurface_Lock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $wa i32) (local $dib_guest i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (call $host_dx_trace (i32.const 1) (call $dx_slot_of (local.get $entry))
      (i32.load (i32.add (local.get $entry) (i32.const 28)))
      (i32.load (i32.add (local.get $entry) (i32.const 20)))
      (i32.const 0))
    (local.set $wa (call $g2w (local.get $arg2)))
    ;; Fill DDSURFACEDESC
    (call $zero_memory (local.get $wa) (i32.const 108))
    (i32.store (local.get $wa) (i32.const 108))
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0x100F))
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.load16_u (i32.add (local.get $entry) (i32.const 14))))
    (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.load16_u (i32.add (local.get $entry) (i32.const 12))))
    (i32.store (i32.add (local.get $wa) (i32.const 16)) (i32.load16_u (i32.add (local.get $entry) (i32.const 18))))
    ;; lpSurface — guest address of DIB
    (local.set $dib_guest (i32.add
      (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 20))) (global.get $GUEST_BASE))
      (global.get $image_base)))
    (i32.store (i32.add (local.get $wa) (i32.const 36)) (local.get $dib_guest))
    ;; Pixel format — set masks based on surface bpp
    (i32.store (i32.add (local.get $wa) (i32.const 72)) (i32.const 32)) ;; ddpfPixelFormat.dwSize
    (i32.store (i32.add (local.get $wa) (i32.const 76)) (i32.const 0x40)) ;; DDPF_RGB
    (i32.store (i32.add (local.get $wa) (i32.const 84)) (i32.load16_u (i32.add (local.get $entry) (i32.const 16)))) ;; dwRGBBitCount
    (if (i32.eq (i32.load16_u (i32.add (local.get $entry) (i32.const 16))) (i32.const 32))
      (then
        (i32.store (i32.add (local.get $wa) (i32.const 88)) (i32.const 0x00FF0000)) ;; R
        (i32.store (i32.add (local.get $wa) (i32.const 92)) (i32.const 0x0000FF00)) ;; G
        (i32.store (i32.add (local.get $wa) (i32.const 96)) (i32.const 0x000000FF))) ;; B
      (else
        (i32.store (i32.add (local.get $wa) (i32.const 88)) (i32.const 0xF800)) ;; R 5-6-5
        (i32.store (i32.add (local.get $wa) (i32.const 92)) (i32.const 0x07E0)) ;; G
        (i32.store (i32.add (local.get $wa) (i32.const 96)) (i32.const 0x001F)))) ;; B
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24)))) ;; 5 args

  ;; ReleaseDC — commit GDI output (canvas) back to the surface's native DIB
  ;; so subsequent Blt/Flip/Present reads the drawn pixels.
  (func $handle_IDirectDrawSurface_ReleaseDC (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $slot i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $slot (call $dx_slot_of (local.get $entry)))
    (call $host_dx_surface_sync (local.get $slot) (i32.const 1))
    ;; If primary, present on ReleaseDC (mirrors Unlock). Apps like ddex2
    ;; draw via GetDC/StretchBlt/ReleaseDC without ever calling Lock/Unlock,
    ;; so without this the DIB update never reaches the screen.
    (if (i32.and (i32.load (i32.add (local.get $entry) (i32.const 28))) (i32.const 1))
      (then (call $dx_present (local.get $entry))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Restore — always DD_OK
  (func $handle_IDirectDrawSurface_Restore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; SetClipper — no-op
  (func $handle_IDirectDrawSurface_SetClipper (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetColorKey(this, dwFlags, lpDDColorKey)
  (func $handle_IDirectDrawSurface_SetColorKey (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    ;; DDCKEY_SRCBLT = 0x8, DDCKEY_DESTBLT = 0x2
    (i32.store (i32.add (local.get $entry) (i32.const 24))
      (call $gl32 (local.get $arg2))) ;; dwColorSpaceLowValue
    ;; Set has_colorkey flag
    (i32.store (i32.add (local.get $entry) (i32.const 28))
      (i32.or (i32.load (i32.add (local.get $entry) (i32.const 28))) (i32.const 0x100)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawSurface_SetOverlayPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetPalette(this, lpDDPalette) — associate palette with surface
  (func $handle_IDirectDrawSurface_SetPalette (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $pal_entry i32)
    ;; arg0 = this (surface), arg1 = palette COM object guest ptr
    ;; Look up the palette entry and store its data pointer for 8bpp present
    (if (local.get $arg1)
      (then
        (local.set $pal_entry (call $dx_from_this (local.get $arg1)))
        (global.set $dx_primary_pal_wa (i32.load (i32.add (local.get $pal_entry) (i32.const 20))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Unlock(this, lpRect)
  (func $handle_IDirectDrawSurface_Unlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (call $host_dx_trace (i32.const 2) (call $dx_slot_of (local.get $entry))
      (i32.load (i32.add (local.get $entry) (i32.const 28)))
      (i32.load (i32.add (local.get $entry) (i32.const 20)))
      (i32.const 0))
    ;; If primary, present on unlock
    (if (i32.and (i32.load (i32.add (local.get $entry) (i32.const 28))) (i32.const 1))
      (then (call $dx_present (local.get $entry))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectDrawSurface_UpdateOverlay (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IDirectDrawSurface_UpdateOverlayDisplay (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectDrawSurface_UpdateOverlayZOrder (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirectDrawSurface2 extensions — slots 36-38 beyond IDirectDrawSurface's 36.
  ;; flip3dtl QI's the RT surface for IID_IDirectDrawSurface2 and calls slot 36.
  (func $handle_IDirectDrawSurface2_GetDDInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (global.get $dx_ddraw_this))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IDirectDrawSurface2_PageLock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))
  (func $handle_IDirectDrawSurface2_PageUnlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; ── Present helper: blit DIB to screen via SetDIBitsToDevice ─
  ;; Constructs a BITMAPINFOHEADER on the stack and calls the existing host import
  (func $dx_present (param $entry_wa i32)
    (local $w i32) (local $h i32) (local $bpp i32) (local $pitch i32)
    (local $dib_wa i32) (local $bmi_wa i32) (local $i i32) (local $val i32)
    (local.set $w (i32.load16_u (i32.add (local.get $entry_wa) (i32.const 12))))
    (local.set $h (i32.load16_u (i32.add (local.get $entry_wa) (i32.const 14))))
    (local.set $bpp (i32.load16_u (i32.add (local.get $entry_wa) (i32.const 16))))
    (local.set $pitch (i32.load16_u (i32.add (local.get $entry_wa) (i32.const 18))))
    (local.set $dib_wa (i32.load (i32.add (local.get $entry_wa) (i32.const 20))))
    (call $host_dx_trace (i32.const 5) (call $dx_slot_of (local.get $entry_wa))
      (local.get $bpp) (local.get $dib_wa) (global.get $dx_primary_pal_wa))
    ;; Build BITMAPINFO at scratch area 0xAD40 (40-byte header + optional palette)
    ;; Space available: 0xAD40 to 0x12000 = plenty for header + 256-entry palette
    (local.set $bmi_wa (i32.const 0x0000AD40))
    (call $zero_memory (local.get $bmi_wa) (i32.const 1064)) ;; 40 + 256*4
    (i32.store (local.get $bmi_wa) (i32.const 40)) ;; biSize
    (i32.store (i32.add (local.get $bmi_wa) (i32.const 4)) (local.get $w))
    ;; Negative height = top-down DIB (DirectDraw surfaces are top-down)
    (i32.store (i32.add (local.get $bmi_wa) (i32.const 8))
      (i32.sub (i32.const 0) (local.get $h)))
    (i32.store16 (i32.add (local.get $bmi_wa) (i32.const 12)) (i32.const 1)) ;; biPlanes
    (i32.store16 (i32.add (local.get $bmi_wa) (i32.const 14)) (local.get $bpp))
    ;; For 8bpp, convert PALETTEENTRY (R,G,B,flags) → RGBQUAD (B,G,R,0)
    (if (i32.and (i32.le_u (local.get $bpp) (i32.const 8)) (i32.ne (global.get $dx_primary_pal_wa) (i32.const 0)))
      (then
        (local.set $i (i32.const 0))
        (block $pd (loop $pl
          (br_if $pd (i32.ge_u (local.get $i) (i32.const 256)))
          (local.set $val (i32.load (i32.add (global.get $dx_primary_pal_wa)
            (i32.shl (local.get $i) (i32.const 2)))))
          ;; swap byte0 (R) and byte2 (B), keep byte1 (G), clear byte3
          (i32.store (i32.add (i32.add (local.get $bmi_wa) (i32.const 40))
              (i32.shl (local.get $i) (i32.const 2)))
            (i32.or (i32.or
              (i32.shl (i32.and (local.get $val) (i32.const 0xFF)) (i32.const 16))
              (i32.and (local.get $val) (i32.const 0xFF00)))
              (i32.and (i32.shr_u (local.get $val) (i32.const 16)) (i32.const 0xFF))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $pl)))))
    ;; For 16bpp, set BI_BITFIELDS compression and write masks after header
    (if (i32.eq (local.get $bpp) (i32.const 16))
      (then
        (i32.store (i32.add (local.get $bmi_wa) (i32.const 16)) (i32.const 3)) ;; BI_BITFIELDS
        (i32.store (i32.add (local.get $bmi_wa) (i32.const 40)) (i32.const 0xF800))   ;; R mask
        (i32.store (i32.add (local.get $bmi_wa) (i32.const 44)) (i32.const 0x07E0))   ;; G mask
        (i32.store (i32.add (local.get $bmi_wa) (i32.const 48)) (i32.const 0x001F)))) ;; B mask
    (call $host_gdi_set_dib_to_device
      (i32.add (global.get $main_hwnd) (i32.const 0x40000)) ;; hdc = client DC
      (i32.const 0) (i32.const 0) ;; xDest, yDest
      (local.get $w) (local.get $h) ;; w, h
      (i32.const 0) (i32.const 0) ;; xSrc, ySrc
      (i32.const 0) (local.get $h) ;; startScan, cLines
      (local.get $dib_wa) ;; bits WASM addr
      (local.get $bmi_wa) ;; bmi WASM addr
      (i32.const 0)) ;; colorUse = DIB_RGB_COLORS
    (drop))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectDrawPalette methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectDrawPalette_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004002)) ;; E_NOINTERFACE
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawPalette_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectDrawPalette_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectDrawPalette_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 0x4)) ;; DDPCAPS_8BIT
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectDrawPalette_GetEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $pal_wa i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $pal_wa (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (if (local.get $pal_wa) (then
      (call $memcpy (call $g2w (local.get $arg4))
        (i32.add (local.get $pal_wa) (i32.mul (local.get $arg2) (i32.const 4)))
        (i32.mul (local.get $arg3) (i32.const 4)))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; IDirectDrawPalette::Initialize — already initialized, just return DD_OK
  (func $handle_IDirectDrawPalette_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawPalette_SetEntries (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $pal_wa i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $pal_wa (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (if (local.get $pal_wa) (then
      (call $memcpy (i32.add (local.get $pal_wa) (i32.mul (local.get $arg2) (i32.const 4)))
        (call $g2w (local.get $arg4))
        (i32.mul (local.get $arg3) (i32.const 4)))))
    (call $host_dx_trace (i32.const 4) (call $dx_slot_of (local.get $entry))
      (local.get $arg2) (local.get $arg3) (local.get $pal_wa))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectDrawClipper methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectDrawClipper_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Return same object for IUnknown / IDirectDrawClipper
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectDrawClipper_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectDrawClipper_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (local.get $rc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetClipList(this, lpRect, lpClipList, lpdwSize) — stub, return DDERR_NOCLIPLIST
  (func $handle_IDirectDrawClipper_GetClipList (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x887600CD)) ;; DDERR_NOCLIPLIST
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; GetHWnd(this, lphWnd)
  (func $handle_IDirectDrawClipper_GetHWnd (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (global.get $main_hwnd))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Initialize(this, lpDD, dwFlags) — no-op
  (func $handle_IDirectDrawClipper_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IsClipListChanged(this, lpbChanged) — always return FALSE
  (func $handle_IDirectDrawClipper_IsClipListChanged (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1)
      (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetClipList(this, lpClipList, dwFlags) — no-op
  (func $handle_IDirectDrawClipper_SetClipList (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetHWnd(this, dwFlags, hWnd) — no-op
  (func $handle_IDirectDrawClipper_SetHWnd (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectSound methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectSound_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectSound_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectSound_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; CreateSoundBuffer(this, lpDSBufferDesc, lplpDirectSoundBuffer, pUnkOuter)
  (func $handle_IDirectSound_CreateSoundBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc_wa i32) (local $flags i32) (local $buf_size i32)
    (local $fmt_wa i32) (local $obj i32) (local $entry i32) (local $buf_guest i32)
    (local.set $desc_wa (call $g2w (local.get $arg1)))
    ;; DSBUFFERDESC: +4 dwFlags, +8 dwBufferBytes, +12 dwReserved, +16 lpwfxFormat
    (local.set $flags (i32.load (i32.add (local.get $desc_wa) (i32.const 4))))
    (local.set $buf_size (i32.load (i32.add (local.get $desc_wa) (i32.const 8))))
    ;; Create DSBuffer COM object
    (local.set $obj (call $dx_create_com_obj (i32.const 5) (global.get $DX_VTBL_DSBUF)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    ;; DSBCAPS_PRIMARYBUFFER = 1
    (if (i32.and (local.get $flags) (i32.const 1))
      (then
        ;; Primary buffer — no allocation needed, just a marker
        (i32.store (i32.add (local.get $entry) (i32.const 28)) (i32.const 1)))
      (else
        ;; Secondary buffer — allocate guest memory for sound data
        (if (i32.gt_u (local.get $buf_size) (i32.const 0)) (then
          (local.set $buf_guest (call $heap_alloc (local.get $buf_size)))
          (call $zero_memory (call $g2w (local.get $buf_guest)) (local.get $buf_size))
          (i32.store (i32.add (local.get $entry) (i32.const 20)) (call $g2w (local.get $buf_guest)))))
        ;; Store buffer size in w/h fields
        (i32.store (i32.add (local.get $entry) (i32.const 12)) (local.get $buf_size))
        ;; Store format info from WAVEFORMATEX
        (local.set $fmt_wa (call $g2w (i32.load (i32.add (local.get $desc_wa) (i32.const 16)))))
        (if (local.get $fmt_wa) (then
          ;; WAVEFORMATEX: +2 nChannels, +4 nSamplesPerSec, +14 wBitsPerSample
          (i32.store16 (i32.add (local.get $entry) (i32.const 16))
            (i32.load16_u (i32.add (local.get $fmt_wa) (i32.const 2)))) ;; channels in bpp field
          (i32.store16 (i32.add (local.get $entry) (i32.const 18))
            (i32.load16_u (i32.add (local.get $fmt_wa) (i32.const 14)))) ;; bits in pitch field
          (i32.store (i32.add (local.get $entry) (i32.const 24))
            (i32.load (i32.add (local.get $fmt_wa) (i32.const 4))))  ;; sampleRate in colorkey field
        ))))
    ;; *lplpDirectSoundBuffer = obj
    (call $gs32 (local.get $arg2) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; GetCaps(this, lpDSCaps)
  (func $handle_IDirectSound_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $sz i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    ;; Respect caller's dwSize — DSCAPS shrank/grew across DX versions; writing
    ;; past the caller's buffer clobbers their stack frame (see GetCaps fix).
    (local.set $sz (i32.load (local.get $wa)))
    (if (i32.or (i32.lt_u (local.get $sz) (i32.const 16))
                (i32.gt_u (local.get $sz) (i32.const 96)))
      (then (local.set $sz (i32.const 96))))
    (call $zero_memory (local.get $wa) (local.get $sz))
    (i32.store (local.get $wa) (local.get $sz))
    ;; dwFlags: DSCAPS_PRIMARYSTEREO|DSCAPS_PRIMARY16BIT|DSCAPS_SECONDARYSTEREO|DSCAPS_SECONDARY16BIT
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0xF0))
    ;; dwMaxSecondarySampleRate = 44100
    (i32.store (i32.add (local.get $wa) (i32.const 56)) (i32.const 44100))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; DuplicateSoundBuffer(this, pOriginalBuffer, ppDuplicateBuffer)
  (func $handle_IDirectSound_DuplicateSoundBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $src_entry i32) (local $obj i32) (local $dst_entry i32)
    (local $buf_size i32) (local $buf_guest i32)
    ;; Look up source buffer entry
    (local.set $src_entry (call $dx_from_this (local.get $arg1)))
    ;; Create new DSBuffer COM object
    (local.set $obj (call $dx_create_com_obj (i32.const 5) (global.get $DX_VTBL_DSBUF)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (local.set $dst_entry (call $dx_from_this (local.get $obj)))
    ;; Copy format info from source: bufsize(+12), channels(+16), bits(+18), sampleRate(+24)
    (local.set $buf_size (i32.load (i32.add (local.get $src_entry) (i32.const 12))))
    (i32.store (i32.add (local.get $dst_entry) (i32.const 12)) (local.get $buf_size))
    (i32.store16 (i32.add (local.get $dst_entry) (i32.const 16))
      (i32.load16_u (i32.add (local.get $src_entry) (i32.const 16))))
    (i32.store16 (i32.add (local.get $dst_entry) (i32.const 18))
      (i32.load16_u (i32.add (local.get $src_entry) (i32.const 18))))
    (i32.store (i32.add (local.get $dst_entry) (i32.const 24))
      (i32.load (i32.add (local.get $src_entry) (i32.const 24))))
    (i32.store (i32.add (local.get $dst_entry) (i32.const 28))
      (i32.load (i32.add (local.get $src_entry) (i32.const 28))))
    ;; Allocate new buffer and copy data
    (if (i32.gt_u (local.get $buf_size) (i32.const 0)) (then
      (local.set $buf_guest (call $heap_alloc (local.get $buf_size)))
      (memory.copy
        (call $g2w (local.get $buf_guest))
        (i32.load (i32.add (local.get $src_entry) (i32.const 20)))
        (local.get $buf_size))
      (i32.store (i32.add (local.get $dst_entry) (i32.const 20))
        (call $g2w (local.get $buf_guest)))))
    ;; *ppDuplicateBuffer = obj
    (call $gs32 (local.get $arg2) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetCooperativeLevel — no-op
  (func $handle_IDirectSound_SetCooperativeLevel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Compact — no-op
  (func $handle_IDirectSound_Compact (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetSpeakerConfig
  (func $handle_IDirectSound_GetSpeakerConfig (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg1) (i32.const 0x200)) ;; DSSPEAKER_STEREO
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectSound_SetSpeakerConfig (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectSound_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectSoundBuffer methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectSoundBuffer_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectSoundBuffer_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectSoundBuffer_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then
        (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
        (if (local.get $handle) (then (drop (call $host_voice_close (local.get $handle)))))
        (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetCaps(this, lpDSBCaps)
  (func $handle_IDirectSoundBuffer_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $wa i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $wa (call $g2w (local.get $arg1)))
    (call $zero_memory (local.get $wa) (i32.const 20))
    (i32.store (local.get $wa) (i32.const 20)) ;; dwSize
    ;; dwFlags = DSBCAPS_CTRLVOLUME | DSBCAPS_CTRLPAN | DSBCAPS_CTRLFREQUENCY
    (i32.store (i32.add (local.get $wa) (i32.const 4)) (i32.const 0xE0))
    ;; dwBufferBytes
    (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetCurrentPosition(this, lpdwCurrentPlayCursor, lpdwCurrentWriteCursor)
  (func $handle_IDirectSoundBuffer_GetCurrentPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32) (local $pos i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $handle)
      (then (local.set $pos (call $host_voice_get_pos (local.get $handle))))
      (else (local.set $pos (i32.const 0))))
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (local.get $pos))))
    (if (local.get $arg2) (then (call $gs32 (local.get $arg2) (local.get $pos))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetFormat — stub
  (func $handle_IDirectSoundBuffer_GetFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $wa i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (if (local.get $arg1) (then
      (local.set $wa (call $g2w (local.get $arg1)))
      (call $zero_memory (local.get $wa) (i32.const 18))
      (i32.store16 (local.get $wa) (i32.const 1)) ;; WAVE_FORMAT_PCM
      (i32.store16 (i32.add (local.get $wa) (i32.const 2))
        (i32.load16_u (i32.add (local.get $entry) (i32.const 16)))) ;; channels
      (i32.store (i32.add (local.get $wa) (i32.const 4))
        (i32.load (i32.add (local.get $entry) (i32.const 24)))) ;; sampleRate
      (i32.store16 (i32.add (local.get $wa) (i32.const 14))
        (i32.load16_u (i32.add (local.get $entry) (i32.const 18)))) ;; bitsPerSample
    ))
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 18))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; GetVolume / GetPan / GetFrequency — return 0
  (func $handle_IDirectSoundBuffer_GetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectSoundBuffer_GetPan (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg1) (then (call $gs32 (local.get $arg1) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirectSoundBuffer_GetFrequency (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (if (local.get $arg1) (then
      (call $gs32 (local.get $arg1) (i32.load (i32.add (local.get $entry) (i32.const 24))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetStatus(this, lpdwStatus)
  (func $handle_IDirectSoundBuffer_GetStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $flags i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $flags (i32.load (i32.add (local.get $entry) (i32.const 28))))
    ;; bit 1 = playing, bit 2 = looping
    (if (local.get $arg1) (then
      (call $gs32 (local.get $arg1)
        (i32.and (local.get $flags) (i32.const 0x7)))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Initialize — no-op
  (func $handle_IDirectSoundBuffer_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Lock(this, dwOffset, dwBytes, ppvAudioPtr1, pdwAudioBytes1, ppvAudioPtr2, pdwAudioBytes2, dwFlags)
  ;; 8 args! We only have 5 from dispatch. Read remaining from stack.
  (func $handle_IDirectSoundBuffer_Lock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $dib_wa i32) (local $buf_size i32)
    (local $buf_guest i32) (local $ppv2 i32) (local $pdw2 i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $dib_wa (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (local.set $buf_size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    ;; Convert WASM addr to guest addr
    (local.set $buf_guest (i32.add
      (i32.sub (local.get $dib_wa) (global.get $GUEST_BASE))
      (global.get $image_base)))
    ;; *ppvAudioPtr1 = buffer + offset
    (call $gs32 (local.get $arg3) (i32.add (local.get $buf_guest) (local.get $arg1)))
    ;; *pdwAudioBytes1 = min(dwBytes, buf_size - offset)
    (call $gs32 (local.get $arg4)
      (select (local.get $arg2)
              (i32.sub (local.get $buf_size) (local.get $arg1))
              (i32.lt_u (local.get $arg2) (i32.sub (local.get $buf_size) (local.get $arg1)))))
    ;; ppvAudioPtr2 and pdwAudioBytes2 (args 6,7 at ESP+24,ESP+28)
    (local.set $ppv2 (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (local.set $pdw2 (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (if (local.get $ppv2) (then (call $gs32 (local.get $ppv2) (i32.const 0))))
    (if (local.get $pdw2) (then (call $gs32 (local.get $pdw2) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36)))) ;; 8 args

  ;; Play(this, dwReserved1, dwReserved2, dwFlags)
  ;; Snapshot the buffer's PCM via voice_play_ring. Each DSBuffer owns its own
  ;; voice (allocated lazily here), so multiple buffers mix instead of clobbering
  ;; each other the way the old single-waveOut routing did.
  (func $handle_IDirectSoundBuffer_Play (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32) (local $dib_wa i32) (local $buf_size i32)
    (local $channels i32) (local $bits i32) (local $rate i32) (local $loop i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $dib_wa (i32.load (i32.add (local.get $entry) (i32.const 20))))
    (local.set $buf_size (i32.load (i32.add (local.get $entry) (i32.const 12))))
    (local.set $channels (i32.load16_u (i32.add (local.get $entry) (i32.const 16))))
    (local.set $bits (i32.load16_u (i32.add (local.get $entry) (i32.const 18))))
    (local.set $rate (i32.load (i32.add (local.get $entry) (i32.const 24))))
    (if (i32.eqz (local.get $channels)) (then (local.set $channels (i32.const 1))))
    (if (i32.eqz (local.get $bits)) (then (local.set $bits (i32.const 16))))
    (if (i32.eqz (local.get $rate)) (then (local.set $rate (i32.const 22050))))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (i32.eqz (local.get $handle)) (then
      (local.set $handle (call $host_voice_open (local.get $rate) (local.get $channels) (local.get $bits)))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $handle))))
    ;; DSBPLAY_LOOPING = 1
    (local.set $loop (i32.and (local.get $arg3) (i32.const 1)))
    (if (i32.and (local.get $dib_wa) (local.get $buf_size)) (then
      (drop (call $host_voice_play_ring
        (local.get $handle) (local.get $dib_wa) (local.get $buf_size)
        (i32.const 0) (local.get $loop)))))
    (i32.store (i32.add (local.get $entry) (i32.const 28))
      (i32.or (i32.const 1) (i32.shl (local.get $loop) (i32.const 1))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; SetCurrentPosition — no-op (can't seek waveOut)
  (func $handle_IDirectSoundBuffer_SetCurrentPosition (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetFormat — no-op (primary buffer format)
  (func $handle_IDirectSoundBuffer_SetFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetVolume(this, lVolume) — DSOUND attenuation centibels (0=full, -10000=silent)
  (func $handle_IDirectSoundBuffer_SetVolume (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $handle) (then
      (call $host_voice_set_volume_db (local.get $handle) (local.get $arg1))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetPan(this, lPan) — centibels, -10000=left .. +10000=right
  (func $handle_IDirectSoundBuffer_SetPan (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $handle) (then
      (call $host_voice_set_pan (local.get $handle) (local.get $arg1))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetFrequency(this, dwFrequency) — playback rate in Hz; 0 = original
  (func $handle_IDirectSoundBuffer_SetFrequency (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $handle) (then
      (call $host_voice_set_freq (local.get $handle) (local.get $arg1))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; Stop(this) — stop playback but keep the voice; Play() may be called again
  (func $handle_IDirectSoundBuffer_Stop (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $handle i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $handle (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $handle) (then
      (drop (call $host_voice_stop (local.get $handle)))))
    (i32.store (i32.add (local.get $entry) (i32.const 28)) (i32.const 0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Unlock(this, pvAudioPtr1, dwAudioBytes1, pvAudioPtr2, dwAudioBytes2) — no-op
  (func $handle_IDirectSoundBuffer_Unlock (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; Restore — no-op
  (func $handle_IDirectSoundBuffer_Restore (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectInput methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectInput_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectInput_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectInput_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; CreateDevice(this, rguid, lplpDirectInputDevice, pUnkOuter)
  ;; rguid: GUID_SysKeyboard = {6F1D2B61-D5A0-11CF-BFC7-444553540000}
  ;;         GUID_SysMouse    = {6F1D2B60-D5A0-11CF-BFC7-444553540000}
  (func $handle_IDirectInput_CreateDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32) (local $entry i32) (local $guid_first i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 7) (global.get $DX_VTBL_DIDEV)))
    (if (i32.eqz (local.get $obj))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 20)))
        (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    ;; Detect keyboard vs mouse from GUID first dword
    (local.set $guid_first (call $gl32 (local.get $arg1)))
    (if (i32.eq (local.get $guid_first) (i32.const 0x6F1D2B61))
      (then (i32.store (i32.add (local.get $entry) (i32.const 8)) (i32.const 1))) ;; keyboard
      (else (i32.store (i32.add (local.get $entry) (i32.const 8)) (i32.const 2)))) ;; mouse
    (call $gs32 (local.get $arg2) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; EnumDevices — call callback twice (keyboard + mouse), or just return ok
  (func $handle_IDirectInput_EnumDevices (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; Simplified: don't call the callback, just return success
    ;; MARBLES creates devices by GUID, not by enumeration
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; GetDeviceStatus — always OK
  (func $handle_IDirectInput_GetDeviceStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; RunControlPanel — no-op
  (func $handle_IDirectInput_RunControlPanel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectInput_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectInputDevice methods
  ;; ════════════════════════════════════════════════════════════

  (func $handle_IDirectInputDevice_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    ;; QI must AddRef even when returning the same 'this' — otherwise a paired
    ;; Release on the original frees the DX_OBJECTS slot while the caller still
    ;; holds the QI'd pointer (MCM triggers exactly this pattern).
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectInputDevice_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectInputDevice_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetCapabilities — return basic caps
  (func $handle_IDirectInputDevice_GetCapabilities (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $wa i32) (local $entry i32)
    (local.set $wa (call $g2w (local.get $arg1)))
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    ;; DIDEVCAPS: dwSize=44, dwFlags, dwDevType, dwAxes, dwButtons, dwPOVs
    ;; Just zero it and set dwSize
    (call $zero_memory (local.get $wa) (i32.const 44))
    (i32.store (local.get $wa) (i32.const 44))
    (if (i32.eq (i32.load (i32.add (local.get $entry) (i32.const 8))) (i32.const 1))
      (then
        ;; Keyboard
        (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x11)) ;; DI8DEVTYPE_KEYBOARD
        (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 256))) ;; 256 keys
      (else
        ;; Mouse
        (i32.store (i32.add (local.get $wa) (i32.const 8)) (i32.const 0x12)) ;; DI8DEVTYPE_MOUSE
        (i32.store (i32.add (local.get $wa) (i32.const 12)) (i32.const 3)) ;; 3 axes
        (i32.store (i32.add (local.get $wa) (i32.const 20)) (i32.const 3)))) ;; 3 buttons
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; EnumObjects — no-op
  (func $handle_IDirectInputDevice_EnumObjects (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; GetProperty / SetProperty — no-op
  (func $handle_IDirectInputDevice_GetProperty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirectInputDevice_SetProperty (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Acquire / Unacquire — no-op
  (func $handle_IDirectInputDevice_Acquire (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirectInputDevice_Unacquire (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; GetDeviceState(this, cbData, lpvData)
  ;; For keyboard: fill 256-byte array with 0x80 for each pressed key
  ;; For mouse: fill DIMOUSESTATE (dx, dy, dz, rgbButtons[4]) = 16 bytes
  (func $handle_IDirectInputDevice_GetDeviceState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $dev_type i32) (local $wa i32) (local $i i32)
    (local $screen i32) (local $mx i32) (local $my i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $dev_type (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (local.set $wa (call $g2w (local.get $arg2)))
    (call $zero_memory (local.get $wa) (local.get $arg1))
    (if (i32.eq (local.get $dev_type) (i32.const 1))
      (then
        ;; Keyboard — fill 256 bytes, key[vk] = 0x80 if pressed
        (local.set $i (i32.const 0))
        (block $kbd_done (loop $kbd_lp
          (br_if $kbd_done (i32.ge_u (local.get $i) (i32.const 256)))
          (if (i32.and (call $host_get_async_key_state (local.get $i)) (i32.const 0x8000))
            (then (i32.store8 (i32.add (local.get $wa) (local.get $i)) (i32.const 0x80))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $kbd_lp))))
      (else
        ;; Mouse — DIMOUSESTATE: lX(4), lY(4), lZ(4), rgbButtons[4](4)
        ;; Get current mouse position from host (packed w|h << 16)
        (local.set $screen (call $host_get_screen_size))
        ;; We don't have direct mouse coords from host_get_screen_size.
        ;; Use host_check_input to poll — but that consumes messages.
        ;; For now, return 0 relative movement. Real tracking needs
        ;; the message pump to accumulate dx/dy.
        ;; TODO: track mouse deltas from WM_MOUSEMOVE in the message loop
        ))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetDeviceData — return 0 items
  (func $handle_IDirectInputDevice_GetDeviceData (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    ;; *pdwInOut = 0
    (if (local.get $arg3) (then (call $gs32 (local.get $arg3) (i32.const 0))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; SetDataFormat — no-op
  (func $handle_IDirectInputDevice_SetDataFormat (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetEventNotification — no-op
  (func $handle_IDirectInputDevice_SetEventNotification (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetCooperativeLevel — no-op
  (func $handle_IDirectInputDevice_SetCooperativeLevel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetObjectInfo — stub
  (func $handle_IDirectInputDevice_GetObjectInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004001))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; GetDeviceInfo — stub
  (func $handle_IDirectInputDevice_GetDeviceInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; RunControlPanel — no-op
  (func $handle_IDirectInputDevice_RunControlPanel (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Initialize — no-op
  (func $handle_IDirectInputDevice_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; Direct3DRMCreate(lplpD3DRM) → HRESULT — 1 arg stdcall
  ;; D3D Retained Mode is not supported; return E_FAIL
  (func $handle_Direct3DRMCreate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (if (local.get $arg0) (then
      (call $gs32 (local.get $arg0) (i32.const 0))))
    (global.set $eax (i32.const 0x80004005))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirect3D stub methods (9 methods)
  ;; All return E_FAIL (0x80004005) with correct stdcall stack cleanup.
  ;; ════════════════════════════════════════════════════════════

  ;; IDirect3D::QueryInterface(this, riid, ppvObj) — 3 args
  ;; Routes upgrades to v2/v3/v7 vtables on the same DX_OBJECTS slot.
  (func $handle_IDirect3D_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $d3dim_qi (i32.const 1) (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D::AddRef(this) — 1 arg
  (func $handle_IDirect3D_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; IDirect3D::Release(this) — 1 arg
  (func $handle_IDirect3D_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; IDirect3D::Initialize(this, riid) — 2 args
  (func $handle_IDirect3D_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; IDirect3D::EnumDevices(this, lpEnumDevicesCallback, lpUserArg) — 3 args
  ;; Invokes the callback once with a HAL device descriptor (shared with v2/v3).
  (func $handle_IDirect3D_EnumDevices (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    (if (i32.eqz (local.get $arg1)) (then
      (global.set $eax (i32.const 0x80070057))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (call $d3d_enum_devices_invoke (local.get $arg1) (local.get $arg2) (local.get $ret_addr)))

  ;; IDirect3D::CreateLight — mirrors the IDirect3D3 pattern (DX type 24, vtbl D3DLIGHT)
  (func $handle_IDirect3D_CreateLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 24) (global.get $DX_VTBL_D3DLIGHT)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D::CreateMaterial — DX type 25, vtbl D3DMAT3 (v1 caller upgrades on QI)
  (func $handle_IDirect3D_CreateMaterial (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 25) (global.get $DX_VTBL_D3DMAT3)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D::CreateViewport — DX type 23, vtbl D3DVP3
  (func $handle_IDirect3D_CreateViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 23) (global.get $DX_VTBL_D3DVP3)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D::FindDevice — succeed without populating result; the v1 caller
  ;; reads dwSize / GUIDs from the result struct, but our Phase-0 emulation
  ;; treats it as advisory and lets CreateDevice return a working object.
  (func $handle_IDirect3D_FindDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirect3D3 stub methods (10 methods)
  ;; ════════════════════════════════════════════════════════════

  ;; IDirect3D3::QueryInterface — routes upgrades across D3D family (v1/v2/v3/v7).
  (func $handle_IDirect3D3_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $d3dim_qi (i32.const 1) (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D3::AddRef(this) — 1 arg
  (func $handle_IDirect3D3_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; IDirect3D3::Release(this) — 1 arg
  (func $handle_IDirect3D3_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; IDirect3D3::EnumDevices(this, lpEnumDevicesCallback, lpUserArg) — 3 args
  (func $handle_IDirect3D3_EnumDevices (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $ret_addr i32)
    (if (i32.eqz (local.get $arg1)) (then
      (global.set $eax (i32.const 0x80070057))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    (call $d3d_enum_devices_invoke (local.get $arg1) (local.get $arg2) (local.get $ret_addr)))

  ;; IDirect3D3::CreateLight(this, lplpDirect3DLight, pUnkOuter) — 3 args
  (func $handle_IDirect3D3_CreateLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 24) (global.get $DX_VTBL_D3DLIGHT)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D3::CreateMaterial(this, lplpDirect3DMaterial, pUnkOuter) — 3 args
  (func $handle_IDirect3D3_CreateMaterial (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 25) (global.get $DX_VTBL_D3DMAT3)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D3::CreateViewport(this, lplpDirect3DViewport, pUnkOuter) — 3 args
  (func $handle_IDirect3D3_CreateViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 23) (global.get $DX_VTBL_D3DVP3)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
      (return)))
    (call $gs32 (local.get $arg1) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3D3::FindDevice(this, lpD3DFDS, lpD3DFDR) — 3 args
  (func $handle_IDirect3D3_FindDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Device state block layout (guest heap, 1024 bytes, zero-init then defaults):
  ;;   +0    world matrix    (64 bytes, 4x4 f32, row-major D3D)
  ;;   +64   view matrix     (64)
  ;;   +128  projection      (64)
  ;;   +192  scratch matrix  (64)
  ;;   +256  render state   [256 × i32]  indexed by D3DRENDERSTATETYPE (max ~209)
  ;;   +1280... exceeds 1024 — we keep render-state at +256 size 768 bytes = 192 slots
  ;; Revised: allocate 2048 bytes; we have room.
  ;;   +0     matrices (4 × 64 = 256)
  ;;   +256   render state  [512 × i32]  (2048 bytes total when combined below)
  ;;   we'll use 2048 total: mats 256 + rstate 1024 + lightstate 512 + scratch 256.
  ;; Simpler layout used by handlers below:
  ;;   +0     4 matrices × 64 bytes = 256
  ;;   +256   render state: 512 i32 slots = 2048 bytes
  ;;   +2304  light state:  128 i32 slots = 512 bytes
  ;; → total 2816; round up to 4096.
  ;; D3DTRANSFORMSTATETYPE: 1=WORLD 2=VIEW 3=PROJECTION 4-6=WORLD1/2/3, 7+=TEXTURE0..
  ;; Map WORLD family → slot 0, VIEW → 1, PROJECTION → 2, else scratch slot 3.
  (func $d3ddev_matrix_slot (param $xform i32) (result i32)
    (if (i32.or (i32.eq (local.get $xform) (i32.const 1))
        (i32.or (i32.eq (local.get $xform) (i32.const 4))
        (i32.or (i32.eq (local.get $xform) (i32.const 5))
                (i32.eq (local.get $xform) (i32.const 6)))))
      (then (return (i32.const 0))))
    (if (i32.eq (local.get $xform) (i32.const 2)) (then (return (i32.const 1))))
    (if (i32.eq (local.get $xform) (i32.const 3)) (then (return (i32.const 2))))
    (i32.const 3))

  (func $d3ddev_init_state (param $state_guest i32)
    (local $wa i32) (local $i i32)
    (local.set $wa (call $g2w (local.get $state_guest)))
    (call $zero_memory (local.get $wa) (i32.const 4096))
    ;; Identity matrices at world(+0), view(+64), projection(+128), scratch(+192).
    (local.set $i (i32.const 0))
    (block $done (loop $lp
      (br_if $done (i32.ge_u (local.get $i) (i32.const 4)))
      (f32.store (i32.add (local.get $wa) (i32.add (i32.mul (local.get $i) (i32.const 64)) (i32.const 0)))  (f32.const 1.0))
      (f32.store (i32.add (local.get $wa) (i32.add (i32.mul (local.get $i) (i32.const 64)) (i32.const 20))) (f32.const 1.0))
      (f32.store (i32.add (local.get $wa) (i32.add (i32.mul (local.get $i) (i32.const 64)) (i32.const 40))) (f32.const 1.0))
      (f32.store (i32.add (local.get $wa) (i32.add (i32.mul (local.get $i) (i32.const 64)) (i32.const 60))) (f32.const 1.0))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $lp))))

  ;; IDirect3D3::CreateDevice(this, refclsid, lpDDSurface, lplpD3DDevice, pUnkOuter) — 5 args
  ;; refclsid is the device-type GUID (HAL / RGB / etc). We ignore it and always
  ;; return a software RGB device. lpDDSurface is the render-target DD surface;
  ;; we store its DX slot on the device for future Phase 1+ rendering.
  (func $handle_IDirect3D3_CreateDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj i32) (local $entry i32) (local $rt_entry i32) (local $rt_slot i32) (local $state i32)
    (local.set $obj (call $dx_create_com_obj (i32.const 20) (global.get $DX_VTBL_D3DDEV3)))
    (if (i32.eqz (local.get $obj)) (then
      (global.set $eax (i32.const 0x80004005))
      (global.set $esp (i32.add (global.get $esp) (i32.const 24)))
      (return)))
    (local.set $entry (call $dx_from_this (local.get $obj)))
    ;; Record render-target DDSurface slot on the device entry at +8.
    (if (local.get $arg2) (then
      (local.set $rt_entry (call $dx_from_this (local.get $arg2)))
      (local.set $rt_slot (i32.div_u
        (i32.sub (local.get $rt_entry) (global.get $DX_OBJECTS))
        (i32.const 32)))
      (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $rt_slot))))
    ;; Allocate 4KB state block on guest heap, initialize, store ptr at entry+16.
    (local.set $state (call $heap_alloc (i32.const 4096)))
    (call $d3ddev_init_state (local.get $state))
    (i32.store (i32.add (local.get $entry) (i32.const 16)) (local.get $state))
    (call $gs32 (local.get $arg3) (local.get $obj))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; Helper: given device "this", return guest addr of its state block (or 0).
  (func $d3ddev_state (param $this_guest i32) (result i32)
    (local $entry i32) (local $wa i32) (local $slot i32)
    (local.set $wa (call $g2w (local.get $this_guest)))
    (local.set $slot (i32.load (i32.add (local.get $wa) (i32.const 4))))
    (if (i32.ge_u (local.get $slot) (global.get $DX_MAX)) (then
      (call $host_log_i32 (i32.const 0xD3DDBAD0))
      (call $host_log_i32 (local.get $this_guest))
      (call $host_log_i32 (local.get $slot))
      (return (i32.const 0))))
    (local.set $entry (i32.add (global.get $DX_OBJECTS) (i32.mul (local.get $slot) (i32.const 32))))
    (i32.load (i32.add (local.get $entry) (i32.const 16))))

  ;; IDirect3D3::CreateVertexBuffer(this, lpVBDesc, lplpD3DVertexBuffer, dwFlags, pUnkOuter) — 5 args
  (func $handle_IDirect3D3_CreateVertexBuffer (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0x80004005))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  ;; ════════════════════════════════════════════════════════════
  ;; IDirectDrawFactory methods (from ddrawex.dll)
  ;; ════════════════════════════════════════════════════════════
  ;; CLSID_DirectDrawFactory = {4FD2A832-86C8-11D0-8FCA-00C04FD9189D}
  ;; IID_IDirectDrawFactory  = {4FD2A823-86C8-11D0-8FCA-00C04FD9189D}
  ;; The factory is a thin shim over DirectDrawCreate; CreateDirectDraw returns
  ;; the same IDirectDraw object DirectDrawCreate would, so reuses VTBL_DDRAW.

  ;; QueryInterface(this, riid, ppv) — 3 args
  (func $handle_IDirectDrawFactory_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $iid_dword i32) (local $obj i32)
    (local.set $iid_dword (call $gl32 (local.get $arg1)))
    ;; Accept IUnknown (NULL/zero) and IDirectDrawFactory {4FD2A823-...}
    (if (i32.or (i32.eqz (local.get $iid_dword))
                (i32.eq (local.get $iid_dword) (i32.const 0x4FD2A823)))
      (then
        (call $gs32 (local.get $arg2) (local.get $arg0))
        ;; AddRef
        (local.set $obj (call $dx_from_this (local.get $arg0)))
        (i32.store (i32.add (local.get $obj) (i32.const 4))
          (i32.add (i32.load (i32.add (local.get $obj) (i32.const 4))) (i32.const 1)))
        (global.set $eax (i32.const 0))
        (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
        (return)))
    (call $gs32 (local.get $arg2) (i32.const 0))
    (global.set $eax (i32.const 0x80004002)) ;; E_NOINTERFACE
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; AddRef(this) — 1 arg
  (func $handle_IDirectDrawFactory_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Release(this) — 1 arg
  (func $handle_IDirectDrawFactory_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.eqz (local.get $rc))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (local.get $rc))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; CreateDirectDraw(this, pGUID, hWnd, dwCoopFlags, dwReserved, pUnkOuter, ppDirectDraw) — 6 args
  ;; The factory's coop level is supplied at creation time (vs DirectDrawCreate where SetCooperativeLevel
  ;; is called separately). We store hwnd in misc0 and ignore flags — the resulting IDirectDraw is
  ;; identical to what DirectDrawCreate yields.
  (func $handle_IDirectDrawFactory_CreateDirectDraw (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $obj_guest i32) (local $entry_wa i32) (local $pp_dd i32)
    ;; ppDirectDraw is the 6th arg, beyond arg4 — read it from stack at ESP+24 (after this+5*arg).
    ;; Stack: [ESP]=ret, [ESP+4]=this, [ESP+8]=pGUID, [ESP+12]=hWnd, [ESP+16]=dwCoopFlags,
    ;;        [ESP+20]=dwReserved, [ESP+24]=pUnkOuter, [ESP+28]=ppDirectDraw
    (local.set $pp_dd (call $gl32 (i32.add (global.get $esp) (i32.const 28))))
    (local.set $obj_guest (call $dx_create_com_obj (i32.const 1) (global.get $DX_VTBL_DDRAW)))
    (if (i32.eqz (local.get $obj_guest))
      (then
        (global.set $eax (i32.const 0x80004005))
        (global.set $esp (i32.add (global.get $esp) (i32.const 28))) ;; this + 6 args
        (return)))
    ;; Stash hWnd in misc0 (DDraw entry layout: +8 = hwnd)
    (local.set $entry_wa (call $dx_from_this (local.get $obj_guest)))
    (i32.store (i32.add (local.get $entry_wa) (i32.const 8)) (local.get $arg2))
    (call $gs32 (local.get $pp_dd) (local.get $obj_guest))
    (global.set $eax (i32.const 0)) ;; DD_OK
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  ;; DirectDrawEnumerate(this, lpCallback, lpContext) — 2 args
  ;; Same payload as the standalone DirectDrawEnumerateA — fires once for the primary driver.
  ;; We can't share the helper easily (different ESP cleanup count), so inline a minimal version
  ;; that calls back with NULL guid and returns DD_OK without trampolining, since most callers
  ;; just care about the enumeration completing.
  (func $handle_IDirectDrawFactory_DirectDrawEnumerate (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $desc i32) (local $name i32) (local $ret_addr i32)
    (local.set $ret_addr (call $gl32 (global.get $esp)))
    ;; Pop this + 2 args + ret
    (global.set $esp (i32.add (global.get $esp) (i32.const 16)))
    ;; Build description/name strings
    (local.set $desc (call $heap_alloc (i32.const 32)))
    (local.set $name (call $heap_alloc (i32.const 16)))
    (i32.store   (call $g2w (local.get $desc))                          (i32.const 0x6d697250))
    (i32.store   (call $g2w (i32.add (local.get $desc) (i32.const 4)))  (i32.const 0x20797261))
    (i32.store   (call $g2w (i32.add (local.get $desc) (i32.const 8)))  (i32.const 0x70736944))
    (i32.store   (call $g2w (i32.add (local.get $desc) (i32.const 12))) (i32.const 0x2079616c))
    (i32.store   (call $g2w (i32.add (local.get $desc) (i32.const 16))) (i32.const 0x76697244))
    (i32.store16 (call $g2w (i32.add (local.get $desc) (i32.const 20))) (i32.const 0x7265))
    (i32.store8  (call $g2w (i32.add (local.get $desc) (i32.const 22))) (i32.const 0))
    (i32.store   (call $g2w (local.get $name))                          (i32.const 0x70736964))
    (i32.store   (call $g2w (i32.add (local.get $name) (i32.const 4)))  (i32.const 0x0079616c))
    ;; Save original return address so the existing $ddenum_ret_thunk path returns to caller
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $ret_addr))
    ;; Push callback args (right-to-left): lpContext, lpName, lpDesc, lpGUID(=NULL)
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $arg2)) ;; lpContext
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $name))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (local.get $desc))
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (i32.const 0)) ;; lpGUID = NULL
    ;; Push continuation thunk as callback's return addr
    (global.set $esp (i32.sub (global.get $esp) (i32.const 4)))
    (call $gs32 (global.get $esp) (global.get $ddenum_ret_thunk))
    (global.set $eip (local.get $arg1))
    (global.set $steps (i32.const 0)))
  ;; ════════════════════════════════════════════════════════════
  ;; D3DIM Phase 0 — S_OK stubs (generated by scratch/gen-d3dim-phase0.js)
  ;; ════════════════════════════════════════════════════════════

  ;; ── IDirect3DDevice3 ─────────────────────────────────────────
  ;; IDirect3DDevice3::QueryInterface — routes upgrades across Device family (v1/v2/v3/v7).
  (func $handle_IDirect3DDevice3_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (call $d3dim_qi (i32.const 2) (local.get $arg0) (local.get $arg1) (local.get $arg2)))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DDevice3_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DDevice3_GetCaps (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_GetStats (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_AddViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vp_entry i32)
    (if (local.get $arg1) (then
      (local.set $vp_entry (call $dx_from_this (local.get $arg1)))
      (if (local.get $vp_entry)
        (then (i32.store (i32.add (local.get $vp_entry) (i32.const 8)) (local.get $arg0))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_DeleteViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_NextViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DDevice3_EnumTextureFormats (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_BeginScene (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DDevice3_EndScene (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DDevice3_GetDirect3D (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_SetCurrentViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $vp_entry i32)
    (if (local.get $arg1) (then
      (local.set $vp_entry (call $dx_from_this (local.get $arg1)))
      (if (local.get $vp_entry)
        (then (i32.store (i32.add (local.get $vp_entry) (i32.const 8)) (local.get $arg0))))))
    (call $d3dim_set_current_viewport (local.get $arg0) (local.get $arg1))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_GetCurrentViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_SetRenderTarget (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_GetRenderTarget (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_Begin (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DDevice3_BeginIndexed (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 24))))

  (func $handle_IDirect3DDevice3_Vertex (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_Index (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_End (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetRenderState(this, dwRenderStateType, lpdwRenderState) — 3 args
  (func $handle_IDirect3DDevice3_GetRenderState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $arg1) (i32.const 512)))
      (then (call $gs32 (local.get $arg2)
              (call $gl32 (i32.add (local.get $state)
                (i32.add (i32.const 256) (i32.mul (local.get $arg1) (i32.const 4))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetRenderState(this, dwRenderStateType, dwRenderState) — 3 args
  (func $handle_IDirect3DDevice3_SetRenderState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $arg1) (i32.const 512)))
      (then (call $gs32
              (i32.add (local.get $state)
                (i32.add (i32.const 256) (i32.mul (local.get $arg1) (i32.const 4))))
              (local.get $arg2))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetLightState(this, dwLightStateType, lpdwLightState) — 3 args
  (func $handle_IDirect3DDevice3_GetLightState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $arg1) (i32.const 128)))
      (then (call $gs32 (local.get $arg2)
              (call $gl32 (i32.add (local.get $state)
                (i32.add (i32.const 2304) (i32.mul (local.get $arg1) (i32.const 4))))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetLightState(this, dwLightStateType, dwLightState) — 3 args
  (func $handle_IDirect3DDevice3_SetLightState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0))
                 (i32.lt_u (local.get $arg1) (i32.const 128)))
      (then (call $gs32
              (i32.add (local.get $state)
                (i32.add (i32.const 2304) (i32.mul (local.get $arg1) (i32.const 4))))
              (local.get $arg2))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; SetTransform(this, dtstTransformStateType, lpD3DMATRIX) — 3 args
  (func $handle_IDirect3DDevice3_SetTransform (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32) (local $slot i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0)) (local.get $arg2)) (then
      (local.set $slot (call $d3ddev_matrix_slot (local.get $arg1)))
      (call $memcpy
        (call $g2w (i32.add (local.get $state) (i32.mul (local.get $slot) (i32.const 64))))
        (call $g2w (local.get $arg2))
        (i32.const 64))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; GetTransform(this, dtstTransformStateType, lpD3DMATRIX) — 3 args
  (func $handle_IDirect3DDevice3_GetTransform (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $state i32) (local $slot i32)
    (local.set $state (call $d3ddev_state (local.get $arg0)))
    (if (i32.and (i32.ne (local.get $state) (i32.const 0)) (local.get $arg2)) (then
      (local.set $slot (call $d3ddev_matrix_slot (local.get $arg1)))
      (call $memcpy
        (call $g2w (local.get $arg2))
        (call $g2w (i32.add (local.get $state) (i32.mul (local.get $slot) (i32.const 64))))
        (i32.const 64))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_MultiplyTransform (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; IDirect3DDevice3::DrawPrimitive(primType, vtxType, lpvVerts, dwVtxCount, dwFlags)
  (func $handle_IDirect3DDevice3_DrawPrimitive (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dwVertexCount i32)
    (local.set $dwVertexCount (call $gl32 (i32.add (global.get $esp) (i32.const 20))))
    (call $d3dim_draw_primitive (local.get $arg0) (local.get $arg1) (local.get $arg2)
      (local.get $arg3) (local.get $dwVertexCount))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IDirect3DDevice3_DrawIndexedPrimitive (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))))

  (func $handle_IDirect3DDevice3_SetClipStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_GetClipStatus (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DDevice3_DrawPrimitiveStrided (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IDirect3DDevice3_DrawIndexedPrimitiveStrided (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 36))))

  (func $handle_IDirect3DDevice3_DrawPrimitiveVB (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IDirect3DDevice3_DrawIndexedPrimitiveVB (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  (func $handle_IDirect3DDevice3_ComputeSphereVisibility (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  (func $handle_IDirect3DDevice3_GetTexture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_SetTexture (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $d3dim_set_texture (local.get $arg0) (local.get $arg1) (local.get $arg2))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DDevice3_GetTextureStageState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DDevice3_SetTextureStageState (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $d3dim_set_tss (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DDevice3_ValidateDevice (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; ── IDirect3DViewport3 ─────────────────────────────────────────
  (func $handle_IDirect3DViewport3_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DViewport3_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DViewport3_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DViewport3_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_GetViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_SetViewport (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_TransformVertices (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 28))))

  (func $handle_IDirect3DViewport3_LightElements (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DViewport3_SetBackground (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_GetBackground (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DViewport3_SetBackgroundDepth (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_GetBackgroundDepth (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Clear(this, dwCount, lpRects, dwFlags) — 4 args. No color/z (uses background).
  (func $handle_IDirect3DViewport3_Clear (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (call $d3dim_viewport_clear_full (local.get $arg0) (local.get $arg3) (i32.const 0) (f32.const 1.0))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DViewport3_AddLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_DeleteLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_NextLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  (func $handle_IDirect3DViewport3_GetViewport2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_SetViewport2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_SetBackgroundDepth2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DViewport3_GetBackgroundDepth2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; Clear2(this, dwCount, lpRects, dwFlags, dwColor, dvZ, dwStencil) — 6 args + this.
  ;; arg3=dwFlags, arg4=dwColor; dvZ and dwStencil are deeper on the stack.
  (func $handle_IDirect3DViewport3_Clear2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $dvZ_bits i32)
    ;; dvZ sits 1 dword past arg4 on the caller stack: [retaddr][a0][a1][a2][a3][a4=dwColor][dvZ][stencil]
    ;; esp currently still points at retaddr (we haven't popped yet).
    (local.set $dvZ_bits (call $gl32 (i32.add (global.get $esp) (i32.const 24))))
    (call $d3dim_viewport_clear_full
      (local.get $arg0) (local.get $arg3) (local.get $arg4)
      (f32.reinterpret_i32 (local.get $dvZ_bits)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 32))))

  ;; ── IDirect3DLight ─────────────────────────────────────────
  ;; Each Light slot owns a 76-byte D3DLIGHT buffer on the guest heap;
  ;; its guest pointer lives at DX_OBJECTS entry +8 (misc0). Lazy-allocated
  ;; on first SetLight so CreateLight stays cheap for apps that never
  ;; configure a light.
  (func $dx_light_buf (param $entry i32) (result i32)
    (local $g i32)
    (local.set $g (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (i32.eqz (local.get $g)) (then
      (local.set $g (call $heap_alloc (i32.const 76)))
      (if (local.get $g) (then
        (call $zero_memory (call $g2w (local.get $g)) (i32.const 76))
        (i32.store (i32.add (local.get $entry) (i32.const 8)) (local.get $g))))))
    (local.get $g))

  (func $handle_IDirect3DLight_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DLight_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DLight_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32) (local $buf i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then
        (local.set $buf (i32.load (i32.add (local.get $entry) (i32.const 8))))
        (if (local.get $buf) (then
          (call $heap_free (local.get $buf))
          (i32.store (i32.add (local.get $entry) (i32.const 8)) (i32.const 0))))
        (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; Initialize(this, lpDirect3D) — advisory. Keep S_OK; the v1 glue is vestigial.
  (func $handle_IDirect3DLight_Initialize (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; SetLight(this, lpLight) — copy caller's D3DLIGHT (first dword is dwSize) into
  ;; our per-slot buffer. Clamp to 76 (full D3DLIGHT2) to keep older/shorter
  ;; D3DLIGHT structs safe.
  (func $handle_IDirect3DLight_SetLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $buf i32) (local $dwSize i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $buf (call $dx_light_buf (local.get $entry)))
    (if (local.get $arg1) (then
      (if (local.get $buf) (then
        (local.set $dwSize (call $gl32 (local.get $arg1)))
        (if (i32.gt_u (local.get $dwSize) (i32.const 76)) (then (local.set $dwSize (i32.const 76))))
        (if (i32.lt_u (local.get $dwSize) (i32.const 4)) (then (local.set $dwSize (i32.const 76))))
        (call $memcpy
          (call $g2w (local.get $buf))
          (call $g2w (local.get $arg1))
          (local.get $dwSize))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; GetLight(this, lpLight) — caller provides D3DLIGHT* with dwSize prefilled.
  ;; Copy back min(dwSize, 76) bytes from our buffer. If no SetLight ever ran,
  ;; our buffer stays zeroed except the caller-visible dwSize echo.
  (func $handle_IDirect3DLight_GetLight (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $buf i32) (local $dwSize i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $buf (i32.load (i32.add (local.get $entry) (i32.const 8))))
    (if (local.get $arg1) (then
      (local.set $dwSize (call $gl32 (local.get $arg1)))
      (if (i32.gt_u (local.get $dwSize) (i32.const 76)) (then (local.set $dwSize (i32.const 76))))
      (if (i32.lt_u (local.get $dwSize) (i32.const 4)) (then (local.set $dwSize (i32.const 76))))
      (if (local.get $buf)
        (then
          (call $memcpy
            (call $g2w (local.get $arg1))
            (call $g2w (local.get $buf))
            (local.get $dwSize)))
        (else
          ;; No stored light yet — zero the caller buffer then restore dwSize.
          (call $zero_memory (call $g2w (local.get $arg1)) (local.get $dwSize))
          (call $gs32 (local.get $arg1) (local.get $dwSize))))))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  ;; ── IDirect3DMaterial3 ─────────────────────────────────────────
  (func $handle_IDirect3DMaterial3_QueryInterface (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (call $gs32 (local.get $arg2) (local.get $arg0))
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DMaterial3_AddRef (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (i32.store (i32.add (local.get $entry) (i32.const 4))
      (i32.add (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (global.set $eax (i32.load (i32.add (local.get $entry) (i32.const 4))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DMaterial3_Release (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (local $entry i32) (local $rc i32)
    (local.set $entry (call $dx_from_this (local.get $arg0)))
    (local.set $rc (i32.sub (i32.load (i32.add (local.get $entry) (i32.const 4))) (i32.const 1)))
    (i32.store (i32.add (local.get $entry) (i32.const 4)) (local.get $rc))
    (if (i32.le_s (local.get $rc) (i32.const 0))
      (then (call $dx_free (local.get $entry))))
    (global.set $eax (select (local.get $rc) (i32.const 0) (i32.gt_s (local.get $rc) (i32.const 0))))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DMaterial3_SetMaterial (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DMaterial3_GetMaterial (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 12))))

  (func $handle_IDirect3DMaterial3_GetHandle (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  (func $handle_IDirect3DMaterial3_Reserved1 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  (func $handle_IDirect3DMaterial3_Reserved2 (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

  ;; ============================================================
  ;; VIDEO FOR WINDOWS (VFW) — codec enumeration stubs
  ;; ============================================================

  ;; ICInfo(fccType, fccHandler, lpicinfo) — 3 args
  ;; Returns FALSE: no codecs available
  (func $handle_ICInfo (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 16))))

  ;; ICOpen(fccType, fccHandler, wMode, ...) — 4 args
  ;; Returns NULL: no codec handle
  (func $handle_ICOpen (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 20))))

  ;; ICClose(hic) — 1 arg
  (func $handle_ICClose (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)
    (global.set $eax (i32.const 0))
    (global.set $esp (i32.add (global.get $esp) (i32.const 8))))

