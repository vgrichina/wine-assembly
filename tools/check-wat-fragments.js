#!/usr/bin/env node
/**
 * Per-fragment WAT parenthesis gate (Milestone 2.2 of docs/watx-migration-plan.md).
 *
 * NOT YET WIRED INTO tools/build.sh — run it by hand:
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
 * TEMPORARY modeled exception (today's layout, deliberately not "fixed" here):
 * the outer (module ...) wrapper still lives in the source. src/01-header.wat
 * opens it and src/13-exports.wat closes it, so those two — AND ONLY THOSE TWO,
 * FOREVER — carry an expected net +1 / -1. Milestone 2.2 moves the wrapper into
 * tools/concat-wat.js; when that lands, delete the two WRAPPER entries below and
 * every fragment must net to 0.
 *
 * The exception is a frozen allow-list, not a mechanism: the gate hard-fails if
 * WRAPPER_EXPECTED_DEPTH ever names a file other than those two, so it cannot be
 * used to bless a new instance of the structure the plan wants removed.
 *
 * Rejected in every file, wrapper or not:
 *   - a mid-file negative-depth dip (a closer with no opener before it), even
 *     if a later opener makes the totals balance again;
 *   - any final depth other than the modeled one;
 *   - an unterminated string or block comment.
 *
 * Exit 0 when every fragment passes, 1 otherwise.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Expected final depth per file. Absent => 0 (a self-contained fragment).
// TEMPORARY: these two entries model the source-level (module ...) wrapper that
// Milestone 2.2 has not removed yet. Delete both when the wrapper moves into
// tools/concat-wat.js; nothing else may ever be added here.
const WRAPPER_EXPECTED_DEPTH = {
  'src/01-header.wat': 1,   // opens (module
  'src/13-exports.wat': -1, // closes it
};

// The only two files the wrapper exception may ever cover. Adding a third entry
// above would let the gate bless exactly the structure Milestone 2.2 removes,
// so that is a hard failure rather than a config change.
const WRAPPER_ALLOWED_FILES = ['src/01-header.wat', 'src/13-exports.wat'];

// Minimum depth a file may legally reach mid-stream. Only the wrapper closer
// is allowed below zero, and only by the one level it is closing.
function minDepthFor(expectedDepth) {
  return expectedDepth < 0 ? expectedDepth : 0;
}

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

/** Balance one fragment against its expected net depth. */
function checkFragment(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');
  const structural = structuralLines(lines);
  const expected = WRAPPER_EXPECTED_DEPTH[relPath] || 0;
  const floor = minDepthFor(expected);
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
        if (depth < floor && !reportedDip) {
          reportedDip = true;
          errors.push({
            line: i + 1,
            msg: `surplus ) — depth went to ${depth} (floor ${floor})`,
            text: lines[i].trimEnd().slice(0, 120),
          });
        }
      }
    }
  }

  if (depth !== expected) {
    errors.push({
      line: lines.length,
      msg: `final depth ${depth}, expected ${expected}` +
        (expected === 0 ? '' : ' (modeled (module ...) wrapper)'),
    });
  }

  return { file: relPath, depth, expected, lines: lines.length, errors };
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

  // The wrapper exception is frozen. If it ever grows a third member, fail
  // loudly instead of quietly accepting a new unbalanced fragment.
  const rogue = Object.keys(WRAPPER_EXPECTED_DEPTH)
    .filter(f => !WRAPPER_ALLOWED_FILES.includes(f));
  if (rogue.length) {
    console.error('FAIL check-wat-fragments: the (module ...) wrapper exception is frozen to');
    console.error(`  ${WRAPPER_ALLOWED_FILES.join(' and ')}, but WRAPPER_EXPECTED_DEPTH also names:`);
    for (const f of rogue) console.error(`    ${f}`);
    console.error('  Every other fragment must balance on its own — fix the fragment, not the table.');
    process.exit(1);
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
      const note = r.expected === 0 ? 'balanced' : `net ${r.expected >= 0 ? '+' : ''}${r.expected} (modeled wrapper)`;
      console.log(`ok   ${r.file}  ${r.lines} lines, ${note}`);
    }
  }

  if (failed) {
    console.error(`\ncheck-wat-fragments: ${failed} of ${files.length} fragment(s) unbalanced`);
    process.exit(1);
  }
  const modeled = files.filter(f => f in WRAPPER_EXPECTED_DEPTH);
  console.log(`check-wat-fragments: ${files.length} fragments OK` +
    (modeled.length
      ? ` (${modeled.length} TEMPORARY wrapper exception(s): ${modeled.join(', ')} — remove when Milestone 2.2 moves (module ...) into tools/concat-wat.js)`
      : ''));
}

if (require.main === module) main();

module.exports = { checkFragment, structuralLines, WRAPPER_EXPECTED_DEPTH };
