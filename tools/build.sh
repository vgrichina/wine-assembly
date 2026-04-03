#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

echo "Concatenating WAT parts..."
cat src/*.wat > build/combined.wat

echo "Compiling combined.wat..."
wat2wasm build/combined.wat -o build/wine-assembly.wasm

echo "Build complete: build/wine-assembly.wasm"
ls -la build/wine-assembly.wasm
