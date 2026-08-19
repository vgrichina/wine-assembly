#!/usr/bin/env node
// Blobby Volley — the DirectPlay lobby path (TODOS item 3, the async-I/O demo).
//
// Drives NETZWERKSPIEL down both branches and checks the app reaches its end
// state on each:
//
//   host:  MULTIPLAYER-OPTIONEN -> EIN SPIEL HOSTEN... -> SPIEL BEGINNEN!
//          => "WARTE AUF EINEN GAST..."   (session open, waiting)
//   guest: MULTIPLAYER-OPTIONEN -> ALS GAST SPIELEN... -> SPIELE SUCHEN
//          => "GEFUNDENE SPIELE: LOCAL SESSION"
//
// The assertions are on the COM call sequence rather than on pixels, because
// the screens are text on a near-black beach and a text render regression is
// not what this test is for. Method ids are looked up BY NAME out of
// api_table.json and turned into the 0xC0DE0000|id marker the worker-thread
// API trace prints, so inserting an API ahead of them cannot rot this test.
//
// The regression that motivated it: DirectPlayCreate popped 20 bytes for a
// 3-argument function, so every call left the caller 4 bytes short and the
// game thread died (T1 state=exited) a few hundred batches later instead of
// showing a menu. "T1 never exited" is therefore a real check, not a formality.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'candidates', 'blobby-volley', 'volley.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  volley.exe not found at', EXE);
  process.exit(0);
}

// COM methods reach the worker-thread trace as "=> 0xc0deNNNN", where NNNN is
// the api_table id. Resolve by name so the numbers follow the table.
const apiTable = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'api_table.json'), 'utf8'));
function marker(name) {
  const e = apiTable.find(a => a.name === name);
  if (!e) throw new Error(`api_table.json has no entry named ${name}`);
  // >>> 0: the marker's top bit is set, and a bare | yields a negative int.
  return '0x' + ((0xC0DE0000 | e.id) >>> 0).toString(16);
}

const MULTIPLAYER = 258;   // NETZWERKSPIEL, on the main menu
const HOST_ENTRY = 290;    // EIN SPIEL HOSTEN..., on MULTIPLAYER-OPTIONEN
const GUEST_ENTRY = 322;   // ALS GAST SPIELEN...
const HOST_GO = 348;       // SPIEL BEGINNEN!, on HOST-EINSTELLUNGEN
const GUEST_GO = 350;      // SPIELE SUCHEN, on GAST-EINSTELLUNGEN

// The game hit-tests menu entries against its own cursor and ignores the
// click's lParam, so every click needs a preceding move -- and a second move
// one pixel on, because it only redraws the cursor on a delta.
function click(batch, y) {
  return [
    `${batch}:mousemove:350:${y}`,
    `${batch + 20}:mousemove:351:${y + 1}`,
    `${batch + 60}:mousedown:351:${y + 1}`,
    `${batch + 100}:mouseup:351:${y + 1}`,
  ];
}

function drive(label, secondY, thirdY, batches) {
  const input = [
    ...click(500, MULTIPLAYER),
    ...click(700, secondY),
    ...click(900, thirdY),
  ].join(',');

  const args = [
    RUN,
    `--exe=${EXE}`,
    `--max-batches=${batches}`,
    '--batch-size=200000',
    '--no-close',
    '--trace-api',
    `--input=${input}`,
  ];
  console.log(`$ node ${args.map(a => a.replace(ROOT, '.')).join(' ')}`);

  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', args, {
      cwd: ROOT, encoding: 'utf8', timeout: 300000,
      maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '').toString() + (e.stderr || '').toString();
    exitCode = e.status ?? 1;
  }
  return { label, out, exitCode };
}

const host = drive('host', HOST_ENTRY, HOST_GO, 2000);
const guest = drive('guest', GUEST_ENTRY, GUEST_GO, 2200);

// Only the click sequence differs between the two runs, so a marker that shows
// up before the menu is even reached would prove nothing -- look for the calls
// after the last injected click.
function after(run, batch) {
  const i = run.out.indexOf(`at batch ${batch}`);
  return i === -1 ? '' : run.out.slice(i);
}
const hostTail = after(host, 960);
const guestTail = after(guest, 960);

const checks = [
  { name: 'host run exited cleanly', pass: host.exitCode === 0 },
  { name: 'guest run exited cleanly', pass: guest.exitCode === 0 },
  { name: 'no unimplemented API', pass: !/UNIMPLEMENTED API:/.test(host.out + guest.out) },

  // DPlayX is LoadLibrary'd, not imported -- if this stops firing the app has
  // taken some other path and every check below is vacuous.
  { name: 'app resolved DirectPlayCreate from DPlayX.dll',
    pass: /LoadLibraryA\(name="DPlayX\.dll"\)/.test(host.out)
       && /GetProcAddress.*name="DirectPlayCreate"/.test(host.out) },

  { name: 'host: DirectPlayCreate handed out an object',
    pass: /\[API T1\] DirectPlayCreate/.test(hostTail) },
  { name: 'host: InitializeConnection',
    pass: hostTail.includes(marker('IDirectPlay3_InitializeConnection')) },
  { name: 'host: Open (session created)',
    pass: hostTail.includes(marker('IDirectPlay3_Open')) },
  { name: 'host: CreatePlayer',
    pass: hostTail.includes(marker('IDirectPlay3_CreatePlayer')) },

  { name: 'guest: EnumSessions (discovery ran)',
    pass: guestTail.includes(marker('IDirectPlay3_EnumSessions')) },

  // The stack-discipline regression: a short pop kills the game thread a few
  // hundred batches after the call, with no error anywhere.
  { name: 'game thread survived the network path',
    pass: !/T1 .*state=exited/.test(host.out) && !/T1 .*state=exited/.test(guest.out) },
];

console.log('');
let failed = 0;
for (const c of checks) {
  console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!c.pass) failed++;
}
console.log('');
console.log(`${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
