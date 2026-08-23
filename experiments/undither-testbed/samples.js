'use strict';

window.UNDITHER_SAMPLES = [
  {
    id: 'kornelski-city',
    label: 'POSITIVE + REFERENCE — Kornelski foggy city',
    src: 'assets/kornelski-1-dithered.png',
    referenceSrc: 'assets/kornelski-1-reference.png',
    provenance: 'kornelski/undither README example 1',
    expectation: 'Positive Floyd–Steinberg example supplied by the algorithm author; compare against the author-produced reference.',
    regions: [
      { label: 'Full image', x: 0, y: 0, w: 356, h: 239, zoom: 2 },
      { label: 'Buildings and fog', x: 20, y: 35, w: 210, h: 180, zoom: 3 },
      { label: 'Green light and fog', x: 225, y: 60, w: 125, h: 150, zoom: 4 },
    ],
  },
  {
    id: 'kornelski-bears',
    label: 'POSITIVE + REFERENCE — Kornelski polar bears',
    src: 'assets/kornelski-2-dithered.png',
    referenceSrc: 'assets/kornelski-2-reference.png',
    provenance: 'kornelski/undither README example 2',
    expectation: 'Positive 32-color Floyd–Steinberg example supplied by the algorithm author; fur, sky, and snow expose both smoothing and edge damage.',
    regions: [
      { label: 'Full image', x: 0, y: 0, w: 320, h: 200, zoom: 2 },
      { label: 'Bear fur', x: 55, y: 35, w: 205, h: 145, zoom: 3 },
      { label: 'Trees and sky', x: 0, y: 0, w: 320, h: 85, zoom: 3 },
    ],
  },
  {
    id: 'age-of-empires',
    label: 'MIXED CANDIDATE — Age of Empires gameplay',
    src: 'assets/age-of-empires.png',
    provenance: 'scratch/aoe-gameplay-map-260k.png',
    expectation: 'Negative / mixed: preserve dense grass, forest, sprites, and stone UI texture.',
    regions: [
      { label: 'Full frame', x: 0, y: 0, w: 640, h: 480, zoom: 1 },
      { label: 'Grass and units', x: 20, y: 45, w: 360, h: 220, zoom: 2 },
      { label: 'Trees and stone', x: 355, y: 45, w: 270, h: 300, zoom: 2 },
      { label: 'Stone UI portraits', x: 0, y: 375, w: 445, h: 105, zoom: 3 },
    ],
  },
  {
    id: 'diablo',
    label: 'MIXED CANDIDATE — Diablo Tristram',
    src: 'assets/diablo.png',
    provenance: '/private/tmp/diablo-gameplay.2UwT5L/final.png',
    expectation: 'Mixed: inspect dark gradients and water, but preserve ground, roof, trees, and HUD texture.',
    regions: [
      { label: 'Full frame', x: 0, y: 0, w: 640, h: 480, zoom: 1 },
      { label: 'Roof and dark ground', x: 15, y: 20, w: 320, h: 230, zoom: 2 },
      { label: 'Water and bank', x: 300, y: 145, w: 260, h: 200, zoom: 2 },
      { label: 'HUD orbs and stone', x: 20, y: 350, w: 600, h: 125, zoom: 2 },
    ],
  },
  {
    id: 'heroes2',
    label: 'MIXED CANDIDATE — Heroes II scenario setup',
    src: 'assets/heroes2.png',
    provenance: '/private/tmp/heroes2-gameplay3.png',
    expectation: 'Mixed: candidate gradients and shadows coexist with deliberate stone, wood, and foliage texture.',
    regions: [
      { label: 'Full frame', x: 0, y: 0, w: 640, h: 480, zoom: 1 },
      { label: 'Logo and roof', x: 0, y: 0, w: 330, h: 185, zoom: 2 },
      { label: 'Dialog controls', x: 145, y: 35, w: 390, h: 405, zoom: 2 },
      { label: 'Class silhouettes', x: 150, y: 305, w: 365, h: 75, zoom: 3 },
    ],
  },
  {
    id: 'bricks',
    label: 'NO-DITHER CONTROL — Bricks native frame',
    src: 'assets/bricks.png',
    provenance: 'screenshots/v86-reference/reviewed/bricks.png',
    expectation: 'Protected negative: hard text, one-pixel ornament, and flat colors; low color count is not dither proof.',
    regions: [
      { label: 'Full frame', x: 0, y: 0, w: 640, h: 480, zoom: 1 },
      { label: 'Title lettering', x: 35, y: 35, w: 470, h: 125, zoom: 3 },
      { label: 'Instructions and buttons', x: 35, y: 175, w: 580, h: 285, zoom: 2 },
    ],
  },
];
