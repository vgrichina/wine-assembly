#!/usr/bin/env node
// Prepare a screen recording for upload: cut the black bars, fit the platform's
// resolution cap, re-encode to a profile it will not have to touch.
//
//   node tools/twitter-clip.js                     # newest wine-assembly-*.mp4 in ~/Downloads
//   node tools/twitter-clip.js in.mp4 --out=x.mp4
//
// Why the bars are there: the recorder captures the whole screen canvas, and
// the guest desktop is 4:3 inside whatever shape the browser window happens to
// be, so a wide window pillarboxes. Uploading that wastes a third of the frame
// on black that the platform's encoder still spends bits on.
//
// The crop is measured, not assumed -- cropdetect at several points across the
// clip, and the widest content box wins, so a window that only appears late is
// not sliced off. Anything it wants to cut is checked for actual darkness
// first; a bar that is not black is content, and the tool says so rather than
// cutting it.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Twitter/X: max 1920x1200 landscape, 140s for a standard account, H.264 High
// + AAC in MP4. Staying inside these means the platform re-encodes once
// instead of resizing first.
const MAX_W = 1920;
const MAX_H = 1200;
const MAX_SECONDS = 140;

function arg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// cropdetect and signalstats report on STDERR, and ffmpeg exits 0 either way,
// so execFileSync's return value (stdout) never contains them -- it silently
// yields "no crop detected" while the measurements scroll past on the terminal.
function ffmpegStderr(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', ...args],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function newestRecording() {
  const dir = path.join(os.homedir(), 'Downloads');
  const files = fs.readdirSync(dir)
    .filter(name => /^wine-assembly-.*\.mp4$/.test(name) && !name.includes('-twitter'))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error(`no wine-assembly-*.mp4 in ${dir}`);
  return files[0].file;
}

function probe(file) {
  const out = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,bit_rate,profile',
    '-show_entries', 'format=duration,size', '-of', 'default=noprint_wrappers=1', file]);
  const get = key => (out.match(new RegExp(`^${key}=(.*)$`, 'm')) || [, ''])[1];
  const rate = get('avg_frame_rate').split('/');
  return {
    w: Number(get('width')), h: Number(get('height')),
    fps: Number(rate[0]) / Number(rate[1] || 1),
    profile: get('profile'), duration: Number(get('duration')), size: Number(get('size')),
  };
}

// Union of the content boxes seen across the clip: smallest x/y, largest edges.
function detectCrop(file, duration) {
  const points = [2, 0.25, 0.5, 0.75, 0.95].map((p, i) => (i === 0 ? 2 : duration * p))
    .filter(t => t < duration - 1);
  let box = null;
  for (const t of points) {
    const text = ffmpegStderr(['-ss', String(Math.max(0, t)), '-i', file,
      '-vf', 'cropdetect=24:2:0', '-frames:v', '60', '-f', 'null', '-']);
    const hits = text.match(/crop=\d+:\d+:\d+:\d+/g);
    if (!hits || !hits.length) continue;
    const [w, h, x, y] = hits[hits.length - 1].slice(5).split(':').map(Number);
    const found = { x0: x, y0: y, x1: x + w, y1: y + h };
    box = box ? {
      x0: Math.min(box.x0, found.x0), y0: Math.min(box.y0, found.y0),
      x1: Math.max(box.x1, found.x1), y1: Math.max(box.y1, found.y1),
    } : found;
  }
  return box;
}

// A bar is only safe to cut if it is actually dark. Encoded black is not
// exactly 0 -- measured 17/255 on a real capture -- so allow a little.
const DARK_YMAX = 32;

function stripBrightness(file, crop, at) {
  const text = ffmpegStderr(['-ss', String(at), '-t', '2', '-i', file,
    '-vf', `crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YMAX`,
    '-f', 'null', '-']);
  const values = (text.match(/YMAX=\d+/g) || []).map(v => Number(v.slice(5)));
  return values.length ? Math.max(...values) : null;
}

function even(n) { return Math.max(2, Math.floor(n / 2) * 2); }

function main() {
  const positional = process.argv.slice(2).find(a => !a.startsWith('--'));
  const input = positional || newestRecording();
  const output = arg('out', input.replace(/\.mp4$/, '-twitter.mp4'));
  const crf = arg('crf', '18');

  const info = probe(input);
  console.log(`input   ${input}`);
  console.log(`        ${info.w}x${info.h} @ ${info.fps.toFixed(1)} fps, ${info.duration.toFixed(1)}s, ` +
    `${(info.size / 1e6).toFixed(1)} MB, profile=${info.profile}`);

  let crop = arg('crop', null);
  let cw = info.w, ch = info.h, cx = 0, cy = 0;
  if (crop) {
    [cw, ch, cx, cy] = crop.split(':').map(Number);
  } else {
    const box = detectCrop(input, info.duration);
    if (box) {
      cw = even(box.x1 - box.x0); ch = even(box.y1 - box.y0); cx = box.x0; cy = box.y0;
    }
  }

  if (cw !== info.w || ch !== info.h) {
    // Refuse to cut anything that is not dark -- that is content, not a bar.
    const bars = [];
    if (cx > 0) bars.push([`${cx}:${info.h}:0:0`, 'left']);
    if (cx + cw < info.w) bars.push([`${info.w - cx - cw}:${info.h}:${cx + cw}:0`, 'right']);
    if (cy > 0) bars.push([`${info.w}:${cy}:0:0`, 'top']);
    if (cy + ch < info.h) bars.push([`${info.w}:${info.h - cy - ch}:0:${cy + ch}`, 'bottom']);
    for (const [rect, name] of bars) {
      const ymax = stripBrightness(input, rect, Math.min(30, info.duration / 2));
      if (ymax !== null && ymax > DARK_YMAX) {
        console.log(`\nREFUSING to crop: the ${name} bar peaks at Y=${ymax}, which is content, not a bar.`);
        console.log(`Pass --crop=W:H:X:Y to override.`);
        process.exit(1);
      }
      console.log(`        ${name} bar Y max ${ymax} -- dark, safe to cut`);
    }
    console.log(`crop    ${cw}x${ch}+${cx}+${cy}  (cutting ${info.w * info.h - cw * ch} px/frame of black)`);
  } else {
    console.log('crop    none detected');
  }

  let ow = cw, oh = ch;
  if (ow > MAX_W || oh > MAX_H) {
    const factor = Math.min(MAX_W / ow, MAX_H / oh);
    ow = even(ow * factor); oh = even(oh * factor);
    console.log(`scale   ${cw}x${ch} -> ${ow}x${oh} (platform cap ${MAX_W}x${MAX_H})`);
  }

  if (info.duration > MAX_SECONDS) {
    console.log(`\nWARNING: ${info.duration.toFixed(1)}s exceeds the ${MAX_SECONDS}s limit; ` +
      `trim it or the upload is rejected.`);
  }

  const filters = [];
  if (cw !== info.w || ch !== info.h) filters.push(`crop=${cw}:${ch}:${cx}:${cy}`);
  if (ow !== cw || oh !== ch) filters.push(`scale=${ow}:${oh}:flags=lanczos`);
  filters.push('format=yuv420p');

  console.log(`\nencoding -> ${output}`);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-preset', 'slow',
    '-crf', crf, '-maxrate', '20M', '-bufsize', '40M',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart', output], { stdio: 'inherit' });

  const done = probe(output);
  console.log(`\noutput  ${output}`);
  console.log(`        ${done.w}x${done.h} @ ${done.fps.toFixed(1)} fps, ${done.duration.toFixed(1)}s, ` +
    `${(done.size / 1e6).toFixed(1)} MB, profile=${done.profile}`);
}

main();
