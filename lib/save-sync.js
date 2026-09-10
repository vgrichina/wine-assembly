// Save sync — the bundle lib/save-bundle.js writes, carried between a user's
// devices by berrry's per-user data API.
//
// berrry has two unrelated HTTP surfaces and confusing them is the whole trap:
// `tools/deploy-berrry.js` speaks the *owner-keyed deploy* API, whose key can
// never ship to a browser, while a deployed app calls the *per-user data* API
// same-origin as whoever is signed in. Saves go through the second one:
//
//   GET  /api/auth/user               who is signed in, or 401
//   POST /api/data/wine-saves-<app>   the bundle, Content-Type application/zip
//   GET  /api/data/wine-saves-<app>   it back, with the same content type
//   GET  /api/data/wine-saves-<app>/metadata   { updatedAt, … }
//
// Records are private to the authenticated user by default, which is exactly
// the sharing model saves want, and the session is a server-set cookie — the
// one storage slot Safari's 7-day script-storage purge does not touch. So the
// identity is the berrry account: there is no sync code to lose, and a
// signed-out user still has the whole local experience plus the export file.
//
// `endpoint` is configurable and defaults to same-origin (''), which is what a
// deployed page wants; the CLI and the tests point it at
// `tools/save-sync-server.js`, which emulates this same API shape so the code
// under test is the code that will run in production.
//
// Nothing here fails quietly. A 401 comes back as an error carrying
// `authRequired` and the login URL to redirect to, not as "no saves found".

(function () {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 15000;
  const KEY_PREFIX = 'wine-saves-';

  function bundleModule(options) {
    if (options && options.saveBundle) return options.saveBundle;
    if (typeof require === 'function') return require('./save-bundle');
    if (typeof window !== 'undefined' && window.SaveBundle) return window.SaveBundle;
    throw new Error('save sync needs lib/save-bundle.js');
  }

  // '' means same-origin, which is the deployed case. Anything else has to be
  // a real http(s) origin: a bare hostname would silently resolve relative to
  // the page and sync somewhere nobody meant.
  function baseUrl(endpoint) {
    const text = String(endpoint === undefined || endpoint === null ? '' : endpoint).trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) {
      throw new Error(
        `save sync: endpoint must be an http(s) URL or "" for same-origin, got "${text}"`);
    }
    return text.replace(/\/+$/, '');
  }

  function saveKey(appId) {
    const app = String(appId || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(app)) {
      throw new Error(`save sync: "${app}" is not a usable app id`);
    }
    return KEY_PREFIX + app;
  }

  function dataUrl(endpoint, appId) {
    return `${baseUrl(endpoint)}/api/data/${encodeURIComponent(saveKey(appId))}`;
  }

  function metadataUrl(endpoint, appId) {
    return dataUrl(endpoint, appId) + '/metadata';
  }

  function loginUrl(endpoint) {
    return `${baseUrl(endpoint)}/api/auth/login`;
  }

  function authError(endpoint) {
    const error = new Error(
      'save sync: not signed in to berrry. Sync stores saves under the signed-in ' +
      `account — send the user to ${loginUrl(endpoint)}, which returns to the app.`);
    error.authRequired = true;
    error.loginUrl = loginUrl(endpoint);
    return error;
  }

  function fetchImplFor(options) {
    const impl = (options && options.fetchImpl) || (typeof fetch === 'function' ? fetch : null);
    if (!impl) throw new Error('save sync: no fetch() in this environment (pass fetchImpl)');
    return impl;
  }

  async function request(options, url, init, consume = response => response) {
    const doFetch = fetchImplFor(options);
    const ms = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`save sync: ${url} timed out after ${ms}ms`);
        error.name = 'TimeoutError';
        reject(error);
        if (controller) controller.abort();
      }, ms);
    });
    try {
      // fetch resolves at the headers. Keep the same deadline alive while the
      // consumer reads the body; race also bounds injected fetch implementations
      // that do not honor AbortSignal.
      const operation = (async () => {
        const response = await doFetch(url, Object.assign(
          { credentials: 'same-origin' }, init, controller ? { signal: controller.signal } : {}));
        return consume(response);
      })();
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Who is signed in, or null. Null is a normal, expected state — a signed-out
  // visitor still plays and still exports a bundle by hand — so this one call
  // reports it rather than throwing.
  async function getUser(options) {
    options = options || {};
    return request(options, `${baseUrl(options.endpoint)}/api/auth/user`,
      { method: 'GET', headers: { accept: 'application/json' } }, async response => {
        if (response.status === 401) return null;
        if (!response.ok) {
          throw new Error(`save sync: GET /api/auth/user failed with HTTP ${response.status}`);
        }
        return JSON.parse(await responseText(response));
      });
  }

  async function responseText(response) {
    if (typeof response.text === 'function') return response.text();
    const buf = await response.arrayBuffer();
    return new TextDecoder('utf-8').decode(new Uint8Array(buf));
  }

  // { updatedAt, … } for the stored bundle, or null when nothing is stored yet.
  async function metadata(options) {
    options = options || {};
    const url = metadataUrl(options.endpoint, options.appId);
    return request(options, url,
      { method: 'GET', headers: { accept: 'application/json' } }, async response => {
        if (response.status === 404) return null;
        if (response.status === 401) throw authError(options.endpoint);
        if (!response.ok) throw new Error(`save sync: GET ${url} failed with HTTP ${response.status}`);
        const text = await responseText(response);
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error(`save sync: ${url} did not return JSON metadata (${e.message})`);
        }
      });
  }

  // The stored bundle, fully verified, or null when the account has none for
  // this app yet. An HTTP error is never "no saves".
  async function pull(options) {
    options = options || {};
    const url = dataUrl(options.endpoint, options.appId);
    const bytes = await request(options, url,
      { method: 'GET', headers: { accept: 'application/zip' } }, async response => {
        if (response.status === 404) return null;
        if (response.status === 401) throw authError(options.endpoint);
        if (!response.ok) throw new Error(`save sync: GET ${url} failed with HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      });
    if (!bytes) return null;
    if (!bytes.length) return null;
    const parsed = bundleModule(options).readBundle(bytes, options);
    if (options.appId && parsed.manifest.appId !== options.appId) {
      throw new Error(
        `save sync: the stored record under ${saveKey(options.appId)} holds a bundle for ` +
        `"${parsed.manifest.appId}"`);
    }
    return { bytes, manifest: parsed.manifest };
  }

  // Upload. The data API takes raw bytes when the Content-Type says what they
  // are, so the bundle goes up as the zip it already is — no base64, no
  // multipart envelope, and `GET` hands the same bytes back.
  async function push(options) {
    options = options || {};
    const bytes = options.bundle;
    if (!(bytes instanceof Uint8Array)) throw new Error('save sync: push needs the bundle bytes');
    const url = dataUrl(options.endpoint, options.appId);
    const response = await request(options, url, {
      method: options.method || 'POST',
      headers: { 'content-type': 'application/zip' },
      body: bytes,
    });
    if (response.status === 401) throw authError(options.endpoint);
    if (!response.ok) throw new Error(`save sync: PUT ${url} failed with HTTP ${response.status}`);
    return { url, bytes: bytes.length };
  }

  async function remove(options) {
    options = options || {};
    const url = dataUrl(options.endpoint, options.appId);
    const response = await request(options, url, { method: 'DELETE' });
    if (response.status === 401) throw authError(options.endpoint);
    if (response.status === 404) return { removed: false };
    if (!response.ok) {
      throw new Error(`save sync: DELETE ${url} failed with HTTP ${response.status}`);
    }
    return { removed: true };
  }

  function createdMs(manifest) {
    const ms = Date.parse((manifest && manifest.createdAt) || '');
    return Number.isFinite(ms) ? ms : 0;
  }

  //  sync({ endpoint, appId, bundle })
  //
  // Last-write-wins. The clock that decides is each bundle's own
  // `manifest.createdAt` — the moment the state was captured — and not the
  // record's `updatedAt`, which is the moment it reached the server. Those two
  // disagree in the one case that matters: a device that played offline on
  // Monday and syncs on Friday would otherwise beat a device that played on
  // Wednesday and synced immediately, and the Wednesday save would be lost.
  // `updatedAt` is fetched anyway and reported, because it is the cheap probe
  // for "has anything changed at all" and belongs in a UI.
  //
  // Returns one of:
  //   { action: 'pushed' }          local was newer, or the account had nothing
  //   { action: 'pulled', bytes }   remote was newer — the caller imports it
  //   { action: 'in-sync' }         same capture time, nothing moved
  //   { action: 'none' }            no local bundle and nothing stored
  async function sync(options) {
    options = options || {};
    const local = options.bundle || null;
    const meta = await metadata(options);
    if (!meta) {
      if (!local) return { action: 'none', reason: 'no local bundle and nothing stored' };
      await push(Object.assign({}, options, { bundle: local }));
      return { action: 'pushed', reason: 'the account had no saves for this app' };
    }

    const remote = await pull(options);
    if (!remote) {
      if (!local) return { action: 'none', reason: 'nothing stored' };
      await push(Object.assign({}, options, { bundle: local }));
      return { action: 'pushed', reason: 'the stored record was empty', updatedAt: meta.updatedAt };
    }
    if (!local) {
      return {
        action: 'pulled', bytes: remote.bytes, manifest: remote.manifest,
        updatedAt: meta.updatedAt,
      };
    }

    const localManifest = bundleModule(options).readBundle(local, options).manifest;
    if (options.appId && localManifest.appId !== options.appId) {
      throw new Error(
        `save sync: local bundle is for "${localManifest.appId}", not "${options.appId}"`);
    }
    const localMs = createdMs(localManifest);
    const remoteMs = createdMs(remote.manifest);
    if (localMs > remoteMs) {
      await push(Object.assign({}, options, { bundle: local }));
      return { action: 'pushed', manifest: localManifest, updatedAt: meta.updatedAt };
    }
    if (remoteMs > localMs) {
      return {
        action: 'pulled', bytes: remote.bytes, manifest: remote.manifest,
        updatedAt: meta.updatedAt,
      };
    }
    return { action: 'in-sync', manifest: remote.manifest, updatedAt: meta.updatedAt };
  }

  const api = {
    KEY_PREFIX,
    saveKey,
    dataUrl,
    metadataUrl,
    loginUrl,
    getUser,
    metadata,
    pull,
    push,
    remove,
    sync,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.SaveSync = api;
})();
