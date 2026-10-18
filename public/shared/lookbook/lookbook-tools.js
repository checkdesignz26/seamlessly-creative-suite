/* Creative Lookbook — page tools (loaded AFTER lookbook-editor.js, which it extends through a few small hooks).
 *
 *   1. Decorative shapes as FREE page objects (not part of a collage): move anywhere, overlap anything, resize,
 *      rotate, fill / stroke / stroke width / opacity / no-fill / no-stroke. Saved, restored and exported.
 *   2. One shared colour-swatch component (the same swatches + custom picker for text, shape fill, shape stroke,
 *      page background and colours extracted from a collage picture).
 *   3. Colour extraction from the picture inside a collage frame (hook for the collage panel).
 *   4. Multi-select, alignment (left / centre / right / top / middle / bottom, relative to the page or to the
 *      selection), distribution, and OPTIONAL snapping with guide lines.
 *
 * It only uses the editor's own globals (ilActiveCanvas, ilSelectedItem, ilZoom, …) — nothing suite-specific.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ shapes */
  var SHAPES = ['diamond', 'circle', 'square', 'triangle', 'heart', 'star', 'hexagon', 'tape', 'line'];
  var POLYS = {
    diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    triangle: [[0.5, 0], [1, 1], [0, 1]],
    hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
    tape: [[.02, 0], [.98, 0], [1, .12], [.96, .25], [1, .37], [.96, .5], [1, .62], [.96, .75], [1, .88], [.98, 1], [.02, 1], [0, .88], [.04, .75], [0, .62], [.04, .5], [0, .37], [.04, .25], [0, .12]]
  };
  function starPoly() {
    var pts = [];
    for (var i = 0; i < 10; i++) {
      var r = i % 2 ? 0.2 : 0.5, a = -Math.PI / 2 + i * Math.PI / 5;   // outer radius 0.5 fills the box
      pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
    }
    return pts;
  }
  POLYS.star = starPoly();
  var HEART = 'M0.5,1 C0.15,0.72 0,0.52 0,0.30 C0,0.13 0.13,0 0.28,0 C0.38,0 0.46,0.05 0.5,0.14 C0.54,0.05 0.62,0 0.72,0 C0.87,0 1,0.13 1,0.30 C1,0.52 0.85,0.72 0.5,1 Z';

  function f2(n) { return (Math.round(n * 100) / 100).toString(); }

  // The ONE geometry function: its path string feeds both the live <svg> and the export's Path2D, so a shape
  // looks identical on screen and in PNG/PDF. The stroke is drawn inside the box (inset by half its width), so the
  // selection box is always the outer edge of what you see.
  function shapePath(kind, W, H, sw) {
    var i = Math.max(0, sw) / 2;
    var x0 = i, y0 = i, w = Math.max(1, W - 2 * i), h = Math.max(1, H - 2 * i);
    if (kind === 'line') return 'M' + f2(x0) + ',' + f2(H / 2) + ' L' + f2(x0 + w) + ',' + f2(H / 2);
    if (kind === 'circle') {
      var rx = w / 2, ry = h / 2, cx = x0 + rx, cy = y0 + ry;
      return 'M' + f2(cx - rx) + ',' + f2(cy) + ' A' + f2(rx) + ',' + f2(ry) + ' 0 1,0 ' + f2(cx + rx) + ',' + f2(cy) + ' A' + f2(rx) + ',' + f2(ry) + ' 0 1,0 ' + f2(cx - rx) + ',' + f2(cy) + ' Z';
    }
    if (kind === 'square') return 'M' + f2(x0) + ',' + f2(y0) + ' L' + f2(x0 + w) + ',' + f2(y0) + ' L' + f2(x0 + w) + ',' + f2(y0 + h) + ' L' + f2(x0) + ',' + f2(y0 + h) + ' Z';
    if (kind === 'heart') {
      return HEART.replace(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g, function (m, a, b) { return f2(x0 + parseFloat(a) * w) + ',' + f2(y0 + parseFloat(b) * h); });
    }
    var poly = POLYS[kind] || POLYS.diamond;
    return poly.map(function (p, n) { return (n ? 'L' : 'M') + f2(x0 + p[0] * w) + ',' + f2(y0 + p[1] * h); }).join(' ') + ' Z';
  }

  function shapeProps(item) {
    var d = item.dataset;
    return {
      kind: d.shape || 'diamond',
      fill: d.fill || '#ff8fb1', stroke: d.stroke || '#333333',
      strokeW: parseFloat(d.strokeW) || 0,
      fillOn: d.fillOn !== '0', strokeOn: d.strokeOn === '1'
    };
  }

  function updateShape(item) {
    var p = shapeProps(item), W = item.offsetWidth || 1, H = item.offsetHeight || 1;
    var svg = item.__svg;
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none');
      var path = document.createElementNS(NS, 'path');
      svg.appendChild(path); svg.__path = path;
      item.insertBefore(svg, item.firstChild);
      item.__svg = svg;
    }
    var sw = p.strokeOn ? p.strokeW : 0;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    var path2 = svg.__path;
    path2.setAttribute('d', shapePath(p.kind, W, H, sw));
    var isLine = p.kind === 'line';
    path2.setAttribute('fill', (p.fillOn && !isLine) ? p.fill : 'none');
    path2.setAttribute('stroke', p.strokeOn || isLine ? p.stroke : 'none');
    path2.setAttribute('stroke-width', String(isLine ? Math.max(1, p.strokeW || 4) : sw));
    path2.setAttribute('stroke-linejoin', 'round');
    path2.setAttribute('stroke-linecap', 'round');
  }

  function drawShapeItem(ctx, item, w, h) {
    var p = shapeProps(item), isLine = p.kind === 'line';
    var sw = p.strokeOn ? p.strokeW : 0;
    var path = new Path2D(shapePath(p.kind, w, h, sw));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (p.fillOn && !isLine) { ctx.fillStyle = p.fill; ctx.fill(path); }
    if ((p.strokeOn && sw > 0) || isLine) {
      ctx.strokeStyle = p.stroke; ctx.lineWidth = isLine ? Math.max(1, p.strokeW || 4) : sw; ctx.stroke(path);
    }
  }

  var shapeCount = 0;
  function createShapeItem(o) {
    o = o || {};
    var kind = SHAPES.indexOf(o.kind) >= 0 ? o.kind : 'diamond';
    var wide = kind === 'tape' || kind === 'line';
    var w = o.w || (kind === 'line' ? 300 : wide ? 260 : 180), h = o.h || (kind === 'line' ? 30 : wide ? 64 : 180);
    var n = shapeCount++ % 6;
    var x = o.x != null ? o.x : (IL_PAGE_W - w) / 2 + n * 18, y = o.y != null ? o.y : (IL_PAGE_H - h) / 2 + n * 18;
    var item = document.createElement('div');
    item.className = 'canvas-item shape-item';
    item.style.left = x + 'px'; item.style.top = y + 'px';
    item.style.width = w + 'px'; item.style.height = h + 'px';
    item.style.zIndex = o.zIndex || ++ilZIndexCounter;
    item.dataset.shape = kind;
    item.dataset.fill = o.fill || (kind === 'tape' ? '#f3d9a4' : kind === 'line' ? '#333333' : '#ff8fb1');
    item.dataset.stroke = o.stroke || (kind === 'line' ? '#333333' : '#ffffff');
    item.dataset.strokeW = String(o.strokeW != null ? o.strokeW : (kind === 'line' ? 4 : 6));
    item.dataset.fillOn = (o.fillOn === false || kind === 'line') ? '0' : '1';
    item.dataset.strokeOn = o.strokeOn ? '1' : '0';
    var rot = parseFloat(o.rotate != null ? o.rotate : (kind === 'tape' ? -12 : 0)) || 0;
    item.dataset.rotate = String(rot);
    if (rot) item.style.transform = 'rotate(' + rot + 'deg)';
    var op = o.opacity != null && o.opacity !== '' ? o.opacity : (kind === 'tape' ? 0.78 : '');
    if (op !== '') item.style.opacity = String(op);
    ilActiveCanvas().appendChild(item);
    ilAttachHandles(item);
    ilMakeItemDraggable(item);
    attachRotateHandle(item);
    updateShape(item);
    if (window.ResizeObserver) new ResizeObserver(function () { updateShape(item); }).observe(item);
    return item;
  }
  window.ilCreateShapeItem = createShapeItem;
  window.ilDrawShapeItem = drawShapeItem;

  // Rotation handle (touch-sized), shapes only. Same mouse+touch pattern as the resize handle.
  function attachRotateHandle(item) {
    var h = document.createElement('div');
    h.className = 'item-rotate-handle'; h.title = 'rotate'; h.textContent = '⟳';
    item.appendChild(h);
    var active = false, cx = 0, cy = 0;
    function pt(e) { return e.touches ? e.touches[0] : e; }
    function down(e) {
      e.stopPropagation(); e.preventDefault();
      ilSelectItem(item);
      var r = item.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      active = true;
      document.addEventListener('mousemove', move); document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('mouseup', up); document.addEventListener('touchend', up);
    }
    function move(e) {
      if (!active) return; e.preventDefault();
      var p = pt(e), a = Math.atan2(p.clientY - cy, p.clientX - cx) * 180 / Math.PI + 90;
      a = Math.round(((a % 360) + 360) % 360);
      var step = snapOn ? 15 : 0, near = [0, 45, 90, 135, 180, 225, 270, 315, 360];
      if (step) a = Math.round(a / step) * step;
      else near.forEach(function (s) { if (Math.abs(a - s) < 4) a = s; });
      setRotation(item, a % 360);
      syncShapeControls(item);
    }
    function up() {
      var was = active; active = false;
      document.removeEventListener('mousemove', move); document.removeEventListener('touchmove', move);
      document.removeEventListener('mouseup', up); document.removeEventListener('touchend', up);
      if (was) ilRenderSinglePageThumbnail(ilActivePageIndex);
    }
    h.addEventListener('mousedown', down); h.addEventListener('touchstart', down, { passive: false });
  }
  function setRotation(item, deg) {
    item.dataset.rotate = String(deg);
    item.style.transform = deg ? 'rotate(' + deg + 'deg)' : '';
  }

  /* ------------------------------------------------------------------ shared colour component */
  var extracted = [];              // colours pulled out of collage pictures this session
  var customCb = null;             // what the shared custom-colour input should do next
  function uniq(list) { var seen = {}; return list.filter(function (c) { var k = (c || '').toLowerCase(); if (!k || seen[k]) return false; seen[k] = 1; return true; }); }
  // Starter colours, so shapes and text always have a friendly range to choose from even before any pattern has been
  // uploaded; the page's own colours (from your patterns/images) and extracted colours come first.
  var STARTERS = ['#ff8fb1', '#f3c969', '#7fc8a9', '#6fa8dc', '#b39ddb', '#e57373', '#8d6e63', '#f5e6d3'];
  function paletteColours() { return uniq(extracted.concat(ilCurrentPalette || [], STARTERS)).slice(0, 26); }

  // strip: container element; active: currently applied colour (or null); onPick(hex); opts.none: show a "none" chip.
  function renderColourStrip(strip, active, onPick, opts) {
    if (!strip) return;
    opts = opts || {};
    strip.innerHTML = '';
    var act = (active || '').toLowerCase();
    paletteColours().forEach(function (color) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'il-sw' + (act && act === color.toLowerCase() ? ' active' : '');
      b.style.background = color; b.title = color; b.setAttribute('aria-label', 'colour ' + color);
      b.addEventListener('click', function () { onPick(color); renderColourStrip(strip, color, onPick, opts); });
      strip.appendChild(b);
    });
    var add = document.createElement('button');
    add.type = 'button'; add.className = 'il-sw il-sw-add'; add.title = 'pick any colour'; add.textContent = '+';
    add.addEventListener('click', function () {
      customCb = function (hex) { onPick(hex); renderColourStrip(strip, hex, onPick, opts); };
      var inp = $('ilCustomColorInput'); if (inp) { inp.value = /^#[0-9a-f]{6}$/i.test(act) ? act : '#ff8fb1'; inp.click(); }
    });
    strip.appendChild(add);
  }
  window.ilRenderColourStrip = renderColourStrip;
  window.ilPaletteColours = paletteColours;
  window.ilCustomColourHandler = function (hex) { if (customCb) { customCb(hex); return true; } return false; };

  function pageBgNow() { var pg = ilPages[ilActivePageIndex]; return pg && pg.bg && pg.bg.type === 'solid' ? pg.bg.color : null; }
  function setPageBg(hex) {
    var pg = ilPages[ilActivePageIndex]; if (!pg) return;
    ilSetPageBackground(pg, { type: 'solid', color: hex });
    var inp = $('ilPageBgColorInput'); if (inp) inp.value = hex;
  }

  // Apply one colour to whatever is selected: text -> text colour, shape -> fill, nothing -> page background.
  function applyColour(hex) {
    var it = ilSelectedItem;
    if (it && it.classList.contains('text-item')) { it.style.color = hex; ilRenderPaletteStrip(hex); toast('applied to the text'); }
    else if (it && it.classList.contains('shape-item')) { it.dataset.fill = hex; it.dataset.fillOn = '1'; updateShape(it); syncShapeControls(it); toast('applied as the shape fill'); }
    else { setPageBg(hex); renderBgStrip(); toast('applied as the page background'); }
    ilRenderSinglePageThumbnail(ilActivePageIndex);
    ilNotifyChange();
  }
  function toast(m) { try { showToastMessage(m); } catch (e) {} }

  function renderBgStrip() { renderColourStrip($('ilPageBgStrip'), pageBgNow(), setPageBg); }

  /* ------------------------------------------------------------------ colour extraction from a collage picture */
  async function extractFromSrc(src) {
    var img = await ilCollageLoadImage(src);
    var cols = ilExtractPaletteColors(img, 6);
    extracted = uniq(cols.concat(extracted)).slice(0, 12);
    renderExtractedBlock(cols);
    refreshAllStrips();
    return cols;
  }
  function renderExtractedBlock(cols) {
    var blk = $('ilExtractedBlock'); if (!blk) return;
    blk.hidden = !extracted.length;
    var strip = $('ilExtractedStrip');
    if (strip) {
      strip.innerHTML = '';
      (cols || extracted).forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'il-sw'; b.style.background = c; b.title = c;
        b.addEventListener('click', function () { applyColour(c); });
        strip.appendChild(b);
      });
    }
  }
  $('ilAddExtractedPaletteBtn') && $('ilAddExtractedPaletteBtn').addEventListener('click', async function () {
    if (!extracted.length) return;
    var colors = extracted.slice(0, 6), w = Math.max(180, colors.length * 56), h = 84;
    ilCreatePaletteItem({ colors: colors, x: (IL_PAGE_W - w) / 2, y: (IL_PAGE_H - h) / 2 });
    await ilRenderSinglePageThumbnail(ilActivePageIndex);
  });
  window.ilExtractColoursFromSrc = extractFromSrc;
  window.ilRefreshColourStrips = function () { refreshAllStrips(); };
  window.ilApplyColour = applyColour;

  /* ------------------------------------------------------------------ shape controls (Style panel) */
  function selShape() { return ilSelectedItem && ilSelectedItem.classList.contains('shape-item') ? ilSelectedItem : null; }
  function syncShapeControls(item) {
    var blk = $('ilShapeControls'); if (!blk) return;
    blk.hidden = !item;
    if (!item) return;
    var p = shapeProps(item), isLine = p.kind === 'line';
    $('ilShapeFillRow').hidden = isLine;
    $('ilShapeNoFillBtn').classList.toggle('on', !p.fillOn);
    $('ilShapeNoStrokeBtn').classList.toggle('on', !p.strokeOn && !isLine);
    $('ilShapeNoStrokeBtn').hidden = isLine;
    renderColourStrip($('ilShapeFillStrip'), p.fillOn ? p.fill : null, function (c) { var s = selShape(); if (!s) return; s.dataset.fill = c; s.dataset.fillOn = '1'; updateShape(s); syncShapeControls(s); commit(); });
    renderColourStrip($('ilShapeStrokeStrip'), p.strokeOn || isLine ? p.stroke : null, function (c) { var s = selShape(); if (!s) return; s.dataset.stroke = c; if (!isLine) { s.dataset.strokeOn = '1'; if (!(parseFloat(s.dataset.strokeW) > 0)) s.dataset.strokeW = '6'; } updateShape(s); syncShapeControls(s); commit(); });
    var sw = $('ilShapeStrokeWSlider'); sw.value = p.strokeW || 0; $('ilShapeStrokeWValue').textContent = (p.strokeW || 0) + 'px';
    var op = $('ilShapeOpacitySlider'); var ov = item.style.opacity === '' ? 100 : Math.round(parseFloat(item.style.opacity) * 100); op.value = ov; $('ilShapeOpacityValue').textContent = ov + '%';
    var rot = Math.round(parseFloat(item.dataset.rotate) || 0); $('ilShapeRotateSlider').value = ((rot % 360) + 360) % 360; $('ilShapeRotateValue').textContent = rot + '°';
  }
  function commit() { ilRenderSinglePageThumbnail(ilActivePageIndex); ilNotifyChange(); }

  $('ilShapeNoFillBtn') && $('ilShapeNoFillBtn').addEventListener('click', function () { var s = selShape(); if (!s) return; s.dataset.fillOn = s.dataset.fillOn === '0' ? '1' : '0'; updateShape(s); syncShapeControls(s); commit(); });
  $('ilShapeNoStrokeBtn') && $('ilShapeNoStrokeBtn').addEventListener('click', function () { var s = selShape(); if (!s) return; var on = s.dataset.strokeOn === '1'; s.dataset.strokeOn = on ? '0' : '1'; if (!on && !(parseFloat(s.dataset.strokeW) > 0)) s.dataset.strokeW = '6'; updateShape(s); syncShapeControls(s); commit(); });
  $('ilShapeStrokeWSlider') && $('ilShapeStrokeWSlider').addEventListener('input', function (e) { var s = selShape(); if (!s) return; var v = +e.target.value; s.dataset.strokeW = String(v); if (s.dataset.shape !== 'line') s.dataset.strokeOn = v > 0 ? '1' : '0'; updateShape(s); $('ilShapeStrokeWValue').textContent = v + 'px'; $('ilShapeNoStrokeBtn').classList.toggle('on', v === 0 && s.dataset.shape !== 'line'); });
  $('ilShapeStrokeWSlider') && $('ilShapeStrokeWSlider').addEventListener('change', commit);
  $('ilShapeOpacitySlider') && $('ilShapeOpacitySlider').addEventListener('input', function (e) { var s = selShape(); if (!s) return; var v = +e.target.value; s.style.opacity = v >= 100 ? '' : String(v / 100); $('ilShapeOpacityValue').textContent = v + '%'; });
  $('ilShapeOpacitySlider') && $('ilShapeOpacitySlider').addEventListener('change', commit);
  $('ilShapeRotateSlider') && $('ilShapeRotateSlider').addEventListener('input', function (e) { var s = selShape(); if (!s) return; setRotation(s, +e.target.value); $('ilShapeRotateValue').textContent = e.target.value + '°'; });
  $('ilShapeRotateSlider') && $('ilShapeRotateSlider').addEventListener('change', commit);

  // Text opacity (text colour + custom colours already existed; opacity is new)
  $('ilTextOpacitySlider') && $('ilTextOpacitySlider').addEventListener('input', function (e) {
    var t = ilSelectedItem; if (!t || !t.classList.contains('text-item')) return;
    var v = +e.target.value; t.style.opacity = v >= 100 ? '' : String(v / 100); $('ilTextOpacityValue').textContent = v + '%';
  });
  $('ilTextOpacitySlider') && $('ilTextOpacitySlider').addEventListener('change', commit);

  // Shape picker in the Add panel
  (function () {
    var wrap = $('ilShapeKinds'); if (!wrap) return;
    SHAPES.forEach(function (k) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'il-chip'; b.textContent = k; b.title = 'add a ' + k + ' — free to move anywhere';
      b.addEventListener('click', function () { addShape(k); });
      wrap.appendChild(b);
    });
  })();
  function addShape(kind) {
    var item = createShapeItem({ kind: kind });
    ilSelectItem(item);
    ilSetToolGroup('style');           // the colour controls live in Style
    ilRenderSinglePageThumbnail(ilActivePageIndex);
    return item;
  }
  window.ilAddShape = addShape;

  /* ------------------------------------------------------------------ selection hooks */
  var multiMode = false, snapOn = false;
  try { snapOn = localStorage.getItem('il-snap') === '1'; } catch (e) {}

  window.ilToolsOnSelect = function (item) {
    syncShapeControls(item.classList.contains('shape-item') ? item : null);
    var isText = item.classList.contains('text-item');
    var tb = $('ilTextOpacityRow'); if (tb) tb.hidden = !isText;
    if (isText) {
      var ov = item.style.opacity === '' ? 100 : Math.round(parseFloat(item.style.opacity) * 100);
      $('ilTextOpacitySlider').value = ov; $('ilTextOpacityValue').textContent = ov + '%';
    }
    renderBgStrip(); syncAlignUi();
  };
  window.ilToolsOnDeselect = function () {
    syncShapeControls(null);
    var tb = $('ilTextOpacityRow'); if (tb) tb.hidden = true;
    renderBgStrip(); syncAlignUi();
  };
  function refreshAllStrips() {
    if (ilSelectedItem && ilSelectedItem.classList.contains('text-item')) ilRenderPaletteStrip(ilSelectedItem.style.color);
    syncShapeControls(selShape()); renderBgStrip();
  }

  /* ------------------------------------------------------------------ multi-select */
  window.ilMultiSel = window.ilMultiSel || new Set();
  function clearMulti() { window.ilMultiSel.forEach(function (el) { el.classList.remove('multi-selected'); }); window.ilMultiSel.clear(); }
  function toggleMulti(item) {
    var set = window.ilMultiSel;
    // the item that is "selected" joins the set the first time a second one is added
    if (!set.size && ilSelectedItem && ilSelectedItem !== item) { set.add(ilSelectedItem); ilSelectedItem.classList.add('multi-selected'); }
    if (set.has(item)) { set.delete(item); item.classList.remove('multi-selected'); }
    else { set.add(item); item.classList.add('multi-selected'); }
    if (set.size === 1) { var only = Array.from(set)[0]; set.clear(); only.classList.remove('multi-selected'); ilSelectItem(only); }
    else if (set.size > 1) { ilSelectedItem = item; item.classList.add('selected'); }
    syncAlignUi();
  }
  window.ilClearMulti = clearMulti;
  window.ilToggleMulti = toggleMulti;
  window.ilIsMultiMode = function () { return multiMode; };
  function targets() { return window.ilMultiSel.size > 1 ? Array.from(window.ilMultiSel) : (ilSelectedItem ? [ilSelectedItem] : []); }

  $('ilMultiBtn') && $('ilMultiBtn').addEventListener('click', function () {
    multiMode = !multiMode; this.classList.toggle('on', multiMode); this.setAttribute('aria-pressed', String(multiMode));
    this.textContent = multiMode ? '✓ selecting several (tap items)' : '☑ select several';
    if (!multiMode) { var keep = ilSelectedItem; clearMulti(); if (keep) ilSelectItem(keep); }
    syncAlignUi();
  });
  $('ilSelectAllBtn') && $('ilSelectAllBtn').addEventListener('click', function () {
    var cv = ilActiveCanvas(); if (!cv) return;
    var all = Array.prototype.slice.call(cv.querySelectorAll('.canvas-item'));
    clearMulti();
    if (all.length < 2) { if (all[0]) ilSelectItem(all[0]); return; }
    all.forEach(function (el) { window.ilMultiSel.add(el); el.classList.add('multi-selected'); });
    ilSelectedItem = all[all.length - 1]; syncAlignUi();
  });

  /* ------------------------------------------------------------------ alignment */
  function boxOf(item) {
    var cv = ilActiveCanvas(), cr = cv.getBoundingClientRect(), r = item.getBoundingClientRect();
    return { l: (r.left - cr.left) / ilZoom, t: (r.top - cr.top) / ilZoom, w: r.width / ilZoom, h: r.height / ilZoom };
  }
  function nudge(item, dx, dy) {
    item.style.left = ((parseFloat(item.style.left) || 0) + dx) + 'px';
    item.style.top = ((parseFloat(item.style.top) || 0) + dy) + 'px';
  }
  function relTo() { var s = document.querySelector('#ilAlignRel button.on'); return s ? s.dataset.rel : 'page'; }
  function align(how) {
    var list = targets(); if (!list.length) return;
    var boxes = list.map(boxOf);
    var ref;
    if (list.length > 1 && relTo() === 'selection') {
      var l = Math.min.apply(null, boxes.map(function (b) { return b.l; })), t = Math.min.apply(null, boxes.map(function (b) { return b.t; }));
      var r = Math.max.apply(null, boxes.map(function (b) { return b.l + b.w; })), b2 = Math.max.apply(null, boxes.map(function (b) { return b.t + b.h; }));
      ref = { l: l, t: t, w: r - l, h: b2 - t };
    } else ref = { l: 0, t: 0, w: IL_PAGE_W, h: IL_PAGE_H };
    list.forEach(function (it, i) {
      var b = boxes[i], dx = 0, dy = 0;
      if (how === 'left') dx = ref.l - b.l;
      else if (how === 'center') dx = ref.l + ref.w / 2 - (b.l + b.w / 2);
      else if (how === 'right') dx = ref.l + ref.w - (b.l + b.w);
      else if (how === 'top') dy = ref.t - b.t;
      else if (how === 'middle') dy = ref.t + ref.h / 2 - (b.t + b.h / 2);
      else if (how === 'bottom') dy = ref.t + ref.h - (b.t + b.h);
      nudge(it, dx, dy);
    });
    commit();
  }
  function distribute(axis) {
    var list = targets(); if (list.length < 3) { toast('pick at least three objects to space them evenly'); return; }
    var rows = list.map(function (it) { return { it: it, b: boxOf(it) }; });
    var h = axis === 'h';
    rows.sort(function (a, b) { return h ? a.b.l - b.b.l : a.b.t - b.b.t; });
    var first = rows[0].b, last = rows[rows.length - 1].b;
    var start = h ? first.l : first.t, end = h ? last.l + last.w : last.t + last.h;
    var sum = rows.reduce(function (s, r) { return s + (h ? r.b.w : r.b.h); }, 0);
    var gap = (end - start - sum) / (rows.length - 1), pos = start;
    rows.forEach(function (r) {
      var size = h ? r.b.w : r.b.h;
      if (h) nudge(r.it, pos - r.b.l, 0); else nudge(r.it, 0, pos - r.b.t);
      pos += size + gap;
    });
    commit();
  }
  document.querySelectorAll('#ilAlignBlock [data-align]').forEach(function (b) { b.addEventListener('click', function () { align(b.dataset.align); }); });
  document.querySelectorAll('#ilAlignBlock [data-distribute]').forEach(function (b) { b.addEventListener('click', function () { distribute(b.dataset.distribute); }); });
  document.querySelectorAll('#ilAlignRel button').forEach(function (b) {
    b.addEventListener('click', function () { document.querySelectorAll('#ilAlignRel button').forEach(function (x) { x.classList.toggle('on', x === b); }); });
  });
  function syncAlignUi() {
    var n = targets().length, blk = $('ilAlignBlock'); if (!blk) return;
    blk.classList.toggle('il-disabled', n === 0);
    blk.querySelectorAll('button').forEach(function (b) { b.disabled = n === 0; });
    blk.querySelectorAll('[data-distribute]').forEach(function (b) { b.disabled = n < 3; });
    blk.querySelectorAll('#ilAlignRel button').forEach(function (b) { b.disabled = n < 2; });
    var note = $('ilAlignNote'); if (note) note.textContent = n === 0 ? 'select an object on the page to align it.' : n === 1 ? 'aligns the selected object to the page.' : n + ' objects selected — align to the page or to the selection.';
  }

  /* ------------------------------------------------------------------ optional snapping (+ guide lines) */
  function setSnap(on) {
    snapOn = on; try { localStorage.setItem('il-snap', on ? '1' : '0'); } catch (e) {}
    var b = $('ilSnapBtn'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '✓ snapping to guides: on' : 'snapping to guides: off'; }
  }
  $('ilSnapBtn') && $('ilSnapBtn').addEventListener('click', function () { setSnap(!snapOn); });
  setSnap(snapOn);

  function clearGuides() { document.querySelectorAll('.il-guide').forEach(function (g) { g.remove(); }); }
  function guide(axis, pos) {
    var cv = ilActiveCanvas(); if (!cv) return;
    var g = document.createElement('div'); g.className = 'il-guide il-guide-' + axis;
    if (axis === 'v') { g.style.left = pos + 'px'; } else { g.style.top = pos + 'px'; }
    cv.appendChild(g);
  }
  // Returns the snapped {left, top} for `item` being dragged to (l, t). Does nothing unless snapping is on.
  window.ilSnapPosition = function (item, l, t) {
    clearGuides();
    if (!snapOn) return { left: l, top: t };
    var w = item.offsetWidth, h = item.offsetHeight, TH = 7 / (ilZoom || 1);
    var xs = [0, IL_PAGE_W / 2, IL_PAGE_W], ys = [0, IL_PAGE_H / 2, IL_PAGE_H];
    var skip = window.ilMultiSel;
    ilActiveCanvas().querySelectorAll('.canvas-item').forEach(function (o) {
      if (o === item || skip.has(o)) return;
      var ol = parseFloat(o.style.left) || 0, ot = parseFloat(o.style.top) || 0;
      xs.push(ol, ol + o.offsetWidth / 2, ol + o.offsetWidth); ys.push(ot, ot + o.offsetHeight / 2, ot + o.offsetHeight);
    });
    function best(anchors, targetsArr) {
      var bestD = TH, shift = 0, at = null;
      anchors.forEach(function (a) { targetsArr.forEach(function (g) { var d = Math.abs(g - a); if (d < bestD) { bestD = d; shift = g - a; at = g; } }); });
      return { shift: shift, at: at };
    }
    var bx = best([l, l + w / 2, l + w], xs), by = best([t, t + h / 2, t + h], ys);
    if (bx.at != null) guide('v', bx.at);
    if (by.at != null) guide('h', by.at);
    return { left: l + bx.shift, top: t + by.shift };
  };
  window.ilClearGuides = clearGuides;

  /* ------------------------------------------------------------------ project round trip hooks */
  window.ilSerializeShape = function (item) {
    var p = shapeProps(item);
    return { type: 'shape', kind: p.kind, fill: p.fill, stroke: p.stroke, strokeW: p.strokeW, fillOn: p.fillOn, strokeOn: p.strokeOn,
      rotate: item.dataset.rotate || '0', opacity: item.style.opacity || '' };
  };
  window.ilRestoreShape = function (data, x, y) {
    return createShapeItem({
      kind: data.kind, x: x, y: y, w: parseFloat(data.width) || undefined, h: parseFloat(data.height) || undefined,
      fill: data.fill, stroke: data.stroke, strokeW: data.strokeW, fillOn: data.fillOn, strokeOn: data.strokeOn,
      rotate: data.rotate, opacity: data.opacity, zIndex: data.zIndex
    });
  };
  syncAlignUi();
})();
