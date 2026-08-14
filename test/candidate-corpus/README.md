# CLI candidate corpus

This is an intentionally separate pool of possible future Wine-Assembly
fixtures. It is not referenced by `test/run-all.sh`, `test/test-all-exes.js`,
the browser app list, or deployment tooling.

The manifest records exact versions, source pages, package hashes, executable
names, and small CLI smoke budgets. Candidate binaries are downloaded beneath
`test/binaries/candidates/`, which is gitignored like the rest of the local
binary fixture pool.

## Fetch

Fetch every automatically recoverable package:

```sh
node tools/fetch-candidate-corpus.js
```

Fetch selected entries or replace an existing local fixture:

```sh
node tools/fetch-candidate-corpus.js --id=dxball,qbob,cave-story
node tools/fetch-candidate-corpus.js --id=putty --force
```

The fetcher verifies every package against its pinned SHA-1 before extraction.
It uses `7z`, with `unar` as a fallback for older RAR/self-extracting packages.
Entries with no package list are deliberately manual: either the original
package is not directly recoverable, it is too large to pull as part of a
routine candidate setup, or the archived package is not the required Windows
build.

## Run

Run the local candidate survey in the CLI harness:

```sh
node test/test-cli-candidate-corpus.js
node test/test-cli-candidate-corpus.js --id=dxball,qbob
```

Useful inspection modes:

```sh
node test/test-cli-candidate-corpus.js --list
node test/test-cli-candidate-corpus.js --dry-run
node test/test-cli-candidate-corpus.js --strict
```

The runner rejects DOS, NE, and non-x86 files before invoking Wine-Assembly;
only PE32/i386 executables enter the survey. It compiles one immutable WAT
snapshot and reuses that snapshot for every local candidate. The default
survey prints an ASCII status table with `READY`, `BLOCKED`, `SKIP`, or
`HARNESS` rows and exits successfully when applications merely hit expected
compatibility gaps. `--list` and `--dry-run` use the same table with
`LOCAL`/`MISSING` status. `--strict` turns `BLOCKED` into a failing result.
Harness/build failures always fail because they mean the survey itself could
not produce useful evidence.
Each launch is bounded to 20 seconds by default; a manifest entry can override
that when a candidate needs a longer startup window.

## Legal boundary

An Internet Archive item is provenance, not a redistribution license. GPL/MIT
packages still carry their normal notice/source obligations, proprietary
freeware and shareware remain local research fixtures, and Dependency Walker
is explicitly internal-only because its upstream terms forbid bundling it with
another product. None of these files should enter public deployment merely
because the fetcher can recover them.
