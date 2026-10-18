/* Creative Lookbook — standalone app (start screen, projects, uploads, save/open, exports).
 *
 * The editor itself is the shared engine in /shared/lookbook/lookbook-editor.js; this file is the "host" that
 * supplies what that engine needs (patterns, images, change notifications, project name) and owns everything
 * around it: where projects are kept (IndexedDB via ScLookbookStore), the start screen, and project files.
 * It uses no suite code, so the page works completely on its own.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_SIDE = 4096;          // uploads larger than this (long side) are scaled down
  var THUMB_SIDE = 200;
  var FORMAT = 'creative-lookbook', VERSION = 1;

  var project = null;           // the open project (see ScLookbookStore)
  var lastSaved = '';          // fingerprint (not a copy) of what is on disk
  var saveTimer = null;
  var saving = Promise.resolve();
  var observing = false;

  /* ---------------- small helpers ---------------- */
  function toast(msg) { window.showToastMessage(msg); }

  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  function readAsDataUrl(file) {
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('could not read file')); };
      r.readAsDataURL(file);
    });
  }

  function canvasOf(img, w, h) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, 0, 0, w, h);
    return c;
  }

  // A file becomes a library asset: the picture itself (scaled down only if huge) plus a small thumbnail.
  async function makeAsset(src, name, mime) {
    var img = await ilLoadImage(src);
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('not a picture');
    var keepJpeg = /jpe?g/i.test(mime || '') || /^data:image\/jpe?g/i.test(src);
    var full = src;
    if (Math.max(w, h) > MAX_SIDE) {
      var k = MAX_SIDE / Math.max(w, h);
      full = canvasOf(img, Math.round(w * k), Math.round(h * k)).toDataURL(keepJpeg ? 'image/jpeg' : 'image/png', 0.92);
    }
    var tk = Math.min(1, THUMB_SIDE / Math.max(w, h));
    var thumb = canvasOf(img, Math.max(1, Math.round(w * tk)), Math.max(1, Math.round(h * tk))).toDataURL(keepJpeg ? 'image/jpeg' : 'image/png', 0.8);
    return { id: ScLookbookStore.newId(), name: name, src: full, thumbSrc: thumb, ar: w / h };
  }

  async function addFiles(fileList, kind) {
    var files = Array.prototype.slice.call(fileList || []);
    var added = 0, failed = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!/^image\//.test(f.type) && !/\.(png|jpe?g|webp|gif|bmp|avif|heic)$/i.test(f.name)) { failed++; continue; }
      try {
        var asset = await makeAsset(await readAsDataUrl(f), f.name.replace(/\.[^.]+$/, ''), f.type);
        (kind === 'pattern' ? project.patterns : project.images).push(asset);
        added++;
      } catch (e) { console.error(e); failed++; }
    }
    if (added) { ilRefreshHostStrips(); scheduleSave(); }
    if (failed) toast(failed + (failed === 1 ? ' file' : ' files') + " couldn't be added — try a PNG or JPEG.");
    else if (added) toast(added + (added === 1 ? ' picture' : ' pictures') + ' added — tap one to place it on the page.');
  }

  function removeAsset(kind, src) {
    var key = kind === 'pattern' ? 'patterns' : 'images';
    project[key] = project[key].filter(function (a) { return a.src !== src; });
    ilRefreshHostStrips(); scheduleSave();
  }

  /* ---------------- the host seam for the shared editor ---------------- */
  window.ScLookbookHost = {
    getPatterns: function () { return project ? project.patterns : []; },
    getImages: function () { return project ? project.images : []; },
    onChange: function () { scheduleSave(); },
    projectName: function () { return project && project.name; },
    removeAsset: removeAsset,
    collageTabNames: { mockups: 'images' },
    collageEmptyNotes: { mockups: 'no images yet — add some below with ＋ upload.' }
  };

  /* ---------------- saving ---------------- */
  function setStatus(kind, text) {
    var el = $('lbSaveStatus'); if (!el) return;
    el.className = 'lb-save-status' + (kind ? ' lb-' + kind : '');
    el.textContent = text || '';
  }

  // Cheap fingerprint of a big string so we don't hold a second copy of a many-MB project in memory.
  function fingerprint(str) {
    var h1 = 0x811c9dc5, h2 = 5381;
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = ((h2 << 5) + h2 + c) | 0; }
    return str.length + ':' + (h1 >>> 0).toString(36) + ':' + (h2 >>> 0).toString(36);
  }

  function snapshot() {
    return { patterns: project.patterns, images: project.images, lookbook: ilSerializeLookbook() };
  }

  function firstPageThumb() {
    var img = document.querySelector('#ilPageThumbnails .lookbook-page-thumb img');
    return img ? img.src : '';
  }

  function scheduleSave() {
    if (!project) return;
    setStatus('saving', 'saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 1200);
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!project) return saving;
    saving = saving.then(async function () {
      if (!project) return;
      try {
        var snap = snapshot();
        var key = fingerprint(JSON.stringify([project.name, snap]));
        if (key === lastSaved) { setStatus('saved', 'saved'); return; }
        project.lookbook = snap.lookbook;
        project.thumb = firstPageThumb() || project.thumb || '';
        await ScLookbookStore.put(project);
        lastSaved = key;
        setStatus('saved', 'saved ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
      } catch (e) {
        console.error('save failed', e);
        setStatus('error', 'not saved!');
        toast("couldn't save on this device — export a backup (.lookbook) so nothing is lost.");
      }
    });
    return saving;
  }

  // Safari clears unused site data after a while; ask for durable storage (silently ignored if refused).
  function requestPersistence() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }

  /* ---------------- screens ---------------- */
  function showStart() {
    $('lbWorkspace').hidden = true;
    $('lbStart').hidden = false;
    renderProjectList();
  }

  async function renderProjectList() {
    var box = $('lbProjectList');
    var rows = [];
    try { rows = await ScLookbookStore.list(); }
    catch (e) {
      box.innerHTML = '';
      var p = document.createElement('div'); p.className = 'lb-empty';
      p.textContent = "This browser isn't letting the app store lookbooks (private mode?). You can still work and export a backup (.lookbook).";
      box.appendChild(p); return;
    }
    box.innerHTML = '';
    if (!rows.length) {
      var e = document.createElement('div'); e.className = 'lb-empty';
      e.textContent = 'no lookbooks yet — tap “new lookbook” to start.';
      box.appendChild(e); return;
    }
    rows.forEach(function (r) {
      var card = document.createElement('div'); card.className = 'lb-card';
      var open = document.createElement('button'); open.type = 'button'; open.className = 'lb-card-open';
      open.setAttribute('aria-label', 'open ' + r.name);
      var th = document.createElement('div'); th.className = 'lb-card-thumb';
      if (r.thumb) th.style.backgroundImage = 'url("' + r.thumb + '")'; else th.textContent = 'blank page';
      var body = document.createElement('div'); body.className = 'lb-card-body';
      var nm = document.createElement('div'); nm.className = 'lb-card-name'; nm.textContent = r.name;
      var meta = document.createElement('div'); meta.className = 'lb-card-meta';
      meta.textContent = r.pages + (r.pages === 1 ? ' page' : ' pages') + ' · ' + fmtDate(r.updatedAt);
      body.appendChild(nm); body.appendChild(meta);
      open.appendChild(th); open.appendChild(body);
      open.addEventListener('click', function () { openById(r.id); });
      var acts = document.createElement('div'); acts.className = 'lb-card-actions';
      var dup = document.createElement('button'); dup.type = 'button'; dup.className = 'secondary'; dup.textContent = 'duplicate';
      dup.addEventListener('click', async function () { await ScLookbookStore.duplicate(r.id); renderProjectList(); });
      var del = document.createElement('button'); del.type = 'button'; del.className = 'secondary lb-danger'; del.textContent = 'delete';
      del.addEventListener('click', async function () {
        if (!confirm('Delete “' + r.name + '”? This can’t be undone. (Tip: open it first and save a backup if you might want it again.)')) return;
        await ScLookbookStore.remove(r.id); renderProjectList();
      });
      acts.appendChild(dup); acts.appendChild(del);
      card.appendChild(open); card.appendChild(acts);
      box.appendChild(card);
    });
  }

  async function openProject(p) {
    project = p;
    project.patterns = project.patterns || [];
    project.images = project.images || [];
    project.lookbook = project.lookbook || { pages: [] };
    $('lbStart').hidden = true;
    $('lbWorkspace').hidden = false;
    $('lbProjectName').value = project.name || '';
    setStatus('', '');
    // First ever visit: show the Add panel so the upload buttons are discoverable.
    try { if (localStorage.getItem('il-tool-panel-open') === null) { localStorage.setItem('il-tool-panel-open', '1'); localStorage.setItem('il-tool-panel-group', 'add'); } } catch (e) {}
    await ilInit();
    await ilRestoreLookbook(project.lookbook);
    ilRefreshHostStrips();
    ilFitPage();
    if (!observing) { ilWatchChanges(); observing = true; }
    lastSaved = fingerprint(JSON.stringify([project.name, snapshot()]));
    requestPersistence();
  }

  async function openById(id) {
    var p = null;
    try { p = await ScLookbookStore.get(id); } catch (e) { console.error(e); }
    if (!p) { toast("couldn't open that lookbook."); renderProjectList(); return; }
    await openProject(p);
  }

  // `extra` lets a host (the suite bridge) set fields on the new project, e.g. { suiteProjectId, name }.
  async function newProject(extra) {
    var p = Object.assign({ id: ScLookbookStore.newId(), name: 'untitled lookbook', patterns: [], images: [], lookbook: { pages: [] } }, extra || {});
    try { await ScLookbookStore.put(p); } catch (e) { console.error(e); }
    await openProject(p);
    // a fresh project starts with one blank page; save it so it appears in the list straight away
    scheduleSave();
  }

  async function goHome() {
    await saveNow();
    project = null;
    showStart();
  }

  /* ---------------- project files (.lookbook) ---------------- */
  function projectFile() {
    var snap = snapshot();
    return {
      format: FORMAT, version: VERSION, savedAt: new Date().toISOString(),
      name: project.name, patterns: snap.patterns, images: snap.images, lookbook: snap.lookbook
    };
  }

  function downloadProjectFile() {
    if (!project) return;
    var json = JSON.stringify(projectFile());
    ilDownloadBlob(new Blob([json], { type: 'application/octet-stream' }), ilProjectFileStem() + '.lookbook');
    toast('backup saved — keep the .lookbook file somewhere safe.');
  }

  // Accepts our own .lookbook files and, as a bridge, a Quick Lookbook project (.mstudio) from Mock-up Studio:
  // its pages (pictures, text, palettes) and pattern collection come across as a new, editable project.
  async function importFile(file) {
    var text = await file.text();
    var data;
    try { data = JSON.parse(text); } catch (e) { toast("that file isn't a lookbook project."); return; }
    var p = null;
    if (data && data.format === FORMAT && data.lookbook) {
      p = { id: ScLookbookStore.newId(), name: data.name || 'imported lookbook', patterns: data.patterns || [], images: data.images || [], lookbook: data.lookbook };
    } else if (data && data.format === 'mstudio' && data.lookbook && data.lookbook.pages) {
      var pats = [];
      var coll = data.quickPatternCollection || [];
      for (var i = 0; i < coll.length; i++) {
        try { if (coll[i] && coll[i].src) pats.push(await makeAsset(coll[i].src, coll[i].name || 'pattern', '')); } catch (e) {}
      }
      p = { id: ScLookbookStore.newId(), name: 'Quick Lookbook import', patterns: pats, images: [], lookbook: { pages: data.lookbook.pages } };
    } else { toast("that file isn't a lookbook project."); return; }
    try { await ScLookbookStore.put(p); } catch (e) { console.error(e); }
    await openProject(p);
    scheduleSave();
    toast('opened “' + p.name + '”.');
  }

  /* ---------------- wiring ---------------- */
  async function withBusy(btn, label, fn) {
    if (!btn || btn.disabled) return;
    var old = btn.textContent; btn.disabled = true; btn.textContent = label;
    try { await fn(); } catch (e) { console.error(e); toast('that export failed — please try again.'); }
    finally { btn.disabled = false; btn.textContent = old; }
  }

  function wire() {
    $('lbNewBtn').addEventListener('click', function () { newProject(); });
    $('lbOpenBtn').addEventListener('click', function () { $('lbFileOpen').click(); });
    $('lbOpenFileBtn').addEventListener('click', function () { $('lbFileOpen').click(); });
    $('lbFileOpen').addEventListener('change', async function (e) {
      var f = e.target.files && e.target.files[0]; e.target.value = '';
      if (f) { if (project) await saveNow(); await importFile(f); }
    });

    $('lbHomeBtn').addEventListener('click', goHome);
    $('lbSaveBtn').addEventListener('click', async function () { await saveNow(); });
    $('lbProjectName').addEventListener('input', function (e) { if (project) { project.name = e.target.value.trim() || 'untitled lookbook'; scheduleSave(); } });
    $('lbProjectName').addEventListener('keydown', function (e) { if (e.key === 'Enter') e.target.blur(); });

    $('lbUploadPatternsBtn').addEventListener('click', function () { $('lbFilePatterns').click(); });
    $('lbUploadImagesBtn').addEventListener('click', function () { $('lbFileImages').click(); });
    $('lbFilePatterns').addEventListener('change', async function (e) { var fs = e.target.files; await addFiles(fs, 'pattern'); e.target.value = ''; });
    $('lbFileImages').addEventListener('change', async function (e) { var fs = e.target.files; await addFiles(fs, 'image'); e.target.value = ''; });

    $('ilExportPngBtn').addEventListener('click', function () { withBusy($('ilExportPngBtn'), 'exporting…', ilExportPagePng); });
    $('lbExportJpgBtn').addEventListener('click', function () { withBusy($('lbExportJpgBtn'), 'exporting…', ilExportPageJpeg); });
    $('ilExportPdfBtn').addEventListener('click', function () {
      var b = $('ilExportPdfBtn');
      withBusy(b, 'building PDF…', function () { return ilExportAllPdf(function (i, n) { b.textContent = 'page ' + i + ' of ' + n + '…'; }); });
    });
    $('lbExportZipBtn').addEventListener('click', function () {
      var b = $('lbExportZipBtn');
      withBusy(b, 'building ZIP…', function () { return ilExportAllZip(function (i, n) { b.textContent = 'page ' + i + ' of ' + n + '…'; }); });
    });
    $('lbDownloadProjectBtn').addEventListener('click', downloadProjectFile);

    // Don't lose the last few seconds of work when the tab is hidden or closed.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') saveNow(); });
    window.addEventListener('pagehide', function () { saveNow(); });
  }

  wire();
  showStart();

  // test/debug hooks (read-only helpers; harmless in production)
  window.__lbApp = { openById: openById, saveNow: saveNow, getProject: function () { return project; }, importFile: importFile, goHome: goHome, newProject: newProject };
})();
