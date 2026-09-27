/**
 * Seamlessly Creative — shared project/asset library.
 *
 * Phase 1 proof of concept. Lives entirely in the browser (one new,
 * separate IndexedDB — "seamlesslyCreativeSuite" — at the suite's own
 * address). It does NOT read, write, or migrate any existing studio
 * database (pkmDB, patternPagesAutoSaveDB, mockupStudioDB, or any
 * localStorage key). Those keep working exactly as they do standalone.
 *
 * Loaded by:
 *   - the suite shell (public/index.html) — to list/create projects
 *     and render the top-bar save status
 *   - each studio's small adapter script — to read/write assets for
 *     the currently-open project
 *
 * Images are stored as Blobs (PNG), not base64 strings — base64 is
 * ~33% larger and is exactly what already bloats Pattern Pages'
 * autosave; this library is designed from the start not to repeat
 * that mistake once Pattern Pages gets an adapter in Phase 2.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'seamlesslyCreativeSuite';
  const DB_VERSION = 1;
  const STORE_PROJECTS = 'projects';
  const STORE_ASSETS = 'assets';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
          db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_ASSETS)) {
          const store = db.createObjectStore(STORE_ASSETS, { keyPath: 'id' });
          store.createIndex('byProject', 'projectId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // Races every IndexedDB call against a timeout. Safari private-mode
  // has a known issue where an IDB request just hangs forever instead
  // of firing onerror — Pattern Playground already works around this
  // (idbWithTimeout) and the same failure mode applies here.
  function withTimeout(promise, label, ms = 6000) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(label + ' timed out')), ms)
      ),
    ]);
  }

  function tx(storeName, mode) {
    return openDb().then(
      (db) => db.transaction(storeName, mode).objectStore(storeName)
    );
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function uid(prefix) {
    return (
      prefix +
      '_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 9)
    );
  }

  // --- Projects -----------------------------------------------------

  async function listProjects() {
    const store = await tx(STORE_PROJECTS, 'readonly');
    const all = await withTimeout(reqToPromise(store.getAll()), 'listProjects');
    return all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }

  async function getProject(id) {
    const store = await tx(STORE_PROJECTS, 'readonly');
    return withTimeout(reqToPromise(store.get(id)), 'getProject');
  }

  async function createProject(name) {
    const project = {
      id: uid('proj'),
      name: name || 'Untitled project',
      created: Date.now(),
      updated: Date.now(),
      coverAssetId: null,
    };
    const store = await tx(STORE_PROJECTS, 'readwrite');
    await withTimeout(reqToPromise(store.put(project)), 'createProject');
    return project;
  }

  async function touchProject(id, patch) {
    const store = await tx(STORE_PROJECTS, 'readwrite');
    const existing = await withTimeout(reqToPromise(store.get(id)), 'touchProject:get');
    if (!existing) return null;
    const updated = Object.assign({}, existing, patch || {}, { updated: Date.now() });
    await withTimeout(reqToPromise(store.put(updated)), 'touchProject:put');
    return updated;
  }

  async function deleteProject(id) {
    const assets = await listAssets(id);
    const store = await tx(STORE_ASSETS, 'readwrite');
    await Promise.all(
      assets.map((a) => withTimeout(reqToPromise(store.delete(a.id)), 'deleteProject:asset'))
    );
    const pStore = await tx(STORE_PROJECTS, 'readwrite');
    await withTimeout(reqToPromise(pStore.delete(id)), 'deleteProject:project');
  }

  // --- Assets ---------------------------------------------------------
  //
  // Public asset shape (what listAssets/getAsset/addAssetFromBlob
  // return — every caller outside this file only ever sees this):
  //   { id, projectId, kind: 'pattern'|'motif'|'background'|'graphic'
  //                          |'mockup'|'lookbook',
  //     name, file (Blob, PNG), width, height, thumb (Blob, PNG),
  //     source: { studio, recipe?, recipeVersion? },
  //     derivedFrom: assetId | null,
  //     derivation: { studio, preset, px, dpi } | null,
  //     created, updated }
  //
  // What's actually stored in IndexedDB differs — fileBuffer/fileType
  // and thumbBuffer/thumbType instead of file/thumb — see the
  // hydrateAsset comment below for why, and note that a record
  // written before that fix may still have the old file/thumb Blob
  // fields directly; hydrateAsset handles both.

  async function listAssets(projectId) {
    const store = await tx(STORE_ASSETS, 'readonly');
    const idx = store.index('byProject');
    const all = await withTimeout(
      reqToPromise(idx.getAll(IDBKeyRange.only(projectId))),
      'listAssets'
    );
    return all.sort((a, b) => (a.created || 0) - (b.created || 0)).map(hydrateAsset);
  }

  async function getAsset(id) {
    const store = await tx(STORE_ASSETS, 'readonly');
    const record = await withTimeout(reqToPromise(store.get(id)), 'getAsset');
    return hydrateAsset(record);
  }

  // Real bug found on iPad Safari, one layer deeper than the
  // dataUrlToBlob fix above: even after that fix let store.put(asset)
  // succeed, every asset read back out showed a broken/fallback
  // thumbnail everywhere it was displayed (Mock-up Studio's own
  // project panel, not just Pattern Pages') — the SAME class of
  // WebKit IndexedDB bug, just its other failure mode. WebKit's
  // IndexedDB cannot reliably structured-clone Blob objects at all:
  // sometimes it rejects the write outright (the earlier bug),
  // sometimes it accepts the write but silently corrupts the Blob on
  // the way back out, so it fails to decode as an image later even
  // though nothing errored at save time. A plain Blob, in-memory
  // buffer or not, still goes through the same buggy Blob-specific
  // clone path either way.
  // Fixed at the root instead of chasing another symptom: assets are
  // no longer stored as Blob fields at all. addAssetFromBlob below
  // stores the raw bytes as a plain ArrayBuffer (fileBuffer/thumbBuffer)
  // plus a MIME type string — both structured-clone reliably on every
  // browser tested, Safari included, since neither is a Blob. A real
  // Blob is reconstructed here, in memory, only when a caller actually
  // asks for one (via listAssets/getAsset) — asset.file/asset.thumb
  // still come back as normal Blobs to every existing caller
  // (Playground/Mock-up Studio/Pattern Pages adapters, the project
  // backup export), so nothing downstream had to change.
  function hydrateAsset(record) {
    if (!record) return record;
    if (record.file || record.thumb) {
      // A record saved before this fix already has real Blob fields
      // (from whatever it managed to store) - nothing to reconstruct.
      return record;
    }
    const { fileBuffer, fileType, thumbBuffer, thumbType, ...rest } = record;
    return Object.assign({}, rest, {
      file: fileBuffer ? new Blob([fileBuffer], { type: fileType || 'image/png' }) : null,
      thumb: thumbBuffer ? new Blob([thumbBuffer], { type: thumbType || 'image/png' }) : null,
    });
  }

  // Real bug found on iPad Safari: fetch(dataUrl).then(r => r.blob())
  // is the obvious way to turn a dataURL into a Blob, and works fine
  // for reading the Blob back out (img.src, canvas draws, etc.) — but
  // a Blob built this way is backed by WebKit's internal fetch/network
  // response machinery, not a plain in-memory buffer, and WebKit's
  // IndexedDB implementation cannot always structured-clone that kind
  // of Blob to disk. The failure is exactly this: store.put(asset)
  // rejects with "Error preparing Blob/File data to be stored in
  // object store" — every "send to project" action (Playground's
  // starred patterns, Mock-up Studio's mock-ups/lookbook pages) goes
  // through this function, so this broke sending everywhere, not any
  // one studio. Chromium (used for local testing) doesn't have this
  // limitation, so it only ever showed up on a real device.
  // Fixed by decoding the base64 payload by hand into a plain
  // Uint8Array and building the Blob directly from that buffer —
  // a plain memory-backed Blob, not a fetch response, which
  // structured-clones into IndexedDB reliably on every browser tested
  // so far, Safari included.
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const header = dataUrl.slice(0, comma);
    const isBase64 = /;base64/.test(header);
    const mimeMatch = /^data:([^;,]+)/.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
    const body = dataUrl.slice(comma + 1);
    const binary = isBase64 ? atob(body) : decodeURIComponent(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return Promise.resolve(new Blob([bytes], { type: mime }));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  async function makeThumb(blob, maxPx) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const thumbBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return { blob: thumbBlob, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Adds an asset to a project from a dataURL (what every studio's
   * canvas export already produces). Handles the dataURL -> Blob
   * conversion and thumbnail generation so an adapter only ever has
   * to call this one function.
   */
  async function addAssetFromDataUrl(projectId, dataUrl, meta) {
    const blob = await dataUrlToBlob(dataUrl);
    return addAssetFromBlob(projectId, blob, meta);
  }

  async function addAssetFromBlob(projectId, blob, meta) {
    meta = meta || {};
    const { blob: thumb, width, height } = await makeThumb(blob, 320);
    // Stored as ArrayBuffer + type, not as the Blob objects themselves -
    // see the hydrateAsset comment above for why. blob.arrayBuffer() is
    // supported on every browser this suite targets (iOS Safari 14+).
    const [fileBuffer, thumbBuffer] = await Promise.all([
      blob.arrayBuffer(),
      thumb.arrayBuffer(),
    ]);
    const record = {
      id: uid('asset'),
      projectId,
      kind: meta.kind || 'pattern',
      name: meta.name || 'untitled',
      fileBuffer,
      fileType: blob.type || 'image/png',
      width,
      height,
      thumbBuffer,
      thumbType: thumb.type || 'image/png',
      source: meta.source || null,
      derivedFrom: meta.derivedFrom || null,
      derivation: meta.derivation || null,
      created: Date.now(),
      updated: Date.now(),
    };
    const store = await tx(STORE_ASSETS, 'readwrite');
    await withTimeout(reqToPromise(store.put(record)), 'addAsset');
    await touchProject(projectId, {});
    return hydrateAsset(record);
  }

  async function deleteAsset(id) {
    const asset = await getAsset(id);
    const store = await tx(STORE_ASSETS, 'readwrite');
    await withTimeout(reqToPromise(store.delete(id)), 'deleteAsset');
    if (asset) await touchProject(asset.projectId, {});
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --- Project backup (single JSON file; a stand-in for cloud sync) --
  //
  // Phase 1 scope: exports the project + every asset's full-res file
  // as a plain JSON file (assets as base64 inside it — fine for an
  // explicit, occasional download, unlike a hot autosave path). A
  // real ZIP/binary format can replace this later without changing
  // the shell's "Download Project Backup" button.

  // Real bug found from testing: a project containing even one asset
  // saved before the ArrayBuffer storage fix above (ones that already
  // show as a broken/fallback thumbnail everywhere else, from the same
  // WebKit Blob-corruption bug) made "Download Project Backup" fail
  // outright for the WHOLE project — Promise.all rejects the instant
  // any single blobToDataUrl(a.file) call rejects, so one bad legacy
  // asset blocked every good one from being backed up too. Fixed the
  // same way playground-adapter.js's own "send to project" already
  // handles a per-item failure: convert each asset independently, and
  // if one fails, include it in the backup as a marked skip (name +
  // reason, no image data) instead of aborting the whole export. A
  // project with nothing but good assets is unaffected either way.
  async function exportProjectBackup(projectId) {
    const project = await getProject(projectId);
    if (!project) throw new Error('project not found');
    const assets = await listAssets(projectId);
    const assetsOut = await Promise.all(
      assets.map(async (a) => {
        const base = {
          id: a.id,
          kind: a.kind,
          name: a.name,
          width: a.width,
          height: a.height,
          source: a.source,
          derivedFrom: a.derivedFrom,
          derivation: a.derivation,
          created: a.created,
        };
        try {
          return Object.assign(base, { file: await blobToDataUrl(a.file) });
        } catch (err) {
          console.error('[suite] asset failed to back up, skipping just this one', a.id, a.name, err);
          return Object.assign(base, { file: null, skipped: true, skipReason: (err && err.message) || String(err) });
        }
      })
    );
    return {
      app: 'seamlessly-creative-suite',
      kind: 'project-backup',
      version: 1,
      savedAt: new Date().toISOString(),
      project: { id: project.id, name: project.name, created: project.created },
      assets: assetsOut,
    };
  }

  // Builds the backup Blob but does NOT trigger a download itself —
  // that has to happen from a real, synchronous tap (see shell.js's
  // click handler). Real bug found on iPad Safari: the old version of
  // this function did its own a.click() at the end, AFTER several
  // awaited IndexedDB reads above (exportProjectBackup ->
  // listAssets -> blobToDataUrl per asset). Safari only allows a file
  // save to be triggered synchronously within the tap that started
  // it; once anything is awaited first, the click that follows is no
  // longer considered part of that same user gesture and Safari
  // silently blocks it — no error, nothing visibly happens. Chromium
  // (what this was tested with) doesn't enforce that as strictly, so
  // the bug never showed up in testing until real iPad use surfaced
  // it. Splitting "prepare the file" (async, can take as long as it
  // needs) from "save it" (must be a real, fresh tap) fixes this.
  async function prepareProjectBackup(projectId) {
    const data = await exportProjectBackup(projectId);
    const json = JSON.stringify(data);
    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = (data.project.name || 'project').replace(/[\\/:*?"<>|]/g, '').trim() || 'project';
    const blob = new Blob([json], { type: 'application/octet-stream' });
    const skippedCount = data.assets.filter((a) => a.skipped).length;
    return {
      blob,
      filename: `${safeName}-${stamp}.screativeproject`,
      bytes: json.length,
      assetCount: data.assets.length,
      skippedCount,
    };
  }

  global.SCLibrary = {
    listProjects,
    getProject,
    createProject,
    touchProject,
    deleteProject,
    listAssets,
    getAsset,
    addAssetFromDataUrl,
    addAssetFromBlob,
    deleteAsset,
    blobToDataUrl,
    prepareProjectBackup,
  };
})(window);
