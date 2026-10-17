/**
 * Seamlessly Creative — shared Collage Builder panel (the UI).
 *
 * Builds the "Collage builder" tool group for ANY Lookbook flavour (suite,
 * standalone, Mock-up Studio's mini Lookbook). It uses the Lookbook's own
 * `.lookbook-tool-block` / `button.secondary` classes, so it looks native, and
 * talks to its host only through the small `ctx` object below — it never
 * reaches into a particular app's globals.
 *
 *   ScCollage.mountPanel(rootEl, ctx) -> { sync() }
 *
 * ctx:
 *   getCollage()        -> controller | null   (the selected collage on the page)
 *   createCollage()     -> controller          (adds a new, empty collage to the page)
 *   getSources(tab)     -> Promise<[{src, thumb?, name?, kind?}]>
 *                          tab: 'patterns' | 'mockups' | 'project'
 *   tabs                -> which of those tabs this host offers
 *   onBack()            -> go back to the host's Add panel
 *   deleteCollage(ctl)  -> remove the collage item
 * controller: { model, editor, commit(final), host?, item }   (host = the element the collage is drawn into)
 */
(function (global) {
  'use strict';
  var SC = global.ScCollage;
  if (!SC || SC.__panelLoaded) return;
  SC.__panelLoaded = true;

  /* ---------- user templates (arrangement only, never photos) ---------- */
  var TPL_KEY = 'scCollageTemplates:v1';
  SC.userTemplates = {
    list: function () { try { return JSON.parse(localStorage.getItem(TPL_KEY) || '[]'); } catch (e) { return []; } },
    save: function (arr) { try { localStorage.setItem(TPL_KEY, JSON.stringify(arr)); return true; } catch (e) { return false; } },
    add: function (tpl) { var a = this.list(); a.push(tpl); return this.save(a); },
    remove: function (id) { this.save(this.list().filter(function (t) { return t.id !== id; })); }
  };

  function ensureStyles() {
    if (document.getElementById('sccl-panel-css')) return;
    var st = document.createElement('style');
    st.id = 'sccl-panel-css';
    st.textContent =
      '.sccl-p{display:flex;flex-direction:column;gap:10px}' +
      '.sccl-p [hidden]{display:none!important}' +
      '.sccl-p .sccl-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
      '.sccl-p .sccl-row>*{flex:1 1 0;min-width:0}' +
      '.sccl-p .sccl-seg{display:flex;border:1px solid var(--border);border-radius:10px;overflow:hidden}' +
      '.sccl-p .sccl-seg button{flex:1;border:0;border-radius:0;padding:8px 6px;font-size:12px;background:transparent;color:var(--muted);cursor:pointer;min-height:36px}' +
      '.sccl-p .sccl-seg button.on{background:var(--accent);color:#fff}' +
      '.sccl-p .sccl-tpls{display:grid;grid-template-columns:repeat(4,1fr);gap:5px}' +
      '.sccl-p .sccl-tpl{padding:4px;min-height:40px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);' +
        'border-radius:8px;background:rgba(255,255,255,.06);cursor:pointer;color:var(--text,#e8ecff)}' +
      '.sccl-p .sccl-tpl.on{outline:2px solid var(--accent);background:rgba(138,122,255,.22)}' +
      '.sccl-p .sccl-ico{position:relative;width:30px;height:30px}' +
      '.sccl-p .sccl-ico span{position:absolute;background:currentColor;opacity:.8;border-radius:1px}' +
      '.sccl-p .sccl-chip{padding:7px 8px;font-size:11.5px;line-height:1.2;border:1px solid var(--border);border-radius:999px;background:transparent;color:var(--muted);cursor:pointer;min-height:32px}' +
      '.sccl-p .sccl-chip.on{background:var(--accent);color:#fff;border-color:transparent}' +
      '.sccl-p .sccl-chips{display:flex;flex-wrap:wrap;gap:5px}' +
      '.sccl-p .sccl-thumbs{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto}' +
      '.sccl-p .sccl-thumb{width:40px;height:40px;border-radius:8px;border:2px solid rgba(0,0,0,.4);box-shadow:0 0 0 1px rgba(255,255,255,.55);' +
        'background-size:cover;background-position:center;cursor:pointer;flex:0 0 auto}' +
      '.sccl-p .sccl-empty-note{font-size:11.5px;color:var(--muted);line-height:1.35}' +
      '.sccl-p details>summary{cursor:pointer;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);padding:2px 0;min-height:24px}' +
      '.sccl-p details[open]>summary{margin-bottom:6px}' +
      '.sccl-p .sccl-userTpl{display:flex;gap:4px;align-items:center}' +
      '.sccl-p .sccl-userTpl .sccl-chip{flex:1}' +
      '.sccl-p .sccl-x{flex:0 0 28px;padding:4px;min-height:28px;border-radius:50%;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer}';
    document.head.appendChild(st);
  }

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') e.className = props[k]; else if (k === 'text') e.textContent = props[k];
      else if (k === 'on') for (var ev in props.on) e.addEventListener(ev, props.on[ev]);
      else if (k === 'style') e.style.cssText = props[k];
      else e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function block(title, kids, cls) {
    return el('div', { class: 'lookbook-tool-block' + (cls ? ' ' + cls : '') }, [title ? el('h4', { text: title }) : null].concat(kids));
  }
  function btn(text, fn, extra) {
    return el('button', { type: 'button', class: 'secondary', text: text, on: { click: fn }, style: extra || '' });
  }
  function range(label, min, max, step, get, set, fmt) {
    var out = el('span', { text: fmt ? fmt(get()) : String(get()) });
    var inp = el('input', { type: 'range', min: min, max: max, step: step || 1 });
    inp.value = get();
    inp.addEventListener('input', function () { set(+inp.value, false); out.textContent = fmt ? fmt(+inp.value) : inp.value; });
    inp.addEventListener('change', function () { set(+inp.value, true); });
    var wrap = el('div', null, [el('label', null, [label + ' ', out]), inp]);
    wrap.__sync = function () { inp.value = get(); out.textContent = fmt ? fmt(get()) : String(get()); };
    return wrap;
  }

  function measure(src) {
    return new Promise(function (resolve) {
      var im = new Image();
      im.onload = function () { resolve({ ar: (im.naturalWidth / (im.naturalHeight || 1)) || 1, w: im.naturalWidth, h: im.naturalHeight }); };
      im.onerror = function () { resolve({ ar: 1 }); };
      im.src = src;
    });
  }

  // Read an uploaded file at full quality, but cap enormous images so a big
  // collage can't blow the iPad's memory/IndexedDB budget (4096px long edge).
  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onerror = reject;
      rd.onload = function () {
        var url = rd.result, im = new Image();
        im.onerror = function () { resolve({ src: url, ar: 1, name: file.name }); };
        im.onload = function () {
          var w = im.naturalWidth, h = im.naturalHeight, MAX = 4096;
          if (Math.max(w, h) <= MAX) return resolve({ src: url, ar: w / h, name: file.name });
          var s = MAX / Math.max(w, h), c = document.createElement('canvas');
          c.width = Math.round(w * s); c.height = Math.round(h * s);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          var png = /png|gif|webp/i.test(file.type);
          resolve({ src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.92), ar: w / h, name: file.name });
        };
        im.src = url;
      };
      rd.readAsDataURL(file);
    });
  }

  function iconFor(tmpl) {
    var wrap = el('span', { class: 'sccl-ico' });
    SC.gridLayout(tmpl, { x: 2, y: 2, w: 96, h: 96 }, 5, null).rects.forEach(function (r) {
      wrap.appendChild(el('span', { style: 'left:' + r.x + '%;top:' + r.y + '%;width:' + r.w + '%;height:' + r.h + '%' }));
    });
    return wrap;
  }

  SC.mountPanel = function (root, ctx) {
    ensureStyles();
    root.innerHTML = '';
    root.classList.add('sccl-p');

    var tab = (ctx.tabs && ctx.tabs[0]) || 'patterns';
    var fileInput = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', hidden: 'hidden' });
    var replaceInput = el('input', { type: 'file', accept: 'image/*', hidden: 'hidden' });
    var colorInput = el('input', { type: 'color', style: 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none' });
    root.appendChild(fileInput); root.appendChild(replaceInput); root.appendChild(colorInput);

    function ctl() { return ctx.getCollage(); }
    function done(final) { var c = ctl(); if (!c) return; c.editor.refresh(); c.commit(!!final); }
    function curSel() { var c = ctl(); return c ? c.editor.getSelection() : null; }
    function curObj() { var c = ctl(); return c ? c.editor.getSelectedObject() : null; }

    /* ---------- adding images ---------- */
    async function addImages(list) {
      if (!list.length) return;
      var c = ctl() || ctx.createCollage();
      for (var i = 0; i < list.length; i++) {
        var info = list[i];
        if (info.load && !info.src) { try { info = Object.assign({}, info, { src: await info.load() }); } catch (e) { console.error(e); continue; } }
        var m = info.ar ? { ar: info.ar } : await measure(info.src);
        var rec = { src: info.src, kind: info.kind || 'image', ar: m.ar, name: info.name || '' };
        var so = c.editor.getSelection() && c.editor.getSelection().type === 'slot' ? c.editor.getSelectedObject() : null;
        if (so && !so.src && i === 0) SC.setSlotImage(c.model, so, rec);
        else SC.addSlot(c.model, rec);
      }
      if (c.model.mode === 'layout') {
        if (c.model.autoPick) SC.setAutoBest(c.model);       // a fresh collage follows the photo count
        else if (c.model.layout.kind === 'template') SC.ensureCells(c.model);
      }
      c.editor.refresh(); c.commit(true); sync();
    }

    fileInput.addEventListener('change', async function () {
      var files = Array.prototype.slice.call(fileInput.files || []); fileInput.value = '';
      var out = [];
      for (var i = 0; i < files.length; i++) { try { var r = await readImageFile(files[i]); r.kind = uploadKind; out.push(r); } catch (e) { console.error(e); } }
      addImages(out);
    });
    var uploadKind = 'image';

    replaceInput.addEventListener('change', async function () {
      var f = replaceInput.files && replaceInput.files[0]; replaceInput.value = '';
      var o = curObj(), c = ctl(); if (!f || !o || !c || curSel().type !== 'slot') return;
      var r = await readImageFile(f);
      SC.setSlotImage(c.model, o, { src: r.src, ar: r.ar, kind: o.kind, name: r.name });
      done(true); sync();
    });

    /* ---------- static sections ---------- */
    var noCollageNote = el('p', { class: 'sccl-empty-note', text: 'pick photos below, or start from a layout. Everything stays editable — switch layouts or go freeform any time and no photo is lost.' });

    var tabNames = { patterns: 'patterns', mockups: 'mock-ups', project: 'project' };
    var tabsRow = el('div', { class: 'sccl-chips' });
    var thumbs = el('div', { class: 'sccl-thumbs' });
    var tabNote = el('p', { class: 'sccl-empty-note' });
    var cur = { list: [] };

    async function loadTab() {
      thumbs.innerHTML = ''; tabNote.textContent = 'loading…';
      var list = [];
      try { list = await ctx.getSources(tab); } catch (e) { console.error(e); }
      cur.list = list || [];
      tabNote.textContent = cur.list.length ? '' : (tab === 'patterns' ? 'no patterns yet — upload one below.' : tab === 'mockups' ? 'select mock-ups with the ✓ on any card first.' : 'no project assets yet.');
      cur.list.forEach(function (it) {
        var t = el('div', { class: 'sccl-thumb', title: it.name || 'add to collage', on: { click: function () { addImages([it]); } } });
        t.style.backgroundImage = 'url("' + (it.thumb || it.src) + '")';
        thumbs.appendChild(t);
      });
    }
    function buildTabs() {
      tabsRow.innerHTML = '';
      (ctx.tabs || ['patterns']).forEach(function (t) {
        tabsRow.appendChild(el('button', { type: 'button', class: 'sccl-chip' + (t === tab ? ' on' : ''), text: tabNames[t] || t, on: { click: function () { tab = t; buildTabs(); loadTab(); } } }));
      });
      tabsRow.appendChild(el('button', { type: 'button', class: 'sccl-chip', text: '＋ upload', on: { click: function () { uploadKind = 'image'; fileInput.click(); } } }));
      tabsRow.appendChild(el('button', { type: 'button', class: 'sccl-chip', text: '＋ seamless pattern', title: 'add as a repeating pattern', on: { click: function () { uploadKind = 'pattern'; fileInput.click(); } } }));
    }

    var imagesBlock = block('photos & patterns', [tabsRow, thumbs, tabNote,
      btn('+ add all shown', function () { addImages(cur.list.slice(0, 24)); })]);

    // layout
    var seg = el('div', { class: 'sccl-seg' });
    var segLayout = el('button', { type: 'button', text: 'Layout', on: { click: function () { setMode('layout'); } } });
    var segFree = el('button', { type: 'button', text: 'Freeform', on: { click: function () { setMode('free'); } } });
    seg.appendChild(segLayout); seg.appendChild(segFree);

    var tplGrid = el('div', { class: 'sccl-tpls' });
    SC.GRID_ORDER.forEach(function (id) {
      var b = el('button', { type: 'button', class: 'sccl-tpl', title: SC.GRID_TEMPLATES[id].cells.length + ' photos', 'data-id': id, on: { click: function () { applyGrid(id); } } }, [iconFor(SC.GRID_TEMPLATES[id])]);
      tplGrid.appendChild(b);
    });
    var autoRow = el('div', { class: 'sccl-row' }, [
      btn('✨ auto', function () { withCollage(function (c) { SC.setAutoBest(c.model); }); }),
      btn('auto-fit', function () { withCollage(function (c) { SC.setLayoutAuto(c.model); }); })
    ]);
    var freeChips = el('div', { class: 'sccl-chips' });
    SC.FREE_ORDER.forEach(function (id) {
      freeChips.appendChild(el('button', { type: 'button', class: 'sccl-chip', text: SC.FREE_PRESETS[id].name, on: { click: function () { withCollage(function (c) { SC.applyPreset(c.model, id); }); } } }));
    });
    var gutterRange = range('gutter', 0, 12, 0.5, function () { var c = ctl(); return c ? c.model.gutter : 2.5; }, function (v, f) { var c = ctl(); if (c) { c.model.gutter = v; done(f); } }, function (v) { return v + '%'; });
    var padRange = range('margin', 0, 15, 0.5, function () { var c = ctl(); return c ? c.model.pad : 3; }, function (v, f) { var c = ctl(); if (c) { c.model.pad = v; done(f); } }, function (v) { return v + '%'; });
    var radRange = range('corner radius', 0, 50, 1, function () { var c = ctl(); return c ? c.model.radius : 0; }, function (v, f) { var c = ctl(); if (c) { c.model.radius = v; done(f); } }, function (v) { return v + '%'; });
    var resetGridBtn = btn('reset grid sizes', function () { withCollage(function (c) { c.model.layout.colWeights = null; c.model.layout.rowWeights = null; }); });
    var gridHint = el('p', { class: 'sccl-empty-note', text: 'tap “edit pieces”, then drag the purple handles between cells to resize columns and rows.' });

    var layoutBlock = block('layout', [seg, tplGrid, autoRow, freeChips, gutterRange, padRange, radRange, resetGridBtn, gridHint]);

    function withCollage(fn) {
      var c = ctl() || ctx.createCollage();
      fn(c);
      c.editor.refresh(); c.commit(true); sync();
    }
    function applyGrid(id) { withCollage(function (c) { SC.setLayoutTemplate(c.model, id); }); }
    function setMode(mode) {
      withCollage(function (c) {
        var host = c.host || c.item.querySelector('.collage-host') || c.item;
        if (mode === 'free') SC.setFree(c.model, host.clientWidth, host.clientHeight);
        else { c.model.mode = 'layout'; SC.ensureCells(c.model); }
      });
    }

    // selected photo / decoration
    var fitSeg = el('div', { class: 'sccl-seg' });
    var fitFill = el('button', { type: 'button', text: 'fill', on: { click: function () { setSlot('fit', 'cover'); } } });
    var fitFit = el('button', { type: 'button', text: 'fit', on: { click: function () { setSlot('fit', 'contain'); } } });
    fitSeg.appendChild(fitFill); fitSeg.appendChild(fitFit);
    function setSlot(k, v) { var o = curObj(); if (!o) return; o[k] = v; done(true); sync(); }

    var zoomRange = range('zoom', 100, 300, 1, function () { var o = curObj(); return o && o.zoom ? Math.round(o.zoom * 100) : 100; },
      function (v, f) { var o = curObj(); if (!o) return; o.zoom = Math.max(1, v / 100); var mo = SC.maxOffset(o.zoom); o.offX = SC.clamp(o.offX || 0, -mo, mo); o.offY = SC.clamp(o.offY || 0, -mo, mo); done(f); }, function (v) { return v + '%'; });
    var kindSeg = el('div', { class: 'sccl-seg' });
    var kindRepeat = el('button', { type: 'button', text: 'repeat', on: { click: function () { setSlot('kind', 'pattern'); } } });
    var kindSingle = el('button', { type: 'button', text: 'single image', on: { click: function () { setSlot('kind', 'image'); } } });
    kindSeg.appendChild(kindRepeat); kindSeg.appendChild(kindSingle);
    var tileRange = range('pattern scale', 8, 100, 1, function () { var o = curObj(); return o && o.tile ? o.tile : 40; }, function (v, f) { var o = curObj(); if (o) { o.tile = v; done(f); } }, function (v) { return v + '%'; });
    var maskChips = el('div', { class: 'sccl-chips' });
    SC.MASKS.forEach(function (mk) {
      maskChips.appendChild(el('button', { type: 'button', class: 'sccl-chip', 'data-mask': mk, text: mk === 'rect' ? 'square' : mk, on: { click: function () { var o = curObj(); if (!o) return; o.mask = mk; done(true); sync(); } } }));
    });
    var maskAll = btn('apply shape to all photos', function () { var o = curObj(), c = ctl(); if (!o || !c) return; c.model.mask = o.mask || 'rect'; c.model.slots.forEach(function (s) { s.mask = null; }); done(true); sync(); });
    var borderRange = range('border', 0, 12, 0.5, function () { var o = curObj(); return o && o.border ? o.border.w : 0; }, function (v, f) { var o = curObj(); if (o) { o.border = o.border || { w: 0, color: '#ffffff' }; o.border.w = v; done(f); } }, function (v) { return v + '%'; });
    var borderColorBtn = btn('border colour…', function () { var o = curObj(); if (!o) return; colorInput.value = (o.border && o.border.color) || '#ffffff'; colorTarget = 'border'; colorInput.click(); });
    function makeShadow() { return range('shadow', 0, 100, 1, function () { var o = curObj(); return o ? o.shadow || 0 : 0; }, function (v, f) { var o = curObj(); if (o) { o.shadow = v; done(f); } }, function (v) { return v + '%'; }); }
    function layer(dir) { var s = curSel(), c = ctl(); if (!s || !c) return; SC.moveZ(c.model, s.id, dir); done(true); }
    function makeLayerRows() {
      return [
        el('div', { class: 'sccl-row' }, [btn('forward', function () { layer('up'); }), btn('back', function () { layer('down'); })]),
        el('div', { class: 'sccl-row' }, [btn('to front', function () { layer('front'); }), btn('to back', function () { layer('back'); })])
      ];
    }
    function removeSelected() {
      var s = curSel(), c = ctl(); if (!s || !c) return;
      if (s.type === 'decor') SC.removeDecor(c.model, s.id);
      else { SC.removeSlot(c.model, s.id); if (c.model.mode === 'layout') SC.ensureCells(c.model); }
      c.editor.select(null); done(true); sync();
    }
    var shadowRange = makeShadow(), decorShadow = makeShadow();
    var photoLayers = makeLayerRows(), decorLayers = makeLayerRows();
    var replaceBtn = btn('replace photo…', function () { replaceInput.click(); });
    var removePhotoBtn = btn('remove this photo', removeSelected);
    var decorColorBtn = btn('colour…', function () { var o = curObj(); if (!o) return; colorInput.value = o.color || '#ff8fb1'; colorTarget = 'decor'; colorInput.click(); });
    var decorOpacity = range('opacity', 10, 100, 1, function () { var o = curObj(); return o && o.opacity != null ? Math.round(o.opacity * 100) : 100; }, function (v, f) { var o = curObj(); if (o) { o.opacity = v / 100; done(f); } }, function (v) { return v + '%'; });

    var colorTarget = 'border';
    colorInput.addEventListener('input', function () {
      var o = curObj(), c = ctl(); if (!c) return;
      if (colorTarget === 'bg') { c.model.bg = { type: 'solid', color: colorInput.value }; done(false); return; }
      if (!o) return;
      if (colorTarget === 'border') { o.border = o.border || { w: 0, color: '#fff' }; o.border.color = colorInput.value; if (!o.border.w) o.border.w = 2; }
      else o.color = colorInput.value;
      done(false);
    });
    colorInput.addEventListener('change', function () { done(true); sync(); });

    var photoBlock = block('selected photo', [kindSeg, fitSeg, zoomRange, tileRange, replaceBtn, el('label', { text: 'shape' }), maskChips, maskAll, borderRange, borderColorBtn, shadowRange].concat(photoLayers).concat([removePhotoBtn]));
    var decorBlock = block('selected decoration', [decorColorBtn, decorOpacity, decorShadow].concat(decorLayers).concat([btn('delete decoration', removeSelected)]));

    // decorations (details)
    var decorKinds = el('div', { class: 'sccl-chips' });
    SC.DECOR_KINDS.forEach(function (k) {
      decorKinds.appendChild(el('button', { type: 'button', class: 'sccl-chip', text: k, on: { click: function () {
        var c = ctl() || ctx.createCollage();
        var d = SC.addDecor(c.model, k);
        c.editor.setEditing(true); c.editor.select({ type: 'decor', id: d.id }); c.commit(true); sync();
      } } }));
    });
    var decorDetails = el('details', null, [el('summary', { text: 'decorations' }), decorKinds]);

    // templates (details)
    var tplList = el('div', { style: 'display:flex;flex-direction:column;gap:5px' });
    var saveTplBtn = btn('save this layout as a template', function () {
      var c = ctl(); if (!c) return;
      var name = (global.prompt && global.prompt('name this collage template:', 'my collage')) || '';
      if (!name.trim()) return;
      if (!SC.userTemplates.add(SC.toTemplate(c.model, name.trim()))) alert('could not save the template — browser storage is full.');
      renderTpls();
    });
    function renderTpls() {
      tplList.innerHTML = '';
      var list = SC.userTemplates.list();
      if (!list.length) tplList.appendChild(el('p', { class: 'sccl-empty-note', text: 'no saved templates yet. Templates keep the arrangement and style — never the photos.' }));
      list.forEach(function (t) {
        tplList.appendChild(el('div', { class: 'sccl-userTpl' }, [
          el('button', { type: 'button', class: 'sccl-chip', text: t.name, title: 'apply to this collage (your photos stay)', on: { click: function () { withCollage(function (c) { SC.applyTemplate(c.model, t); }); } } }),
          el('button', { type: 'button', class: 'sccl-x', text: '×', title: 'delete template', on: { click: function () { SC.userTemplates.remove(t.id); renderTpls(); } } })
        ]));
      });
    }
    var tplDetails = el('details', null, [el('summary', { text: 'my collage templates' }), saveTplBtn, tplList]);

    // collage-level
    var editBtn = btn('✎ edit pieces', function () {
      var c = ctl(); if (!c) return;
      c.editor.setEditing(!c.editor.isEditing()); sync();
    });
    var bgBtn = btn('collage background…', function () { var c = ctl(); if (!c) return; colorInput.value = c.model.bg.color || '#ffffff'; colorTarget = 'bg'; colorInput.click(); });
    var bgClear = btn('no background', function () { var c = ctl(); if (c) { c.model.bg = { type: 'none', color: '#ffffff' }; done(true); } });
    var unplaced = el('p', { class: 'sccl-empty-note' });
    var delBtn = btn('delete collage', function () { var c = ctl(); if (c && confirm('delete this whole collage?')) ctx.deleteCollage(c); });
    var collageBlock = block('this collage', [editBtn, unplaced, bgBtn, bgClear, delBtn]);

    var backBtn = btn('‹ back to Add', function () { ctx.onBack(); });
    var newBtn = btn('+ new empty collage', function () { ctx.createCollage(); sync(); });

    root.appendChild(backBtn);
    root.appendChild(noCollageNote);
    root.appendChild(newBtn);
    root.appendChild(imagesBlock);
    root.appendChild(layoutBlock);
    root.appendChild(photoBlock);
    root.appendChild(decorBlock);
    root.appendChild(collageBlock);
    root.appendChild(el('div', { class: 'lookbook-tool-block' }, [decorDetails, tplDetails]));

    function sync() {
      var c = ctl(), s = c ? c.editor.getSelection() : null, o = c ? c.editor.getSelectedObject() : null;
      noCollageNote.hidden = !!c; newBtn.hidden = !!c;
      collageBlock.hidden = !c;
      var isFree = c && c.model.mode === 'free';
      segLayout.classList.toggle('on', !!c && !isFree); segFree.classList.toggle('on', !!isFree);
      var kind = c && c.model.layout.kind, tid = c && c.model.layout.templateId;
      Array.prototype.forEach.call(tplGrid.children, function (b) { b.classList.toggle('on', !!c && !isFree && kind === 'template' && b.getAttribute('data-id') === tid); });
      tplGrid.hidden = isFree; autoRow.hidden = isFree; gutterRange.hidden = isFree; padRange.hidden = isFree;
      resetGridBtn.hidden = isFree || !(c && kind === 'template'); gridHint.hidden = isFree || !(c && kind === 'template');
      freeChips.hidden = !isFree;
      [gutterRange, padRange, radRange].forEach(function (r) { r.__sync && r.__sync(); });
      editBtn.textContent = c && c.editor.isEditing() ? '✓ done editing pieces' : '✎ edit pieces';

      var isSlot = !!(s && s.type === 'slot' && o), isDecor = !!(s && s.type === 'decor' && o);
      photoBlock.hidden = !isSlot; decorBlock.hidden = !isDecor;
      if (isSlot) {
        var pat = o.kind === 'pattern';
        kindSeg.hidden = !o.src; kindRepeat.classList.toggle('on', pat); kindSingle.classList.toggle('on', !pat);
        fitSeg.hidden = pat || !o.src; fitFill.classList.toggle('on', o.fit !== 'contain'); fitFit.classList.toggle('on', o.fit === 'contain');
        zoomRange.hidden = pat || !o.src; tileRange.hidden = !pat;
        var eff = o.mask || c.model.mask || 'rect';
        Array.prototype.forEach.call(maskChips.children, function (b) { b.classList.toggle('on', b.getAttribute('data-mask') === eff); });
        photoLayers.forEach(function (r) { r.hidden = !isFree; });
        [zoomRange, tileRange, borderRange, shadowRange].forEach(function (r) { r.__sync && r.__sync(); });
      }
      if (isDecor) [decorOpacity, decorShadow].forEach(function (r) { r.__sync && r.__sync(); });
      var hidden = c ? c.model.slots.filter(function (sl, i) {
        var r = c.editor.getResolved(); var it = r && r.items.filter(function (x) { return x.slot === sl; })[0]; return sl.src && it && !it.visible;
      }).length : 0;
      unplaced.hidden = !hidden;
      unplaced.textContent = hidden ? hidden + ' photo' + (hidden > 1 ? 's' : '') + ' not shown by this layout (kept safe — pick a bigger layout, auto-fit or Freeform to show ' + (hidden > 1 ? 'them' : 'it') + ').' : '';
    }

    buildTabs(); renderTpls(); loadTab(); sync();
    return { sync: sync, reloadSources: loadTab };
  };
})(typeof window !== 'undefined' ? window : globalThis);
