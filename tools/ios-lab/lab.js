// Shared instrument for the scroll-collapse lab pages.
//
// The question these pages exist to answer is one number: does
// window.innerHeight ever grow? Safari's toolbars ARE that difference -- when
// they retract the visual viewport gets ~60-90px taller and nothing else on
// the page changes. So every page here shows innerHeight's live min..max in
// the corner, and a max that never exceeds the min is a collapse that never
// happened, whatever the page looked like while swiping.
//
// Everything else on the readout is there to say WHY: document height (did
// the page ever overflow), scrollY and its max (did it ever actually scroll),
// touchmove count (did the gesture reach the page at all).
//
// It also opens a channel back to whoever is watching: tools/ios-eval.js
// posts JS to the server, this polls for it, evaluates it and posts the
// result. There is no debugger into a phone on someone else's desk, and this
// is the substitute.

(() => {
  const PAGE = document.body.dataset.lab || 'lab';
  const state = { maxY: 0, moves: 0, minH: Infinity, maxH: 0, startH: window.innerHeight };

  const readout = document.createElement('div');
  readout.id = 'lab-readout';
  readout.style.cssText =
    'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#000;color:#0f0;' +
    'font:12px/1.45 ui-monospace,Menlo,monospace;padding:4px 6px;text-align:center;' +
    'pointer-events:none;white-space:pre-wrap';
  document.documentElement.appendChild(readout);

  const post = (item) => {
    try {
      fetch('/ios-report', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([item]), keepalive: true,
      }).catch(() => {});
    } catch (_) { /* the page still works with nobody listening */ }
  };

  const line = () => {
    const h = window.innerHeight;
    state.minH = Math.min(state.minH, h);
    state.maxH = Math.max(state.maxH, h);
    state.maxY = Math.max(state.maxY, Math.round(window.scrollY || 0));
    const grew = state.maxH - state.minH;
    return `v${h} range ${state.minH}..${state.maxH} ` +
      (grew >= 24 ? `COLLAPSED +${grew}` : 'bars: unchanged') +
      `\ndoc${document.documentElement.scrollHeight} y${Math.round(window.scrollY || 0)} ` +
      `maxY${state.maxY} moves${state.moves} dpr${window.devicePixelRatio}` +
      // A page can add its own field -- whatever it is testing. It lands in
      // the same line, so the server log says which shape produced a reading.
      (typeof window.LabNote === 'function' ? ' ' + window.LabNote() : '');
  };

  let last = '';
  const paint = () => {
    const now = line();
    readout.textContent = PAGE + '  ' + now;
    if (now !== last) {
      last = now;
      post({ kind: 'lab', page: PAGE, line: now.replace(/\n/g, '  ') });
    }
  };

  addEventListener('scroll', paint, { passive: true, capture: true });
  addEventListener('resize', paint);
  addEventListener('touchmove', () => { state.moves++; }, { passive: true, capture: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', paint);
  setInterval(paint, 400);
  paint();
  post({ kind: 'log', text: `LAB ${PAGE} opened  ${window.innerWidth}x${window.innerHeight} ` +
    `dpr${window.devicePixelRatio}  ${navigator.userAgent}` });

  // The channel. Polling, not a socket: this has to survive a phone locking,
  // a tab going to the background and coming back, and a server restart, and
  // a poll does all three by doing nothing special.
  const pump = async () => {
    try {
      const batch = await (await fetch('/ios-cmd', { cache: 'no-store' })).json();
      for (const command of batch) {
        let ok = true;
        let value;
        try {
          // eslint-disable-next-line no-eval
          value = (0, eval)(command.code);
          if (typeof value === 'object' && value !== null) {
            try { value = JSON.stringify(value); } catch (_) { value = String(value); }
          }
        } catch (error) { ok = false; value = String((error && error.message) || error); }
        post({ kind: 'eval', id: command.id, ok, value: String(value) });
      }
    } catch (_) { /* server down, try again next tick */ }
    setTimeout(pump, 500);
  };
  pump();

  window.Lab = { state, line, post };
})();
