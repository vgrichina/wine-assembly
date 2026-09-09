// Per-program machine configuration.
//
// Most of what a program needs from this machine is discovered by measurement:
// shot-sweep.js retries a program with a silent-mode switch, with no sound
// card, with an ULTRASND= variable or with its configurator run first, and
// keeps whichever frame is fuller. Those answers end up on the sweep row and
// travel to the page through programs-index.json.
//
// This file is the other kind: settings that are properties of the MACHINE
// rather than of the run, that cannot be found by trying twice because they
// are not free. There is exactly one so far.
//
// --- where DOS puts the program -------------------------------------------
// On a real machine the load address is whatever is left after the kernel, its
// buffers and every driver CONFIG.SYS loaded. Two machines run the same .EXE
// at two different paragraphs and no program is entitled to an opinion about
// which -- which is precisely why a demo can carry a store through a stale DS
// for thirty years without anyone noticing: on the machine it was written for,
// the byte landed in DOS's own data.
//
// ACME-VIC.EXE is that demo. Its driver install at 110:c4f5 sets DS=0 to save
// three interrupt vectors and calls the EMS probe at 110:c554 without putting
// DS back, so `mov byte [0xc54a], 0` writes linear 0000:C54A. At the default
// load segment that is 110:B44A -- live code -- and it turns `add bx,0x4c`
// into `add bl,al` + `dec sp`, which leaks a byte of SP per iteration until
// the return address is wrong and the demo wanders into a jump table. Above
// paragraph 0xC55 the same store lands below the program and is absorbed, and
// the demo runs: 220 of 256 DAC entries, 1396 INT 67h calls, still animating
// at 150M dispatches.
//
// It is per-program and not a new default because the address is not free.
// Free conventional memory is (ceiling - PSP) * 16, so every paragraph the
// program moves up is 16 bytes it can no longer have, and ACME-BIG.EXE prints
// "This demo requires at least 600k of free base memory!" and exits below
// PSP 0x0900. The two cannot both be served by one number, and a real machine
// does not serve them with one either -- it serves them with a boot floppy.
//
// 0x0D00 is the smallest round PSP that clears the store: LOAD is PSP+0x10 =
// 0x0D10, and the demo's write at 0xC54A needs LOAD > 0xC55.
const PROGRAMS = {
  'acme-vic.exe': { pspSeg: 0x0D00 },
};

// The configuration for a program, by the base name of its executable. Case
// insensitive: the corpus ships the same demo as ACME-VIC.EXE and acme-vic.exe
// in different archives, and the sweep and the page disagree about which.
function programConfig(exe) {
  if (!exe) return null;
  const base = String(exe).replace(/^.*[\\/]/, '').toLowerCase();
  return PROGRAMS[base] || null;
}

module.exports = { PROGRAMS, programConfig };
