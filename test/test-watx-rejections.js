// test/test-watx-rejections.js — every WATX grammar rule has a negative test.
//
// The differential suite next door can only ask about the part of the language
// wabt also speaks. WATX's own extensions — the region family above all — have
// no second implementation, and their entire value is in what they REFUSE:
// `(data (region.addr $SPAN 0) …)` compiled cleanly until efba89ca and put
// bytes in a range the overlap sweep does not police. The rule existed; the
// test did not.
//
// The table lives in tools/watx-rejection-pairs.js. Each entry is a PAIR — one
// input that must compile and one that must be refused with a message naming
// the rule — so a rule cannot be "enforced" by refusing everything. The tally
// is printed because "every rule has a negative test" is a claim about a count.
//
// Run: node test/test-watx-rejections.js
'use strict';
const path = require('path');
const { runPairs, PAIRS } = require(path.join(__dirname, '..', 'tools', 'watx-rejection-pairs.js'));

// A guard against the failure mode this file exists to prevent: a table that
// quietly loses entries still prints a clean "N/N hold".
const FLOOR = 80;
if (PAIRS.length < FLOOR) {
  console.error(`the pair table has shrunk to ${PAIRS.length} (floor ${FLOOR}). ` +
    'Rules are meant to accumulate here, never to be deleted — if a rule really went ' +
    'away, lower the floor in the same commit that removes it.');
  process.exit(2);
}

const rep = runPairs({
  onResult: (r) => {
    if (r.ok) return;
    console.log(`  FAIL [${r.group}] ${r.rule}`);
    for (const p of r.problems) console.log(`       ${p}`);
  },
});

console.log(`\n${rep.passed}/${rep.total} accepted/rejected pairs hold.`);
console.log('Negative tests per grammar area:');
for (const [g, n] of rep.byGroup) console.log(`  ${String(n).padStart(3)}  ${g}`);
console.log(`\n${rep.unlocated}/${rep.total} refusals carry the right message but NO line number.`);
console.log('  That is not a failure — a located error and an unlocated one are different');
console.log('  repairs, and conflating them lets one hide behind the other — but it is the');
console.log('  work list for making these diagnostics usable from an editor.');
if (rep.notEnforced) {
  console.log(`\n${rep.notEnforced} rule(s) recorded but NOT enforced today:`);
  for (const r of rep.results) if (r.notEnforced) console.log(`  [${r.group}] ${r.rule}\n       ${r.notEnforced}`);
}

process.exit(rep.passed === rep.total ? 0 : 1);
