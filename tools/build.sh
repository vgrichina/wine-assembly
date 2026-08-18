#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

# The shipped wasm compiles from WAT_FILES in lib/compile-wat.js, not from the
# src/*.wat glob — a part that lands in src/ but not in WAT_FILES is silently
# absent from the build while still appearing in build/combined.wat.
node tools/check-wat-manifest.js
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

echo "Concatenating WAT parts..."
# From WAT_FILES, not a shell glob: combined.wat must be the same sequence the
# real compile sees, or every function index in it names the wrong function.
node tools/concat-wat.js

echo "Compiling with lib/compile-wat.js..."
node tools/build-compile-wat.js

ls -la build/wine-assembly.wasm
