#!/usr/bin/env node
'use strict';

// Drive every actionable JigSawed menu item through the rendered menu bar.
// This deliberately does not post WM_COMMAND: regressions in menu geometry,
// cascades, modal windows, or dispatch must be visible to the same mouse path
// a player uses.  The companion test-win16-jigsawed.js chooses BRICKS.BMP and
// proves that a complete picture piece can actually be dragged.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');

const ROOT = path.join(__dirname, '..');
const WEP2 = path.join(ROOT, 'test', 'binaries', 'wep16', 'WEP2');
const EXE = path.join(WEP2, 'JIGSAWED.EXE');
const BITMAP = path.join(WEP2, 'BRICKS.BMP');
const OUT = path.join(ROOT, 'test', 'output', 'win16-jigsawed-menus');
const OPTIONAL_WASM = process.env.WINE_ASSEMBLY_WASM || '';

if (!fs.existsSync(EXE) || !fs.existsSync(BITMAP)) {
  console.log('SKIP  JigSawed corpus is not installed');
  process.exit(0);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

assert.strictEqual(sha256(EXE),
  '11ba2c35296c1c01af6f75da58cc98c25f18640310d786f9115f573a2aa36d2e');
assert.strictEqual(sha256(BITMAP),
  'e34fd93f523ecda8ab17b40dc74b735933bfe6df37ff61d7646718f4fbbb1142');
fs.mkdirSync(OUT, { recursive: true });

const dismissAbout = '190:dlg-click:1';
const loadPicture = dismissAbout +
  ',215:click:20:31,240:click:80:52,300:click:150:150,330:ctrl-cmd:5';

function shot(name) {
  return path.join(OUT, `${name}.png`);
}

function run(name, maxBatches, input, allowedMessages = 0) {
  const args = [path.join(ROOT, 'test', 'run.js'), '--app=wep16_jigsawed',
    '--no-build', `--max-batches=${maxBatches}`, '--repaint-every=50',
    '--quiet-blocks', `--input=${input}`];
  if (OPTIONAL_WASM) args.push(`--wasm=${OPTIONAL_WASM}`);
  const output = execFileSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.doesNotMatch(output, /\*\*\* CRASH|UNIMPLEMENTED API|RuntimeError|STUCK/,
    `${name} must complete without a runtime failure`);
  assert.doesNotMatch(output, /\[MessageBox\] "JIGSAWED": ""/,
    `${name} must not hide a VB error behind a blank message box`);
  assert.strictEqual((output.match(/^\[MessageBox\]/gm) || []).length,
    allowedMessages, `${name} opened an unexpected message box`);
  return output;
}

function png(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  assert.strictEqual(image.width, 640, `${path.basename(file)} width`);
  assert.strictEqual(image.height, 480, `${path.basename(file)} height`);
  return image;
}

function regionDigest(file, left = 0, top = 0, right = 640, bottom = 480) {
  const image = png(file);
  const hash = crypto.createHash('sha256');
  for (let y = top; y < bottom; y++) {
    const begin = (y * image.width + left) * 4;
    hash.update(image.data.subarray(begin, begin + (right - left) * 4));
  }
  return hash.digest('hex');
}

function pixelDifference(aFile, bFile, left = 0, top = 0, right = 640, bottom = 480) {
  const a = png(aFile);
  const b = png(bFile);
  let different = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const p = (y * a.width + x) * 4;
      if (a.data[p] !== b.data[p] || a.data[p + 1] !== b.data[p + 1] ||
          a.data[p + 2] !== b.data[p + 2] || a.data[p + 3] !== b.data[p + 3]) {
        different++;
      }
    }
  }
  return different;
}

// Inventory the live menu tree, including both cascades. Separators have IDs
// too, so list the 27 actual commands explicitly rather than trusting a count.
const inventoryShot = shot('inventory-help');
const inventory = run('live menu inventory', 700,
  dismissAbout +
  ',240:click:20:31,260:menu-dump:game' +
  ',280:click:500:400,300:click:75:31,320:menu-dump:options' +
  ',360:mousemove:170:253,380:menu-dump:outline' +
  ',420:mousemove:170:273,440:menu-dump:shape' +
  `,460:click:500:400,480:click:125:31,500:menu-dump:help,540:png:${inventoryShot}`);
const commands = [
  [3216, 'Open'], [3368, 'Paste'], [3570, 'Scramble'], [3682, 'Solve'],
  [3794, 'Fast Solve'], [3912, 'Hint'], [4122, 'Exit'],
  [4318, 'Maximize Workspace'], [4556, 'Fast Move'], [4668, 'Scrambling'],
  [4788, 'Scramble on Open'], [4910, 'Timer'], [5012, 'Sound'],
  [5116, 'Hidden Pieces'], [5354, 'Background'],
  [5552, 'Black'], [5672, 'White'], [5778, 'None'],
  [5974, 'Rectangles'], [6122, 'Circles'], [6230, 'Ellipses'],
  [6340, 'Stars'], [6450, 'Ellipses In Rectangles'],
  [6666, 'Index'], [6804, 'How to Play'], [6916, 'Commands'],
  [7026, 'Using Help'], [7240, 'About'],
];
const inventoryPlain = inventory.replaceAll('&', '');
for (const [id, label] of commands) {
  assert.match(inventoryPlain,
    new RegExp(`(?:id=|:)${id}[^\\n]*${label.replace(/ /g, '.?')}`, 'i'),
    `live menus should contain ${label} (${id})`);
}
assert.match(inventory, /menu-dump:outline:.*cascade=/);
assert.match(inventory, /menu-dump:shape:.*cascade=/);

// Game: choose a real picture, use Paste through the menu (the original crash),
// then exercise every puzzle operation. Hint is tested after an explicit
// Scramble because the app only establishes its hint history on that path.
const gameBase = shot('game-loaded');
const gamePaste = shot('game-paste');
const gameScramble = shot('game-scramble');
const gameHint = shot('game-hint');
const gameSolve = shot('game-solve');
const gameFastSolve = shot('game-fast-solve');
const game = run('Game menu', 2250, loadPicture +
  `,600:png:${gameBase}` +
  `,650:click:20:31,670:click:80:72,700:png:${gamePaste}` +
  `,750:click:20:31,770:click:80:112,850:png:${gameScramble}` +
  `,900:click:20:31,920:click:80:172,1000:png:${gameHint}` +
  `,1050:click:20:31,1070:click:80:132,1500:png:${gameSolve}` +
  ',1600:click:20:31,1620:click:80:112' +
  `,1700:click:20:31,1720:click:80:152,2100:png:${gameFastSolve}`);
assert.match(game, /SetWindowText\] "JigSawed: c:\\bricks\.bmp"/,
  'Open must choose and load BRICKS.BMP through the real file dialog');
assert.strictEqual(regionDigest(gameBase, 4, 42, 636, 456),
  regionDigest(gamePaste, 4, 42, 636, 456),
  'empty Paste must leave the current puzzle intact');
assert(pixelDifference(gamePaste, gameScramble, 4, 42, 636, 456) > 10000,
  'Scramble must visibly rearrange the picture');
assert(pixelDifference(gameScramble, gameHint, 4, 42, 636, 456) > 1000,
  'Hint must visibly move a puzzle piece');
assert(pixelDifference(gameHint, gameSolve, 4, 42, 636, 456) > 10000,
  'Solve must visibly change the board');
assert(pixelDifference(gameSolve, gameFastSolve, 4, 42, 636, 456) > 10000,
  'Fast Solve must run after a fresh scramble');

// Let both solvers finish in isolated runs. Their animation rates differ, but
// they must converge on the exact same completed picture pixels.
const solveComplete = shot('game-solve-complete');
run('completed Solve', 5200, loadPicture +
  `,600:click:20:31,620:click:80:132,5000:png:${solveComplete}`);
const fastSolveComplete = shot('game-fast-solve-complete');
run('completed Fast Solve', 2300, loadPicture +
  `,600:click:20:31,620:click:80:152,2100:png:${fastSolveComplete}`);
assert.strictEqual(regionDigest(solveComplete, 4, 42, 636, 456),
  regionDigest(fastSolveComplete, 4, 42, 636, 456),
  'Solve and Fast Solve should converge on the same completed picture');

// The six direct Options toggles. Their final check state proves the clicks
// reached the real commands; Show Hidden Pieces is an action rather than a
// persistent check in this version, so activation/no-crash is its contract.
const toggles = run('Options toggles', 1350, loadPicture +
  ',600:click:75:31,620:click:120:92' +
  ',680:click:75:31,700:click:120:114' +
  ',760:click:75:31,780:click:120:134' +
  ',840:click:75:31,860:click:120:154' +
  ',920:click:75:31,940:click:120:174' +
  ',1000:click:75:31,1020:click:120:194' +
  ',1100:click:75:31,1120:menu-dump:toggled');
const toggledLine = toggles.match(/^\[input\] menu-dump:toggled:.*$/m)[0];
assert.match(toggledLine, /id=4556 flags=0x4 "&Fast Move"/);
for (const id of [4668, 4788, 4910, 5012]) {
  assert.match(toggledLine, new RegExp(`id=${id} flags=0x0`),
    `${id} should toggle off through the rendered menu`);
}

// Maximize and Background are isolated because Maximize intentionally swaps
// to a menu-less workspace after explaining its access keys.
const maximizeShot = shot('maximize');
const maximize = run('Maximize Workspace', 900, loadPicture +
  `,600:click:75:31,620:click:120:53,720:png:${maximizeShot}`, 1);
assert.match(maximize,
  /\[MessageBox\] "JigSawed: Maximized Workspace": "Menus are not visible/,
  'Maximize should render its intended guidance, not a blank VB error');
assert(pixelDifference(gameBase, maximizeShot) > 1000,
  'Maximize should visibly change the workspace');

const backgroundShot = shot('background-dialog');
const background = run('Background dialog', 1050, loadPicture +
  `,600:click:75:31,620:click:120:233,760:png:${backgroundShot}` +
  ',800:dlg-dump:background,850:dlg-click:2');
assert.match(background, /SetWindowText\] "Background Color"/);
assert.match(background, /dlg-dump:background:.*id=1.*id=2/,
  'Background should present usable OK and Cancel controls');

// Every Outline and Shape cascade choice is opened by hovering its parent and
// clicking the rendered child menu. Distinct board pixels catch no-op drawing
// functions even when command dispatch itself reports success.
const cascadeNames = [
  'outline-black', 'outline-white', 'outline-none',
  'shape-rectangles', 'shape-circles', 'shape-ellipses', 'shape-stars',
  'shape-ellipses-in-rectangles',
];
const cascadeShots = Object.fromEntries(cascadeNames.map(name => [name, shot(name)]));
const cascades = run('Outline and Shape cascades', 1850, loadPicture +
  `,600:click:75:31,620:mousemove:170:253,640:click:280:253,700:png:${cascadeShots['outline-black']}` +
  `,740:click:75:31,760:mousemove:170:253,780:click:280:274,840:png:${cascadeShots['outline-white']}` +
  `,880:click:75:31,900:mousemove:170:253,920:click:280:294,980:png:${cascadeShots['outline-none']}` +
  `,1020:click:75:31,1040:mousemove:170:273,1060:click:280:273,1120:png:${cascadeShots['shape-rectangles']}` +
  `,1160:click:75:31,1180:mousemove:170:273,1200:click:280:294,1260:png:${cascadeShots['shape-circles']}` +
  `,1300:click:75:31,1320:mousemove:170:273,1340:click:280:314,1400:png:${cascadeShots['shape-ellipses']}` +
  `,1440:click:75:31,1460:mousemove:170:273,1480:click:280:335,1540:png:${cascadeShots['shape-stars']}` +
  `,1580:click:75:31,1600:mousemove:170:273,1620:click:280:356,1700:png:${cascadeShots['shape-ellipses-in-rectangles']}`);
assert.doesNotMatch(cascades, /\[MessageBox\]/);
assert.notStrictEqual(regionDigest(cascadeShots['outline-white'], 4, 42, 636, 456),
  regionDigest(cascadeShots['outline-black'], 4, 42, 636, 456),
  'the white outline should visibly differ from the black outline');
assert.notStrictEqual(regionDigest(cascadeShots['outline-white'], 4, 42, 636, 456),
  regionDigest(cascadeShots['outline-none'], 4, 42, 636, 456),
  'removing the white outline should visibly change the board');
assert.strictEqual(new Set(cascadeNames.slice(3).map(name =>
  regionDigest(cascadeShots[name], 4, 42, 636, 456))).size, 5,
  'all five piece shapes should render differently');

// Black and None can have the same pixels where the source bitmap already has
// dark piece edges. Verify all three commands independently through the live
// radio check, so pixel coincidence cannot conceal a missed cascade click.
const outlineState = run('Outline checks', 1250, loadPicture +
  ',600:click:75:31,620:mousemove:170:253,640:click:280:253' +
  ',700:click:75:31,720:mousemove:170:253,740:menu-dump:black,760:click:500:400' +
  ',800:click:75:31,820:mousemove:170:253,840:click:280:274' +
  ',900:click:75:31,920:mousemove:170:253,940:menu-dump:white,960:click:500:400' +
  ',1000:click:75:31,1020:mousemove:170:253,1040:click:280:294' +
  ',1100:click:75:31,1120:mousemove:170:253,1140:menu-dump:none');
assert.match(outlineState, /menu-dump:black:.*0:5552:"&Black":flags=0x4/);
assert.match(outlineState, /menu-dump:white:.*1:5672:"&White":flags=0x4/);
assert.match(outlineState, /menu-dump:none:.*2:5778:"&None":flags=0x4/);

// All Help commands, closing each rendered help window through its title-bar X.
const helpNames = ['help-index', 'help-how-to-play', 'help-commands', 'help-using-help'];
const helpShots = Object.fromEntries(helpNames.map(name => [name, shot(name)]));
const aboutShot = shot('about');
const help = run('authored Help topics', 1000, dismissAbout +
  `,300:click:125:31,320:click:150:53,430:png:${helpShots['help-index']},460:click:485:62` +
  `,520:click:125:31,540:click:150:74,650:png:${helpShots['help-how-to-play']},680:click:485:62` +
  `,740:click:125:31,760:click:150:94,870:png:${helpShots['help-commands']},900:click:485:62`);
assert.strictEqual((help.match(/CreateWindow\].*title="Jigsawed"/g) || []).length, 3,
  'each authored JigSawed topic should open the rendered help window');

const usingHelp = run('Using Help', 700, dismissAbout +
  `,300:click:125:31,320:click:150:114,500:png:${helpShots['help-using-help']}` +
  ',520:dlg-dump:using-help,560:dlg-click:2');
assert.match(usingHelp,
  /dlg-dump:using-help:.*rows="Commands \|\| Game Menu.*id=1.*text="Display".*id=2.*text="Cancel"/,
  'Using Help should open a populated, usable Help Topics navigator');

const about = run('About', 650, dismissAbout +
  `,300:click:125:31,320:click:150:153,470:png:${aboutShot},520:dlg-click:1`);
assert.match(about, /SetWindowText\] "About JigSawed"/);
assert.strictEqual(new Set(helpNames.map(name => regionDigest(helpShots[name]))).size, 4,
  'the four Help commands should show distinct pages');
assert(pixelDifference(inventoryShot, aboutShot) > 1000,
  'About should draw a visible modal dialog');

// Exit is last and gets its own process so hiding the application cannot mask
// a later command. A solid desktop is also checked below, not merely the log.
const exitShot = shot('exit');
const exit = run('Exit', 650, dismissAbout +
  `,300:click:20:31,320:click:80:212,500:png:${exitShot}`);
assert.match(exit, /\[ShowWindow\] hwnd=0x10002 cmd=0/,
  'Exit should hide the JigSawed frame');
const exitImage = png(exitShot);
const first = exitImage.data.subarray(0, 4).toString('hex');
for (let p = 4; p < exitImage.data.length; p += 4) {
  assert.strictEqual(exitImage.data.subarray(p, p + 4).toString('hex'), first,
    'Exit screenshot should contain only the desktop background');
}

console.log('PASS  Win16 JigSawed exposes all 27 actionable menu commands');
console.log('PASS  Win16 JigSawed opens a picture and exercises every Game command via mouse menus');
console.log('PASS  Win16 JigSawed exercises all Options toggles, dialogs, outlines, and shapes');
console.log('PASS  Win16 JigSawed renders every Help command and exits cleanly');
console.log(`Snapshots: ${OUT}`);
