// Automated test: Notepad menu items should not crash
// Tests all notepad.exe menu commands, especially Find (which needs FindTextA)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'notepad.exe');

const MENU_ITEMS = [
  { id: 9,   name: 'New' },
  { id: 10,  name: 'Open' },
  { id: 1,   name: 'Save' },
  { id: 2,   name: 'Save As' },
  { id: 32,  name: 'Page Setup' },
  { id: 14,  name: 'Print' },
  { id: 28,  name: 'Exit' },
  { id: 25,  name: 'Undo' },
  { id: 7,   name: 'Select All' },
  { id: 12,  name: 'Time/Date' },
  { id: 27,  name: 'Word Wrap' },
  { id: 37,  name: 'Set Font' },
  { id: 3,   name: 'Find' },
  { id: 8,   name: 'Find Next' },
];

let passed = 0;
let failed = 0;

for (const item of MENU_ITEMS) {
  try {
    const out = execSync(
      `node "${RUN}" --exe="${EXE}" --input=50:0x111:${item.id} --max-batches=120`,
      { encoding: 'utf-8', timeout: 30000, cwd: ROOT }
    );
    const unimpl = out.match(/UNIMPLEMENTED API: (\S+)/);
    if (unimpl) {
      console.log(`FAIL  Menu ${item.id} (${item.name}): crashes on ${unimpl[1]}`);
      failed++;
    } else {
      console.log(`OK    Menu ${item.id} (${item.name})`);
      passed++;
    }
  } catch (e) {
    const stderr = (e.stderr || '').toString();
    const unimpl = stderr.match(/UNIMPLEMENTED API: (\S+)/);
    if (unimpl) {
      console.log(`FAIL  Menu ${item.id} (${item.name}): crashes on ${unimpl[1]}`);
    } else {
      console.log(`FAIL  Menu ${item.id} (${item.name}): ${e.message.split('\n')[0]}`);
    }
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${MENU_ITEMS.length} menu items`);
process.exit(failed > 0 ? 1 : 0);
