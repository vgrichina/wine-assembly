#!/usr/bin/env node
/**
 * Per-fragment WAT parenthesis gate (Milestone 2.2 of docs/watx-migration-plan.md).
 *
 * Wired into tools/build.sh's gate section. Also runnable by hand:
 *
 *   node tools/check-wat-fragments.js            # gate every file in WAT_FILES
 *   node tools/check-wat-fragments.js --verbose  # also print the clean files
 *   node tools/check-wat-fragments.js src/10d-gdi-region-path.wat [...]
 *
 * Why a separate checker: tools/check-parens.js analyzes ONE file (by default
 * the concatenated build/combined.wat) and only reports whether that whole
 * stream balances. A fragment can be individually malformed — a stray closer
 * near the top cancelled by a missing one further down — and still concatenate
 * into a balanced module, which is exactly how the surplus close recorded in
 * the migration plan survived. This checker holds each fragment to its own
 * balance instead.
 *
 * STRICT: every fragment must net to zero. There are no exceptions and no
 * mechanism for adding one. The source-level `(module ...)` wrapper that used
 * to make src/01-header.wat net +1 and src/13-exports.wat net -1 is gone —
 * tools/concat-wat.js adds it around build/combined.wat instead, and
 * lib/compile-wat.js consumes bare top-level module fields directly. If a
 * fragment fails here, fix the fragment.
 *
 * Rejected in every file:
 *   - a mid-file negative-depth dip (a closer with no opener before it), even
 *     if a later opener makes the totals balance again;
 *   - any final depth other than zero;
 *   - an unterminated string or block comment.
 *
 * Exit 0 when every fragment passes, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// No fragment may ever dip below zero: a closer with no opener before it is a
// structural error even when a later opener makes the totals balance again.
const MIN_DEPTH = 0;

/**
 * Blank out WAT strings and (; block comments ;) and ;; line comments while
 * preserving offsets, so data strings full of parens and semicolons are not
 * mistaken for module structure. Same rules as tools/check-parens.js — that
 * file is a CLI script with no exports, so the scanner is duplicated rather
 * than required.
 */
function structuralLines(lines) {
  const result = [];
  const errors = [];
  let inString = false;
  let escaped = false;
  let blockDepth = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    let structural = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (blockDepth) {
        if (ch === '(' && next === ';') {
          blockDepth++;
          structural += '  ';
          i++;
        } else if (ch === ';' && next === ')') {
          blockDepth--;
          structural += '  ';
          i++;
        } else {
          structural += ' ';
        }
        continue;
      }

      if (inString) {
        structural += ' ';
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === ';' && next === ';') {
        structural += ' '.repeat(line.length - i);
        break;
      }
      if (ch === '(' && next === ';') {
        blockDepth = 1;
        structural += '  ';
        i++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        escaped = false;
        structural += ' ';
        continue;
      }
      structural += ch;
    }
    result.push(structural);
  }

  if (blockDepth) {
    errors.push({ line: lines.length, msg: `unterminated block comment (depth ${blockDepth})` });
  }
  if (inString) {
    errors.push({ line: lines.length, msg: 'unterminated string' });
  }
  return { lines: result, errors };
}

/** Balance one fragment on its own: it must open and close every paren it uses. */
function checkFragment(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');
  const structural = structuralLines(lines);
  const errors = structural.errors.slice();

  let depth = 0;
  let reportedDip = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = structural.lines[i];
    for (let pos = 0; pos < stripped.length; pos++) {
      const ch = stripped[pos];
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth < MIN_DEPTH && !reportedDip) {
          reportedDip = true;
          errors.push({
            line: i + 1,
            msg: `surplus ) — depth went to ${depth} (floor ${MIN_DEPTH})`,
            text: lines[i].trimEnd().slice(0, 120),
          });
        }
      }
    }
  }

  if (depth !== 0) {
    errors.push({
      line: lines.length,
      msg: `final depth ${depth}, expected 0 — this fragment must balance on its own`,
    });
  }

  return { file: relPath, depth, lines: lines.length, errors };
}

function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--verbose');
  const explicit = argv.filter(a => !a.startsWith('-'));

  let files;
  if (explicit.length) {
    files = explicit.map(f => path.relative(REPO_ROOT, path.resolve(f)));
  } else {
    // WAT_FILES is the build's own manifest; never duplicate it here. Its
    // entries are bare basenames rooted at src/.
    const { WAT_FILES } = require(path.join(REPO_ROOT, 'lib', 'compile-wat.js'));
    files = WAT_FILES.map(f => (f.includes('/') ? f : `src/${f}`));
  }

  let failed = 0;
  for (const f of files) {
    const r = checkFragment(f);
    if (r.errors.length) {
      failed++;
      console.error(`FAIL ${r.file}`);
      for (const e of r.errors) {
        console.error(`  line ${e.line}: ${e.msg}`);
        if (e.text) console.error(`    ${e.text}`);
      }
    } else if (verbose) {
      console.log(`ok   ${r.file}  ${r.lines} lines, balanced`);
    }
  }

  if (failed) {
    console.error(`\ncheck-wat-fragments: ${failed} of ${files.length} fragment(s) unbalanced`);
    process.exit(1);
  }
  console.log(`check-wat-fragments: ${files.length} fragments OK (all self-balanced, no exceptions)`);
}

if (require.main === module) main();

module.exports = { checkFragment, structuralLines };
