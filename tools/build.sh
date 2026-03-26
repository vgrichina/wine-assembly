#!/bin/bash
set -e

cd "$(dirname "$0")/.."

mkdir -p build

echo "Compiling main.wat..."
wat2wasm src/main.wat -o build/wine-assembly.wasm

echo "Build complete: build/wine-assembly.wasm"
ls -la build/wine-assembly.wasm
