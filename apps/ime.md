# IME (Input Method Editor)

Win32 subsystem for typing characters that don't fit on a keyboard — primarily CJK (Chinese/Japanese/Korean), but also transliteration for Indic scripts. The user types Latin letters (or phonetic keys), an IME process intercepts them, shows a **composition window** with candidate characters, and only sends the final chosen character to the app as `WM_CHAR`.

## Status: no-op stubs

We don't simulate an IME. There's no composition window, no candidate list, and `WM_KEYDOWN` → `WM_CHAR` goes straight through the normal message pump. Every `Imm*` call is conceptually a no-op.

## Stubbed APIs

| API | Returns | Notes |
|---|---|---|
| `ImmGetContext(hWnd)` | `0` (no IME) | Pair with `ImmReleaseContext` like `GetDC`/`ReleaseDC`. |
| `ImmReleaseContext(hWnd, hIMC)` | `TRUE` | |
| `ImmAssociateContext(hWnd, hIMC)` | `0` (no prev) | Passing `NULL` is the common case — Western games call it at startup to **disable** IME so keypresses go straight through (AoE does this for hotkeys). Returning "no previous context" is honest. |

All three live in `src/09a-handlers.wat` next to `CharUpperA`.

## Why no-op is correct

- AoE-style Western apps call `ImmAssociateContext(hWnd, NULL)` to *turn IME off*. Since our IME is already off, this is a trivial success.
- Apps that call `ImmGetContext` to query composition state get `NULL`, which they interpret as "this window has no IME" — also honest.
- Apps that try to drive an IME programmatically (set candidate lists, read composition strings) would break. No test binary does this.

## When to replace with real impl

Only if we ever run a Japanese/Chinese Win98 app whose *core UX* depends on composing characters — e.g. a CJK word processor or text editor. That would need:

- An `HIMC` object with composition string + candidate list state
- `ImmGetCompositionString{A,W}` + `ImmSetCompositionString{A,W}`
- `WM_IME_STARTCOMPOSITION` / `WM_IME_COMPOSITION` / `WM_IME_ENDCOMPOSITION` dispatch
- A host-side composition UI (DOM overlay or canvas-drawn candidate popup)

Big project. Nobody has asked for it. Leave stubs until a specific binary fails on a non-stubbed Imm call.
