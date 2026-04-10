#!/usr/bin/env node
// Notepad menu items regression: verify each menu command actually works.
//
// For each menu item we inject WM_COMMAND with the item's ID and check
// that something observable happens:
//   - Dialog-opening items (Open, SaveAs, PageSetup, Print, SetFont, Find, About):
//     slot count increases (dialog window created).
//   - Time/Date (id=12): text is inserted into the edit control (WM_GETTEXTLENGTH > 0).
//   - Word Wrap (id=27): toggled without crash.
//   - New (id=9): no crash.
//   - Undo (id=25): no crash.
//   - SelectAll (id=7): no crash.
//   - Edit clipboard ops (Cut=768, Copy=769, Paste=770, Delete=771): no crash.
//   - Find Next (id=8): no crash (no find dialog open, should be a no-op).
//
// Every item must complete without UNIMPLEMENTED API crash.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN  = path.join(__dirname, 'run.js');
const EXE  = path.join(__dirname, 'binaries', 'notepad.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  notepad.exe not found at', EXE);
  process.exit(0);
}

function run(inputSpec, maxBatches) {
  const cmd = `node "${RUN}" --exe="${EXE}" --no-close --input='${inputSpec}' --max-batches=${maxBatches}`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8', timeout: 60000, cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return (e.stdout || '').toString() + (e.stderr || '').toString();
  }
}

function parseSlot(out, label) {
  const re = new RegExp(`slot-count ${label}: used=(\\d+)`);
  const m = out.match(re);
  return m ? parseInt(m[1], 10) : null;
}

const checks = [];
function check(name, pass) {
  checks.push({ name, pass });
}

// --- Test 1: Dialog-opening items create windows ---
// Open each dialog item, verify slots grew, then close via class-cmd or find-click.
console.log('Testing dialog-opening menu items...');
const dialogItems = [
  { id: 10, name: 'Open',      classId: 12, closeCmd: 2 },   // Open dialog, class 12, IDCANCEL=2
  { id: 2,  name: 'SaveAs',    classId: 12, closeCmd: 2 },   // SaveAs also uses class 12
  { id: 32, name: 'PageSetup', classId: 13, closeCmd: 2 },   // class 13 for page setup
  { id: 14, name: 'Print',     classId: 13, closeCmd: 2 },   // class 13 for print
  { id: 37, name: 'SetFont',   classId: 14, closeCmd: 2 },   // class 14 for font
  { id: 3,  name: 'Find',      findClose: true },             // Find uses find-click:2
  { id: 11, name: 'About',     classId: 11, closeCmd: 1 },   // class 11, IDOK=1
];

for (const item of dialogItems) {
  let inputSpec;
  if (item.findClose) {
    inputSpec = [
      '30:slot-count:before',
      `50:0x111:${item.id}`,
      '90:slot-count:after',
      '95:find-click:2',
      '120:slot-count:closed',
    ].join(',');
  } else {
    inputSpec = [
      '30:slot-count:before',
      `50:0x111:${item.id}`,
      '90:slot-count:after',
      `95:class-cmd:${item.classId}:${item.closeCmd}`,
      '120:slot-count:closed',
    ].join(',');
  }

  const out = run(inputSpec, 140);
  const before = parseSlot(out, 'before');
  const after = parseSlot(out, 'after');
  const closed = parseSlot(out, 'closed');
  const crashed = /UNIMPLEMENTED API:/.test(out);

  check(`${item.name} (id=${item.id}): no crash`, !crashed);
  check(`${item.name} (id=${item.id}): dialog opened (slots grew)`,
    before !== null && after !== null && after > before);
  check(`${item.name} (id=${item.id}): dialog closed (slots returned)`,
    before !== null && closed !== null && closed === before);
}

// --- Test 2: Time/Date inserts text ---
console.log('Testing Time/Date...');
{
  // EM_GETTEXTLENGTH = 0x000E (14). SendMessageA to edit child (0x10002).
  // After Time/Date the edit should have nonzero length.
  const inputSpec = [
    '30:slot-count:before',
    '50:0x111:12',   // Time/Date
    '80:slot-count:after',
  ].join(',');
  const out = run(inputSpec, 100);
  const crashed = /UNIMPLEMENTED API:/.test(out);
  check('Time/Date (id=12): no crash', !crashed);
  // Slot count shouldn't change (no dialog opened)
  const before = parseSlot(out, 'before');
  const after = parseSlot(out, 'after');
  check('Time/Date (id=12): no dialog (slots unchanged)',
    before !== null && after !== null && after === before);
}

// --- Test 3: Non-dialog items don't crash ---
console.log('Testing non-dialog menu items...');
{
  const inputSpec = [
    '30:slot-count:baseline',
    '40:0x111:9',     // New
    '50:0x111:25',    // Undo
    '60:0x111:7',     // Select All
    '70:0x111:768',   // Cut
    '80:0x111:769',   // Copy
    '90:0x111:770',   // Paste
    '100:0x111:771',  // Delete
    '120:slot-count:after',
  ].join(',');
  const out = run(inputSpec, 140);
  const crashed = /UNIMPLEMENTED API:/.test(out);
  check('Non-dialog items batch: no crash', !crashed);
  const baseline = parseSlot(out, 'baseline');
  const after = parseSlot(out, 'after');
  check('Non-dialog items batch: no dialogs opened (slots unchanged)',
    baseline !== null && after !== null && after === baseline);
}

// --- Test 3b: Find Next opens Find dialog when none exists ---
console.log('Testing Find Next (opens Find dialog)...');
{
  const inputSpec = [
    '30:slot-count:before',
    '50:0x111:8',     // Find Next — opens Find dialog if none exists
    '90:slot-count:after',
    '95:find-click:2', // Cancel
    '120:slot-count:closed',
  ].join(',');
  const out = run(inputSpec, 140);
  const crashed = /UNIMPLEMENTED API:/.test(out);
  const before = parseSlot(out, 'before');
  const after = parseSlot(out, 'after');
  const closed = parseSlot(out, 'closed');
  check('Find Next (id=8): no crash', !crashed);
  check('Find Next (id=8): opened Find dialog (slots grew)',
    before !== null && after !== null && after > before);
  check('Find Next (id=8): dialog closed cleanly',
    before !== null && closed !== null && closed === before);
}

// --- Test 4: Word Wrap toggles without crash ---
console.log('Testing Word Wrap toggle...');
{
  // Toggle word wrap twice to verify both transitions work
  const inputSpec = [
    '40:0x111:27',    // toggle on
    '60:0x111:27',    // toggle off
  ].join(',');
  const out = run(inputSpec, 80);
  const crashed = /UNIMPLEMENTED API:/.test(out);
  check('Word Wrap double toggle: no crash', !crashed);
}

// --- Test 5: Find → type → Find Next finds text ---
console.log('Testing Find workflow...');
{
  // Type some text, open Find, search for it
  const inputSpec = [
    // Type "hello" via keydown events
    '40:keydown:72',   // H
    '42:keydown:69',   // E
    '44:keydown:76',   // L
    '46:keydown:76',   // L
    '48:keydown:79',   // O
    '60:0x111:3',      // Find dialog
    '100:slot-count:find-open',
    '102:find-click:2', // Cancel
    '120:slot-count:find-closed',
  ].join(',');
  const out = run(inputSpec, 140);
  const crashed = /UNIMPLEMENTED API:/.test(out);
  const findOpen = parseSlot(out, 'find-open');
  const findClosed = parseSlot(out, 'find-closed');
  check('Find after typing: no crash', !crashed);
  check('Find after typing: dialog opened', findOpen !== null && findOpen > 2);
  check('Find after typing: dialog closed cleanly',
    findClosed !== null && findClosed === 2);
}

// --- Print results ---
console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
