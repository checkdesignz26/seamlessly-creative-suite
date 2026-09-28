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
  //                          |'mockup'|'lookbook'|'resized-export',
  //     name, file (Blob, PNG), width, height, thumb (Blob, PNG),
  //     repeatTile (Blob, PNG) | null, repeatLayout: 'halfbrick'|'halfdrop' | null,
  //     source: { studio, recipe?, recipeVersion? },
  //     derivedFrom: assetId | null,
  //     derivation: { studio, preset, px, dpi } | null,
  //     created, updated }
  //
  // repeatTile/repeatLayout (added for Pattern Playground's Half Brick/Half Drop repeat layouts):
  // `file` is always the plain ORIGINAL/SINGLE ARTWORK - unchanged meaning, still what Single
  // Artwork mode and every pre-existing caller gets. repeatTile is a SEPARATE, genuinely different
  // rendering (only present when repeatLayout isn't grid/null) that plain-grid-tiles correctly on
  // its own - see mockup-adapter.js and resizer-adapter.js for who reads it and why.
  //
  // `kind` is a plain string tag, not an enforced enum — each studio's
  // adapter sets it on send and reads it on receive. It's the one
  // source of truth for suite-wide asset routing: which studios show
  // which assets in their own project panel (see each adapter's own
  // RECEIVE-side filter, e.g. mockup-adapter.js / resizer-adapter.js).
  // Source-ish kinds (pattern/motif/background/graphic) are visible to
  // Creative Resizer, Mock-up Studio and Pattern Pages; studio-specific
  // outputs (mockup/lookbook/resized-export) are visible to Pattern
  // Pages only — it's the one app in the suite meant to see every kind.
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
    // repeatTileBuffer only exists on records written after the Half Brick/Half Drop cross-app
    // handoff feature was added, so it's reconstructed the same way regardless of which era the
    // rest of the record is from (see the file/thumb branch below for the legacy case this
    // predates).
    const { repeatTileBuffer, repeatTileType, ...withoutRepeatTile } = record;
    const repeatTile = repeatTileBuffer ? new Blob([repeatTileBuffer], { type: repeatTileType || 'image/png' }) : (record.repeatTile || null);
    if (record.file || record.thumb) {
      // A record saved before this fix already has real Blob fields
      // (from whatever it managed to store) - nothing else to reconstruct.
      return Object.assign({}, withoutRepeatTile, { repeatTile });
    }
    const { fileBuffer, fileType, thumbBuffer, thumbType, ...rest } = withoutRepeatTile;
    return Object.assign({}, rest, {
      file: fileBuffer ? new Blob([fileBuffer], { type: fileType || 'image/png' }) : null,
      thumb: thumbBuffer ? new Blob([thumbBuffer], { type: thumbType || 'image/png' }) : null,
      repeatTile,
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
   *
   * meta.repeatTileDataUrl (optional): a SECOND representation of the
   * same design - the repeat-safe tile (see Pattern Playground's
   * tsRenderSavedItemVariants). `file`/`thumb` stay the plain single
   * ORIGINAL/SINGLE ARTWORK exactly as before (still what Creative
   * Resizer's Single Artwork mode and every other existing caller
   * gets, unchanged) - this is stored alongside it as `repeatTile`,
   * for a caller that specifically needs something it can plain-grid-
   * tile (Mock-up Studio) or that should drive Creative Resizer's own
   * repeat mode. meta.repeatLayout ('halfbrick'/'halfdrop'; omitted or
   * 'grid' means "no separate tile needed" and repeatTileDataUrl is
   * expected to be absent) rides along as plain metadata so a
   * consumer can tell what kind of repeat-safe tile it got without
   * inspecting pixels.
   */
  async function addAssetFromDataUrl(projectId, dataUrl, meta) {
    const blob = await dataUrlToBlob(dataUrl);
    meta = meta || {};
    const repeatTileBlob = meta.repeatTileDataUrl ? await dataUrlToBlob(meta.repeatTileDataUrl) : null;
    return addAssetFromBlob(projectId, blob, Object.assign({}, meta, { repeatTileBlob }));
  }

  async function addAssetFromBlob(projectId, blob, meta) {
    meta = meta || {};
    const { blob: thumb, width, height } = await makeThumb(blob, 320);
    // Stored as ArrayBuffer + type, not as the Blob objects themselves -
    // see the hydrateAsset comment above for why. blob.arrayBuffer() is
    // supported on every browser this suite targets (iOS Safari 14+).
    const [fileBuffer, thumbBuffer, repeatTileBuffer] = await Promise.all([
      blob.arrayBuffer(),
      thumb.arrayBuffer(),
      meta.repeatTileBlob ? meta.repeatTileBlob.arrayBuffer() : Promise.resolve(null),
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
      repeatTileBuffer: repeatTileBuffer || null,
      repeatTileType: meta.repeatTileBlob ? (meta.repeatTileBlob.type || 'image/png') : null,
      repeatLayout: meta.repeatLayout || null,
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
          repeatLayout: a.repeatLayout || null,
          source: a.source,
          derivedFrom: a.derivedFrom,
          derivation: a.derivation,
          created: a.created,
        };
        // repeatTile is converted independently of the main file below - a failure there
        // shouldn't mark the whole asset skipped when the original artwork backed up fine (and
        // vice versa isn't possible, since a missing repeatTile just means "no separate tile", not
        // an error).
        let repeatTile = null;
        if (a.repeatTile) {
          try {
            repeatTile = await blobToDataUrl(a.repeatTile);
          } catch (err) {
            console.error('[suite] repeat-safe tile failed to back up, keeping the original artwork', a.id, a.name, err);
          }
        }
        try {
          return Object.assign(base, { file: await blobToDataUrl(a.file), repeatTile });
        } catch (err) {
          console.error('[suite] asset failed to back up, skipping just this one', a.id, a.name, err);
          return Object.assign(base, { file: null, repeatTile: null, skipped: true, skipReason: (err && err.message) || String(err) });
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

  // Reads a .screativeproject file back in (the counterpart to
  // exportProjectBackup/prepareProjectBackup above) and rebuilds it as
  // a brand-new project — never merged into whatever's currently open,
  // so importing can't silently mix assets into the wrong project or
  // overwrite something by accident. Each asset gets a fresh id (the
  // one substore/IndexedDB is not necessarily the one it was exported
  // from), so derivedFrom links from the original project would point
  // at ids that don't exist here — dropped on import rather than left
  // dangling. An asset the backup itself had already marked `skipped`
  // (no image data, from a legacy Blob-corruption failure at export
  // time — see exportProjectBackup's own comment) can't be restored
  // either; counted separately so the caller can tell "imported
  // everything" from "some assets didn't make the trip".
  async function importProjectBackup(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('That file isn’t a valid backup (not readable JSON).');
    }
    if (!data || data.kind !== 'project-backup' || !Array.isArray(data.assets)) {
      throw new Error('That file isn’t a Seamlessly Creative project backup.');
    }
    const baseName = (data.project && data.project.name) || 'Imported project';
    const project = await createProject(baseName);
    let importedCount = 0;
    let skippedCount = 0;
    for (const a of data.assets) {
      if (!a.file) {
        skippedCount++;
        continue;
      }
      try {
        const blob = await dataUrlToBlob(a.file);
        // repeatTile is best-effort here too - if it fails to decode, restore the asset anyway
        // with just its original artwork rather than skipping the whole thing over a secondary
        // representation.
        let repeatTileBlob = null;
        if (a.repeatTile) {
          try {
            repeatTileBlob = await dataUrlToBlob(a.repeatTile);
          } catch (err) {
            console.error('[suite] repeat-safe tile failed to import, keeping the original artwork', a.id, a.name, err);
          }
        }
        await addAssetFromBlob(project.id, blob, {
          kind: a.kind,
          name: a.name,
          source: a.source,
          derivedFrom: null,
          derivation: a.derivation,
          repeatTileBlob,
          repeatLayout: a.repeatLayout || null,
        });
        importedCount++;
      } catch (err) {
        console.error('[suite] asset failed to import, skipping just this one', a.id, a.name, err);
        skippedCount++;
      }
    }
    return { project, importedCount, skippedCount, totalCount: data.assets.length };
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
    importProjectBackup,
  };
})(window);
