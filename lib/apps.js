// The app registry: what each launchable app is made of — its exe, the DLLs
// it needs beside it, and the data files that have to exist in the VFS before
// it starts (help files, card decks, level data, sound banks).
//
// This lived inside index.html, which meant it was browser-only knowledge: an
// app could be listed with the wrong asset set and nothing headless would
// notice, and test/run.js had no way to say "run what the desktop runs". Both
// hosts read it from here now. Paths are repo-relative and use the top-level
// `binaries` symlink, so they resolve the same from the page and from Node.
//
// An entry may also carry `launchPrefs: ({ screenW, screenH }) => [poke, ...]`
// — the app's own stored settings, pre-set from the size of the screen it is
// about to run on, before it reads them. Each poke is
// `{ key, addr, expected, replacement, label }` and is skipped (with a warning)
// unless `expected` is really there, so it cannot corrupt a differently-built
// binary of the same name. Both hosts apply it right after load_pe; see
// LAUNCH_PREFS in lib/app-profiles.js, which holds the same thing keyed by exe
// name for apps launched by bare `--exe=` with no entry here — RollerCoaster
// Tycoon's resolution byte lives there.

(function () {
  const DESKTOP_APPS = [
      ['notepad',     'Notepad',     '\u{1F4DD}'],
      ['calc',        'Calculator',  '\u{1F9EE}'],
      ['mspaint98',   'Paint',       '\u{1F3A8}'],
      ['wordpad',     'WordPad',        '\u{1F4C4}'],
      ['regedit',     'RegEdit',        '\u{1F9E9}'],
      ['taskman',     'Task Manager',   '\u{1F4CA}'],
      ['sndrec32_98', 'Sound Recorder', '\u{1F399}'],
      ['freecell',    'FreeCell',    '\u{1F0CF}'],
      ['sol',         'Solitaire',   '\u{2660}'],
      ['cruel',       'Cruel',       '\u{1F0A1}'],
      ['golf',        'Golf',        '\u{26F3}'],
      ['pegged',      'Pegged',      '\u{1F3AF}'],
      ['snake',       'Rattler',     '\u{1F40D}'],
      // Rodent's Revenge ships in two builds here and the 16-bit WEP2 original
      // is the one that plays: Game > New Game deals a board with the mouse,
      // the cats and the blocks, arrow keys push a column and the score moves
      // (5 -> 12 over three keys). The Rodent2000 remake (VB6) gets as far as
      // its credits splash with an empty title bar and never deals a board, so
      // it stays off the desktop.
      ['wep16_rodent', "Rodent's Revenge", '\u{1F42D}'],
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
      // Both ship their own freely-copyable demo/shareware data and both are
      // verified running on the deployed site, so they are desktop apps rather
      // than localhost-only candidates.
      ['heroes2_demo', 'Heroes II Demo', '\u{1F3F0}'],
      ['rct',          'RollerCoaster Tycoon', '\u{1F3A2}'],
    ];
    // Local candidates shown in the app selector on localhost networks: apps
    // whose assets exist in this working tree but are not published.
    const LOCAL_CANDIDATE_APPS = [
      ['far_manager_170', 'Far Manager 1.70', '\u{1F5C2}'],
      ['jazz2_demo', 'Jazz Jackrabbit 2 Demo', '\u{1F407}'],
      ['quake2_demo', 'Quake II Demo', '\u{1F680}'],
      ['quake2_demo_installer', 'Quake II Demo Installer', '\u{1F4BF}'],
      ['heroes3_demo', 'Heroes III Demo', '\u{1F3F0}'],
      ['heroes3_demo_installer', 'Heroes III Demo Installer', '\u{1F4BF}'],
      ['diablo2_demo', 'Diablo II Demo', '\u{1F525}'],
      ['diablo2_demo_installer', 'Diablo II Demo Installer', '\u{1F525}'],
      ['halflife_uplink', 'Half-Life: Uplink', '\u{1F52C}'],
      ['halflife_uplink_installer', 'Half-Life: Uplink Installer', '\u{1F52C}'],
      ['deus_ex_demo', 'Deus Ex Demo', '\u{1F576}'],
      ['icewind_dale_demo', 'Icewind Dale Demo', '\u{2744}'],
      ['baldurs_gate_noninteractive_demo',
        "Baldur's Gate Non-interactive Demo", '\u{1F3AC}'],
      ['baldurs_gate_interactive_demo',
        "Baldur's Gate Interactive Demo", '\u{1F409}'],
      ['baldurs_gate_chapters_1_2_demo',
        "Baldur's Gate Chapters I & II", '\u{1F409}'],
    ];

    // Debug-only apps: reachable from the full app list but not the
    // desktop display. Runenlegen and Tile World draw real screens
    // (tools/wep32-compare.js checks them). Liquid War and Hearts need
    // browser LAN wiring end-to-end before player-vs-player works.
    const DEBUG_ONLY_APPS = [
      ['diablo_demo', 'Diablo Demo', '\u{1F525}'],
      ['diablo_shareware', 'Diablo Shareware', '\u{1F525}'],
      ['worms2_demo', 'Worms 2 Demo', '\u{1FAB1}'],
      ['starcraft_shareware', 'StarCraft Shareware', '\u{1F680}'],
      ['fallout_demo', 'Fallout Demo', '\u{2622}'],
      ['total_annihilation_demo', 'Total Annihilation Demo', '\u{1F4A5}'],
      ['caesar3_demo', 'Caesar III Demo', '\u{1F3DB}'],
      ['captain_claw_demo', 'Captain Claw Demo', '\u{1F3F4}'],
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

    const aoe2Root = 'binaries/shareware/aoe2/aoe2_ex/';
    const aoe2CampaignMedia = [
      'backgrd8.SLP', 'backgrd8.pal', 'backgrd8.sin',
      'c8s1_beg.SLP', 'c8s1_beg.mm', 'c8s1_end.SLP', 'c8s1_end.mm',
      'c8s2_beg.SLP', 'c8s2_beg.mm', 'c8s2_end.SLP', 'c8s2_end.mm',
      'c8s3_beg.SLP', 'c8s3_beg.mm', 'c8s3_end.SLP', 'c8s3_end.mm',
      'c8s4_beg.SLP', 'c8s4_beg.mm', 'c8s4_end.SLP', 'c8s4_end.mm',
      'c8s5_beg.SLP', 'c8s5_beg.mm', 'c8s5_end.SLP', 'c8s5_end.mm',
      'c8s6_beg.SLP', 'c8s6_beg.mm', 'c8s6_end.SLP', 'c8s6_end.mm',
      'c8s7_beg.SLP', 'c8s7_beg.mm', 'c8s7_end.SLP', 'c8s7_end.mm',
      'cam8.bln', 'intro.bln', 'intro.mm', 'intro.pal', 'intro.sin',
      'intro.slp', 'introbkg.SLP',
    ].map(name => `campaign/media/${name}`);
    const aoe2CampaignSound = [
      'c8s1.mp3', 'c8s1end.mp3', 'c8s2.mp3', 'c8s2end.mp3',
      'c8s3.mp3', 'c8s3end.mp3', 'c8s4.mp3', 'c8s4end.mp3',
      'c8s5.mp3', 'c8s5end.mp3', 'c8s6.mp3', 'c8s6end.mp3',
      'c8s7.mp3', 'c8s7end.mp3', 'intro.mp3',
    ].map(name => `Sound/campaign/${name}`);
    const aoe2Files = [
      // These are loaded dynamically rather than appearing in the EXE import
      // table. Without them the web host exits cleanly before creating AoE2's
      // main window, even though a local CLI run can find the sibling DLL.
      'EBUEula.dll',
      'EULA.RTF',
      'language.dll',
      'Data/interfac.drs',
      'Data/gamedata.drs',
      'Data/terrain.drs',
      'Data/graphics.drs',
      'Data/sounds.drs',
      'Data/empires2.dat',
      'Data/blendomatic.dat',
      'Data/BlkEdge.Dat',
      'Data/TileEdge.Dat',
      'Data/PatternMasks.dat',
      'Data/FilterMaps.dat',
      'Data/LoQMaps.dat',
      'Data/STemplet.dat',
      'Data/lightMaps.dat',
      'Data/view_icm.dat',
      'Data/shadow.col',
      'FONTS/arial.ttf',
      'FONTS/ArialN.TTF',
      'FONTS/Georgia.TTF',
      'FONTS/Georgiab.TTF',
      'FONTS/Georgiai.TTF',
      'FONTS/LBLACK.TTF',
      'FONTS/LBRITE.TTF',
      'FONTS/LBRITED.TTF',
      // The menu is present without these files, but creating a player then
      // enumerates campaign\\*.cpn and scenario\\*.scn. Mount the complete
      // shipped trial campaign rather than exposing empty gameplay buttons.
      'campaign/cam8.cpn',
      ...aoe2CampaignMedia,
      ...aoe2CampaignSound,
      'Scenario/Trial Coastal Map.scn',
      'Scenario/Trial Multiplayer Coastal Map.scn',
      'Scenario/scenario.inf',
      ...[
        'lost.mid', 'music1.mid', 'music2.mid', 'music3.mid', 'music4.mid',
        'music5.mid', 'music6.mid', 'music7.mid', 'music8.mid', 'open.mid',
        'won.mid',
      ].map(name => `Sound/midi/${name}`),
    ].map(path => aoe2Root + path);

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

    // Installed payload from Epic's original 1.23s shareware package. Keep it
    // localhost-only: the executable is useful as a fast-scrolling 8-bit
    // DirectDraw/Miles regression, but the bundled demo terms have not been
    // cleared for public deployment. Every game resource sits beside the exe.
    const jazz2DemoRoot =
      'test/binaries/candidates/jazz-jackrabbit-2-demo-installer/installed/';
    const jazz2DemoFiles = [
      'animssw.j2a banlist.lst boss2.j2b data.j2d diam2.j2t diamond.j2b',
      'dutch.j2s english.j2s filter.lst flash.j2e french.j2s funkyg.j2b',
      'german.j2s god.j2v godlq.j2v godsnd.j2v home.j2e intro.j2b',
      'intro.j2v introlq.j2v italian.j2s labrat.j2b labrat1n.j2t logo.j2v',
      'logolq.j2v menu.j2b monk.j2e order.j2b prince.j2e psych2.j2t',
      'rescue.j2e share.j2e share1.j2l share1.j2m share2.j2l share2.j2m',
      'share3.j2l share3.j2m sharect2.j2l sharectf.j2l sharetrs.j2l',
      'spanish.j2s uninst.j2',
    ].flatMap(group => group.split(' ')).map(name => jazz2DemoRoot + name);

    // Original demo installers kept as localhost-only compatibility probes.
    // Their payloads have not been extracted or cleared for deployment, so
    // the labels make it explicit that selecting one starts its setup program.
    const localDemoInstallerRoot = 'test/binaries/candidates/';

    // Official Baldur's Gate previews prepared by the pinned local-only
    // candidate-corpus recipes. Preserve their installed directory layout:
    // Infinity resolves KEY/BIF resources through the C:\ aliases in each INI.
    const infinityTreeFiles = (root, names) => names.trim().split(/\s+/).map(name => ({
      url: root + name,
      vfsPath: 'c:\\' + name.replace(/\//g, '\\'),
    }));
    const baldursGateNoninteractiveRoot = localDemoInstallerRoot +
      'baldurs-gate-noninteractive-demo/';
    const baldursGateNoninteractiveFiles = infinityTreeFiles(
      baldursGateNoninteractiveRoot,
      `CHITIN.KEY Chitin.ini Music/sst1.MUS Music/sst1/sst1a.acm
       NID.bif NID2.bif ReadMe.txt`);

    const baldursGateInteractiveRoot = localDemoInstallerRoot +
      'baldurs-gate-interactive-demo/installed-extracted/MinimumData/';
    // The visual/gameplay candidate deliberately omits the optional 37 MB of
    // adaptive-music ACM stems. Everything used by its movies, menus,
    // character creator, scripts, voices and Candlekeep areas is mounted.
    const baldursGateInteractiveFiles = infinityTreeFiles(
      baldursGateInteractiveRoot,
      `Baldur.exe Baldur.ini CD1/Movies/MovieCD1.bif CD1/Movies/Movies.bif
       CD1/data/AREA2600.bif CD1/data/AREA260a.bif CD1/data/AREA2700.bif
       CD1/data/AREA2800.bif CD1/data/CHASound.bif CD1/data/CREAnim.bif
       CD1/data/CRESound.bif CD1/data/NPCSound.bif CD1/data/RndEncnt.bif
       Chitin.key Config.exe Keymap.ini Music/BC1.mus Music/BC2.mus
       Music/BD1.mus Music/BD2.mus Music/BF1.mus Music/BF2.mus Music/BL1.mus
       Music/BL2.mus Music/BP1.mus Music/BP2.mus Music/BW1.mus Music/CDay1.mus
       Music/CDay2.mus Music/CNite.mus Music/Chapter.mus Music/Dream.mus
       Music/Dung1.mus Music/Dung2.mus Music/Dung3.mus Music/FDay.mus
       Music/FNite.mus Music/Fort.mus Music/PDay.mus Music/Pnite.mus
       Music/TDay1.mus Music/TDay2.mus Music/TNite.mus Music/Tav1.mus
       Music/Tav2.mus Music/Tav3.mus Music/Tav4.mus Music/Temple.mus
       Music/Theme.mus Music/chants.mus Scripts/None.bs Scripts/cleric1.bs
       Scripts/cleric2.bs Scripts/cleric3.bs Scripts/cleric4.bs
       Scripts/default.bs Scripts/fighter1.bs Scripts/fighter2.bs
       Scripts/fighter3.bs Scripts/fighter4.bs Scripts/mage1.bs
       Scripts/mage2.bs Scripts/mage3.bs Scripts/mage4.bs Scripts/thief1.bs
       Scripts/thief2.bs Scripts/thief3.bs Scripts/thief4.bs
       Sounds/sndlist.txt data/ARMisc.bif data/Areas.bif data/CHAAnim.bif
       data/Creature.bif data/Default.bif data/Dialog.bif data/Effects.bif
       data/Gui.bif data/Items.bif data/OBJAnim.bif data/SFXSound.bif
       data/Spells.bif data/scripts.bif dialog.tlk luaAuto.cfg
       override/Splash1.bmp override/Splash2.bmp override/Splash3.bmp
       override/Splash4.bmp`);

    const baldursGateChaptersRoot = localDemoInstallerRoot +
      'baldurs-gate-chapters-1-2-demo/installed-extracted/MinimumData/';
    const baldursGateChaptersFiles = infinityTreeFiles(
      baldursGateChaptersRoot,
      `Baldur.exe Baldur.ini Chitin.key Config.exe Keymap.ini
       Override/AutorunVE.BMP Override/StartVE.bmp Override/WorldMap.WMP
       Override/splash1.bmp Override/splash2.bmp Override/splash3.bmp
       Override/splash4.bmp Override/ws2_32a.dll Override/ws2helpa.dll
       cd1/data/AREA2300.bif cd1/data/AREA230A.bif cd1/data/AREA230b.bif
       cd1/data/AREA2600.bif cd1/data/AREA260a.bif cd1/data/AREA2700.bif
       cd1/data/AREA3300.bif cd1/data/AREA330a.bif cd1/data/AREA330b.bif
       cd1/data/AREA330c.bif cd1/data/AREA330d.bif cd1/data/AREA4800.bif
       cd1/data/AREA480X.bif cd1/data/AREA4900.bif cd1/data/AREA490X.bif
       cd1/data/AREA5400.bif cd1/data/AREA540a.bif cd1/data/AREA540b.bif
       cd1/data/AREA540c.bif cd1/data/AREA540d.bif
       cd1/movies/MovieCD1.bif cd1/movies/Movies.bif data/ARMisc.bif
       data/AreasVE.bif data/CHAAnim.bif data/CHASound.bif data/CREAnim.bif
       data/CRESound.bif data/Creature.bif data/Default.bif data/Dialog.bif
       data/Effects.bif data/Gui.bif data/Items.bif data/NPCSound.bif
       data/OBJAnim.bif data/SFXSound.bif data/Spells.bif data/scripts.bif
       dialog.tlk`);

    // These two official demos are deliberately localhost-only: their bundled
    // terms do not grant redistribution. The candidate fetcher prepares the
    // ignored trees below; no proprietary bytes enter a public deployment.
    const deusExDemoRoot = localDemoInstallerRoot + 'deus-ex-demo/';
    const deusExDemoDlls = [
      'Window.dll', 'Core.dll', 'Engine.dll', 'WinDrv.dll', 'SoftDrv.dll',
      'Render.dll', 'Fire.dll', 'IpDrv.dll', 'Extension.dll', 'ConSys.dll',
      'DeusEx.dll', 'DeusExText.dll', 'Galaxy.dll',
    ].map(name => deusExDemoRoot + 'System/' + name);
    // UE1 resolves packages beside the executable at C:\ and its content in
    // sibling directories such as C:\Maps. Keep exactly that installed view.
    const deusExDemoFiles = [
      `ConSys.u Core.int Core.u D3DDrv.int DefUser.ini Default.ini DeusEx.ini
       DeusEx.int DeusEx.u DeusExCharacters.u DeusExConAudioAIBarks.u
       DeusExConAudioMission00.u DeusExConAudioMission01.u DeusExConText.u
       DeusExConversations.u DeusExDeco.u DeusExItems.u DeusExSounds.u
       DeusExText.u DeusExUI.u Engine.int Engine.u Extension.u Fire.u
       Galaxy.int GlideDrv.int IpDrv.int IpDrv.u IpServer.int IpServer.u
       Manifest.ini Manifest.int MeTaLDrv.int OpenGlDrv.ini OpenGlDrv.int
       SGLDrv.int Setup.int SoftDrv.int Startup.int User.ini WinDrv.int
       Window.int license.int`,
    ].flatMap(group => group.trim().split(/\s+/))
      .map(name => deusExDemoRoot + 'System/' + name)
      .concat([
        `Maps/00_Training.dx Maps/00_TrainingCombat.dx
         Maps/00_TrainingFinal.dx Maps/01_NYC_UNATCOHQ.dx
         Maps/01_NYC_UNATCOIsland.dx Maps/DX.dx Maps/DXOnly.dx Maps/Entry.dx
         Help/Logo.bmp Help/LogoSmall.bmp
         Music/Credits_Music.umx Music/LibertyIsland_Music.umx
         Music/Title_Music.umx Music/Training_Music.umx Music/UNATCO_Music.umx
         Sounds/Ambient.uax Sounds/MoverSFX.uax`,
        `Textures/Area51Textures.utx Textures/BatteryPark.utx Textures/BobPage.utx
         Textures/Catacombs.utx Textures/Cmd_Tunnels.utx Textures/Constructor.utx
         Textures/CoreTexBrick.utx Textures/CoreTexCeramic.utx
         Textures/CoreTexConcrete.utx Textures/CoreTexDetail.utx
         Textures/CoreTexFoliage.utx Textures/CoreTexGlass.utx
         Textures/CoreTexMetal.utx Textures/CoreTexMisc.utx
         Textures/CoreTexPaper.utx Textures/CoreTexSky.utx
         Textures/CoreTexStone.utx Textures/CoreTexTextile.utx
         Textures/CoreTexTiles.utx Textures/CoreTexWallObj.utx
         Textures/CoreTexWood.utx Textures/DXFonts.utx Textures/Effects.utx
         Textures/HK_MJ12Lab.utx Textures/InfoPortraits.utx
         Textures/Mobile_Camp.utx Textures/NYCBar.utx Textures/NewYorkCity.utx
         Textures/OceanLab.utx Textures/Palettes.utx Textures/Paris.utx
         Textures/Render.utx Textures/Rocket.utx Textures/Supertanker.utx
         Textures/UNATCO.utx Textures/V_Com_Center.utx`,
      ].flatMap(group => group.trim().split(/\s+/)).map(name => ({
        url: deusExDemoRoot + name,
        vfsPath: 'c:\\' + name.replace(/\//g, '\\'),
      })));

    const icewindDaleDemoRoot = localDemoInstallerRoot +
      'icewind-dale-demo/installed-extracted/Recommended_compressed/';
    const icewindDaleDemoVoiceSets = [
      ['Female_Fighter_1', 'DFF'], ['Female_Fighter_2', 'HeFC'],
      ['Female_Fighter_3', 'HeFF'], ['Female_Mage_1', 'DFC'],
      ['Female_Mage_2', 'EFM'], ['Female_Mage_3', 'GFC'],
      ['Female_Thief_1', 'HaFT'], ['Female_Thief_2', 'HFT'],
      ['Male_Fighter_1', 'DMC'], ['Male_Fighter_2', 'DMF'],
      ['Male_Fighter_3', 'HMF'], ['Male_Mage_1', 'EMM'],
      ['Male_Mage_2', 'GMM'], ['Male_Mage_3', 'GMT'],
      ['Male_Thief_1', 'EMT'], ['Male_Thief_2', 'HeMT'],
    ];
    const icewindDaleDemoVoiceFiles = icewindDaleDemoVoiceSets.flatMap(
      ([directory, prefix]) => Array.from({ length: 40 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0');
        const name = `Sounds/${directory}/${prefix}_${number}.wav`;
        return {
          url: icewindDaleDemoRoot + name,
          vfsPath: 'c:\\' + name.replace(/\//g, '\\'),
        };
      }));
    const icewindDaleDemoOverrideNames = [
      ...[[1, 9], [12, 60], [62, 79], [81, 87]].flatMap(([first, last]) =>
        Array.from({ length: last - first + 1 }, (_, index) =>
          `ARUN_${String(first + index).padStart(2, '0')}.wav`)),
      ...Array.from({ length: 40 }, (_, index) =>
        `EVER_${String(index + 1).padStart(2, '0')}.wav`),
      ...Array.from({ length: 40 }, (_, index) =>
        `HROT_${String(index + 1).padStart(2, '0')}.wav`),
      ...Array.from({ length: 21 }, (_, index) =>
        `IGN_${String(index + 1).padStart(2, '0')}.wav`),
      `NARR_CH1.WAV NARR_CH2.WAV NARR_CH3.WAV NARR_PL.WAV`,
    ].flatMap(group => typeof group === 'string' ? group.trim().split(/\s+/) : group);
    const icewindDaleDemoOverrideFiles = icewindDaleDemoOverrideNames.map(name => ({
      url: icewindDaleDemoRoot + 'Override/' + name,
      vfsPath: 'c:\\override\\' + name,
    }));
    const icewindDaleDemoCdFiles = [
      `AR100A.cbf AR100B.cbf AR100C.cbf AR100D.cbf AR120X.cbf
       AR2000.cbf AR200A.cbf AR200B.cbf AR210A.cbf AR210B.cbf AR210C.cbf
       AR210D.cbf AR3000.cbf AR3001.cbf AR3101.cbf AR3201.cbf AR3301.cbf
       AR3401.cbf AR3501.cbf AR3502.cbf AR3503.cbf CREmani.cbf CREmaru.cbf
       CREmgve.cbf MVEfile1.bif MVEfile2.bif IWDCD.2`,
    ].flatMap(group => group.trim().split(/\s+/)).map(name => ({
      url: icewindDaleDemoRoot + 'Data/' + name,
      // The portable demo uses both CD2 layouts depending on which resource
      // path is being resolved. Keep C: for the merged local install and both
      // authentic D: aliases for the CD check/resource loader.
      vfsPaths: [
        'c:\\data\\' + name,
        'd:\\data\\' + name,
        'd:\\cd2\\data\\' + name,
      ],
    }));
    const icewindDaleDemoFullFiles = [
      `AR100A.bif AR100B.bif AR100C.bif AR100D.bif AR120X.bif
       AR2000.bif AR200A.bif AR200B.bif AR210A.bif AR210B.bif AR210C.bif
       AR210D.bif AR3000.bif AR3001.bif AR3101.bif AR3201.bif AR3301.bif
       AR3401.bif AR3501.bif AR3502.bif AR3503.bif CREmani.bif CREmaru.bif
       CREmgve.bif`,
    ].flatMap(group => group.trim().split(/\s+/)).map(name => ({
      url: icewindDaleDemoRoot + 'Full/Data/' + name,
      vfsPath: 'c:\\data\\' + name,
    }));
    // Create Game makes Infinity's installed-resource pass open every archive
    // whose CHITIN.KEY location is HD0 (bit 0), even when character generation
    // has not requested a resource from it yet. Omitting the first non-menu
    // archive (BCSgen.bif) produces ChDimm.cpp:817 / "Media Removed From Drive"
    // after the DirectPlay session opens. Keep all 34 location=1 archives that
    // exist in the Recommended install; location=9 CD-area and movie archives
    // remain out of this local browser route until gameplay asks for them.
    const icewindDaleDemoFiles = [
      'Dialog.tlk', 'icewind.ini', 'Keymap.ini', 'Language.ini',
    ].map(name => icewindDaleDemoRoot + name).concat([
      { url: icewindDaleDemoRoot + 'CHITIN-full.KEY', vfsPath: 'c:\\CHITIN.KEY' },
    ], [
      // Character generation enumerates C:\Sounds after Appearance.
      `Sounds/sndlist.txt`,
      `Data/SPLbmp.bif Data/ITMfile.bif Data/BCSgen.bif Data/CREfile.bif
       Data/DLGfile.bif Data/ARfile.bif Data/ARTport.bif Data/DEFAULT.bif
       Data/CREanim.bif Data/GUIbam.bif Data/GUIchui.bif Data/GUIdesc.bif
       Data/GUIfont.bif Data/GUIicon.bif Data/GUImos.bif Data/AR2100.bif
       Data/STOfiles.bif Data/SPLbam.bif Data/BCSeh.bif Data/BCSkp.bif
       Data/SNDgen.bif Data/AR1000.bif Data/SPLfile.bif Data/CHRanim.bif
       Data/ITMbam.bif Data/ITMinv.bif Data/GUImisc.bif Data/BAMmisc.bif
       Data/BCSku.bif Data/BCSvs.bif Data/BCScv.bif Data/SNDcreat.bif
       Data/MVEfileL.bif Data/SNDspell.bif`,
    ].flatMap(group => group.trim().split(/\s+/)).map(name => ({
      url: icewindDaleDemoRoot + name,
      vfsPath: 'c:\\' + name.replace(/\//g, '\\'),
    }))).concat(icewindDaleDemoVoiceFiles, icewindDaleDemoOverrideFiles,
      icewindDaleDemoCdFiles,
      icewindDaleDemoFullFiles);

    // Payload produced by the original Half-Life Uplink InstallShield setup.
    // The launcher opens everything relative to C:\ and loads its renderer and
    // game DLLs by name after boot, so keep the installed layout intact.
    const halfLifeUplinkRoot = localDemoInstallerRoot +
      'half-life-uplink-installer/installed/';
    const halfLifeUplinkDlls = [
      'hw.dll', 'sw.dll', 'hl_res.dll', 'a3dapi.dll',
      'valve/dlls/hl.dll', 'valve/cl_dlls/client.dll',
    ].map(name => halfLifeUplinkRoot + name);
    const halfLifeUplinkFiles = [
      `hldemo.dat logo.bmp readme.txt valve.ico
       media/intro.avi media/uplink.avi
       media/launch_deny1.wav media/launch_deny2.wav
       media/launch_dnmenu1.wav media/launch_glow1.wav
       media/launch_select1.wav media/launch_select2.wav media/launch_upmenu1.wav`,
      `valve/pak0.pak valve/cached.wad valve/decals.wad valve/gfx.wad
       valve/dlls/hl.dll valve/cl_dlls/client.dll
       valve/credits.txt valve/default.cfg valve/language.cfg valve/liblist.gam
       valve/settings.scr valve/skill.cfg valve/titles.txt valve/valve.rc`,
      `media/order/default.html media/order/default.ico
       media/order/images/arrow.gif media/order/images/box.gif
       media/order/images/box_small.gif media/order/images/bridge.gif
       media/order/images/cgw.gif media/order/images/creature.jpg
       media/order/images/e3award.jpg media/order/images/experience.gif
       media/order/images/gordon.gif media/order/images/gordon_tall.gif
       media/order/images/gordonclose.gif media/order/images/goty.gif
       media/order/images/grayblur.jpg media/order/images/grayblur2.jpg
       media/order/images/halflife.gif media/order/images/hgrunts.jpg
       media/order/images/multiplayer.jpg media/order/images/orangeblur.jpg
       media/order/images/orangeblur2.jpg media/order/images/orangeblurdark.jpg
       media/order/images/redblur.jpg media/order/images/screen1.jpg
       media/order/images/screenstrip.jpg media/order/images/sniper.gif
       media/order/images/solds.gif media/order/images/stars.gif
       media/order/images/surface.jpg media/order/images/usa_today.gif
       media/order/images/weapon.jpg media/order/images/worldcraft.jpg
       media/order/images/xen.jpg`,
    ].flatMap(group => group.trim().split(/\s+/)).map(name => ({
      url: halfLifeUplinkRoot + name,
      vfsPath: 'c:\\' + name.toLowerCase().replace(/\//g, '\\'),
    })).concat([{
      // valve.rc comments out its default.cfg line but always executes
      // autoexec.cfg. The extracted first-run payload has no autoexec, so
      // seed it with the installer's complete keyboard defaults.
      url: halfLifeUplinkRoot + 'valve/default.cfg',
      vfsPath: 'c:\\valve\\autoexec.cfg',
    }]);

    // Quake II's official self-extractor is also a ZIP, so local setup can
    // expose the actual software-rendered game instead of its blocked stub.
    const quake2DemoRoot = localDemoInstallerRoot +
      'quake-2-demo-installer/installed-extracted/Install/Data/';
    const quake2GameDll = quake2DemoRoot + 'baseq2/gamex86.dll';
    const quake2RefSoft = quake2DemoRoot + 'ref_soft.dll';
    const quake2RefGl = quake2DemoRoot + 'ref_gl.dll';
    const quake2DemoFiles = [
      {
        url: quake2GameDll,
        vfsPaths: ['c:\\baseq2\\gamex86.dll', 'c:\\gamex86.dll'],
      },
      { url: quake2DemoRoot + 'baseq2/pak0.pak', vfsPath: 'c:\\baseq2\\pak0.pak' },
      { url: 'lib/quake2-modern-controls.ini', vfsPath: 'c:\\baseq2\\config.cfg' },
      quake2RefSoft,
      quake2RefGl,
    ];

    // The Heroes III InstallShield cabinet can likewise be unpacked without
    // running setup. This demo builds two malformed initial resource paths
    // when no installed AppPath exists, so alias its LODs at those paths too.
    const heroes3DemoRoot = localDemoInstallerRoot +
      'heroes-3-demo-installer/installed-extracted/Program_Files/';
    const heroes3DemoFiles = [
      'BINKW32.DLL', 'MP3DEC.ASI', 'MSS32.DLL', 'SMACKW32.DLL',
    ].map(name => heroes3DemoRoot + name).concat([
      {
        url: heroes3DemoRoot + 'Data/H3BITMAP.LOD',
        vfsPaths: ['c:\\data\\h3bitmap.lod', 'c:\\datah3bitmap.lod'],
      },
      {
        url: heroes3DemoRoot + 'Data/H3SPRITE.LOD',
        vfsPaths: ['c:\\data\\h3sprite.lod', 'c:\\datah3sprite.lod'],
      },
      { url: heroes3DemoRoot + 'Data/HEROES3.SND', vfsPath: 'c:\\data\\heroes3.snd' },
      { url: heroes3DemoRoot + 'Data/VIDEO.VID', vfsPath: 'c:\\data\\video.vid' },
      { url: heroes3DemoRoot + 'Maps/H3demo.h3m', vfsPath: 'c:\\maps\\h3demo.h3m' },
      ...[
        'StrongHold.mp3', 'Surrender Battle.mp3', 'WATER.MP3',
        'Win Scenario.mp3', 'Retreat Battle.mp3', 'UltimateLose.mp3',
        'LoseCombat.mp3', 'Defend Castle.mp3', 'Win Battle.mp3',
        'LoseCastle.mp3', 'MAINMENU.MP3', 'DIRT.MP3', 'COMBAT01.MP3',
        'AITHEME0.MP3',
      ].map(name => ({
        url: heroes3DemoRoot + 'MP3/' + name,
        vfsPath: 'c:\\mp3\\' + name,
      })),
    ]);

    // The outer Heroes III package can only hand off to Setup.exe via a new
    // process, which Wine Assembly intentionally does not spawn. Setup.exe in
    // turn unpacks this real InstallShield engine. Keep that deterministic
    // second-stage engine beside the original Disk1 payload so selecting the
    // installer reaches the same Welcome wizard without crossing either
    // single-process boundary.
    const heroes3InstallerRoot = localDemoInstallerRoot +
      'heroes-3-demo-installer/';
    const heroes3InstallerEngineRoot = heroes3InstallerRoot +
      'installer-engine/';
    const heroes3InstallerDiskRoot = heroes3InstallerRoot +
      'installer-files/Disk1/';
    const heroes3InstallerFiles = [
      '_INST32I.EX_', 'Setup.exe', 'lang.dat', 'DATA.TAG', '_sys1.hdr',
      'setup.ins', '_user1.hdr', 'SETUP.INI', 'setup.lid', 'data1.cab',
      '_Setup.dll', '_sys1.cab', '_ISDel.exe', '_user1.cab', 'data1.hdr',
      'layout.bin', 'os.dat',
    ].map(name => ({
      url: heroes3InstallerDiskRoot + name,
      vfsPath: 'c:\\' + name,
    })).concat([
      heroes3InstallerEngineRoot + 'zdatai51.dll',
      heroes3InstallerEngineRoot + '_wutl951.dll',
    ]);

    // Payload produced by Blizzard's original Diablo II Shareware setup. The
    // EXE dynamically loads the complete renderer/game DLL graph by basename,
    // while the MPQs and locale file are opened from the working directory.
    const diablo2DemoRoot = localDemoInstallerRoot +
      'diablo-2-demo-installer/installed-extracted/';
    const diablo2DemoDlls = [
      'd2cmp.dll', 'd2lang.dll', 'd2net.dll', 'd2sound.dll', 'd2win.dll',
      'd2gfx.dll', 'd2ddraw.dll', 'd2direct3d.dll', 'd2gdi.dll', 'd2glide.dll',
      'binkw32.dll', 'smackw32.dll', 'ijl11.dll', 'storm.dll', 'fog.dll',
    ].map(name => diablo2DemoRoot + name);
    const diablo2DemoFiles = [
      'd2.lng', 'd2char.mpq', 'd2data.mpq', 'd2music.mpq', 'd2sfx.mpq',
      'd2speech.mpq', 'patch_d2.mpq', 'd2readme.htm', 'license.txt',
    ].map(name => diablo2DemoRoot + name);

    // Official Diablo pre-release demo. DIABDEMO.EXE and STORM.DLL are the
    // payload extracted by Blizzard's self-extracting DIABLO.EXE. Storm then
    // reopens that original package as Z:\DIABLO.EXE to read the demo's MPQ
    // data, matching the layout used by the focused CLI compatibility run.
    const diabloCandidateRoot = 'test/binaries/candidates/diablo/';
    const diabloArchive = diabloCandidateRoot + 'DIABLO.EXE';

    // Retail-era Diablo Shareware installed by the CD's original AUTORUN.EXE
    // inside Wine Assembly. Keep this separate from BLIZDEMO.EXE on the same
    // disc: that executable is Blizzard's promotional reel, not the game.
    const diabloSharewareRoot =
      'test/binaries/candidates/diablo-shareware/installed/';

    // Files produced by the original StarCraft Shareware installer. Keep the
    // installed payload separate from the raw CD image. The shareware build
    // still checks/reads the CD's Install.exe at runtime, so that one original
    // disc file remains part of the launch manifest.
    const starcraftInstalledRoot =
      'test/binaries/candidates/starcraft-shareware/installed/';
    const starcraftInstallDir = 'c:\\program files\\starcraft shareware\\';
    const starcraftFile = name => ({
      url: starcraftInstalledRoot + name,
      // The native-install compatibility run mounted its working files at the
      // drive root. Also expose their real installed locations so registry-
      // derived paths and relative opens both resolve without copying bytes.
      vfsPaths: ['c:\\' + name, starcraftInstallDir + name],
    });

    // The official Fallout demo distribution is already its installed form:
    // its readme directs users to unzip it with directory names preserved.
    const falloutDemoRoot = 'test/binaries/candidates/fallout-demo/falldemo/';

    // Payload installed by the original October 1997 Worms 2 demo setup.
    // WORMS2DEMO.EXE is only a promotional screen carousel which eventually
    // calls CreateProcessA("worms2.dat"). The latter is the untouched native
    // game PE, so launch it directly in the browser's one-process sandbox.
    const worms2DemoRoot =
      'test/binaries/candidates/worms-2-demo/installed-10oct/';
    const worms2EffectNames = `
      airstrike bananaimpact baseballbatimpact baseballbatrelease blowtorch
      communicator cowmoo crateimpact crossimpact crowdpart1 crowdpart2
      cursorselect dragonballimpact dragonballrelease drill drillimpact
      explosion1 explosion2 explosion3 firepunchimpact fuse girderimpact
      grenadeimpact handgunfire holydonkey holygrenade kamikazerelease keyclick
      keyerase magicbullet minearm minedud mineimpact minetick minigunfire
      ninjaropefire ninjaropeimpact nukeanthem nukepart1 nukepart2 oldwoman
      pausetick petrol ricochet rocketpowerup rocketrelease salvationarmy
      sheepbaa shotgunfire shotgunreload sizzle snotplop splash splish
      suddendeath teambounce teamdrop teleport throwpowerup throwrelease
      timertick twang1 twang2 twang3 twang4 twang5 twang6 uzifire warningbeep
      weaponhoming wormburned wormdiepart1 wormdiepart2 wormdiepart3
      wormdiepart4 wormdiepart5 wormimpact wormpop wormselect wormspring
      wormwalk1 wormwalk2
    `.trim().split(/\s+/);
    const worms2SpeechNames = `
      amazing boring brilliant bummer bungee byebye collect comeonthen coward
      dragonpunch drop excellent fatality fire fireball firstblood flawless
      goaway grenade hello hmm hurry illgetyou incoming jump1 jump2 justyouwait
      kamikaze laugh leavemealone missed nooo ohdear oinutter ooff1 ooff2
      ooff3 oops orders ouch ow1 ow2 ow3 perfect revenge runaway stupid surf
      takecover traitor uh-oh victory watchthis whatthe whoops wobble yessir
      youllregretthat
    `.trim().split(/\s+/);
    const worms2DemoFiles = [
      'controls.txt', 'guide.txt', 'readme.txt',
      'data/gfx/gfx.dir', 'data/land.dat',
      'data/level/medieval/level.dir',
      'data/water/blue/colour.txt', 'data/water/blue/water.dir',
      ...worms2EffectNames.map(name => `data/wav/effects/${name}.wav`),
      ...worms2SpeechNames.map(name => `data/wav/speech/${name}.wav`),
    ].map(name => ({
      url: worms2DemoRoot + name,
      vfsPath: 'c:\\' + name.toLowerCase().replace(/\//g, '\\'),
    }));

    // The official Heroes II demo is a ready-to-run archive. Preserve its
    // directory layout: the game opens the aggregate and scenario through
    // C:\\DATA and C:\\MAPS after switching its working directory to C:\\.
    const heroes2DemoRoot = 'test/binaries/candidates/heroes-2-demo/files/';
    const heroes2DemoFiles = [
      'MSS32.DLL', 'SMACKW32.DLL',
      'DATA/CAMPAIGN.HS', 'DATA/H2OFFER.SMK', 'DATA/HEROES2.AGG',
      'DATA/STANDARD.HS', 'GAMES/TUTORIAL.GM1',
      'HELP/HEROES2.CNT', 'HELP/HEROES2.HLP', 'MAPS/BROKENA.MP2',
      'FILE_ID.DIZ', 'README.TXT', 'license.txt',
    ].map(name => ({
      url: heroes2DemoRoot + name,
      vfsPath: 'c:\\' + name.toLowerCase().replace(/\//g, '\\'),
    }));

    // Payload produced by the original Total Annihilation demo self-extractor.
    // Use the validated nested copy: installed/TADemo.exe is the known all-zero
    // extraction artifact, while this executable and HPI match the native
    // installer's ADD resources and run together from the drive root.
    const totalAnnihilationDemoRoot =
      'test/binaries/candidates/total-annihilation-demo/installed-fixed/cavedog/totala/demo/';

    // Payload produced by the Caesar III demo's original ZipMagic wrapper,
    // Win16 bootstrap, and native InstallShield engine. Keep the game files at
    // C:\ because this build changes its current directory there and opens all
    // of its installed assets by relative name.
    const caesar3DemoRoot =
      'test/binaries/candidates/caesar-3-demo/installed/';
    const caesar3DemoCoreNames = [
      'bigpeople.555', 'Briefing1a.555', 'C3_mm.eng', 'c3_model.txt',
      'C3.555', 'c3.emp', 'c3.eng', 'c3.inf', 'c3.sg2', 'c3map.inf',
      'C3title.555', 'Caesar3.ini', 'carthage.555', 'carthage.sg2',
      'Demo1.555', 'Demo2.555', 'Demo3.555', 'language.inf',
      'Map_panels.555', 'mission1.pak', 'panelwindows.555',
      'Picture0.555', 'Picture1.555', 'Picture2.555', 'Picture3.555',
      'Picture4.555', 'Picture5.555', 'rclick wavs.txt', 'Readme.doc',
      'readme.txt', 'scoreb.555', 'Senate.555', 'Sierra.inf', 'status.txt',
      'The_empire.555', 'title.555',
    ];
    const caesar3DemoWavNames = `
      academy ampitheatre barber Baths Build1 burning_ruin char_pit clay
      Colloseum dock1 dock2 empty_land explo1 fanfare fanfare2 fort1 forum
      Fountain1 Fountain2 furniture_workshop gardens1 gardens2 gardens3
      gardens4 glad_pit glad_pit2 Granary granary1 granary2 Hippodrome hospital
      house_mid1 house_mid2 house_mid3 house_poor1 house_poor2 house_poor3
      house_poor4 house_slum1 house_slum2 house_slum3 house_slum4 Icon1 library
      lion_pit market1 market2 market3 market4 meat_farm mine Oracle PANEL1
      PANEL2 panel3 Park Plebs pottery_workshop Pupils_starv2 Resevoir
      Rioter_exact1 Rioter_exact2 Rioter_exact3 rome1 School Setup shipyard1
      shipyard2 Theatre timber warehouse1 warehouse2 weapons_workshop wharf1
      wheat wine_workshop
    `.trim().split(/\s+/).map(name => `Wavs/${name}.wav`);
    const caesar3DemoFiles = [
      ...caesar3DemoCoreNames,
      ...caesar3DemoWavNames,
    ].map(name => ({
      url: caesar3DemoRoot + name,
      vfsPath: 'c:\\' + name.toLowerCase().replace(/\//g, '\\'),
    }));

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
      // Mount each one where the game looks for it. A bare string mounts at
      // c:\<basename>, and Liquid War opens "data\lw.dat" by that relative
      // path from c:\ — so the datafile with every sprite in it was simply
      // not there. Allegro's failure to load it is silent: the window thread
      // parks in its own loop and the main thread sits in
      // WaitForSingleObject on that thread's handle forever, which is what
      // "no window in the browser" was. The custom/ trees are enumerated with
      // FindFirstFile("custom\map\*.*"), so they need their directories too.
    ].map(name => ({ url: liquidWarRoot + name, vfsPath: name.replace(/\//g, '\\') }));

    // Far's trial license permits redistributing only its complete, unmodified
    // package. The ignored corpus fixture supplies the executable and the four
    // language/help companions it opens beside itself; do not materialize a
    // separately extracted icon in the tracked web assets.
    const farManager170Root =
      'test/binaries/candidates/far-manager-170/FarManager170/';
    const farManager170Files = [
      'FarEng.hlf', 'FarEng.lng', 'FarRus.hlf', 'FarRus.lng',
    ].map(name => farManager170Root + name);

    // A guest reaches its help file only through the VFS, and the CLI harness
    // has a fallback that silently resolves any name against binaries/help.
    // The browser has no such fallback, so each app must mount its own .hlp
    // (and .cnt, which drives the Help Topics contents tree).
    const helpFiles = name => [`binaries/help/${name}.hlp`, `binaries/help/${name}.cnt`];
    const screenSaverFiles = names => names.map(name => `binaries/screensavers/${name}`);
    const plus98ThemeFrames = (prefix, count, theme) => Array.from({ length: count }, (_, index) => {
      const filename = `${prefix}${String(index + 1).padStart(2, '0')}.JPG`;
      return {
        url: `binaries/screensavers/${filename}`,
        decodeImage: true,
        vfsPaths: [
          `c:\\${filename}`,
          `c:\\program files\\plus!\\themes\\${theme}\\${filename}`,
        ],
      };
    });
    const organicArtSceneFiles = screenSaverFiles([
      'CA_2001.SCN', 'CA_ATOMI.SCN', 'CA_BIOTA.SCN', 'CA_CAVPO.SCN',
      'CA_CHRLA.SCN', 'CA_CHROM.SCN', 'CA_DEMIT.SCN', 'CA_DIAGR.SCN',
      'CA_DRAGO.SCN', 'CA_ENCOM.SCN', 'CA_GOLDS.SCN', 'CA_GREEN.SCN',
      'CA_K-TAL.SCN', 'CA_K-TW3.SCN', 'CA_LIGHT.SCN', 'CA_LOVBU.SCN',
      'CA_PEBBL.SCN', 'CA_RINGT.SCN', 'CA_SCULP.SCN', 'CA_SINGL.SCN',
      'CA_SKYDA.SCN', 'CA_SKYLA.SCN', 'CA_SQUGG.SCN', 'CA_STAIN.SCN',
      'CA_T-O-A.SCN',
      '2001.X', 'ALIEN.X', 'BOLD6.GIF', 'BONE.GIF', 'BWROOM.GIF',
      'CAT01.GIF', 'CLAW.X', 'CLOUDS.GIF', 'COMPASS.X', 'COMPLEX.X',
      'COMTOR.X', 'CRAFT.X', 'CREATURE.GIF', 'FLARE.GIF', 'GAGWHIYE.GIF',
      'GRAD02.GIF', 'GRAD05.GIF', 'GRAD06.GIF', 'GRAD11.GIF',
      'GRADBACK.GIF', 'GRADBLU2.GIF', 'GRADMELN.GIF', 'GRAD_K2.GIF',
      'GRANITE.GIF', 'GRAPPLE.X', 'GRDDKPRP.GIF', 'GRDINTAN.GIF',
      'GRDMELON.GIF', 'GRDYLRED.GIF', 'GROTTO02.GIF', 'IO-HALF.X',
      'JESTER.X', 'JESTER76.X', 'LAND4.X', 'LIMEFLW.GIF', 'LSPH16.X',
      'LSPH8.X', 'MESS.X', 'OCTAHEDR.X', 'ORANLEAF.GIF', 'P6DIE.GIF',
      'PEBBLE.X', 'PINCER.X', 'PODULE.X', 'RMSUNBG.GIF', 'RMSUNSET.GIF',
      'SKY.GIF', 'SPHERE0.X', 'SPOT_BR.GIF', 'SPOT_YBL.GIF', 'SQUIRL.X',
      'STARSCAP.GIF', 'STELLA.X', 'TORBALL.X', 'TWISTPUR.GIF',
      'VOPCONTI.GIF', 'VOPSTAIN.GIF', 'WINGS.X', 'YELOFTHR.GIF',
    ]);

    const mw3DatabaseFiles = [
      'zbd/interp.zbd', 'zbd/mechlib.zbd', 'zbd/motion.zbd',
      'zbd/reader.zbd', 'zbd/rimage.zbd', 'zbd/rlab.zbd',
      'zbd/rmechtex.zbd', 'zbd/rmechtex16.zbd', 'zbd/rmechtexs.zbd',
      'zbd/soundsM.zbd', 'zbd/c4/anim.zbd', 'zbd/c4/gamez.zbd',
      'zbd/c4/reader.zbd', 'zbd/c4/readeria1.zbd', 'zbd/c4/readeria2.zbd',
      'zbd/c4/readeria3.zbd', 'zbd/c4/readerm1.zbd', 'zbd/c4/readerm2.zbd',
      'zbd/c4/readerm3.zbd', 'zbd/c4/readerm4.zbd', 'zbd/c4/readermp1.zbd',
      'zbd/c4/rtexture.zbd', 'zbd/c4/rtexture2.zbd', 'zbd/c4/rtexture3.zbd',
      'zbd/c4/texture.zbd', 'zbd/c4/texture1.zbd', 'zbd/c4/texture2.zbd',
    ].map(rel => ({
      url: `binaries/shareware/mw3/ex/Database_Files/${rel}`,
      vfsPath: `c:\\${rel.replace(/\//g, '\\')}`,
    }));

    // Motocross Madness trial searches installed scene descriptors separately
    // from the CD media tree. Preserve that split: flattening both to C:\ made
    // basename fallback report Quarry01.scn in both roots, and MCM's duplicate
    // filter removed its sole quarry. The remaining hierarchy is significant
    // too: rider/bike art and terrain are opened below SBIKE, UI and TERAFORM.
    const mcmInstallRoot =
      'c:\\program files\\microsoft games\\motocross madness trial\\';
    const mcmFiles = [
      ['', 'DRIVERDB.BIN DSETUP.DLL DSETUP16.DLL DSETUP32.DLL EULA.TXT IMPACT.TTF KVDD.DLL LANG.DLL README.TXT SETUP.EXE SETUPENU.DLL'],
      ['AUDIO/', 'BIKE.WAV DECEL.WAV FALL01.WAV FALL02.WAV FALL03.WAV FALL04.WAV FALL05.WAV FALL06.WAV IDLE.WAV LAND01.WAV LAUNCH.WAV WRECK01.WAV WRECK02.WAV WRECK03.WAV WRECK04.WAV WRECK05.WAV WRECK06.WAV'],
      ['GEOMETRY/', '0.SLT 1.SLT 2.SLT 3.SLT 4.SLT 5.SLT 6.SLT 7.SLT 8.SLT 9.SLT FINISH01.SLT FIVE.SLT FOUR.SLT ONE.SLT PODIUM.SLT POINTER.SLT THREE.SLT TWO.SLT VISCUE.SLT X.SLT YOUIND.SLT'],
      ['GOODIES/DRIVERS/', '3DMFG.HTM ALTTAB.HTM ATIR.HTM ATIR2.HTM ATIR2U.HTM ATIRP.HTM ATIRPCI.HTM ATIX.HTM CLAB1.HTM CLAB2.HTM DANGER.HTM DIAS.HTM DIAS1.HTM DIAS2.HTM DIAS3.HTM DIAV.HTM FOG.HTM GOMENU.HTM HERC.HTM IDENTIFY.HTM MATRX2.HTM MATRX3.HTM MATRXG.HTM MATRXM.HTM NOT.HTM NVIDIA.HTM NVIDMFG.HTM ORCHID.HTM PARTICLE.HTM PERM2.HTM POWERVR.HTM REAL.HTM S3VIR.HTM SCRIPT.HTM SHADOWS.HTM STBG.HTM STBN.HTM'],
      ['GOODIES/DRIVERS/REG/', 'FOG1.REG FOG2.REG ISPOWER.REG ISPWROFF.REG SORRY.HTM'],
      ['HELP/', 'DRIVERS.HTM HELP.HTM'],
      ['HELP/CONTENTS/GRAPHICS/', 'BULL014.GIF BUTTN019.GIF GAMEPAD.GIF JOYSTK.GIF MOUSE.GIF MUDTILE.GIF STUNTS18.GIF STUNTS96.GIF TRACK2.GIF'],
      ['MAPS/', 'LENS.CMP LENS.TEX OBJECTS.CMP OBJECTS.TEX OVERLAY.CMP OVERLAY.TEX PARTICLE.CMP PARTICLE.TEX UIFX.CMP UIFX.TEX'],
      ['SBIKE/', 'BACKOVER.VUB BARHOP.VUB BARKNL.VUB BBARHOP.VUB BBARKNL.VUB BBIGKHUN.VUB BCROSS01.VUB BCROSS02.VUB BCROSS03.VUB BDBCNCN.VUB BFENDBND.VUB BFISHWRP.VUB BHANDSHK.VUB BHEELCLK.VUB BIGKDUMP.VUB BIGKHUN.VUB BIKE.MCF BIKE.SLT BIKE.VUT BLOOKBCK.VUB BLUBKRID.CMP BLUBKRID.TEX BNACNAC.VUB BSARNWRP.VUB BSCHIMPF.VUB BSPLITS.VUB BSUPRMAN.VUB BTAILSTD.VUB BTWIST.VUB BXSPLITS.VUB CROSS01.VUB CROSS02.VUB CROSS03.VUB DBCNCN.VUB ENDOVER.VUB FALL01.VUB FALL02.VUB FALL03.VUB FEETHIT.VUB FEETHITL.VUB FENDBND.VUB FISHWRP.VUB GRNBKRID.CMP GRNBKRID.TEX HANDSHK.VUB HBARS45.VUB HEADHIT.VUB HEADHITL.VUB HEELCLK.VUB KAHUNDMP.VUB LAND1.FRC LAND2.FRC LAND3.FRC LEANR01.VUB LEANR02.VUB LEANR03.VUB LEFTHIT.VUB LEFTHITL.VUB LEFTOVER.VUB LOOKBCK.VUB NACNAC.VUB PINWHL.VUB PINWHL2.VUB PINWHL3.VUB REDBKRID.CMP REDBKRID.TEX RIDE01D.VUB RIDE01U.VUB RIDE02D.VUB RIDE02U.VUB RIDE03D.VUB RIDE03U.VUB RIDE04D.VUB RIDE04U.VUB RIDER.MCF RIDER.SLT RIDER.VUT RITEHIT.VUB RITEHITL.VUB RITEOVER.VUB SARNWRP.VUB SCHIMPF.VUB SPLITS.VUB SUPRMAN.VUB TAILSTD.VUB TWIST.VUB VICTORY.VUB WIN01.VUB WIN02.VUB WIN03.VUB WIN04.VUB WIN05.VUB WIN06.VUB WIN07.VUB WIN08.VUB WIN09.VUB WINNER.LST WINNER.MCF WINNER.VUT XSPLITS.VUB YLWBKRID.CMP YLWBKRID.TEX'],
      ['TERAFORM/NATIONAL/', 'DAY31.CUB NATION16.DAT NATION16.SCN NATION16.TGA NATION16.TRN'],
      ['TERAFORM/QUARRIES/', 'CUBE05.CUB QUARRY01.DAT QUARRY01.SCN QUARRY01.TGA QUARRY01.TRN'],
      ['UI/', '1BUTMB.DAT 3BUTEXT.DAT CONTROL.CTL COPY.TGA CURSOR.TGA DIALOG01.DAT DIALOG02.DAT DIALOG03.DAT DIALOG04.DAT DIALOG08.DAT DIALOG11.DAT DIALOG13.DAT DIALOG14.DAT DIALOG15.DAT DIALOG16.DAT DIALOG17.DAT DIALOG19.DAT DIALOG20.DAT DIALOG22.DAT DIALOG23.DAT EVENT.DAT GENERIC.DAT GLOBAL.DAT LOADING.DAT MAIN.DAT OPTIONS.DAT PRESET.CTL SCORES.DAT SINGLE.DAT TEXTMB.DAT UILST.INI USER.DAT WAIT.DAT WAIT.TGA'],
      ['UI/ART/', 'POWER01.TGA POWER02.TGA POWER03.TGA UNAV.TGA'],
      ['UI/ART/16X12/', 'BIKE_01.TGA BIKE_02.TGA BIKE_03.TGA BIKE_04.TGA BIKE_05.TGA BIKE_06.TGA BIKE_07.TGA BIKE_08.TGA BIKE_09.TGA BIKE_10.TGA BIKE_11.TGA BIKE_12.TGA POSE_01A.TGA POSE_02A.TGA POSE_03A.TGA POSE_04A.TGA POSE_05A.TGA POSE_06A.TGA POSE_07A.TGA POSE_08A.TGA POSE_09A.TGA POSE_10A.TGA POSE_11A.TGA POSE_12A.TGA'],
      ['UI/ART/24X18/', 'BIKE_01.TGA BIKE_02.TGA BIKE_03.TGA BIKE_04.TGA BIKE_05.TGA BIKE_06.TGA BIKE_07.TGA BIKE_08.TGA BIKE_09.TGA BIKE_10.TGA BIKE_11.TGA BIKE_12.TGA POSE_01A.TGA POSE_02A.TGA POSE_03A.TGA POSE_04A.TGA POSE_05A.TGA POSE_06A.TGA POSE_07A.TGA POSE_08A.TGA POSE_09A.TGA POSE_10A.TGA POSE_11A.TGA POSE_12A.TGA'],
    ].flatMap(([dir, names]) => names.split(' ').map(name => {
      const relative = (dir + name).replace(/\//g, '\\');
      return {
        url: `binaries/shareware/mcm/mcm_ex/${dir}${name}`,
        vfsPath: /\.SCN$/i.test(name)
          ? mcmInstallRoot + relative
          : 'c:\\' + relative,
      };
    }));

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
      // All 29 Entertainment Pack games. The three recovered last (Rodent's
      // Revenge, Fuji Golf, and Tic Tac Drop) are pinned to Archive.org-primary
      // source hashes in docs/win16-app-sources.md. Re-measure the complete
      // 31-executable corpus with `node tools/wep32-compare.js
      // --dir=test/binaries/wep16` (WEP1/WEP2 each also contain IdleWild).
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
      wep16_rattler:  wep16('WEP2', 'RATTLER', ['FIELD100.DLL'], ['FIELD100', 'WEPUTIL']),
      // VBRUN checks the custom-control DLL through the filesystem before it
      // asks KERNEL to load the module, so FIELD100 is both data and a module.
      wep16_rodent:   wep16('WEP2', 'RODENT', ['FIELD100.DLL'], ['FIELD100', 'WEPUTIL']),
      // Stones loads the screen it is about to play as a module.
      wep16_stones:   wep16('WEP2', 'STONES',
        ['STONE.SAV', 'STONE00.DLL', 'STONE01.DLL', 'STONE02.DLL',
         'STONE03.DLL', 'STONE04.DLL', 'STONEE00.DLL', 'STONEE01.DLL',
         'STONEE02.DLL', 'STONEE03.DLL'],
        ['WEPUTIL', 'STONE00', 'STONE01', 'STONE02', 'STONE03', 'STONE04',
         'STONEE00', 'STONEE01', 'STONEE02', 'STONEE03']),
      wep16_tutstomb: wep16('WEP2', 'TUTSTOMB', [], ['WEPUTIL']),
      wep16_fujigolf: wep16('WEP3', 'FUJIGOLF', ['FUJIGOLF.DAT']),
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
      wep16_gofigure: wep16('WEP4', 'GOFIGURE',
        [...wep4Sounds, 'GAUGE.VBX', 'THREED.VBX', 'CMDIALOG.VBX'],
        ['GAUGE', 'THREED', 'CMDIALOG', 'WEP4UTIL']),
      wep16_jezzball: wep16('WEP4', 'JEZZBALL', wep4Sounds),
      wep16_maxwell:  wep16('WEP4', 'MAXWELL', wep4Sounds),
      // These VBX files are likewise opened before their NE modules load.
      wep16_tictacdp: wep16('WEP4', 'TICTACDP',
        ['TicTacDp.brd', 'CMDIALOG.VBX', 'THREED.VBX'], ['CMDIALOG', 'THREED']),
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
      explorer98: {
        exe: 'binaries/explorer98/explorer.exe',
        // SHDOCVW forwards compatibility-shell entry points through ordinal
        // exports in SHDOC401. Loading the authentic pair is required for its
        // post-SHCreateThread startup check (SHDOC401 ordinal 200) to succeed.
        dlls: [
          'binaries/explorer98/dlls/browseui.dll',
          'binaries/explorer98/dlls/shdoc401.dll',
          'binaries/explorer98/dlls/ole32.dll',
          'binaries/explorer98/dlls/shlwapi.dll',
          'binaries/explorer98/dlls/shdocvw.dll',
          'binaries/explorer98/dlls/shell32.dll',
        ],
        startupRegistry: [
          // Explorer's aggregated desktop/browser object. The Win98
          // BROWSEUI.DLL binary contains this CLSID and both interfaces the
          // shell requests during startup.
          { keyPath: 'HKCR\\CLSID\\{ECD4FC4D-521C-11D0-B792-00A0C90312E1}\\InprocServer32',
            valueName: '', type: 1, data: 'C:\\WINDOWS\\SYSTEM\\BROWSEUI.DLL' },
        ],
      },
      regedit:  { exe: 'binaries/win98-apps/regedit.exe' },
      taskman:  { exe: 'binaries/win98-apps/taskman.exe' },
      // WELCOME.EXE opens welcome.dat before it does anything else and exits
      // when it is not there — it holds the tour's per-topic state. Windows
      // keeps it under the per-user Application Data tree, not next to the
      // exe, so it has to be mounted at that path.
      welcome98: {
        exe: 'binaries/win98-apps/welcome.exe',
        files: [{
          url: 'binaries/win98-apps/welcome.dat',
          vfsPath: 'c:\\windows\\application data\\microsoft\\welcome\\welcome.dat',
        }, {
          // Welcome opens this alongside welcome.dat on startup; without it the
          // OpenFile fails and the greeting plays silently.
          url: 'binaries/win98-apps/welcom98.wav',
          vfsPath: 'c:\\windows\\application data\\microsoft\\welcome\\welcom98.wav',
        }],
      },
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
      far_manager_170: {
        exe: farManager170Root + 'Far.exe',
        files: farManager170Files,
        requiredFiles: true,
        preExtractIcon: false,
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
      deus_ex_demo: {
        exe: deusExDemoRoot + 'System/DeusEx.exe',
        dlls: deusExDemoDlls,
        files: deusExDemoFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        args: '-windowed',
        // Native package initialization and the software viewport both happen
        // before the first top-level frame is useful.
        windowlessGraceMs: 120000,
      },
      icewind_dale_demo: {
        exe: icewindDaleDemoRoot + 'IDDemo.exe',
        files: icewindDaleDemoFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        persistFiles: [
          'c:\\characters\\*.chr', 'c:\\characters\\*.res',
          'c:\\save\\*', 'c:\\mpsave\\*',
        ],
        windowlessGraceMs: 60000,
      },
      baldurs_gate_noninteractive_demo: {
        exe: baldursGateNoninteractiveRoot + 'Baldur.exe',
        files: baldursGateNoninteractiveFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        windowlessGraceMs: 60000,
      },
      baldurs_gate_interactive_demo: {
        exe: baldursGateInteractiveRoot + 'BGDemo.exe',
        files: baldursGateInteractiveFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        persistFiles: [
          'c:\\characters\\*.chr', 'c:\\characters\\*.res',
          'c:\\save\\*', 'c:\\mpsave\\*',
        ],
        windowlessGraceMs: 120000,
      },
      baldurs_gate_chapters_1_2_demo: {
        exe: baldursGateChaptersRoot + 'BGMain.exe',
        files: baldursGateChaptersFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        persistFiles: [
          'c:\\characters\\*.chr', 'c:\\characters\\*.res',
          'c:\\save\\*', 'c:\\mpsave\\*',
        ],
        windowlessGraceMs: 120000,
      },
      jazz2_demo: {
        exe: jazz2DemoRoot + 'jazz2.exe',
        files: jazz2DemoFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        // Skip the long shareware logo video and request the shareware episode
        // directly. Network discovery is irrelevant for the local
        // single-player dropdown and delays startup substantially.
        args: 'Share1.j2l -nonetwork',
      },
      quake2_demo: {
        exe: quake2DemoRoot + 'quake2.exe',
        // Preload both authentic renderer DLLs. The dropdown selects the
        // hardware-accelerated compatibility renderer; ref_soft stays mounted
        // for the Video menu and the dedicated renderer-switch regression.
        dlls: [quake2GameDll, quake2RefSoft, quake2RefGl],
        files: quake2DemoFiles,
        requiredFiles: true,
        // Restore a user's rewritten config over the bundled first-launch
        // WASD/mouse defaults, then persist later in-game control changes.
        persistFiles: ['c:\\baseq2\\config.cfg'],
        // Start at the ordinary game menu through ref_gl. Gameplay tests inject
        // their own map command without changing what a user sees here.
        args: '+set vid_ref gl +menu_main',
      },
      quake2_demo_installer: {
        exe: localDemoInstallerRoot +
          'quake-2-demo-installer/q2-314-demo-x86.exe',
      },
      heroes3_demo: {
        exe: heroes3DemoRoot + 'h3demo.exe',
        dlls: [
          heroes3DemoRoot + 'BINKW32.DLL',
          heroes3DemoRoot + 'MSS32.DLL',
          heroes3DemoRoot + 'SMACKW32.DLL',
        ],
        files: heroes3DemoFiles,
        requiredFiles: true,
      },
      heroes3_demo_installer: {
        exe: heroes3InstallerEngineRoot + '_ins5576._mp',
        dlls: [
          heroes3InstallerEngineRoot + 'zdatai51.dll',
          heroes3InstallerEngineRoot + '_wutl951.dll',
        ],
        files: heroes3InstallerFiles,
        requiredFiles: true,
      },
      diablo2_demo: {
        exe: diablo2DemoRoot + 'diablo ii.exe',
        dlls: diablo2DemoDlls,
        files: diablo2DemoFiles,
        requiredFiles: true,
        fileConcurrency: 10,
      },
      diablo2_demo_installer: {
        exe: localDemoInstallerRoot +
          'diablo-2-demo-installer/DiabloIIDemo.exe',
      },
      halflife_uplink: {
        exe: halfLifeUplinkRoot + 'hldemo.exe',
        dlls: halfLifeUplinkDlls,
        files: halfLifeUplinkFiles,
        requiredFiles: true,
        fileConcurrency: 10,
        startupRegistry: [
          // The demo's first-run OpenGL default is its bundled 3Dfx mini
          // driver. Wine-Assembly exposes the system OpenGL 1.x/WGL bridge,
          // which GoldSrc names "Default" in gldrv\\drvmap.txt.
          { keyPath: 'HKCU\\Software\\Valve\\HLDemo\\Settings',
            valueName: 'EngineGLDriver', type: 1, data: 'Default' },
          { keyPath: 'HKCU\\Software\\Valve\\HLDemo\\Settings',
            valueName: 'EngineType', type: 4, data: 2 },
        ],
        // OpenGL benefits from a larger cooperative quantum; the CPU software
        // renderer must yield more often or map startup blocks Safari's page.
        // GoldSrc can replace either renderer from Video Modes without exit.
        rendererRunSlices: { software: 1000, opengl: 10000 },
        // Uplink performs a lengthy software/OpenGL renderer probe before it
        // creates the Half-Life window.
        windowlessGraceMs: 60000,
      },
      halflife_uplink_installer: {
        exe: localDemoInstallerRoot +
          'half-life-uplink-installer/hluplink.exe',
      },
      diablo_demo: {
        exe: diabloCandidateRoot + 'DIABDEMO.EXE',
        dlls: [diabloCandidateRoot + 'STORM.DLL'],
        // This August 1996 demo predates the later spawn0.sv format. It saves
        // one game as C:\\Save\\Game00.sav plus Level*.sav companions.
        persistFiles: ['c:\\save\\*.sav'],
        // Diablo's loading loop waits for timeSetEvent without pumping the
        // window queue, so the browser host must invoke the existing
        // cooperative callback hook between main-thread slices.
        asyncMultimediaTimer: true,
        files: [
          { url: diabloArchive, vfsPaths: ['c:\\diablo.exe', 'z:\\diablo.exe'] },
          { url: diabloCandidateRoot + 'DIABLO.TXT', vfsPath: 'c:\\diablo.txt' },
        ],
        requiredFiles: true,
      },
      diablo_shareware: {
        exe: diabloSharewareRoot + 'diablo_s.exe',
        dlls: [
          diabloSharewareRoot + 'storm.dll',
          diabloSharewareRoot + 'diabloui.dll',
          diabloSharewareRoot + 'smackw32.dll',
        ],
        files: [
          diabloSharewareRoot + 'spawn.mpq',
          diabloSharewareRoot + 'diablo.ini',
          diabloSharewareRoot + 'battle.snp',
          diabloSharewareRoot + 'standard.snp',
        ],
        asyncMultimediaTimer: true,
        requiredFiles: true,
        fileConcurrency: 4,
      },
      worms2_demo: {
        exe: worms2DemoRoot + 'worms2.dat',
        files: worms2DemoFiles,
        requiredFiles: true,
        fileConcurrency: 12,
      },
      starcraft_shareware: {
        exe: starcraftInstalledRoot + 'starcraft.exe',
        dlls: [
          starcraftInstalledRoot + 'storm.dll',
          starcraftInstalledRoot + 'smackw32.dll',
        ],
        files: [
          { url: starcraftInstalledRoot + 'starcraft.exe',
            vfsPath: starcraftInstallDir + 'starcraft.exe' },
          starcraftFile('stardatsw.mpq'),
          { url: 'test/binaries/candidates/starcraft-shareware/disc/INSTALL.EXE',
            vfsPath: 'c:\\install.exe' },
          starcraftFile('storm.dll'),
          starcraftFile('smackw32.dll'),
          starcraftFile('local.dll'),
          starcraftFile('battle.snp'),
          starcraftFile('standard.snp'),
        ],
        requiredFiles: true,
        // Jump straight into the first Terran mission while leaving Storm's
        // DirectSound mixer enabled. The old `nosound` token was a temporary
        // compatibility shortcut and made the registered app silent.
        args: 'ophelia terran1',
        startupRegistry: [
          { keyPath: 'HKLM\\Software\\Blizzard Entertainment\\Starcraft Shareware',
            valueName: 'InstallPath', type: 1,
            data: 'C:\\Program Files\\Starcraft Shareware' },
          { keyPath: 'HKLM\\Software\\Blizzard Entertainment\\Starcraft Shareware',
            valueName: 'Program', type: 1,
            data: 'C:\\Program Files\\Starcraft Shareware\\Starcraft.exe' },
          { keyPath: 'HKLM\\Software\\Blizzard Entertainment\\Starcraft Shareware',
            valueName: 'StarCD', type: 1, data: 'C' },
        ],
      },
      fallout_demo: {
        exe: falloutDemoRoot + 'Falldemo.exe',
        files: [falloutDemoRoot + 'Falldemo.dat'],
        requiredFiles: true,
      },
      heroes2_demo: {
        exe: heroes2DemoRoot + 'H2DEMOW.EXE',
        dlls: [heroes2DemoRoot + 'MSS32.DLL', heroes2DemoRoot + 'SMACKW32.DLL'],
        files: heroes2DemoFiles,
        requiredFiles: true,
        // Single/multiplayer saves are NAME.GM1 through NAME.GM6 in the
        // working-directory root; campaign saves use NAME.GMC.
        persistFiles: ['c:\\*.gm?', 'c:\\*.gmc'],
        // Use the demo's real Miles and Smacker libraries. Only Red Book CD
        // audio is unavailable because the browser has no mounted game CD.
        args: '/R0',
      },
      total_annihilation_demo: {
        exe: totalAnnihilationDemoRoot + 'tademo.exe',
        files: [{
          url: totalAnnihilationDemoRoot + 'tademo.hpi',
          vfsPath: 'c:\\tademo.hpi',
        }],
        requiredFiles: true,
      },
      // Untouched game payload installed by the official Sierra/Impressions
      // demo's ZipMagic + InstallShield chain. The outer extractor remains in
      // the corpus for installer regressions; the web launcher starts the game.
      caesar3_demo: {
        exe: caesar3DemoRoot + 'c3.exe',
        dlls: [caesar3DemoRoot + 'SMACKW32.DLL'],
        files: caesar3DemoFiles,
        requiredFiles: true,
        fileConcurrency: 12,
      },
      captain_claw_demo: {
        exe: 'test/binaries/candidates/captain-claw-demo/installed/clawdemo.exe',
        dlls: ['test/binaries/candidates/captain-claw-demo/installed/mss32.dll'],
        files: ['test/binaries/candidates/captain-claw-demo/installed/clawdemo.rez'],
        requiredFiles: true,
        startupRegistry: [
          { keyPath: 'HKLM\\Software\\Monolith Productions\\Claw Demo\\1.0',
            valueName: 'Skip Joystick Calibration Test', type: 4, data: 1 },
          { keyPath: 'HKLM\\Software\\Monolith Productions\\Claw Demo\\1.0',
            valueName: 'Skip Title Screen', type: 4, data: 1 },
          { keyPath: 'HKLM\\Software\\Monolith Productions\\Claw Demo\\1.0',
            valueName: 'Skip Logo Movies', type: 4, data: 1 },
        ],
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
      pawn:       {
        exe: 'binaries/wep32-community/Pawn/Pawn.exe',
        // The 3D board loads its own font and piece textures from the exe
        // directory; without them it stops at "File ALPHFONT.TTF not found!".
        files: [
          'binaries/wep32-community/Pawn/ALPHFONT.TTF',
          'binaries/wep32-community/Pawn/pawn.bok',
          'binaries/wep32-community/Pawn/pawn.cfg',
          'binaries/wep32-community/Pawn/Square black.bmp',
          'binaries/wep32-community/Pawn/Square white.bmp',
        ],
      },
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
      jigssawme:  {
        exe: 'binaries/wep32-community/Jigssawme/JigSawedME.exe',
        files: [
          'binaries/wep32-community/Jigssawme/LDMinMax6.ocx',
          'binaries/wep32-community/Jigssawme/piecelock.wav',
        ],
        requiredFiles: true,
        startupRegistry: [
          { keyPath: 'HKCR\\CLSID\\{af3f3434-a691-11d3-a934-00e029417274}\\InprocServer32',
            valueName: '', type: 1, data: 'C:\\LDMinMax6.ocx' },
        ],
      },
      rodent2000: {
        exe: 'binaries/wep32-community/Rodent2000/Rodent2000.exe',
        files: [
          ...['00000', '00001', '00002', '00003', '00004', 'new'].map(level => ({
            url: `binaries/wep32-community/Rodent2000/Levels/${level}.rodent_level`,
            vfsPath: `c:\\levels\\${level}.rodent_level`,
          })),
        ],
        requiredFiles: true,
      },
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
        // A visualizer has to be listed here as well as mounted below:
        // LoadLibraryA resolves a guest path against modules that are already
        // loaded and never opens the VFS, so a plug-in Winamp discovers at
        // runtime comes back as a junk handle unless it was preloaded.
        // MilkDrop is the MMX one that survives the enumeration walk -- 145
        // movq/14 pxor sites in its .text, so it exercises the SIMD path.
        dlls: [
          'binaries/plugins/candidates/vis_w.dll',
          'binaries/plugins/candidates/vis_milk.dll',
          'binaries/plugins/vis_avs.dll',
        ],
        files: [
          // Winamp's Visualization prefs enumerate C:\Plugins\*.DLL when that
          // pane opens. The AVS here is the 2.6.1 that this Winamp's own 2.95
          // installer extracts -- the 2.8 in plugins/candidates is the Winamp 5
          // build, and its enumeration entry point never returns, which takes
          // the whole pane down with it. AVS resolves its own config against
          // the Winamp directory, so vis_avs.dat and the .ape effect library
          // are mounted at the root rather than under plugins.
          { url: 'binaries/plugins/in_mp3.dll', vfsPath: 'c:\\plugins\\in_mp3.dll' },
          { url: 'binaries/plugins/out_wave.dll', vfsPath: 'c:\\plugins\\out_wave.dll' },
          { url: 'binaries/plugins/candidates/vis_w.dll', vfsPath: 'c:\\plugins\\vis_w.dll' },
          { url: 'binaries/plugins/candidates/vis_milk.dll', vfsPath: 'c:\\plugins\\vis_milk.dll' },
          { url: 'binaries/plugins/vis_avs.dll', vfsPath: 'c:\\plugins\\vis_avs.dll' },
          { url: 'binaries/plugins/vis_avs.dat', vfsPath: 'c:\\vis_avs.dat' },
          { url: 'binaries/plugins/avs/fyrewurx.ape', vfsPath: 'c:\\avs\\fyrewurx.ape' },
          'binaries/demo.mp3',
          'binaries/winamp.ini',
          'binaries/winamp.m3u',
          'binaries/whatsnew.txt',
        ],
        winampDemo: 'C:\\demo.mp3',
        resetIniOnLaunch: ['winamp.ini'],
      },
      // Winamp pointed at a tracker module instead of an mp3. Kept separate
      // from `winamp` on purpose: the Visualization prefs pane enumerates
      // C:\Plugins\*.DLL and does not survive a non-visualizer plug-in in that
      // directory, so in_mod.dll cannot join the vis fixture.
      //
      // Not an MMX A/B, despite appearances. in_mod does compute a CPU-feature
      // byte (detector at 0x1000d379, result stored to 0x1001fd98) and does
      // pass it to the mixer factory at 0x1001018d, and --no-mmx does flip it
      // -- 0x01 vs 0x00, checked with --dump. But the mixer it actually runs is
      // the same either way: --handler-hist --handler-hist-thread=3 puts the
      // identical MMX blocks (0x1000d911..0x1000d9b3) on top in both configs,
      // ~19% of the decode thread's dispatches. The byte selects something,
      // just not whether the mix is vectorised.
      winamp_mod: {
        exe: 'binaries/winamp.exe',
        // Preloaded as well as mounted: LoadLibraryA resolves a guest path
        // against already-loaded modules and never opens the VFS.
        dlls: ['binaries/plugins/in_mod.dll'],
        files: [
          { url: 'binaries/plugins/in_mod.dll', vfsPath: 'c:\\plugins\\in_mod.dll' },
          { url: 'binaries/plugins/out_wave.dll', vfsPath: 'c:\\plugins\\out_wave.dll' },
          { url: 'binaries/devhell1.xm', vfsPath: 'c:\\devhell1.xm' },
          'binaries/winamp.ini',
          'binaries/whatsnew.txt',
        ],
        args: 'C:\\devhell1.xm',
        winampDemo: 'C:\\devhell1.xm',
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
      // The .drs archives hold the interface/game graphics, while the trial
      // campaign and scenarios are loose files enumerated only after a player
      // has been created. Keep the registry complete for both web and CLI.
      aoe2:       { exe: 'binaries/shareware/aoe2/aoe2_ex/EMPIRES2.EXE',
        fileConcurrency: 10, files: aoe2Files, requiredFiles: true },
      mcm:        { exe: 'binaries/shareware/mcm/mcm_ex/MCM.EXE', files: mcmFiles, requiredFiles: true, fileConcurrency: 10 },
      mw3:        { exe: 'binaries/shareware/mw3/ex/Program_Files/mech3demo.exe', files: [
        'binaries/shareware/mw3/ex/Font_Files/arial.ttf',
        'binaries/shareware/mw3/ex/Font_Files/impact.ttf',
        'binaries/shareware/mw3/ex/Font_Files/lucon.ttf',
        ...mw3DatabaseFiles,
      ], dlls: [
        // MW3 imports std::_Lockit's constructor/destructor from the VC++ 5
        // runtime shipped by its installer. The browser cannot discover the
        // sibling Shared_DLLs directory the CLI searches, so carry the exact
        // runtime beside the app manifest as an explicit load seed. Its menu
        // captions are resolved through the installer's Mech3Msg resource DLL;
        // preload that too because it is not in the EXE import table.
        'binaries/shareware/mw3/ex/Shared_DLLs/MSVCP50.DLL',
        'binaries/shareware/mw3/ex/Program_Files/Mech3Msg.dll',
      ], requiredFiles: true, fileConcurrency: 10, copySuperops: true },
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
      scr_corbis:   { exe: 'binaries/screensavers/CORBIS.SCR', args: '/s', requiredFiles: true,
        files: plus98ThemeFrames('CP_SCN', 16, 'corbis') },
      scr_doonbury: { exe: 'binaries/screensavers/DOONBURY.SCR', args: '/s' },
      scr_fallingl: { exe: 'binaries/screensavers/FALLINGL.SCR', args: '/s', requiredFiles: true, files: screenSaverFiles([
        'FALLINGL.SCN', 'LEAF.X', 'LEAF1.GIF', 'LEAF2.GIF', 'LEAF2.X', 'LEAVES.GIF',
      ]) },
      scr_fashion:  { exe: 'binaries/screensavers/FASHION.SCR', args: '/s', requiredFiles: true,
        files: plus98ThemeFrames('FA_SCN', 13, 'fashion') },
      scr_foxtrot:  { exe: 'binaries/screensavers/FOXTROT.SCR', args: '/s' },
      scr_ga_saver: { exe: 'binaries/screensavers/GA_SAVER.SCR', args: '/s' },
      scr_geometry: { exe: 'binaries/screensavers/GEOMETRY.SCR', args: '/s', requiredFiles: true, files: screenSaverFiles([
        'GEOMETRY.SCN', 'GE_BACK.GIF', 'GE_MESH1.X', 'GE_MESH2.X',
      ]) },
      scr_horror:   { exe: 'binaries/screensavers/HORROR.SCR', args: '/s', requiredFiles: true,
        files: plus98ThemeFrames('HO_SCR', 15, 'horror') },
      scr_jazz:     { exe: 'binaries/screensavers/JAZZ.SCR', args: '/s', requiredFiles: true, files: screenSaverFiles([
        'JAZZ.SCN', 'JA_NOTE2.X', 'JA_NOTE4.X',
      ]) },
      scr_oasaver:  { exe: 'binaries/screensavers/OASAVER.SCR', args: '/s', requiredFiles: true, files: organicArtSceneFiles },
      scr_peanuts:  { exe: 'binaries/screensavers/PEANUTS.SCR', args: '/s' },
      scr_phodisc:  { exe: 'binaries/screensavers/PHODISC.SCR', args: '/s' },
      scr_rockroll: { exe: 'binaries/screensavers/ROCKROLL.SCR', args: '/s', requiredFiles: true, files: screenSaverFiles([
        'ROCKROLL.SCN', 'RO_GIT.X', 'RO_PICK.X', 'RO_BACK.GIF', 'RO_TEX01.GIF',
        'RO_WVLIN.GIF', 'RO_WALLP.PAL',
      ]) },
      scr_scifi:    { exe: 'binaries/screensavers/SCIFI.SCR', args: '/s', requiredFiles: true, files: screenSaverFiles([
        'SCIFI.SCN', 'SF_BACK.GIF', 'SF_BIRD.GIF', 'SF_PINCE.X',
      ]) },
      scr_win98:    { exe: 'binaries/screensavers/WIN98.SCR', args: '/s' },
      scr_wotravel: { exe: 'binaries/screensavers/WOTRAVEL.SCR', args: '/s', requiredFiles: true,
        files: plus98ThemeFrames('WO_SCN', 14, 'wotravel') },
    };

  function appFileUrl(file) {
    if (!file) return "";
    return typeof file === "string" ? file : (file.url || "");
  }

  const wineApps = { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS, appFileUrl };
  if (typeof module !== "undefined" && module.exports) module.exports = wineApps;
  if (typeof window !== "undefined") window.wineApps = wineApps;
})();
