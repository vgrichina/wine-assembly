#!/bin/bash
# Milestone 0 of docs/watx-migration-plan.md: build the LEGACY (lib/compile-wat.js)
# artifacts into build/legacy/ twice and prove the bytes are reproducible.
#
# The canonical build/wine-assembly*.wasm are never touched here — the plan keeps
# legacy and WATX outputs in separate directories for the whole migration:
#
#   build/legacy/wine-assembly.wasm         build/watx/wine-assembly.wasm
#   build/legacy/wine-assembly.compat.wasm  build/watx/wine-assembly.compat.wasm
#
# Usage:
#   bash tools/watx-baseline.sh              # gates + two builds + hash compare
#   bash tools/watx-baseline.sh --skip-gates # two builds + hash compare only
#
# --skip-gates exists because tools/build.sh's gate section covers the whole
# repository (test-suite membership, api ids, silent stubs...). A gate that is
# red for an unrelated reason must not make the compiler's own determinism
# unmeasurable. It never skips a step that affects the emitted bytes.
set -e

cd "$(dirname "$0")/.."

SKIP_GATES=0
for arg in "$@"; do
  case "$arg" in
    --skip-gates) SKIP_GATES=1 ;;
    *) echo "watx-baseline: unknown argument $arg" >&2; exit 2 ;;
  esac
done

OUTDIR=build/legacy
mkdir -p "$OUTDIR"

if [ "$SKIP_GATES" = "0" ]; then
  echo "== build gates =="
  bash tools/build.sh > /dev/null
fi

hash_run() {
  # $1 = run label
  # The label goes to stderr: stdout is captured and compared, so a run number
  # in it would make every comparison unequal.
  echo "== legacy build run $1 ==" >&2
  node tools/concat-wat.js > /dev/null
  node tools/build-compile-wat.js \
    --out="$OUTDIR/wine-assembly.wasm" \
    --compat-out="$OUTDIR/wine-assembly.compat.wasm" > /dev/null
  shasum -a 256 "$OUTDIR/wine-assembly.wasm" "$OUTDIR/wine-assembly.compat.wasm" \
    | awk '{print $1"  "$2}'
}

RUN1=$(hash_run 1)
RUN2=$(hash_run 2)

echo
echo "run 1:"
echo "$RUN1"
echo "run 2:"
echo "$RUN2"
echo

if [ "$RUN1" = "$RUN2" ]; then
  echo "watx-baseline: OK — legacy artifacts are byte-reproducible"
  echo "wine commit: $(git rev-parse HEAD)"
  echo "node: $(node --version)"
  exit 0
fi

echo "watx-baseline: FAIL — the legacy build is not reproducible" >&2
exit 1
