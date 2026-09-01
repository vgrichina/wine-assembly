#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

# The shipped wasm IS src/main.watx's (include ...) closure, so an include that
# names a missing file is already a located compile error. What the compiler
# CANNOT see is the other direction: a part that lands in src/ and is included
# by nobody is silently absent from the build while still appearing in
# build/combined.wat. That, plus filename order, is what this gate is for.
node tools/check-wat-manifest.js
# Every src/*.wat fragment must balance its own parentheses. check-parens.js only
# proves the CONCATENATION balances, so a stray closer in one file cancelled by a
# missing one in another passes it — that is exactly how the surplus close in
# 10d-gdi-region-path.wat survived. Since the (module ...) wrapper moved into
# tools/concat-wat.js there are no exceptions: any nonzero net is a bug.
node tools/check-wat-fragments.js
# Fixed WAT tables share one flat linear-memory address space. A collision is
# valid WAT and compiles cleanly, then silently cross-corrupts unrelated state
# at runtime, so the sized-region/data-segment map is a shipping gate.
node test/test-wat-memory-map.js
# src/00-regions.wat declares that same map to the compiler, which then enforces
# overlap-freedom, alignment and memory bounds itself. A declaration set that
# has drifted from the globals the code actually reads is a second opinion, not
# a safety net — hold the two together here. --strict because the declaration
# set is complete: a new sized region without a mirror declaration is an error.
node tools/check-region-decls.js --strict
# Raw address literals inside declared regions are a RATCHET: the count per file
# may fall (bank it with --record), never rise, and a region marked converted
# must stay at zero. This is what keeps the symbolization wave from regressing.
node tools/region-census.js --gate
# lib/region-map.generated.js is the JS mirror of the declarations — the one
# copy Node, workers and the browser all read. A stale mirror is a silent
# re-fork of the map into two truths, so hold it fresh here.
node tools/gen-region-map.js --check
# ...and nothing but that mirror may spell an ALLOCATED base. The ratchet above
# cannot ask this: it ignores allocated bases on purpose, because an address the
# allocator picked this morning cannot be "written down twice". But it is exactly
# the address a JS file must never hold, since it MOVES on the next size change
# with no error anywhere — see d59ce229, a copied base that was zeroing 32KB of
# $PE_STAGING per worker spawn. Hard gate, not a ratchet: the answer is zero.
node tools/region-census.js --js-copies
# ...and neither may a WAT fragment a JS test splices into our sources. That
# fragment is compiled by our own compiler, so region.addr resolves inside it,
# which makes a bare (i32.const N) in a MEMORY-OPERAND position a copy of the
# map by construction. Neither gate above can see one: the ratchet skips
# allocated bases, and --js-copies matches only CURRENT bases and ends, which a
# STALE copy never equals. test-wave-out-get-id stored a waveOut handle at
# 0xD160 — $WAVE_OUT_SHARED before the map moved, and by then 0x1010 into
# $SCROLL_TABLE — and answered MMSYSERR_INVALHANDLE to a valid handle for it.
node tools/region-census.js --embedded-wat
# JS host-side guest-pointer translation must use the same DIB/RPC boundary as
# WAT. A stale extra megabyte maps guest DIB addresses onto worker RPC slots.
node test/test-wat-rpc-region.js
# Constants copied across the WAT/JS boundary form an ABI even though both
# languages compile independently. Check the guest base, fixed-table bases and
# strides, Win16 module ids, process-handle tag, and GPU opcode word counts.
node tools/check-wat-js-constants.js
# A test that is not named in a run-all tier never executes. Keep suite
# membership complete as a cheap build gate, before spending time compiling.
bash tools/check-test-manifest.sh
# api_ids are array positions baked into the compiled hash table, the generated
# br_table, and 09b-dispatch.wat's fast paths. A mid-array insert renumbers them
# all; these two gates catch that before it becomes a runtime mystery.
node tools/check-api-table.js
node tools/gen_dispatch.js --check
node tools/check-hash-table.js > /dev/null || { node tools/check-hash-table.js; exit 1; }
# Hardcoded data-segment offsets in the ordinal-import tables vs. what those
# addresses actually hold.
node tools/check-data-strings.js
node tools/check-handler-count.js
# A handler that never pops its stdcall frame corrupts the guest stack, and the
# wild jump only shows up thousands of instructions later. The compiler accepts
# a surplus ')' that closes a function early and orphans its cleanup line, so
# this gate is the thing that catches it — keep it in the build, not on demand.
node tools/check-handler-esp.js
# WAT has no boolean type and i32.and is bitwise, so combining an address,
# count, class id or non-bit-0 mask with a predicate can make a true condition
# false based on unrelated low bits. Keep the reviewed Win32-layer sites and
# the general pointer-shaped pattern normalized to explicit 0/1 values.
node tools/check-wat-logical-and.js
# A handler that returns success while leaving callbacks/output pointers
# untouched fails much later under an unrelated API name. Pin the legacy
# inventory so it can only change deliberately, and forbid dangerous D3D9
# resource/output methods from returning D3D_OK without implementation.
node tools/check-silent-stubs.js
# Adding a host import to 01-header.wat without regenerating the signature table
# does not break the build or the normal page — it breaks WORKER mode only, and
# it breaks it QUIETLY: the worker's broker builds its import object from this
# JSON, so the missing name arrives as undefined, instantiate() fails with
# "requires a callable", and host.js falls back to single-threaded. Launching an
# app then looks merely slower. Gate it here, where whoever added the import is
# already standing.
node tools/gen-host-import-sigs.js --check
# The committed browser bundle of the toy VM must be reproducible from source.
# It inlines every tools/toyvm module verbatim, so a source edit that skips
# regeneration ships old code to the page while every test stays green on the
# committed bytes — that drift went unnoticed across whole commit windows twice.
node tools/toyvm/bundle-browser.js --check
# Every handler's stdcall epilogue, checked against api_table.json's nargs —
# the values are derived from the table now, not typed. `--sync` rewrites any
# that drift.
node tools/esp-epilogue.js --check
# The WATX compiler under tools/watx-src/ is a vendored copy of ../android-emu,
# and a vendored copy is only trustworthy while somebody can say what it is a
# copy OF. Fail if any imported file's bytes no longer match the SHA-256 the
# import recorded, so a silent edit or an unlogged re-sync cannot ship.
node tools/check-watx-provenance.js
# A struct that has been migrated to a (layout ...) must STAY migrated. Without
# this the tree quietly re-grows hand-spelled field offsets against a record
# whose offsets now live in one place, and the migration undoes itself over
# months. One line per migrated struct — see docs/watx-layout-migration-design.md.
# The gate keys on the BASE SYMBOL, not on the offset literals: grepping for
# `(i32.const 56)` would fire on every unrelated 56 in the file, and a gate that
# cries wolf gets deleted.
node tools/layout-migrate.js --file=src/09d-winsock.wat --layout=VSock \
  --base-local=rec,prec,lrec,crec --base-call='$vsock_rec' --gate > /dev/null || {
  node tools/layout-migrate.js --file=src/09d-winsock.wat --layout=VSock \
    --base-local=rec,prec,lrec,crec --base-call='$vsock_rec' --gate; exit 1; }
# DxObject (wave 4) — the 32-byte DX_OBJECTS entry, reached through
# $dx_from_this from five files. --skip-func names the functions where a local
# called `$entry` is NOT this record (12-byte D3DIM_STATEBLOCKS records, a
# packed debug key, a PE message-table cursor); base recognition there is by
# call only. Keep this list in step with the one in the wave-4 commit — dropping
# a name from it does not make the gate stricter, it makes the codemod convert
# sites that are not DX objects.
#
# --memarg (the completion wave) — wave 4 could only reach the add-form sites,
# so the 28 that spell the offset in the instruction stayed raw AND STAYED
# INVISIBLE TO THIS GATE. Measured: hand-respelling a converted site as
# `(i32.load offset=4 (local.get $entry))` passed the pre-memarg gate with
# exit 0. It fails now. That is the whole reason the flag is here.
#
# u16 (the 16-bit wave) — a5fc1b72 closed the compiler's field-type set and
# gave u16/s16/s8 real opcodes, so width/height/bpp/pitch at +12/+14/+16/+18
# are declared at their true width and their 64 sites are converted. Until then
# they were `u8 2` for spacing and every access stayed hand-spelled, and THOSE
# SITES WERE INVISIBLE TO THIS GATE for the same reason the memarg ones were:
# the tool's op table had no i32.load16_u, so it did not see them at all.
# Measured: at HEAD with the u8[2] declaration and all 64 raw sites present the
# gate exited 0; with the u16 declaration one planted `(i32.load16_u offset=16
# (local.get $entry))` fails it. layout-migrate.js's FIELD_SIZE table must stay
# in step with the compiler's WATX_LAYOUT_FIELD_TYPES — the two compute the same
# struct offsets independently, and a drift mis-attributes every later field.
#
# THE +12/+16 DWORD SITES IT STILL DECLINES ARE CORRECT AND MUST STAY RAW.
# Those two dwords are UNIONS, like misc0/misc1/misc2: width/height/bpp/pitch is
# the SURFACE arm, while a DirectInput device reads a whole-dword `capacity` at
# +12 and a D3D device a `version` at +16. 59 sites spell i32.load/i32.store
# there and the width mismatch is the only thing telling the two readings apart.
# Widening them to `load.field width` would read two fields as one and label a
# capacity as a width — byte-identically, so the oracle would not catch it.
DX_LAYOUT_ARGS=(--file=src/09a8-handlers-directx.wat,src/09aa-handlers-d3dim.wat,src/09ab-handlers-d3dim-core.wat,src/09ad-handlers-d3d9.wat,src/09a7-handlers-dispatch.wat
  --layout=DxObject --layout-from=src/09a8-handlers-directx.wat
  --base-local=entry,dst_entry,src_entry,back_entry,parent,surf_entry,pal_entry
  --base-call='$dx_from_this'
  --skip-func='$d3dim_stateblock_create,$d3dim_stateblock_apply,$d3dim_stateblock_capture,$d3dim_stateblock_delete,$d3dim_lights_refresh,$message_table_lookup'
  --memarg)
node tools/layout-migrate.js "${DX_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${DX_LAYOUT_ARGS[@]}" --gate; exit 1; }
# WndRecord (wave 2) — the 24-byte per-window record. Deliberately NO
# --base-local: 09c0-window-table.wat owns ~20 PARALLEL per-slot tables, and its
# $addr locals also hold MENU_DATA_TABLE, class-long and WND_OWN_DC_TABLE
# pointers. With --base-local the codemod converts 10 sites instead of 3 and
# labels seven of them as fields of a record they are not in — all at offset 0,
# so the bytes never move and the byte-identity oracle cannot catch it. In a
# file with parallel tables, recognize the base by CALL only.
#
# The completion wave keeps that rule and adds the two things wave 2 could not
# have: --memarg (30 of 09c0's own sites spell the offset in the instruction,
# and like DxObject above they were invisible to this gate — a planted
# `(i32.load offset=8 (local.get $ptr))` passed it with exit 0 before), and the
# other two files of the family, 09c3-controls.wat and 09c5-menu.wat.
#
# --base-local-from-call, still NOT --base-local — the parallel-table hazard in
# the comment above is exactly why. That flag accepts `rec`/`addr`/`ptr` only in
# the functions where EVERY assignment to the local is the $wnd_record_addr
# call, so provenance is checked rather than guessed; a plain name match on
# `$addr` is what would have relabelled the MENU_DATA_TABLE and class-long
# pointers as WndRecord.hwnd at offset 0, byte-identically and undetectably.
WND_LAYOUT_ARGS=(--file=src/09c0-window-table.wat,src/09c3-controls.wat,src/09c5-menu.wat
  --layout=WndRecord --layout-from=src/09c0-window-table.wat
  --base-call='$wnd_record_addr' --base-local-from-call=rec,addr,ptr --memarg)
node tools/layout-migrate.js "${WND_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${WND_LAYOUT_ARGS[@]}" --gate; exit 1; }

# GdiObject (wave 5) — the 48-byte GDI object record, which is a DISCRIMINATED
# UNION and so gets SEVEN variant layouts rather than one, plus GdiObjectAny for
# the handle@0 / type@4 prefix they all share. All eight are 48 bytes, so
# (size-of ...) pins the table stride whichever one a site reaches for.
#
# All 160 sites are CONVERTED now (the .memarg lowering of 009f35de is what made
# that possible), so this gate does ATTRIBUTE **AND** REFUSE-RAW, like the other
# nine — but it is not a layout-migrate --gate line, because a union has no
# single layout to point one at. It is its own tool for that reason, and it does
# four things a --gate line cannot:
#
#   * REFUSE RAW: struct-offset-census.js must find NO hand-spelled offset
#     arithmetic left against `call $gdi_object_record`. Anything it does find
#     is reported with the variant that site should have been spelled as.
#   * every site must spell the variant its ATTRIBUTION names — the wrong-layout
#     check (§6.2), which only became possible once the sites named a layout at
#     all. A bitmap's +24 read as a font's strike compiles perfectly.
#   * a +0/+4 site must spell GdiObjectAny, and nothing else may: those sites
#     have not decided a type yet (they are usually the read that decides), and
#     naming one of the seven there claims one they do not have.
#   * the attribution must not contradict the function's own +4 discriminant
#     guard, harvested from the source in BOTH spellings.
#
# Verified to exit 1 on each of the four: a planted raw site, a bitmap field
# spelled GdiFont, GdiObjectAny used above the prefix, and a variant named at a
# +4 site. A gate that cannot fail is not a gate.
node tools/gdi-variant-gate.js > /dev/null || { node tools/gdi-variant-gate.js; exit 1; }

# TthPoint (the first MEMARG wave) — the 28-byte hinted-point record. --memarg
# is what makes this family convertible at all: 53 of its 72 sites spell the
# offset in the instruction, and those lower through `load.field.memarg`, a
# different encoding from the add form. It is opt-in per family on purpose —
# VSock, WndRecord and DxObject above all still carry unconverted memarg sites,
# and passing --memarg to their gates would fail them without anyone having
# asked for a conversion.
#
# --base-local-from-call, NOT --base-local: `$a` has 26 assignments in this file
# and 2 of them are points, `$b` has 16 and 2. A name match would label 24 and
# 14 unrelated sites as fields of TthPoint, byte-identically, so the oracle
# could never catch it. This flag accepts a local only in the functions where
# EVERY assignment to it is the base call.
TTH_LAYOUT_ARGS=(--file=src/10c1-truetype-hint.wat --layout=TthPoint
  --base-call='$tth_point' --base-local-from-call=p,point,pt,a,b,pa0,pa1,pb0,pb1 --memarg)
node tools/layout-migrate.js "${TTH_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${TTH_LAYOUT_ARGS[@]}" --gate; exit 1; }

# GdiDcState — the 96-byte per-HDC state slot, reached through
# $gdi_dc_state_entry. --memarg: every one of its 38 convertible sites spells
# the offset in the instruction, so without it this family converts nothing.
#
# --base-local-from-call, NOT --base-local, and the reason is inside the
# accessor itself: $gdi_dc_state_entry's own `$p` walks the table AND is the
# scan cursor, and `$dc` in 10f/10b is also used for host DC descriptors and
# for $gdi_surface_descriptor's `$desc` block, which has an unrelated field at
# +36. Every one of those would have converted byte-identically under a name
# match. Provenance declines them and converts only the 38 the call proves.
#
# The remaining raw sites are all inside $gdi_dc_state_entry, which BUILDS the
# record ($empty/$p are computed from the table base, not returned by the call)
# — the same constructor-shaped decline TthPoint has. Do not "fix" those by
# adding --base-local; that would trade a checkable derivation for a name.
GDI_DC_LAYOUT_ARGS=(--file=src/10f-gdi-dc.wat,src/10b-gdi-font.wat,src/10c-truetype.wat
  --layout=GdiDcState --layout-from=src/10f-gdi-dc.wat
  --base-call='$gdi_dc_state_entry' --base-local-from-call=dc,entry --memarg)
node tools/layout-migrate.js "${GDI_DC_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${GDI_DC_LAYOUT_ARGS[@]}" --gate; exit 1; }

# LoopOp — the 8-byte threaded-code op HEADER, as $te writes it, read at decode
# time through $loop_op_at. --memarg because 85 of the 167 convertible sites
# spell the offset in the instruction; --base-local-from-call because $p is a
# general-purpose scratch name in this file and only the functions where every
# assignment to it is the base call may be converted (12 of them qualify).
#
# This gate covers the header ONLY, and that is the finding of the wave rather
# than a shortcut: the words at +8 and beyond are a discriminated union keyed by
# the handler index at +0, with per-handler arity and no length field — +8 is a
# fall-through for Jcc but the branch target for LOOP, a SIB info word for the
# indexed forms and a bare disp32 for the _ro family. The declaration beside
# $loop_op_at carries the evidence. --gate is safe over that union because an
# undeclared offset is not a convertible site, so those 76 hand-spelled reads
# neither fail the build nor get silently attributed to a field they are not.
LOOPOP_LAYOUT_ARGS=(--file=src/07b-loop-match.wat --layout=LoopOp
  --base-call='$loop_op_at' --base-local-from-call=p,x --memarg)
node tools/layout-migrate.js "${LOOPOP_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${LOOPOP_LAYOUT_ARGS[@]}" --gate; exit 1; }

# PaintRect — the 16-byte slot of the PAINT_SCRATCH ring, handed out by
# $paint_scratch_take. A plain Win32 RECT: $paint_rect writes l/t/r/b in that
# order and every reader takes them back the same way.
#
# COMPLETE. edf55a7a covered the four files that were unclaimed when that wave
# ran and deferred five more that other lanes were holding; 09c3, 09c5, 09a8 and
# 13-exports were freed afterwards and are converted and listed here (27 more
# sites), and 09a5 turned out to carry no raw site at all. Every file of the
# family is now gated. A file missing from this list is silently ungated, so add
# one the day a new file reaches this record.
#
# THREE sites inside these listed files stay raw ON PURPOSE, and each carries a
# comment at the site saying so. The ring hands out 16 opaque bytes and what
# they MEAN is the caller's business, so not every slot is a RECT:
#   * 09b-dispatch.wat passes the slot straight to $w2g as an address and never
#     names a field at all;
#   * 09c3 $statusbar_wndproc builds an "X, Y" string in one, writing a comma at
#     a RUNTIME offset;
#   * 09c5 $menu_draw_submenu_arrow stores the single byte '>' in one.
# The last two are i32.store8 at +0, which is exactly why the codemod declines
# them — the access width disagrees with the i32 field — rather than naming a
# rect edge for a character. $coord_w and $glyph are deliberately absent from
# --base-local-from-call for the same reason.
PAINT_RECT_LAYOUT_ARGS=(--file=src/10-helpers.wat,src/09a-handlers.wat,src/09c4-defwndproc.wat,src/09b-dispatch.wat,src/09c3-controls.wat,src/09c5-menu.wat,src/09a8-handlers-directx.wat,src/13-exports.wat
  --layout=PaintRect --layout-from=src/10-helpers.wat
  --base-call='$paint_scratch_take' --base-local-from-call=rect,p,box,brect --memarg)
node tools/layout-migrate.js "${PAINT_RECT_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${PAINT_RECT_LAYOUT_ARGS[@]}" --gate; exit 1; }

# GdiDcPath — the 16-byte GDI_DC_PATH_TABLE slot, one per HDC with a path open
# or closed, reached through $gdi_dc_path_entry. All four fields are i32, so the
# u16/s16/s8 types added in a5fc1b72 do not apply to this record.
#
# --base-local-from-call is LOAD-BEARING HERE more than anywhere else in this
# block: 10d reaches THREE different record tables through a local named
# $entry — $gdi_dc_path_entry, $gdi_dc_clip_entry and $gdi_dc_system_clip_entry
# — and all three are small records whose low offsets would convert
# byte-identically under a name match, with the oracle unable to say a word.
# Provenance converts the 20 path functions and declines all 12 clip ones.
#
# The comment above $gdi_dc_path_discard documents a SECOND record: the
# count/capacity/figure-start/flags header of the guest point buffer this one
# points at. Different base ($g2w of buffer), NOT covered by this gate, and a
# good candidate for a later wave.
GDI_PATH_LAYOUT_ARGS=(--file=src/10d-gdi-region-path.wat --layout=GdiDcPath
  --base-call='$gdi_dc_path_entry' --base-local-from-call=entry --memarg)
node tools/layout-migrate.js "${GDI_PATH_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${GDI_PATH_LAYOUT_ARGS[@]}" --gate; exit 1; }

echo "Concatenating WAT parts..."
# From the src/main.watx include list, not a shell glob: combined.wat must be
# the same sequence the real compile resolves, or every function index in it
# names the wrong function.
node tools/concat-wat.js
# Keep the lightweight structural checker honest and useful. The compiler is
# authoritative for syntax; this gate adds targeted diagnostics for unmatched
# parentheses and out-of-scope branch labels before a WAT edit ships.
node tools/check-parens.js build/combined.wat --no-diff --quiet

# build/wine-assembly.wasm is compiled by the vendored WATX compiler. The
# legacy lib/compile-wat.js rollback is RETIRED (2026-08-31, the M6
# symbolization wave): the tree contains region-symbolic spellings legacy
# compiles to runtime traps, so build-compile-wat.js hard-errors on
# WINE_WAT_COMPILER=legacy. See docs/watx-region-safety-design.md §11.
#
# build/combined.wat is still written from the same include list: it is the grep
# / check-parens / func-index surface and is never itself compiled.
echo "Compiling (WATX)..."
node tools/build-compile-wat.js

# Two (data ...) segments that cover the same byte: the later one wins at
# instantiation and eats the earlier one's NUL terminator, which turns a
# string compare into a compare against the concatenation of both strings.
# check-data-strings.js reads the source, so it cannot see this -- only the
# compiled module can.
node tools/wasm-data.js build/wine-assembly.wasm --overlaps

ls -la build/wine-assembly.wasm
