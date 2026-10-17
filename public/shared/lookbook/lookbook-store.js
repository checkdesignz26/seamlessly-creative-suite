/* Creative Lookbook project storage (IndexedDB) — independent of the suite's project library and of
 * Mock-up Studio's own saves (its own database name), so the standalone app needs nothing else.
 *
 * Two object stores so the project list stays light even when projects hold many large images:
 *   projects     { id, name, createdAt, updatedAt, pages, thumb }      (listed on the start screen)
 *   projectData  { id, data }                                          (the full project, loaded on open)
 *
 * ScLookbookStore.list() / get(id) / put(project) / remove(id) / duplicate(id) / newId()
 * A "project" is { id, name, createdAt, updatedAt, patterns[], images[], lookbook:{pages[]} , thumb? }.
 */
(function (global) {
  'use strict';
  var DB_NAME = 'creativeLookbookDB', DB_VERSION = 1, META = 'projects', DATA = 'projectData';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB is not available in this browser')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { dbPromise = null; reject(req.error); };
      req.onblocked = function () { /* another tab holds an old version; the browser retries */ };
    });
    return dbPromise;
  }

  function tx(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  function reqValue(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  function newId() {
    return 'lb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function put(project) {
    var now = Date.now();
    project.updatedAt = now;
    if (!project.createdAt) project.createdAt = now;
    var meta = {
      id: project.id, name: project.name || 'untitled lookbook', createdAt: project.createdAt, updatedAt: now,
      pages: (project.lookbook && project.lookbook.pages ? project.lookbook.pages.length : 0), thumb: project.thumb || ''
    };
    var data = {
      patterns: project.patterns || [], images: project.images || [], lookbook: project.lookbook || { pages: [] }
    };
    return tx([META, DATA], 'readwrite', function (t) {
      t.objectStore(META).put(meta);
      t.objectStore(DATA).put({ id: project.id, data: data });
    }).then(function () { return meta; });
  }

  function list() {
    return open().then(function (db) {
      return reqValue(db.transaction(META, 'readonly').objectStore(META).getAll());
    }).then(function (rows) { return rows.sort(function (a, b) { return b.updatedAt - a.updatedAt; }); });
  }

  function get(id) {
    return open().then(function (db) {
      var t = db.transaction([META, DATA], 'readonly');
      return Promise.all([reqValue(t.objectStore(META).get(id)), reqValue(t.objectStore(DATA).get(id))]);
    }).then(function (r) {
      if (!r[0] || !r[1]) return null;
      var d = r[1].data || {};
      return {
        id: id, name: r[0].name, createdAt: r[0].createdAt, updatedAt: r[0].updatedAt, thumb: r[0].thumb || '',
        patterns: d.patterns || [], images: d.images || [], lookbook: d.lookbook || { pages: [] }
      };
    });
  }

  function remove(id) {
    return tx([META, DATA], 'readwrite', function (t) { t.objectStore(META).delete(id); t.objectStore(DATA).delete(id); });
  }

  function duplicate(id) {
    return get(id).then(function (p) {
      if (!p) return null;
      p.id = newId(); p.name = (p.name || 'untitled lookbook') + ' copy'; p.createdAt = 0;
      return put(p).then(function () { return p; });
    });
  }

  global.ScLookbookStore = { open: open, newId: newId, put: put, list: list, get: get, remove: remove, duplicate: duplicate };
})(window);
