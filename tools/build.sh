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
DX_LAYOUT_ARGS=(--file=src/09a8-handlers-directx.wat,src/09aa-handlers-d3dim.wat,src/09ab-handlers-d3dim-core.wat,src/09ad-handlers-d3d9.wat,src/09a7-handlers-dispatch.wat
  --layout=DxObject --layout-from=src/09a8-handlers-directx.wat
  --base-local=entry,dst_entry,src_entry,back_entry,parent,surf_entry,pal_entry
  --base-call='$dx_from_this'
  --skip-func='$d3dim_stateblock_create,$d3dim_stateblock_apply,$d3dim_stateblock_capture,$d3dim_stateblock_delete,$d3dim_lights_refresh,$message_table_lookup')
node tools/layout-migrate.js "${DX_LAYOUT_ARGS[@]}" --gate > /dev/null || {
  node tools/layout-migrate.js "${DX_LAYOUT_ARGS[@]}" --gate; exit 1; }
# WndRecord (wave 2) — the 24-byte per-window record. Deliberately NO
# --base-local: 09c0-window-table.wat owns ~20 PARALLEL per-slot tables, and its
# $addr locals also hold MENU_DATA_TABLE, class-long and WND_OWN_DC_TABLE
# pointers. With --base-local the codemod converts 10 sites instead of 3 and
# labels seven of them as fields of a record they are not in — all at offset 0,
# so the bytes never move and the byte-identity oracle cannot catch it. In a
# file with parallel tables, recognize the base by CALL only.
node tools/layout-migrate.js --file=src/09c0-window-table.wat --layout=WndRecord \
  --base-call='$wnd_record_addr' --gate > /dev/null || {
  node tools/layout-migrate.js --file=src/09c0-window-table.wat --layout=WndRecord \
    --base-call='$wnd_record_addr' --gate; exit 1; }

# GdiObject (wave 5) — the 48-byte GDI object record, which is a DISCRIMINATED
# UNION and so gets SEVEN variant layouts rather than one, all 48 bytes, all
# agreeing on handle@0 / type@4. There is no --gate here because there is
# nothing to convert: all 160 sites are `offset=` memarg-spelled, and load.field
# lowers to the add form, so this family has to wait for the memarg lowering
# (design doc §3.4(b)) before it can be converted byte-identically. What this
# gate does instead is check the part a codemod could never do — that every site
# is attributed to an object TYPE, that the offset it reads is a field that type
# actually owns, and that the attribution does not contradict the function's own
# +4 discriminant guard.
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
