/**
 * Seamlessly Creative — shared collage engine.
 *
 * One data model + layout/render engine for the Lookbook's Collage Builder.
 * It is deliberately independent of any one app's DOM: the suite Lookbook,
 * the standalone Lookbook and the mini Lookbook inside Mock-up Studio all load
 * this same file, so a collage built in one opens, edits and exports
 * identically in the others.
 *
 * REUSED FROM PATTERN PAGES (not rewritten): the 16 grid templates, their
 * cell-rect math (cols/rows/cell spans + colWeights/rowWeights + a real
 * gutter), the zoom/pan-inside-a-frame maths (ppCollageMaxOffset) and the
 * "auto-fit" justified-row packing (generateModularCollage). They are lifted
 * into one shared place here; tests/collage-parity.test.js parses Pattern
 * Pages' inline copy and fails if the two ever drift apart.
 *
 * THE MODEL (plain JSON, saved verbatim inside a .lookbook / .mstudio):
 *   {
 *     v: 1,
 *     mode: 'layout' | 'free',
 *     layout: { kind: 'template'|'auto', templateId, colWeights, rowWeights },
 *     gutter, pad, radius,         // % of the collage's shorter side
 *     mask: 'rect'|'ellipse'|...,  // collage-wide default; a slot may override
 *     bg: { type: 'none'|'solid', color },
 *     slots: [ { id, src, kind:'image'|'pattern', ar, name, fit, zoom, offX,
 *                offY, tile, mask, border:{w,color}, shadow, z, rot,
 *                free:{x,y,w,h,rot}, freeEdited } ],
 *     decor: [ { id, kind, x,y,w,h,rot, color, opacity, shadow, z } ]
 *   }
 *
 * WHY SWITCHING NEVER LOSES AN IMAGE: images live in `slots` (an ordered
 * list). The layout (grid / auto-fit) only decides where each slot is DRAWN;
 * it never owns the image. A template with fewer cells than images simply
 * leaves the extras "parked" (kept, not drawn); freeform geometry is
 * remembered per slot in `slot.free`, so toggling Layout <-> Freeform
 * round-trips both arrangements.
 *
 * All geometry in the model is a % of the collage box (free / decor) or is
 * derived from it at draw time (layout), so a collage scales with its item.
 */
(function (global) {
  'use strict';

  var SC = (global.ScCollage = global.ScCollage || {});
  if (SC.__engineLoaded) return;
  SC.__engineLoaded = true;
  var VERSION = 1;

  /* ------------------------------------------------------------------ *
   * Grid templates — VERBATIM from Pattern Pages (PP_COLLAGE_TEMPLATES).
   * ------------------------------------------------------------------ */
  var GRID_TEMPLATES = {
    'halves-v': { cols: 2, rows: 1, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }] },
    'halves-h': { cols: 1, rows: 2, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }] },
    'big-left': { cols: 2, rows: 2, cells: [{ c: 0, r: 0, cw: 1, rh: 2 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }] },
    'big-top': { cols: 2, rows: 2, cells: [{ c: 0, r: 0, cw: 2, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }] },
    'quadrants': { cols: 2, rows: 2, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }] },
    'quadrants-uneven': { cols: 2, rows: 2, colWeights: [0.56, 0.44], rowWeights: [0.58, 0.42], cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }] },
    'thirds': { cols: 3, rows: 1, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }] },
    'thirds-uneven': { cols: 3, rows: 1, colWeights: [0.42, 0.32, 0.26], cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }] },
    'big-plus-three': { cols: 2, rows: 3, cells: [{ c: 0, r: 0, cw: 1, rh: 3 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 1, r: 2, cw: 1, rh: 1 }] },
    'grid-six': { cols: 3, rows: 2, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 2, r: 1, cw: 1, rh: 1 }] },
    'grid-six-uneven': { cols: 3, rows: 2, colWeights: [0.40, 0.33, 0.27], rowWeights: [0.56, 0.44], cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 2, r: 1, cw: 1, rh: 1 }] },
    'grid-nine': { cols: 3, rows: 3, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 2, r: 1, cw: 1, rh: 1 }, { c: 0, r: 2, cw: 1, rh: 1 }, { c: 1, r: 2, cw: 1, rh: 1 }, { c: 2, r: 2, cw: 1, rh: 1 }] },
    'grid-nine-uneven': { cols: 3, rows: 3, colWeights: [0.40, 0.33, 0.27], rowWeights: [0.38, 0.34, 0.28], cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 2, r: 1, cw: 1, rh: 1 }, { c: 0, r: 2, cw: 1, rh: 1 }, { c: 1, r: 2, cw: 1, rh: 1 }, { c: 2, r: 2, cw: 1, rh: 1 }] },
    'hero-center': { cols: 3, rows: 3, colWeights: [0.30, 0.40, 0.30], rowWeights: [0.26, 0.40, 0.34], cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 2, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 0, r: 2, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 2 }, { c: 2, r: 1, cw: 1, rh: 1 }, { c: 2, r: 2, cw: 1, rh: 1 }] },
    'landscape-thirds': { cols: 1, rows: 3, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 0, r: 2, cw: 1, rh: 1 }] },
    'landscape-six': { cols: 2, rows: 3, cells: [{ c: 0, r: 0, cw: 1, rh: 1 }, { c: 1, r: 0, cw: 1, rh: 1 }, { c: 0, r: 1, cw: 1, rh: 1 }, { c: 1, r: 1, cw: 1, rh: 1 }, { c: 0, r: 2, cw: 1, rh: 1 }, { c: 1, r: 2, cw: 1, rh: 1 }] }
  };
  var GRID_ORDER = ['halves-v', 'halves-h', 'big-left', 'big-top', 'quadrants', 'quadrants-uneven', 'thirds', 'thirds-uneven', 'big-plus-three', 'grid-six', 'grid-six-uneven', 'grid-nine', 'grid-nine-uneven', 'hero-center', 'landscape-thirds', 'landscape-six'];

  /* Freeform starting points (new, % of the collage box). Applying one keeps
   * every image — extra images are cascaded, missing ones become empty slots. */
  var FREE_PRESETS = {
    'scatter': { name: 'scatter', slots: [
      { x: 4, y: 8, w: 44, h: 52, rot: -6 }, { x: 40, y: 4, w: 40, h: 46, rot: 5 },
      { x: 56, y: 40, w: 40, h: 50, rot: -4 }, { x: 8, y: 50, w: 38, h: 44, rot: 4 },
      { x: 34, y: 34, w: 32, h: 36, rot: -2 }] },
    'polaroid-stack': { name: 'stack', slots: [
      { x: 14, y: 10, w: 46, h: 58, rot: -8 }, { x: 34, y: 18, w: 46, h: 58, rot: 4 },
      { x: 24, y: 30, w: 46, h: 58, rot: -1 }] },
    'cascade': { name: 'cascade', slots: [
      { x: 3, y: 4, w: 40, h: 44, rot: 0 }, { x: 22, y: 20, w: 40, h: 44, rot: 0 },
      { x: 41, y: 36, w: 40, h: 44, rot: 0 }, { x: 58, y: 52, w: 38, h: 42, rot: 0 }] },
    'hero-minis': { name: 'hero + minis', slots: [
      { x: 4, y: 6, w: 60, h: 88, rot: 0 }, { x: 58, y: 8, w: 36, h: 26, rot: 3 },
      { x: 62, y: 36, w: 34, h: 26, rot: -3 }, { x: 58, y: 64, w: 36, h: 28, rot: 2 }] },
    'moodboard': { name: 'moodboard', slots: [
      { x: 3, y: 4, w: 34, h: 52, rot: 0 }, { x: 40, y: 4, w: 30, h: 30, rot: 2 },
      { x: 72, y: 6, w: 25, h: 40, rot: -2 }, { x: 40, y: 38, w: 36, h: 28, rot: 0 },
      { x: 6, y: 60, w: 30, h: 34, rot: -3 }, { x: 60, y: 62, w: 34, h: 32, rot: 3 }] }
  };
  var FREE_ORDER = ['scatter', 'polaroid-stack', 'cascade', 'hero-minis', 'moodboard'];

  var MASKS = ['rect', 'ellipse', 'arch', 'hexagon', 'diamond', 'heart'];
  var DECOR_KINDS = ['tape', 'circle', 'ring', 'square', 'heart', 'star', 'diamond', 'line'];

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  function uid(p) { return (p || 's') + Math.random().toString(36).slice(2, 9); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  // Same maths as Pattern Pages' ppCollageMaxOffset: how far (as % of the zoomed
  // photo's own box) it can pan before empty space would show.
  function maxOffset(zoom) {
    zoom = Math.max(1, zoom || 1);
    return zoom <= 1 ? 0 : (zoom - 1) / (2 * zoom) * 100;
  }

  /* ------------------------------------------------------------------ *
   * Model
   * ------------------------------------------------------------------ */
  function newSlot(src, extra) {
    var s = {
      id: uid('s'), src: src || null, kind: 'image', ar: 1, name: '',
      fit: 'cover', zoom: 1, offX: 0, offY: 0, tile: 40,
      mask: null, border: { w: 0, color: '#ffffff' }, shadow: 0,
      z: 0, rot: 0, free: null, freeEdited: false
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) s[k] = extra[k];
    return s;
  }

  function create(opts) {
    opts = opts || {};
    return {
      v: VERSION,
      mode: 'layout',
      layout: { kind: 'template', templateId: opts.templateId || 'quadrants', colWeights: null, rowWeights: null },
      gutter: 2.5, pad: 3, radius: 0, mask: 'rect', autoPick: false,
      bg: { type: 'none', color: '#ffffff' },
      slots: [], decor: [], nextZ: 1
    };
  }

  // Tolerant loader: anything saved by an older/newer build still opens.
  function normalize(m) {
    if (!m || typeof m !== 'object') return create();
    var out = create();
    out.mode = m.mode === 'free' ? 'free' : 'layout';
    if (m.layout) {
      out.layout.kind = m.layout.kind === 'auto' ? 'auto' : 'template';
      out.layout.templateId = GRID_TEMPLATES[m.layout.templateId] ? m.layout.templateId : 'quadrants';
      out.layout.colWeights = Array.isArray(m.layout.colWeights) ? m.layout.colWeights.slice() : null;
      out.layout.rowWeights = Array.isArray(m.layout.rowWeights) ? m.layout.rowWeights.slice() : null;
    }
    out.gutter = num(m.gutter, out.gutter); out.pad = num(m.pad, out.pad); out.radius = num(m.radius, 0);
    out.mask = MASKS.indexOf(m.mask) >= 0 ? m.mask : 'rect';
    out.autoPick = !!m.autoPick;
    if (m.bg) out.bg = { type: m.bg.type === 'solid' ? 'solid' : 'none', color: m.bg.color || '#ffffff' };
    out.slots = (m.slots || []).map(function (s) { return newSlot(s.src, clone(s)); });
    out.slots.forEach(function (s) { if (!s.id) s.id = uid('s'); });
    out.decor = (m.decor || []).map(function (d) { var x = clone(d); if (!x.id) x.id = uid('d'); return x; });
    var maxZ = 0;
    out.slots.concat(out.decor).forEach(function (o) { maxZ = Math.max(maxZ, num(o.z, 0)); });
    out.nextZ = Math.max(num(m.nextZ, 1), maxZ + 1);
    return out;
  }

  function cascadeGeom(i) {
    var n = i % 8;
    return { x: clamp(6 + n * 9, 0, 56), y: clamp(6 + n * 8, 0, 56), w: 38, h: 38, rot: (n % 2 ? 3 : -3) };
  }

  function findSlot(model, id) {
    for (var i = 0; i < model.slots.length; i++) if (model.slots[i].id === id) return model.slots[i];
    return null;
  }
  function findDecor(model, id) {
    for (var i = 0; i < model.decor.length; i++) if (model.decor[i].id === id) return model.decor[i];
    return null;
  }

  // Adds an image: fills the first EMPTY slot (so picking a template then adding
  // photos works naturally), otherwise appends a new slot. Never replaces a photo.
  function addSlot(model, info) {
    var slot = null;
    for (var i = 0; i < model.slots.length; i++) {
      if (!model.slots[i].src) { slot = model.slots[i]; break; }
    }
    if (!slot) {
      slot = newSlot(null);
      slot.free = cascadeGeom(model.slots.length);
      slot.z = model.nextZ++;
      model.slots.push(slot);
    }
    slot.src = info.src;
    slot.kind = info.kind === 'pattern' ? 'pattern' : 'image';
    slot.ar = info.ar > 0 ? info.ar : 1;
    slot.name = info.name || '';
    slot.zoom = 1; slot.offX = 0; slot.offY = 0;
    if (!slot.free) slot.free = cascadeGeom(model.slots.indexOf(slot));
    return slot;
  }

  function removeSlot(model, id) {
    model.slots = model.slots.filter(function (s) { return s.id !== id; });
  }
  function removeDecor(model, id) {
    model.decor = model.decor.filter(function (d) { return d.id !== id; });
  }

  function swapSlots(model, i, j) {
    if (i === j || !model.slots[i] || !model.slots[j]) return;
    var t = model.slots[i]; model.slots[i] = model.slots[j]; model.slots[j] = t;
  }

  function cellCount(model) {
    return model.layout.kind === 'template' ? GRID_TEMPLATES[model.layout.templateId].cells.length : Infinity;
  }

  // Ensure there is an (empty) slot for every cell of the chosen template, so the
  // user can see/tap each cell. Filled slots beyond the cell count are KEPT.
  function ensureCells(model) {
    var n = cellCount(model);
    if (n === Infinity) return;
    while (model.slots.length < n) {
      var s = newSlot(null);
      s.free = cascadeGeom(model.slots.length);
      s.z = model.nextZ++;
      model.slots.push(s);
    }
  }

  // Empty slots that would be hidden anyway (beyond the cell count) are dropped;
  // anything holding a photo is never dropped.
  function pruneEmptyBeyond(model) {
    var n = cellCount(model);
    if (n === Infinity) return;
    model.slots = model.slots.filter(function (s, i) { return i < n || s.src; });
  }

  function setLayoutTemplate(model, templateId) {
    if (!GRID_TEMPLATES[templateId]) return;
    model.mode = 'layout';
    model.autoPick = false;
    model.layout.kind = 'template';
    model.layout.templateId = templateId;
    model.layout.colWeights = null;
    model.layout.rowWeights = null;
    pruneEmptyBeyond(model);
    ensureCells(model);
  }

  // Justified auto-fit. Empty cells are pointless here, so they are dropped; every photo is kept.
  function setLayoutAuto(model) {
    model.mode = 'layout';
    model.autoPick = false;
    model.layout.kind = 'auto';
    model.layout.colWeights = null; model.layout.rowWeights = null;
    model.slots = model.slots.filter(function (s) { return s.src; });
  }

  // Picks the built-in template whose cell count matches the number of photos;
  // falls back to the justified-row auto-fit when none is an exact match.
  function bestTemplateIdFor(n) {
    var pref = { 1: null, 2: 'halves-v', 3: 'big-left', 4: 'quadrants', 5: null, 6: 'grid-six', 8: 'hero-center', 9: 'grid-nine' };
    return pref[n] || null;
  }
  function setAutoBest(model) {
    var n = model.slots.filter(function (s) { return s.src; }).length;
    var id = bestTemplateIdFor(n);
    if (id) setLayoutTemplate(model, id); else setLayoutAuto(model);
    model.autoPick = true;   // keep following the photo count as photos are added/removed
  }

  // Layout -> Freeform. Photos that were never freeform-edited start exactly where
  // the layout shows them; ones the user had already arranged freely snap back to
  // THAT arrangement (so toggling back and forth is lossless).
  function setFree(model, W, H) {
    if (model.mode !== 'free' && W > 0 && H > 0) {
      var r = resolve(model, W, H);
      r.items.forEach(function (it) {
        var s = it.slot;
        if (!s.freeEdited || !s.free) {
          if (it.visible) s.free = { x: it.x / W * 100, y: it.y / H * 100, w: it.w / W * 100, h: it.h / H * 100, rot: 0 };
          else if (!s.free) s.free = cascadeGeom(model.slots.indexOf(s));
        }
      });
    }
    model.slots.forEach(function (s, i) { if (!s.free) s.free = cascadeGeom(i); });
    model.mode = 'free';
    model.autoPick = false;
  }

  function applyPreset(model, presetId, W, H) {
    var p = FREE_PRESETS[presetId];
    if (!p) return;
    model.mode = 'free';
    model.autoPick = false;
    while (model.slots.length < p.slots.length) {
      var s = newSlot(null); s.z = model.nextZ++; model.slots.push(s);
    }
    model.slots.forEach(function (s, i) {
      var g = p.slots[i];
      s.free = g ? clone(g) : cascadeGeom(i);
      s.freeEdited = !!g;
      s.rot = 0;
    });
    model.slots.forEach(function (s, i) { s.z = i + 1; });
    model.nextZ = model.slots.length + 1;
  }

  function moveZ(model, id, dir) {
    var all = model.slots.concat(model.decor).sort(function (a, b) { return a.z - b.z; });
    var i = all.map(function (o) { return o.id; }).indexOf(id);
    if (i < 0) return;
    var item = all.splice(i, 1)[0];
    if (dir === 'front') all.push(item);
    else if (dir === 'back') all.unshift(item);
    else if (dir === 'up') all.splice(Math.min(all.length, i + 1), 0, item);
    else if (dir === 'down') all.splice(Math.max(0, i - 1), 0, item);
    all.forEach(function (o, k) { o.z = k + 1; });
    model.nextZ = all.length + 1;
  }

  function addDecor(model, kind) {
    var wide = kind === 'tape' || kind === 'line';
    var d = {
      id: uid('d'), kind: kind,
      x: wide ? 34 : 40, y: wide ? 44 : 38,
      w: kind === 'line' ? 30 : (wide ? 26 : 16),
      h: kind === 'line' ? 1.2 : (wide ? 6 : 16),
      rot: kind === 'tape' ? -12 : 0,
      color: kind === 'tape' ? '#f3d9a4' : '#ff8fb1',
      opacity: kind === 'tape' ? 0.78 : 1,
      shadow: 0, z: model.nextZ++
    };
    model.decor.push(d);
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Layout maths
   * ------------------------------------------------------------------ */
  // Ported from Pattern Pages' cellRects() (uniform grid + spans + weights),
  // now taking a pixel area and optional per-collage weight overrides.
  function weights(n, given) {
    var w = (given && given.length === n) ? given.slice() : new Array(n).fill(1 / n);
    var sum = w.reduce(function (a, b) { return a + b; }, 0) || 1;
    return w.map(function (x) { return x / sum; });
  }
  function gridLayout(tmpl, area, g, ovr) {
    var cols = tmpl.cols, rows = tmpl.rows;
    var usableW = area.w - g * (cols - 1), usableH = area.h - g * (rows - 1);
    var cw = (ovr && ovr.colWeights && ovr.colWeights.length === cols) ? ovr.colWeights : tmpl.colWeights;
    var rw = (ovr && ovr.rowWeights && ovr.rowWeights.length === rows) ? ovr.rowWeights : tmpl.rowWeights;
    var colW = weights(cols, cw).map(function (w) { return w * usableW; });
    var rowH = weights(rows, rw).map(function (w) { return w * usableH; });
    var colX = [area.x]; for (var i = 0; i < cols - 1; i++) colX.push(colX[i] + colW[i] + g);
    var rowY = [area.y]; for (var j = 0; j < rows - 1; j++) rowY.push(rowY[j] + rowH[j] + g);
    var rects = tmpl.cells.map(function (cell) {
      var cs = cell.cw || 1, rs = cell.rh || 1, w = 0, h = 0, a, b;
      for (a = 0; a < cs; a++) w += colW[cell.c + a]; w += g * (cs - 1);
      for (b = 0; b < rs; b++) h += rowH[cell.r + b]; h += g * (rs - 1);
      return { x: colX[cell.c], y: rowY[cell.r], w: w, h: h };
    });
    return { rects: rects, colX: colX, rowY: rowY, colW: colW, rowH: rowH, g: g, cols: cols, rows: rows, area: area };
  }

  // Justified rows (the Google-Photos/Flickr technique Pattern Pages' auto-fit uses):
  // each photo keeps its own proportions, rows are sized to fill the area.
  function packRows(aspects, totalW, gutter, targetH) {
    var rows = [], cur = [];
    function pushRow(h) {
      rows.push({ h: h, items: cur.map(function (c) { return { i: c.i, w: c.ar * h }; }) });
      cur = [];
    }
    function closeFullRow() {
      var sum = cur.reduce(function (s, c) { return s + c.ar; }, 0);
      var h = (totalW - gutter * (cur.length - 1)) / sum;
      pushRow(h);
    }
    aspects.forEach(function (ar, i) {
      cur.push({ i: i, ar: ar });
      var widthAtTarget = cur.reduce(function (s, c) { return s + c.ar * targetH; }, 0) + gutter * (cur.length - 1);
      if (widthAtTarget >= totalW) closeFullRow();
    });
    if (cur.length) pushRow(targetH);
    return rows;
  }
  function totalHeightOf(rows, gutter) { return rows.reduce(function (a, r) { return a + r.h; }, 0) + gutter * (rows.length - 1); }
  function justify(aspects, totalW, desiredH, gutter) {
    var lo = 0.5, hi = desiredH * Math.max(3, aspects.length);
    var best = packRows(aspects, totalW, gutter, (lo + hi) / 2), bestDiff = Infinity;
    for (var iter = 0; iter < 30; iter++) {
      var mid = (lo + hi) / 2;
      var rows = packRows(aspects, totalW, gutter, mid);
      var diff = Math.abs(totalHeightOf(rows, gutter) - desiredH);
      if (diff < bestDiff) { bestDiff = diff; best = rows; }
      if (totalHeightOf(rows, gutter) > desiredH) hi = mid; else lo = mid;
    }
    return best;
  }
  function rowsToRects(rows, area, gutter) {
    var n = rows.reduce(function (a, r) { return a + r.items.length; }, 0);
    var rects = new Array(n);
    var totalH = totalHeightOf(rows, gutter);
    // Uniform shrink if the best packing is still taller than the area: proportions are kept.
    var maxW = rows.reduce(function (m, r) { return Math.max(m, r.items.reduce(function (s, it) { return s + it.w; }, 0) + gutter * (r.items.length - 1)); }, 0);
    var fit = Math.min(1, area.h / (totalH || 1), area.w / (maxW || 1));
    var y = area.y + Math.max(0, (area.h - totalH * fit) / 2);
    rows.forEach(function (row) {
      var rowW = (row.items.reduce(function (s, it) { return s + it.w; }, 0) + gutter * (row.items.length - 1)) * fit;
      var x = area.x + Math.max(0, (area.w - rowW) / 2);
      row.items.forEach(function (it) {
        rects[it.i] = { x: x, y: y, w: it.w * fit, h: row.h * fit };
        x += it.w * fit + gutter * fit;
      });
      y += (row.h + gutter) * fit;
    });
    return rects;
  }

  /* resolve(): where is every slot drawn?  Pixel geometry inside a W x H box.
   * Returns { items:[{slot,x,y,w,h,rot,visible}], grid } — grid is set only for
   * template layouts (used by the editor's draggable dividers). */
  function resolve(model, W, H) {
    var items = [], grid = null;
    var minSide = Math.min(W, H);
    var pad = model.pad / 100 * minSide, g = model.gutter / 100 * minSide;
    var area = { x: pad, y: pad, w: Math.max(1, W - pad * 2), h: Math.max(1, H - pad * 2) };

    if (model.mode === 'free') {
      model.slots.forEach(function (s, i) {
        var f = s.free || cascadeGeom(i);
        items.push({ slot: s, x: f.x / 100 * W, y: f.y / 100 * H, w: f.w / 100 * W, h: f.h / 100 * H, rot: f.rot || 0, visible: true });
      });
    } else if (model.layout.kind === 'template') {
      var tmpl = GRID_TEMPLATES[model.layout.templateId] || GRID_TEMPLATES.quadrants;
      grid = gridLayout(tmpl, area, g, model.layout);
      model.slots.forEach(function (s, i) {
        var r = grid.rects[i];
        items.push(r ? { slot: s, x: r.x, y: r.y, w: r.w, h: r.h, rot: 0, visible: true, cell: i }
                     : { slot: s, x: 0, y: 0, w: 0, h: 0, rot: 0, visible: false });
      });
    } else {
      var idx = [], aspects = [];
      model.slots.forEach(function (s, i) { if (s.src) { idx.push(i); aspects.push(s.ar > 0 ? s.ar : 1); } });
      var rects = aspects.length ? rowsToRects(justify(aspects, area.w, area.h, g), area, g) : [];
      var byIndex = {};
      idx.forEach(function (si, k) { byIndex[si] = rects[k]; });
      model.slots.forEach(function (s, i) {
        var r = byIndex[i];
        items.push(r ? { slot: s, x: r.x, y: r.y, w: r.w, h: r.h, rot: 0, visible: true }
                     : { slot: s, x: 0, y: 0, w: 0, h: 0, rot: 0, visible: false });
      });
    }
    return { items: items, grid: grid };
  }

  /* ------------------------------------------------------------------ *
   * Masks — one definition, drawn by both the DOM and canvas renderers.
   * ------------------------------------------------------------------ */
  var HEART = 'M0.5,1 C0.15,0.72 0,0.52 0,0.30 C0,0.13 0.13,0 0.28,0 C0.38,0 0.46,0.05 0.5,0.14 C0.54,0.05 0.62,0 0.72,0 C0.87,0 1,0.13 1,0.30 C1,0.52 0.85,0.72 0.5,1 Z';
  var POLY = {
    hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
    diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    star: (function () {
      var pts = [];
      for (var i = 0; i < 10; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.22 : 0.5;
        pts.push([0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)]);
      }
      return pts;
    })()
  };
  function pct(n) { return (Math.round(n * 1000) / 10) + '%'; }
  function polyCss(name) { return 'polygon(' + POLY[name].map(function (p) { return pct(p[0]) + ' ' + pct(p[1]); }).join(',') + ')'; }

  // Traces the mask outline into ctx (path only — caller fills/clips/strokes).
  function tracePath(ctx, name, x, y, w, h, rPct) {
    ctx.beginPath();
    if (name === 'ellipse') { ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); }
    else if (name === 'arch') {
      var r = w / 2;
      ctx.moveTo(x, y + h); ctx.lineTo(x, y + r);
      ctx.arc(x + r, y + r, r, Math.PI, 0, false);
      ctx.lineTo(x + w, y + h); ctx.closePath();
    } else if (POLY[name]) {
      POLY[name].forEach(function (p, i) { var px = x + p[0] * w, py = y + p[1] * h; if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.closePath();
    } else if (name === 'heart') {
      var P = function (a, b) { return [x + a * w, y + b * h]; };
      var c = [
        ['M', 0.5, 1], ['C', 0.15, 0.72, 0, 0.52, 0, 0.30], ['C', 0, 0.13, 0.13, 0, 0.28, 0],
        ['C', 0.38, 0, 0.46, 0.05, 0.5, 0.14], ['C', 0.54, 0.05, 0.62, 0, 0.72, 0],
        ['C', 0.87, 0, 1, 0.13, 1, 0.30], ['C', 1, 0.52, 0.85, 0.72, 0.5, 1]
      ];
      c.forEach(function (seg) {
        if (seg[0] === 'M') { var m = P(seg[1], seg[2]); ctx.moveTo(m[0], m[1]); }
        else { var a = P(seg[1], seg[2]), b = P(seg[3], seg[4]), e = P(seg[5], seg[6]); ctx.bezierCurveTo(a[0], a[1], b[0], b[1], e[0], e[1]); }
      });
      ctx.closePath();
    } else {
      var rad = Math.max(0, Math.min(w, h) * (rPct || 0) / 100);
      if (rad <= 0) ctx.rect(x, y, w, h);
      else if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
      else {   // older Safari has no roundRect: same shape via arcTo, so export still matches the screen
        rad = Math.min(rad, w / 2, h / 2);
        ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
        ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
      }
    }
  }

  // CSS equivalent of the same mask, for the live DOM.
  function maskCss(name, rPct, w, h) {
    if (name === 'ellipse') return { borderRadius: '50%', clipPath: 'none' };
    if (name === 'arch') return { borderRadius: (w / 2) + 'px ' + (w / 2) + 'px 0 0', clipPath: 'none' };
    if (POLY[name]) return { borderRadius: '0', clipPath: polyCss(name) };
    if (name === 'heart') return { borderRadius: '0', clipPath: 'url(#sccl-heart-clip)' };
    return { borderRadius: Math.max(0, Math.min(w, h) * (rPct || 0) / 100) + 'px', clipPath: 'none' };
  }

  function shadowParams(i) {
    i = clamp(+i || 0, 0, 100);
    return { blur: i * 0.4, offY: i * 0.12, alpha: i ? 0.12 + i * 0.0028 : 0 };
  }
  function shadowCss(i) {
    if (!i) return 'none';
    var p = shadowParams(i);
    return 'drop-shadow(0 ' + p.offY.toFixed(1) + 'px ' + (p.blur / 2).toFixed(1) + 'px rgba(0,0,0,' + p.alpha.toFixed(3) + '))';
  }

  function effectiveMask(model, slot) { return slot.mask || model.mask || 'rect'; }
  function sortedByZ(arr) { return arr.slice().sort(function (a, b) { return a.z - b.z; }); }

  /* ------------------------------------------------------------------ *
   * DOM renderer (reconciling: elements are reused, so dragging is cheap and
   * large data-URL images are never re-assigned unless they changed).
   * ------------------------------------------------------------------ */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function ensureDefs() {
    if (document.getElementById('sccl-defs')) return;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'sccl-defs'; svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.innerHTML = '<defs><clipPath id="sccl-heart-clip" clipPathUnits="objectBoundingBox"><path d="' + HEART + '"/></clipPath></defs>';
    (document.body || document.documentElement).appendChild(svg);
  }

  function decorSvg(d) {
    var f = d.color || '#ff8fb1', k = d.kind;
    var inner;
    if (k === 'circle') inner = '<ellipse cx="50" cy="50" rx="50" ry="50" fill="' + f + '"/>';
    else if (k === 'ring') inner = '<ellipse cx="50" cy="50" rx="46" ry="46" fill="none" stroke="' + f + '" stroke-width="6" vector-effect="non-scaling-stroke" style="stroke-width:5px"/>';
    else if (k === 'heart') inner = '<path transform="scale(100)" d="' + HEART + '" fill="' + f + '"/>';
    else if (k === 'star') inner = '<polygon points="' + POLY.star.map(function (p) { return (p[0] * 100).toFixed(2) + ',' + (p[1] * 100).toFixed(2); }).join(' ') + '" fill="' + f + '"/>';
    else if (k === 'diamond') inner = '<polygon points="50,0 100,50 50,100 0,50" fill="' + f + '"/>';
    else if (k === 'tape') inner = '<polygon points="2,0 98,0 100,12 96,25 100,37 96,50 100,62 96,75 100,88 98,100 2,100 0,88 4,75 0,62 4,50 0,37 4,25 0,12" fill="' + f + '"/>';
    else inner = '<rect x="0" y="0" width="100" height="100" fill="' + f + '"/>';
    return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' + inner + '</svg>';
  }

  function ensureStyles() {
    if (document.getElementById('sccl-engine-css')) return;
    var st = document.createElement('style');
    st.id = 'sccl-engine-css';
    st.textContent =
      '.sccl-root{position:absolute;inset:0;overflow:visible;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}' +
      '.sccl-bg{position:absolute;inset:0;pointer-events:none}' +
      '.sccl-slot,.sccl-decor{position:absolute;box-sizing:border-box}' +
      '.sccl-clip{position:absolute;inset:0;overflow:hidden;background:transparent}' +
      '.sccl-img{position:absolute;left:50%;top:50%;max-width:none;pointer-events:none;-webkit-user-drag:none;user-select:none}' +
      '.sccl-pat{position:absolute;inset:0;background-repeat:repeat;pointer-events:none}' +
      '.sccl-border{position:absolute;inset:0;pointer-events:none}' +
      '.sccl-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
        'border:2px dashed rgba(120,120,140,.55);background:rgba(160,170,190,.16);color:rgba(90,95,115,.85);font:600 22px/1 system-ui,sans-serif;border-radius:inherit;box-sizing:border-box}' +
      '.sccl-root.sccl-editing .sccl-slot,.sccl-root.sccl-editing .sccl-decor{touch-action:none;cursor:grab}';
    document.head.appendChild(st);
  }

  function applyStyle(el, css) { for (var k in css) if (el.style[k] !== css[k]) el.style[k] = css[k]; }

  /**
   * renderDom(model, host, opts) — draws into `host` (an absolutely-positioned
   * box). opts.selectedId only adds a data attribute the editor styles.
   */
  function renderDom(model, host, opts) {
    opts = opts || {};
    ensureStyles(); ensureDefs();
    var W = host.clientWidth || host.offsetWidth || 1, H = host.clientHeight || host.offsetHeight || 1;
    var root = host.__scclRoot;
    if (!root) {
      root = document.createElement('div'); root.className = 'sccl-root';
      host.__scclRoot = root; host.appendChild(root);
      root.__scclBg = document.createElement('div'); root.__scclBg.className = 'sccl-bg'; root.appendChild(root.__scclBg);
      root.__scclEls = {};
    }
    applyStyle(root.__scclBg, { background: model.bg && model.bg.type === 'solid' ? model.bg.color : 'transparent' });

    var res = resolve(model, W, H);
    var alive = {};

    res.items.forEach(function (it) {
      var s = it.slot; alive[s.id] = true;
      var el = root.__scclEls[s.id];
      if (!el) {
        el = document.createElement('div'); el.className = 'sccl-slot'; el.dataset.id = s.id; el.dataset.type = 'slot';
        el.__clip = document.createElement('div'); el.__clip.className = 'sccl-clip'; el.appendChild(el.__clip);
        root.appendChild(el); root.__scclEls[s.id] = el;
      }
      if (!it.visible) { el.style.display = 'none'; return; }
      var maskName = effectiveMask(model, s);
      var m = maskCss(maskName, model.radius, it.w, it.h);
      applyStyle(el, {
        display: 'block', left: it.x + 'px', top: it.y + 'px', width: it.w + 'px', height: it.h + 'px',
        transform: it.rot ? 'rotate(' + it.rot + 'deg)' : 'none',
        zIndex: String(s.z || 0), filter: shadowCss(s.shadow)
      });
      applyStyle(el.__clip, { borderRadius: m.borderRadius, clipPath: m.clipPath, webkitClipPath: m.clipPath });

      var clip = el.__clip;
      if (!s.src) {
        if (!clip.__empty) { clip.innerHTML = '<div class="sccl-empty">+</div>'; clip.__empty = true; clip.__srcKey = null; }
      } else if (s.kind === 'pattern') {
        if (clip.__srcKey !== 'p:' + s.src) { clip.innerHTML = '<div class="sccl-pat"></div>'; clip.firstChild.style.backgroundImage = 'url("' + s.src + '")'; clip.__srcKey = 'p:' + s.src; clip.__empty = false; }
        applyStyle(clip.firstChild, { backgroundSize: (s.tile || 40) + '% auto' });
      } else {
        if (clip.__srcKey !== 'i:' + s.src) {
          clip.innerHTML = ''; var img = document.createElement('img'); img.className = 'sccl-img'; img.draggable = false; img.src = s.src;
          clip.appendChild(img); clip.__srcKey = 'i:' + s.src; clip.__empty = false;
        }
        var zoom = Math.max(1, s.zoom || 1);
        applyStyle(clip.firstChild, {
          width: (zoom * 100) + '%', height: (zoom * 100) + '%',
          objectFit: s.fit === 'contain' ? 'contain' : 'cover',
          transform: 'translate(calc(-50% + ' + (s.offX || 0) + '%), calc(-50% + ' + (s.offY || 0) + '%))'
        });
      }
      // border (drawn inside the clipped box so only its inner half shows). Box-like masks use an
      // inset box-shadow; heart/hexagon/diamond trace the real outline with an SVG stroke so the live
      // view matches the export exactly.
      var bd = clip.querySelector('.sccl-border');
      var bw = s.border && s.border.w > 0 ? s.border.w : 0;
      if (bw) {
        var px = bw / 100 * Math.min(it.w, it.h);
        var bkey = maskName + '|' + px.toFixed(2) + '|' + s.border.color;
        if (bd && bd.__key !== bkey) { bd.remove(); bd = null; }
        if (!bd) {
          bd = document.createElement('div'); bd.className = 'sccl-border'; bd.__key = bkey;
          if (maskName === 'heart' || POLY[maskName]) {
            var shape = maskName === 'heart'
              ? '<path transform="scale(100)" d="' + HEART + '"'
              : '<polygon points="' + POLY[maskName].map(function (p) { return (p[0] * 100) + ',' + (p[1] * 100); }).join(' ') + '"';
            bd.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">' +
              shape + ' fill="none" stroke="' + s.border.color + '" vector-effect="non-scaling-stroke" style="stroke-width:' + (px * 2) + 'px"/></svg>';
          } else {
            bd.style.boxShadow = 'inset 0 0 0 ' + px + 'px ' + s.border.color; bd.style.borderRadius = 'inherit';
          }
          clip.appendChild(bd);
        }
      } else if (bd) bd.remove();
    });

    model.decor.forEach(function (d) {
      alive[d.id] = true;
      var el = root.__scclEls[d.id];
      if (!el) {
        el = document.createElement('div'); el.className = 'sccl-decor'; el.dataset.id = d.id; el.dataset.type = 'decor';
        root.appendChild(el); root.__scclEls[d.id] = el;
      }
      var key = d.kind + '|' + d.color;
      if (el.__key !== key) { el.innerHTML = decorSvg(d); el.__key = key; }
      applyStyle(el, {
        left: d.x / 100 * W + 'px', top: d.y / 100 * H + 'px', width: d.w / 100 * W + 'px', height: d.h / 100 * H + 'px',
        transform: d.rot ? 'rotate(' + d.rot + 'deg)' : 'none', opacity: String(d.opacity == null ? 1 : d.opacity),
        zIndex: String(d.z || 0), filter: shadowCss(d.shadow)
      });
    });

    Object.keys(root.__scclEls).forEach(function (id) {
      if (!alive[id]) { root.__scclEls[id].remove(); delete root.__scclEls[id]; }
    });
    return res;
  }

  /* ------------------------------------------------------------------ *
   * Canvas renderer — what export, thumbnails and "send page to project" use.
   * Mirrors the DOM maths above exactly so an export matches the screen.
   * ------------------------------------------------------------------ */
  function drawFitted(ctx, img, w, h, slot) {
    var zoom = Math.max(1, slot.zoom || 1);
    var bw = w * zoom, bh = h * zoom;
    var cx = w / 2 + (slot.offX || 0) / 100 * bw, cy = h / 2 + (slot.offY || 0) / 100 * bh;
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    var sc = slot.fit === 'contain' ? Math.min(bw / iw, bh / ih) : Math.max(bw / iw, bh / ih);
    var dw = iw * sc, dh = ih * sc;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  }

  // Same behaviour as the Lookbook's ilDrawTiledPattern: tile width is a % of the BOX width.
  function drawTiled(ctx, img, w, h, tilePct) {
    var tw = Math.max(4, Math.round(w * (tilePct || 40) / 100));
    var th = Math.max(4, Math.round(tw * ((img.naturalHeight || img.height) / (img.naturalWidth || img.width) || 1)));
    var c = document.createElement('canvas'); c.width = tw; c.height = th;
    c.getContext('2d').drawImage(img, 0, 0, tw, th);
    ctx.fillStyle = ctx.createPattern(c, 'repeat');
    ctx.fillRect(0, 0, w, h);
  }

  function drawSlotContent(ctx, model, slot, img, w, h) {
    ctx.save();
    tracePath(ctx, effectiveMask(model, slot), 0, 0, w, h, model.radius);
    ctx.clip();
    if (slot.kind === 'pattern') drawTiled(ctx, img, w, h, slot.tile);
    else drawFitted(ctx, img, w, h, slot);
    var bw = slot.border && slot.border.w > 0 ? slot.border.w / 100 * Math.min(w, h) : 0;
    if (bw) {
      tracePath(ctx, effectiveMask(model, slot), 0, 0, w, h, model.radius);
      ctx.lineWidth = bw * 2; ctx.strokeStyle = slot.border.color; ctx.stroke();
    }
    ctx.restore();
  }

  function scaleOf(ctx) { var t = ctx.getTransform(); return Math.hypot(t.a, t.b) || 1; }

  function drawDecor(ctx, d, w, h) {
    ctx.save();
    ctx.globalAlpha *= (d.opacity == null ? 1 : d.opacity);
    var sp = shadowParams(d.shadow);
    if (d.shadow) { ctx.shadowColor = 'rgba(0,0,0,' + sp.alpha + ')'; ctx.shadowBlur = sp.blur; ctx.shadowOffsetY = sp.offY; }
    ctx.fillStyle = ctx.strokeStyle = d.color || '#ff8fb1';
    var k = d.kind;
    if (k === 'circle') { tracePath(ctx, 'ellipse', 0, 0, w, h); ctx.fill(); }
    else if (k === 'ring') { tracePath(ctx, 'ellipse', 3, 3, w - 6, h - 6); ctx.lineWidth = 5; ctx.stroke(); }
    else if (k === 'heart') { tracePath(ctx, 'heart', 0, 0, w, h); ctx.fill(); }
    else if (k === 'star' || k === 'diamond') { tracePath(ctx, k === 'star' ? 'star' : 'diamond', 0, 0, w, h); ctx.fill(); }
    else if (k === 'tape') {
      var pts = [[2, 0], [98, 0], [100, 12], [96, 25], [100, 37], [96, 50], [100, 62], [96, 75], [100, 88], [98, 100], [2, 100], [0, 88], [4, 75], [0, 62], [4, 50], [0, 37], [4, 25], [0, 12]];
      ctx.beginPath(); pts.forEach(function (p, i) { var x = p[0] / 100 * w, y = p[1] / 100 * h; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.fill();
    } else { ctx.fillRect(0, 0, w, h); }
    ctx.restore();
  }

  /**
   * drawCanvas(ctx, model, W, H, loadImage) — loadImage(src) -> Promise<HTMLImageElement>.
   * Draws into the current ctx transform with the box's top-left at (0,0).
   */
  async function drawCanvas(ctx, model, W, H, loadImage) {
    if (model.bg && model.bg.type === 'solid') { ctx.fillStyle = model.bg.color; ctx.fillRect(0, 0, W, H); }
    var res = resolve(model, W, H);
    var entries = [];
    res.items.forEach(function (it) { if (it.visible && it.slot.src) entries.push({ z: it.slot.z, kind: 'slot', it: it }); });
    model.decor.forEach(function (d) { entries.push({ z: d.z, kind: 'decor', d: d }); });
    entries.sort(function (a, b) { return a.z - b.z; });

    for (var n = 0; n < entries.length; n++) {
      var e = entries[n];
      if (e.kind === 'decor') {
        var d = e.d;
        ctx.save();
        ctx.translate(d.x / 100 * W + d.w / 200 * W, d.y / 100 * H + d.h / 200 * H);
        ctx.rotate((d.rot || 0) * Math.PI / 180);
        ctx.translate(-d.w / 200 * W, -d.h / 200 * H);
        drawDecor(ctx, d, d.w / 100 * W, d.h / 100 * H);
        ctx.restore();
        continue;
      }
      var it = e.it, s = it.slot, img = null;
      try { img = await loadImage(s.src); } catch (err) { console.error('collage export: image failed to load', err); continue; }
      ctx.save();
      ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
      ctx.rotate((it.rot || 0) * Math.PI / 180);
      ctx.translate(-it.w / 2, -it.h / 2);
      if (s.shadow) {
        // The shadow must follow the photo's own alpha (like the DOM's drop-shadow), so the
        // clipped photo is composed offscreen first and then drawn WITH the shadow.
        var sc = scaleOf(ctx);
        var off = document.createElement('canvas');
        off.width = Math.max(1, Math.ceil(it.w * sc)); off.height = Math.max(1, Math.ceil(it.h * sc));
        var octx = off.getContext('2d'); octx.scale(sc, sc);
        drawSlotContent(octx, model, s, img, it.w, it.h);
        var sp = shadowParams(s.shadow);
        ctx.shadowColor = 'rgba(0,0,0,' + sp.alpha + ')'; ctx.shadowBlur = sp.blur * sc; ctx.shadowOffsetY = sp.offY * sc;
        ctx.save(); ctx.scale(1 / sc, 1 / sc); ctx.drawImage(off, 0, 0); ctx.restore();
      } else {
        drawSlotContent(ctx, model, s, img, it.w, it.h);
      }
      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ *
   * Reusable collage templates (user-saved or built-in). A template stores the
   * ARRANGEMENT and styling only — never the photos — so it can be applied to
   * any set of images.
   * ------------------------------------------------------------------ */
  function toTemplate(model, name) {
    return {
      v: VERSION, id: uid('t'), name: name || 'my collage', user: true,
      mode: model.mode, layout: clone(model.layout),
      gutter: model.gutter, pad: model.pad, radius: model.radius, mask: model.mask, bg: clone(model.bg),
      slots: model.slots.map(function (s) {
        return { free: s.free ? clone(s.free) : null, mask: s.mask, fit: s.fit, shadow: s.shadow, border: clone(s.border), tile: s.tile, z: s.z };
      }),
      decor: model.decor.map(function (d) { var x = clone(d); delete x.id; return x; })
    };
  }

  // Applies a template to an existing collage. Photos stay (matched by order);
  // photos beyond the template's slot count keep their own freeform geometry.
  function applyTemplate(model, tpl) {
    model.mode = tpl.mode === 'free' ? 'free' : 'layout';
    model.autoPick = false;
    model.layout = normalize({ layout: tpl.layout }).layout;
    ['gutter', 'pad', 'radius', 'mask'].forEach(function (k) { if (tpl[k] != null) model[k] = tpl[k]; });
    if (tpl.bg) model.bg = clone(tpl.bg);
    while (model.slots.length < tpl.slots.length) { var s = newSlot(null); s.z = model.nextZ++; model.slots.push(s); }
    model.slots.forEach(function (s, i) {
      var t = tpl.slots[i];
      if (t) {
        s.free = t.free ? clone(t.free) : (s.free || cascadeGeom(i)); s.freeEdited = !!t.free;
        s.mask = t.mask; s.fit = t.fit || 'cover'; s.shadow = t.shadow || 0; s.border = clone(t.border || { w: 0, color: '#ffffff' });
        s.tile = t.tile || 40; if (t.z) s.z = t.z;
      } else if (!s.free) s.free = cascadeGeom(i);
    });
    if (model.mode === 'layout') { pruneEmptyBeyond(model); ensureCells(model); }
    model.decor = (tpl.decor || []).map(function (d) { var x = clone(d); x.id = uid('d'); return x; });
    var maxZ = 0; model.slots.concat(model.decor).forEach(function (o) { maxZ = Math.max(maxZ, o.z || 0); });
    model.nextZ = maxZ + 1;
  }

  SC.VERSION = VERSION;
  SC.GRID_TEMPLATES = GRID_TEMPLATES; SC.GRID_ORDER = GRID_ORDER;
  SC.FREE_PRESETS = FREE_PRESETS; SC.FREE_ORDER = FREE_ORDER;
  SC.MASKS = MASKS; SC.DECOR_KINDS = DECOR_KINDS;
  SC.create = create; SC.normalize = normalize; SC.clone = clone;
  SC.newSlot = newSlot; SC.findSlot = findSlot; SC.findDecor = findDecor;
  SC.addSlot = addSlot; SC.removeSlot = removeSlot; SC.removeDecor = removeDecor; SC.swapSlots = swapSlots;
  SC.setLayoutTemplate = setLayoutTemplate; SC.setLayoutAuto = setLayoutAuto; SC.setAutoBest = setAutoBest;
  SC.bestTemplateIdFor = bestTemplateIdFor; SC.setFree = setFree; SC.applyPreset = applyPreset;
  SC.ensureCells = ensureCells; SC.moveZ = moveZ; SC.addDecor = addDecor; SC.sortedByZ = sortedByZ;
  SC.resolve = resolve; SC.gridLayout = gridLayout; SC.maxOffset = maxOffset; SC.effectiveMask = effectiveMask;
  SC.renderDom = renderDom; SC.drawCanvas = drawCanvas; SC.tracePath = tracePath;
  SC.shadowParams = shadowParams; SC.toTemplate = toTemplate; SC.applyTemplate = applyTemplate;
  SC.clamp = clamp; SC.uid = uid;
})(typeof window !== 'undefined' ? window : globalThis);
