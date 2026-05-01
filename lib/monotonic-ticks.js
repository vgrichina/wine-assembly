function createMonotonicTickSource(nowFn = () => Date.now()) {
  let last = 0;
  return () => {
    const now = (nowFn() | 0) & 0x7FFFFFFF;
    if (now <= last) {
      last = (last + 1) & 0x7FFFFFFF;
    } else {
      last = now;
    }
    return last;
  };
}

module.exports = { createMonotonicTickSource };
