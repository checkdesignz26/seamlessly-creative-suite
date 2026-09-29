/**
 * Seamlessly Creative — shared repeat-tile builder.
 *
 * The general, raster/pixel-based counterpart to Pattern Playground's own
 * procedural Half Brick/Half Drop repeat math (Classics Studio's
 * drawRepeatUnit, working on its own dot-layer data). This module does the
 * same JOB - turn a plain seamless-when-grid-tiled source image into
 * whatever representation actually tiles correctly for Half Brick/Half
 * Drop - but for an ARBITRARY raster image (a Mock-up Studio upload, or any
 * other pattern with no procedural layer data behind it), not dot layers.
 *
 * Used by Mock-up Studio when a user brings in their own pattern (local
 * upload, or a Project asset with no prepared repeatTile yet) and picks a
 * repeat style. Playground's own assets that already carry a prepared
 * repeatTile + repeatLayout (see project-library.js's asset shape) are NOT
 * touched by this file - those are used as-is, unchanged, exactly as
 * before this module existed.
 *
 * IMPORTANT LIMITATION, stated plainly rather than silently papered over:
 * a flat, already-rendered "seamless grid tile" PNG has its edge content
 * already cropped to the tile's own square bounds (that's what makes it
 * seamless AS A GRID tile in the first place - e.g. a motif that touches a
 * corner appears as four quarter-shapes, one per corner). Restacking such
 * a flat image into a brick/drop arrangement (this file's square-source
 * path, below) can only offset WHOLE COPIES of that already-cropped image
 * - it cannot recover shape information that was never in the file to
 * begin with. For a source tile whose content doesn't touch its own
 * edges, this produces a genuinely correct, seamless result. For a source
 * tile with edge-touching content (E.g. a motif deliberately anchored at
 * a corner), the row/column seam can show the same kind of double-image
 * artifact any "offset a plain tile to fake a brick repeat" technique
 * produces - this is the same fundamental technique (and the same
 * limitation) Creative Resizer's own existing half-brick/half-drop
 * converter already uses (see makeSquareWorkingTileFromSource +
 * repeatMode's row/column offset math in studios/resizer/index.html), not
 * a new gap introduced here. It is NOT a limitation for a source that
 * ALREADY IS the correct, non-square true repeat unit (built by Pattern
 * Playground, or by external repeat-design software) - see the
 * non-square/rectangular-source path below, which uses such a file
 * exactly as given, no pixel manipulation at all.
 */
(function (global) {
  'use strict';

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = src;
    });
  }

  // A source within this tolerance of a perfect square is treated as ONE
  // repeat cell that Half Brick/Half Drop still needs to build a doubled
  // unit from. Anything further off square is treated as ALREADY being a
  // prepared, non-square true repeat unit (a rectangular file from
  // external repeat-design software, or one Mock-up Studio itself built
  // earlier) and is used exactly as given - dimensions/orientation are
  // read only to make THIS one call (build vs. use-as-is), never to guess
  // which repeat style is active; the style is always whatever the
  // caller/user selected.
  const SQUARE_TOLERANCE = 0.08;

  function looksSquare(w, h) {
    const longer = Math.max(w, h), shorter = Math.max(1, Math.min(w, h));
    return (longer / shorter - 1) <= SQUARE_TOLERANCE;
  }

  // Builds the doubled repeat unit from a single square-ish source cell -
  // the raster equivalent of Pattern Playground's drawRepeatUnit for a
  // plain image instead of dot layers. row0 unshifted, row1 (or col1 for
  // half-drop) shifted by half the cell size with horizontal (or
  // vertical) wraparound, so the unit tiles correctly with ITSELF left-
  // right (top-bottom for half-drop) at least - see this file's header
  // for the one seam this technique cannot always guarantee.
  function buildDoubledUnit(sourceCanvas, layout) {
    const cellW = sourceCanvas.width, cellH = sourceCanvas.height;
    const canvas = document.createElement('canvas');
    if (layout === 'halfbrick') {
      canvas.width = cellW;
      canvas.height = cellH * 2;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceCanvas, 0, 0);
      // Wraparound marching (3 copies) so the shifted row is itself
      // horizontally seamless, not just a single off-center copy.
      [-cellW, 0, cellW].forEach((dx) => ctx.drawImage(sourceCanvas, dx + cellW / 2, cellH));
    } else {
      canvas.width = cellW * 2;
      canvas.height = cellH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(sourceCanvas, 0, 0);
      [-cellH, 0, cellH].forEach((dy) => ctx.drawImage(sourceCanvas, cellW, dy + cellH / 2));
    }
    return canvas;
  }

  function toCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  /**
   * Builds the repeatTile Mock-up Studio (or any other plain-grid tiler)
   * should actually use for the given source + repeat style.
   *
   * @param {HTMLImageElement|HTMLCanvasElement} source - the user's
   *   ORIGINAL seamless pattern, untouched by this call either way.
   * @param {string} layout - 'grid' | 'halfbrick' | 'halfdrop'.
   * @returns {Promise<HTMLCanvasElement>} the repeatTile canvas. For
   *   'grid', or any source already treated as a prepared true unit, this
   *   is the source's own pixels on a fresh canvas (never the same
   *   element reference, so a caller can safely treat the result as a
   *   distinct, disposable image) - not a re-derived approximation.
   */
  async function buildRepeatTile(source, layout) {
    const img = (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement)
      ? source
      : await loadImage(source);
    const sourceCanvas = toCanvas(img);
    if (layout !== 'halfbrick' && layout !== 'halfdrop') return sourceCanvas;
    if (!looksSquare(sourceCanvas.width, sourceCanvas.height)) {
      // Already a rectangle - trust it's a prepared true repeat unit
      // (from Pattern Playground, or external repeat-design software) and
      // use it exactly as given. Never force it to square, never crop it.
      return sourceCanvas;
    }
    return buildDoubledUnit(sourceCanvas, layout);
  }

  global.SCRepeatTileBuilder = { buildRepeatTile, looksSquare };
})(window);
