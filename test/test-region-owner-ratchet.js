#!/usr/bin/env node

'use strict';

// `tools/check-region-decls.js --check-owners` is a ratchet on the
// `(owner "file:line")` clause every region declaration carries. The clause is
// documentation the compiler never reads, and two waves of moving code left
// ~155 of them aimed at lines that have nothing to do with the region — which
// is worse than no owner at all, because it sends the next reader somewhere
// confident and wrong.
//
// The mode's whole job is to stop that number growing, so the two things worth
// testing are the two directions of its verdict: an owner that still names its
// region passes, and one that does not is caught. A ratchet nobody has watched
// fire is a ratchet nobody knows works.
//
// It tests `ownerVerdict` rather than shelling out to the CLI, because the CLI
// path is the baseline bookkeeping and the baseline is deliberately allowed to
// contain 155 names — running it proves nothing about whether the check itself
// can see a stale owner.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { collectDeclarations, ownerVerdict } = require('../tools/check-region-decls.js');

let checks = 0;
const check = (cond, what) => { assert.ok(cond, what); checks++; };

const decls = collectDeclarations();
check(decls.length > 100, `the declaration set is real (${decls.length} regions)`);

// 1. Every declaration carries an owner. The compiler makes this mandatory;
//    assert it here too, because a `missing` verdict would otherwise be
//    indistinguishable from a parse failure in this tool.
const ownerless = decls.filter(d => !d.owner);
check(ownerless.length === 0,
  `every region has an (owner "…"): ${ownerless.map(d => d.name).join(', ')}`);

// 2. A synthetic owner pointing at a line that DOES mention the region passes.
//    Built from the live tree so the fixture cannot go stale: find the region's
//    own declaration line in 00-regions.wat and aim the owner at it.
const regionsPath = path.join(__dirname, '..', 'src', '00-regions.wat');
const regionsLines = fs.readFileSync(regionsPath, 'utf8').split('\n');
const sample = decls[0];
const selfLine = regionsLines.findIndex(l => l.includes(`$${sample.name}`)) + 1;
check(selfLine > 0, `found $${sample.name}'s own line in 00-regions.wat`);
check(ownerVerdict({ name: sample.name, owner: `"00-regions.wat:${selfLine}"` }).state === 'ok',
  'an owner aimed at a line naming the region verdicts ok');

// 3. ...and one aimed at a line that does not mention it is STALE. Line 1 of
//    00-regions.wat is the shebang-less header comment; no region name is
//    within three lines of it.
const stale = ownerVerdict({ name: sample.name, owner: '"00-regions.wat:1"' });
check(stale.state === 'stale', `a wrong line is caught (got ${stale.state})`);
check(/does not mention/.test(stale.why || ''), 'and the message says why');

// 4. An owner naming a file that does not exist is stale, not a crash.
check(ownerVerdict({ name: 'X', owner: '"no-such-file.wat:1"' }).state === 'stale',
  'a vanished owner file is caught');

// 5. An owner past the end of its file is stale, not a silent pass on an empty
//    window — this is the shape a deleted block leaves behind.
check(ownerVerdict({ name: 'X', owner: '"00-regions.wat:999999"' }).state === 'stale',
  'an owner past EOF is caught');

// 6. An owner that is deliberately not a file:line is SKIPPED, not failed.
//    "01-header.wat: (string.pool …)" names a mechanism; there is nothing to
//    grep and inventing a line number for it would be a fabricated claim.
check(ownerVerdict({ name: 'X', owner: '"01-header.wat: (string.pool ...)"' }).state === 'skip',
  'a non-file:line owner is skipped, not failed');

// 7. The baseline exists, is a name list, and is not empty-by-accident — an
//    empty baseline would make the ratchet look green while checking nothing.
const baselinePath = path.join(__dirname, '..', 'tools', 'check-region-decls.owners.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
check(Array.isArray(baseline.stale) && baseline.stale.length > 0,
  'the recorded stale set is a non-empty list');
const declNames = new Set(decls.map(d => d.name));
const ghosts = baseline.stale.filter(n => !declNames.has(n));
check(ghosts.length === 0,
  `every baselined name is still a declared region: ${ghosts.join(', ')}`);

// 8. And the live tree has at least one owner that verifies, so "155 stale" is
//    a measurement rather than a broken matcher reporting everything.
const okCount = decls.filter(d => ownerVerdict(d).state === 'ok').length;
check(okCount > 0, `the matcher can verify a real owner (${okCount} do)`);

console.log(`PASS  region owner ratchet (${checks} checks, ${okCount} owners verify, ` +
  `${baseline.stale.length} baselined stale)`);
