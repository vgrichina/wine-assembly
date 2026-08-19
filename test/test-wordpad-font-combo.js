#!/usr/bin/env node
'use strict';

// Regression: clicking WordPad's font combobox must drop its list, and clicking
// an item in that list must change the font.
//
// It used to do nothing at all, and there were three separate reasons stacked
// on top of each other, each of which hid the next:
//
//   1. $wnd_child_from_point_deep skipped every combobox, on the grounds that
//      "the dialog router" delivers their clicks. True inside a dialog; there
//      is no router over a toolbar, so the click landed on the toolbar behind.
//   2. The renderer only called that router for dialogs, so even once the hit
//      test found the control, nothing routed to it.
//   3. $dialog_route_mouse recursed into the hit child before dispatching to
//      it. A combobox owns an edit field and a button, so a click on the field
//      or the arrow was claimed by one of those children and the combobox's own
//      wndproc -- the thing that opens the list -- never ran. This is why the
//      control did respond to a click at its vertical centre, below the edit
//      child, and that asymmetry is the signature of the bug.
//
// The click coordinates are the ones a user's cursor lands on: the field of the
// font combo on the Formatting toolbar, and then a row of the open list.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'win98-apps', 'wordpad.exe');
const FONT_COMBO_ID = 165;

if (!fs.existsSync(EXE)) {
  console.log('SKIP  wordpad.exe not found at', EXE);
  process.exit(0);
}

const run = (input) => {
  const cmd = `node "${RUN}" --exe="${EXE}" --no-close --batch-size=50000 ` +
    `--max-batches=700 --quiet-blocks --quiet-api --input=${input}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 600000, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return (e.stdout || '').toString() + (e.stderr || '').toString();
  }
};

const cases = [];
const check = (name, pass, detail) => cases.push({ name, pass, detail });

// Open: a click on the field drops the list. The list is a popup window, which
// is control class 9 -- counting visible ones is how we see it appear.
const opened = run('250:click:112:80,300:dump-windows,320:stop');
const visiblePopups = opened.split('\n')
  .filter(l => l.includes('ctrlClass=9') && l.includes('visible=true')).length;
check('clicking the font combo drops its list', visiblePopups >= 1,
  `${visiblePopups} visible popups`);

// The list has to have something in it, or "picking" proves nothing. WordPad
// fills this one from EnumFontFamiliesEx during startup.
const startup = run('300:dump-control-state:' + FONT_COMBO_ID + ':start,320:stop');
check('the combo starts on a real font',
  /dump-control-state start: .*text="[A-Za-z][^"]*"/.test(startup),
  (startup.match(/dump-control-state start: .*(text="[^"]*")/) || [])[1]);

// Pick: a click on a row changes the control's text to that row.
const picked = run(`250:click:112:80,320:click:60:110,400:dump-control-state:${FONT_COMBO_ID}:picked,450:stop`);
const before = (startup.match(/dump-control-state start: .*text="([^"]*)"/) || [])[1];
const after = (picked.match(/dump-control-state picked: .*text="([^"]*)"/) || [])[1];
check('clicking a row selects that font', !!after && after !== before,
  `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

for (const l of picked.split('\n')) {
  if (/dump-control-state|CRASH|UNIMPLEMENTED/.test(l)) console.log('  ' + l.trim().slice(0, 150));
}

let failed = 0;
for (const c of cases) {
  if (c.pass) console.log(`PASS  ${c.name}`);
  else { failed++; console.log(`FAIL  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`); }
}
console.log('');
console.log(`${cases.length - failed}/${cases.length} checks passed`);
process.exit(failed > 0 ? 1 : 0);
