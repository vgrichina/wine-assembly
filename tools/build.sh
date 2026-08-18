#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

node tools/check-handler-count.js
# A handler that never pops its stdcall frame corrupts the guest stack, and the
# wild jump only shows up thousands of instructions later. The compiler accepts
# a surplus ')' that closes a function early and orphans its cleanup line, so
# this gate is the thing that catches it — keep it in the build, not on demand.
node tools/check-handler-esp.js
# Adding a host import to 01-header.wat without regenerating the signature table
# does not break the build or the normal page — it breaks WORKER mode only, and
# it breaks it QUIETLY: the worker's broker builds its import object from this
# JSON, so the missing name arrives as undefined, instantiate() fails with
# "requires a callable", and host.js falls back to single-threaded. Launching an
# app then looks merely slower. Gate it here, where whoever added the import is
# already standing.
node tools/gen-host-import-sigs.js --check

echo "Concatenating WAT parts..."
# LC_ALL=C affects the shell's glob sorting (must be exported before the glob expands),
# so dash sorts before letters: 01-header.wat precedes 01b-api-hashes.generated.wat.
export LC_ALL=C
cat src/*.wat > build/combined.wat

echo "Compiling with lib/compile-wat.js..."
node tools/build-compile-wat.js

ls -la build/wine-assembly.wasm
