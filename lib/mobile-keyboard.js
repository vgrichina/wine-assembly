// Keeping the guest visible when a phone's on-screen keyboard opens.
//
// The keyboard does not resize the page. `body { height: 100vh }` is measured
// against the *large* viewport, so the layout keeps its full height and the
// browser simply shows a shorter window into it -- and `body { overflow:
// hidden }` means nothing scrolls it back. In single-app mode the guest screen
// fills that whole layout, so the bottom third of a maximized Win98 app, and
// any dialog the app centred in it, ends up behind the keyboard with no way to
// reach it.
//
// Two rules follow, and they pull in opposite directions:
//
//  1. The guest screen must NOT change size. A keyboard opening is not a
//     display-mode change: resizing the backing store would send WM_SIZE to
//     the app, relayout every control, and re-centre every centred dialog into
//     whatever strip is left -- which is exactly the "centred under the
//     keyboard" failure, made permanent. So the backing size is frozen at its
//     pre-keyboard value for as long as the keyboard is up.
//
//  2. The part being typed into must be visible. With the size frozen, the
//     only remaining lever is *where* that fixed surface sits, so the canvas
//     is translated up by the smallest amount that brings the caret above the
//     keyboard, and never further than the canvas's own bottom edge.
//
// The caret is the anchor because it is the one thing that says where the text
// is going. Without one -- a keyboard opened by something other than an edit
// control -- the shift stays 0: the top of the screen, where the title bar and
// menu are, is a better default than an arbitrary scroll.
//
// The geometry is separated from the DOM so it can be tested without a
// browser: keyboardInset() and canvasShift() are pure.

'use strict';

// How much of the layout viewport the keyboard is covering, in CSS pixels.
//
// `visualViewport` shrinks for the keyboard, browser chrome (a collapsing
// URL bar) and pinch-zoom alike, and only the first should move the guest.
// A threshold separates them: no on-screen keyboard is 120px tall, and no
// address bar is. Returns 0 when nothing keyboard-sized is covering the page,
// which is also what a desktop browser always reports.
function keyboardInset(metrics) {
  const m = metrics || {};
  const layoutHeight = Number(m.layoutHeight) || 0;
  const viewportHeight = Number(m.viewportHeight) || 0;
  const offsetTop = Number(m.viewportOffsetTop) || 0;
  const threshold = m.threshold == null ? 120 : Number(m.threshold);
  if (!layoutHeight || !viewportHeight) return 0;
  // Pinch-zoom shrinks visualViewport too, but it also sets a scale; the page
  // is not being covered, it is being magnified, and moving the guest under
  // the user's fingers would fight the gesture.
  const scale = Number(m.scale) || 1;
  if (scale > 1.05) return 0;
  const hidden = layoutHeight - (viewportHeight + offsetTop);
  return hidden >= threshold ? Math.round(hidden) : 0;
}

// How far to translate the canvas up (positive = move up) so the caret clears
// the keyboard, in CSS pixels.
//
// All inputs are in client coordinates -- the same space getBoundingClientRect
// reports -- with the visible band running from 0 to visibleHeight.
//
//   canvasTop/canvasBottom  where the canvas sits before any shift
//   focus                   {top, bottom} of the caret, or null when there
//                           is no caret to keep in view
//   margin                  breathing room above the keyboard, so the caret
//                           is not flush against it
//
// The result is clamped twice: never negative (the canvas top never drops
// below its resting place) and never past canvasBottom - visibleHeight (the
// canvas bottom never rises above the keyboard, which would open a gap of
// page background below the guest).
function canvasShift(opts) {
  const o = opts || {};
  const inset = Number(o.inset) || 0;
  const visibleHeight = Number(o.visibleHeight) || 0;
  const canvasTop = Number(o.canvasTop) || 0;
  const canvasBottom = Number(o.canvasBottom) || 0;
  const margin = o.margin == null ? 8 : Number(o.margin);
  const focus = o.focus;
  if (inset <= 0 || visibleHeight <= 0) return 0;
  if (!focus) return 0;

  const maxShift = Math.max(0, canvasBottom - visibleHeight);
  if (maxShift <= 0) return 0;

  const focusTop = Number(focus.top) || 0;
  const focusBottom = Number(focus.bottom) || focusTop;
  // Already clear of the keyboard: leave the screen where it is rather than
  // nudging it for every caret move.
  let shift = 0;
  if (focusBottom + margin > visibleHeight) {
    shift = focusBottom + margin - visibleHeight;
  }
  shift = Math.min(shift, maxShift);
  // Revealing the bottom of the caret must not push its top off the screen --
  // on a tall caret, or a visible band shorter than the caret, the top wins.
  shift = Math.min(shift, Math.max(0, focusTop - margin));
  return Math.max(0, Math.round(shift));
}

// Whether the hidden textarea that *is* the on-screen keyboard should hold
// focus right now.
//
// A tap on the canvas used to focus it unconditionally, so Minesweeper and
// Solitaire opened a keyboard the moment they were touched -- half the screen
// gone for an app with nowhere to type. The guest already answers the
// question: Win32 creates a caret when, and only when, something is taking
// text, so `hasCaret` is the whole signal.
//
//   gesture  true when this call is inside a real touch/click handler. iOS
//            only opens the keyboard from a user gesture, so a caret that
//            appears later can be focused but may not raise the keyboard
//            until the next tap -- by which time the caret is already there.
//
// Returns 'focus', 'blur', or 'none' (leave the DOM alone).
function keyboardProxyAction(state) {
  const s = state || {};
  const hasCaret = !!s.hasCaret;
  const proxyFocused = !!s.proxyFocused;
  if (!hasCaret) return proxyFocused ? 'blur' : 'none';
  if (proxyFocused) return 'none';
  // A caret exists and the keyboard is not up. Inside a gesture this opens it;
  // outside one it at least puts focus where the next keystroke belongs.
  return s.gesture || s.caretIsNew ? 'focus' : 'none';
}

// The DOM half: watch visualViewport, freeze the size, apply the shift.
//
// `deps` supplies everything that belongs to the page rather than to this
// module, so a test can drive the whole controller with plain objects:
//   element()    -> the element to translate (the screen wrap)
//   focusRect()  -> caret rect in CSS client coordinates, or null
//   enabled()    -> whether single-app mode is on; false disables everything
//   onChange()   -> called when the frozen size or shift changes
function createKeyboardController(deps) {
  const d = deps || {};
  const viewport = d.viewport || (typeof window !== 'undefined' ? window.visualViewport : null);
  const doc = d.document || (typeof document !== 'undefined' ? document : null);
  let inset = 0;
  let shift = 0;
  let frozenHeight = 0;

  const measure = () => {
    if (!viewport || !doc) return { layoutHeight: 0, viewportHeight: 0, viewportOffsetTop: 0, scale: 1 };
    return {
      layoutHeight: doc.documentElement ? doc.documentElement.clientHeight : 0,
      viewportHeight: viewport.height,
      viewportOffsetTop: viewport.offsetTop,
      scale: viewport.scale,
    };
  };

  const update = () => {
    const enabled = d.enabled ? !!d.enabled() : true;
    const metrics = measure();
    const nextInset = enabled ? keyboardInset(metrics) : 0;
    const element = d.element ? d.element() : null;

    // The pre-keyboard height has to be captured while the keyboard is still
    // closed -- once it is up, every measurement is already the short one.
    if (!nextInset && element && element.getBoundingClientRect) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) frozenHeight = rect.height;
    }

    let nextShift = 0;
    if (nextInset && element && element.getBoundingClientRect) {
      const rect = element.getBoundingClientRect();
      // Undo any shift already applied, so the geometry is always computed
      // from the canvas's resting position rather than compounding.
      const canvasTop = rect.top + shift;
      const canvasBottom = rect.bottom + shift;
      const focus = d.focusRect ? d.focusRect() : null;
      nextShift = canvasShift({
        inset: nextInset,
        visibleHeight: metrics.viewportHeight,
        canvasTop,
        canvasBottom,
        focus: focus && { top: focus.top + shift, bottom: focus.bottom + shift },
        margin: d.margin,
      });
    }

    const changed = nextInset !== inset || nextShift !== shift;
    inset = nextInset;
    shift = nextShift;
    if (doc && doc.body && doc.body.classList) {
      doc.body.classList.toggle('keyboard-open', inset > 0);
    }
    if (element && element.style) {
      element.style.transform = shift ? `translateY(${-shift}px)` : '';
    }
    if (changed && d.onChange) d.onChange({ inset, shift, frozenHeight });
    return changed;
  };

  const attach = () => {
    if (!viewport || !viewport.addEventListener) return;
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  };

  // Put everything back to "no keyboard", now, without waiting for a viewport
  // event to say so. The shift is applied to the screen wrap, and the desktop
  // icon grid is inside that element -- so a shift that outlives the app it
  // was computed for hides the only launcher a phone has. update() cannot do
  // this job: it derives the inset from the viewport, and while the keyboard
  // is still on its way down the viewport still says the keyboard is up.
  const reset = () => {
    const element = d.element ? d.element() : null;
    inset = 0;
    shift = 0;
    frozenHeight = 0;
    if (doc && doc.body && doc.body.classList) doc.body.classList.remove('keyboard-open');
    if (element && element.style) element.style.transform = '';
    if (d.onChange) d.onChange({ inset, shift, frozenHeight });
  };

  return {
    update,
    attach,
    reset,
    inset: () => inset,
    shift: () => shift,
    // While the keyboard is up this is the height the backing store must keep,
    // so screenCanvasSize() does not follow the viewport down.
    frozenHeight: () => (inset > 0 ? frozenHeight : 0),
  };
}

// Named, not `api`: every lib/ file the page loads shares one global lexical
// scope, and lib/dll-registry.js already declares a top-level `const api` --
// a second one is a SyntaxError that kills the whole page, not just this file.
const mobileKeyboardApi =
  { keyboardInset, canvasShift, keyboardProxyAction, createKeyboardController };
if (typeof module !== 'undefined' && module.exports) module.exports = mobileKeyboardApi;
if (typeof window !== 'undefined') window.MobileKeyboard = mobileKeyboardApi;
