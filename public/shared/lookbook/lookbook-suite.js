/* Creative Lookbook — suite bridge.
 *
 * Does NOTHING unless the page was opened by the Seamlessly Creative shell (URL has ?project=<id>), so the
 * standalone Lookbook is unaffected. When active it:
 *   1. opens (or creates, once) the editable Lookbook that belongs to this suite project — saved by the
 *      Lookbook's own store exactly like the standalone app, just tagged with the suite project id;
 *   2. reads the project's assets from the suite's shared library (SCLibrary) at FULL resolution and adds
 *      them to the Lookbook's lists / asset tray (patterns, mock-ups, images, other). They are read, never
 *      modified, and are not copied into the saved Lookbook file; only pictures actually placed on a page
 *      are stored with it, like any uploaded picture. A "refresh" button picks up newly starred items;
 *   3. adds "send this page to project": a flattened image of the page goes into the library as kind
 *      'lookbook' — the kind Pattern Pages already receives through its own Refresh. The editable Lookbook
 *      is never overwritten.
 */
(function () {
  'use strict';
  var pid = null;
  try { pid = new URLSearchParams(location.search).get('project'); } catch (e) {}
  if (!pid) return;

  var suite = { patterns: [], images: [], srcs: {}, cache: {}, loadedAt: 0, count: 0, error: '' };
  function toast(m) { if (window.showToastMessage) window.showToastMessage(m); }
  function status(kind) { try { window.SCStatus && window.SCStatus.set(kind); } catch (e) {} }

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* ---------- project assets -> Lookbook asset lists ---------- */
  var PATTERN_KINDS = { pattern: 1, motif: 1, background: 1 };
  function category(a) {
    if (PATTERN_KINDS[a.kind]) return 'pattern';
    if (a.kind === 'mockup') return 'mockup';
    if (a.kind === 'graphic') return 'image';
    return 'other';                      // lookbook pages, resized exports, anything new
  }

  async function toItem(a) {
    var key = a.id + ':' + (a.updated || 0);
    if (suite.cache[key]) return suite.cache[key];
    var cat = category(a);
    // a half-brick / half-drop pattern repeats correctly only from its own seamless tile (same rule as Mock-up Studio)
    var fullBlob = cat === 'pattern' && a.repeatTile ? a.repeatTile : a.file;
    var src = await window.SCLibrary.blobToDataUrl(fullBlob);                 // original artwork, not a thumbnail
    var thumb = a.thumb ? await window.SCLibrary.blobToDataUrl(a.thumb).catch(function () { return null; }) : null;
    var it = { src: src, thumbSrc: thumb || undefined, name: a.name || a.kind, ar: a.width && a.height ? a.width / a.height : undefined, kind: cat, projectAsset: true, assetId: a.id };
    suite.cache[key] = it;
    return it;
  }

  async function loadAssets() {
    status('saving');
    try {
      var assets = await window.SCLibrary.listAssets(pid);
      var items = [];
      for (var i = 0; i < assets.length; i += 4) {
        items = items.concat(await Promise.all(assets.slice(i, i + 4).map(toItem)));
      }
      suite.patterns = items.filter(function (it) { return it.kind === 'pattern'; });
      suite.images = items.filter(function (it) { return it.kind !== 'pattern'; });
      suite.srcs = {}; items.forEach(function (it) { suite.srcs[it.src] = true; });
      suite.count = items.length; suite.error = ''; suite.loadedAt = Date.now();
      status('saved');
    } catch (e) {
      console.error('[lookbook] could not read project assets', e);
      suite.error = "couldn't read this project's assets";
      status('idle');
    }
    if (typeof ilRefreshHostStrips === 'function') ilRefreshHostStrips();
    return suite.count;
  }

  function extendHost() {
    var h = window.ScLookbookHost;
    var own = { getPatterns: h.getPatterns, getImages: h.getImages, removeAsset: h.removeAsset };
    h.getPatterns = function () { return own.getPatterns().concat(suite.patterns); };
    h.getImages = function () { return own.getImages().concat(suite.images); };
    h.removeAsset = function (kind, src) {
      if (suite.srcs[src]) { toast('that one belongs to your project — remove it from the project, not from the Lookbook.'); return; }
      return own.removeAsset(kind, src);
    };
    // delete one picture from the suite project (the shared library). Pages already using it keep their copy.
    h.deleteProjectAsset = async function (it) {
      var used = false;
      try { used = JSON.stringify(ilSerializeLookbook()).indexOf(it.src) >= 0; } catch (e) {}
      var msg = 'Delete “' + (it.name || 'this picture') + '” from the project?\n\n' +
        'It will also disappear from Mock-up Studio, Pattern Pages and the other studios in this project, and this can’t be undone.' +
        (used ? '\n\nIt is used on a page of this lookbook. The page keeps its own copy, but the original will be gone from the project.' : '');
      if (!confirm(msg)) return;
      try {
        await window.SCLibrary.deleteAsset(it.assetId);
        suite.cache = {};
        await loadAssets();
        toast('deleted from the project.');
      } catch (e) { console.error(e); toast("couldn't delete that one — please try again."); }
    };
    h.refreshAssets = async function () {
      var n = await loadAssets();
      toast(suite.error || (n + (n === 1 ? ' project asset' : ' project assets') + ' available.'));
    };
    h.assetsNote = function () { return suite.error || ''; };
    h.emptyNote = function (g) {
      return g === 'pattern' ? 'no patterns yet — star some to this project in Pattern Playground, then tap ↻ refresh.'
        : g === 'mockup' ? 'no mock-ups yet — send some to this project from Mock-up Studio, then tap ↻ refresh.'
        : 'nothing here yet — send artwork to this project, then tap ↻ refresh.';
    };
    h.collageEmptyNotes = { mockups: 'no images yet — see the asset tray below the page, or ＋ upload.' };
  }

  /* ---------- send this page to the project ---------- */
  function addSendBlock() {
    var group = document.getElementById('ilGroupExport');
    if (!group || document.getElementById('lbSendBlock')) return;
    var block = document.createElement('div');
    block.className = 'lookbook-tool-block'; block.id = 'lbSendBlock';
    block.innerHTML =
      '<h4>send to Pattern Pages</h4>' +
      '<label class="lookbook-row-label" for="lbSendSize">image size</label>' +
      '<select id="lbSendSize"><option value="1">standard (page size)</option><option value="2" selected>high quality (2×)</option><option value="3">extra large (3×)</option></select>' +
      '<button class="orange" id="lbSendBtn" type="button">send this page to project</button>' +
      '<p class="lookbook-tool-hint" id="lbSendStatus" aria-live="polite">a flat picture of this page goes into your project; open Pattern Pages and tap refresh. Your editable lookbook is not changed.</p>';
    var first = group.querySelector('.lookbook-tool-block');
    if (first) first.insertAdjacentElement('afterend', block); else group.appendChild(block);

    var btn = block.querySelector('#lbSendBtn'), st = block.querySelector('#lbSendStatus');
    btn.addEventListener('click', async function () {
      if (btn.disabled) return;
      btn.disabled = true; var old = btn.textContent; btn.textContent = 'sending…'; status('saving');
      try {
        var canvasEl = ilActiveCanvas();
        if (!canvasEl) throw new Error('no page');
        var n = ilActivePageIndex + 1, scale = Number(block.querySelector('#lbSendSize').value) || 2;
        var out = await ilRasterizeCanvas(canvasEl, scale, ilPages[ilActivePageIndex] && ilPages[ilActivePageIndex].bg);
        var blob = await ilCanvasToBlob(out, 'image/png');
        if (!blob) throw new Error('could not make the picture');
        var stem = (window.ScLookbookHost.projectName && window.ScLookbookHost.projectName()) || 'lookbook';
        var name = stem + ' – page ' + n;
        await window.SCLibrary.addAssetFromBlob(pid, blob, { kind: 'lookbook', name: name, source: { studio: 'lookbook', page: n } });
        st.textContent = '✓ sent “' + name + '” (' + out.width + ' × ' + out.height + ' px). In Pattern Pages, tap refresh in the project panel.';
        status('saved');
      } catch (e) {
        console.error('[lookbook] send to project failed', e);
        st.textContent = '⚠ couldn’t send this page — please try again.';
        status('idle');
      } finally { btn.disabled = false; btn.textContent = old; }
    });
  }

  /* ---------- boot ---------- */
  async function boot() {
    try {
      await loadScript('../../shared/project-library.js');
      await loadScript('../../shared/suite-status.js');
    } catch (e) { console.error(e); toast("couldn't reach the suite's project library."); return; }
    var app = window.__lbApp;
    if (!app) return;
    extendHost();
    addSendBlock();
    var rows = [];
    try { rows = (await ScLookbookStore.list()).filter(function (r) { return r.suiteProjectId === pid; }); } catch (e) { console.error(e); }
    if (rows.length) {
      await app.openById(rows[0].id);                        // newest Lookbook for this project
    } else {
      var proj = null; try { proj = await window.SCLibrary.getProject(pid); } catch (e) {}
      await app.newProject({ suiteProjectId: pid, name: proj && proj.name ? proj.name + ' lookbook' : 'untitled lookbook' });
    }
    loadAssets();
  }
  boot();
})();
