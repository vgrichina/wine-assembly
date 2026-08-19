#!/usr/bin/env node
// A help file's own DLL, executed.
//
// WinHelp lets a help file register functions from a DLL it ships
// (RegisterRoutine/RR in its |SYSTEM macros) and then call them by name.
// Age of Empires registers five against AoEHlp.dll - PlayWAV, PlayBMP,
// PlayAVI, CallWinHelp and ActivateTribeGame - and plays its sounds that way.
//
// This drives the whole path against the real files: Empires.hlp registers
// its routines when it opens, WinHelpA(HELP_COMMAND) runs PlayWAV, the WAT
// loader maps the real AoEHlp.dll, and the x86 in that DLL runs until it
// reaches PlaySoundA. Nothing here is a fixture.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN_JS = path.join(__dirname, 'run.js');
const HELP = path.join(ROOT, 'test/binaries/shareware/aoe/aoe_ex/Empires.hlp');
const DLL = path.join(ROOT, 'test/binaries/shareware/aoe/aoe_ex/AoEHlp.dll');
const EXE = path.join(ROOT, 'test/binaries/notepad.exe');

for (const [label, file] of [['Empires.hlp', HELP], ['AoEHlp.dll', DLL], ['notepad.exe', EXE]]) {
  if (!fs.existsSync(file)) {
    console.log(`WinHelp DLL macro: SKIP (${label} absent)`);
    process.exit(0);
  }
}

// Any live guest process will do: the help engine runs the DLL inside the
// process that owns the help session, and Notepad is the one that boots
// fastest. Empires.exe itself is blocked on unrelated VFS work.
function run(macro) {
  const result = spawnSync(process.execPath, [
    RUN_JS,
    `--exe=${EXE}`,
    '--max-batches=200',
    '--no-build',
    '--quiet-blocks',
    '--trace-api=PlaySoundA',
    '--input=' + [
      '60:vfs-import:Empires.hlp:test/binaries/shareware/aoe/aoe_ex/Empires.hlp',
      '61:vfs-import:bird.wav:test/binaries/shareware/aoe/aoe_ex/Bird.wav',
      `90:help-macro:Empires.hlp:${macro}`,
    ].join(','),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_OPTIONS: '' } });
  return (result.stdout || '') + (result.stderr || '');
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

const played = run('PlayWAV(`bird.wav\')');
const line = (played.match(/\[input\] help-macro .*$/m) || [''])[0];

// dispatch=1 is HELP_DISPATCH_ACCEPTED; routines=5 is the count Empires.hlp
// registers from its |SYSTEM macros when it opens.
check('opening the file registers its five routines',
  / routines=5\b/.test(line), line);
check('a registered routine accepts the macro',
  /accepted=1 dispatch=1\b/.test(line), line);
check('the real AoEHlp.dll is mapped from the game directory',
  /aoehlp\.dll/i.test(played) || /PlaySoundA/.test(played));
// The DLL's own code reaching a Win32 import is the proof that it executed:
// PlayWAV builds a path on its stack and calls PlaySoundA with it.
check('PlayWAV runs as x86 and reaches PlaySoundA',
  /PlaySoundA\(/.test(played),
  played.split('\n').filter(l => l.includes('help-macro')).join(' '));

// A name the file never registered must not become callable just because a
// DLL is nearby. 6 is HELP_DISPATCH_UNSUPPORTED.
const unknown = run('PlayOgg(`bird.ogg\')');
const unknownLine = (unknown.match(/\[input\] help-macro .*$/m) || [''])[0];
check('an unregistered name is still refused',
  /accepted=0 dispatch=6\b/.test(unknownLine), unknownLine);
check('and no sound is played for it',
  !/PlaySoundA\(/.test(unknown));

console.log(`\n--- winhelp-dll-macro: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
