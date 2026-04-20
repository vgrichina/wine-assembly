#!/usr/bin/env node
// Automated smoke tests for all EXE binaries
// Runs each EXE with limited batches, checks for crashes vs clean exit

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage } = require('canvas');

const ROOT = path.join(__dirname, '..');
const RUN_JS = path.join(__dirname, 'run.js');
const PNG_DIR = path.join(ROOT, 'scratch', 'harness-pngs');
const BLANK_COLOR_THRESHOLD = 8;  // PASS requires > this many unique colors in PNG

// Count unique RGB triples in a PNG file. Returns null if load fails.
async function countUniqueColors(pngPath) {
  try {
    const img = await loadImage(pngPath);
    const w = img.width, h = img.height;
    if (!w || !h) return 0;
    const c = createCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    const seen = new Set();
    // Sample every 4th pixel for speed on large canvases
    const step = 4 * 4;
    for (let i = 0; i < data.length; i += step) {
      seen.add((data[i] << 16) | (data[i+1] << 8) | data[i+2]);
      if (seen.size > 64) break;  // early exit — definitely not blank
    }
    return seen.size;
  } catch (_) {
    return null;
  }
}

// All test binaries with their expected behavior
const TEST_CASES = [
  { exe: 'test/binaries/notepad.exe', name: 'Notepad' },
  { exe: 'test/binaries/calc.exe', name: 'Calculator' },
  { exe: 'test/binaries/entertainment-pack/ski32.exe', name: 'SkiFree' },
  { exe: 'test/binaries/entertainment-pack/freecell.exe', name: 'FreeCell',
    extraArgs: ['--no-close', '--input=5:0x111:102'] },  // Game > New Game (F2)
  { exe: 'test/binaries/entertainment-pack/sol.exe', name: 'Solitaire',
    extraArgs: ['--no-close', '--input=5:0x111:1000'] },  // Game > Deal
  { exe: 'test/binaries/mspaint.exe', name: 'MSPaint (Win98)' },
  { exe: 'test/binaries/nt/mspaint.exe', name: 'MSPaint (NT)' },
  { exe: 'test/binaries/entertainment-pack/cruel.exe', name: 'Cruel',
    extraArgs: ['--no-close', '--input=5:0x111:1'] },  // Game > New
  { exe: 'test/binaries/entertainment-pack/golf.exe', name: 'Golf',
    extraArgs: ['--no-close', '--input=5:0x111:1'] },  // Game > New
  { exe: 'test/binaries/entertainment-pack/pegged.exe', name: 'Pegged' },
  { exe: 'test/binaries/entertainment-pack/snake.exe', name: 'Rattler Race' },
  { exe: 'test/binaries/entertainment-pack/taipei.exe', name: 'Taipei' },
  { exe: 'test/binaries/entertainment-pack/tictac.exe', name: 'TicTacToe' },
  { exe: 'test/binaries/xp/winmine.exe', name: 'Minesweeper (XP)' },
  // Entertainment Pack additions
  { exe: 'test/binaries/entertainment-pack/reversi.exe', name: 'Reversi' },
  { exe: 'test/binaries/entertainment-pack/winmine.exe', name: 'Minesweeper (WEP)' },
  // Win98 accessories
  { exe: 'test/binaries/win98-apps/wordpad.exe', name: 'WordPad' },
  { exe: 'test/binaries/win98-apps/write.exe', name: 'Write' },
  { exe: 'test/binaries/win98-apps/cdplayer.exe', name: 'CD Player' },
  { exe: 'test/binaries/win98-apps/mplayer.exe', name: 'Media Player' },
  { exe: 'test/binaries/win98-apps/mplay32.exe', name: 'Media Player 32' },
  { exe: 'test/binaries/win98-apps/fontview.exe', name: 'Font Viewer' },
  { exe: 'test/binaries/win98-apps/kodakimg.exe', name: 'Kodak Imaging' },
  { exe: 'test/binaries/win98-apps/kodakprv.exe', name: 'Kodak Preview' },
  { exe: 'test/binaries/win98-apps/hypertrm.exe', name: 'HyperTerminal' },
  { exe: 'test/binaries/win98-apps/sndvol32.exe', name: 'Volume Control' },
  { exe: 'test/binaries/win98-apps/sndrec32.exe', name: 'Sound Recorder' },
  { exe: 'test/binaries/win98-apps/explorer.exe', name: 'Explorer (98)' },
  { exe: 'test/binaries/win98-apps/regedit.exe', name: 'RegEdit' },
  { exe: 'test/binaries/win98-apps/taskman.exe', name: 'Task Manager' },
  { exe: 'test/binaries/win98-apps/welcome.exe', name: 'Welcome (98)' },
  { exe: 'test/binaries/win98-apps/tour98.exe', name: 'Win98 Tour' },
  { exe: 'test/binaries/win98-apps/sysmon.exe', name: 'System Monitor' },
  { exe: 'test/binaries/win98-apps/rsrcmtr.exe', name: 'Resource Meter' },
  { exe: 'test/binaries/win98-apps/winipcfg.exe', name: 'IP Config' },
  { exe: 'test/binaries/win98-apps/cleanmgr.exe', name: 'Disk Cleanup' },
  { exe: 'test/binaries/win98-apps/notepad98.exe', name: 'Notepad (98)' },
  { exe: 'test/binaries/win98-apps/vol98.exe', name: 'Volume (98)' },
  { exe: 'test/binaries/win98-apps/telnet.exe', name: 'Telnet' },
  // XP apps
  { exe: 'test/binaries/xp/claass.exe', name: 'Calculator (XP)' },
  { exe: 'test/binaries/xp/sndrec32.exe', name: 'Sound Recorder (XP)' },
  { exe: 'test/binaries/xp/xp_eos.exe', name: 'XP End of Life' },
  // Entertainment Pack extras
  { exe: 'test/binaries/entertainment-pack/mspaint.exe', name: 'MSPaint (EP)' },
  // Pinball
  { exe: 'test/binaries/pinball/pinball.exe', name: 'Space Cadet Pinball' },
  { exe: 'test/binaries/pinball-plus95/pinball.exe', name: 'Pinball (Plus! 95)' },
  // Winamp (top-level copies, not installers)
  { exe: 'test/binaries/winamp.exe', name: 'Winamp' },
  { exe: 'test/binaries/winamp295.exe', name: 'Winamp 2.95' },
  // Installers (NSIS etc.)
  { exe: 'test/binaries/installers/winamp291.exe', name: 'WinAmp Installer',
    extraArgs: ['--buttons=2'], maxBatches: 20000 },  // Click Cancel on license dialog (needs batches for CRC loop)
  { exe: 'test/binaries/installers/mirc59.exe', name: 'mIRC Installer' },
  // WEP community 32-bit remakes (archive.org/details/wep-32bit)
  { exe: 'test/binaries/wep32-community/Bricks/bricks.exe', name: 'Bricks (Klotski)' },
  { exe: 'test/binaries/wep32-community/EmPipe/EMPIPE.EXE', name: 'EmPipe (PipeDream)' },
  { exe: 'test/binaries/wep32-community/Funpack/Funtris.exe', name: 'Funtris (Tetris)' },
  { exe: 'test/binaries/wep32-community/Funpack/Peaks.exe', name: 'Peaks (TriPeaks)' },
  { exe: 'test/binaries/wep32-community/Funpack/Pyramid.exe', name: 'Pyramid (TutsTomb)' },
  { exe: 'test/binaries/wep32-community/Funpack/FourStones.exe', name: 'FourStones (TicTacDrop)' },
  { exe: 'test/binaries/wep32-community/Pawn/Pawn.exe', name: 'Pawn (Chess)' },
  { exe: 'test/binaries/wep32-community/QBlackjack/QuickBlackjack.exe', name: 'QuickBlackjack' },
  { exe: 'test/binaries/wep32-community/Runenlegen/Runenlegen.exe', name: 'Runenlegen (Stones)' },
  { exe: 'test/binaries/wep32-community/Tetravex/Tetravex.exe', name: 'Tetravex' },
  { exe: 'test/binaries/wep32-community/Winarc/Winarc.exe', name: 'Winarc (Pegs/Krypto/Life)' },
  { exe: 'test/binaries/wep32-community/Wordzap/CWordZap.exe', name: 'CWordZap' },
  { exe: 'test/binaries/wep32-community/TWorld/tworld.exe', name: 'TWorld (SDL, expected fail)' },
  { exe: 'test/binaries/wep32-community/Jigssawme/JigSawedME.exe', name: 'JigSawedME (VB6, expected fail)' },
  { exe: 'test/binaries/wep32-community/Rodent2000/Rodent2000.exe', name: 'Rodent2000 (VB6, expected fail)' },
  // Plus! 98
  { exe: 'test/binaries/plus98/SPIDER.EXE', name: 'Spider (Plus!98)' },
  { exe: 'test/binaries/plus98/MARBLES.EXE', name: 'LoseYourMarbles (DX, expected fail)' },
  // Shareware / demos — DirectX titles
  { exe: 'test/binaries/shareware/abe/ex/AbeDemo.exe', name: 'Abe Oddysee demo (DX)' },
  { exe: 'test/binaries/shareware/aoe/aoe_ex/Empires.exe', name: 'Age of Empires demo (DX)' },
  { exe: 'test/binaries/shareware/aoe2/aoe2_ex/EMPIRES2.EXE', name: 'Age of Empires 2 demo (DX)' },
  { exe: 'test/binaries/shareware/mcm/mcm_ex/MCM.EXE', name: 'Motocross Madness demo (DX+d3drm)' },
  { exe: 'test/binaries/shareware/mw3/ex/Program_Files/mech3demo.exe', name: 'MechWarrior 3 demo (DX/D3DIM)' },
  { exe: 'test/binaries/shareware/rct/English/RCT.exe', name: 'RollerCoaster Tycoon (DX)' },
  // DirectX 5 SDK samples (D3DIM verify gate — see apps/mcm.md D3D-1)
  { exe: 'test/binaries/dx-sdk/bin/ddex1.exe', name: 'DX5 DDraw Sample 1 (ddex1)' },
  { exe: 'test/binaries/dx-sdk/bin/ddex2.exe', name: 'DX5 DDraw Sample 2 (ddex2)' },
  { exe: 'test/binaries/dx-sdk/bin/ddex3.exe', name: 'DX5 DDraw Sample 3 (ddex3)' },
  { exe: 'test/binaries/dx-sdk/bin/ddex4.exe', name: 'DX5 DDraw Sample 4 (ddex4)' },
  { exe: 'test/binaries/dx-sdk/bin/ddex5.exe', name: 'DX5 DDraw Sample 5 (ddex5)' },
  { exe: 'test/binaries/dx-sdk/bin/flip2d.exe', name: 'DX5 Flip2D' },
  { exe: 'test/binaries/dx-sdk/bin/palette.exe', name: 'DX5 Palette' },
  { exe: 'test/binaries/dx-sdk/bin/stretch.exe', name: 'DX5 Stretch' },
  { exe: 'test/binaries/dx-sdk/bin/tunnel.exe', name: 'DX5 D3DIM Tunnel (DrawPrimitive)' },
  { exe: 'test/binaries/dx-sdk/bin/twist.exe', name: 'DX5 D3DIM Twist' },
  { exe: 'test/binaries/dx-sdk/bin/boids.exe', name: 'DX5 D3DIM Boids' },
  { exe: 'test/binaries/dx-sdk/bin/globe.exe', name: 'DX5 D3DIM Globe' },
  { exe: 'test/binaries/dx-sdk/bin/bellhop.exe', name: 'DX5 D3DIM Bellhop' },
  { exe: 'test/binaries/dx-sdk/bin/viewer.exe', name: 'DX5 D3DIM Viewer' },
  { exe: 'test/binaries/dx-sdk/bin/donut.exe', name: 'DX5 Donut' },
  { exe: 'test/binaries/dx-sdk/bin/donuts.exe', name: 'DX5 Donuts' },
  { exe: 'test/binaries/dx-sdk/bin/flip3dtl.exe', name: 'DX5 D3DIM Flip3DTL' },
  { exe: 'test/binaries/dx-sdk/bin/wormhole.exe', name: 'DX5 D3DIM Wormhole' },
  { exe: 'test/binaries/dx-sdk/foxbear/foxbear.exe', name: 'DX5 FoxBear (DDraw sprite demo)' },
  // Plus! 98 screensavers — pure GDI
  { exe: 'test/binaries/screensavers/CATHY.SCR', name: 'Cathy (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/CITYSCAP.SCR', name: 'Cityscape (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/DOONBURY.SCR', name: 'Doonesbury (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/FOXTROT.SCR', name: 'FoxTrot (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/GA_SAVER.SCR', name: 'Garfield (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/PEANUTS.SCR', name: 'Peanuts (screensaver)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/PHODISC.SCR', name: 'PhotoDisc (screensaver)', extraArgs: ['--args=/s'] },
  // Plus! 98 screensavers — MFC42
  { exe: 'test/binaries/screensavers/CORBIS.SCR', name: 'Corbis (screensaver, MFC)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/FASHION.SCR', name: 'Fashion (screensaver, MFC)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/HORROR.SCR', name: 'Horror (screensaver, MFC)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/WIN98.SCR', name: 'Win98 (screensaver, MFC)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/WOTRAVEL.SCR', name: 'WorldTraveler (screensaver, MFC)', extraArgs: ['--args=/s'] },
  // Plus! 98 screensavers — DirectDraw (expected fail until DDRAW support)
  { exe: 'test/binaries/screensavers/ARCHITEC.SCR', name: 'Architecture (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/FALLINGL.SCR', name: 'FallingLeaves (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/GEOMETRY.SCR', name: 'Geometry (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/JAZZ.SCR', name: 'Jazz (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/OASAVER.SCR', name: 'OnlineArt (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/ROCKROLL.SCR', name: 'RockRoll (screensaver, DX)', extraArgs: ['--args=/s'] },
  { exe: 'test/binaries/screensavers/SCIFI.SCR', name: 'SciFi (screensaver, DX)', extraArgs: ['--args=/s'] },
  // 16-bit NE binaries — emulator is 32-bit PE only, expected to fail at load
  // time. Kept in the list as SKIP candidates so coverage stays honest.
  { exe: 'test/binaries/win98-16bit/FREECELL.EXE', name: 'FreeCell (16-bit)', expect16bit: true },
  { exe: 'test/binaries/win98-16bit/SOL.EXE', name: 'Solitaire (16-bit)', expect16bit: true },
  { exe: 'test/binaries/win98-16bit/MSHEARTS.EXE', name: 'Hearts (16-bit)', expect16bit: true },
  { exe: 'test/binaries/win98-16bit/WINMINE.EXE', name: 'Minesweeper (16-bit)', expect16bit: true },
];

const MAX_BATCHES = 80;
const BATCH_SIZE = 1000;

function runExe(testCase, pngPath) {
  const exePath = path.join(ROOT, testCase.exe);
  if (!fs.existsSync(exePath)) {
    return { name: testCase.name, status: 'SKIP', reason: 'file not found' };
  }
  if (testCase.expect16bit) {
    // NE format; emulator only supports 32-bit PE. Verify MZ+NE then SKIP.
    try {
      const buf = fs.readFileSync(exePath);
      if (buf.length >= 0x40 && buf[0] === 0x4D && buf[1] === 0x5A) {
        const peOff = buf.readUInt32LE(0x3C);
        if (peOff + 2 <= buf.length && buf[peOff] === 0x4E && buf[peOff + 1] === 0x45) {
          return { name: testCase.name, status: 'SKIP', reason: '16-bit NE (unsupported)' };
        }
      }
    } catch (_) {}
    return { name: testCase.name, status: 'SKIP', reason: 'expected 16-bit NE' };
  }

  const args = [
    RUN_JS,
    `--exe=${exePath}`,
    `--max-batches=${testCase.maxBatches || MAX_BATCHES}`,
    `--batch-size=${BATCH_SIZE}`,
    '--no-build',
    '--verbose',
    ...(pngPath ? [`--png=${pngPath}`] : []),
    ...(testCase.extraArgs || []),
  ];

  const result = spawnSync('node', args, {
    cwd: ROOT,
    timeout: 5000,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,  // 50MB — MFC apps with DLLs generate lots of API trace output
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  const output = (result.stdout || '') + (result.stderr || '');
  const lines = output.split('\n');

  // Check for crash_unimplemented (missing API)
  const unimplMatch = output.match(/crash_unimplemented|unreachable|RuntimeError/);

  // Find all unique API calls — handles both --verbose ([API] Name) and --trace-api ([API #N] Name(...))
  const apiCalls = new Set();
  const apiPattern = /\[API[^\]]*\]\s*(\S+)/g;
  let m;
  while ((m = apiPattern.exec(output)) !== null) {
    const name = m[1].replace(/\(.*/, '');
    if (name) apiCalls.add(name);
  }

  // Check for window creation (sign of successful init)
  const hasWindow = output.includes('[CreateWindow]') || output.includes('[CreateDialog]');
  const hasShowWindow = output.includes('[ShowWindow]');
  const hasMessageLoop = /GetMessageA|GetMessageW|DispatchMessageA|DispatchMessageW/.test(output);
  const hasWmClose = output.includes('WM_CLOSE') || output.includes('0x10');
  const exitClean = output.includes('[Exit]');
  const hasMessageBox = output.includes('[MessageBox]');

  if ((result.status !== null && result.status !== 0) || unimplMatch) {
    // run.js prints "*** CRASH at batch N: <msg>" then "  EIP before batch: 0xXXXX"
    const crashMsgMatch = output.match(/\*\*\* CRASH at batch \d+: (.+)/);
    const crashMsg = crashMsgMatch ? crashMsgMatch[1].trim() : '';
    const eipBeforeMatch = output.match(/EIP before batch:\s*(0x[0-9a-fA-F]+)/);
    const eipBefore = eipBeforeMatch ? eipBeforeMatch[1] : '';

    // crash_unimplemented is the one case where "last API" IS the crash site:
    // the WAT $crash_unimplemented trap fires from inside an unimplemented handler stub.
    const isUnimpl = /crash_unimplemented/.test(output);
    const apiLines = lines.filter(l => /^\[API/.test(l.trim()));
    const lastApi = apiLines.length > 0
      ? apiLines[apiLines.length - 1].trim().replace(/^\[API[^\]]*\]\s*/, '').replace(/\(.*/, '')
      : '';

    let reason;
    if (isUnimpl && lastApi) {
      reason = `unimpl API: ${lastApi}`;
    } else if (crashMsg) {
      reason = eipBefore ? `${crashMsg} @ EIP=${eipBefore}` : crashMsg;
      if (lastApi) reason += ` (last API: ${lastApi})`;
    } else {
      reason = 'unknown crash';
    }

    return {
      name: testCase.name,
      status: 'CRASH',
      reason,
      apiCount: apiCalls.size,
      hasWindow,
    };
  }

  // Reached max batches without crash = likely working
  const windowOrLoop = hasWindow || hasMessageLoop || hasMessageBox;
  return {
    name: testCase.name,
    status: windowOrLoop || exitClean ? 'OK' : 'WARN',
    reason: windowOrLoop
      ? `${apiCalls.size} APIs, ${hasWindow ? 'window created' : hasMessageBox ? 'message box shown' : 'message loop running'}`
      : exitClean
        ? `${apiCalls.size} APIs, clean exit`
        : `${apiCalls.size} APIs, no window`,
    apiCount: apiCalls.size,
    hasWindow,
    hasShowWindow,
  };
}

// Build first (skip with --no-build)
const noBuild = process.argv.includes('--no-build');
if (!noBuild) {
  console.log('Building WASM...');
  execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  console.log('');
}

// Run all tests
console.log('=== Wine-Assembly EXE Smoke Tests ===\n');

const filter = process.argv.slice(2).filter(a => !a.startsWith('--')).pop();

fs.mkdirSync(PNG_DIR, { recursive: true });

(async () => {
  const results = [];
  for (const tc of TEST_CASES) {
    if (filter && !tc.name.toLowerCase().includes(filter.toLowerCase()) && !tc.exe.toLowerCase().includes(filter.toLowerCase())) {
      continue;
    }
    process.stdout.write(`  ${tc.name.padEnd(22)} ... `);
    const safeName = tc.name.replace(/[^a-zA-Z0-9]+/g, '_');
    const pngPath = path.join(PNG_DIR, `${safeName}.png`);
    try { fs.unlinkSync(pngPath); } catch (_) {}
    const r = runExe(tc, pngPath);

    // Pixel-diversity gate: apparent PASS with a near-blank PNG is really a WARN.
    if (r.status === 'OK' && fs.existsSync(pngPath)) {
      const colors = await countUniqueColors(pngPath);
      r.colors = colors;
      if (colors !== null && colors <= BLANK_COLOR_THRESHOLD) {
        r.status = 'WARN';
        r.reason = `${r.reason} — BLANK (${colors} colors in PNG)`;
      } else if (colors !== null) {
        r.reason = `${r.reason}, ${colors}+ colors`;
      }
    }
    results.push(r);

    const icon = r.status === 'OK' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : r.status === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`${icon}  ${r.reason}`);
  }

  console.log('\n=== Summary ===');
  const pass = results.filter(r => r.status === 'OK').length;
  const fail = results.filter(r => r.status === 'CRASH').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  console.log(`  PASS: ${pass}  FAIL: ${fail}  WARN: ${warn}  SKIP: ${skip}  Total: ${results.length}`);

  if (fail > 0) {
    console.log('\nCrashed EXEs:');
    for (const r of results.filter(r => r.status === 'CRASH')) {
      console.log(`  ${r.name}: ${r.reason}`);
    }
  }

  const blanks = results.filter(r => r.status === 'WARN' && /BLANK/.test(r.reason || ''));
  if (blanks.length > 0) {
    console.log('\nBlank canvases (demoted from PASS):');
    for (const r of blanks) console.log(`  ${r.name}: ${r.reason}`);
  }

  process.exit(fail > 0 ? 1 : 0);
})();
