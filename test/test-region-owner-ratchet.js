#!/usr/bin/env node

'use strict';

// `tools/check-region-decls.js --check-owners` gates the `(owner "file:line")`
// clause every region declaration carries. The clause is documentation the
// compiler never reads, and two waves of moving code once left 155 of them
// aimed at lines that have nothing to do with the region — worse than no owner
// at all, because it sends the next reader somewhere confident and wrong.
//
// It landed as a ratchet over those 155; they have since all been re-derived,
// so the whitelist is empty and the mode is a flat refusal. The two things
// worth testing are still the two directions of its verdict: an owner that
// names its region passes, and one that does not is caught. A gate nobody has
// watched fire is a gate nobody knows works.
//
// It tests `ownerVerdict` directly rather than shelling out to the CLI, because
// the CLI path is baseline bookkeeping; exercising it proves nothing about
// whether the check itself can see a stale owner.

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

// 4. A near miss is stale too. This is the regression shape that justified
//    exact matching: the former +/-3 window accepted an owner after a nearby
//    edit shifted its real use by one line. Derive an adjacent line from the
//    live fixture, and first prove that line does not itself repeat the name.
const adjacentLine = selfLine < regionsLines.length ? selfLine + 1 : selfLine - 1;
check(!(regionsLines[adjacentLine - 1] || '').includes(sample.name),
  'the adjacent-line fixture does not itself mention the region');
const adjacent = ownerVerdict({
  name: sample.name,
  owner: `"00-regions.wat:${adjacentLine}"`,
});
check(adjacent.state === 'stale',
  `an owner one line beside its real use is stale (got ${adjacent.state})`);
check((adjacent.why || '').includes(`actual line is 00-regions.wat:${selfLine}`),
  'the near-miss diagnostic names the exact corrected line');

// 5. An owner naming a file that does not exist is stale, not a crash.
check(ownerVerdict({ name: 'X', owner: '"no-such-file.wat:1"' }).state === 'stale',
  'a vanished owner file is caught');

// 6. An owner past the end of its file is stale, not a silent pass on an empty
//    window — this is the shape a deleted block leaves behind.
check(ownerVerdict({ name: 'X', owner: '"00-regions.wat:999999"' }).state === 'stale',
  'an owner past EOF is caught');

// 7. An owner that is deliberately not a file:line is SKIPPED, not failed.
//    "01-header.wat: (string.pool …)" names a mechanism; there is nothing to
//    grep and inventing a line number for it would be a fabricated claim.
check(ownerVerdict({ name: 'X', owner: '"01-header.wat: (string.pool ...)"' }).state === 'skip',
  'a non-file:line owner is skipped, not failed');

// 8. The baseline is EMPTY. It used to hold 155 names and this check used to
//    assert the opposite, on the reasoning that an empty list would make the
//    ratchet look green while checking nothing. That reasoning belonged to the
//    period when the drain was pending: the guarantee comes from checks 2-7
//    (the matcher can see both verdicts) and check 9 (it verifies real owners
//    in the live tree), not from the whitelist having entries. Now that all 155
//    are re-derived the list is a flat refusal, and a name reappearing here is
//    the regression — a wrong owner laundered by --record-owners rather than
//    fixed.
const baselinePath = path.join(__dirname, '..', 'tools', 'check-region-decls.owners.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
check(Array.isArray(baseline.stale), 'the recorded stale set is a list');
check(baseline.stale.length === 0,
  `the stale baseline is drained: ${baseline.stale.join(', ')}`);

// 9. And no declaration in the live tree is stale — the drain holds without the
//    whitelist. This is what check 8 used to delegate to the baseline.
const liveStale = decls.filter(d => ownerVerdict(d).state === 'stale');
check(liveStale.length === 0,
  `no live declaration has a stale owner: ${liveStale.map(d => d.name).join(', ')}`);
const okCount = decls.filter(d => ownerVerdict(d).state === 'ok').length;
check(okCount > 100, `the matcher verifies real owners (${okCount} do)`);

console.log(`PASS  region owner ratchet (${checks} checks, ${okCount} owners verify, ` +
  `${baseline.stale.length} baselined stale)`);
