'use strict';

const { spawn } = require('child_process');

// Shared client for test/run.js --control-stdin. Callers retain ownership of
// the input schedule and assertions; this module owns the byte-stream framing,
// request ids, reply routing, output capture, and pending-request teardown.
function startControlSession(args, options = {}) {
  const {
    command = process.execPath,
    cwd = process.cwd(),
    idPrefix = 'ctl-',
    spawnOptions = {},
  } = options;
  const child = spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...spawnOptions,
  });

  let output = '';
  let lineBuffer = '';
  let nextId = 1;
  const pending = new Map();
  const exited = new Promise(resolve => child.on('exit', resolve));

  child.stdout.on('data', data => {
    output += data;
    lineBuffer += data;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      const match = line.match(/^\[ctl\] (.*)$/);
      if (!match) continue;
      let reply;
      try { reply = JSON.parse(match[1]); } catch (_) { continue; }
      const waiter = pending.get(reply.id);
      if (!waiter) continue;
      pending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.value);
      else waiter.reject(new Error(reply.error || 'control command failed'));
    }
  });
  child.stderr.on('data', data => { output += data; });
  child.on('exit', code => {
    for (const [id, waiter] of pending) {
      waiter.reject(new Error(`run.js exited before replying to ${id} (exit ${code})`));
    }
    pending.clear();
  });

  function send(commandValue) {
    const id = `${idPrefix}${nextId++}`;
    const payload = typeof commandValue === 'string'
      ? { id, cmd: commandValue }
      : { id, ...commandValue };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
  }

  const step = n => send({ action: 'step', n });
  async function quit(optionsValue = {}) {
    const { ignoreReplyError = false } = optionsValue;
    let replyError = null;
    if (child.exitCode === null) {
      try { await send({ action: 'quit' }); } catch (error) { replyError = error; }
      child.stdin.end();
    }
    const code = await exited;
    if (replyError && !ignoreReplyError) throw replyError;
    return code;
  }

  return {
    child,
    exited,
    send,
    step,
    quit,
    output: () => output,
  };
}

module.exports = { startControlSession };
