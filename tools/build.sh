#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

# The shipped wasm compiles from WAT_FILES in lib/compile-wat.js, not from the
# src/*.wat glob — a part that lands in src/ but not in WAT_FILES is silently
# absent from the build while still appearing in build/combined.wat.
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
# a safety net — hold the two together here.
node tools/check-region-decls.js
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
# Every handler's stdcall epilogue, checked against api_table.json's nargs —
# the values are derived from the table now, not typed. `--sync` rewrites any
# that drift.
node tools/esp-epilogue.js --check
# The WATX compiler under tools/watx-src/ is a vendored copy of ../android-emu,
# and a vendored copy is only trustworthy while somebody can say what it is a
# copy OF. Fail if any imported file's bytes no longer match the SHA-256 the
# import recorded, so a silent edit or an unlogged re-sync cannot ship.
node tools/check-watx-provenance.js

echo "Concatenating WAT parts..."
# From WAT_FILES, not a shell glob: combined.wat must be the same sequence the
# real compile sees, or every function index in it names the wrong function.
node tools/concat-wat.js
# Keep the lightweight structural checker honest and useful. The compiler is
# authoritative for syntax; this gate adds targeted diagnostics for unmatched
# parentheses and out-of-scope branch labels before a WAT edit ships.
node tools/check-parens.js build/combined.wat --no-diff --quiet

# WHICH compiler produces build/wine-assembly.wasm is selectable — Milestone 5
# of docs/watx-migration-plan.md. Both modes write the same canonical paths and
# every gate above and below runs unchanged, so rollback is this one env var:
#
#   bash tools/build.sh                              # legacy (default today)
#   WINE_WAT_COMPILER=watx   bash tools/build.sh      # WATX, from src/main.watx
#   WINE_WAT_COMPILER=legacy bash tools/build.sh      # explicit rollback
#
# build/combined.wat is written from WAT_FILES in BOTH modes: it is the grep /
# check-parens / func-index surface and is never itself compiled.
echo "Compiling (WINE_WAT_COMPILER=${WINE_WAT_COMPILER:-legacy})..."
node tools/build-compile-wat.js

# Two (data ...) segments that cover the same byte: the later one wins at
# instantiation and eats the earlier one's NUL terminator, which turns a
# string compare into a compare against the concatenation of both strings.
# check-data-strings.js reads the source, so it cannot see this -- only the
# compiled module can.
node tools/wasm-data.js build/wine-assembly.wasm --overlaps

ls -la build/wine-assembly.wasm
