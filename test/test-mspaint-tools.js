#!/usr/bin/env node

// End-to-end Win98 Paint regression for all 16 toolbox tools. Drawing tools
// get isolated pixel checks; selection, text, and magnifier get UI-state
// checks as well as a process-survival check.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadImage, createCanvas } = require('../lib/canvas-compat');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-tools');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
const shots = Object.fromEntries([
  'before', 'rectangle', 'fill', 'eraser', 'freehand', 'curve', 'shapes',
  'free-select', 'rect-select', 'text', 'zoom', 'menu',
].map(name => [name, path.join(OUT, `${name}.png`)]));
for (const file of Object.values(shots)) {
  try { fs.unlinkSync(file); } catch (_) {}
}

const input = [
  `18:png:${shots.before}`,

  // Make a closed black boundary, then flood its interior red. This used to
  // terminate Paint at ExtFloodFill.
  '19:click:39:221',
  '20:mousedown:100:90', '21:mousemove:140:120', '22:mouseup:190:170',
  `23:png:${shots.rectangle}`,
  '24:click:91:375',
  '25:click:64:96',
  '26:click:140:125',
  `27:png:${shots.fill}`,

  // Change away from red, pick red back from the picture, then erase part of
  // the fill. Pencil below proves the picked color is subsequently used.
  '28:click:237:375',
  '29:click:39:121',
  '30:click:140:125',
  '31:click:39:96',
  '32:mousedown:120:110', '33:mousemove:140:125', '34:mouseup:160:140',
  `35:png:${shots.eraser}`,

  '36:click:39:146',
  '37:mousedown:105:190', '38:mousemove:125:180', '39:mouseup:145:190',
  '40:click:64:146',
  '41:mousedown:155:190', '42:mousemove:175:180', '43:mouseup:195:190',
  '44:click:39:171',
  '45:mousedown:205:190', '46:mousemove:225:180', '47:mouseup:245:190',
  `48:png:${shots.freehand}`,

  '49:click:39:196',
  '50:mousedown:100:210', '51:mouseup:145:230',
  '52:click:64:196',
  '53:mousedown:155:210', '54:mouseup:210:230',
  '55:mousedown:175:200', '56:mouseup:185:220',
  '57:mousedown:190:220', '58:mouseup:200:240',
  `59:png:${shots.curve}`,

  '60:click:64:221',
  '61:mousedown:100:250', '62:mouseup:130:230',
  '63:click:160:250', '64:dblclick:130:275',
  '65:click:39:246',
  '66:mousedown:175:245', '67:mouseup:215:275',
  '68:click:64:246',
  '69:mousedown:220:245', '70:mouseup:270:280',
  `71:png:${shots.shapes}`,

  '72:click:39:71',
  '73:mousedown:100:90', '74:mousemove:120:80',
  '75:mousemove:150:90', '76:mouseup:160:120',
  `77:png:${shots['free-select']}`,
  '78:click:64:71',
  '79:mousedown:100:210', '80:mousemove:130:240', '81:mouseup:150:260',
  `82:png:${shots['rect-select']}`,

  '83:click:64:171',
  '84:mousedown:105:285', '85:mousemove:160:305', '86:mouseup:210:320',
  `87:png:${shots.text}`,

  // Magnifier is last because it deliberately changes the canvas viewport.
  '88:click:64:121',
  '89:click:230:100',
  `91:png:${shots.zoom}`,
  '92:wait-title-menu-open:untitled_-_Paint:100:70:file',
  '93:menu-dump:file',
  `93:png:${shots.menu}`,
  '94:stop',
].join(',');

let output = '';
let runFailed = false;
try {
  output = execFileSync(process.execPath, [
    RUN,
    `--exe=${EXE}`,
    `--input=${input}`,
    '--max-batches=98',
    '--batch-size=50000',
    '--no-close',
    '--quiet-api',
    '--quiet-blocks',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 15000, maxBuffer: 12 * 1024 * 1024 });
} catch (error) {
  runFailed = true;
  output = `${error.stdout || ''}${error.stderr || ''}`;
}

async function pixels(file) {
  const image = await loadImage(file);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height,
    data: ctx.getImageData(0, 0, image.width, image.height).data };
}

function countDiff(a, b, box) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, a.height, b.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, a.width, b.width); x++) {
      const i = (y * a.width + x) * 4;
      if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] ||
          a.data[i + 2] !== b.data[i + 2]) count++;
    }
  }
  return count;
}

function countWhere(image, box, predicate) {
  let count = 0;
  for (let y = box.y0; y < Math.min(box.y1, image.height); y++) {
    for (let x = box.x0; x < Math.min(box.x1, image.width); x++) {
      const i = (y * image.width + x) * 4;
      if (predicate(image.data[i], image.data[i + 1], image.data[i + 2])) count++;
    }
  }
  return count;
}

const isRed = (r, g, b) => r > 180 && g < 100 && b < 100;

(async () => {
  if (runFailed) {
    const diagnostic = output.split('\n').filter(line =>
      /Error|Runtime|CRASH|STUCK|input|CreateWindow|Stats/.test(line),
    ).slice(-60).join('\n');
    console.error(diagnostic || output.slice(-6000));
  }

  const filesExist = Object.values(shots).every(file =>
    fs.existsSync(file) && fs.statSync(file).size > 0);
  const images = {};
  if (filesExist) {
    await Promise.all(Object.entries(shots).map(async ([name, file]) => {
      images[name] = await pixels(file);
    }));
  }

  const metric = (a, b, box) => filesExist ? countDiff(images[a], images[b], box) : -1;
  const colored = (name, box, predicate = isRed) => filesExist ?
    countWhere(images[name], box, predicate) : -1;

  const rectangleDiff = metric('before', 'rectangle', { x0: 95, y0: 85, x1: 200, y1: 180 });
  const filledRed = colored('fill', { x0: 105, y0: 95, x1: 185, y1: 165 });
  const erasedDiff = metric('fill', 'eraser', { x0: 110, y0: 100, x1: 170, y1: 150 });
  const pencilRed = colored('freehand', { x0: 100, y0: 175, x1: 150, y1: 200 });
  const brushRed = colored('freehand', { x0: 150, y0: 175, x1: 200, y1: 200 });
  const airbrushRed = colored('freehand', { x0: 200, y0: 170, x1: 250, y1: 200 });
  const lineRed = colored('curve', { x0: 95, y0: 205, x1: 150, y1: 235 });
  const curveRed = colored('curve', { x0: 150, y0: 195, x1: 215, y1: 245 });
  const polygonRed = colored('shapes', { x0: 95, y0: 225, x1: 165, y1: 282 });
  const ellipseRed = colored('shapes', { x0: 170, y0: 240, x1: 220, y1: 282 });
  const roundRectRed = colored('shapes', { x0: 215, y0: 240, x1: 275, y1: 285 });
  const freeSelectDiff = metric('shapes', 'free-select', { x0: 90, y0: 70, x1: 175, y1: 135 });
  const rectSelectDiff = metric('free-select', 'rect-select', { x0: 90, y0: 195, x1: 160, y1: 270 });
  const textDiff = metric('rect-select', 'text', { x0: 35, y0: 35, x1: 400, y1: 330 });
  const zoomDiff = metric('text', 'zoom', { x0: 80, y0: 60, x1: 292, y1: 330 });

  const descriptions = [
    'Selects a free-form part', 'Selects a rectangular part',
    'Erases a portion', 'Fills an area', 'Picks up a color',
    'Changes the magnification', 'Draws a free-form line',
    'Draws using a brush', 'Draws using an airbrush', 'Inserts text',
    'Draws a straight line', 'Draws a curved line', 'Draws a rectangle',
    'Draws a polygon', 'Draws an ellipse', 'Draws a rounded rectangle',
  ];
  const selectedTools = descriptions.filter(text => output.includes(text)).length;

  const checks = [
    ['emulator run completed', !runFailed],
    ['all 12 staged screenshots written', filesExist],
    [`all 16 tools selected (${selectedTools}/16)`, selectedTools === descriptions.length],
    [`rectangle drew its boundary (${rectangleDiff} px)`, rectangleDiff >= 100],
    [`flood fill painted the closed area (${filledRed} red px)`, filledRed >= 3000],
    [`eraser removed part of the fill (${erasedDiff} px)`, erasedDiff >= 100],
    [`eyedropper plus pencil drew red (${pencilRed} px)`, pencilRed >= 8],
    [`brush drew red (${brushRed} px)`, brushRed >= 12],
    [`airbrush drew red (${airbrushRed} px)`, airbrushRed >= 10],
    [`line tool drew (${lineRed} red px)`, lineRed >= 20],
    [`curve tool drew (${curveRed} red px)`, curveRed >= 20],
    [`polygon tool drew (${polygonRed} red px)`, polygonRed >= 40],
    [`ellipse tool drew (${ellipseRed} red px)`, ellipseRed >= 30],
    [`rounded rectangle tool drew (${roundRectRed} red px)`, roundRectRed >= 40],
    [`free-form selection changed its region (${freeSelectDiff} px)`, freeSelectDiff >= 100],
    [`rectangular selection changed its region (${rectSelectDiff} px)`, rectSelectDiff >= 100],
    [`text tool created an editing surface (${textDiff} px)`,
      textDiff >= 100 && /title="Fonts"/.test(output)],
    [`magnifier changed the canvas viewport (${zoomDiff} px)`, zoomDiff >= 500],
    ['File menu contains 17 direct items', /menu-dump:file:[^\n]*count=17/.test(output)],
    ['File menu exposes New, Save As, Print, Wallpaper, and Exit',
      ['&New', 'Save &As', '&Print', '&Wallpaper', 'E&xit'].every(label => output.includes(label))],
    ['no unimplemented API or runtime crash',
      !/UNIMPLEMENTED API:|RuntimeError|LinkError|CRASH/.test(output)],
  ];

  let failed = 0;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) failed++;
  }
  console.log(`Screenshots: ${OUT}`);
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
