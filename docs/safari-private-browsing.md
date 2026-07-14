# Safari Private Browsing performance

Safari Private Browsing can make Wine-Assembly startup dramatically slower when
its advanced tracking and fingerprinting protections are active. Bricks and
Spider continue executing, but the page can look hung for roughly a minute.

The confirmed workaround is to choose **View → Reload Reducing Privacy
Protections** in Safari for the affected page. A non-private window also avoids
the issue. Apple documents this menu action for sites affected by Private
Browsing protections in the [Safari User Guide](https://support.apple.com/guide/safari/browse-privately-ibrw1069/26.0/mac/26).

## Observed trace

Measured on July 13, 2026 with Safari 26.4 in a real Private Window:

- Wasm tail calls validated successfully.
- `localStorage`, `sessionStorage`, and IndexedDB round trips succeeded.
- Native Bricks returned from launch in 477 ms. Its second 100,000-step Wasm
  slice then blocked the main thread for about 44 seconds before reaching
  message wait and rendering `Bricks I` correctly.
- Forced compatibility dispatch did not solve the slowdown. Bricks used 20
  500-step slices and reached message wait in 55.9 seconds. Heartbeats remained
  observable, but individual slices commonly delayed them by 2–4 seconds.
- Forced compatibility Spider reached slice 30 after 61.2 seconds, with its
  window and a non-empty rendered canvas already present. Normal completion is
  around slice 33; the original 60-second probe timeout ended observation first.

This rules out missing tail-call support and unavailable browser storage.
Disabling tail calls merely divides the long native stall into many smaller
stalls and is slower overall. The behavior is consistent with a WebKit Wasm
warm-up/tiering problem under Private Browsing protections, but the probe cannot
directly inspect WebKit's active execution tier.

## Reproducing

Start the no-cache static server and event collector:

```bash
node tools/safari-private-probe-server.js
```

Then open the printed URL in an actual Safari Private Window:

```text
http://127.0.0.1:8878/safari-private-probe.html
```

Keep the window active. The page tests Bricks and Spider with native tail-call
dispatch and forced compatibility dispatch. It streams environment checks,
phase changes, heartbeats, run-slice counts, EIP, yield reason, window state,
logs, and sampled canvas output to the collector.

SafariDriver is not a substitute for this check: its clean automation window
does not enable the same Private Browsing protections.

## Engineering guidance

- Do not select compatibility dispatch merely because Safari is in a Private
  Window; tail calls still work and compatibility dispatch was slower.
- Treat a silent heartbeat during a native run slice as a synchronous main-loop
  stall, not necessarily a deadlock. Confirm the final EIP and yield reason if
  the call eventually returns.
- If an in-product mitigation is needed, prefer adaptive or conservative native
  run slices so the UI can yield during cold startup. Detecting Private Browsing
  itself is intentionally unreliable.
- Keep **View → Reload Reducing Privacy Protections** as the recommended Safari
  workaround until WebKit's behavior changes.
