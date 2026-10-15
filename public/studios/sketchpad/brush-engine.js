/**
 * Sketch Pad Brush Engine.
 *
 * Pure logic + rendering, no DOM assumptions beyond a CanvasRenderingContext2D.
 * Owns: the brush registry, pressure curves, the shared dab-stamping
 * renderer every brush is built from, and persistence for per-brush
 * settings / recents / favourites.
 *
 * DESIGN — one rendering primitive, retained/replayable strokes:
 * every one of the 13 drawing brushes (Inking, Pencil, Marker, Paint/
 * Texture) is `renderMode:'vector'` — a stroke is retained as
 * {id, brushId, color, points:[{x,y,pressure}]} in the app's own
 * `strokes` array, and rendered by stamping dabs along those points
 * via BE.renderStroke(). Re-rendering a stroke with a NEW brushId
 * reproduces the exact same geometry in the new brush's appearance —
 * the brush is purely a set of parameters BE.renderStroke() uses to
 * decide how to stamp along the existing points, never a transform of
 * the points themselves. That's what makes every drawing brush here
 * re-brushable after the fact (Sketch Pad's "interchangeable outline
 * brushes"), texture brushes (Chalk, Crayon, Dry Brush, Gouache)
 * included — their texture comes from this same dab primitive's
 * hardness/jitter/streaky parameters, not from a separate raster path.
 *
 * The one deliberate exception is the Eraser (see ERASER below): it is
 * `renderMode:'raster'` because erasing is inherently destructive —
 * it removes whole strokes it crosses rather than being itself a
 * retained, re-brushable mark. That is the "raster tool, cleanly
 * separated" the brush spec allows for, kept to the one tool that
 * actually needs it rather than applied to any drawing brush.
 *
 * Every brush, drawing or eraser, calls the SAME BE.stampDab()
 * primitive, so adding a new brush is a new entry in BRUSHES with new
 * parameters, never a new code path — that's what keeps this
 * extensible rather than hard-coded around the 13 initial brushes.
 */
(function (global) {
  'use strict';

  // ---- Brush registry -------------------------------------------------
  //
  // family: purely a UI grouping label.
  // renderMode: 'vector' (retained, replayable, re-brushable) | 'raster'
  //   (immediate, flattened, never re-brushable — see file header).
  // pressureAffects: which channels respond to pencil pressure BY
  //   DEFAULT for this brush; the user's own settings (widthStrength/
  //   opacityStrength, persisted per-brush) are what actually drive the
  //   math — a strength of 0 is equivalent to "disabled" for that
  //   channel without needing a separate on/off flag.
  // jitter: 0-1, per-dab random offset/size wobble (Rough Ink, Chalk,
  //   Dry Brush, Crayon) — seeded from the stroke id + dab index so the
  //   SAME stroke always re-renders identically (required for vector
  //   brushes: re-rendering after an undo/reload must reproduce the
  //   same pixels).
  // streaky: 0-1, probability a given dab is skipped/thinned — gives
  //   Dry Brush / Chalk / Crayon their broken-coverage look.
  // taper: 'none' | 'both' — tapers the first/last few dabs of a stroke
  //   down to a point, independent of pressure (Tapered Ink).
  const BRUSHES = [
    // -- Inking (vector) --
    { id: 'smoothPen', name: 'Smooth Pen', family: 'inking', renderMode: 'vector',
      defaults: { size: 3, opacity: 100, smoothing: 35, pressureWidth: 0, pressureOpacity: 0, spacing: 6 },
      // Monoline pen: one constant width and opacity whatever the Pencil pressure (forced, so settings
      // saved before this change cannot bring pressure variation back).
      lock: { pressureWidth: 0, pressureOpacity: 0 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none', path: true },
    { id: 'technicalPen', name: 'Technical Pen', family: 'inking', renderMode: 'vector',
      defaults: { size: 4, opacity: 100, smoothing: 45, pressureWidth: 5, pressureOpacity: 0, spacing: 5 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none' },
    { id: 'taperedInk', name: 'Tapered Ink', family: 'inking', renderMode: 'vector',
      defaults: { size: 7, opacity: 100, smoothing: 30, pressureWidth: 70, pressureOpacity: 0, spacing: 6 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'both' },
    { id: 'calligraphy', name: 'Calligraphy', family: 'inking', renderMode: 'vector', nib: true,
      // Flat nib held at a fixed angle: thick across the nib, hairline along it. Size = nib width,
      // nibAngle = degrees (0 = horizontal), nibFlat = nib thickness as % of its width.
      defaults: { size: 16, opacity: 100, smoothing: 45, pressureWidth: 25, pressureOpacity: 0, spacing: 6, nibAngle: 40, nibFlat: 12 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none' },
    { id: 'roughInk', name: 'Rough Ink', family: 'inking', renderMode: 'vector',
      defaults: { size: 8, opacity: 100, smoothing: 20, pressureWidth: 60, pressureOpacity: 15, spacing: 7 },
      hardness: 0.85, jitter: 0.35, streaky: 0.08, taper: 'none' },

    // -- Pencil (vector, textured via per-dab opacity noise) --
    { id: 'sketchPencil', name: 'Sketch Pencil', family: 'pencil', renderMode: 'vector',
      defaults: { size: 3, opacity: 75, smoothing: 15, pressureWidth: 30, pressureOpacity: 45, spacing: 8 },
      hardness: 0.7, jitter: 0.15, streaky: 0.12, taper: 'none' },
    { id: 'softPencil', name: 'Soft Pencil', family: 'pencil', renderMode: 'vector',
      defaults: { size: 9, opacity: 55, smoothing: 25, pressureWidth: 25, pressureOpacity: 55, spacing: 10 },
      hardness: 0.45, jitter: 0.2, streaky: 0.18, taper: 'none' },
    { id: 'texturedPencil', name: 'Textured Pencil', family: 'pencil', renderMode: 'vector',
      defaults: { size: 10, opacity: 65, smoothing: 10, pressureWidth: 20, pressureOpacity: 40, spacing: 5 },
      hardness: 0.4, jitter: 0.3, streaky: 0.3, taper: 'none' },

    // -- Marker (vector, flat coverage) --
    { id: 'solidMarker', name: 'Solid Marker', family: 'marker', renderMode: 'vector',
      defaults: { size: 22, opacity: 90, smoothing: 25, pressureWidth: 10, pressureOpacity: 0, spacing: 9 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none' },
    { id: 'softMarker', name: 'Soft Marker', family: 'marker', renderMode: 'vector',
      defaults: { size: 30, opacity: 55, smoothing: 25, pressureWidth: 15, pressureOpacity: 20, spacing: 12 },
      hardness: 0.55, jitter: 0.05, streaky: 0, taper: 'none' },

    // -- Paint / Texture (raster-only, see file header) --
    { id: 'gouache', name: 'Gouache', family: 'paint', renderMode: 'vector',
      defaults: { size: 34, opacity: 95, smoothing: 15, pressureWidth: 35, pressureOpacity: 15, spacing: 14, engine: 'raster', wetMix: 35, dryness: 0 },
      hardness: 0.8, jitter: 0.12, streaky: 0.06, taper: 'none' },
    { id: 'dryBrush', name: 'Dry Brush', family: 'paint', renderMode: 'vector',
      defaults: { size: 26, opacity: 85, smoothing: 10, pressureWidth: 40, pressureOpacity: 35, spacing: 8, engine: 'raster', wetMix: 12, dryness: 60 },
      hardness: 0.5, jitter: 0.3, streaky: 0.45, taper: 'none' },
    { id: 'chalk', name: 'Chalk', family: 'paint', renderMode: 'vector',
      defaults: { size: 20, opacity: 70, smoothing: 5, pressureWidth: 20, pressureOpacity: 40, spacing: 6 },
      hardness: 0.35, jitter: 0.4, streaky: 0.4, taper: 'none' },
    { id: 'crayon', name: 'Crayon', family: 'paint', renderMode: 'vector',
      defaults: { size: 16, opacity: 80, smoothing: 5, pressureWidth: 25, pressureOpacity: 25, spacing: 5 },
      hardness: 0.6, jitter: 0.25, streaky: 0.3, taper: 'none' },
    { id: 'watercolour', name: 'Watercolour', family: 'paint', renderMode: 'vector',
      defaults: { size: 44, opacity: 70, smoothing: 20, pressureWidth: 30, pressureOpacity: 40, spacing: 8, engine: 'raster', wetMix: 0, dryness: 0, wcEdge: 55, wcGrain: 25, wcSoft: 60 },
      hardness: 0.3, jitter: 0.08, streaky: 0, taper: 'none' },
    { id: 'dryInk', name: 'Dry Ink', family: 'inking', renderMode: 'vector',
      defaults: { size: 10, opacity: 100, smoothing: 18, pressureWidth: 55, pressureOpacity: 30, spacing: 6, engine: 'raster', wetMix: 0, dryness: 55 },
      hardness: 0.85, jitter: 0.06, streaky: 0, taper: 'none' },
  ];

  const FAMILY_ORDER = ['inking', 'pencil', 'marker', 'paint', 'custom', 'stamp'];
  const FAMILY_LABEL = { inking: 'Inking', pencil: 'Pencil', marker: 'Marker', paint: 'Paint / Texture', custom: 'Custom Brushes', stamp: 'Motif Brushes' };

  const ERASER = { id: 'eraser', name: 'Eraser', family: 'eraser', renderMode: 'raster',
    defaults: { size: 26, opacity: 100, smoothing: 15, pressureWidth: 30, pressureOpacity: 0, spacing: 6 },
    hardness: 0.9, jitter: 0, streaky: 0, taper: 'none' };

  const byId = new Map(BRUSHES.map((b) => [b.id, b]));
  byId.set(ERASER.id, ERASER);

  function getBrush(id) { return byId.get(id) || BRUSHES[0]; }
  // ---- Motif (stamp) brushes ----------------------------------------------
  // A captured motif becomes a brush: the stroke is still an ordinary retained path, but it is
  // drawn by stamping the motif's picture along it. Registered at runtime by the app.
  function registerStampBrush(id, name, img, noRegister) {
    const max = 512, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
    const old = byId.get(id);
    const brush = {
      id, name, family: 'stamp', renderMode: 'vector', stamp: true, stampImg: img, stampCanvas: c, tinted: {},
      defaults: { size: 90, opacity: 100, smoothing: 35, pressureWidth: 0, pressureOpacity: 0, spacing: 100, follow: 0, tint: 0 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none',
    };
    if (noRegister) return brush;
    if (old) { BRUSHES[BRUSHES.indexOf(old)] = brush; } else { BRUSHES.push(brush); }
    byId.set(id, brush);
    return brush;
  }
  // ---- User-made brushes ---------------------------------------------------
  // def: { id, name, softness(0-100), grain(0-80), wobble(0-100), taper, mono, tipImg?, defaults:{size,opacity,smoothing,pressureWidth,pressureOpacity,spacing,...} }
  function applyFx(b, def) {
    const fx = def.fx || {};
    let ts = fx.taperStart, te = fx.taperEnd;
    if (ts == null && te == null && def.taper) { ts = te = 12; }
    ts = Math.max(0, Math.min(60, ts || 0)); te = Math.max(0, Math.min(60, te || 0));
    b.taperS = ts / 100; b.taperE = te / 100; b.taper = (ts > 0 || te > 0) ? 'both' : 'none';
    const c = fx.color || {};
    b.cdyn = { h: c.h || 0, s: c.s || 0, b: c.b || 0 };
    const grain = fx.grain && (def.grainImg) ? Object.assign({}, fx.grain, { img: def.grainImg }) : null;
    const dual = fx.dual && fx.dual.on ? Object.assign({}, fx.dual, { img: def.dualImg || null }) : null;
    b.fx = { grain, blend: fx.blend || 'source-over', dual };
    return b;
  }
  function makeCustomBrush(def) {
    const d = Object.assign({ size: 20, opacity: 100, smoothing: 30, pressureWidth: 0, pressureOpacity: 0, spacing: 8 }, def.defaults || {});
    if (def.tipImg) {
      const b = registerStampBrush(def.id, def.name, def.tipImg, true);
      if (!b) return null;
      b.family = 'custom'; b.custom = true; b.def = def;
      b.defaults = Object.assign({}, b.defaults, d, { follow: d.follow || 0, tint: d.tint || 0 });
      return applyFx(b, def);
    }
    const brush = {
      id: def.id, name: def.name, family: 'custom', renderMode: 'vector', custom: true, def,
      defaults: d,
      hardness: Math.max(0.05, Math.min(1, (def.softness == null ? 100 : def.softness) / 100)),
      jitter: Math.max(0, Math.min(1, (def.wobble || 0) / 100)),
      streaky: Math.max(0, Math.min(0.9, (def.grain || 0) / 100)),
      taper: 'none',
    };
    applyFx(brush, def);
    if (def.mono) {
      brush.hardness = 1; brush.jitter = 0; brush.streaky = 0; brush.lock = { pressureWidth: 0, pressureOpacity: 0 };
      // a true monoline path cannot narrow, so a tapered monoline is drawn as hard dabs instead
      if (brush.taper === 'none') { brush.path = true; brush.cdyn = { h: 0, s: 0, b: 0 }; }
    }
    return brush;
  }
  function registerCustomBrush(def) {
    const b = makeCustomBrush(def); if (!b) return null;
    const old = byId.get(def.id);
    if (old) BRUSHES[BRUSHES.indexOf(old)] = b; else BRUSHES.push(b);
    byId.set(def.id, b);
    return b;
  }
  function unregisterStampBrush(id) {
    const old = byId.get(id); if (!old) return;
    BRUSHES.splice(BRUSHES.indexOf(old), 1); byId.delete(id);
  }

  function isVector(brushOrId) {
    const b = typeof brushOrId === 'string' ? getBrush(brushOrId) : brushOrId;
    return b.renderMode === 'vector';
  }

  // ---- Settings persistence -------------------------------------------
  //
  // One JSON blob per key rather than one localStorage key per brush —
  // keeps this to 3 keys total, well inside any reasonable storage quota,
  // and trivial to include in a future full project export.
  const LS_SETTINGS = 'pkmBrushSettingsV1';
  const LS_RECENTS = 'pkmBrushRecentsV1';
  const LS_FAVORITES = 'pkmBrushFavoritesV1';
  const RECENTS_MAX = 8;

  function loadJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  let settingsStore = loadJSON(LS_SETTINGS, {});
  let recents = loadJSON(LS_RECENTS, []);
  let favorites = loadJSON(LS_FAVORITES, []);

  function getSettings(brushId) {
    const brush = getBrush(brushId);
    return Object.assign({}, brush.defaults, settingsStore[brushId] || {}, brush.lock || {});
  }
  function setSettings(brushId, patch) {
    settingsStore[brushId] = Object.assign({}, getSettings(brushId), patch);
    saveJSON(LS_SETTINGS, settingsStore);
  }
  function touchRecent(brushId) {
    recents = [brushId].concat(recents.filter((id) => id !== brushId)).slice(0, RECENTS_MAX);
    saveJSON(LS_RECENTS, recents);
  }
  function getRecents() { return recents.slice(); }
  function isFavorite(brushId) { return favorites.indexOf(brushId) !== -1; }
  function toggleFavorite(brushId) {
    favorites = isFavorite(brushId) ? favorites.filter((id) => id !== brushId) : favorites.concat([brushId]);
    saveJSON(LS_FAVORITES, favorites);
    return isFavorite(brushId);
  }
  function getFavorites() { return favorites.slice(); }

  // ---- Pressure curves --------------------------------------------------
  //
  // strength 0..100. 0 = channel ignores pressure entirely (constant).
  // 100 = channel fully follows pressure. Anything between blends the
  // two linearly — this single formula is what "pressure -> width",
  // "-> opacity", "-> both" and "disabled" all reduce to, per brush,
  // per user setting, with no separate code path per mode.
  function pressureFactor(pressure, strength) {
    const p = Math.max(0, Math.min(1, pressure == null ? 0.5 : pressure));
    const s = Math.max(0, Math.min(100, strength)) / 100;
    return (1 - s) + s * p;
  }

  // Deterministic per-dab pseudo-random, seeded from the stroke id + dab
  // index — same stroke always re-renders identically (required so
  // undo/redo and brush re-assignment reproduce exact pixels), but
  // varies dab-to-dab and stroke-to-stroke.
  function seededRandom(seedStr) {
    let h = 0;
    for (let i = 0; i < seedStr.length; i++) { h = (h * 31 + seedStr.charCodeAt(i)) | 0; }
    return function () {
      h = (h * 1664525 + 1013904223) | 0;
      return ((h >>> 0) / 4294967296);
    };
  }

  // ---- Core stamping primitive -----------------------------------------
  //
  // Every brush, vector or raster, resolves to a sequence of calls to
  // this one function. `hardness` controls edge softness (1 = hard disc,
  // <1 = radial-gradient falloff, giving pencil/chalk/dry-brush their
  // soft edges without a second rendering path).
  function stampDab(ctx, x, y, radius, opacity, color, hardness) {
    if (radius <= 0 || opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    if (hardness >= 0.98) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const grad = ctx.createRadialGradient(x, y, Math.max(0, radius * hardness), x, y, radius);
      grad.addColorStop(0, color);
      grad.addColorStop(1, colorWithAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Cheap hex/rgb -> "same colour, alpha 0" for the gradient stop above.
  // Only needs to handle the #rrggbb / #rgb the app's own <input
  // type=color> produces plus the eraser's synthetic rgba(...) — good
  // enough without pulling in a colour-parsing library for this.
  function colorWithAlpha(color, alpha) {
    if (color.charAt(0) === '#') {
      let hex = color.slice(1);
      if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
      const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }
    if (color.indexOf('rgba(') === 0) return color.replace(/[\d.]+\)$/, alpha + ')');
    if (color.indexOf('rgb(') === 0) return color.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
    return color;
  }

  // Resample a raw point list at even arc-length spacing (in canvas
  // px) so dab density stays consistent regardless of how fast the
  // pencil moved — fast strokes would otherwise get sparse/gappy dabs
  // since pointermove fires less often per pixel of travel at speed.
  // Pressure is linearly interpolated between the two source points a
  // resampled point falls between.
  function resample(points, spacing) {
    if (points.length < 2) return points.slice();
    const out = [points[0]];
    let carry = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen <= 0) continue;
      let dist = carry;
      while (dist < segLen) {
        const t = dist / segLen;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, pressure: a.pressure + (b.pressure - a.pressure) * t });
        dist += spacing;
      }
      carry = dist - segLen;
    }
    out.push(points[points.length - 1]);
    return out;
  }
  // Shape outlines and node-edited paths have deliberate corners. The "curve through the midpoints"
  // smoothing below used to round every one of them (a rectangle came out as a blob with one sharp
  // corner at the seam, i.e. a teardrop). Corners are now kept sharp: a point flagged corner:true
  // (set by the shape generators and by corner nodes), every vertex of a polygonal shape, and for
  // shapes / node paths any vertex that turns by more than ~40 degrees (covers older saved shapes).
  // Closed outlines are built as one closed loop so the seam is clean. Freehand strokes (no shape,
  // no nodes) keep the original smoothing exactly.
  const SHARP_SHAPES = { line: 1, rect: 1, triangle: 1, diamond: 1, polygon: 1, star: 1 };
  function cornerFlags(stroke, pts, closed) {
    const n = pts.length, sharpAll = !!(stroke.shape && SHARP_SHAPES[stroke.shape.type]);
    const auto = !!(stroke.shape || stroke.nodes || stroke.cornerAuto);
    const flags = new Array(n).fill(false);
    let any = false;
    for (let i = 0; i < n; i++) {
      let f = pts[i].corner === true || sharpAll;
      if (!f && auto) {
        const a = pts[closed ? (i - 1 + n) % n : i - 1], c = pts[closed ? (i + 1) % n : i + 1];
        if (a && c) {
          const a1 = Math.atan2(pts[i].y - a.y, pts[i].x - a.x), a2 = Math.atan2(c.y - pts[i].y, c.x - pts[i].x);
          let d = Math.abs(a2 - a1); if (d > Math.PI) d = 2 * Math.PI - d;
          if (d > 0.7) f = true;
        }
      }
      if (f) any = true;
      flags[i] = f;
    }
    return { flags: flags, any: any };
  }
  function pathThrough(ctx, pts, closed, flags) {
    const n = pts.length, mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    if (!closed) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n - 1; i++) {
        if (flags[i]) { ctx.lineTo(pts[i].x, pts[i].y); continue; }
        const m = mid(pts[i], pts[i + 1]);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
      }
      ctx.lineTo(pts[n - 1].x, pts[n - 1].y);
      return;
    }
    const k = flags.indexOf(true);
    if (k >= 0) {
      ctx.moveTo(pts[k].x, pts[k].y);
      for (let j = 1; j <= n; j++) {
        const i = (k + j) % n;
        if (flags[i]) { ctx.lineTo(pts[i].x, pts[i].y); continue; }
        const m = mid(pts[i], pts[(i + 1) % n]);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
      }
    } else {
      const m0 = mid(pts[0], pts[1]);
      ctx.moveTo(m0.x, m0.y);
      for (let j = 1; j <= n; j++) {
        const i = j % n, m = mid(pts[i], pts[(i + 1) % n]);
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y);
      }
    }
    ctx.closePath();
  }
  // Monoline pens: one true anti-aliased curved path (round caps/joins) instead of
  // stamped dabs, so edges stay perfectly smooth at any zoom.
  function renderPathStroke(ctx, stroke, settings, alphaMul) {
    const src = stroke.points, color = stroke.color || '#000000';
    const pts = [src[0]];
    for (let i = 1; i < src.length; i++) {
      const l = pts[pts.length - 1];
      if (Math.hypot(src[i].x - l.x, src[i].y - l.y) >= 0.3) pts.push(src[i]);
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (settings.opacity / 100) * alphaMul));
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = settings.size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    let closed = !!stroke.closed && (stroke.shape || stroke.nodes || stroke.cornerAuto) && pts.length > 3;
    if (closed && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.5) pts.pop();
    else closed = false;
    // Corner shapes (rectangle, triangle, diamond, polygon, star) get true pointed corners, not round ones.
    if (stroke.shape && SHARP_SHAPES[stroke.shape.type] && stroke.shape.type !== 'line') { ctx.lineJoin = 'miter'; ctx.miterLimit = 12; }
    if (pts.length < 2) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, settings.size / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      const cf = (stroke.shape || stroke.nodes || stroke.cornerAuto || closed) ? cornerFlags(stroke, pts, closed) : null;
      ctx.beginPath();
      if (cf && (cf.any || closed)) {
        pathThrough(ctx, pts, closed, cf.flags);
      } else {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const e = pts[pts.length - 1];
        ctx.lineTo(e.x, e.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Motif brush: stamp the motif picture along the path. size = the motif's longest side in canvas px.
  // Which picture to stamp with: the small default tip, or a sharper one when the stamp is going to be
  // drawn bigger than that tip (size x the canvas's current scale, so deep zoom and hi-res layers count).
  //  - motifs supply brush.tipFn(px), which redraws the motif from its saved vector strokes at that size;
  //  - bitmap-only tips use progressively larger copies of the ORIGINAL picture (never enlarged beyond it).
  // Tips come in power-of-two sizes so they are reused instead of rebuilt for every size tweak.
  function tipFor(brush, needed) {
    const base = brush.stampCanvas, bl = Math.max(base.width, base.height);
    if (needed <= bl * 0.9) return base;
    if (brush.tipFn) { try { const t = brush.tipFn(needed); if (t) return t; } catch (e) { /* fall back */ } }
    const img = brush.stampImg; if (!img) return base;
    const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height, nl = Math.max(nw, nh);
    if (nl <= bl * 1.05) return base;
    let bucket = bl * 2; while (bucket < needed && bucket < nl) bucket *= 2;
    bucket = Math.min(bucket, nl, 2048);
    if (bucket <= bl * 1.05) return base;
    brush.mip = brush.mip || {};
    let m = brush.mip[bucket];
    if (!m) {
      const k = bucket / nl; m = document.createElement('canvas');
      m.width = Math.max(1, Math.round(nw * k)); m.height = Math.max(1, Math.round(nh * k));
      const g = m.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, m.width, m.height);
      brush.mip[bucket] = m;
    }
    return m;
  }
  function tintedTip(brush, src, key) {
    const k = src.width + 'x' + src.height + '|' + key;
    let t = brush.tinted[k];
    if (!t) {
      // keep tinted copies of big tips from piling up (memory on iPad)
      brush.tintedN = (brush.tintedN || 0) + 1;
      if (brush.tintedN > 24) { brush.tinted = {}; brush.tintedN = 1; }
      t = document.createElement('canvas'); t.width = src.width; t.height = src.height;
      const g = t.getContext('2d'); g.drawImage(src, 0, 0);
      g.globalCompositeOperation = 'source-in'; g.fillStyle = key; g.fillRect(0, 0, t.width, t.height);
      brush.tinted[k] = t;
    }
    return t;
  }
  function renderStampStroke(ctx, stroke, brush, settings, alphaMul) {
    if (!brush.stampCanvas) return;
    let sc = 1;
    try { const m = ctx.getTransform(); sc = Math.hypot(m.a, m.b) || 1; } catch (e) { /* old browser */ }
    const src = tipFor(brush, settings.size * sc);
    let img = src;
    if (settings.tint) img = tintedTip(brush, src, stroke.color || '#000000');
    const pts0 = stroke.points; if (!pts0 || !pts0.length) return;
    const spacingPx = Math.max(2, (settings.spacing / 100) * settings.size);
    let pts = pts0.length < 2 ? pts0.slice() : resample(pts0, spacingPx);
    if (pts.length > 2) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (Math.hypot(a.x - b.x, a.y - b.y) < spacingPx * 0.5) pts.pop();
    }
    const longest = Math.max(src.width, src.height);
    const sBase = (settings.tint && hasCdyn(brush)) ? hexToHsl(stroke.color || '#000000') : null;
    let variants = null;
    if (sBase) { const r0 = seededRandom((stroke.id || 'live') + 'v'); variants = []; for (let v = 0; v < 8; v++) variants.push(dynColor(sBase, brush.cdyn, r0)); }
    const rv = seededRandom((stroke.id || 'live') + 'p');
    ctx.save();
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (variants) {
        img = tintedTip(brush, src, variants[Math.floor(rv() * 8)]);
      }
      const sz = settings.size * pressureFactor(pt.pressure, settings.pressureWidth) * taperAt(brush, i, pts.length);
      const op = (settings.opacity / 100) * pressureFactor(pt.pressure, settings.pressureOpacity) * alphaMul;
      if (sz <= 0.5 || op <= 0) continue;
      const k = sz / longest, w = src.width * k, h = src.height * k;
      ctx.globalAlpha = Math.max(0, Math.min(1, op));
      ctx.save();
      ctx.translate(pt.x, pt.y);
      if (settings.follow && pts.length > 1) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
        ctx.rotate(Math.atan2(p1.y - p0.y, p1.x - p0.x));
      }
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
    ctx.restore();
  }

  // Renders one stroke (vector or, called from the app's raster path,
  // one in-progress raster segment) onto `ctx` using `brush`'s current
  // settings. This is the single function both the vector replay path
  // and the live raster-paint path call — see file header.
  // ---- Calligraphy: a flat nib swept along the path, filled as ONE shape so opacity stays even ----
  function renderNibStroke(ctx, stroke, settings, alphaMul) {
    const src = stroke.points; if (!src || !src.length) return;
    const ang = ((settings.nibAngle == null ? 40 : settings.nibAngle) * Math.PI) / 180;
    const flat = Math.max(0.02, Math.min(1, (settings.nibFlat == null ? 12 : settings.nibFlat) / 100));
    const ux = Math.cos(ang), uy = -Math.sin(ang); // nib long axis (angle measured counter-clockwise, as on paper)
    const step = Math.max(0.25, settings.size * 0.06);
    const pts = resample(src, step);
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (settings.opacity / 100) * alphaMul));
    ctx.fillStyle = stroke.color || '#000000';
    ctx.beginPath();
    let prev = null;
    pts.forEach((pt) => {
      const half = Math.max(0.05, (settings.size / 2) * pressureFactor(pt.pressure, settings.pressureWidth));
      const th = Math.max(0.05, half * 2 * flat / 2);
      ctx.moveTo(pt.x + Math.cos(-ang) * half, pt.y + Math.sin(-ang) * half);
      ctx.ellipse(pt.x, pt.y, half, th, -ang, 0, Math.PI * 2);
      if (prev) {
        const ax = prev.x - prev.hx, ay = prev.y - prev.hy, bx = prev.x + prev.hx, by = prev.y + prev.hy;
        const cx = pt.x + ux * half, cy = pt.y + uy * half, dx = pt.x - ux * half, dy = pt.y - uy * half;
        // quad a-b-c-d; make winding clockwise (matches ellipse) so nonzero fill never cancels
        const area = (ax * by - bx * ay) + (bx * cy - cx * by) + (cx * dy - dx * cy) + (dx * ay - ax * dy);
        ctx.moveTo(ax, ay);
        if (area >= 0) { ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.lineTo(dx, dy); }
        else { ctx.lineTo(dx, dy); ctx.lineTo(cx, cy); ctx.lineTo(bx, by); }
        ctx.closePath();
      }
      prev = { x: pt.x, y: pt.y, hx: ux * half, hy: uy * half };
    });
    ctx.fill('nonzero');
    ctx.restore();
  }

  // ---- Raster-feel engine -------------------------------------------------
  // Paints like pixels: dabs go into a scratch buffer (so overlaps inside one stroke don't pile
  // up), a paper-tooth grain can be knocked out of it (dryness), the paint can pick up colour
  // already on the layer (wet mix), then the buffer is laid onto the layer at the stroke opacity.
  // The stroke is still retained as points and replayed in order, so undo, saving, the vector
  // eraser and re-brushing all keep working. Deterministic: same stroke + same layer = same pixels.
  let _buf = null, _grain = null, _bufIdle = 0;
  const _sampleCache = { id: null, map: new Map() };
  function grainTile() {
    if (_grain) return _grain;
    const N = 48, c = document.createElement('canvas'); c.width = c.height = N * 2;
    const sm = document.createElement('canvas'); sm.width = sm.height = N;
    const sx = sm.getContext('2d'), id = sx.createImageData(N, N), r = seededRandom('paper-tooth');
    for (let i = 0; i < N * N; i++) { const v = r() * 255; id.data[i * 4 + 3] = v < 105 ? 0 : Math.min(255, (v - 105) * 3); }
    sx.putImageData(id, 0, 0);
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.drawImage(sm, 0, 0, N * 2, N * 2);
    _grain = c; return c;
  }
  function parseRgb(col) {
    let m = /^#([0-9a-f]{6})$/i.exec(col || '');
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    m = /^#([0-9a-f]{3})$/i.exec(col || '');
    if (m) { const h = m[1]; return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)]; }
    m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(col || '');
    if (m) return [+m[1], +m[2], +m[3]];
    return [0, 0, 0];
  }
  // Colour pick-up reads the paint under the brush. Reading many tiny spots from the big layer canvas makes iPad Safari copy
  // the whole canvas to the CPU each time (memory spikes, then the page dies), so instead the canvas is shrunk ONCE on the GPU
  // into a small picture (<= ~320 px) and sampled from that in plain JS.
  // Colour pick-up is worked out once per stroke and remembered (keyed by the stroke's point list), so redrawing a layer (eraser,
  // undo, zoom) never has to read paint back from the canvas again for strokes it has already seen.
  const _pkCache = new WeakMap();
  let _lowCv = null;
  function makeLow(uctx) {
    const c = uctx.canvas, k = Math.max(1, Math.ceil(Math.max(c.width, c.height) / 320));
    const lw = Math.max(1, Math.ceil(c.width / k)), lh = Math.max(1, Math.ceil(c.height / k));
    if (!_lowCv) { _lowCv = document.createElement('canvas'); }
    _lowCv.width = lw; _lowCv.height = lh;
    const g = _lowCv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, lw, lh); g.drawImage(c, 0, 0, c.width, c.height, 0, 0, lw, lh);
    let data = null; try { data = g.getImageData(0, 0, lw, lh).data; } catch (e) { data = null; }
    _lowCv.width = 1; _lowCv.height = 1;
    return data ? { data, lw, lh, k } : null;
  }
  function renderRaster(ctx, stroke, brush, settings, alphaMul) {
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const sc = Math.max(0.05, Math.hypot(m.a, m.b));
    let spacingPx = Math.max(1, (settings.spacing / 100) * Math.max(4, settings.size));
    const narrow = Math.max(0.35, 1 - settings.pressureWidth / 100);
    spacingPx = Math.max(0.2, Math.min(spacingPx, settings.size * narrow * 0.6));
    spacingPx = Math.max(spacingPx, Math.min(settings.size * 0.25, 6)); // the scratch buffer saturates anyway, so fewer dabs look the same
    const pts = resample(stroke.points, spacingPx);
    const rand = seededRandom(stroke.id || 'live');
    const n = pts.length, dabs = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pSum = 0;
    pts.forEach((pt, i) => {
      const widthMul = pressureFactor(pt.pressure, settings.pressureWidth);
      const opMul = pressureFactor(pt.pressure, settings.pressureOpacity);
      let radius = (settings.size / 2) * widthMul * taperAt(brush, i, n);
      let op = opMul;
      if (brush.jitter > 0) { radius *= (1 - brush.jitter * 0.3) + rand() * brush.jitter * 0.6; op *= (1 - brush.jitter * 0.2) + rand() * brush.jitter * 0.4; }
      if (brush.streaky > 0 && rand() < brush.streaky) return;
      let x = pt.x, y = pt.y;
      if (brush.jitter > 0) { const jr = radius * brush.jitter * 0.5; x += (rand() - 0.5) * jr; y += (rand() - 0.5) * jr; }
      if (radius <= 0) return;
      dabs.push({ x, y, r: radius, op, i });
      pSum += (pt.pressure == null ? 0.5 : pt.pressure);
      if (x - radius < minX) minX = x - radius; if (x + radius > maxX) maxX = x + radius;
      if (y - radius < minY) minY = y - radius; if (y + radius > maxY) maxY = y + radius;
    });
    if (!dabs.length) return;
    let bx = Math.floor(minX) - 2, by = Math.floor(minY) - 2, bx1 = Math.ceil(maxX) + 2, by1 = Math.ceil(maxY) + 2;
    try { // only the part that is actually on this canvas matters
      if (ctx.canvas && typeof DOMMatrix !== 'undefined' && ctx.getTransform) {
        const inv = m.inverse(), cw = ctx.canvas.width, ch = ctx.canvas.height, xs = [], ys = [];
        [[0, 0], [cw, 0], [0, ch], [cw, ch]].forEach((c) => { const q = inv.transformPoint(new DOMPoint(c[0], c[1])); xs.push(q.x); ys.push(q.y); });
        bx = Math.max(bx, Math.floor(Math.min.apply(null, xs)) - 2); by = Math.max(by, Math.floor(Math.min.apply(null, ys)) - 2);
        bx1 = Math.min(bx1, Math.ceil(Math.max.apply(null, xs)) + 2); by1 = Math.min(by1, Math.ceil(Math.max.apply(null, ys)) + 2);
      }
    } catch (e) {}
    const bw = bx1 - bx, bh = by1 - by;
    if (bw < 1 || bh < 1) return;
    // keep the scratch image small (<= ~2.5M pixels): iPads kill the page when canvases get huge
    const se = Math.min(sc, 2048 / Math.max(bw, bh), Math.sqrt(2500000 / (bw * bh)));
    const pw = Math.max(1, Math.ceil(bw * se)), ph = Math.max(1, Math.ceil(bh * se));
    if (!_buf) _buf = document.createElement('canvas');
    if (_buf.width < pw || _buf.height < ph) { _buf.width = Math.max(_buf.width, Math.ceil(pw / 512) * 512); _buf.height = Math.max(_buf.height, Math.ceil(ph / 512) * 512); }
    clearTimeout(_bufIdle); _bufIdle = setTimeout(() => { if (_buf) { _buf.width = 1; _buf.height = 1; } }, 8000);
    const b = _buf.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0); b.clearRect(0, 0, Math.min(_buf.width, pw + 2), Math.min(_buf.height, ph + 2));
    b.setTransform(se, 0, 0, se, -bx * se, -by * se);
    // colour pick-up from what is already on the layer
    let wet = Math.max(0, Math.min(100, settings.wetMix || 0)) / 100;
    if (wet < 0.04) wet = 0;
    const U = global.BrushEngine && global.BrushEngine.underlay;
    let uctx = null, ux = 1, uy = 1, ue = 0, uf = 0;
    if (wet > 0) {
      try {
        if (U && U.canvas) { uctx = U.canvas.getContext('2d'); ux = U.sx; uy = U.sy; }
        else if (ctx.canvas && !m.b && !m.c) { uctx = ctx.canvas.getContext('2d'); ux = m.a; uy = m.d; ue = m.e; uf = m.f; }
      } catch (e) { uctx = null; }
    }
    const live = !!(U && U.canvas);
    let pk = null, pkNew = null;
    if (wet > 0 && !live && stroke.points) {
      const sig = dabs.length + '|' + wet.toFixed(3) + '|' + (stroke.color || '') + '|' + settings.size;
      const hit = _pkCache.get(stroke.points);
      if (hit && hit.sig === sig) { pk = hit.cols; uctx = null; } else pkNew = { sig, cols: new Array(dabs.length) };
    }
    if (live && _sampleCache.id !== stroke.id) { _sampleCache.id = stroke.id; _sampleCache.map.clear(); _sampleCache.low = null; }
    // Committed strokes: ONE read of the area under the stroke instead of dozens of tiny reads
    // (readbacks are what make the iPad stall). Live strokes keep a few cached single reads.
    let region = null, rx0 = 0, ry0 = 0, rw = 0, rh = 0;
    if (uctx && !live) {
      try {
        rx0 = Math.max(0, Math.floor(bx * ux + ue) - 2); ry0 = Math.max(0, Math.floor(by * uy + uf) - 2);
        const rx1 = Math.min(uctx.canvas.width, Math.ceil(bx1 * ux + ue) + 2), ry1 = Math.min(uctx.canvas.height, Math.ceil(by1 * uy + uf) + 2);
        rw = rx1 - rx0; rh = ry1 - ry0;
        if (rw > 2 && rh > 2 && rw * rh <= 900000) region = uctx.getImageData(rx0, ry0, rw, rh).data;
      } catch (e) { region = null; }
    }
    let low = null;
    if (uctx && (live || !region)) { try { low = live ? (_sampleCache.low || (_sampleCache.low = makeLow(uctx))) : makeLow(uctx); } catch (e) { low = null; } }
    const base = parseRgb(stroke.color || '#000000');
    let cur = base.slice();
    const every = Math.max(region ? 3 : 6, Math.ceil(dabs.length / (region ? 40 : 10)));
    dabs.forEach((d, k) => {
      if (uctx && k % every === 0) {
        let sm = live ? _sampleCache.map.get(d.i) : undefined;
        if (sm === undefined && low) {
          sm = null;
          const px = Math.round((d.x * ux + ue) / low.k), py = Math.round((d.y * uy + uf) / low.k);
          if (px > 0 && py > 0 && px < low.lw - 1 && py < low.lh - 1) {
            let r = 0, g = 0, bl = 0, a = 0;
            for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) { const q = ((py + yy) * low.lw + (px + xx)) * 4, al = low.data[q + 3] / 255; r += low.data[q] * al; g += low.data[q + 1] * al; bl += low.data[q + 2] * al; a += al; }
            if (a > 0.5) sm = [r / a, g / a, bl / a, Math.min(1, a / 9)];
          }
          if (live) _sampleCache.map.set(d.i, sm);
        } else if (sm === undefined && region) {
          sm = null;
          const px = Math.round(d.x * ux + ue) - rx0, py = Math.round(d.y * uy + uf) - ry0;
          if (px > 1 && py > 1 && px < rw - 2 && py < rh - 2) {
            let r = 0, g = 0, bl = 0, a = 0;
            for (let yy = -1; yy <= 1; yy++) for (let xx = -1; xx <= 1; xx++) { const q = ((py + yy) * rw + (px + xx)) * 4, al = region[q + 3] / 255; r += region[q] * al; g += region[q + 1] * al; bl += region[q + 2] * al; a += al; }
            if (a > 0.5) sm = [r / a, g / a, bl / a, Math.min(1, a / 9)];
          }
        } else if (sm === undefined && (!uctx || uctx)) {
          sm = null;
          try {
            const px = Math.round(d.x * ux + ue), py = Math.round(d.y * uy + uf);
            if (px > 1 && py > 1 && px < uctx.canvas.width - 2 && py < uctx.canvas.height - 2) {
              const dt = uctx.getImageData(px - 1, py - 1, 3, 3).data; let r = 0, g = 0, bl = 0, a = 0;
              for (let q = 0; q < 36; q += 4) { const al = dt[q + 3] / 255; r += dt[q] * al; g += dt[q + 1] * al; bl += dt[q + 2] * al; a += al; }
              if (a > 0.5) sm = [r / a, g / a, bl / a, Math.min(1, a / 9)];
            }
          } catch (e) { sm = null; }
          if (live) _sampleCache.map.set(d.i, sm);
        }
        if (sm && sm[3] > 0.15) {
          const kk = Math.min(0.6, wet * 0.4 * sm[3]);
          cur = [cur[0] * (1 - kk) + sm[0] * kk, cur[1] * (1 - kk) + sm[1] * kk, cur[2] * (1 - kk) + sm[2] * kk];
        }
        cur = [cur[0] * 0.96 + base[0] * 0.04, cur[1] * 0.96 + base[1] * 0.04, cur[2] * 0.96 + base[2] * 0.04];
      }
      const colStr = pk ? pk[k] : 'rgb(' + (cur[0] | 0) + ',' + (cur[1] | 0) + ',' + (cur[2] | 0) + ')';
      if (pkNew) pkNew.cols[k] = colStr;
      stampDab(b, d.x, d.y, d.r, d.op, colStr, brush.hardness);
    });
    if (pkNew) _pkCache.set(stroke.points, pkNew);
    const dry = Math.max(0, Math.min(100, settings.dryness || 0)) / 100;
    if (dry > 0) {
      b.save(); b.setTransform(se, 0, 0, se, -bx * se, -by * se);
      b.globalCompositeOperation = 'destination-out';
      b.globalAlpha = Math.min(1, dry * (1 - 0.45 * Math.min(1, pSum / dabs.length)));
      b.fillStyle = b.createPattern(grainTile(), 'repeat');
      b.fillRect(bx, by, bw, bh); b.restore();
    }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (settings.opacity / 100) * alphaMul));
    if (brush.id === 'watercolour') ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(_buf, 0, 0, pw, ph, bx, by, pw / se, ph / se);
    ctx.restore();
  }
  // ---- Watercolour engine ---------------------------------------------------
  // A transparent wash with a pooled, darker edge and a little paper granulation, built from three
  // small buffers instead of colour read-backs, so it is fast:
  //   M  hard discs (the shape of the wash)      I  slightly smaller hard discs
  //   B  soft coloured dabs (the wash itself, builds up inside the stroke)
  //   edge = M minus I (a thin ring round the outline), body = B; both are laid into O, the result.
  // While drawing, a live state keeps the buffers between pointer moves and only stamps the NEW
  // dabs and refreshes the small rectangle around them, so a long stroke costs the same per move as a
  // short one. A saved stroke is built the same way in one go, so the live look and the final look match.
  const _wcSets = { live: null, doc: null }, _wcLive = { key: null };
  function wcSet(which, pw, ph) {
    let st = _wcSets[which];
    if (!st) { st = _wcSets[which] = { M: document.createElement('canvas'), I: document.createElement('canvas'), I2: document.createElement('canvas'), B: document.createElement('canvas'), O: document.createElement('canvas'), T: document.createElement('canvas') }; st.M.width = st.M.height = 1; ['I', 'I2', 'B', 'O', 'T'].forEach((k) => { st[k].width = st[k].height = 1; }); }
    const big = st.M.width * st.M.height > 6500000 && pw * ph < 1500000;
    ['M', 'I', 'I2', 'B', 'O'].forEach((k) => {
      const c = st[k];
      if (big) { c.width = 1; c.height = 1; }
      if (c.width < pw || c.height < ph) { c.width = Math.max(c.width, pw); c.height = Math.max(c.height, ph); }
    });
    return st;
  }
  function liveEnd() { _wcLive.key = null; const st = _wcSets.live; if (st) ['M', 'I', 'I2', 'B', 'O', 'T'].forEach((k) => { st[k].width = 1; st[k].height = 1; }); }
  function renderWatercolour(ctx, stroke, brush, settings, alphaMul) {
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const sc = Math.max(0.05, Math.hypot(m.a, m.b));
    const U = global.BrushEngine && global.BrushEngine.underlay;
    const live = !!(stroke.liveKey && U && U.canvas && brush.taper === 'none');
    const num = (v, d) => (typeof v === 'number' ? v : d);
    const size = Math.max(1, settings.size), edge = Math.max(0, Math.min(100, num(settings.wcEdge, 55))) / 100,
      gran = Math.max(0, Math.min(100, num(settings.wcGrain, 18))) / 100, soft = Math.max(0, Math.min(100, num(settings.wcSoft, 60))) / 100;
    const spacing = Math.max(1.2, Math.min(7, size * Math.max(0.03, Math.min(0.2, (settings.spacing || 8) / 100)) ));
    const pts = resample(stroke.points, spacing);
    if (!pts.length) return;
    const rand = live ? null : seededRandom(stroke.id || 'wc');
    // region the buffers cover (user space)
    let bx, by, bx1, by1;
    if (live) { bx = 0; by = 0; bx1 = Math.ceil(U.canvas.width / (U.sx || 1)); by1 = Math.ceil(U.canvas.height / (U.sy || 1)); }
    else {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const rmax = size / 2 + 3;
      pts.forEach((p) => { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
      bx = Math.floor(minX - rmax); by = Math.floor(minY - rmax); bx1 = Math.ceil(maxX + rmax); by1 = Math.ceil(maxY + rmax);
      try {
        if (ctx.canvas && typeof DOMMatrix !== 'undefined' && ctx.getTransform) {
          const inv = m.inverse(), cw = ctx.canvas.width, ch = ctx.canvas.height, xs = [], ys = [];
          [[0, 0], [cw, 0], [0, ch], [cw, ch]].forEach((c) => { const q = inv.transformPoint(new DOMPoint(c[0], c[1])); xs.push(q.x); ys.push(q.y); });
          bx = Math.max(bx, Math.floor(Math.min.apply(null, xs)) - 2); by = Math.max(by, Math.floor(Math.min.apply(null, ys)) - 2);
          bx1 = Math.min(bx1, Math.ceil(Math.max.apply(null, xs)) + 2); by1 = Math.min(by1, Math.ceil(Math.max.apply(null, ys)) + 2);
        }
      } catch (e) {}
    }
    const bw = bx1 - bx, bh = by1 - by;
    if (bw < 1 || bh < 1) return;
    const cap = live ? 1800000 : 2500000;
    const se = Math.min(sc, 2048 / Math.max(bw, bh), Math.sqrt(cap / (bw * bh)));
    const pw = Math.max(1, Math.ceil(bw * se)), ph = Math.max(1, Math.ceil(bh * se));
    const color = stroke.color || '#000000';
    const sig = [size, color, edge, soft, settings.pressureWidth, settings.pressureOpacity, bx, by, bw, bh, se.toFixed(3), spacing.toFixed(2)].join('|');
    let S = null, firstDab = 0;
    const st = wcSet(live ? 'live' : 'doc', pw, ph);
    if (live) {
      const L = _wcLive;
      const same = L.key === stroke.liveKey && L.sig === sig && L.n <= pts.length + 1 && L.p0 && pts[0].x === L.p0.x && pts[0].y === L.p0.y;
      if (!same) { L.key = stroke.liveKey; L.sig = sig; L.n = 0; L.p0 = { x: pts[0].x, y: pts[0].y }; L.rand = seededRandom(String(stroke.liveKey)); L.bb = null; L.cleared = false; }
      S = L; firstDab = L.n;
    }
    const ctxs = {};
    ['M', 'I', 'I2', 'B', 'O'].forEach((k) => { ctxs[k] = st[k].getContext('2d'); });
    if (!live || !S.cleared) {
      ['M', 'I', 'I2', 'B', 'O'].forEach((k) => { const g = ctxs[k]; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, Math.min(st[k].width, pw + 2), Math.min(st[k].height, ph + 2)); });
      if (live) S.cleared = true;
    }
    const lastIdx = live ? pts.length - 1 : pts.length; // a live stroke's final point is provisional; the saved stroke includes it
    const R = live ? S.rand : rand;
    let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
    const rgb = parseRgb(color), solid = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')', clear0 = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)';
    const hard = 1 - soft * 0.25; // only the outer part of the wash feathers; the middle stays an even tone
    let vv = live ? (S.v == null ? 1 : S.v) : 1; // slow wander in how much pigment the brush carries
    for (let i = firstDab; i < lastIdx; i++) {
      const pt = pts[i];
      const r = (size / 2) * pressureFactor(pt.pressure, settings.pressureWidth) * (1 - 0.04 + R() * 0.08);
      vv = Math.max(0.78, Math.min(1.12, vv + (R() - 0.5) * 0.07));
      const op = Math.max(0.05, pressureFactor(pt.pressure, settings.pressureOpacity)) * vv;
      if (r <= 0.3) continue;
      const x = pt.x, y = pt.y, ri = Math.max(0, r - Math.max(1.4, r * 0.24)), ri2 = Math.max(0, r - Math.max(0.7, r * 0.08));
      ctxs.M.setTransform(se, 0, 0, se, -bx * se, -by * se); ctxs.I.setTransform(se, 0, 0, se, -bx * se, -by * se); ctxs.I2.setTransform(se, 0, 0, se, -bx * se, -by * se); ctxs.B.setTransform(se, 0, 0, se, -bx * se, -by * se);
      ctxs.M.fillStyle = '#fff'; ctxs.M.beginPath(); ctxs.M.arc(x, y, r, 0, 6.2832); ctxs.M.fill();
      ctxs.I.fillStyle = '#fff'; ctxs.I.beginPath(); ctxs.I.arc(x, y, ri, 0, 6.2832); ctxs.I.fill();
      ctxs.I2.fillStyle = '#fff'; ctxs.I2.beginPath(); ctxs.I2.arc(x, y, ri2, 0, 6.2832); ctxs.I2.fill();
      const g = ctxs.B.createRadialGradient(x, y, r * hard * 0.9, x, y, r);
      g.addColorStop(0, solid); g.addColorStop(1, clear0);
      ctxs.B.globalAlpha = Math.min(1, op * 0.4); ctxs.B.fillStyle = g; ctxs.B.beginPath(); ctxs.B.arc(x, y, r, 0, 6.2832); ctxs.B.fill(); ctxs.B.globalAlpha = 1;
      if (x - r < dx0) dx0 = x - r; if (x + r > dx1) dx1 = x + r; if (y - r < dy0) dy0 = y - r; if (y + r > dy1) dy1 = y + r;
    }
    if (live) { S.n = Math.max(firstDab, lastIdx); S.v = vv; }
    // refresh the result O inside the rectangle that changed
    if (isFinite(dx0)) {
      let rx0 = Math.max(0, Math.floor((dx0 - bx) * se) - 2), ry0 = Math.max(0, Math.floor((dy0 - by) * se) - 2);
      let rx1 = Math.min(pw, Math.ceil((dx1 - bx) * se) + 2), ry1 = Math.min(ph, Math.ceil((dy1 - by) * se) + 2);
      const rw = rx1 - rx0, rh = ry1 - ry0;
      if (rw > 0 && rh > 0) {
        if (st.T.width < rw || st.T.height < rh) { st.T.width = Math.max(st.T.width, rw); st.T.height = Math.max(st.T.height, rh); }
        const T = st.T.getContext('2d'), O = ctxs.O;
        const ring = (inner) => { // M minus a smaller disc set = a ring round the outline, tinted
          T.setTransform(1, 0, 0, 1, 0, 0); T.globalCompositeOperation = 'source-over'; T.clearRect(0, 0, rw, rh);
          T.drawImage(st.M, rx0, ry0, rw, rh, 0, 0, rw, rh);
          T.globalCompositeOperation = 'destination-out'; T.drawImage(inner, rx0, ry0, rw, rh, 0, 0, rw, rh);
          T.globalCompositeOperation = 'source-in'; T.fillStyle = solid; T.fillRect(0, 0, rw, rh);
          T.globalCompositeOperation = 'source-over';
        };
        O.setTransform(1, 0, 0, 1, 0, 0); O.globalCompositeOperation = 'source-over'; O.clearRect(rx0, ry0, rw, rh);
        O.globalAlpha = 0.6; O.drawImage(st.B, rx0, ry0, rw, rh, rx0, ry0, rw, rh);
        if (edge > 0) {
          ring(st.I); O.globalAlpha = 0.06 + 0.3 * edge; O.drawImage(st.T, 0, 0, rw, rh, rx0, ry0, rw, rh);
          ring(st.I2); O.globalAlpha = 0.08 + 0.45 * edge; O.drawImage(st.T, 0, 0, rw, rh, rx0, ry0, rw, rh);
        }
        O.globalAlpha = 1;
        if (gran > 0) {
          O.save(); O.beginPath(); O.rect(rx0, ry0, rw, rh); O.clip();
          O.setTransform(se, 0, 0, se, -bx * se, -by * se);
          O.globalCompositeOperation = 'destination-out'; O.globalAlpha = Math.min(0.6, gran * 0.55);
          O.fillStyle = O.createPattern(grainTile(), 'repeat'); O.fillRect(bx + rx0 / se - 2, by + ry0 / se - 2, rw / se + 4, rh / se + 4);
          O.restore();
        }
        if (S) { S.bb = S.bb ? { x0: Math.min(S.bb.x0, rx0), y0: Math.min(S.bb.y0, ry0), x1: Math.max(S.bb.x1, rx1), y1: Math.max(S.bb.y1, ry1) } : { x0: rx0, y0: ry0, x1: rx1, y1: ry1 }; }
      }
    }
    // lay the result on the target at the stroke opacity (multiply, like real transparent paint)
    let sx0 = 0, sy0 = 0, sx1 = pw, sy1 = ph;
    if (live) { if (!S.bb) return; sx0 = S.bb.x0; sy0 = S.bb.y0; sx1 = S.bb.x1; sy1 = S.bb.y1; }
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (settings.opacity / 100) * alphaMul));
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(st.O, sx0, sy0, sx1 - sx0, sy1 - sy0, bx + sx0 / se, by + sy0 / se, (sx1 - sx0) / se, (sy1 - sy0) / se);
    ctx.restore();
  }
  // ---- Smudge ---------------------------------------------------------------
  // Drags the paint that is already on the canvas along a path, like a finger through wet paint. It works
  // on the pixels of the canvas it is given. A "carry" patch remembers what the finger is holding; at
  // every step the carry is laid back down (blended with what is underneath) and then refreshed from
  // the canvas at the new spot. No pixel read-backs, only canvas-to-canvas copies, so it stays fast.
  // iPad Safari keeps every canvas it has ever been given until memory runs out (then canvases go black),
  // so the four small working canvases are reused between strokes instead of created fresh each time.
  const BrushEngine_skipSmudge = { on: false, until: 0, hit: false }; // until: a time limit (performance.now) for replaying smudge / liquify strokes while a project opens
  let _smPool = null, _smBusy = false;
  function makeSmudger(ctx, radius, strength, brush) {
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, d: 1, e: 0, f: 0 };
    const sc = Math.max(0.05, Math.abs(m.a));
    let R = Math.max(1, radius * sc);
    const MAXR = 300; // a finger bigger than this just becomes slow and memory hungry
    const shrink = R > MAXR ? MAXR / R : 1; R *= shrink;
    const D = Math.max(4, Math.ceil(R * 2) + 2);
    const pooled = !_smBusy; if (pooled) { _smBusy = true; if (!_smPool) _smPool = [0, 1, 2, 3].map(() => document.createElement('canvas')); }
    const mk = (w, h, i) => { const c = pooled ? _smPool[i] : document.createElement('canvas'); c.width = w; c.height = h; return c; }; // setting the size also clears it
    const carry = mk(D, D, 0), pick = mk(D, D, 1), laid = mk(D, D, 2), mask = mk(D, D, 3);
    const cg = carry.getContext('2d'), pg = pick.getContext('2d'), lg = laid.getContext('2d'), mg = mask.getContext('2d');
    // The footprint of the finger comes from the chosen brush: its tip picture (stamp brushes), its edge
    // softness (a hard brush smudges with a hard edge) and its texture (a dry or grainy brush smears in streaks).
    const tip = brush && brush.stamp ? (brush.stampCanvas || brush.stampImg) : null;
    if (tip && (tip.width || tip.naturalWidth)) {
      const tw = tip.width || tip.naturalWidth, th = tip.height || tip.naturalHeight, k = Math.min((D - 2) / tw, (D - 2) / th);
      try { mg.drawImage(tip, (D - tw * k) / 2, (D - th * k) / 2, tw * k, th * k); } catch (e) {}
    } else {
      const h = brush && brush.hardness != null ? Math.max(0.05, Math.min(1, brush.hardness)) : 0.25;
      const grad = mg.createRadialGradient(D / 2, D / 2, R * Math.min(0.97, h), D / 2, D / 2, R);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      mg.fillStyle = grad; mg.fillRect(0, 0, D, D);
    }
    if (brush) {
      const gr = brush.fx && brush.fx.grain ? Math.min(1, (brush.fx.grain.depth || 0) / 100) * 0.7 : 0;
      const tex = Math.min(0.85, Math.max(brush.streaky || 0, gr) * 1.3 + (brush.jitter > 0.25 ? 0.12 : 0));
      if (tex > 0.05) {
        mg.save(); mg.globalCompositeOperation = 'destination-out'; mg.globalAlpha = tex;
        mg.setTransform(Math.max(0.6, sc), 0, 0, Math.max(0.6, sc), 0, 0);
        mg.fillStyle = mg.createPattern(grainTile(), 'repeat'); mg.fillRect(0, 0, D / Math.max(0.6, sc), D / Math.max(0.6, sc)); mg.restore();
      }
    }
    const s01 = Math.max(0.05, Math.min(1, strength));
    const lay = Math.min(1, 0.3 + 0.45 * s01), keep = 0.45 + 0.5 * s01;
    let has = false;
    return {
      done() { if (pooled) { _smBusy = false; _smPool.forEach((c) => { c.width = c.height = 1; }); } },
      step: Math.max(1.2 / sc, radius * 0.22),
      to(x, y) {
        const cx = m.a * x + m.e, cy = m.d * y + m.f, sx = Math.round(cx - D / 2), sy = Math.round(cy - D / 2);
        pg.setTransform(1, 0, 0, 1, 0, 0); pg.globalCompositeOperation = 'source-over'; pg.globalAlpha = 1; pg.clearRect(0, 0, D, D);
        try { pg.drawImage(ctx.canvas, sx, sy, D, D, 0, 0, D, D); } catch (e) { return; }
        if (!has) { cg.setTransform(1, 0, 0, 1, 0, 0); cg.clearRect(0, 0, D, D); cg.drawImage(pick, 0, 0); has = true; return; }
        lg.setTransform(1, 0, 0, 1, 0, 0); lg.globalCompositeOperation = 'source-over'; lg.globalAlpha = 1; lg.clearRect(0, 0, D, D);
        lg.drawImage(carry, 0, 0); lg.globalCompositeOperation = 'destination-in'; lg.drawImage(mask, 0, 0);
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-out'; ctx.globalAlpha = lay * 0.18; ctx.drawImage(mask, sx, sy); // only a little is lifted, so starting a smear in an empty spot does not rub the paint away
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = lay; ctx.drawImage(laid, sx, sy);
        ctx.restore();
        const t = 1 - keep; // the carry slowly takes on what it passes over
        cg.globalCompositeOperation = 'destination-out'; cg.globalAlpha = t; cg.fillStyle = '#000'; cg.fillRect(0, 0, D, D);
        cg.globalCompositeOperation = 'source-over'; cg.drawImage(pick, 0, 0);
        cg.globalAlpha = 1;
      },
    };
  }
  // Clone: copies the picture found at an offset (dx, dy canvas px away) onto the spot you paint, through a soft round tip.
  // It samples a snapshot taken when the stroke starts, so what it just painted is never copied again (no smearing feedback).
  let _clSnap = null, _clPiece = null, _clMask = null;
  function makeCloner(ctx, radius, opacity, hardness, dx, dy) {
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, d: 1, e: 0, f: 0 };
    const sc = Math.max(0.05, Math.abs(m.a));
    let R = Math.max(1, radius * sc); const MAXR = 400; if (R > MAXR) R = MAXR;
    const D = Math.max(4, Math.ceil(R * 2) + 2);
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (!_clSnap) _clSnap = document.createElement('canvas');
    if (!_clPiece) _clPiece = document.createElement('canvas');
    if (!_clMask) _clMask = document.createElement('canvas');
    _clSnap.width = W; _clSnap.height = H;
    _clSnap.getContext('2d').drawImage(ctx.canvas, 0, 0);
    _clPiece.width = D; _clPiece.height = D; _clMask.width = D; _clMask.height = D;
    const pg = _clPiece.getContext('2d'), mg = _clMask.getContext('2d');
    const h = Math.max(0.02, Math.min(1, hardness == null ? 0.5 : hardness));
    const grad = mg.createRadialGradient(D / 2, D / 2, R * Math.min(0.98, h), D / 2, D / 2, R);
    grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    mg.fillStyle = grad; mg.fillRect(0, 0, D, D);
    const odx = dx * sc, ody = dy * sc, alpha = Math.max(0.05, Math.min(1, opacity));
    return {
      done() { _clSnap.width = _clSnap.height = 1; _clPiece.width = _clPiece.height = 1; _clMask.width = _clMask.height = 1; },
      step: Math.max(1.2 / sc, radius * 0.16),
      to(x, y) {
        const cx = m.a * x + m.e, cy = m.d * y + m.f, sx = Math.round(cx - D / 2), sy = Math.round(cy - D / 2);
        pg.setTransform(1, 0, 0, 1, 0, 0); pg.globalCompositeOperation = 'source-over'; pg.globalAlpha = 1; pg.clearRect(0, 0, D, D);
        try { pg.drawImage(_clSnap, Math.round(sx + odx), Math.round(sy + ody), D, D, 0, 0, D, D); } catch (e) { return; }
        pg.globalCompositeOperation = 'destination-in'; pg.drawImage(_clMask, 0, 0);
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = alpha * 0.55;
        ctx.drawImage(_clPiece, sx, sy); ctx.restore();
      },
    };
  }
  function cloneStroke(ctx, stroke) {
    const st = stroke.settings || {}, c = st.clone || {};
    const cl = makeCloner(ctx, Math.max(1, (st.size || 40) / 2), st.opacity == null ? 0.8 : st.opacity, st.hardness, c.dx || 0, c.dy || 0);
    let pts = resample(stroke.points, cl.step * 1.5);
    if (pts.length > 600) { const k = pts.length / 600; pts = Array.from({ length: 600 }, (_, i) => pts[Math.min(pts.length - 1, Math.floor(i * k))]); }
    try { for (let i = 0; i < pts.length; i++) cl.to(pts[i].x, pts[i].y); } finally { cl.done(); }
  }
  // Liquify on real paint: moves the pixels around the brush (push / pinch / bloat / twirl), so neighbouring colours smear and
  // swirl into each other like marbling. One call = one small step; holding the pen makes many steps. Steps are stored on the
  // stroke and replayed in order, so undo, saving and hi-res export see exactly the same result.
  // ---- Liquify on the GPU ----
  // The pixel warp is the same maths as the CPU loop below, run as a WebGL fragment shader. Reading the layer back with getImageData and
  // pushing it up again with putImageData is what made big brushes lag; here the pixels only move GPU to GPU. If WebGL is not
  // available (or ever fails) the CPU path below is used instead.
  // The GPU is only used if it measures faster than the CPU on this device: the first big steps are timed both ways (alternating, results
  // are identical either way) and the winner is remembered. On a device where WebGL is slow or missing the CPU path stays in charge.
  const _lq = { on: true, bad: false, gl: null, cv: null, prog: null, u: null, tex: null, src: null, sctx: null, pick: 'auto', samples: { gl: [], cpu: [] } };
  // Off by default: the GPU path is only tried when sp-lqgl-try is set to 1 (it needs extra graphics memory, which is tight on an iPad).
  _lq.pick = 'cpu'; try { if (localStorage.getItem('sp-lqgl-try') === '1') _lq.pick = 'auto'; } catch (e) { }
  function lqRecord(kind, ms, area) {
    const a = _lq.samples[kind]; a.push(ms / area); if (a.length > 4) a.shift();
    if (_lq.pick !== 'auto' || _lq.samples.gl.length < 3 || _lq.samples.cpu.length < 3) return;
    const med = q => q.slice().sort((x, y) => x - y)[q.length >> 1];
    _lq.pick = med(_lq.samples.gl) < med(_lq.samples.cpu) * 0.85 ? 'gl' : 'cpu';
  }
  const LQ_VS = 'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=vec2(aPos.x*0.5+0.5,0.5-aPos.y*0.5);gl_Position=vec4(aPos,0.0,1.0);}';
  const LQ_FS = 'precision highp float;varying vec2 vUv;uniform sampler2D uTex;uniform vec2 uRes;uniform vec2 uC;uniform vec2 uPd;uniform float uR;uniform float uS;uniform float uAng;uniform float uPf;uniform float uReps;uniform int uMode;' +
    'void main(){vec2 g=vUv*uRes-uC;float R2=uR*uR;float d2=dot(g,g);if(d2>=R2){gl_FragColor=texture2D(uTex,vUv);return;}' +
    'float u=1.0-d2/R2;float u2=u*u;float k=u2*uS;vec2 s;' +
    'if(uMode==0){s=g-uPd*k;}' +
    'else if(uMode==1){vec2 q=g;float rem=uReps;for(int i=0;i<400;i++){if(rem<=0.0)break;float part=min(rem,1.0);rem-=part;float dd=dot(q,q);if(dd>=R2)break;float uu=1.0-dd/R2;q*=1.0+uPf*uu*uu*uS*part*0.042;}s=q;}' +
    'else{float a=uAng*u2;float c=cos(a);float sn=-sin(a);s=vec2(g.x*c-g.y*sn,g.x*sn+g.y*c);}' +
    'vec2 t=(s+uC)/uRes;if(t.x<0.0||t.y<0.0||t.x>1.0||t.y>1.0){gl_FragColor=vec4(0.0);return;}gl_FragColor=texture2D(uTex,t);}';
  function lqInitGL() {
    if (_lq.gl) return true; if (_lq.bad) return false;
    try {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const gl = cv.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('no webgl');
      const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
      const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, LQ_VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, LQ_FS)); gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const ap = gl.getAttribLocation(pr, 'aPos'); gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
      const u = {}; ['uTex', 'uRes', 'uC', 'uPd', 'uR', 'uS', 'uAng', 'uPf', 'uReps', 'uMode'].forEach(n => { u[n] = gl.getUniformLocation(pr, n); });
      cv.addEventListener('webglcontextlost', e => { e.preventDefault(); _lq.gl = null; _lq.bad = true; });
      _lq.cv = cv; _lq.gl = gl; _lq.prog = pr; _lq.u = u; _lq.tex = tex;
      _lq.src = document.createElement('canvas'); _lq.sctx = _lq.src.getContext('2d');
      return true;
    } catch (e) { _lq.bad = true; _lq.gl = null; return false; }
  }
  function lqGL(ctx, x0, y0, w, h, cx, cy, R, mode, strength, ang, pdx, pdy, reps) {
    if (!_lq.on || !lqInitGL()) return false;
    try {
      const gl = _lq.gl, cv = _lq.cv, u = _lq.u;
      if (_lq.src.width !== w || _lq.src.height !== h) { _lq.src.width = w; _lq.src.height = h; }
      const sc = _lq.sctx; sc.setTransform(1, 0, 0, 1, 0, 0); sc.globalCompositeOperation = 'copy'; sc.globalAlpha = 1;
      sc.drawImage(ctx.canvas, x0, y0, w, h, 0, 0, w, h);
      if (cv.width < w || cv.height < h) { cv.width = Math.max(cv.width, Math.ceil(w / 64) * 64); cv.height = Math.max(cv.height, Math.ceil(h / 64) * 64); }
      gl.viewport(0, cv.height - h, w, h);
      gl.bindTexture(gl.TEXTURE_2D, _lq.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, _lq.src);
      gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uRes, w, h); gl.uniform2f(u.uC, cx - x0, cy - y0); gl.uniform2f(u.uPd, pdx, pdy);
      gl.uniform1f(u.uR, R); gl.uniform1f(u.uS, strength); gl.uniform1f(u.uAng, ang);
      const pf = mode === 'pinch' ? 1 : mode === 'bloat' ? -1 : 0;
      gl.uniform1f(u.uPf, pf); gl.uniform1f(u.uReps, reps > 1 ? Math.min(reps, 400) : 1);
      gl.uniform1i(u.uMode, mode === 'push' ? 0 : pf ? 1 : 2);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      ctx.save();
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
        ctx.globalCompositeOperation = 'copy'; ctx.globalAlpha = 1; try { ctx.filter = 'none'; ctx.shadowColor = 'transparent'; } catch (e2) { }
        ctx.drawImage(cv, 0, 0, w, h, x0, y0, w, h);
      } finally { ctx.restore(); }
      return true;
    } catch (e) { _lq.bad = true; _lq.gl = null; return false; }
  }
  // The app keeps one nearly invisible pixel in the top-left corner of every layer to notice when the iPad wipes a canvas (and then redraws the whole layer).
  // Liquify writes pixels there too, so it has to put the marker back or the app thinks the layer was wiped and replays everything.
  function lqSentinel(ctx) { try { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(255,255,255,0.004)'; ctx.fillRect(0, 0, 1, 1); ctx.restore(); } catch (e) { } }
  let _lqOut = null; // scratch buffer reused between steps (a fresh multi-MB array per step was what made big brushes lag and crash)
  // The warp itself, on a plain pixel buffer: id covers canvas pixels (x0,y0)..(x0+w,y0+h), the brush centre is (cx,cy) in the same pixels.
  function lqApply(id, w, h, x0, y0, cx, cy, R, sc, mode, strength, dx, dy, reps) {
    const src = id.data, n = src.length;
    if (!_lqOut || _lqOut.length < n) _lqOut = new Uint8ClampedArray(n);
    const out = _lqOut; out.set(src);
    const W4 = w * 4, R2 = R * R;
    const ang = (mode === 'twirlR' ? 1 : mode === 'twirlL' ? -1 : 0) * 0.075 * strength;
    const pf = mode === 'pinch' ? 1 : mode === 'bloat' ? -1 : 0;
    // Repeated pinch / bloat (a long hold, merged on replay) turns the same radial mapping into a loop per pixel; it only depends on the distance from the centre, so work it out once per step
    let tbl = null; const TN = 192;
    if (pf && reps > 1) {
      tbl = new Float32Array(TN + 1);
      for (let i = 0; i <= TN; i++) {
        const r = Math.max(R * 0.002, i / TN * R); let q = r, rem = Math.min(reps, 400);
        while (rem > 0) { const part = rem >= 1 ? 1 : rem; rem -= part; const dd = q * q; if (dd >= R2) break; const uu = 1 - dd / R2; q *= 1 + pf * uu * uu * strength * part * 0.042; }
        tbl[i] = q / r;
      }
    }
    const isPush = mode === 'push', pdx = dx * sc, pdy = dy * sc, bigAng = Math.abs(ang) > 0.3; // merged steps can twirl a long way, so they use real cos/sin
    for (let py = 0; py < h; py++) {
      const gy = y0 + py + 0.5 - cy, gy2 = gy * gy;
      if (gy2 >= R2) continue;
      const half = Math.sqrt(R2 - gy2); // only visit the pixels inside the circle on this row
      const pxs = Math.max(0, Math.ceil(cx - half - x0 - 0.5)), pxe = Math.min(w - 1, Math.floor(cx + half - x0 - 0.5));
      for (let px = pxs; px <= pxe; px++) {
        const gx = x0 + px + 0.5 - cx, d2 = gx * gx + gy2;
        if (d2 >= R2) continue;
        const u = 1 - d2 / R2, u2 = u * u, k = u2 * strength;
        let sx, sy; // where this pixel's new colour comes from
        if (isPush) { sx = gx - pdx * k; sy = gy - pdy * k; }
        else if (tbl) { const f = Math.sqrt(d2) / R * TN, i0 = f | 0, i1 = i0 < TN ? i0 + 1 : TN, k2 = tbl[i0] + (tbl[i1] - tbl[i0]) * (f - i0); sx = gx * k2; sy = gy * k2; }
        else if (pf) {
          let qx = gx, qy = gy, rem = reps > 1 ? Math.min(reps, 400) : 1; // reps > 1 = several merged steps: repeat the same pinch / bloat mapping that many times
          while (rem > 0) { const part = rem >= 1 ? 1 : rem; rem -= part; const dd = qx * qx + qy * qy; if (dd >= R2) break; const uu = 1 - dd / R2; qx *= 1 + pf * uu * uu * strength * part * 0.042; qy *= 1 + pf * uu * uu * strength * part * 0.042; }
          sx = qx; sy = qy;
        }
        else if (bigAng) { const a2 = ang * u2, c2 = Math.cos(a2), s2 = -Math.sin(a2); sx = gx * c2 - gy * s2; sy = gx * s2 + gy * c2; }
        else { const a2 = ang * u2, c2 = 1 - a2 * a2 * 0.5, s2 = -(a2 - a2 * a2 * a2 / 6); sx = gx * c2 - gy * s2; sy = gx * s2 + gy * c2; } // angle is at most 0.075 rad, so this is exact enough and skips cos/sin per pixel
        // bilinear sample with premultiplied alpha (so transparent pixels do not darken the colours)
        const fx = sx + cx - x0 - 0.5, fy = sy + cy - y0 - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ux = fx - ix, uy = fy - iy;
        let r = 0, g = 0, b = 0, a = 0;
        const ix1 = ix + 1, iy1 = iy + 1;
        const okx0 = ix >= 0 && ix < w, okx1 = ix1 >= 0 && ix1 < w, oky0 = iy >= 0 && iy < h, oky1 = iy1 >= 0 && iy1 < h;
        if (oky0) {
          const row = iy * W4;
          if (okx0) { const o = row + ix * 4, al = src[o + 3] / 255 * (1 - ux) * (1 - uy); r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; }
          if (okx1) { const o = row + ix1 * 4, al = src[o + 3] / 255 * ux * (1 - uy); r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; }
        }
        if (oky1) {
          const row = iy1 * W4;
          if (okx0) { const o = row + ix * 4, al = src[o + 3] / 255 * (1 - ux) * uy; r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; }
          if (okx1) { const o = row + ix1 * 4, al = src[o + 3] / 255 * ux * uy; r += src[o] * al; g += src[o + 1] * al; b += src[o + 2] * al; a += al; }
        }
        const o = py * W4 + px * 4;
        if (a > 0.002) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a * 255; } else { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; }
      }
    }
    id.data.set(n === out.length ? out : out.subarray(0, n));
  }
  function liquifyCore(ctx, x, y, mode, strength, radius, dx, dy, reps) {
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, d: 1, e: 0, f: 0 };
    const sc = Math.max(0.05, Math.abs(m.a));
    const R = Math.max(2, radius * sc), cx = m.a * x + m.e, cy = m.d * y + m.f;
    const x0 = Math.max(0, Math.floor(cx - R) - 1), y0 = Math.max(0, Math.floor(cy - R) - 1);
    const x1 = Math.min(ctx.canvas.width, Math.ceil(cx + R) + 1), y1 = Math.min(ctx.canvas.height, Math.ceil(cy + R) + 1);
    const w = x1 - x0, h = y1 - y0; if (w < 2 || h < 2) return;
    const area = w * h;
    let tryGL = false, timed = false;
    if (_lq.on && !_lq.bad && _lq.pick !== 'cpu') {
      if (_lq.pick === 'gl') tryGL = true;
      else if (area >= 40000) { timed = true; tryGL = _lq.samples.gl.length <= _lq.samples.cpu.length; }
    }
    const tStart = timed ? performance.now() : 0;
    if (tryGL) {
      if (lqGL(ctx, x0, y0, w, h, cx, cy, R, mode, strength, (mode === 'twirlR' ? 1 : mode === 'twirlL' ? -1 : 0) * 0.075 * strength, dx * sc, dy * sc, reps)) {
        if (timed) { try { ctx.getImageData(x0, y0, 1, 1); } catch (e) { } lqRecord('gl', performance.now() - tStart, area); } // reading a pixel makes the GPU finish, so the timing is honest
        return;
      }
      timed = false; _lq.pick = 'cpu'; // WebGL failed: stay on the CPU path
    }
    let id; try { id = ctx.getImageData(x0, y0, w, h); } catch (e) { return; }
    lqApply(id, w, h, x0, y0, cx, cy, R, sc, mode, strength, dx, dy, reps);
    ctx.putImageData(id, x0, y0);
    if (x0 === 0 && y0 === 0) lqSentinel(ctx);
    if (timed) { try { ctx.getImageData(x0, y0, 1, 1); } catch (e) { } lqRecord('cpu', performance.now() - tStart, area); }
  }
  // Seamless tiling. The app shows a layer by laying its canvas over itself at every neighbouring tile position, so what you see is the SUM of those shifted copies.
  // To warp that picture correctly (paint that leaves one side of the tile re-enters on the other side) the layer is first reduced to "just the tile cell"
  // (the sum of all copies, cropped to the tile), then every step reads the tile as if it repeated forever and writes the result back into the cell only.
  const BrushEngine_wrap = { get: null }; // set by the app: () => {x,y,w,h, lat:[[ox,oy]..], offs:[[ox,oy]..]} (tile rectangle, repeat vectors, the 8 neighbour offsets)
  let _lqTmp = null, _lqBuf = null;
  function lqNormalize(ctx, wrap, m) {
    const cv = ctx.canvas;
    if (!_lqTmp) _lqTmp = document.createElement('canvas');
    if (_lqTmp.width !== cv.width || _lqTmp.height !== cv.height) { _lqTmp.width = cv.width; _lqTmp.height = cv.height; }
    const t = _lqTmp.getContext('2d');
    t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, cv.width, cv.height);
    t.drawImage(cv, 0, 0);
    for (let k = 0; k < wrap.offs.length; k++) t.drawImage(cv, Math.round(wrap.offs[k][0] * m.a), Math.round(wrap.offs[k][1] * m.d));
    const tx = Math.max(0, Math.round(m.a * wrap.x + m.e)), ty = Math.max(0, Math.round(m.d * wrap.y + m.f));
    const tw = Math.min(cv.width - tx, Math.round(m.a * wrap.w)), th = Math.min(cv.height - ty, Math.round(m.d * wrap.h));
    ctx.save();
    try { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'copy'; ctx.globalAlpha = 1; ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(_lqTmp, tx, ty, tw, th, tx, ty, tw, th); } finally { ctx.restore(); }
    t.setTransform(1, 0, 0, 1, 0, 0); t.clearRect(0, 0, cv.width, cv.height);
    cv._lqNorm = true;
  }
  function liquifyStep(ctx, x, y, mode, strength, radius, dx, dy, reps, wrap) {
    if (!wrap) return liquifyCore(ctx, x, y, mode, strength, radius, dx, dy, reps);
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, d: 1, e: 0, f: 0 }, cv = ctx.canvas;
    const sc = Math.max(0.05, Math.abs(m.a)), R = Math.max(2, radius * sc);
    const tx = Math.round(m.a * wrap.x + m.e), ty = Math.round(m.d * wrap.y + m.f), tw = Math.round(m.a * wrap.w), th = Math.round(m.d * wrap.h);
    const lat = wrap.lat.map(v => [Math.round(v[0] * m.a), Math.round(v[1] * m.d)]);
    let cx = m.a * x + m.e, cy = m.d * y + m.f, home = null;
    for (let i = 0; i < lat.length; i++) { const px = cx + lat[i][0], py = cy + lat[i][1]; if (px >= tx && px < tx + tw && py >= ty && py < ty + th) { home = lat[i]; break; } }
    if (!home || tw < 4 || th < 4) return liquifyCore(ctx, x, y, mode, strength, radius, dx, dy, reps); // brush is outside the repeating area: plain warp
    cx += home[0]; cy += home[1];
    if (!cv._lqNorm) lqNormalize(ctx, wrap, m);
    const rx0 = Math.floor(cx - R) - 1, ry0 = Math.floor(cy - R) - 1, w = Math.ceil(cx + R) + 1 - rx0, h = Math.ceil(cy + R) + 1 - ry0;
    if (w < 2 || h < 2 || w * h > 4e6) return;
    // the part of the repeating picture around the brush, assembled from the tile cell
    const need = w * h * 4;
    if (!_lqBuf || _lqBuf.length < need) _lqBuf = new Uint8ClampedArray(need);
    const buf = _lqBuf; buf.fill(0, 0, need);
    const pieces = [];
    for (let i = 0; i < lat.length; i++) {
      const cx0 = tx + lat[i][0], cy0 = ty + lat[i][1];
      const ax = Math.max(rx0, cx0), ay = Math.max(ry0, cy0), bx = Math.min(rx0 + w, cx0 + tw), by = Math.min(ry0 + h, cy0 + th);
      if (bx <= ax || by <= ay) continue;
      pieces.push([lat[i][0], lat[i][1], ax, ay, bx - ax, by - ay]);
    }
    for (let k = 0; k < pieces.length; k++) {
      const pc = pieces[k]; let src;
      const sx = pc[2] - pc[0], sy = pc[3] - pc[1], sw = pc[4], sh = pc[5];
      if (sx < 0 || sy < 0 || sx + sw > cv.width || sy + sh > cv.height) continue;
      try { src = ctx.getImageData(sx, sy, sw, sh).data; } catch (e) { return; }
      for (let r = 0; r < sh; r++) {
        const from = r * sw * 4, to = ((pc[3] - ry0 + r) * w + (pc[2] - rx0)) * 4;
        buf.set(src.subarray(from, from + sw * 4), to);
      }
    }
    const id = new ImageData(buf.subarray(0, need), w, h);
    lqApply(id, w, h, rx0, ry0, cx, cy, R, sc, mode, strength, dx, dy, reps);
    for (let k = 0; k < pieces.length; k++) {
      const pc = pieces[k];
      const sx = pc[2] - pc[0], sy = pc[3] - pc[1];
      if (sx < 0 || sy < 0 || sx + pc[4] > cv.width || sy + pc[5] > cv.height) continue;
      ctx.putImageData(id, rx0 - pc[0], ry0 - pc[1], pc[2] - rx0, pc[3] - ry0, pc[4], pc[5]);
    }
    lqSentinel(ctx);
  }
  // A long hold (twirl / pinch / bloat) is stored as hundreds of tiny steps at almost the same spot, and a long push drag as hundreds
  // of tiny moves. Replaying all of them on every project open / layer rebuild is what made big projects unusable. Neighbouring steps
  // are merged here: for a hold the result is the same (rotation and scaling about one centre simply add up), for a push it is
  // within a hair of the original.
  function liquifyMerge(pts, size) {
    const out = [], lim = Math.max(2, size * 0.06), plim = Math.max(4, size * 0.22);
    let run = null;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], m = p.m || 'push', s = p.s || 1, pdx = p.dx || 0, pdy = p.dy || 0, last = out[out.length - 1];
      if (last && last.m === m) {
        if (m !== 'push') {
          if (Math.hypot(p.x - last.x, p.y - last.y) < lim) { const tot = last.s + s; last.x = (last.x * last.s + p.x * s) / tot; last.y = (last.y * last.s + p.y * s) / tot; last.s = tot; continue; }
        } else {
          const l = Math.hypot(pdx, pdy);
          if (run.len + l <= plim) { last.dx += pdx; last.dy += pdy; last.x = (last.x * run.n + p.x) / (run.n + 1); last.y = (last.y * run.n + p.y) / (run.n + 1); run.n++; run.len += l; continue; }
        }
      }
      out.push({ x: p.x, y: p.y, m: m, dx: pdx, dy: pdy, s: s }); run = { n: 1, len: Math.hypot(pdx, pdy) };
    }
    return out;
  }
  // Stored form of a liquify stroke: the same merged steps the replay uses, with only the fields that matter (a long hold used to be thousands of steps, which every undo step, save and timelapse copied again)
  function liquifyCompact(pts, size) {
    const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
    return liquifyMerge(pts || [], size || 80).map(p => {
      const o = { x: r1(p.x), y: r1(p.y), m: p.m, pressure: 0.5 };
      if (p.m === 'push') { o.dx = r2(p.dx); o.dy = r2(p.dy); } else if (p.s && Math.abs(p.s - 1) > 0.001) o.s = r2(p.s);
      return o;
    });
  }
  function liquifyStroke(ctx, stroke) {
    const st = stroke.settings || {}, lq = st.liquify || {};
    const size = lq.size || 80, base = lq.strength == null ? 0.8 : lq.strength;
    const pts = liquifyMerge(stroke.points || [], size);
    let wrap = null; if (lq.wrap !== 0 && BrushEngine_wrap.get) { try { wrap = BrushEngine_wrap.get(); } catch (e) { wrap = null; } }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const m = p.m || lq.mode || 'push', sv = p.s || 1, hold = m === 'pinch' || m === 'bloat';
      liquifyStep(ctx, p.x, p.y, m, hold ? base : base * sv, size, p.dx || 0, p.dy || 0, hold ? sv : 1, wrap);
    }
  }
  function smudgeStroke(ctx, stroke) {
    const st = stroke.settings || {};
    if (st.clone) return cloneStroke(ctx, stroke);
    if (st.liquify) return liquifyStroke(ctx, stroke);
    const sb = st.sb ? byId.get(st.sb) : null;
    const sm = makeSmudger(ctx, Math.max(1, (st.size || 30) / 2), (st.opacity == null ? 70 : st.opacity) / 100, sb && sb.id !== 'eraser' ? sb : null);
    let pts = resample(stroke.points, sm.step * 1.5);
    if (pts.length > 500) { const k = pts.length / 500; pts = Array.from({ length: 500 }, (_, i) => pts[Math.min(pts.length - 1, Math.floor(i * k))]); }
    try { for (let i = 0; i < pts.length; i++) sm.to(pts[i].x, pts[i].y); } finally { sm.done(); }
  }
  function renderStroke(ctx, stroke, brush, settings, alphaMul) {
    if (!stroke.points || stroke.points.length === 0) return;
    if (stroke.brushId === 'smudge') { if (BrushEngine_skipSmudge.on) return; if (BrushEngine_skipSmudge.until && performance.now() > BrushEngine_skipSmudge.until) { BrushEngine_skipSmudge.hit = true; return; } try { smudgeStroke(ctx, stroke); } catch (e) {} return; }
    try { ctx.canvas._lqNorm = false; } catch (e) { }
    if (alphaMul === undefined) alphaMul = 1;
    if (alphaMul <= 0) return; // fully hidden — skip dabs entirely rather than stamp at opacity 0
    if (brush.id === 'watercolour' && settings && settings.engine === 'raster') { try { renderWatercolour(ctx, stroke, brush, settings, alphaMul); } catch (e) { try { renderBase(ctx, stroke, brush, settings, alphaMul); } catch (e2) {} } return; }
    if (settings && settings.engine === 'raster' && !brush.stamp && !brush.nib && !brush.path && !brush.fx && brush.id !== 'eraser') { try { renderRaster(ctx, stroke, brush, settings, alphaMul); } catch (e) { try { renderBase(ctx, stroke, brush, settings, alphaMul); } catch (e2) {} } return; }
    if (brush.fx && fxActive(brush)) { renderWithFx(ctx, stroke, brush, settings, alphaMul); return; }
    renderBase(ctx, stroke, brush, settings, alphaMul);
  }
  function renderBase(ctx, stroke, brush, settings, alphaMul) {
    if (brush.path) { renderPathStroke(ctx, stroke, settings, alphaMul); return; }
    if (brush.nib) { renderNibStroke(ctx, stroke, settings, alphaMul); return; }
    if (brush.stamp) { renderStampStroke(ctx, stroke, brush, settings, alphaMul); return; }
    let spacingPx = Math.max(1, (settings.spacing / 100) * Math.max(4, settings.size));
    // Thin brushes: a 1-unit minimum gap is wider than the dab itself at size ~1-3 (and wider still
    // when light pressure shrinks it), so the stroke breaks into visible dots, worst when zoomed in.
    // Cap the gap to a fraction of the dab's narrowest width; sizes of ~3.5+ are unchanged.
    const narrow = Math.max(0.35, 1 - settings.pressureWidth / 100);
    spacingPx = Math.max(0.2, Math.min(spacingPx, settings.size * narrow * 0.6));
    const pts = resample(stroke.points, spacingPx);
    const rand = seededRandom(stroke.id || 'live');
    const baseHsl = hasCdyn(brush) ? hexToHsl(stroke.color || '#000000') : null;
    const cdyn = !!baseHsl, rand2 = cdyn ? seededRandom((stroke.id || 'live') + 'c') : null;
    const n = pts.length;
    const hold = Math.max(1, Math.round(settings.size * 0.2 / spacingPx));
    let curCol = stroke.color || '#000000';
    pts.forEach((pt, i) => {
      const widthMul = pressureFactor(pt.pressure, settings.pressureWidth);
      const opMul = pressureFactor(pt.pressure, settings.pressureOpacity);
      const taperMul = taperAt(brush, i, n);
      let radius = (settings.size / 2) * widthMul * taperMul;
      let opacity = (settings.opacity / 100) * opMul * alphaMul;
      if (brush.jitter > 0) {
        radius *= (1 - brush.jitter * 0.3) + rand() * brush.jitter * 0.6;
        opacity *= (1 - brush.jitter * 0.2) + rand() * brush.jitter * 0.4;
      }
      if (brush.streaky > 0 && rand() < brush.streaky) return; // skipped dab -> broken coverage
      let x = pt.x, y = pt.y;
      if (brush.jitter > 0) {
        const jr = radius * brush.jitter * 0.5;
        x += (rand() - 0.5) * jr;
        y += (rand() - 0.5) * jr;
      }
      stampDab(ctx, x, y, radius, opacity, (cdyn && i % hold === 0 ? (curCol = dynColor(baseHsl, brush.cdyn, rand2)) : curCol), brush.hardness);
    });
  }

  // ---- Taper (separate start / end lengths, as a fraction of the stroke) ----
  function taperAt(brush, i, n) {
    let ts, te;
    if (brush.taperS != null || brush.taperE != null) { ts = brush.taperS || 0; te = brush.taperE || 0; }
    else if (brush.taper === 'both') { ts = te = 0.12; }
    else return 1;
    let m = 1;
    if (ts > 0) { const len = Math.max(2, Math.round(n * ts)); if (i < len) m = Math.min(m, Math.max(0.12, i / len)); }
    if (te > 0) { const len = Math.max(2, Math.round(n * te)), e = n - 1 - i; if (e < len) m = Math.min(m, Math.max(0.12, e / len)); }
    return m;
  }

  // ---- Colour dynamics (per-dab hue / saturation / brightness variation) ----
  function hexToHsl(hex) {
    if (!hex || hex.charAt(0) !== '#') return null;
    let h = hex.slice(1); if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
    if (isNaN(r + g + b)) return null;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    let hh = 0, ss = 0;
    if (d) {
      ss = d / (1 - Math.abs(2 * l - 1));
      if (mx === r) hh = ((g - b) / d) % 6; else if (mx === g) hh = (b - r) / d + 2; else hh = (r - g) / d + 4;
      hh *= 60; if (hh < 0) hh += 360;
    }
    return { h: hh, s: ss, l };
  }
  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    const to = (v) => ('0' + Math.round((v + m) * 255).toString(16)).slice(-2);
    return '#' + to(r) + to(g) + to(b);
  }
  // cd = {h,s,b} each 0..100
  function dynColor(base, cd, rand) {
    const j = () => rand() * 2 - 1;
    return hslToHex(base.h + j() * (cd.h / 100) * 60, base.s + j() * (cd.s / 100) * 0.5, base.l + j() * (cd.b / 100) * 0.35);
  }
  function hasCdyn(brush) { const c = brush.cdyn; return !!(c && (c.h > 0 || c.s > 0 || c.b > 0)); }

  // ---- Grain, blend and dual-brush layers -----------------------------------
  // A brush using any of these is drawn into a small scratch canvas covering just the stroke, then
  // shaped (grain / second tip multiply the coverage) and composited with its blend mode.
  function makeGrainMask(brush) {
    const g = brush.fx && brush.fx.grain; if (!g || !g.img) return null;
    if (brush._grainMask && brush._grainMask.src === g.img) return brush._grainMask.canvas;
    const img = g.img, w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const k = Math.min(1, 512 / Math.max(w, h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, cw, ch);
    let d; try { d = x.getImageData(0, 0, cw, ch); } catch (e) { return null; }
    const depth = Math.max(0, Math.min(1, (g.depth == null ? 70 : g.depth) / 100));
    for (let i = 0; i < d.data.length; i += 4) {
      let lum = (0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]) / 255;
      const a = d.data[i + 3] / 255; lum = lum * a + (1 - a); // transparent = full paint
      if (g.invert) lum = 1 - lum;
      if (g.contrast) lum = Math.max(0, Math.min(1, (lum - 0.5) * (1 + g.contrast / 50) + 0.5));
      d.data[i] = d.data[i + 1] = d.data[i + 2] = 0;
      d.data[i + 3] = Math.round(((1 - depth) + depth * lum) * 255);
    }
    x.putImageData(d, 0, 0);
    brush._grainMask = { src: g.img, canvas: c };
    return c;
  }
  function fxActive(brush) {
    const f = brush.fx; if (!f) return false;
    return !!((f.grain && f.grain.img) || (f.blend && f.blend !== 'source-over') || (f.dual && f.dual.on));
  }
  function renderWithFx(ctx, stroke, brush, settings, alphaMul) {
    const f = brush.fx, pts = stroke.points;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i++) { const p = pts[i]; if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
    const pad = settings.size * ((f.dual && f.dual.on ? 1 + (f.dual.scatter || 0) / 100 : 1)) + 4;
    let bx = Math.floor(minX - pad), by = Math.floor(minY - pad), bw = Math.ceil(maxX - minX + pad * 2), bh = Math.ceil(maxY - minY + pad * 2);
    const m = ctx.getTransform ? ctx.getTransform() : { a: 1, b: 0 };
    // When zoomed far in, only the part of the stroke that is on this canvas matters: shrink the scratch
    // area to it so the texture stays sharp instead of being scaled down to fit a huge stroke.
    try {
      if (ctx.getTransform && ctx.canvas && typeof DOMMatrix !== 'undefined') {
        const inv = m.inverse(), cw = ctx.canvas.width, ch = ctx.canvas.height;
        const xs = [], ys = [];
        [[0, 0], [cw, 0], [0, ch], [cw, ch]].forEach((c) => { const q = inv.transformPoint(new DOMPoint(c[0], c[1])); xs.push(q.x); ys.push(q.y); });
        const vx0 = Math.floor(Math.min.apply(null, xs)), vy0 = Math.floor(Math.min.apply(null, ys));
        const vx1 = Math.ceil(Math.max.apply(null, xs)), vy1 = Math.ceil(Math.max.apply(null, ys));
        const nx0 = Math.max(bx, vx0 - 2), ny0 = Math.max(by, vy0 - 2), nx1 = Math.min(bx + bw, vx1 + 2), ny1 = Math.min(by + bh, vy1 + 2);
        if (nx1 <= nx0 || ny1 <= ny0) return;
        bx = nx0; by = ny0; bw = nx1 - nx0; bh = ny1 - ny0;
      }
    } catch (e) { /* keep the full area */ }
    let sc = Math.hypot(m.a, m.b) || 1;
    const MAXPX = 12e6;
    if (bw * bh * sc * sc > MAXPX) sc = Math.sqrt(MAXPX / (bw * bh));
    const W = Math.max(1, Math.round(bw * sc)), H = Math.max(1, Math.round(bh * sc));
    const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    const t = tmp.getContext('2d');
    t.setTransform(W / bw, 0, 0, H / bh, -bx * (W / bw), -by * (H / bh));
    renderBase(t, stroke, brush, settings, alphaMul);
    if (f.grain && f.grain.img) {
      const mask = makeGrainMask(brush);
      if (mask) {
        const pat = t.createPattern(mask, 'repeat');
        const gs = Math.max(0.05, (f.grain.scale == null ? 100 : f.grain.scale) / 100);
        const ox = f.grain.moving ? pts[0].x : 0, oy = f.grain.moving ? pts[0].y : 0;
        if (pat.setTransform && typeof DOMMatrix !== 'undefined') pat.setTransform(new DOMMatrix().translate(ox, oy).scale(gs));
        t.save(); t.globalCompositeOperation = 'destination-in'; t.fillStyle = pat; t.fillRect(bx, by, bw, bh); t.restore();
      }
    }
    if (f.dual && f.dual.on) {
      const mk = document.createElement('canvas'); mk.width = W; mk.height = H;
      const q = mk.getContext('2d'); q.setTransform(W / bw, 0, 0, H / bh, -bx * (W / bw), -by * (H / bh));
      const d = f.dual, rr = seededRandom((stroke.id || 'live') + 'd');
      const dsize = Math.max(1, settings.size * (d.size || 40) / 100);
      const step = Math.max(0.6, dsize * Math.max(0.05, (d.spacing || 50) / 100));
      const line = resample(pts, step);
      const sp = settings.size * (d.scatter || 0) / 100;
      q.fillStyle = '#000';
      for (let i = 0; i < line.length; i++) {
        const cnt = Math.max(1, Math.round(d.count || 1));
        for (let c = 0; c < cnt; c++) {
          const x = line[i].x + (rr() - 0.5) * 2 * sp, y = line[i].y + (rr() - 0.5) * 2 * sp;
          if (d.img) {
            const iw = d.img.naturalWidth || d.img.width, ih = d.img.naturalHeight || d.img.height, kk = dsize / Math.max(iw, ih);
            q.save(); q.translate(x, y); q.rotate(rr() * Math.PI * 2); q.drawImage(d.img, -iw * kk / 2, -ih * kk / 2, iw * kk, ih * kk); q.restore();
          } else {
            const soft = Math.max(0.05, Math.min(1, (d.soft == null ? 100 : d.soft) / 100));
            if (soft >= 0.98) { q.beginPath(); q.arc(x, y, dsize / 2, 0, Math.PI * 2); q.fill(); }
            else { const gr = q.createRadialGradient(x, y, dsize / 2 * soft, x, y, dsize / 2); gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)'); q.fillStyle = gr; q.beginPath(); q.arc(x, y, dsize / 2, 0, Math.PI * 2); q.fill(); q.fillStyle = '#000'; }
          }
        }
      }
      t.save(); t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'destination-in'; t.drawImage(mk, 0, 0); t.restore();
    }
    ctx.save();
    if (f.blend && f.blend !== 'source-over') ctx.globalCompositeOperation = f.blend;
    ctx.drawImage(tmp, bx, by, bw, bh);
    ctx.restore();
  }

  // Smooths a raw captured point list before it's committed as a
  // stroke — the app's pre-existing brushSmooth technique (exponential
  // lerp toward each new point) generalised to run over a whole
  // finished stroke rather than only live, point-by-point. Reused as-is
  // because it already works well and stays cheap; see index.html's
  // strokeTo() for the live version applied during the stroke itself.
  function smoothPoints(points, amount) {
    const a = Math.max(0, Math.min(0.95, amount / 100));
    if (a <= 0 || points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = out[out.length - 1];
      out.push({
        x: prev.x + (points[i].x - prev.x) * (1 - a),
        y: prev.y + (points[i].y - prev.y) * (1 - a),
        pressure: points[i].pressure,
      });
    }
    out.push(points[points.length - 1]);
    return out;
  }

  global.BrushEngine = {
    BRUSHES, FAMILY_ORDER, FAMILY_LABEL, ERASER,
    getBrush, isVector, taperAt, registerStampBrush, unregisterStampBrush, makeCustomBrush, registerCustomBrush,
    getSettings, setSettings,
    touchRecent, getRecents,
    isFavorite, toggleFavorite, getFavorites,
    underlay: null, skipSmudge: BrushEngine_skipSmudge, wrap: BrushEngine_wrap, liveEnd, makeSmudger, makeCloner, liquifyStep, liquifyCompact, liquifyGL: _lq, pressureFactor, stampDab, colorWithAlpha, resample, renderStroke, smoothPoints, seededRandom,
  };
})(window);
