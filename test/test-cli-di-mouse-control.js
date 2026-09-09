#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startControlSession } = require('./control-session');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(__dirname, 'binaries', 'xp', 'winmine.exe');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  winmine.exe not found at ' + EXE);
  process.exit(0);
}

const session = startControlSession([
  'test/run.js', '--exe=' + EXE, '--control-stdin', '--frozen',
  '--max-seconds=20', '--quiet-api', '--quiet-blocks', '--no-build',
], { cwd: ROOT, idPrefix: 'dim-' });

(async () => {
  try {
    const point = await session.send({
      action: 'eval', code: 'renderer.setMousePosition(123, 77)',
    });
    assert.strictEqual(point, (77 << 16) | 123);

    assert.strictEqual((await session.send('di-mousedown')).queued, true);
    await session.step(1);
    assert.deepStrictEqual(await session.send({
      action: 'eval',
      code: '({point:renderer.getMousePosition(),buttons:renderer.getMouseButtons(),async:renderer.getAsyncKeyState(1)})',
    }), { point, buttons: 1, async: 0x8001 },
    'DirectInput press moved the cursor or missed button 1 state');

    assert.strictEqual((await session.send('di-mouseup:1')).queued, true);
    await session.step(1);
    assert.deepStrictEqual(await session.send({
      action: 'eval',
      code: '({point:renderer.getMousePosition(),buttons:renderer.getMouseButtons(),async:renderer.peekAsyncKeyState(1)})',
    }), { point, buttons: 0, async: 0 },
    'DirectInput release moved the cursor or left button 1 held');

    const code = await session.quit();
    assert.strictEqual(code, 0, session.output().slice(-3000));
    assert.match(session.output(), /\[input\] di-mousedown button=1/);
    assert.match(session.output(), /\[input\] di-mouseup button=1/);
    console.log('PASS  frozen CLI controls DirectInput mouse buttons without cursor motion');
  } catch (error) {
    await session.quit({ ignoreReplyError: true });
    throw error;
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
