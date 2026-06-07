#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE_SCRIPT = path.join(ROOT, 'tools', 'profile-aoe-web.js');

function argValue(name) {
  const flag = `--${name}`;
  const withEquals = `${flag}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(withEquals)) return arg.slice(withEquals.length);
    if (arg === flag && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return '';
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function intArgOrEnv(argName, envName, fallback) {
  const raw = argValue(argName) || process.env[envName] || String(fallback);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function slug(s) {
  return String(s || 'aoe')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'aoe';
}

function round(v) {
  return +((Number(v) || 0).toFixed(3));
}

function stats(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  if (!nums.length) return { count: 0 };
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const sd = Math.sqrt(nums.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / nums.length);
  return {
    count: nums.length,
    mean: round(mean),
    min: round(min),
    max: round(max),
    sd: round(sd),
  };
}

function extractMetrics(file, result) {
  const profile = result && result.profile ? result.profile : {};
  const counters = profile.counters || {};
  const runSlice = counters['main.runSlice'] || {};
  const breakdown = profile.runSliceBreakdown || {};
  const jitter = profile.jitter || {};
  const present = jitter.present || {};
  const raf = jitter.raf || {};
  const repaint = jitter.repaint || {};
  return {
    file,
    screenshot: result && result.screenshot ? result.screenshot : '',
    elapsedMs: round(profile.elapsedMs),
    runSliceMs: round(runSlice.totalMs),
    runSliceCount: runSlice.count || 0,
    runSliceAvgMs: round(runSlice.avgMs),
    runSliceMaxMs: round(runSlice.maxMs),
    guestMs: round(breakdown.guestOrUnwrappedMs),
    hostMs: round(breakdown.wrappedHostImportMs),
    hostPct: round(breakdown.wrappedHostPct),
    presentFps: round(present.fps),
    presentEvents: present.events || 0,
    rafFps: round(raf.fps),
    repaintFps: round(repaint.fps),
  };
}

function killProcessGroup(child, signal) {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (_) {
    try {
      child.kill(signal);
    } catch (_) {}
  }
}

function runProfile(env, timeoutMs, verbose) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROFILE_SCRIPT], {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5000);
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (verbose) process.stdout.write(text);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', err => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`profile timed out after ${timeoutMs} ms`));
        return;
      }
      if (code !== 0) {
        const tail = (stderr || stdout).slice(-3000);
        reject(new Error(`profile exited with code ${code} signal ${signal || ''}\n${tail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function printSummary(summary) {
  console.log('');
  console.log(`AoE repeat profile: ${summary.label}`);
  console.log(`runs=${summary.runs.length} timeoutMs=${summary.timeoutMs} summary=${summary.summaryFile}`);
  console.log('');
  console.log('run  runSlice  guest    host   present  events  output');
  for (let i = 0; i < summary.runs.length; i++) {
    const r = summary.runs[i];
    console.log(
      String(i + 1).padStart(3) + '  ' +
      String(r.runSliceMs.toFixed(1)).padStart(8) + '  ' +
      String(r.guestMs.toFixed(1)).padStart(7) + '  ' +
      String(r.hostMs.toFixed(1)).padStart(6) + '  ' +
      String(r.presentFps.toFixed(2)).padStart(7) + '  ' +
      String(r.presentEvents).padStart(6) + '  ' +
      r.file
    );
  }
  console.log('');
  for (const key of ['runSliceMs', 'guestMs', 'hostMs', 'presentFps', 'presentEvents']) {
    const s = summary.stats[key];
    console.log(`${key}: mean=${s.mean} min=${s.min} max=${s.max} sd=${s.sd}`);
  }
}

async function main() {
  const label = slug(argValue('label') || process.env.LABEL || 'aoe');
  const runs = intArgOrEnv('runs', 'RUNS', 3);
  const timeoutMs = intArgOrEnv('timeout-ms', 'RUN_TIMEOUT_MS', 330000);
  const outputDir = path.resolve(argValue('output-dir') || process.env.OUTPUT_DIR || '/private/tmp');
  const outputPrefix = path.resolve(argValue('output-prefix') || process.env.OUTPUT_PREFIX || path.join(outputDir, `aoe-repeat-${label}`));
  const summaryFile = path.resolve(argValue('summary') || process.env.SUMMARY_OUTPUT || `${outputPrefix}-summary.json`);
  const dryRun = hasFlag('dry-run') || process.env.DRY_RUN === '1';
  const verbose = hasFlag('verbose') || process.env.VERBOSE === '1';

  fs.mkdirSync(path.dirname(outputPrefix), { recursive: true });
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });

  if (dryRun) {
    console.log(`label=${label}`);
    console.log(`runs=${runs}`);
    console.log(`timeoutMs=${timeoutMs}`);
    for (let i = 1; i <= runs; i++) {
      console.log(`run ${i}: OUTPUT=${outputPrefix}-${i}.json SCREENSHOT=${outputPrefix}-${i}.png`);
    }
    console.log(`summary=${summaryFile}`);
    return;
  }

  const metrics = [];
  for (let i = 1; i <= runs; i++) {
    const output = `${outputPrefix}-${i}.json`;
    const screenshot = `${outputPrefix}-${i}.png`;
    const cpuOutput = `${outputPrefix}-${i}-cpu.json`;
    const env = {
      ...process.env,
      HANDLER_HIST: process.env.HANDLER_HIST === undefined ? '0' : process.env.HANDLER_HIST,
      PROGRESS: process.env.PROGRESS === undefined ? '1' : process.env.PROGRESS,
      STAGE_SCREENSHOTS: process.env.STAGE_SCREENSHOTS === undefined ? '1' : process.env.STAGE_SCREENSHOTS,
      OUTPUT: output,
      SCREENSHOT: screenshot,
      CPU_PROFILE_OUTPUT: cpuOutput,
    };
    console.error(`[aoe-repeat] run ${i}/${runs} output=${output}`);
    await runProfile(env, timeoutMs, verbose);
    const result = JSON.parse(fs.readFileSync(output, 'utf8'));
    const row = extractMetrics(output, result);
    metrics.push(row);
    console.error(`[aoe-repeat] run ${i}/${runs} runSlice=${row.runSliceMs} guest=${row.guestMs} presentFps=${row.presentFps}`);
  }

  const summary = {
    label,
    generatedAt: new Date().toISOString(),
    timeoutMs,
    outputPrefix,
    summaryFile,
    runs: metrics,
    stats: {
      runSliceMs: stats(metrics.map(r => r.runSliceMs)),
      guestMs: stats(metrics.map(r => r.guestMs)),
      hostMs: stats(metrics.map(r => r.hostMs)),
      presentFps: stats(metrics.map(r => r.presentFps)),
      presentEvents: stats(metrics.map(r => r.presentEvents)),
    },
  };
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  printSummary(summary);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
