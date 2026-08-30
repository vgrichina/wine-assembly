#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'tools', 'check-parens.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-check-parens-'));

function check(name, source) {
  const file = path.join(temp, name);
  fs.writeFileSync(file, source);
  return spawnSync(process.execPath, [CHECK, file, '--no-diff'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

try {
  const valid = check('valid.wat', String.raw`(module
    (data (i32.const 0) "unbalanced ) ;;; and escaped quote \" (")
    (; outer comment with (((
       (; nested comment with ))) ;)
       and one more unmatched (
    ;)
    (func $f
      (block $done
        (br $done))) ;; comment with ) " (
  )
`);
  assert.strictEqual(valid.status, 0,
    `strings/comments changed structural depth:\n${valid.stdout}${valid.stderr}`);
  assert.match(valid.stdout, /balanced, labels in scope/);

  const unbalanced = check('unbalanced.wat', '(module (func $f)) )\n');
  assert.notStrictEqual(unbalanced.status, 0, 'an unmatched close parenthesis passed');
  assert.match(unbalanced.stderr, /unbalanced \)/);

  const badLabel = check('bad-label.wat', '(module (func $f (br $missing)))\n');
  assert.notStrictEqual(badLabel.status, 0, 'an out-of-scope branch label passed');
  assert.match(badLabel.stderr, /br target \$missing not in scope/);

  const unterminated = check('unterminated-comment.wat', '(module (; never closed\n)\n');
  assert.notStrictEqual(unterminated.status, 0, 'an unterminated block comment passed');
  assert.match(unterminated.stderr, /unterminated block comment/);

  console.log('PASS check-parens lexes WAT strings/comments and rejects structural errors');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
