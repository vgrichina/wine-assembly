#!/usr/bin/env node
// Static browser-input coverage: mobile browsers must be able to drive the
// canvas through touch events without scrolling/zooming the page or relying on
// synthetic mouse compatibility events.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

assert(html.includes('touch-action: none'), 'canvas should disable browser touch gestures');
assert(html.includes('-webkit-user-select: none'), 'canvas should disable iOS text selection');
assert(html.includes('function eventPointFromClient(clientX, clientY)'), 'touch and mouse should share client-coordinate mapping');
assert(html.includes("canvas.addEventListener('touchstart'"), 'canvas should handle touchstart');
assert(html.includes("window.addEventListener('touchmove', windowTouchMove, { capture: true, passive: false })"), 'touchmove should be captured and non-passive');
assert(html.includes("window.addEventListener('touchend', windowTouchEnd, { capture: true, passive: false })"), 'touchend should be captured and non-passive');
assert(html.includes("window.addEventListener('touchcancel', windowTouchCancel, { capture: true, passive: false })"), 'touchcancel should be captured and non-passive');
assert(html.includes('renderer.handleMouseDown(cx, cy, 0)'), 'touchstart should map to left-button mouse down');
assert(html.includes('renderer.handleMouseMove(x, y)'), 'touchmove should map to mouse move');
assert(html.includes('renderer.handleMouseUp(p.x, p.y, 0)'), 'touchend/cancel should release left-button mouse up');
assert(html.includes('forwardEmptyDesktopClick(t.clientX, t.clientY, cx, cy)'), 'touch should launch desktop icons when tapping empty canvas overlay');
assert(html.includes("cv.addEventListener('touchstart'"), 'pre-launch canvas overlay should forward mobile taps to icons');
assert(html.includes('e.preventDefault();'), 'touch handlers should prevent browser scroll/zoom defaults');
assert(html.includes('const MIN_BACKING_WIDTH = 640'), 'small screens should still get at least a 640px emulated backing width');
assert(html.includes('displayW') && html.includes('displayH'), 'canvas backing size should be separate from CSS display size');
assert(html.includes('Math.max(1, MIN_BACKING_WIDTH / displayW)'), 'narrow viewports should scale backing height proportionally');
assert(html.includes("canvas.style.width = displayW + 'px'"), 'fullscreen CSS width should use physical display width, not minimum backing width');

console.log('PASS  web canvas supports mobile touch input');
