'use strict';

function decodeRegistrySnapshot(snapshot) {
  const keys = new Map();
  const values = new Map();
  for (const [storeKey, encoded] of Object.entries(snapshot || {})) {
    if (!/^reg:/i.test(storeKey)) continue;
    const keyPath = storeKey.slice(4);
    let record;
    try {
      record = typeof encoded === 'string' ? JSON.parse(encoded) : encoded;
    } catch (_) {
      continue;
    }
    const normalizedKey = keyPath.toLowerCase();
    keys.set(normalizedKey, keyPath);
    for (const [valueName, value] of Object.entries(record?.values || {})) {
      const id = `${normalizedKey}\u0000${valueName.toLowerCase()}`;
      values.set(id, {
        keyPath,
        valueName,
        type: value?.type,
        data: value?.data,
      });
    }
  }
  return { keys, values };
}

function sameValue(a, b) {
  return a.type === b.type && JSON.stringify(a.data) === JSON.stringify(b.data);
}

function compareEntry(a, b) {
  return a.keyPath.localeCompare(b.keyPath, 'en', { sensitivity: 'base' }) ||
    a.valueName.localeCompare(b.valueName, 'en', { sensitivity: 'base' });
}

function diffRegistrySnapshots(beforeSnapshot, afterSnapshot) {
  const before = decodeRegistrySnapshot(beforeSnapshot);
  const after = decodeRegistrySnapshot(afterSnapshot);
  const added = [];
  const changed = [];
  const removed = [];

  for (const [id, entry] of after.values) {
    const old = before.values.get(id);
    if (!old) added.push(entry);
    else if (!sameValue(old, entry)) changed.push({ before: old, after: entry });
  }
  for (const [id, entry] of before.values) {
    if (!after.values.has(id)) removed.push(entry);
  }

  const addedKeys = [...after.keys]
    .filter(([id]) => !before.keys.has(id))
    .map(([, keyPath]) => keyPath)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const removedKeys = [...before.keys]
    .filter(([id]) => !after.keys.has(id))
    .map(([, keyPath]) => keyPath)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));

  added.sort(compareEntry);
  changed.sort((a, b) => compareEntry(a.after, b.after));
  removed.sort(compareEntry);
  return { addedKeys, removedKeys, added, changed, removed };
}

function startupRegistryFromDiff(diff) {
  return [
    ...(diff?.added || []),
    ...(diff?.changed || []).map(change => change.after),
  ].map(entry => ({
    keyPath: entry.keyPath,
    valueName: entry.valueName,
    type: entry.type,
    data: entry.data,
  })).sort(compareEntry);
}

module.exports = {
  decodeRegistrySnapshot,
  diffRegistrySnapshots,
  startupRegistryFromDiff,
};
