#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

node tools/check-handler-count.js

echo "Concatenating WAT parts..."
# LC_ALL=C affects the shell's glob sorting (must be exported before the glob expands),
# so dash sorts before letters: 01-header.wat precedes 01b-api-hashes.generated.wat.
export LC_ALL=C
cat src/*.wat > build/combined.wat

echo "Compiling combined.wat..."
wat2wasm --enable-tail-call --enable-threads build/combined.wat -o build/wine-assembly.wasm

echo "Build complete: build/wine-assembly.wasm"
ls -la build/wine-assembly.wasm
