#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const header = fs.readFileSync(path.join(ROOT, 'src', '01-header.wat'), 'utf8');
const hostImports = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');
const status = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs', 'gdi-migration-status.json'), 'utf8'));

const imported = [...header.matchAll(/\(import\s+"host"\s+"(gdi_[^"]+)"/g)]
  .map(match => match[1]).sort();

function flattenUnique(groups, dimension) {
  const seen = new Map();
  for (const [group, names] of Object.entries(groups)) {
    assert(Array.isArray(names) && names.length > 0, `${dimension}.${group} must be non-empty`);
    for (const name of names) {
      assert(/^gdi_[a-z0-9_]+$/.test(name), `${dimension}.${group} has invalid name ${name}`);
      assert(!seen.has(name), `${name} occurs in both ${seen.get(name)} and ${dimension}.${group}`);
      seen.set(name, `${dimension}.${group}`);
    }
  }
  return [...seen.keys()].sort();
}

assert.deepStrictEqual(flattenUnique(status.areas, 'areas'), imported,
  'area inventory must classify every current GDI host import exactly once');
assert.deepStrictEqual(flattenUnique(status.ownership, 'ownership'), imported,
  'ownership inventory must classify every current GDI host import exactly once');

for (const name of imported) {
  assert(hostImports.includes(`${name}:`), `lib/host-imports.js has no implementation for ${name}`);
}

const nonText = imported.filter(name => !status.ownership.canvas_text_policy.includes(name));
const hostOwned = status.ownership.host_owned.length;
const hybrid = status.ownership.wat_semantics_with_host_mirror_or_fallback.length;
const bridges = status.ownership.wat_owned_presentation_bridge.length;

console.log(`PASS  classified all ${imported.length} GDI host imports in area and ownership inventories`);
console.log(`PASS  all ${nonText.length} non-text GDI imports have an explicit migration status`);
console.log(`INFO  host-owned=${hostOwned} hybrid=${hybrid} presentation-bridge=${bridges} text-policy=${status.ownership.canvas_text_policy.length}`);
