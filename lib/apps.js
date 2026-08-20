// The app registry: what each launchable app is made of — its exe, the DLLs
// it needs beside it, and the data files that have to exist in the VFS before
// it starts (help files, card decks, level data, sound banks).
//
// This lived inside index.html, which meant it was browser-only knowledge: an
// app could be listed with the wrong asset set and nothing headless would
// notice, and test/run.js had no way to say "run what the desktop runs". Both
// hosts read it from here now. Paths are repo-relative and use the top-level
// `binaries` symlink, so they resolve the same from the page and from Node.

(function () {
  const DESKTOP_APPS = [
      ['notepad',     'Notepad',     '\u{1F4DD}'],
      ['calc',        'Calculator',  '\u{1F9EE}'],
      ['mspaint98',   'Paint',       '\u{1F3A8}'],
      ['freecell',    'FreeCell',    '\u{1F0CF}'],
      ['sol',         'Solitaire',   '\u{2660}'],
      ['cruel',       'Cruel',       '\u{1F0A1}'],
      ['golf',        'Golf',        '\u{26F3}'],
      ['pegged',      'Pegged',      '\u{1F3AF}'],
      ['snake',       'Rattler',     '\u{1F40D}'],
      ['taipei',      'Taipei',      '\u{1F004}'],
      ['tictac',      'TicTactics',  '\u{274C}'],
      ['reversi',     'Reversi',     '\u{26AB}'],
      ['winmine_wep', 'Minesweeper', '\u{1F4A3}'],
      ['ski32',       'SkiFree',     '\u{26F7}'],
      ['pinball',     'Pinball',     '\u{1F3D0}'],
      ['spider',      'Spider',      '\u{1F578}'],
      ['marbles',     'Marbles',     '\u{1F535}'],
      ['bricks',      'Bricks',      '\u{1F9F1}'],
      ['empipe',      'EmPipe',      '\u{1F6E0}'],
      ['funtris',     'Funtris',     '\u{1F9E9}'],
      ['peaks',       'Peaks',       '\u{26F0}'],
      ['pyramid',     'Pyramid',     '\u{2666}'],
      ['fourstones',  'FourStones',  '\u{1F536}'],
      ['cwordzap',    'CWordZap',    '\u{1F524}'],
      ['qblackjack',  'Blackjack',   '\u{1F0A1}'],
      ['winamp',      'Winamp',      '\u{1F3B5}'],
    ];
    // Local candidates shown in the app selector on localhost networks.
    const LOCAL_CANDIDATE_APPS = [];

    // Debug-only apps: reachable from the full app list but not the
    // desktop display. Runenlegen and Tile World draw real screens
    // (tools/wep32-compare.js checks them). Liquid War and Hearts need
    // browser LAN wiring end-to-end before player-vs-player works.
    const DEBUG_ONLY_APPS = [
      ['mshearts16',  'Hearts',      '\u{2665}'],
      ['runenlegen',  'Runenlegen',  '\u{1FAA8}'],
      ['tworld',      'Tile World',  '\u{1F511}'],
      ['liquid_war',        'Liquid War',    '\u{1F4A7}'],
      ['liquid_war_server', 'LW Server',     '\u{1F5A7}'],
    ];

    const rctFiles = [
      "AUTORUN.INF",
      "Data/csg1.dat",
      "Data/csg1i.dat",
      "Data/css1.dat",
      "Data/css10.dat",
      "Data/css11.dat",
      "Data/css12.dat",
      "Data/css13.dat",
      "Data/css14.dat",
      "Data/css15.dat",
      "Data/css16.dat",
      "Data/css17.dat",
      "Data/css2.dat",
      "Data/css3.dat",
      "Data/css4.dat",
      "Data/css5.dat",
      "Data/css6.dat",
      "Data/css7.dat",
      "Data/css8.dat",
      "Data/css9.dat",
      "Data/game.cfg",
      "Data/kanji.dat",
      "Data/mp.dat",
      "Data/tutoriak.dat",
      "Data/tutorial.dat",
      "English/English.txt",
      "English/Hasbro Interactive.url",
      "English/RCT.exe",
      "English/README.TXT",
      "English/RollerCoaster Tycoon Web Site.url",
      "English/license.txt",
      "Llogo.bmp",
      "SLOGO.BMP",
      "Saved Games/001",
      "Scenarios/SC.IDX",
      "Scenarios/SC10.SC4",
      "Scenarios/SC11.SC4",
      "Scenarios/SC15.SC4",
      "Scenarios/SC17.SC4",
      "Scenarios/SC4.SC4",
      "Scenarios/SC8.SC4",
      "Scenarios/SC9.SC4",
      "Scenarios/sc0.SC4",
      "Scenarios/sc3.SC4",
      "Setup.exe",
      "Tracks/Big Twister.TD4",
      "Tracks/Big Twister.TP4",
      "Tracks/Chipper Dipper.TD4",
      "Tracks/Chipper Dipper.TP4",
      "Tracks/Crazy Caterpillar.TD4",
      "Tracks/Crazy Caterpillar.TP4",
      "Tracks/Demon Drop.TD4",
      "Tracks/Demon Drop.TP4",
      "Tracks/Exterminator.TD4",
      "Tracks/Exterminator.TP4",
      "Tracks/Logger's Revenge.TD4",
      "Tracks/Logger's Revenge.TP4",
      "Tracks/Manic Miner.TD4",
      "Tracks/Manic Miner.TP4",
      "Tracks/Manic Mouse.TD4",
      "Tracks/Manic Mouse.TP4",
      "Tracks/Mini Cars.TD4",
      "Tracks/Mini Cars.TP4",
      "Tracks/Mini Maze.TD4",
      "Tracks/Mini Maze.TP4",
      "Tracks/Mini Miner.TD4",
      "Tracks/Mini Miner.TP4",
      "Tracks/Ropey Rapids.TD4",
      "Tracks/Ropey Rapids.TP4",
      "Tracks/Scorpion.TD4",
      "Tracks/Scorpion.TP4",
      "Tracks/Spiral Maze.TD4",
      "Tracks/Spiral Maze.TP4",
      "Tracks/Thunder Looper.TD4",
      "Tracks/Thunder Looper.TP4",
      "UniFish3.exe",
    ].flatMap(p => {
      const url = 'binaries/shareware/rct/' + p;
      const mapped = [{ url, vfsPath: 'c:\\' + p }];
      if (p.startsWith('English/')) {
        mapped.push({ url, vfsPath: 'c:\\' + p.slice('English/'.length) });
      }
      return mapped;
    });

    const aoe1Files = [
      "Aelaunch.dll",
      "Aggres_1.per",
      "Aggres_2.per",
      "Aggres_3.per",
      "Aichall.ai",
      "Aoe.ply",
      "AoEHlp.dll",
      "Archer_1.ai",
      "Archer_2.ai",
      "Arial.ttf",
      "Arialbd.ttf",
      "Armies_1.cpn",
      "Assyri_1.ai",
      "Assyri_2.ai",
      "Assyrian.doc",
      "Bablnian.doc",
      "Babylo_1.ai",
      "Babylo_2.ai",
      "Bird.wav",
      "Cavalr_1.ai",
      "Cavalr_2.ai",
      "Cavarc_1.ai",
      "Choson_1.ai",
      "Choson_2.ai",
      "Choson.doc",
      "Closedpw.exe",
      "Comic.ttf",
      "Comicbd.ttf",
      "Coprgtb.ttf",
      "Coprgtl.ttf",
      "data/Border.drs",
      "data/Graphics.drs",
      "data/Interfac.drs",
      "data/Sounds.drs",
      "data/Terrain.drs",
      "De316f_1.ai",
      "De34c1_1.ai",
      "De451c_1.ai",
      "De494f_1.ai",
      "De4ef6_1.ai",
      "De4fe1_1.ai",
      "De5149_1.ai",
      "De8dfc_1.ai",
      "Deathm_1.ai",
      "Deathm_2.ai",
      "Deathm_3.ai",
      "Deathm_4.ai",
      "Default.ai",
      "Default.cty",
      "Default.per",
      "Defens_1.per",
      "Desert1.wav",
      "dplay50a.EXE",
      "Egyptc_1.ai",
      "Egyptian.doc",
      "Egyptw_1.ai",
      "Elepha_1.ai",
      "Empires.dat",
      "Empires.hlp",
      "eula.txt",
      "Forest1.wav",
      "Greek.doc",
      "Greekp_1.ai",
      "Hittit_1.ai",
      "Hittit_2.ai",
      "Hittite.doc",
      "Im04fa_1.ai",
      "Im867c_1.ai",
      "Immort_1.ai",
      "Immort_2.ai",
      "Immort_3.ai",
      "Immort_4.ai",
      "Infant_1.ai",
      "Infant_2.ai",
      "Infant_3.ai",
      "language.dll",
      "Learn.txt",
      "Lost.mid",
      "Minoac_1.ai",
      "Minoan.doc",
      "Multip_1.scn",
      "Music1.mid",
      "Music2.mid",
      "Music3.mid",
      "Music4.mid",
      "Music5.mid",
      "Music6.mid",
      "Music7.mid",
      "Music8.mid",
      "Music9.mid",
      "Ocean1.wav",
      "Open.mid",
      "Passiv_1.per",
      "Passive.per",
      "Persia_1.ai",
      "Persian.doc",
      "Phalan_1.ai",
      "Phalan_2.ai",
      "Phnician.doc",
      "Phoeni_1.ai",
      "Priest_1.ai",
      "Priest_2.ai",
      "Readme.doc",
      "Reigno_1.cpn",
      "Rules.rps",
      "Savegame.txt",
      "Scenario.inf",
      "setup.exe",
      "setupenu.dll",
      "Shadow.col",
      "Shang.doc",
      "Shangc_1.ai",
      "Shangc_2.ai",
      "Shangh_1.ai",
      "Sumeri_1.ai",
      "Sumeri_2.ai",
      "Sumerian.doc",
      "Supera_1.per",
      "Tileedge.dat",
      "Trirem_1.ai",
      "Trirem_2.ai",
      "Warele_1.ai",
      "Wind1.wav",
      "Wind2.wav",
      "Won.mid",
      "Wonder_1.ai",
      "Yamato_1.ai",
      "Yamato.doc",
    ].map(p => {
      const url = 'binaries/shareware/aoe/aoe_ex/' + p;
      const vfsPath = 'c:\\' + p.toLowerCase().replace(/\//g, '\\');
      if (/^data\/.*\.drs$/i.test(p)) {
        return { url, vfsPaths: [vfsPath, 'c:\\' + p.split('/').pop().toLowerCase()] };
      }
      return { url, vfsPath };
    });

    const pinballFiles = [
      'binaries/pinball/wavemix.inf',
      'binaries/pinball/PINBALL.DAT',
      'binaries/pinball/FONT.DAT',
      'binaries/pinball/table.bmp',
      'binaries/pinball/PINBALL.MID',
      'binaries/pinball/PINBALL2.MID',
      'binaries/pinball/SOUND1.WAV',
      'binaries/pinball/SOUND104.WAV',
      'binaries/pinball/SOUND105.WAV',
      'binaries/pinball/SOUND108.WAV',
      'binaries/pinball/SOUND111.WAV',
      'binaries/pinball/SOUND112.WAV',
      'binaries/pinball/SOUND12.WAV',
      'binaries/pinball/SOUND13.WAV',
      'binaries/pinball/SOUND131.WAV',
      'binaries/pinball/SOUND136.WAV',
      'binaries/pinball/SOUND14.WAV',
      'binaries/pinball/SOUND16.WAV',
      'binaries/pinball/SOUND17.WAV',
      'binaries/pinball/SOUND18.WAV',
      'binaries/pinball/SOUND181.WAV',
      'binaries/pinball/SOUND19.WAV',
      'binaries/pinball/SOUND20.WAV',
      'binaries/pinball/SOUND21.WAV',
      'binaries/pinball/SOUND22.WAV',
      'binaries/pinball/SOUND24.WAV',
      'binaries/pinball/SOUND240.WAV',
      'binaries/pinball/SOUND243.WAV',
      'binaries/pinball/SOUND25.WAV',
      'binaries/pinball/SOUND26.WAV',
      'binaries/pinball/SOUND27.WAV',
      'binaries/pinball/SOUND28.WAV',
      'binaries/pinball/SOUND29.WAV',
      'binaries/pinball/SOUND3.WAV',
      'binaries/pinball/SOUND30.WAV',
      'binaries/pinball/SOUND34.WAV',
      'binaries/pinball/SOUND35.WAV',
      'binaries/pinball/SOUND36.WAV',
      'binaries/pinball/SOUND38.WAV',
      'binaries/pinball/SOUND39.WAV',
      'binaries/pinball/SOUND4.WAV',
      'binaries/pinball/SOUND42.WAV',
      'binaries/pinball/SOUND43.WAV',
      'binaries/pinball/SOUND45.WAV',
      'binaries/pinball/SOUND49.WAV',
      'binaries/pinball/SOUND49D.WAV',
      'binaries/pinball/SOUND5.WAV',
      'binaries/pinball/SOUND50.WAV',
      'binaries/pinball/SOUND528.WAV',
      'binaries/pinball/SOUND53.WAV',
      'binaries/pinball/SOUND54.WAV',
      'binaries/pinball/SOUND55.WAV',
      'binaries/pinball/SOUND560.WAV',
      'binaries/pinball/SOUND563.WAV',
      'binaries/pinball/SOUND57.WAV',
      'binaries/pinball/SOUND58.WAV',
      'binaries/pinball/SOUND6.WAV',
      'binaries/pinball/SOUND65.WAV',
      'binaries/pinball/SOUND68.WAV',
      'binaries/pinball/SOUND7.WAV',
      'binaries/pinball/SOUND713.WAV',
      'binaries/pinball/SOUND735.WAV',
      'binaries/pinball/SOUND8.WAV',
      'binaries/pinball/SOUND827.WAV',
      'binaries/pinball/SOUND9.WAV',
      'binaries/pinball/SOUND999.WAV',
    ];

    const pinballPlus95Files = [
      'binaries/pinball-plus95/wavemix.inf',
      'binaries/pinball-plus95/PINBALL.DAT',
      'binaries/pinball-plus95/FONT.DAT',
      'binaries/pinball-plus95/table.bmp',
      'binaries/pinball-plus95/PINBALL.MID',
      'binaries/pinball-plus95/PINBALL2.MID',
      'binaries/pinball-plus95/SOUND1.WAV',
      'binaries/pinball-plus95/SOUND104.WAV',
      'binaries/pinball-plus95/SOUND105.WAV',
      'binaries/pinball-plus95/SOUND108.WAV',
      'binaries/pinball-plus95/SOUND12.WAV',
      'binaries/pinball-plus95/SOUND131.WAV',
      'binaries/pinball-plus95/SOUND14.WAV',
      'binaries/pinball-plus95/SOUND16.WAV',
      'binaries/pinball-plus95/SOUND17.WAV',
      'binaries/pinball-plus95/SOUND18.WAV',
      'binaries/pinball-plus95/SOUND19.WAV',
      'binaries/pinball-plus95/SOUND20.WAV',
      'binaries/pinball-plus95/SOUND21.WAV',
      'binaries/pinball-plus95/SOUND22.WAV',
      'binaries/pinball-plus95/SOUND24.WAV',
      'binaries/pinball-plus95/SOUND25.WAV',
      'binaries/pinball-plus95/SOUND26.WAV',
      'binaries/pinball-plus95/SOUND27.WAV',
      'binaries/pinball-plus95/SOUND28.WAV',
      'binaries/pinball-plus95/SOUND29.WAV',
      'binaries/pinball-plus95/SOUND3.WAV',
      'binaries/pinball-plus95/SOUND30.WAV',
      'binaries/pinball-plus95/SOUND34.WAV',
      'binaries/pinball-plus95/SOUND35.WAV',
      'binaries/pinball-plus95/SOUND36.WAV',
      'binaries/pinball-plus95/SOUND38.WAV',
      'binaries/pinball-plus95/SOUND39.WAV',
      'binaries/pinball-plus95/SOUND4.WAV',
      'binaries/pinball-plus95/SOUND42.WAV',
      'binaries/pinball-plus95/SOUND43.WAV',
      'binaries/pinball-plus95/SOUND45.WAV',
      'binaries/pinball-plus95/SOUND49.WAV',
      'binaries/pinball-plus95/SOUND49D.WAV',
      'binaries/pinball-plus95/SOUND5.WAV',
      'binaries/pinball-plus95/SOUND50.WAV',
      'binaries/pinball-plus95/SOUND54.WAV',
      'binaries/pinball-plus95/SOUND55.WAV',
      'binaries/pinball-plus95/SOUND57.WAV',
      'binaries/pinball-plus95/SOUND58.WAV',
      'binaries/pinball-plus95/SOUND7.WAV',
      'binaries/pinball-plus95/SOUND8.WAV',
      'binaries/pinball-plus95/SOUND9.WAV',
    ];

    const dxSdkBinFiles = [
      'binaries/dx-sdk/bin/banana.ppm',
      'binaries/dx-sdk/bin/camera.x',
      'binaries/dx-sdk/bin/checker.ppm',
      'binaries/dx-sdk/bin/lake.ppm',
      'binaries/dx-sdk/bin/mslogo.x',
      'binaries/dx-sdk/bin/pm_bship.x',
      'binaries/dx-sdk/bin/pm_cam.x',
      'binaries/dx-sdk/bin/pm_chrry.x',
      'binaries/dx-sdk/bin/pm_cube.x',
      'binaries/dx-sdk/bin/pm_dship.x',
      'binaries/dx-sdk/bin/pm_egg.x',
      'binaries/dx-sdk/bin/pm_land4.x',
      'binaries/dx-sdk/bin/pm_mslog.x',
      'binaries/dx-sdk/bin/pm_multi.x',
      'binaries/dx-sdk/bin/pm_rmlog.x',
      'binaries/dx-sdk/bin/pm_sph0.x',
      'binaries/dx-sdk/bin/pm_sph1.x',
      'binaries/dx-sdk/bin/pm_sph2.x',
      'binaries/dx-sdk/bin/pm_sph3.x',
      'binaries/dx-sdk/bin/pm_sph4.x',
      'binaries/dx-sdk/bin/pm_torus.x',
      'binaries/dx-sdk/bin/pm_tpot.x',
      'binaries/dx-sdk/bin/pm_tpot0.x',
      'binaries/dx-sdk/bin/pm_tpot1.x',
      'binaries/dx-sdk/bin/pm_tpot2.x',
      'binaries/dx-sdk/bin/pm_tpot3.x',
      'binaries/dx-sdk/bin/pm_tree.x',
      'binaries/dx-sdk/bin/sphere2.x',
      'binaries/dx-sdk/bin/sphere3.x',
      'binaries/dx-sdk/bin/tex1.ppm',
      'binaries/dx-sdk/bin/tex2.ppm',
      'binaries/dx-sdk/bin/tex3.ppm',
      'binaries/dx-sdk/bin/tex4.ppm',
      'binaries/dx-sdk/bin/tex5.ppm',
      'binaries/dx-sdk/bin/tex6.ppm',
      'binaries/dx-sdk/bin/tex7.ppm',
      'binaries/dx-sdk/bin/win95.ppm',
    ];

    // Prepared from the original Wise installer by running
    // PREPARE_DXBALL_DEBUG_WEB=1 node test/test-dxball-candidate.js.
    // test/binaries is gitignored and excluded from public deployment; this
    // manifest is reachable only from the unfiltered ?debug app selector.
    const dxballCandidateRoot = 'test/binaries/candidates/dxball/installed/';
    const dxballCandidateFiles = [
      '12flight.mds', 'acker-gs.mds', 'ao-laser.wav', 'bang.wav',
      'bassdrum.wav', 'bigbolt.pcx', 'boing.wav', 'brain.mds',
      'byeball.wav', 'candy.sbk', 'chisel2.sbk', 'default.bds',
      'effect.wav', 'effect2.wav', 'ethno_pa.mds', 'fanfare.wav',
      'freebee.mds', 'glass.wav', 'gmfigaro.mds', 'gunfire.wav',
      'highscor.pcx', 'humm.wav', 'intro.pcx', 'mainmenu.pcx',
      'mainmenu.sbk', 'mball2.sbk', 'mbbkgrnd.pcx', 'orchblas.wav',
      'orchestr.wav', 'padexplo.wav', 'peow!.wav', 'readme.txt',
      'ricochet.wav', 'saucer.wav', 'score.dat', 'sfont.sbk',
      'sweepdow.wav', 'swordswi.wav', 'sysfont.sbk', 'tank.wav',
      'thefont.sbk', 'thudclap.wav', 'voltage.wav', 'whine.wav',
      'wowpulse.wav', 'xploshor.wav', 'xplosht1.wav',
    ].map(name => dxballCandidateRoot + name);

    // Extracted archive payload used by the candidate CLI gate. Keep it local
    // and debug-only, alongside DX-Ball, until Blobby is ready for promotion.
    const blobbyCandidateRoot = 'test/binaries/candidates/blobby-volley/';
    const blobbyCandidateFiles = [
      'graph.pak', 'sound.pak', 'text.pak',
    ].map(name => blobbyCandidateRoot + name);

    // Liquid War 5.6.2. The client and the server are separate programs from
    // the same tree and share its assets: lw.dat holds the sprites and the
    // built-in maps, custom/ holds the user maps and textures the menus offer.
    const liquidWarRoot = 'test/binaries/candidates/liquid-war/LW5/';
    const liquidWarFiles = [
      'data/lw.dat',
      'custom/map/meditate.bmp', 'custom/map/pacman.bmp',
      'custom/map/paille.bmp', 'custom/map/t4.bmp',
      'custom/texture/bluesq.bmp', 'custom/texture/clovers.bmp',
      'custom/texture/meditate.bmp', 'custom/texture/rust.bmp',
      'custom/texture/warning.bmp',
      'custom/music/colossus.mid',
    ].map(name => liquidWarRoot + name);

    // A guest reaches its help file only through the VFS, and the CLI harness
    // has a fallback that silently resolves any name against binaries/help.
    // The browser has no such fallback, so each app must mount its own .hlp
    // (and .cnt, which drives the Help Topics contents tree).
    const helpFiles = name => [`binaries/help/${name}.hlp`, `binaries/help/${name}.cnt`];

    // The original Entertainment Pack volumes: 16-bit NE, four directories,
    // one <STEM>.EXE and (almost always) a <STEM>.HLP per game. The DLLs are
    // NE too and are not listed — host.js fetches whatever the exe's own
    // module-reference table names out of the exe's own directory, which is
    // how ABOUTWEP, IWLIB, WEPUTIL, WEP4UTIL and VBRUN100 arrive. What is
    // listed is only what a game opens through the filesystem: the CLI mounts
    // the whole directory and the page cannot, so a data file missing here is
    // a game that runs in one host and not the other.
    // `modules` are NE DLLs the game loads by name at runtime instead of
    // importing — the pack's WEPUTIL, Rattler Race's FIELD100, Go Figure!'s
    // Visual Basic custom controls, the level DLL Stones ships one of per
    // screen. They are in no table anywhere, so the page has to be told; find
    // a game's set with `node test/run.js --app=<id> --trace-win16`.
    const wep16 = (vol, stem, data = [], modules = [], hasHelp = true) => ({
      exe: `binaries/wep16/${vol}/${stem}.EXE`,
      files: [
        ...(hasHelp ? [`binaries/wep16/${vol}/${stem}.HLP`] : []),
        ...data.map(name => `binaries/wep16/${vol}/${name}`),
      ],
      ...(modules.length ? { win16Modules: modules } : {}),
    });
    // Volume 4's games share one sound set and pick from it by name, so each
    // of them gets all of it rather than a guess at which clips are whose.
    const wep4Sounds = [
      'ALERT.WAV', 'BELL.WAV', 'BLIP2.WAV', 'BOUNCE.WAV', 'BUMMER.WAV',
      'CLICK1.WAV', 'CLICK3.WAV', 'DITTY1.WAV', 'DOOR.WAV', 'EXPLOSON.WAV',
      'GAP.WAV', 'HIT3.WAV', 'JEZZDEAD.WAV', 'LOSEGAME.WAV', 'NEWBALL.WAV',
      'OOF3.WAV', 'POP2.WAV', 'STRIKE.WAV', 'TELEPORT.WAV', 'WATER2.WAV',
      'WINLEVEL.WAV', 'WIPE.WAV',
    ];

    const APPS = {
      notepad:  { exe: 'binaries/notepad.exe', files: helpFiles('notepad') },
      calc:     { exe: 'binaries/calc.exe', dlls: ['binaries/dlls/msvcrt.dll'], files: helpFiles('calc') },
      freecell: { exe: 'binaries/entertainment-pack/freecell.exe', dlls: ['binaries/entertainment-pack/cards.dll'], files: helpFiles('freecell') },
      sol:      { exe: 'binaries/entertainment-pack/sol.exe', dlls: ['binaries/entertainment-pack/cards.dll'], files: ['binaries/help/sol.hlp'] },
      cruel:    { exe: 'binaries/entertainment-pack/cruel.exe', dlls: ['binaries/entertainment-pack/cards.dll'] },
      golf:     { exe: 'binaries/entertainment-pack/golf.exe', dlls: ['binaries/entertainment-pack/cards.dll'] },
      pegged:   { exe: 'binaries/entertainment-pack/pegged.exe' },
      snake:    { exe: 'binaries/entertainment-pack/snake.exe' },
      taipei:   { exe: 'binaries/entertainment-pack/taipei.exe' },
      tictac:   { exe: 'binaries/entertainment-pack/tictac.exe' },
      reversi:  { exe: 'binaries/entertainment-pack/reversi.exe' },
      winmine_wep: { exe: 'binaries/entertainment-pack/winmine.exe' },
      // The original 16-bit NE builds. Their DLLs are NE too, so they do not
      // go in `dlls` (which loads 32-bit PEs) — host.js fetches them from the
      // exe's own directory once it sees the task is 16-bit.
      winmine16:  { exe: 'binaries/win98-16bit/WINMINE.EXE' },
      freecell16: { exe: 'binaries/win98-16bit/FREECELL.EXE' },
      sol16:      { exe: 'binaries/win98-16bit/SOL.EXE' },
      mshearts16: {
        exe: 'binaries/win98-16bit/MSHEARTS.EXE',
        // Hearts is a NetDDE game: one player deals, the others join the
        // table. It never names a machine on the wire — the conversation is
        // opened by broadcast on the segment — so unlike Liquid War there is
        // no address for anyone to type in.
        lan: {
          exe: 'MSHEARTS.EXE',
          label: 'Hearts',
          local: true,
          hint: 'One of you picks “I want to be the dealer”, the other picks '
            + '“I want to connect to another game” and types any name.',
        },
      },
      // The 26 Entertainment Pack games that reach their own screen. The three
      // that do not are deliberately absent: Rodent's Revenge and Tic Tac Drop
      // stop on a Visual Basic runtime error, and Fuji Golf wants a
      // FUJIGOLF.DAT that is in no copy of the pack we have. Re-measure with
      // `node tools/wep32-compare.js --dir=test/binaries/wep16`.
      wep16_cruel:    wep16('WEP1', 'CRUEL'),
      wep16_golf:     wep16('WEP1', 'GOLF'),
      // IdleWild's six screens are NE modules of their own, under an .IW
      // extension — deliberately not listed: see win16FileCandidates.
      wep16_idlewild: wep16('WEP1', 'IDLEWILD', [], ['WEPUTIL']),
      wep16_pegged:   wep16('WEP1', 'PEGGED'),
      wep16_tetris:   wep16('WEP1', 'TETRIS', ['TETRIS.INI', 'TETRIS.HST']),
      wep16_tic:      wep16('WEP1', 'TIC'),
      wep16_tp:       wep16('WEP1', 'TP'),
      wep16_winmine:  wep16('WEP1', 'WINMINE'),
      wep16_freecell: wep16('WEP2', 'FREECELL', [], ['WEPUTIL']),
      wep16_jigsawed: wep16('WEP2', 'JIGSAWED',
        ['BRICKS.BMP', 'FISH.BMP', 'RUG.BMP', 'TANKER.BMP', 'TREES.BMP'],
        ['WEPUTIL']),
      wep16_pipe:     wep16('WEP2', 'PIPE'),
      wep16_rattler:  wep16('WEP2', 'RATTLER', [], ['FIELD100', 'WEPUTIL']),
      // Stones loads the screen it is about to play as a module.
      wep16_stones:   wep16('WEP2', 'STONES', ['STONE.SAV'],
        ['WEPUTIL', 'STONE00', 'STONE01', 'STONE02', 'STONE03', 'STONE04',
         'STONEE00', 'STONEE01', 'STONEE02', 'STONEE03']),
      wep16_tutstomb: wep16('WEP2', 'TUTSTOMB', [], ['WEPUTIL']),
      wep16_klotski:  wep16('WEP3', 'KLOTSKI', ['KLOTSKI.SCO']),
      wep16_lifegen:  wep16('WEP3', 'LIFEGEN', [], ['WEPUTIL']),
      // SKI is the one game in the pack that ships without a help file.
      wep16_ski:      wep16('WEP3', 'SKI', [], [], false),
      wep16_tetravex: wep16('WEP3', 'TETRAVEX'),
      wep16_tripeaks: wep16('WEP3', 'TRIPEAKS'),
      wep16_wordzap:  wep16('WEP3', 'WORDZAP'),
      wep16_blakjak:  wep16('WEP4', 'BLAKJAK', wep4Sounds),
      wep16_chess:    wep16('WEP4', 'CHESS', ['OPENING.BK', 'OPENING.TXT', ...wep4Sounds]),
      wep16_chips:    wep16('WEP4', 'CHIPS',
        ['CHIPS.DAT', 'CHIP01.MID', 'CHIP02.MID', ...wep4Sounds]),
      // Go Figure! is a Visual Basic app: its controls are .VBX modules.
      wep16_gofigure: wep16('WEP4', 'GOFIGURE', wep4Sounds,
        ['GAUGE', 'THREED', 'CMDIALOG', 'WEP4UTIL']),
      wep16_jezzball: wep16('WEP4', 'JEZZBALL', wep4Sounds),
      wep16_maxwell:  wep16('WEP4', 'MAXWELL', wep4Sounds),
      mspaint98: { exe: 'binaries/mspaint.exe', files: helpFiles('mspaint') },
      notepad98: { exe: 'binaries/win98-apps/notepad98.exe', files: helpFiles('notepad') },
      wordpad:   {
        exe: 'binaries/win98-apps/wordpad.exe',
        files: helpFiles('wordpad'),
        // WordPad calls LoadLibrary for RichEdit during document-view setup.
        // Preload the native editor and its shaping dependency so their
        // DllMain/import initialization completes before WordPad creates the
        // RichEdit20A child, matching the CLI harness.
        dlls: ['binaries/dlls/riched20.dll', 'binaries/dlls/usp10.dll'],
      },
      write:     { exe: 'binaries/win98-apps/write.exe' },
      mplayer:  { exe: 'binaries/win98-apps/mplayer.exe' },
      mplay32:  { exe: 'binaries/win98-apps/mplay32.exe' },
      cdplayer: { exe: 'binaries/win98-apps/cdplayer.exe' },
      sndrec32_98: { exe: 'binaries/win98-apps/sndrec32.exe' },
      sndvol32: { exe: 'binaries/win98-apps/sndvol32.exe' },
      vol98:    { exe: 'binaries/win98-apps/vol98.exe' },
      fontview: {
        exe: 'binaries/win98-apps/fontview.exe',
        // This Win98 build previews NE-format .FON resources and uses the
        // VC++ 2.0/MFC 3.0 runtime pair. Load the CRT first because MFC30
        // imports it during DllMain initialization.
        dlls: ['binaries/dlls/msvcrt20.dll', 'binaries/dlls/mfc30.dll'],
        files: ['binaries/win98-apps/vgasys.fon'],
        requiredFiles: true,
        args: 'vgasys.fon',
      },
      kodakimg: { exe: 'binaries/win98-apps/kodakimg.exe' },
      kodakprv: { exe: 'binaries/win98-apps/kodakprv.exe' },
      hypertrm: { exe: 'binaries/win98-apps/hypertrm.exe' },
      telnet:   { exe: 'binaries/win98-apps/telnet.exe' },
      winipcfg: { exe: 'binaries/win98-apps/winipcfg.exe' },
      explorer98: { exe: 'binaries/explorer98/explorer.exe' },
      regedit:  { exe: 'binaries/win98-apps/regedit.exe' },
      taskman:  { exe: 'binaries/win98-apps/taskman.exe' },
      welcome98: { exe: 'binaries/win98-apps/welcome.exe' },
      tour98:   { exe: 'binaries/win98-apps/tour98.exe' },
      sysmon:   { exe: 'binaries/win98-apps/sysmon.exe' },
      rsrcmtr:  { exe: 'binaries/win98-apps/rsrcmtr.exe' },
      cleanmgr: { exe: 'binaries/win98-apps/cleanmgr.exe' },
      claass:   { exe: 'binaries/xp/claass.exe' },
      xp_eos:   { exe: 'binaries/xp/xp_eos.exe' },
      mspaint_ep: { exe: 'binaries/entertainment-pack/mspaint.exe' },
      mspaint:  { exe: 'binaries/nt/mspaint.exe', dlls: ['binaries/dlls/msvcrt.dll', 'binaries/dlls/mfc42u.dll'], winver: 0x05650004 },
      ski32:    { exe: 'binaries/entertainment-pack/ski32.exe' },
      liquid_war: {
        exe: liquidWarRoot + 'lwwin.exe',
        files: liquidWarFiles,
        requiredFiles: true,
        // Opens the lobby before booting. The channel is keyed on the
        // executable, so a Liquid War player only ever sees other Liquid War
        // players — see scopeFor() in lib/vlan-rtc.js.
        lan: { exe: 'lwwin.exe', label: 'Liquid War' },
      },
      // The dedicated server is the same tree's other executable. It has no
      // game window of its own — it prints to a console and waits — so it is
      // only interesting with a client pointed at it.
      liquid_war_server: {
        exe: liquidWarRoot + 'lwwinsrv.exe',
        files: liquidWarFiles,
        requiredFiles: true,
        args: '-private -2 -nobeep',
        // The server shares the client's channel: it is the thing the other
        // player's client is looking for, so they have to be on one segment.
        lan: { exe: 'lwwin.exe', label: 'Liquid War server' },
      },
      winmine:  { exe: 'binaries/xp/winmine.exe' },
      sndrec32_xp: { exe: 'binaries/xp/sndrec32.exe' },
      pinball:  { exe: 'binaries/pinball/pinball.exe', files: pinballFiles },
      pinball_plus95: { exe: 'binaries/pinball-plus95/pinball.exe', files: pinballPlus95Files },
      dxball: {
        exe: dxballCandidateRoot + 'dxball.exe',
        files: dxballCandidateFiles,
        requiredFiles: true,
      },
      blobby_volley: {
        exe: blobbyCandidateRoot + 'volley.exe',
        files: blobbyCandidateFiles,
        requiredFiles: true,
      },
      funtris:    {
        exe: 'binaries/wep32-community/Funpack/Funtris.exe',
        dlls: ['binaries/wep32-community/Funpack/FunPack.dll'],
        startupRegistry: [
          { keyPath: 'HKCU\\Software\\Funpack Software\\Funtris\\Options', valueName: 'GetStarted', type: 4, data: 0 },
        ],
        dismissStartupDialog: { title: 'Funtris', command: 1 },
      },
      peaks:      {
        exe: 'binaries/wep32-community/Funpack/Peaks.exe',
        dlls: ['binaries/wep32-community/Funpack/FunPack.dll'],
        startupRegistry: [
          { keyPath: 'HKCU\\Software\\Funpack Software\\Peaks\\Options', valueName: 'GetStarted', type: 4, data: 0 },
        ],
        dismissStartupDialog: { title: 'Peaks', command: 1 },
      },
      pyramid:    {
        exe: 'binaries/wep32-community/Funpack/Pyramid.exe',
        dlls: ['binaries/wep32-community/Funpack/FunPack.dll'],
        startupIni: [
          { fileName: 'win.ini', section: 'intl', key: 'iCDateCount', value: -1 },
        ],
        startupRegistry: [
          { keyPath: 'HKCU\\Software\\Funpack Software\\Pyramid\\Options', valueName: 'GetStarted', type: 4, data: 0 },
        ],
      },
      fourstones: {
        exe: 'binaries/wep32-community/Funpack/FourStones.exe',
        dlls: ['binaries/wep32-community/Funpack/FunPack.dll'],
        startupRegistry: [
          { keyPath: 'HKCU\\Software\\Funpack Software\\Four Stones\\Options', valueName: 'GetStarted', type: 4, data: 0 },
        ],
        dismissStartupDialog: { title: 'Four', command: 1 },
      },
      cwordzap:   { exe: 'binaries/wep32-community/Wordzap/CWordZap.exe' },
      bricks:     { exe: 'binaries/wep32-community/Bricks/bricks.exe',      files: ['binaries/wep32-community/Bricks/brk1.dll'] },
      pawn:       { exe: 'binaries/wep32-community/Pawn/Pawn.exe' },
      qblackjack: {
        exe: 'binaries/wep32-community/QBlackjack/QuickBlackjack.exe',
        startupRegistry: [
          { keyPath: 'HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Player', valueName: 'Purse', type: 4, data: 500 },
          { keyPath: 'HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Player', valueName: 'Change', type: 4, data: 0 },
          { keyPath: 'HKCU\\Software\\Wesley Steiner\\Quick Blackjack\\Tabletop', valueName: 'Animation', type: 4, data: 0 },
        ],
      },
      runenlegen: { exe: 'binaries/wep32-community/Runenlegen/Runenlegen.exe' },
      tetravex:   { exe: 'binaries/wep32-community/Tetravex/Tetravex.exe' },
      winarc:     { exe: 'binaries/wep32-community/Winarc/Winarc.exe' },
      jigssawme:  { exe: 'binaries/wep32-community/Jigssawme/JigSawedME.exe' },
      rodent2000: { exe: 'binaries/wep32-community/Rodent2000/Rodent2000.exe' },
      tworld: {
        exe: 'binaries/wep32-community/TWorld/tworld.exe',
        dlls: ['binaries/wep32-community/TWorld/SDL.dll'],
        files: [
          // Level packs (.dac descriptors live in sets/, .dat level data in data/)
          { url: 'binaries/wep32-community/TWorld/sets/cc-ms.dac',     vfsPath: 'c:\\sets\\cc-ms.dac' },
          { url: 'binaries/wep32-community/TWorld/sets/CCLP1-MS.dac',  vfsPath: 'c:\\sets\\cclp1-ms.dac' },
          { url: 'binaries/wep32-community/TWorld/sets/CCLP2-MS.dac',  vfsPath: 'c:\\sets\\cclp2-ms.dac' },
          { url: 'binaries/wep32-community/TWorld/sets/CCLP3-MS.dac',  vfsPath: 'c:\\sets\\cclp3-ms.dac' },
          { url: 'binaries/wep32-community/TWorld/sets/intro-ms.dac',  vfsPath: 'c:\\sets\\intro-ms.dac' },
          { url: 'binaries/wep32-community/TWorld/data/CHIPS.DAT',     vfsPath: 'c:\\data\\chips.dat' },
          { url: 'binaries/wep32-community/TWorld/data/CCLP1.dat',     vfsPath: 'c:\\data\\cclp1.dat' },
          { url: 'binaries/wep32-community/TWorld/data/CCLP2.dat',     vfsPath: 'c:\\data\\cclp2.dat' },
          { url: 'binaries/wep32-community/TWorld/data/CCLP3.dat',     vfsPath: 'c:\\data\\cclp3.dat' },
          { url: 'binaries/wep32-community/TWorld/data/intro.dat',     vfsPath: 'c:\\data\\intro.dat' },
          // Resources (font/tiles + ruleset config + sound effects)
          { url: 'binaries/wep32-community/TWorld/res/rc',             vfsPath: 'c:\\res\\rc' },
          { url: 'binaries/wep32-community/TWorld/res/font.bmp',       vfsPath: 'c:\\res\\font.bmp' },
          { url: 'binaries/wep32-community/TWorld/res/tiles.bmp',      vfsPath: 'c:\\res\\tiles.bmp' },
          { url: 'binaries/wep32-community/TWorld/res/unslist.txt',    vfsPath: 'c:\\res\\unslist.txt' },
        ],
      },
      empipe:     { exe: 'binaries/wep32-community/EmPipe/EMPIPE.EXE', requiredFiles: true, files: [
        'binaries/wep32-community/EmPipe/EMPIPEE.HLP',
        'binaries/wep32-community/EmPipe/EMPIPEE.TXT',
        'binaries/wep32-community/EmPipe/EMPIPE.EXE.manifest',
        'binaries/wep32-community/EmPipe/EMPCLEAR.MID', 'binaries/wep32-community/EmPipe/EMPGMOV.MID',
        'binaries/wep32-community/EmPipe/EMPSCR1.MID', 'binaries/wep32-community/EmPipe/EMPSCR2.MID',
        'binaries/wep32-community/EmPipe/EMPSCR3.MID', 'binaries/wep32-community/EmPipe/EMPSCR4.MID',
        'binaries/wep32-community/EmPipe/EMPSCR5.MID', 'binaries/wep32-community/EmPipe/EMPSTART.MID',
      ] },
      spider:     { exe: 'binaries/plus98/SPIDER.EXE', dlls: ['binaries/entertainment-pack/cards.dll'], files: ['binaries/plus98/SPIDER.CHM', 'binaries/plus98/SPIDER.HLP'] },
      marbles:    { exe: 'binaries/plus98/MARBLES.EXE', files: [
        'binaries/plus98/LLOGO.BMP', 'binaries/plus98/LSPLASH.BMP',
        'binaries/plus98/CHOOSE1.BMP', 'binaries/plus98/CHOOSE2.BMP',
        'binaries/plus98/COMMON01.BMP', 'binaries/plus98/COMMON02.BMP', 'binaries/plus98/COMMON03.BMP',
        'binaries/plus98/COMMON04.BMP', 'binaries/plus98/COMMON05.BMP', 'binaries/plus98/CMNBONUS.BMP',
        'binaries/plus98/LEVEL-01.BMP', 'binaries/plus98/LEVEL-01.DAT', 'binaries/plus98/LEVEL1BG.BMP',
        'binaries/plus98/TRANS1A.BMP', 'binaries/plus98/TRANS2A.BMP',
        'binaries/plus98/DIALOG.BMP', 'binaries/plus98/OPTIONS.BMP', 'binaries/plus98/TEXTFONT.BMP',
        'binaries/plus98/CRACK.BMP', 'binaries/plus98/GRASTILE.BMP',
        'binaries/plus98/B1.MID', 'binaries/plus98/CRD.MID', 'binaries/plus98/LVL1.MID',
        'binaries/plus98/2.WAV', 'binaries/plus98/MARBLES.ICO',
      ] },
      winamp:     {
        exe: 'binaries/winamp.exe',
        dlls: ['binaries/plugins/candidates/vis_w.dll'],
        files: [
          // Keep the web default to the known-good playback pair. Winamp's
          // Visualization prefs enumerate C:\Plugins\*.DLL and dynamically
          // loading arbitrary non-visualizer plugins still aborts that pane's
          // init under the current loader.
          { url: 'binaries/plugins/in_mp3.dll', vfsPath: 'c:\\plugins\\in_mp3.dll' },
          { url: 'binaries/plugins/out_wave.dll', vfsPath: 'c:\\plugins\\out_wave.dll' },
          { url: 'binaries/plugins/candidates/vis_w.dll', vfsPath: 'c:\\plugins\\vis_w.dll' },
          'binaries/demo.mp3',
          'binaries/winamp.ini',
          'binaries/winamp.m3u',
          'binaries/whatsnew.txt',
        ],
        winampDemo: 'C:\\demo.mp3',
        resetIniOnLaunch: ['winamp.ini'],
      },
      winamp291_inst: { exe: 'binaries/installers/winamp291.exe' },
      winamp295_inst: { exe: 'binaries/installers/winamp295.exe' },
      mirc59:     { exe: 'binaries/installers/mirc59.exe' },
      abedemo:    { exe: 'binaries/shareware/abe/ex/AbeDemo.exe', files: [
        'binaries/shareware/abe/ex/GAMEBGN.ddv',
        'binaries/shareware/abe/ex/R1P18P19.ddv',
        'binaries/shareware/abe/ex/R1P19P18.ddv',
        'binaries/shareware/abe/ex/demoopen.ddv',
        'binaries/shareware/abe/ex/c1.lvl',
        'binaries/shareware/abe/ex/r1.lvl',
        'binaries/shareware/abe/ex/s1.lvl',
      ] },
      aoe1:       { exe: 'binaries/shareware/aoe/aoe_ex/Empires.exe', files: aoe1Files, requiredFiles: true, fileConcurrency: 10 },
      // The TTFs each of these three ships are the faces its installer would
      // have put in the Windows font directory; mounted here, they answer by
      // name instead of falling through to the default face.
      aoe2:       { exe: 'binaries/shareware/aoe2/aoe2_ex/EMPIRES2.EXE', files: [
        'binaries/shareware/aoe2/aoe2_ex/language.dll',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/arial.ttf',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/ArialN.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/Georgia.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/Georgiab.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/Georgiai.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/LBLACK.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/LBRITE.TTF',
        'binaries/shareware/aoe2/aoe2_ex/FONTS/LBRITED.TTF',
      ] },
      mcm:        { exe: 'binaries/shareware/mcm/mcm_ex/MCM.EXE', files: [
        'binaries/shareware/mcm/mcm_ex/IMPACT.TTF',
      ] },
      mw3:        { exe: 'binaries/shareware/mw3/ex/Program_Files/mech3demo.exe', files: [
        'binaries/shareware/mw3/ex/Font_Files/arial.ttf',
        'binaries/shareware/mw3/ex/Font_Files/impact.ttf',
        'binaries/shareware/mw3/ex/Font_Files/lucon.ttf',
      ] },
      rct:        { exe: 'binaries/shareware/rct/English/RCT.exe', files: rctFiles, requiredFiles: true, fileConcurrency: 10 },
      dx_ddex1:   { exe: 'binaries/dx-sdk/bin/ddex1.exe', files: dxSdkBinFiles },
      dx_ddex2:   { exe: 'binaries/dx-sdk/bin/ddex2.exe', files: dxSdkBinFiles },
      dx_ddex3:   { exe: 'binaries/dx-sdk/bin/ddex3.exe', files: dxSdkBinFiles },
      dx_ddex4:   { exe: 'binaries/dx-sdk/bin/ddex4.exe', files: dxSdkBinFiles },
      dx_ddex5:   { exe: 'binaries/dx-sdk/bin/ddex5.exe', files: dxSdkBinFiles },
      dx_flip2d:  { exe: 'binaries/dx-sdk/bin/flip2d.exe', files: dxSdkBinFiles },
      dx_palette: { exe: 'binaries/dx-sdk/bin/palette.exe', files: dxSdkBinFiles },
      dx_stretch: { exe: 'binaries/dx-sdk/bin/stretch.exe', files: dxSdkBinFiles },
      dx_donut:   { exe: 'binaries/dx-sdk/bin/donut.exe', files: dxSdkBinFiles },
      dx_donuts:  { exe: 'binaries/dx-sdk/bin/donuts.exe', files: dxSdkBinFiles },
      dx_foxbear: { exe: 'binaries/dx-sdk/foxbear/foxbear.exe', files: ['binaries/dx-sdk/foxbear/foxbear.art'] },
      dx_tunnel:  { exe: 'binaries/dx-sdk/bin/tunnel.exe', files: dxSdkBinFiles },
      dx_twist:   { exe: 'binaries/dx-sdk/bin/twist.exe', files: dxSdkBinFiles },
      dx_boids:   { exe: 'binaries/dx-sdk/bin/boids.exe', files: dxSdkBinFiles },
      dx_globe:   { exe: 'binaries/dx-sdk/bin/globe.exe', files: dxSdkBinFiles },
      dx_bellhop: { exe: 'binaries/dx-sdk/bin/bellhop.exe', files: dxSdkBinFiles },
      dx_viewer:  { exe: 'binaries/dx-sdk/bin/viewer.exe', files: dxSdkBinFiles },
      dx_flip3dtl: { exe: 'binaries/dx-sdk/bin/flip3dtl.exe', files: dxSdkBinFiles },
      dx_wormhole: { exe: 'binaries/dx-sdk/bin/wormhole.exe', files: dxSdkBinFiles },
      scr_architec: { exe: 'binaries/screensavers/ARCHITEC.SCR', args: '/s', files: [
        'binaries/screensavers/ARCHITEC.SCN',
        'binaries/screensavers/AR_MESH.X',
        'binaries/screensavers/AR_TEXTU.GIF',
        'binaries/screensavers/AR_WALLP.GIF',
        'binaries/screensavers/AR_WALLP.PAL',
        'binaries/screensavers/AR_WVLFT.BMP',
        'binaries/screensavers/AR_WVLIN.GIF',
      ] },
      scr_cathy:    { exe: 'binaries/screensavers/CATHY.SCR', args: '/s' },
      scr_cityscap: { exe: 'binaries/screensavers/CITYSCAP.SCR', args: '/s' },
      scr_corbis:   { exe: 'binaries/screensavers/CORBIS.SCR', args: '/s' },
      scr_doonbury: { exe: 'binaries/screensavers/DOONBURY.SCR', args: '/s' },
      scr_fallingl: { exe: 'binaries/screensavers/FALLINGL.SCR', args: '/s' },
      scr_fashion:  { exe: 'binaries/screensavers/FASHION.SCR', args: '/s' },
      scr_foxtrot:  { exe: 'binaries/screensavers/FOXTROT.SCR', args: '/s' },
      scr_ga_saver: { exe: 'binaries/screensavers/GA_SAVER.SCR', args: '/s' },
      scr_geometry: { exe: 'binaries/screensavers/GEOMETRY.SCR', args: '/s' },
      scr_horror:   { exe: 'binaries/screensavers/HORROR.SCR', args: '/s' },
      scr_jazz:     { exe: 'binaries/screensavers/JAZZ.SCR', args: '/s' },
      scr_oasaver:  { exe: 'binaries/screensavers/OASAVER.SCR', args: '/s' },
      scr_peanuts:  { exe: 'binaries/screensavers/PEANUTS.SCR', args: '/s' },
      scr_phodisc:  { exe: 'binaries/screensavers/PHODISC.SCR', args: '/s' },
      scr_rockroll: { exe: 'binaries/screensavers/ROCKROLL.SCR', args: '/s' },
      scr_scifi:    { exe: 'binaries/screensavers/SCIFI.SCR', args: '/s' },
      scr_win98:    { exe: 'binaries/screensavers/WIN98.SCR', args: '/s' },
      scr_wotravel: { exe: 'binaries/screensavers/WOTRAVEL.SCR', args: '/s' },
    };

  function appFileUrl(file) {
    if (!file) return "";
    return typeof file === "string" ? file : (file.url || "");
  }

  const wineApps = { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS, appFileUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = wineApps;
  if (typeof window !== "undefined") window.wineApps = wineApps;
})();
