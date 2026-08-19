# EmPipe (Pipe Dream remake) — MIDI implementation design

EmPipe is a community Win32 remake of *Pipe Dream*, shipped in `test/binaries/wep32-community/EmPipe/`. It renders through plain GDI and only uses five WINMM symbols, but the game is effectively silent until MIDI playback works — its entire audio experience is a background score made of eight bundled `.MID` files (`EMPSTART`, `EMPSCR1..5`, `EMPCLEAR`, `EMPGMOV`). Current behavior: the emulator traps on `midiOutGetNumDevs` before the main window is ever shown, because the startup path tests whether a MIDI device exists and aborts when the API is unimplemented.

This document is a design sketch for adding a real (not stub) MIDI subsystem that's sufficient for EmPipe and reusable for other MCI-sequencer apps.

## What EmPipe actually calls

Imports from `WINMM.dll` (from `tools/pe-imports.js`):

| Ordinal | API                  | Role                                                  |
|--------:|----------------------|--------------------------------------------------------|
| —       | `midiOutGetNumDevs`  | Device-presence probe. Return value gates audio init. |
| —       | `waveOutGetNumDevs`  | Same probe, for `sndPlaySound`.                        |
| —       | `sndPlaySoundA`      | One-shot `.wav` player (UI click/confirm sounds).      |
| —       | `mciSendCommandA`    | MCI sequencer: `OPEN`, `PLAY`, `STOP`, `CLOSE`, `STATUS`. |
| —       | `mciGetErrorStringA` | Error→string decoder (used in the error dialog).       |

EmPipe **never touches `midiOut*` directly** for playback. All music goes through the MCI `"sequencer"` device type, which is the high-level MCI wrapper around `midiStream*` that Win9x used to play SMF files. That's important: we do not need to implement a MIDI synthesiser in WAT. We need an MCI sequencer whose backend can be fulfilled by the host (Web Audio in the browser, silent in headless tests).

## Design principles

1. **SMF parsing lives in the host.** MIDI files arrive as guest memory pointers (via MCI_OPEN with `lpstrElementName`). The host reads the bytes, parses the MThd/MTrk chunks, and schedules events. WAT stays thin — it only manages MCI handle lifetime.
2. **Playback is async; timing lives in the host.** MCI apps expect `mciSendCommand(MCI_PLAY)` to return immediately and the track to play in real time. That maps naturally to a host-side timer. WAT never blocks.
3. **Headless is silent, not broken.** In `test/run.js` the host-side MIDI driver is a null backend: handles open/play/close cleanly, returns success, produces no audio. Smoke tests pass because the app sees "device present, playback succeeded."
4. **Browser uses Web Audio, not Web MIDI.** Web MIDI needs a real synth; Web Audio lets us render notes with `OscillatorNode`s or (better) a small SoundFont player. The default backend is a GM-ish sine/triangle polyphonic bank — tinny but adequate for retro game music. A user who wants realism can drop in a SoundFont2 file later.
5. **One abstraction, multiple consumers.** The same host API serves MCI sequencer apps (EmPipe, CD Player, Media Player) *and* future direct `midiOut*` users. The MCI path is just a convenience wrapper over the event stream.

## Memory map additions

```
0x0000AD80  256B  MCI_DEVICES   16 entries × 16 bytes
                                  +0   u32  type      (0=free, 1=sequencer, 2=waveaudio, 3=cdaudio)
                                  +4   u32  host_id   opaque id returned by host_mci_open
                                  +8   u32  state     0=stopped, 1=playing, 2=paused
                                  +12  u32  elt_ptr   guest pointer to lpstrElementName (for STATUS queries)
```

Lives right after the existing `MENU_DATA_TABLE`. 16 concurrent devices is plenty for games that typically keep one open at a time. Slot 0 is reserved so that a zero handle is invalid. MCI device IDs returned to the app are `0x10000 | slot_index` to keep them distinct from hwnds and hmenus.

## Host import surface (lib/host-imports.js)

Five new host functions. All are sync as far as WASM is concerned; the actual playback is decoupled on the host side.

```
host_midi_num_devs() -> u32
  Returns the number of MIDI output devices the host can drive. Browser: 1
  (the built-in Web Audio synth). Node headless: 1 (silent null device, so
  feature detection succeeds). Returns 0 if audio is explicitly disabled
  (e.g. --no-audio flag).

host_wave_num_devs() -> u32
  Same shape. Browser: 1 if AudioContext is available. Node: 1 (silent).

host_snd_play_sound(name_ptr: u32, flags: u32) -> u32
  Reads the guest string, resolves against the virtual filesystem (same
  lookup as CreateFileA), and plays it via a host WAV decoder → AudioBuffer.
  SND_ASYNC fires and returns immediately; SND_SYNC would block but we
  always treat it as async (no app in our test set relies on sync).

host_mci_open(device_type: u32, elt_name_ptr: u32, flags: u32) -> u32
  device_type: 1=sequencer, 2=waveaudio, 3=cdaudio, 0=auto (detect from
  extension). elt_name_ptr is the guest string pointer to the file name.
  Returns a non-zero host_id on success (stored in MCI_DEVICES.host_id),
  0 on failure. Host side: reads bytes via readFile, parses SMF, keeps
  the parsed track list indexed by host_id.

host_mci_command(host_id: u32, command: u32, flags: u32, params_ptr: u32) -> u32
  Dispatches PLAY/STOP/PAUSE/RESUME/SEEK/STATUS/CLOSE against a live
  host_id. Returns 0 on success, non-zero MCIERR_* code on failure. For
  STATUS, reads MCI_STATUS_PARMS from params_ptr (guest addr, g2w-translated)
  and writes dwReturn back to the guest.
```

## WAT handlers

Five new handlers in a new file `src/09a3a-handlers-midi.wat` (keeps audio concerns separate from the existing `09a3-handlers-audio.wat` which already covers `waveOut*`). They are thin — all the work is in the host.

```
midiOutGetNumDevs() -> eax = host_midi_num_devs()
waveOutGetNumDevs() -> eax = host_wave_num_devs()
sndPlaySoundA(pszSound, fuSound) -> eax = host_snd_play_sound(pszSound, fuSound)

mciSendCommandA(mciId, uMsg, fdwCommand, dwParam) -> eax = ...
  Routing table on uMsg:
    MCI_OPEN (0x0803): allocate a MCI_DEVICES slot; read MCI_OPEN_PARMSA
      at dwParam → lpstrDeviceType + lpstrElementName; call host_mci_open;
      on success store host_id + elt_ptr in slot; write slot id back to
      MCI_OPEN_PARMSA.wDeviceID; return MMSYSERR_NOERROR (0).
    MCI_PLAY/STOP/PAUSE/RESUME/SEEK/STATUS/CLOSE (0x0806..0x080D): look up
      slot from mciId, forward to host_mci_command, return its result.
      On MCI_CLOSE also free the slot.
    Anything else (MCI_INFO, MCI_SYSINFO, ...): return MCIERR_UNSUPPORTED
      (277). EmPipe never takes that path.

mciGetErrorStringA(err, buf, len) -> eax = ...
  Lookup table of the 30-odd MCIERR_* codes EmPipe can produce; memcpy
  the matching ASCII string into the guest buffer (truncated to len-1);
  return 1 on success, 0 on bad code.
```

## Host backends

### Headless (Node test runner)

`lib/midi-null.js`:
```
class NullMidiBackend {
  num_devs() { return 1; }                    // feature-detect OK
  open(type, eltName) {
    this.id = (this.id || 0) + 1;
    return this.id;                           // non-zero, no parsing
  }
  command(id, cmd) { return 0; }              // everything succeeds
  close(id) {}
}
```
Passes smoke tests; makes no sound; uses no resources. This is the default in `test/run.js`.

### Browser (Web Audio)

`lib/midi-webaudio.js` — the interesting one. Layers:

1. **SMF parser.** Reads MThd (format, ntrks, division), then merges all MTrk chunks into a single event list sorted by absolute tick. Events we care about: Note On / Note Off, Program Change, Control Change (volume=7, pan=10, sustain=64), Tempo meta (0xFF 0x51), End Of Track. Meta events we ignore: text, marker, key signature, time signature (display-only). SysEx is ignored.
2. **Tick→second conversion.** Division is PPQ (ticks per quarter). Current tempo is microseconds per quarter (default 500000 = 120 BPM). A running accumulator turns ticks into wall-clock seconds as tempo events are consumed.
3. **Scheduler.** On `PLAY`, the backend walks the event list and, for each note-on event, schedules a Web Audio note at `audioCtx.currentTime + eventTimeSec`. Because Web Audio's scheduling is sample-accurate, we don't need our own timer — we enqueue the entire track at once (typical game loop MIDIs are a few KB of events). A `setTimeout` is used only to clear state when the last event fires.
4. **Synth.** Per channel: a small poly voice bank. Each voice is `OscillatorNode` → `GainNode` (ADSR envelope) → master. Default waveform: `triangle` for channels 1–15, `square` for channel 10 (drum channel gets a short noise burst instead). Velocity maps to gain. Program Change is accepted but ignored (all programs use the same voice). This is ~80 lines of JS and sounds distinctly like a 1999 MIDI card — appropriate.
5. **State.** Per host_id: `{ events, currentTime0, activeNodes, state }`. `STOP` cancels all active `OscillatorNode`s via `stop(now)`. `PAUSE` is harder (requires rescheduling on resume); for the MVP PAUSE is a no-op and resume is a no-op, because EmPipe doesn't actually pause.
6. **Looping.** EmPipe's background tracks loop. MCI supports this via `MCI_DGV_PLAY_REPEAT` / `MCI_NOTIFY`, but games usually detect end-of-track via `MCI_STATUS mode` polling and call `PLAY` again. Our `STATUS mode` returns `MCI_MODE_PLAY` while scheduled events remain, then transitions to `MCI_MODE_STOP`. That's enough for the poll-and-replay idiom.

### Browser fallback: SoundFont

The inline synth is ugly. A cleaner second iteration swaps the `OscillatorNode` voices for a SoundFont2 player (e.g. `soundfont-player` or `fluidsynth-wasm`). The SMF parser and scheduler stay identical — only the voice layer changes. Add `ctx.soundfont` option in `host-imports.js`; default to the inline synth if unset.

## MCI command encoding reference

For the WAT side, only a handful of constants are needed:

```
MMSYSERR_NOERROR        0x00000000
MCIERR_INVALID_DEVICE   0x00000106
MCIERR_UNSUPPORTED      0x00000115

MCI_OPEN                0x00000803
MCI_CLOSE               0x00000804
MCI_PLAY                0x00000806
MCI_SEEK                0x00000807
MCI_STOP                0x00000808
MCI_PAUSE               0x00000809
MCI_RESUME              0x00000855
MCI_STATUS              0x00000814

MCI_OPEN_TYPE           0x00002000
MCI_OPEN_ELEMENT        0x00000200
MCI_OPEN_TYPE_ID        0x00001000

MCI_STATUS_ITEM         0x00000100
MCI_STATUS_MODE         0x00000004  ;; item value
MCI_MODE_STOP           525
MCI_MODE_PLAY           526
MCI_MODE_PAUSE          529
```

`MCI_OPEN_PARMSA` layout (that `mciSendCommandA` reads at dwParam for MCI_OPEN):
```
+0  DWORD  dwCallback
+4  DWORD  wDeviceID       (written back by us)
+8  LPSTR  lpstrDeviceType (can be int-id if MCI_OPEN_TYPE_ID set)
+12 LPSTR  lpstrElementName
+16 LPSTR  lpstrAlias
```

## Step-by-step implementation order

1. **Silent backend + WAT handlers + ORDINAL_MAP entries.** Gets EmPipe past its audio-init probe and into the main menu — that alone is a PASS for the smoke test. ~200 lines, all of it mechanical. Verifies the MCI handle plumbing in isolation before we touch audio.
2. **Null MCI_STATUS polling.** The game polls track position to detect end-of-song. Return a fake "still playing" response that flips to "stopped" after a fixed wall-clock time. This is enough for the loop to cycle correctly even without real audio.
3. **Browser SMF parser + scheduler + inline synth.** ~400 lines of JS, added to `lib/midi-webaudio.js`. Wired into `host-imports.js` with a backend selector. Tested by loading EmPipe in the host and listening for any sound at all.
4. **Polish pass.** Fix tempo changes, channel 10 drums, panning, velocity curve.
5. **SoundFont backend (optional).** Only if the inline synth is too grating to ship.

## Non-goals

- **Recording.** No app in our test set records MIDI.
- **MIDI input.** Ditto.
- **SysEx.** Ignored entirely.
- **MIDI ports / routing.** There is always exactly one output device (the synth).
- **Sample-accurate mid-track tempo changes in already-scheduled events.** Hard with Web Audio's pre-scheduled model; noticeable only on tracks that do dramatic tempo ramps. EmPipe's tracks don't.

## Why not implement `midiOut*` directly?

Every API in EmPipe goes through MCI, so `midiOutShortMsg` / `midiOutLongMsg` never get called. Implementing them now would be speculative work. The MCI sequencer layer lives on top of `midiStream*` anyway, and our "sequencer" backend hand-rolls the scheduling, so there's no parent layer we'd be delegating to. If a later app (e.g. a demoscene tracker) uses `midiOut*` directly, it gets its own handler that routes note-on/note-off events into the same host synth — they share the voice bank, not the MCI state machine.
