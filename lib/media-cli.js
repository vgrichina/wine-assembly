'use strict';

// Node-side adapter for lib/media-import.js. It deliberately stops at paths,
// byte providers and import plans: both tools/run-media.js and test/run.js use
// the same analysis/mount objects as the browser instead of growing a second
// CUE or ISO parser in the CLI.

const fs = require('fs');
const path = require('path');
const mediaImport = require('./media-import');
const { NodeFileProvider } = require('./byte-provider');
const { parseCue } = require('./cdrom');

function regularFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(directory, entry.name));
}

function cueMembers(cuePath) {
  const directory = path.dirname(cuePath);
  const cue = parseCue(fs.readFileSync(cuePath, 'utf8'));
  return cue.files.map(file => path.resolve(directory, ...String(file.name).split(/[\\/]/)));
}

function resolveMediaPaths(values) {
  const initial = [];
  for (const value of values || []) {
    const absolute = path.resolve(String(value));
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) initial.push(...regularFiles(absolute));
    else if (stat.isFile()) initial.push(absolute);
    else throw new Error(`media path is neither a file nor directory: ${absolute}`);
  }
  const expanded = initial.slice();
  for (const file of initial) {
    if (/\.cue$/i.test(file)) expanded.push(...cueMembers(file));
  }
  const seen = new Set();
  return expanded.filter(file => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return false;
    if (!fs.existsSync(file)) throw new Error(`CUE references missing file: ${file}`);
    seen.add(key);
    return true;
  });
}

function openParts(paths) {
  return paths.map(hostPath => {
    const source = new NodeFileProvider(hostPath);
    return {
      hostPath,
      source,
      name: path.basename(hostPath),
      relativePath: path.basename(hostPath),
      size: source.size,
    };
  });
}

function choosePlan(plans) {
  const launchable = plans.filter(plan => plan.exeCandidates && plan.exeCandidates.length);
  if (launchable.length !== 1) {
    throw new Error(launchable.length
      ? `media selection contains ${launchable.length} launchable items; pass one disc/archive at a time`
      : 'media contains no executable to launch');
  }
  return launchable[0];
}

function chooseCandidate(plan, requested) {
  const candidates = plan.exeCandidates || [];
  if (!requested) return candidates[0] || null;
  const wanted = String(requested).replace(/\//g, '\\').toLowerCase();
  const hit = candidates.find(candidate => {
    const guest = candidate.path.toLowerCase();
    const leaf = guest.replace(/^.*\\/, '');
    return guest === wanted || leaf === wanted.replace(/^.*\\/, '');
  });
  if (!hit) {
    throw new Error(`${requested} is not an executable candidate; choose one of: ` +
      candidates.map(candidate => candidate.path).join(', '));
  }
  return hit;
}

async function analyzeMediaPaths(values, options = {}) {
  const paths = resolveMediaPaths(values);
  if (!paths.length) throw new Error('no media files found');
  const parts = openParts(paths);
  try {
    const plans = await mediaImport.analyzeFiles(parts, options);
    const plan = choosePlan(plans);
    const candidate = chooseCandidate(plan, options.exePath);
    return { paths, parts, plans, plan, candidate };
  } catch (error) {
    for (const part of parts) part.source.close();
    throw error;
  }
}

function closeMedia(result) {
  for (const part of (result && result.parts) || []) part.source.close();
}

module.exports = {
  resolveMediaPaths,
  openParts,
  choosePlan,
  chooseCandidate,
  analyzeMediaPaths,
  closeMedia,
};
