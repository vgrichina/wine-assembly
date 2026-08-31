#!/usr/bin/env node
// Stage a subset of one file's hunks — the missing primitive for this shared
// worktree.
//
// Several agents edit the same src/*.wat and lib/*.js at once, each owning a
// few hunks and claiming them on messageboard.txt. `git commit <path>` commits
// the whole worktree file, so it would sweep a peer's half-finished work into
// somebody else's commit; `git add -p` is interactive and unavailable here.
// This stages exactly the hunks you name and leaves every other hunk in the
// file unstaged, where its owner left it.
//
//   node tools/stage-hunks.js --list <path>              number the hunks
//   node tools/stage-hunks.js --hunks=1,3 <path>         stage those hunks
//   node tools/stage-hunks.js --match=fs_volume <path>   stage hunks whose
//                                                        added lines match
//   node tools/stage-hunks.js --list --hunks=…           dry run: print what
//                                                        would be staged
//
// It works on the diff between the index and the worktree, so run it with a
// clean index for the paths you are staging (the usual case: your own edits on
// top of HEAD). Verify with `git diff --cached <path>` before committing.

'use strict';

const { execFileSync, spawnSync } = require('child_process');

function usage(msg) {
  if (msg) console.error(`stage-hunks: ${msg}`);
  console.error('usage: node tools/stage-hunks.js [--list] [--hunks=1,2] [--match=REGEX] <path>');
  process.exit(msg ? 2 : 0);
}

// Split a unified diff for one file into a header and its hunks.
function splitDiff(text) {
  const lines = text.split('\n');
  const header = [];
  const hunks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      current = [line];
      hunks.push(current);
    } else if (current) {
      // A trailing "\ No newline at end of file" belongs to the hunk above it.
      current.push(line);
    } else {
      header.push(line);
    }
  }
  // The final split element is an empty string from the trailing newline.
  return { header, hunks };
}

function hunkText(hunk) {
  return hunk.filter(l => l.startsWith('+')).join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) usage();
  let list = false, want = null, match = null, file = null;
  for (const a of args) {
    if (a === '--list') list = true;
    else if (a.startsWith('--hunks=')) want = a.slice(8).split(',').map(n => parseInt(n, 10));
    else if (a.startsWith('--match=')) match = new RegExp(a.slice(8));
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (file === null) file = a;
    else usage('one path at a time');
  }
  if (!file) usage('no path given');

  const diff = execFileSync('git', ['diff', '-U3', '--', file], { encoding: 'utf8' });
  if (!diff.trim()) { console.log(`stage-hunks: ${file} has no unstaged changes`); return; }
  const { header, hunks } = splitDiff(diff);

  const selected = new Set();
  hunks.forEach((h, i) => {
    const n = i + 1;
    if (want && want.includes(n)) selected.add(n);
    if (match && match.test(hunkText(h))) selected.add(n);
  });

  if (list || (!want && !match)) {
    hunks.forEach((h, i) => {
      const added = h.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
      const removed = h.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
      const first = h.slice(1).find(l => l.startsWith('+') || l.startsWith('-')) || '';
      const mark = selected.has(i + 1) ? '*' : ' ';
      console.log(`${mark} ${String(i + 1).padStart(3)}  ${h[0]}  +${added}/-${removed}  ${first.trim().slice(0, 70)}`);
    });
    if (!want && !match) return;
    console.log(`\n(* = would be staged; ${selected.size} of ${hunks.length})`);
    if (list) return;
  }

  if (!selected.size) { console.error('stage-hunks: no hunk selected'); process.exit(1); }
  const patch = header.join('\n') + '\n' +
    hunks.filter((_, i) => selected.has(i + 1)).map(h => h.join('\n')).join('\n') + '\n';
  // Through a temp file rather than stdin: `git apply -` rejects a patch whose
  // hunk offsets no longer line up, while the same patch in a file is matched
  // with the usual offset search.
  const tmp = require('path').join(require('os').tmpdir(),
    `stage-hunks-${process.pid}.patch`);
  require('fs').writeFileSync(tmp, patch);
  const r = spawnSync('git', ['apply', '--cached', tmp], { encoding: 'utf8' });
  require('fs').unlinkSync(tmp);
  if (r.status !== 0) {
    console.error(r.stderr || 'git apply failed');
    process.exit(1);
  }
  console.log(`staged ${selected.size} hunk(s) of ${file}; check with: git diff --cached -- ${file}`);
}

main(process.argv);
