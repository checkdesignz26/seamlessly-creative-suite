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
      defaults: { size: 6, opacity: 100, smoothing: 35, pressureWidth: 55, pressureOpacity: 10, spacing: 6 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none' },
    { id: 'technicalPen', name: 'Technical Pen', family: 'inking', renderMode: 'vector',
      defaults: { size: 4, opacity: 100, smoothing: 45, pressureWidth: 5, pressureOpacity: 0, spacing: 5 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'none' },
    { id: 'taperedInk', name: 'Tapered Ink', family: 'inking', renderMode: 'vector',
      defaults: { size: 7, opacity: 100, smoothing: 30, pressureWidth: 70, pressureOpacity: 0, spacing: 6 },
      hardness: 1, jitter: 0, streaky: 0, taper: 'both' },
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
      defaults: { size: 34, opacity: 95, smoothing: 15, pressureWidth: 35, pressureOpacity: 15, spacing: 14 },
      hardness: 0.8, jitter: 0.12, streaky: 0.06, taper: 'none' },
    { id: 'dryBrush', name: 'Dry Brush', family: 'paint', renderMode: 'vector',
      defaults: { size: 26, opacity: 85, smoothing: 10, pressureWidth: 40, pressureOpacity: 35, spacing: 8 },
      hardness: 0.5, jitter: 0.3, streaky: 0.45, taper: 'none' },
    { id: 'chalk', name: 'Chalk', family: 'paint', renderMode: 'vector',
      defaults: { size: 20, opacity: 70, smoothing: 5, pressureWidth: 20, pressureOpacity: 40, spacing: 6 },
      hardness: 0.35, jitter: 0.4, streaky: 0.4, taper: 'none' },
    { id: 'crayon', name: 'Crayon', family: 'paint', renderMode: 'vector',
      defaults: { size: 16, opacity: 80, smoothing: 5, pressureWidth: 25, pressureOpacity: 25, spacing: 5 },
      hardness: 0.6, jitter: 0.25, streaky: 0.3, taper: 'none' },
  ];

  const FAMILY_ORDER = ['inking', 'pencil', 'marker', 'paint'];
  const FAMILY_LABEL = { inking: 'Inking', pencil: 'Pencil', marker: 'Marker', paint: 'Paint / Texture' };

  const ERASER = { id: 'eraser', name: 'Eraser', family: 'eraser', renderMode: 'raster',
    defaults: { size: 26, opacity: 100, smoothing: 15, pressureWidth: 30, pressureOpacity: 0, spacing: 6 },
    hardness: 0.9, jitter: 0, streaky: 0, taper: 'none' };

  const byId = new Map(BRUSHES.map((b) => [b.id, b]));
  byId.set(ERASER.id, ERASER);

  function getBrush(id) { return byId.get(id) || BRUSHES[0]; }
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
    return Object.assign({}, brush.defaults, settingsStore[brushId] || {});
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

  // Renders one stroke (vector or, called from the app's raster path,
  // one in-progress raster segment) onto `ctx` using `brush`'s current
  // settings. This is the single function both the vector replay path
  // and the live raster-paint path call — see file header.
  function renderStroke(ctx, stroke, brush, settings, alphaMul) {
    if (!stroke.points || stroke.points.length === 0) return;
    if (alphaMul === undefined) alphaMul = 1;
    if (alphaMul <= 0) return; // fully hidden — skip dabs entirely rather than stamp at opacity 0
    const spacingPx = Math.max(1, (settings.spacing / 100) * Math.max(4, settings.size));
    const pts = resample(stroke.points, spacingPx);
    const rand = seededRandom(stroke.id || 'live');
    const n = pts.length;
    pts.forEach((pt, i) => {
      const widthMul = pressureFactor(pt.pressure, settings.pressureWidth);
      const opMul = pressureFactor(pt.pressure, settings.pressureOpacity);
      let taperMul = 1;
      if (brush.taper === 'both') {
        const edge = Math.min(i, n - 1 - i);
        const taperLen = Math.max(2, Math.round(n * 0.12));
        if (edge < taperLen) taperMul = Math.max(0.12, edge / taperLen);
      }
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
      stampDab(ctx, x, y, radius, opacity, stroke.color || '#000000', brush.hardness);
    });
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
    getBrush, isVector,
    getSettings, setSettings,
    touchRecent, getRecents,
    isFavorite, toggleFavorite, getFavorites,
    pressureFactor, stampDab, colorWithAlpha, resample, renderStroke, smoothPoints, seededRandom,
  };
})(window);
