#!/usr/bin/env node
'use strict';

const { DESKTOP, contentBox, cropFile, mainLegacy } = require('./png-inspect');

module.exports = { DESKTOP, contentBox, cropFile };

if (require.main === module) mainLegacy(__filename);
