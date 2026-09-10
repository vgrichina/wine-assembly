#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, 'test/binaries/win98-games-a-d');
const CHECK = process.argv.includes('--check');

const GAMES = [
  {
    id: 'curse_monkey_island_demo',
    root: 'Curse of Monkey Island demo-SW',
    exe: 'COMI.EXE',
  },
  {
    id: 'atomic_bomberman_demo',
    root: 'Aotmic BOMBMAN demo-SW/BMANDEMO',
    exe: '_BOMB.EXE',
  },
  {
    id: 'broken_sword_demo',
    root: 'Broken_Sword_demo-SW',
    exe: 'WINSWORD.EXE',
  },
  {
    id: 'dungeon_keeper_demo',
    root: 'Dungeon Keeper Demo-SWonly/installed',
    exe: 'KEEPER95.EXE',
  },
  {
    id: 'darkstone_demo',
    root: 'DarkstoneDemo-D3D/installed',
    exe: 'darkstonedemo.exe',
  },
];

function walk(directory, relative = '', output = []) {
  const entries = fs.readdirSync(path.join(directory, relative), {
    withFileTypes: true,
  }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const name = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) walk(directory, name, output);
    else if (entry.isFile() && entry.name !== '.wine-assembly-browser.json') {
      output.push(name);
    }
  }
  return output;
}
function manifestFor(game, directory) {
  const executable = path.normalize(game.exe);
  const files = walk(directory).filter(relative =>
    path.normalize(relative) !== executable).map(relative => ({
    url: relative.split(path.sep).join('/'),
    vfsPath: 'c:\\' + relative.split(path.sep).join('\\'),
  }));
  return `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`;
}

if (!fs.existsSync(CORPUS)) {
  throw new Error(`missing extracted corpus: ${path.relative(ROOT, CORPUS)}`);
}

for (const game of GAMES) {
  const directory = path.join(CORPUS, game.root);
  const executable = path.join(directory, game.exe);
  const destination = path.join(directory, '.wine-assembly-browser.json');
  if (!fs.existsSync(executable)) {
    throw new Error(`${game.id}: missing executable ${executable}`);
  }
  const wanted = manifestFor(game, directory);
  if (CHECK) {
    const actual = fs.existsSync(destination)
      ? fs.readFileSync(destination, 'utf8') : '';
    if (actual !== wanted) throw new Error(`${game.id}: stale browser manifest`);
    console.log(`OK ${game.id}`);
  } else {
    fs.writeFileSync(destination, wanted);
    const count = JSON.parse(wanted).files.length;
    console.log(`WROTE ${game.id} (${count} companion files)`);
  }
}
