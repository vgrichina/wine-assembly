#!/usr/bin/env node

'use strict';

const assert = require('assert');
const path = require('path');

const { APPS } = require(path.join(__dirname, '..', 'lib', 'apps.js'));
const files = APPS.mcm.files;
const installRoot =
  'c:\\program files\\microsoft games\\motocross madness trial\\';

assert(files.length > 300, 'MCM manifest must include the complete trial media tree');
assert(files.every(file => file && typeof file === 'object' &&
  typeof file.url === 'string' && typeof file.vfsPath === 'string'),
'MCM assets must carry explicit VFS paths instead of basename mounts');

const bySuffix = suffix => files.find(file =>
  file.url.toLowerCase().endsWith(suffix.toLowerCase()));
for (const [suffix, expected] of [
  ['/TERAFORM/QUARRIES/QUARRY01.SCN', installRoot + 'TERAFORM\\QUARRIES\\QUARRY01.SCN'],
  ['/TERAFORM/NATIONAL/NATION16.SCN', installRoot + 'TERAFORM\\NATIONAL\\NATION16.SCN'],
  ['/TERAFORM/QUARRIES/QUARRY01.TGA', 'c:\\TERAFORM\\QUARRIES\\QUARRY01.TGA'],
  ['/TERAFORM/NATIONAL/NATION16.TGA', 'c:\\TERAFORM\\NATIONAL\\NATION16.TGA'],
  ['/SBIKE/RIDER.SLT', 'c:\\SBIKE\\RIDER.SLT'],
  ['/UI/ART/16X12/POSE_01A.TGA', 'c:\\UI\\ART\\16X12\\POSE_01A.TGA'],
  ['/UI/ART/16X12/BIKE_01.TGA', 'c:\\UI\\ART\\16X12\\BIKE_01.TGA'],
]) {
  const file = bySuffix(suffix);
  assert(file, `MCM manifest must include ${suffix}`);
  assert.strictEqual(file.vfsPath, expected, `${suffix} must preserve its runtime root`);
}

const scenes = files.filter(file => /\.scn$/i.test(file.url));
assert.strictEqual(scenes.length, 2, 'trial media has exactly two selectable scenes');
assert(scenes.every(file => file.vfsPath.toLowerCase().startsWith(installRoot)),
  'scene descriptors must occur only in MCM\'s installed search root');
assert(!files.some(file => /\.scn$/i.test(file.url) &&
  /^c:\\teraform\\/i.test(file.vfsPath)),
'scene descriptors must not be duplicated in the CD media root');

console.log(`PASS  ${files.length} MCM files preserve installed-scene and CD-media roots`);
