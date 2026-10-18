/**
 * Seamlessly Creative — shared collage editor (pointer interaction layer).
 *
 * Sits on top of collage-engine.js. Pure Pointer Events, so mouse, touch and
 * Apple Pencil all behave the same. Used by every Lookbook flavour.
 *
 * Gestures (only while the collage is in "editing" state; otherwise the whole
 * collage is a normal draggable Lookbook item):
 *   Freeform  — drag a photo/decoration to move it; corner handles resize,
 *               the top handle rotates.
 *   Layout    — drag a photo onto another cell to swap them; if a photo is
 *               already selected and zoomed in, dragging pans it inside its
 *               frame; drag a gutter handle to resize columns/rows.
 */
(function (global) {
  'use strict';
  var SC = global.ScCollage;
  if (!SC || SC.__editorLoaded) return;
  SC.__editorLoaded = true;

  function ensureStyles() {
    if (document.getElementById('sccl-editor-css')) return;
    var st = document.createElement('style');
    st.id = 'sccl-editor-css';
    st.textContent =
      '.sccl-ui{position:absolute;inset:0;pointer-events:none;z-index:100000}' +
      '.sccl-frame{position:absolute;box-sizing:border-box;border:2px solid var(--accent,#8a7aff);pointer-events:none;border-radius:2px}' +
      '.sccl-h{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:#fff;' +
        'border:3px solid var(--accent,#8a7aff);box-sizing:border-box;pointer-events:auto;touch-action:none;box-shadow:0 1px 4px rgba(0,0,0,.3)}' +
      '.sccl-h.rot{background:var(--accent,#8a7aff);cursor:grab}' +
      '.sccl-h.nw{left:0;top:0;cursor:nwse-resize}.sccl-h.ne{left:100%;top:0;cursor:nesw-resize}' +
      '.sccl-h.se{left:100%;top:100%;cursor:nwse-resize}.sccl-h.sw{left:0;top:100%;cursor:nesw-resize}' +
      '.sccl-h.rot{left:50%;top:-30px}' +
      '.sccl-stem{position:absolute;left:50%;top:-20px;width:2px;height:20px;margin-left:-1px;background:var(--accent,#8a7aff)}' +
      '.sccl-div{position:absolute;pointer-events:none}' +
      '.sccl-div.v{width:0;border-left:2px dashed rgba(138,122,255,.55)}' +
      '.sccl-div.h{height:0;border-top:2px dashed rgba(138,122,255,.55)}' +
      '.sccl-grip{position:absolute;pointer-events:auto;touch-action:none;background:var(--accent,#8a7aff);border:2px solid #fff;' +
        'border-radius:999px;box-shadow:0 1px 4px rgba(0,0,0,.35);box-sizing:border-box}' +
      '.sccl-grip::before{content:"";position:absolute;inset:-12px}' +
      '.sccl-grip.v{width:14px;height:48px;margin:-24px 0 0 -7px;cursor:col-resize}' +
      '.sccl-grip.h{width:48px;height:14px;margin:-7px 0 0 -24px;cursor:row-resize}' +
      '.sccl-target{position:absolute;box-sizing:border-box;border:3px dashed var(--accent3,#ff8a5b);background:rgba(255,138,91,.14);pointer-events:none}';
    document.head.appendChild(st);
  }

  /**
   * attachEditor(host, opts)
   *   opts.model     — the live collage model (mutated in place)
   *   opts.onChange(final) — called as the model changes (final=true on release)
   *   opts.onSelect(sel)   — sel = {type:'slot'|'decor', id} | null
   */
  SC.attachEditor = function (host, opts) {
    ensureStyles();
    var model = opts.model;
    var editing = false, sel = null, lastRes = null, raf = 0;
    var panMode = false;   // when on, dragging a photo/pattern moves the picture INSIDE its frame instead of moving/swapping the frame

    var ui = document.createElement('div'); ui.className = 'sccl-ui'; host.appendChild(ui);

    function size() { return { W: host.clientWidth || 1, H: host.clientHeight || 1 }; }
    // Host-local px from a pointer event — correct under any CSS scale (Lookbook zoom).
    function local(e) {
      var r = host.getBoundingClientRect(), s = size();
      return { x: (e.clientX - r.left) * (s.W / (r.width || 1)), y: (e.clientY - r.top) * (s.H / (r.height || 1)) };
    }
    function change(final) { if (opts.onChange) opts.onChange(!!final); }

    function refresh() {
      lastRes = SC.renderDom(model, host);
      host.__scclRoot.classList.toggle('sccl-editing', editing);
      drawUi();
    }
    function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = 0; refresh(); }); }

    function selectedObj() {
      if (!sel) return null;
      return sel.type === 'decor' ? SC.findDecor(model, sel.id) : SC.findSlot(model, sel.id);
    }
    function select(next) {
      var same = (!next && !sel) || (next && sel && next.id === sel.id);
      sel = next && selectedObjFor(next) ? { type: next.type, id: next.id } : null;
      refresh();
      if (!same && opts.onSelect) opts.onSelect(sel);
    }
    function selectedObjFor(s) { return s.type === 'decor' ? SC.findDecor(model, s.id) : SC.findSlot(model, s.id); }

    /* ---------- overlay ---------- */
    function geomOf(selObj) {
      var s = size();
      if (sel.type === 'decor') return { x: selObj.x / 100 * s.W, y: selObj.y / 100 * s.H, w: selObj.w / 100 * s.W, h: selObj.h / 100 * s.H, rot: selObj.rot || 0 };
      var it = lastRes && lastRes.items.filter(function (i) { return i.slot === selObj; })[0];
      return it && it.visible ? { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot || 0 } : null;
    }

    function drawUi() {
      ui.innerHTML = '';
      if (!editing) return;
      var s = size();

      // gutter handles — template layouts only, and only where two cells genuinely meet
      if (model.mode === 'layout' && model.layout.kind === 'template' && lastRes && lastRes.grid) {
        var g = lastRes.grid, tmpl = SC.GRID_TEMPLATES[model.layout.templateId];
        var covers = function (cell, c, r) { return c >= cell.c && c < cell.c + (cell.cw || 1) && r >= cell.r && r < cell.r + (cell.rh || 1); };
        var meet = function (axis, k, i) {   // do two cells meet across boundary k at row/col i?
          var a = false, b = false;
          tmpl.cells.forEach(function (cell) {
            var c = axis === 'col' ? k - 1 : i, r = axis === 'col' ? i : k - 1;
            var c2 = axis === 'col' ? k : i, r2 = axis === 'col' ? i : k;
            if (covers(cell, c, r)) a = true;
            if (covers(cell, c2, r2) ) b = true;
          });
          // same cell on both sides (a spanning cell) means there is no boundary here
          var same = tmpl.cells.some(function (cell) {
            var c = axis === 'col' ? k - 1 : i, r = axis === 'col' ? i : k - 1;
            var c2 = axis === 'col' ? k : i, r2 = axis === 'col' ? i : k;
            return covers(cell, c, r) && covers(cell, c2, r2);
          });
          return a && b && !same;
        };
        var addSeg = function (axis, k, from, to) {   // from..to inclusive indices along the boundary
          var d = document.createElement('div'); d.className = 'sccl-div ' + (axis === 'col' ? 'v' : 'h');
          var grip = document.createElement('div'); grip.className = 'sccl-grip ' + (axis === 'col' ? 'v' : 'h');
          grip.dataset.axis = axis; grip.dataset.k = k;
          if (axis === 'col') {
            var y0 = g.rowY[from], y1 = g.rowY[to] + g.rowH[to];
            d.style.cssText = 'left:' + (g.colX[k] - g.g / 2) + 'px;top:' + y0 + 'px;height:' + (y1 - y0) + 'px';
            grip.style.left = '0'; grip.style.top = ((y1 - y0) * 0.3) + 'px';   // off-centre so it never collides with a row grip
          } else {
            var x0 = g.colX[from], x1 = g.colX[to] + g.colW[to];
            d.style.cssText = 'top:' + (g.rowY[k] - g.g / 2) + 'px;left:' + x0 + 'px;width:' + (x1 - x0) + 'px';
            grip.style.top = '0'; grip.style.left = ((x1 - x0) * 0.7) + 'px';
          }
          d.appendChild(grip); ui.appendChild(d);
        };
        [['col', g.cols], ['row', g.rows]].forEach(function (ax) {
          var axis = ax[0], n = ax[1], len = axis === 'col' ? g.rows : g.cols;
          for (var k = 1; k < n; k++) {
            var start = -1;
            for (var i = 0; i <= len; i++) {
              var on = i < len && meet(axis, k, i);
              if (on && start < 0) start = i;
              if (!on && start >= 0) { addSeg(axis, k, start, i - 1); start = -1; }
            }
          }
        });
      }

      var obj = selectedObj();
      if (!obj) return;
      var gm = geomOf(obj);
      if (!gm) return;
      var fr = document.createElement('div'); fr.className = 'sccl-frame';
      fr.style.cssText += ';left:' + gm.x + 'px;top:' + gm.y + 'px;width:' + gm.w + 'px;height:' + gm.h + 'px;transform:rotate(' + gm.rot + 'deg)';
      var resizable = sel.type === 'decor' || model.mode === 'free';
      if (resizable) {
        ['nw', 'ne', 'se', 'sw'].forEach(function (c) { var h = document.createElement('div'); h.className = 'sccl-h ' + c; h.dataset.handle = c; fr.appendChild(h); });
        var stem = document.createElement('div'); stem.className = 'sccl-stem'; fr.appendChild(stem);
        var rh = document.createElement('div'); rh.className = 'sccl-h rot'; rh.dataset.handle = 'rot'; fr.appendChild(rh);
      }
      ui.appendChild(fr);
    }

    /* ---------- pointer handling ---------- */
    var drag = null;
    // Pointer capture retargets the trailing `click` to the host, which would look like a click on
    // empty space and deselect the piece the user just grabbed — so that one click is ignored.
    var swallowClickUntil = 0;

    function blockLegacy(e) {
      if (!editing) return;
      if (e.target.closest && (e.target.closest('.sccl-slot') || e.target.closest('.sccl-decor') || e.target.closest('.sccl-h') || e.target.closest('.sccl-grip'))) e.stopPropagation();
    }
    host.addEventListener('mousedown', blockLegacy);
    host.addEventListener('touchstart', blockLegacy, { passive: true });

    function geomPct(obj, type) {
      if (type === 'decor') return obj;
      if (!obj.free) obj.free = { x: 10, y: 10, w: 38, h: 38, rot: 0 };
      return obj.free;
    }

    host.addEventListener('pointerdown', function (e) {
      if (!editing) return;
      var t = e.target;
      var handle = t.closest && t.closest('.sccl-h');
      var divider = t.closest && t.closest('.sccl-grip');
      var el = t.closest && t.closest('.sccl-slot, .sccl-decor');
      if (!handle && !divider && !el) return;
      e.preventDefault(); e.stopPropagation();
      var s = size(), p = local(e);

      if (divider) {
        var g = lastRes.grid, axis = divider.dataset.axis, k = +divider.dataset.k;
        var arr = (axis === 'col' ? g.colW : g.rowH).slice();
        drag = { kind: 'divider', axis: axis, k: k, arr: arr, total: arr.reduce(function (a, b) { return a + b; }, 0), startP: p, pid: e.pointerId };
      } else if (handle) {
        var obj = selectedObj(); if (!obj) return;
        var gp = geomPct(obj, sel.type);
        var cx = (gp.x + gp.w / 2) / 100 * s.W, cy = (gp.y + gp.h / 2) / 100 * s.H;
        drag = { kind: handle.dataset.handle === 'rot' ? 'rotate' : 'resize', obj: obj, gp: gp, cx: cx, cy: cy, pid: e.pointerId, type: sel.type };
      } else {
        var type = el.dataset.type, id = el.dataset.id;
        var wasSelected = sel && sel.id === id;
        select({ type: type, id: id });
        var o2 = selectedObj(); if (!o2) return;
        if (panMode && type === 'slot' && o2.src) {
          var rect0 = el.getBoundingClientRect(), hr0 = host.getBoundingClientRect();
          var kx = (hr0.width || 1) / s.W;
          if (o2.kind === 'pattern') {
            var itp = lastRes && lastRes.items.filter(function (i) { return i.slot === o2; })[0];
            drag = { kind: 'patpan', obj: o2, startP: p, ox: o2.patX || 0, oy: o2.patY || 0, tw: SC.patternGeom(model, o2, itp ? itp.w : rect0.width / kx).tw, pid: e.pointerId };
          } else {
            drag = { kind: 'pan', obj: o2, startP: p, ox: o2.offX || 0, oy: o2.offY || 0, w: rect0.width / kx, h: rect0.height / ((hr0.height || 1) / s.H), pid: e.pointerId };
          }
        } else if (type === 'decor' || model.mode === 'free') {
          var g2 = geomPct(o2, type);
          drag = { kind: 'move', obj: o2, gp: g2, type: type, startP: p, ox: g2.x, oy: g2.y, moved: false, pid: e.pointerId };
        } else if (wasSelected && o2.src && o2.kind !== 'pattern' && (o2.zoom || 1) > 1) {
          var rect = el.getBoundingClientRect();
          drag = { kind: 'pan', obj: o2, startP: p, ox: o2.offX || 0, oy: o2.offY || 0, w: rect.width / ((host.getBoundingClientRect().width || 1) / s.W), h: rect.height / ((host.getBoundingClientRect().height || 1) / s.H), pid: e.pointerId };
        } else {
          drag = { kind: 'swap', obj: o2, startP: p, moved: false, target: -1, pid: e.pointerId };
        }
      }
      try { host.setPointerCapture(e.pointerId); } catch (err) {}
    }, true);

    host.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.pid) return;
      e.preventDefault();
      var s = size(), p = local(e);

      if (drag.kind === 'move') {
        var dx = (p.x - drag.startP.x) / s.W * 100, dy = (p.y - drag.startP.y) / s.H * 100;
        if (Math.abs(p.x - drag.startP.x) + Math.abs(p.y - drag.startP.y) > 3) drag.moved = true;
        drag.gp.x = SC.clamp(drag.ox + dx, -drag.gp.w * 0.7, 100 - drag.gp.w * 0.3);
        drag.gp.y = SC.clamp(drag.oy + dy, -drag.gp.h * 0.7, 100 - drag.gp.h * 0.3);
        if (drag.type === 'slot') drag.obj.freeEdited = true;
        schedule(); change(false);
      } else if (drag.kind === 'resize') {
        var rot = (drag.gp.rot || 0) * Math.PI / 180;
        var vx = p.x - drag.cx, vy = p.y - drag.cy;
        var lx = vx * Math.cos(-rot) - vy * Math.sin(-rot), ly = vx * Math.sin(-rot) + vy * Math.cos(-rot);
        var nw = Math.max(4, Math.abs(lx) * 2 / s.W * 100), nh = Math.max(3, Math.abs(ly) * 2 / s.H * 100);
        drag.gp.w = nw; drag.gp.h = nh;
        drag.gp.x = drag.cx / s.W * 100 - nw / 2; drag.gp.y = drag.cy / s.H * 100 - nh / 2;
        if (drag.type === 'slot') drag.obj.freeEdited = true;
        schedule(); change(false);
      } else if (drag.kind === 'rotate') {
        var ang = Math.atan2(p.y - drag.cy, p.x - drag.cx) * 180 / Math.PI + 90;
        ang = Math.round(ang * 10) / 10;
        [0, 45, 90, 135, 180, -45, -90, -135, -180].forEach(function (snap) { if (Math.abs(ang - snap) < 4) ang = snap; });
        drag.gp.rot = ang;
        if (drag.type === 'slot') drag.obj.freeEdited = true;
        schedule(); change(false);
      } else if (drag.kind === 'pan') {
        var mo = SC.maxOffset(drag.obj.zoom || 1);
        var bw = drag.w * (drag.obj.zoom || 1), bh = drag.h * (drag.obj.zoom || 1);
        drag.obj.offX = SC.clamp(drag.ox + (p.x - drag.startP.x) / bw * 100, -mo, mo);
        drag.obj.offY = SC.clamp(drag.oy + (p.y - drag.startP.y) / bh * 100, -mo, mo);
        schedule(); change(false);
      } else if (drag.kind === 'patpan') {
        drag.obj.patX = drag.ox + (p.x - drag.startP.x) / drag.tw * 100;
        drag.obj.patY = drag.oy + (p.y - drag.startP.y) / drag.tw * 100;
        schedule(); change(false);
      } else if (drag.kind === 'divider') {
        var g = lastRes.grid, k = drag.k, arr = drag.arr.slice();
        var delta = (drag.axis === 'col' ? p.x - drag.startP.x : p.y - drag.startP.y);
        var minSize = drag.total * 0.08;
        var a = SC.clamp(arr[k - 1] + delta, minSize, arr[k - 1] + arr[k] - minSize);
        var b = arr[k - 1] + arr[k] - a;
        arr[k - 1] = a; arr[k] = b;
        var sum = arr.reduce(function (x, y) { return x + y; }, 0);
        var w = arr.map(function (x) { return x / sum; });
        if (drag.axis === 'col') model.layout.colWeights = w; else model.layout.rowWeights = w;
        schedule(); change(false);
      } else if (drag.kind === 'swap') {
        if (Math.abs(p.x - drag.startP.x) + Math.abs(p.y - drag.startP.y) > 6) drag.moved = true;
        if (!drag.moved) return;
        var hit = -1;
        lastRes.items.forEach(function (it, i) { if (it.visible && p.x >= it.x && p.x <= it.x + it.w && p.y >= it.y && p.y <= it.y + it.h) hit = i; });
        drag.target = hit;
        var tgt = ui.querySelector('.sccl-target');
        if (hit >= 0 && lastRes.items[hit].slot !== drag.obj) {
          var ti = lastRes.items[hit];
          if (!tgt) { tgt = document.createElement('div'); tgt.className = 'sccl-target'; ui.appendChild(tgt); }
          tgt.style.left = ti.x + 'px'; tgt.style.top = ti.y + 'px'; tgt.style.width = ti.w + 'px'; tgt.style.height = ti.h + 'px';
        } else if (tgt) tgt.remove();
      }
    }, true);

    function end(e) {
      if (!drag || (e && e.pointerId !== drag.pid)) return;
      var d = drag; drag = null;
      swallowClickUntil = Date.now() + 400;
      try { host.releasePointerCapture(e.pointerId); } catch (err) {}
      if (d.kind === 'swap' && d.moved && d.target >= 0) {
        var from = model.slots.indexOf(d.obj);
        var to = lastRes.items[d.target] ? model.slots.indexOf(lastRes.items[d.target].slot) : -1;
        if (from >= 0 && to >= 0 && from !== to) SC.swapSlots(model, from, to);
      }
      if (d.kind === 'patpan') {   // a repeat looks identical every whole tile, so keep the stored offset small
        var wrap = function (v) { return ((((v + 50) % 100) + 100) % 100) - 50; };
        d.obj.patX = wrap(d.obj.patX || 0); d.obj.patY = wrap(d.obj.patY || 0);
      }
      refresh(); change(true);
    }
    host.addEventListener('pointerup', end, true);
    host.addEventListener('pointercancel', end, true);

    // tapping empty page area inside an editing collage just deselects the piece
    host.addEventListener('click', function (e) {
      if (!editing || Date.now() < swallowClickUntil) return;
      if (!(e.target.closest && (e.target.closest('.sccl-slot') || e.target.closest('.sccl-decor') || e.target.closest('.sccl-h') || e.target.closest('.sccl-grip')))) {
        if (sel) select(null);
      }
    });

    var api = {
      model: model,
      setModel: function (m) { model = m; api.model = m; sel = null; refresh(); },
      setPanMode: function (on) { panMode = !!on; },
      isPanMode: function () { return panMode; },
      setEditing: function (on) { editing = !!on; if (!editing) { panMode = false; var had = !!sel; sel = null; if (had && opts.onSelect) opts.onSelect(null); } refresh(); },
      isEditing: function () { return editing; },
      select: select,
      getSelection: function () { return sel ? { type: sel.type, id: sel.id } : null; },
      getSelectedObject: selectedObj,
      refresh: refresh,
      getResolved: function () { return lastRes; },
      destroy: function () { ui.remove(); }
    };
    refresh();
    return api;
  };

  // Fills a specific (empty or filled) slot with an image without disturbing its geometry.
  SC.setSlotImage = function (model, slot, info) {
    slot.src = info.src; slot.kind = info.kind === 'pattern' ? 'pattern' : 'image';
    slot.ar = info.ar > 0 ? info.ar : 1; slot.name = info.name || slot.name || '';
    slot.zoom = 1; slot.offX = 0; slot.offY = 0;
  };
})(typeof window !== 'undefined' ? window : globalThis);
