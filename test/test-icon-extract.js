#!/usr/bin/env node

// The desktop icon extractor, over both executable formats.
//
//   node test/test-icon-extract.js
//
// lib/resources-icon.js normally loads a pre-extracted PNG, then reads an icon
// straight out of an executable only as a fallback. This checks a known icon
// out of both executable containers, that a real image comes back rather than
// an empty one, and that the pre-extracted fast path avoids the EXE request.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const {
  extractIconRgba,
  preExtractedIconUrl,
  loadAppIcon,
} = require('../lib/resources-icon');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS } = require('../lib/apps');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'output', 'icon-extract');
const NE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'MSHEARTS.EXE');
const PE = path.join(ROOT, 'test', 'binaries', 'win98-apps', 'notepad98.exe');

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

// An icon that decoded but drew nothing is the failure worth catching: a wrong
// palette or a misplaced AND mask gives a full-size, fully transparent image
// that every downstream check would call success.
function opaquePixels(icon) {
  let n = 0;
  for (let i = 3; i < icon.pixels.length; i += 4) if (icon.pixels[i] > 128) n++;
  return n;
}

function distinctColors(icon) {
  const seen = new Set();
  for (let i = 0; i < icon.pixels.length; i += 4) {
    if (icon.pixels[i + 3] <= 128) continue;
    seen.add((icon.pixels[i] << 16) | (icon.pixels[i + 1] << 8) | icon.pixels[i + 2]);
  }
  return seen.size;
}

for (const [label, file, expect] of [['NE (16-bit)', NE, 32], ['PE (32-bit)', PE, 32]]) {
  if (!fs.existsSync(file)) {
    console.log(`SKIP  ${label}: ${path.relative(ROOT, file)} not present`);
    continue;
  }
  const icon = extractIconRgba(fs.readFileSync(file));
  check(`${label}: an icon came out of ${path.basename(file)}`, !!icon, 'null');
  if (!icon) continue;
  check(`${label}: ${icon.w}x${icon.h}`, icon.w === expect && icon.h === expect,
    `${icon.w}x${icon.h}`);
  check(`${label}: the pixel buffer matches the dimensions`,
    icon.pixels.length === icon.w * icon.h * 4, String(icon.pixels.length));
  const opaque = opaquePixels(icon);
  check(`${label}: it has something drawn on it (${opaque} opaque pixels)`,
    opaque > icon.w * icon.h / 8, String(opaque));
  const colors = distinctColors(icon);
  check(`${label}: it is a picture, not a silhouette (${colors} colours)`,
    colors >= 3, String(colors));

  // Numbers cannot tell a correct icon from a scrambled one of the right size.
  // Write it out so a person can look.
  fs.mkdirSync(OUT, { recursive: true });
  const png = new PNG({ width: icon.w, height: icon.h });
  png.data.set(icon.pixels);
  fs.writeFileSync(path.join(OUT, `${path.basename(file, path.extname(file))}.png`),
    PNG.sync.write(png));
}

// The checked-in fast-path set must follow the registry. Compare decoded
// pixels, not only filenames, so replacing an EXE without regenerating its PNG
// cannot quietly put the old artwork on the desktop.
const fastIconDir = path.join(ROOT, 'icons', 'apps');
const expectedFastIcons = new Set();
const fastIconErrors = [];
for (const [id] of [...DESKTOP_APPS, ...LOCAL_CANDIDATE_APPS]) {
  const app = APPS[id];
  const icon = app && fs.existsSync(path.join(ROOT, app.exe))
    ? extractIconRgba(fs.readFileSync(path.join(ROOT, app.exe))) : null;
  if (!icon) continue;
  const name = `${encodeURIComponent(id)}.png`;
  expectedFastIcons.add(name);
  const file = path.join(fastIconDir, name);
  if (!fs.existsSync(file)) { fastIconErrors.push(`${id}: missing`); continue; }
  const png = PNG.sync.read(fs.readFileSync(file));
  if (png.width !== icon.w || png.height !== icon.h ||
      !Buffer.from(png.data).equals(Buffer.from(icon.pixels))) {
    fastIconErrors.push(`${id}: stale pixels`);
  }
}
if (fs.existsSync(fastIconDir)) {
  for (const name of fs.readdirSync(fastIconDir).filter(name => name.endsWith('.png'))) {
    if (!expectedFastIcons.has(name)) fastIconErrors.push(`${name}: stale file`);
  }
}
check(`all ${expectedFastIcons.size} pre-extracted desktop icons match their executables`,
  fastIconErrors.length === 0, fastIconErrors.join(', '));

// Not every executable has an icon, and the caller distinguishes "no icon"
// from a thrown error only by getting null back.
check('a buffer that is not an executable returns null',
  extractIconRgba(Buffer.from('not an exe at all, not even close')) === null);
check('a truncated MZ returns null instead of throwing',
  extractIconRgba(Buffer.from('MZ')) === null);

async function checkFastPath() {
  const oldDocument = global.document;
  const oldFetch = global.fetch;
  const created = [];
  let exeFetches = 0;
  global.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData: () => {},
          }),
          toDataURL: () => 'data:image/png;base64,extracted',
        };
      }
      const img = { tag, style: {}, onload: null, onerror: null, _src: '' };
      Object.defineProperty(img, 'src', {
        get: () => img._src,
        set(value) { img._src = value; created.push(img); },
      });
      return img;
    },
  };
  global.fetch = async () => { exeFetches++; throw new Error('unexpected EXE fetch'); };
  const container = {
    style: {},
    child: 'fallback glyph',
    replaceChildren(child) { this.child = child; },
  };

  try {
    const loading = loadAppIcon(container, 'an app/id', 'large.exe');
    check('the fast path uses the predictable encoded PNG URL',
      created.length === 1 && created[0].src === 'icons/apps/an%20app%2Fid.png',
      created[0] && created[0].src);
    check('the fallback glyph remains while the PNG is loading',
      container.child === 'fallback glyph');
    created[0].onload();
    check('a pre-extracted PNG avoids downloading the executable',
      await loading === 'pre-extracted' && exeFetches === 0,
      `${exeFetches} EXE fetches`);
    check('the loaded image replaces the fallback glyph', container.child === created[0]);
    check('app icon URL helper matches the loader',
      preExtractedIconUrl('an app/id') === created[0].src);

    // A missing PNG must retain the old behavior: fetch the EXE, decode its
    // resource, and install the resulting data URL.
    const peBytes = fs.readFileSync(PE);
    global.fetch = async url => {
      exeFetches++;
      return {
        ok: true,
        arrayBuffer: async () => peBytes.buffer.slice(
          peBytes.byteOffset, peBytes.byteOffset + peBytes.byteLength),
      };
    };
    const fallback = loadAppIcon(container, 'missing', 'large.exe');
    created[1].onerror();
    await new Promise(resolve => setImmediate(resolve));
    check('a missing PNG downloads the executable exactly once',
      exeFetches === 1, `${exeFetches} EXE fetches`);
    check('the EXE fallback parses an icon into an image URL',
      created.length === 3 && created[2].src === 'data:image/png;base64,extracted',
      created[2] && created[2].src);
    created[2].onload();
    check('the EXE-derived image replaces the missing PNG',
      await fallback === 'executable' && container.child === created[2]);
  } finally {
    global.document = oldDocument;
    global.fetch = oldFetch;
  }
}

checkFastPath().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}, err => {
  console.error(err);
  process.exit(1);
});
