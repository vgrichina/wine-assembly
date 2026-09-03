#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { desktopAssetPaths } = require('../tools/deploy-berrry');

const assets = desktopAssetPaths();
for (const file of [
  'binaries/wep16/WEP2/RODENT.EXE',
  'binaries/wep16/WEP2/FIELD100.DLL',
  'binaries/wep16/WEP2/VBRUN100.DLL',
  'binaries/wep16/WEP2/WEPUTIL.DLL',
]) {
  assert(assets.has(file), `Rodent deploy is missing ${file}`);
}

console.log('PASS  deploy derives Rodent\'s complete Win16 module set');
