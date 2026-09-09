'use strict';

const fs = require('fs');
const path = require('path');
const { collectScriptList } = require('../tools/check-browser-cache-versions');

const ROOT = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const workerSource = fs.readFileSync(path.join(ROOT, 'lib', 'guest-worker.js'), 'utf8');
const pageScripts = collectScriptList(indexSource, 'WINE_RUNTIME_SCRIPTS');
const workerScripts = collectScriptList(workerSource, 'WORKER_SCRIPTS');

module.exports = {
  indexSource,
  workerSource,
  pageScripts,
  workerScripts,
  hasPageScript: source => pageScripts.includes(source),
  hasWorkerScript: source => workerScripts.includes(source),
};
