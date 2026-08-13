// Retained as a compatibility entry point for scripts that ran the old
// split-brain dirty-rectangle test directly. The replacement exercises the
// stronger invariant: DirectDraw HDCs write native WAT memory and ReleaseDC
// never reads Canvas pixels back.
require('./test-wat-gdi-directdraw-surface');
