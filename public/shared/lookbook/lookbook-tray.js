/* Creative Lookbook — asset tray (shared by the standalone app and the suite version).
 *
 * A slim, collapsible shelf under the page showing every picture the host can offer, grouped as
 * patterns / mock-ups / images / other. Thumbnails are only for browsing; tapping one places the
 * ORIGINAL artwork (the host's `src`), never the thumbnail:
 *   - a collage is selected  -> the picture fills the selected empty frame, or becomes a new frame
 *   - nothing / something else selected -> it is placed on the page as a free picture
 *     (patterns as repeating swatches, everything else at its own proportions)
 *
 * Host items: getPatterns() -> kind 'pattern'; getImages() -> item.kind 'mockup' | 'image' | 'other'
 * (default 'image'). Optional host hooks: refreshAssets() -> Promise (shows a refresh button),
 * assetsNote() -> string shown under the chips (e.g. "from project: Café Latte").
 * Uses the editor's globals (ilHostPatterns, ilHostImages, ilCreateImageItem, ...), so load it after
 * lookbook-editor.js.
 */
(function () {
  'use strict';
  var GROUPS = [['pattern', 'patterns'], ['mockup', 'mock-ups'], ['image', 'images'], ['other', 'other']];
  var group = 'pattern', open = false, busy = false, renderToken = 0;

  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  // first visit: open on roomy screens, collapsed on short ones (iPad landscape) so the page keeps the room
  open = lsGet('il-tray-open', window.innerHeight >= 900 ? '1' : '0') === '1';
  group = lsGet('il-tray-group', 'pattern');

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function host() { return window.ScLookbookHost || {}; }

  async function collect() {
    var out = [];
    ilHostPatterns().forEach(function (p) { out.push(Object.assign({}, p, { kind: 'pattern' })); });
    (await ilHostImages()).forEach(function (p) {
      var k = p.kind === 'mockup' || p.kind === 'other' ? p.kind : 'image';
      out.push(Object.assign({}, p, { kind: k }));
    });
    return out;
  }

  function toast(m) { if (window.showToastMessage) window.showToastMessage(m); }

  async function place(it) {
    try {
      var col = typeof ilGetSelectedCollage === 'function' ? ilGetSelectedCollage() : null;
      if (col) {
        if (typeof ilMountCollagePanel === 'function') ilMountCollagePanel();
        if (typeof ilCollagePanel !== 'undefined' && ilCollagePanel && ilCollagePanel.addImages) {
          await ilCollagePanel.addImages([{ src: it.src, thumb: it.thumbSrc, name: it.name || '', kind: it.kind === 'pattern' ? 'pattern' : 'image', ar: it.ar }]);
          toast('added to the collage.');
          return;
        }
      }
      if (it.kind === 'pattern') {
        ilCreateImageItem({ src: it.src, x: 80, y: 80, w: 220, h: 220, hasPattern: true });
      } else {
        var a = it.ar;
        if (!a) { try { var im = await ilLoadImage(it.src); a = im.naturalWidth / (im.naturalHeight || 1); } catch (e) { a = 1; } }
        var w = a >= 1 ? 420 : Math.round(420 * a), h = a >= 1 ? Math.round(420 / a) : 420;
        ilCreateImageItem({ src: it.src, x: 120, y: 100, w: w, h: h, hasPattern: false });
      }
      ilNotifyChange();
    } catch (e) { console.error(e); toast("couldn't place that picture."); }
  }

  async function render() {
    var root = document.getElementById('ilAssetTray');
    if (!root) return;
    var token = ++renderToken;
    var items = await collect();
    if (token !== renderToken) return;           // a newer render superseded this one
    var counts = {}; GROUPS.forEach(function (g) { counts[g[0]] = 0; });
    items.forEach(function (it) { counts[it.kind]++; });
    var inSuite = !!host().refreshAssets;
    // standalone shows just patterns / images; the suite also shows mock-ups and other project assets
    var visible = GROUPS.filter(function (g) { return g[0] === 'pattern' || g[0] === 'image' || inSuite || counts[g[0]]; });
    if (!visible.some(function (g) { return g[0] === group; })) group = 'pattern';

    root.innerHTML = '';
    root.classList.toggle('collapsed', !open);

    var head = el('div', 'il-tray-head');
    var toggle = el('button', 'il-tray-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = (open ? '▾ ' : '▸ ') + 'assets (' + items.length + ')';
    toggle.addEventListener('click', function () { open = !open; lsSet('il-tray-open', open ? '1' : '0'); render(); });
    head.appendChild(toggle);

    if (open) {
      var chips = el('div', 'il-tray-chips');
      visible.forEach(function (g) {
        var c = el('button', 'il-chip' + (g[0] === group ? ' active' : ''), g[1] + ' ' + counts[g[0]]);
        c.type = 'button';
        c.addEventListener('click', function () { group = g[0]; lsSet('il-tray-group', group); render(); });
        chips.appendChild(c);
      });
      head.appendChild(chips);
      if (inSuite) {
        var rf = el('button', 'secondary il-tray-refresh', busy ? 'refreshing…' : '↻ refresh');
        rf.type = 'button'; rf.disabled = busy;
        rf.title = 'fetch anything newly starred to this project';
        rf.addEventListener('click', async function () {
          busy = true; render();
          try { await host().refreshAssets(); } catch (e) { console.error(e); toast("couldn't refresh the project assets."); }
          busy = false; render();
        });
        head.appendChild(rf);
      }
    }
    root.appendChild(head);

    if (!open) return;
    var shelf = el('div', 'il-tray-shelf');
    var mine = items.filter(function (it) { return it.kind === group; });
    if (!mine.length) {
      var note = (host().emptyNote && host().emptyNote(group)) ||
        (group === 'pattern' ? 'no patterns yet — add some from the Add panel.' : 'nothing here yet.');
      shelf.appendChild(el('p', 'il-tray-empty', note));
    }
    mine.forEach(function (it) {
      var t = el('button', 'il-tray-thumb');
      t.type = 'button';
      t.title = (it.name ? it.name + ' — ' : '') + 'tap to place';
      t.setAttribute('aria-label', 'place ' + (it.name || 'picture'));
      t.style.backgroundImage = 'url("' + (it.thumbSrc || it.src) + '")';
      t.addEventListener('click', function () { place(it); });
      shelf.appendChild(t);
    });
    root.appendChild(shelf);
    var s = host().assetsNote && host().assetsNote();
    if (s) root.appendChild(el('p', 'il-tray-note', s));
  }

  window.ilRenderAssetTray = render;
  // lookbook-editor.js's ilRefreshHostStrips() calls window.ilRenderAssetTray() so the tray follows uploads,
  // removals, host refreshes and project opens.
})();
