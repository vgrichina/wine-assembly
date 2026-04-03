# mplay32.exe (Media Player 32) - Win98

**Status:** FAIL
**Crashes on:** wsprintfW
**Batch reached:** 0 (crashes during init)

## Crash Details

The app initializes, creates windows with trackbar/toolbar controls, then calls `wsprintfW` with wide-string format arguments. The wsprintfW handler hits `crash_unimplemented` / `unreachable`.

EIP at crash: `0x010115f5` -- calling wsprintfW via `call edi` where edi holds the wsprintfW thunk address.

Arguments: `wsprintfW(0x02bff3d4, 0x01017f38, 0x01019a60, 0x0101a700)` -- buffer, format string, and 2 string args.

## API Call Sequence (372 calls before crash)

Key APIs called successfully:
- GetModuleHandleA, GetCommandLineA, GetStartupInfoA (process init)
- InitCommonControlsEx, RegisterClassW, CreateWindowExW (UI setup)
- LoadMenuW, LoadAcceleratorsW, LoadStringW x many (resources)
- CreateWindowExW x3 (main window + toolbar + trackbar)
- SendMessageW x many (configuring controls)
- MulDiv, EnableWindow, InvalidateRect
- **wsprintfW** -- CRASH

## What Needs to Be Implemented

`wsprintfW` -- the wide-char variant of wsprintf. The existing `12-wsprintf.wat` likely only implements the ANSI version. Need to add wide-character format string support (%s with wide strings, wide output buffer).

## Difficulty: Medium

The wsprintf implementation already exists for ANSI. wsprintfW needs to handle wide-char (UTF-16LE) format strings and output. Main work is adapting the format parser to read 2-byte characters and write 2-byte output.
