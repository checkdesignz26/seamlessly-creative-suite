/* Lookbook editor engine (shared).
 *
 * Extracted (copied, not moved) from the Lookbook editor inside Mock-up Studio so the Creative Lookbook
 * workspace can run it without Mock-up Studio. Mock-up Studio keeps its own inline copy, untouched.
 * The editor is DOM-based: each page is a .lookbook-canvas of .canvas-item layers.
 *
 * Needs, before it loads: the editor markup mounted (ScLookbookUI.mount) and /shared/collage-*.js.
 *
 * HOST SEAM — window.ScLookbookHost (all optional):
 *   getPatterns()  -> [{src, thumbSrc?, name?}]          seamless patterns (swatches, palette, collage)
 *   getImages()    -> [{src, thumbSrc?, name?, ar?}] | Promise   pictures: mock-ups, photos, artwork
 *   onChange()     -> called (debounced) after any edit; use it to autosave
 *   collageTabNames / collageEmptyNotes -> label overrides for the collage panel's source tabs
 * Public API (globals, as in the original): ilInit, ilSerializeLookbook, ilRestoreLookbook,
 *   ilRefreshHostStrips, ilRasterizeCanvas, ilExportPagePng, ilExportAllPdf, ilPages, ...
 */
'use strict';

function ilHost() { return window.ScLookbookHost || {}; }
function ilHostPatterns() { try { return (ilHost().getPatterns && ilHost().getPatterns()) || []; } catch (e) { return []; } }
async function ilHostImages() { try { return (ilHost().getImages && await ilHost().getImages()) || []; } catch (e) { return []; } }
if (typeof window.showToastMessage !== 'function') {
  window.showToastMessage = function (m) {
    let t = document.getElementById('scLbToast');
    if (!t) { t = document.createElement('div'); t.id = 'scLbToast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = m; t.className = 'show';
    clearTimeout(window.__scLbToastT); window.__scLbToastT = setTimeout(() => { t.className = ''; }, 3200);
  };
}
if (typeof window.downloadCanvasPNG !== 'function') {
  window.downloadCanvasPNG = function (canvas, filename) {
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.download = filename; a.href = url; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  };
}

// Change notification: any edit inside a page (drag, text, collage, background...) mutates the DOM,
// so one observer covers every tool without each having to remember to call us.
let ilChangeTimer = null;
function ilNotifyChange() {
  clearTimeout(ilChangeTimer);
  ilChangeTimer = setTimeout(() => { try { ilHost().onChange && ilHost().onChange(); } catch (e) { console.error(e); } }, 600);
}
let ilChangeObserver = null;
function ilWatchChanges() {
  if (ilChangeObserver || typeof MutationObserver === 'undefined') return;
  ilChangeObserver = new MutationObserver(muts => {
    // ignore pure selection/handle noise
    for (const m of muts) {
      if (m.type === 'attributes' && m.attributeName === 'class') continue;
      ilNotifyChange(); return;
    }
  });
  ilChangeObserver.observe(ilViewportEl, { childList: true, subtree: true, attributes: true, characterData: true });
}

const ilViewportEl = document.getElementById('lookbookViewport');
let ilPages = [];
let ilActivePageIndex = 0;
let ilZIndexCounter = 10;
let ilSelectedItem = null;
let ilCurrentPalette = ['#222222', '#ffffff'];

function ilActiveCanvas() {
  return ilPages[ilActivePageIndex] ? ilPages[ilActivePageIndex].el : null;
}

function ilLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function ilSelectItem(item) {
  if (window.ilMultiSel && window.ilMultiSel.size && !window.ilMultiSel.has(item)) window.ilClearMulti();
  document.querySelectorAll('.canvas-item.selected').forEach(el => el.classList.remove('selected'));
  item.classList.add('selected');
  ilSelectedItem = item;
  ilCollageOnSelectionChange();

  const deleteBtn = document.getElementById('ilDeleteItemBtn');
  if (deleteBtn) deleteBtn.disabled = false;

  // Deferred a tick: cheap insurance against a mid-click reflow, same reasoning as before this
  // moved into the side panel — now that the controls live in a fixed-width side panel rather
  // than a bar above the canvas, a content change here can't shift the canvas any more, but there's
  // no cost to keeping this off the same synchronous turn as the mousedown that triggered it.
  setTimeout(() => ilRefreshSelectionControls(item), 0);
}

function ilRefreshSelectionControls(item) {
  if (ilSelectedItem !== item) return;

  // Plain `hidden` toggling (not the old opacity/visibility class) — see the removed
  // .lookbook-editor-controls-wrapper CSS comment for why that was needed before and why it isn't
  // any more now these controls live in the side panel instead of a bar above the canvas.
  const layerControls = document.getElementById('ilLayerControls');
  const shadowGroup = document.getElementById('ilShadowGroup');
  const arrangeHint = document.getElementById('ilArrangeHint');
  const isPattern = item.dataset.hasPattern === 'true';
  layerControls.hidden = !isPattern;
  if (shadowGroup) shadowGroup.hidden = !isPattern;
  if (arrangeHint) arrangeHint.hidden = isPattern;
  if (isPattern) {
    const scale = item.dataset.scale || '100';
    const rotate = item.dataset.rotate || '0';
    const shadow = item.dataset.shadow || '0';
    document.getElementById('ilScaleSlider').value = scale;
    document.getElementById('ilRotateSlider').value = rotate;
    document.getElementById('ilShadowSlider').value = shadow;
    document.getElementById('ilScaleValue').textContent = scale + '%';
    document.getElementById('ilRotateValue').textContent = rotate + '°';
    document.getElementById('ilShadowValue').textContent = shadow + '%';
  }

  const collageArrange = document.getElementById('ilCollageArrangeBlock');
  const isCollage = !!item.__collage;
  if (collageArrange) collageArrange.hidden = !isCollage;
  if (isCollage && arrangeHint) arrangeHint.hidden = true;

  const textControls = document.getElementById('ilTextControls');
  const isText = item.classList.contains('text-item');
  textControls.hidden = !isText;
  if (isText) {
    const size = item.dataset.fontSize || '24';
    const pairSelect = document.getElementById('ilFontPairSelect');
    if (pairSelect) pairSelect.value = ilFindMatchingPairIndex(item.dataset.font || "'Quicksand', sans-serif");
    const singleSelect = document.getElementById('ilFontSingleSelect');
    if (singleSelect) singleSelect.value = ilFindSingleFontIndex(item.dataset.font || "'Quicksand', sans-serif");
    document.getElementById('ilFontSizeSlider').value = size;
    document.getElementById('ilFontSizeValue').textContent = size + 'px';
    ilRenderPaletteStrip(item.style.color);
  }
  if (window.ilToolsOnSelect) window.ilToolsOnSelect(item);
}

function ilDeselectAll() {
  document.querySelectorAll('.canvas-item.selected').forEach(el => el.classList.remove('selected'));
  if (window.ilClearMulti) window.ilClearMulti();
  ilSelectedItem = null;
  ilCollageOnSelectionChange();
  const deleteBtn = document.getElementById('ilDeleteItemBtn');
  if (deleteBtn) deleteBtn.disabled = true;
  const layerControls = document.getElementById('ilLayerControls');
  if (layerControls) layerControls.hidden = true;
  const shadowGroup = document.getElementById('ilShadowGroup');
  if (shadowGroup) shadowGroup.hidden = true;
  const arrangeHint = document.getElementById('ilArrangeHint');
  if (arrangeHint) arrangeHint.hidden = false;
  const textControls = document.getElementById('ilTextControls');
  if (textControls) textControls.hidden = true;
  const collageArrange = document.getElementById('ilCollageArrangeBlock');
  if (collageArrange) collageArrange.hidden = true;
  if (window.ilToolsOnDeselect) window.ilToolsOnDeselect();
}

// Multiple pages: each page is its own .lookbook-canvas element inside the
// viewport, with only the active one shown. Item creation always targets
// whichever page is currently active.
function ilSetupCanvasPageEvents(canvasEl) {
  canvasEl.addEventListener('dblclick', e => {
    if (e.target !== canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    ilCreateTextItem((e.clientX - rect.left) / ilZoom, (e.clientY - rect.top) / ilZoom);
  });
  canvasEl.addEventListener('mousedown', e => {
    if (e.target === canvasEl) ilDeselectAll();
  });
}

function ilAddPage() {
  const canvasEl = document.createElement('div');
  canvasEl.className = 'lookbook-canvas';
  canvasEl.style.transform = `scale(${ilZoom})`;
  // 'center' (not 'top center'): the viewport centers this box via flexbox align-items/
  // justify-content, which centers its UNSCALED layout box — scaling from any origin other than
  // dead center then re-offsets the visible, painted box away from that already-centered position
  // (scaling "from the top" pulls the painted box upward, clipping its top against the viewport's
  // own edge at anything below 100% zoom). Center-origin scaling stays anchored on the same point
  // flexbox already centered, so the fit (or any) zoom stays correctly centered at every scale.
  canvasEl.style.transformOrigin = 'center';
  ilSetupCanvasPageEvents(canvasEl);
  ilViewportEl.appendChild(canvasEl);
  // bg: { type: 'none'|'solid'|'image', color, imageSrc } — 'none' means the plain white CSS
  // default on .lookbook-canvas itself; see ilApplyPageBackground for how the other two render.
  ilPages.push({ el: canvasEl, bg: { type: 'none' } });
  ilSwitchToPage(ilPages.length - 1);
  ilRenderPageThumbnails();
  return ilPages[ilPages.length - 1];
}

function ilDeletePage(index) {
  if (ilPages.length <= 1) {
    showToastMessage('a lookbook needs at least one page');
    return;
  }
  ilPages[index].el.remove();
  ilPages.splice(index, 1);
  const newActive = Math.max(0, Math.min(ilActivePageIndex, ilPages.length - 1));
  ilSwitchToPage(newActive);
  ilRenderPageThumbnails();
}

// Page background (solid colour / uploaded image / none-i.e.-plain-white) — a property of the
// PAGE, not of any one layer, so it lives on the ilPages[] entry itself (page.bg) rather than as a
// canvas-item. Applied as a plain CSS background on the page's own .lookbook-canvas element, which
// sits BEHIND every real .canvas-item (those are all position:absolute, stacking in DOM/z-index
// order on top of whatever the canvas element's own background paints).
function ilApplyPageBackground(page) {
  const bg = page.bg || { type: 'none' };
  if (bg.type === 'solid') {
    page.el.style.backgroundImage = 'none';
    page.el.style.backgroundColor = bg.color || '#ffffff';
  } else if (bg.type === 'image' && bg.imageSrc) {
    page.el.style.backgroundImage = `url("${bg.imageSrc}")`;
    page.el.style.backgroundSize = 'cover';
    page.el.style.backgroundPosition = 'center';
    page.el.style.backgroundRepeat = 'no-repeat';
    page.el.style.backgroundColor = '#ffffff';
  } else {
    // 'none' — clear every inline override so the plain white CSS default on .lookbook-canvas
    // itself takes back over, rather than leaving a stale colour/image behind.
    page.el.style.backgroundImage = '';
    page.el.style.backgroundColor = '';
    page.el.style.backgroundSize = '';
    page.el.style.backgroundPosition = '';
    page.el.style.backgroundRepeat = '';
  }
}

function ilSetPageBackground(page, bg) {
  page.bg = bg;
  ilApplyPageBackground(page);
  ilRenderSinglePageThumbnail(ilPages.indexOf(page));
}

function ilSwitchToPage(index) {
  if (index < 0 || index >= ilPages.length) return;
  ilDeselectAll();
  ilActivePageIndex = index;
  ilPages.forEach((p, i) => { p.el.style.display = i === index ? 'block' : 'none'; });
  document.querySelectorAll('#ilPageThumbnails .lookbook-page-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
  // The page just switched to is already visible, so refreshing just its
  // own thumbnail (to reflect any edits since it was last shown) is free.
  ilRenderSinglePageThumbnail(index);
  // Keeps the Style panel's page-background colour input correct for whichever page is now
  // active, even if the panel isn't currently open (a no-op then, since it just sets an input's
  // value) — see ilSyncPageBgPopover's own comment.
  if (typeof ilSyncPageBgPopover === 'function') ilSyncPageBgPopover();
}

// Paging through the lookbook by a visual filmstrip instead of plain
// text tabs — clicking a thumbnail jumps to that page, the trailing "+"
// tile adds a new blank one, and hovering a thumbnail reveals a delete.
async function ilRenderSinglePageThumbnail(index) {
  const strip = document.getElementById('ilPageThumbnails');
  const page = ilPages[index];
  if (!strip || !page) return;
  const thumbEl = strip.children[index];
  if (!thumbEl || !thumbEl.classList.contains('lookbook-page-thumb')) return;

  try {
    const out = await ilRasterizeCanvas(page.el, 120 / 1200, page.bg);
    let img = thumbEl.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      thumbEl.insertBefore(img, thumbEl.firstChild);
    }
    img.src = out.toDataURL('image/png');
  } catch (err) {
    console.error('lookbook thumbnail failed', err);
  }
}

async function ilRenderPageThumbnails() {
  const strip = document.getElementById('ilPageThumbnails');
  if (!strip) return;
  strip.innerHTML = '';

  ilPages.forEach((page, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'lookbook-page-thumb' + (i === ilActivePageIndex ? ' active' : '');
    thumb.addEventListener('click', () => ilSwitchToPage(i));

    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = 'p' + (i + 1);
    thumb.appendChild(label);

    const del = document.createElement('div');
    del.className = 'thumb-delete';
    del.textContent = '×';
    del.title = 'delete this page';
    del.addEventListener('click', e => {
      e.stopPropagation();
      ilDeletePage(i);
    });
    thumb.appendChild(del);

    strip.appendChild(thumb);
  });

  const addTile = document.createElement('button');
  addTile.type = 'button';
  addTile.className = 'lookbook-page-thumb-add';
  addTile.textContent = '+';
  addTile.title = 'add page';
  addTile.addEventListener('click', () => ilAddPage());
  strip.appendChild(addTile);

  // Rasterising a page needs it actually rendered (a hidden page's own
  // items report zero size), so each inactive page is shown just long
  // enough to capture it — the same trick "export all pages" already
  // uses — then put back exactly how it was.
  const originalActive = ilActivePageIndex;
  for (let i = 0; i < ilPages.length; i++) {
    const page = ilPages[i];
    const wasHidden = page.el.style.display === 'none';
    if (wasHidden) page.el.style.display = 'block';
    await ilRenderSinglePageThumbnail(i);
    if (wasHidden) page.el.style.display = 'none';
  }
  ilPages.forEach((p, i) => { p.el.style.display = i === originalActive ? 'block' : 'none'; });
}

// A text item only enters edit mode on a double-click/double-tap (see the
// dblclick listener in ilCreateTextItem) — but .canvas-item sets
// touch-action:none (needed so a drag never triggers the browser's own
// scroll/zoom gestures), and that same setting makes iOS Safari's own
// double-tap-to-dblclick synthesis unreliable, so re-opening a text item
// for editing on an iPad was "hit or miss" depending on tap timing. Timing
// taps ourselves in pointerUp below (independent of whatever the browser
// does or doesn't synthesize) makes it reliable on both touch and mouse.
let ilLastTapItem = null;
let ilLastTapTime = 0;

function ilFocusTextEnd(textEl) {
  textEl.focus();
  const range = document.createRange();
  range.selectNodeContents(textEl);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Prompt 1: drag/drop/layering engine. Any .canvas-item becomes draggable
// anywhere on .lookbook-canvas, jumping to the top z-index the moment a
// user grabs it, and it works the same for mouse and touch input.
function ilMakeItemDraggable(item) {
  let dragging = false;
  let moved = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;
  let groupOrig = null;   // positions of every item of a multi-selection being dragged together

  function pointerDown(e) {
    // Let a focused text item keep normal text-cursor/selection behaviour
    // instead of hijacking the gesture into a drag.
    if (item.classList.contains('text-item')) {
      const textEl = item.querySelector('.text-item-content');
      if (textEl && document.activeElement === textEl) return;
    }
    if (e.target.classList.contains('item-resize-handle') || e.target.classList.contains('item-delete-handle') || e.target.classList.contains('item-rotate-handle')) return;

    e.preventDefault();
    // Multi-select: shift / ctrl / cmd-click, or the "select several" toggle, adds or removes the item
    // from the selection instead of starting a drag.
    if (window.ilToggleMulti && (e.shiftKey || e.metaKey || e.ctrlKey || (window.ilIsMultiMode && window.ilIsMultiMode()))) {
      window.ilToggleMulti(item);
      return;
    }
    ilSelectItem(item);
    dragging = true;
    moved = false;
    item.style.zIndex = ++ilZIndexCounter;
    groupOrig = (window.ilMultiSel && window.ilMultiSel.size > 1 && window.ilMultiSel.has(item))
      ? Array.from(window.ilMultiSel).map(el => ({ el, l: parseFloat(el.style.left) || 0, t: parseFloat(el.style.top) || 0 }))
      : null;

    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    origLeft = parseFloat(item.style.left) || 0;
    origTop = parseFloat(item.style.top) || 0;

    document.addEventListener('mousemove', pointerMove);
    document.addEventListener('touchmove', pointerMove, { passive: false });
    document.addEventListener('mouseup', pointerUp);
    document.addEventListener('touchend', pointerUp);
  }

  function pointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const point = e.touches ? e.touches[0] : e;
    const dx = (point.clientX - startX) / ilZoom;
    const dy = (point.clientY - startY) / ilZoom;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    // optional snapping (off unless the user turned it on) — see lookbook-tools.js
    const pos = window.ilSnapPosition ? window.ilSnapPosition(item, origLeft + dx, origTop + dy) : { left: origLeft + dx, top: origTop + dy };
    item.style.left = pos.left + 'px';
    item.style.top = pos.top + 'px';
    if (groupOrig) {
      const ddx = pos.left - origLeft, ddy = pos.top - origTop;
      groupOrig.forEach(g => { if (g.el !== item) { g.el.style.left = (g.l + ddx) + 'px'; g.el.style.top = (g.t + ddy) + 'px'; } });
    }
  }

  function pointerUp() {
    const wasDragging = dragging && moved;
    dragging = false;
    groupOrig = null;
    if (window.ilClearGuides) window.ilClearGuides();
    document.removeEventListener('mousemove', pointerMove);
    document.removeEventListener('touchmove', pointerMove);
    document.removeEventListener('mouseup', pointerUp);
    document.removeEventListener('touchend', pointerUp);
    if (wasDragging) ilRenderSinglePageThumbnail(ilActivePageIndex);

    if (!wasDragging && item.classList.contains('text-item')) {
      const textEl = item.querySelector('.text-item-content');
      if (textEl && document.activeElement !== textEl) {
        const now = Date.now();
        if (ilLastTapItem === item && now - ilLastTapTime < 400) {
          ilFocusTextEnd(textEl);
          ilLastTapItem = null;
          ilLastTapTime = 0;
        } else {
          ilLastTapItem = item;
          ilLastTapTime = now;
        }
      }
    }
  }

  item.addEventListener('mousedown', pointerDown);
  item.addEventListener('touchstart', pointerDown, { passive: false });
}

function ilMakeItemResizable(item, handle) {
  let resizing = false;
  let startX = 0, startY = 0, startW = 0, startH = 0;

  function down(e) {
    e.stopPropagation();
    e.preventDefault();
    ilSelectItem(item);
    resizing = true;
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    startW = item.offsetWidth;
    startH = item.offsetHeight;

    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up);
    document.addEventListener('touchend', up);
  }

  function move(e) {
    if (!resizing) return;
    e.preventDefault();
    const point = e.touches ? e.touches[0] : e;
    item.style.width = Math.max(40, startW + (point.clientX - startX) / ilZoom) + 'px';
    item.style.height = Math.max(30, startH + (point.clientY - startY) / ilZoom) + 'px';
  }

  function up() {
    const wasResizing = resizing;
    resizing = false;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('mouseup', up);
    document.removeEventListener('touchend', up);
    if (wasResizing) ilRenderSinglePageThumbnail(ilActivePageIndex);
  }

  handle.addEventListener('mousedown', down);
  handle.addEventListener('touchstart', down, { passive: false });
}

function ilAttachHandles(item) {
  const del = document.createElement('div');
  del.className = 'item-delete-handle';
  del.textContent = '×';
  del.addEventListener('click', e => {
    e.stopPropagation();
    if (window.ilMultiSel) window.ilMultiSel.delete(item);
    item.remove();
    if (ilSelectedItem === item) ilDeselectAll();
  });
  item.appendChild(del);

  const resize = document.createElement('div');
  resize.className = 'item-resize-handle';
  item.appendChild(resize);
  ilMakeItemResizable(item, resize);
}

function ilCreateImageItem({ src, x, y, w, h, hasPattern, hueRotate, scale, rotate, shadow, zIndex }) {
  const item = document.createElement('div');
  item.className = 'canvas-item';
  item.style.left = x + 'px';
  item.style.top = y + 'px';
  item.style.width = w + 'px';
  item.style.height = h + 'px';
  item.style.zIndex = zIndex || ++ilZIndexCounter;
  item.style.backgroundImage = `url("${src}")`;

  if (hasPattern) {
    item.dataset.hasPattern = 'true';
    item.dataset.scale = scale || '100';
    item.dataset.rotate = rotate || '0';
    item.dataset.shadow = shadow || '0';
    item.style.backgroundRepeat = 'repeat';
    item.style.backgroundSize = (scale || '100') + '%';
    if (rotate) item.style.transform = `rotate(${rotate}deg)`;
    if (shadow && shadow !== '0') item.style.boxShadow = ilShadowCss(parseInt(shadow, 10));
  }

  if (hueRotate) {
    item.dataset.hueRotate = hueRotate;
    item.style.filter = `hue-rotate(${hueRotate}deg)`;
  }

  ilActiveCanvas().appendChild(item);
  ilAttachHandles(item);
  ilMakeItemDraggable(item);
  return item;
}

/* ---------- Collage Builder glue ----------
   The collage itself (model, layout, masks, shadows, editor gestures, panel UI) lives in the shared
   /shared/collage-*.js files, so the suite Lookbook, the standalone Lookbook and this mini Lookbook all
   run the SAME engine. This block only does what is specific to this editor: make a collage a normal
   .canvas-item (draggable, resizable, layerable, saved, exported), and feed the panel its photo
   sources. A collage item keeps its whole editable model on item.__collage. */
let ilCollagePanel = null;
let ilCollageLastClick = { item: null, t: 0 };

// Thumbnails re-render after every edit, so decoded images are kept in a small LRU instead of being
// re-decoded from their (potentially huge) data URLs each time. Full quality is kept for export.
const ilCollageImageCache = new Map();
function ilCollageLoadImage(src) {
  if (ilCollageImageCache.has(src)) {
    const hit = ilCollageImageCache.get(src);
    ilCollageImageCache.delete(src); ilCollageImageCache.set(src, hit);
    return hit;
  }
  const p = ilLoadImage(src);
  ilCollageImageCache.set(src, p);
  p.catch(() => ilCollageImageCache.delete(src));
  if (ilCollageImageCache.size > 16) ilCollageImageCache.delete(ilCollageImageCache.keys().next().value);
  return p;
}

function ilCollageReady() {
  return !!(window.ScCollage && window.ScCollage.attachEditor && window.ScCollage.mountPanel);
}

function ilCreateCollageItem({ model, x, y, w, h, zIndex }) {
  const item = document.createElement('div');
  item.className = 'canvas-item collage-item';
  item.style.left = x + 'px';
  item.style.top = y + 'px';
  item.style.width = w + 'px';
  item.style.height = h + 'px';
  item.style.zIndex = zIndex || ++ilZIndexCounter;

  const host = document.createElement('div');
  host.className = 'collage-host';
  item.appendChild(host);
  ilActiveCanvas().appendChild(item);
  ilAttachHandles(item);
  ilMakeItemDraggable(item);

  const ctl = {
    item, host, model, editor: null,
    commit(final) {
      if (!final) return;
      ilNotifyChange();
      ilRenderSinglePageThumbnail(ilActivePageIndex);
    }
  };
  ctl.editor = window.ScCollage.attachEditor(host, {
    model,
    onChange: final => ctl.commit(final),
    onSelect: () => { if (ilCollagePanel) ilCollagePanel.sync(); }
  });
  item.__collage = ctl;

  // The engine lays out in px of its own box, so re-render whenever the item is resized.
  if (window.ResizeObserver) new ResizeObserver(() => ctl.editor.refresh()).observe(host);

  // Double-tap/double-click a collage to start editing its pieces (the panel button does the same).
  item.addEventListener('click', e => {
    if (e.target.closest('.item-resize-handle, .item-delete-handle')) return;
    const now = Date.now();
    if (ilCollageLastClick.item === item && now - ilCollageLastClick.t < 400 && !ctl.editor.isEditing()) {
      ctl.editor.setEditing(true);
      if (ilCollagePanel) ilCollagePanel.sync();
      ilCollageLastClick = { item: null, t: 0 };
    } else {
      ilCollageLastClick = { item, t: now };
    }
  });
  return ctl;
}

function ilNewCollage() {
  const SC = window.ScCollage;
  const model = SC.create();
  SC.setLayoutTemplate(model, 'quadrants');   // starts as four visible empty cells…
  model.autoPick = true;                      // …and follows the photo count until the user picks a layout
  const ctl = ilCreateCollageItem({ model, x: 100, y: 75, w: 1000, h: 700 });
  ilSelectItem(ctl.item);
  ctl.editor.setEditing(true);
  ctl.commit(true);
  return ctl;
}

function ilGetSelectedCollage() {
  return ilSelectedItem && ilSelectedItem.__collage ? ilSelectedItem.__collage : null;
}

// Editing is only ever on for the selected collage; selecting anything else ends it.
function ilCollageOnSelectionChange() {
  document.querySelectorAll('.collage-item').forEach(el => {
    if (el !== ilSelectedItem && el.__collage && el.__collage.editor.isEditing()) el.__collage.editor.setEditing(false);
  });
  if (ilCollagePanel) ilCollagePanel.sync();
}

function ilCollageProjectId() {
  try { return new URLSearchParams(location.search).get('project'); } catch (e) { return null; }
}

async function ilCollageSources(tab) {
  if (tab === 'patterns') {
    return ilHostPatterns().map(p => ({ src: p.src, thumb: p.thumbSrc || p.src, name: p.name || 'pattern', kind: 'pattern' }));
  }
  if (tab === 'mockups') {
    return (await ilHostImages()).map(p => ({ src: p.src, thumb: p.thumbSrc || p.src, name: p.name || 'image', kind: 'image', ar: p.ar }));
  }
  if (tab === 'project') {
    const projectId = ilCollageProjectId();
    if (!projectId || !window.SCLibrary) return [];
    const assets = await window.SCLibrary.listAssets(projectId);
    return assets.map(a => ({
      thumb: a.thumb ? URL.createObjectURL(a.thumb) : (a.file ? URL.createObjectURL(a.file) : ''),
      name: a.name || a.kind,
      kind: a.kind === 'pattern' ? 'pattern' : 'image',
      ar: a.width && a.height ? a.width / a.height : undefined,
      load: () => window.SCLibrary.blobToDataUrl(a.file)
    }));
  }
  return [];
}

function ilMountCollagePanel() {
  if (ilCollagePanel || !ilCollageReady()) return;
  const root = document.getElementById('ilCollageRoot');
  if (!root) return;
  ilCollagePanel = window.ScCollage.mountPanel(root, {
    // project assets (suite) are merged into these two lists by the suite bridge, so no separate 'project' tab
    tabs: ['patterns', 'mockups'],
    tabNames: (ilHost().collageTabNames || undefined),
    emptyNotes: (ilHost().collageEmptyNotes || undefined),
    getCollage: ilGetSelectedCollage,
    createCollage: ilNewCollage,
    // decorations are free page objects, not pieces locked inside the collage
    createDecor: kind => { if (window.ilAddShape) window.ilAddShape(kind === 'ring' ? 'circle' : kind); },
    // colours of the picture actually used in the selected frame (no need to import it again as a swatch)
    extractColours: slot => window.ilExtractColoursFromSrc ? window.ilExtractColoursFromSrc(slot.src) : Promise.resolve([]),
    applyColour: hex => { if (window.ilApplyColour) window.ilApplyColour(hex); },
    getSources: ilCollageSources,
    onBack: () => ilSetToolGroup('add'),
    deleteCollage: ctl => {
      ctl.item.remove();
      ilDeselectAll();
      ilNotifyChange();
      ilRenderSinglePageThumbnail(ilActivePageIndex);
    }
  });
}

function ilCollageOnPanelOpen() {
  ilMountCollagePanel();
  if (ilCollagePanel) { ilCollagePanel.sync(); ilCollagePanel.reloadSources(); }
}

document.getElementById('ilOpenCollageBtn')?.addEventListener('click', () => {
  if (!ilCollageReady()) { showToastMessage('the collage builder is still loading — try again in a second.'); return; }
  ilSetToolGroup('collage');
});
document.getElementById('ilEditCollageBtn')?.addEventListener('click', () => {
  ilSetToolGroup('collage');
  const ctl = ilGetSelectedCollage();
  if (ctl) { ctl.editor.setEditing(true); if (ilCollagePanel) ilCollagePanel.sync(); }
});


// Samples a pattern image down to a small canvas and picks its most
// frequent colours, merging near-duplicates (a busy print can otherwise
// yield five near-identical blues) so the palette actually spans the
// design's range.
function ilExtractPaletteColors(img, count) {
  count = count || 5;
  const SIZE = 48;
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  ilDrawCoverImage(ctx, img, 0, 0, SIZE, SIZE);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const STEP = 32;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const r = Math.round(data[i] / STEP) * STEP;
    const g = Math.round(data[i + 1] / STEP) * STEP;
    const b = Math.round(data[i + 2] / STEP) * STEP;
    const key = r + ',' + g + ',' + b;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const MIN_DISTANCE = 40;
  const picked = [];
  for (const [key] of sorted) {
    const [r, g, b] = key.split(',').map(Number);
    const tooClose = picked.some(p => Math.hypot(p.r - r, p.g - g, p.b - b) < MIN_DISTANCE);
    if (!tooClose) picked.push({ r, g, b });
    if (picked.length >= count) break;
  }
  while (picked.length < count) {
    const shade = 70 + picked.length * 40;
    picked.push({ r: shade, g: shade, b: shade });
  }

  return picked.map(({ r, g, b }) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join(''));
}

// A group of colour swatches that move and resize as one item — not tied
// to the pattern it was pulled from, so it can be dragged anywhere on the
// page to show off a design's palette at a glance. Dots are sized purely
// by CSS (see .palette-item), so resizing the box is all that's needed to
// make them bigger — no per-dot layout logic here.
function ilCreatePaletteItem({ colors, x, y, w, h, zIndex }) {
  const item = document.createElement('div');
  item.className = 'canvas-item palette-item';
  item.style.left = x + 'px';
  item.style.top = y + 'px';
  item.style.width = (w || Math.max(180, colors.length * 56)) + 'px';
  item.style.height = (h || 84) + 'px';
  item.style.zIndex = zIndex || ++ilZIndexCounter;
  item.dataset.colors = JSON.stringify(colors);

  colors.forEach(color => {
    const col = document.createElement('div');
    col.className = 'palette-swatch-col';

    const dot = document.createElement('div');
    dot.className = 'palette-dot';
    dot.style.background = color;
    col.appendChild(dot);

    const hex = document.createElement('span');
    hex.className = 'palette-hex';
    hex.textContent = color.toUpperCase();
    col.appendChild(hex);

    item.appendChild(col);
  });

  ilActiveCanvas().appendChild(item);
  ilAttachHandles(item);
  ilMakeItemDraggable(item);
  return item;
}

// Now a top-level toolbar action (used to live buried inside the layer-controls panel, only
// visible once a pattern swatch happened to be selected — easy to never find). Still prefers the
// SELECTED pattern's own colours when there is one (a design choice someone made on purpose, worth
// keeping specific), but works with no selection at all too, falling back to ilCurrentPalette — the
// same whole-collection palette the text-colour swatches already use, built once per editor open by
// ilBuildPaletteFromCollection — so the button is never just a dead click.
document.getElementById('ilAddPaletteBtn')?.addEventListener('click', async () => {
  const selectedPattern = ilSelectedItem && ilSelectedItem.dataset.hasPattern === 'true' ? ilSelectedItem : null;

  if (selectedPattern) {
    const match = /url\("?(.*?)"?\)/.exec(selectedPattern.style.backgroundImage);
    if (match) {
      try {
        const img = await ilLoadImage(match[1]);
        const colors = ilExtractPaletteColors(img, 5);
        const baseLeft = parseFloat(selectedPattern.style.left) || 0;
        const baseTop = parseFloat(selectedPattern.style.top) || 0;
        const baseHeight = selectedPattern.offsetHeight || 200;
        ilCreatePaletteItem({ colors, x: baseLeft, y: baseTop + baseHeight + 20 });
        await ilRenderSinglePageThumbnail(ilActivePageIndex);
        return;
      } catch (err) {
        console.error('colour palette extraction failed', err);
        showToastMessage('could not read that pattern\'s colours — try a different one.');
        return;
      }
    }
  }

  // No pattern selected (or the selected item had no readable image): drop the page's own
  // whole-collection palette, centred on the canvas rather than anchored below any particular item.
  const colors = (ilCurrentPalette || []).filter((c, i, arr) => arr.indexOf(c) === i).slice(0, 6);
  if (!colors.length) {
    showToastMessage('no pattern colours to add yet — add a pattern swatch to the page first.');
    return;
  }
  const w = Math.max(180, colors.length * 56);
  const h = 84;
  ilCreatePaletteItem({ colors, x: (IL_PAGE_W - w) / 2, y: (IL_PAGE_H - h) / 2 });
  await ilRenderSinglePageThumbnail(ilActivePageIndex);
});

// Prompt 2: text anywhere. Double-clicking empty canvas spawns a
// contenteditable box with placeholder text that grabs focus immediately;
// clicking away leaves it as a normal draggable .canvas-item (dragging is
// simply suppressed for as long as the item itself has focus).
function ilCreateTextItem(x, y, restore) {
  const item = document.createElement('div');
  item.className = 'canvas-item text-item';
  item.style.left = x + 'px';
  item.style.top = y + 'px';
  item.style.width = (restore && restore.width) || '220px';
  item.style.height = (restore && restore.height) || 'auto';
  item.style.zIndex = (restore && restore.zIndex) || ++ilZIndexCounter;
  item.dataset.font = (restore && restore.font) || "'Quicksand', sans-serif";
  item.dataset.fontSize = (restore && restore.fontSize) || '24';
  item.style.fontFamily = item.dataset.font;
  item.style.fontSize = item.dataset.fontSize + 'px';
  item.style.color = (restore && restore.color) || '#222222';
  if (restore && restore.opacity !== undefined && restore.opacity !== '') item.style.opacity = String(restore.opacity);

  // The editable text lives in its own child node — never a direct
  // sibling of the delete/resize handles — so the browser never treats
  // those buttons as part of the editable content while you type.
  const textEl = document.createElement('div');
  textEl.className = 'text-item-content';
  textEl.contentEditable = 'true';
  if (restore && restore.text) {
    textEl.dataset.placeholder = 'false';
    textEl.textContent = restore.text;
  } else {
    textEl.dataset.placeholder = 'true';
    textEl.textContent = 'Type here...';
  }
  item.appendChild(textEl);

  textEl.addEventListener('click', () => ilSelectItem(item));

  textEl.addEventListener('focus', () => {
    if (textEl.dataset.placeholder === 'true') {
      textEl.textContent = '';
      textEl.dataset.placeholder = 'false';
    }
  });

  textEl.addEventListener('blur', () => {
    if (!textEl.textContent.trim()) {
      textEl.textContent = 'Type here...';
      textEl.dataset.placeholder = 'true';
    }
    ilRenderSinglePageThumbnail(ilActivePageIndex);
  });

  item.addEventListener('dblclick', e => {
    e.stopPropagation();
    // The browser's own default for a double-click on text is "select the
    // word under the cursor", which fires right after this listener and
    // was clobbering the caret placement below — block it so ours sticks.
    e.preventDefault();
    ilFocusTextEnd(textEl);
  });

  ilActiveCanvas().appendChild(item);
  ilAttachHandles(item);
  ilMakeItemDraggable(item);

  if (!restore) {
    ilSelectItem(item);
    textEl.focus();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  return item;
}

document.getElementById('ilAddTextBtn')?.addEventListener('click', () => {
  ilCreateTextItem(60, 60);
});

document.getElementById('ilDeleteItemBtn')?.addEventListener('click', () => {
  if (ilSelectedItem) {
    const doomed = window.ilMultiSel && window.ilMultiSel.size > 1 ? Array.from(window.ilMultiSel) : [ilSelectedItem];
    doomed.forEach(el => el.remove());
    ilDeselectAll();
    ilRenderSinglePageThumbnail(ilActivePageIndex);
  }
});

// Prompt 3: pattern scale & rotate. Selecting an item that carries a
// repeating pattern background activates the two sliders; scale maps
// straight onto background-size, rotate onto a transform: rotate() that
// never touches the left/top the drag engine owns, so position holds.
document.getElementById('ilScaleSlider')?.addEventListener('input', e => {
  if (!ilSelectedItem || ilSelectedItem.dataset.hasPattern !== 'true') return;
  const scale = e.target.value;
  ilSelectedItem.dataset.scale = scale;
  ilSelectedItem.style.backgroundSize = scale + '%';
  document.getElementById('ilScaleValue').textContent = scale + '%';
});

document.getElementById('ilRotateSlider')?.addEventListener('input', e => {
  if (!ilSelectedItem || ilSelectedItem.dataset.hasPattern !== 'true') return;
  const deg = e.target.value;
  ilSelectedItem.dataset.rotate = deg;
  ilSelectedItem.style.transform = `rotate(${deg}deg)`;
  document.getElementById('ilRotateValue').textContent = deg + '°';
});

// Drop shadow, 0-100 intensity — one slider rather than a plain on/off toggle, so "a little lift"
// and "strongly floating off the page" are both reachable without a second control. The same
// blur/offset/alpha numbers drive both the live CSS box-shadow here and the canvas shadow* used
// when exporting (ilRasterizeCanvas), so what's on screen matches the PNG/PDF.
function ilShadowParams(intensity) {
  intensity = Math.max(0, Math.min(100, intensity || 0));
  return {
    blur: 6 + intensity * 0.3,
    offsetY: 2 + intensity * 0.12,
    alpha: 0.12 + intensity * 0.003
  };
}
function ilShadowCss(intensity) {
  if (!intensity) return 'none';
  const { blur, offsetY, alpha } = ilShadowParams(intensity);
  return `0 ${offsetY}px ${blur}px rgba(0,0,0,${alpha})`;
}

document.getElementById('ilShadowSlider')?.addEventListener('input', e => {
  if (!ilSelectedItem || ilSelectedItem.dataset.hasPattern !== 'true') return;
  const val = e.target.value;
  ilSelectedItem.dataset.shadow = val;
  ilSelectedItem.style.boxShadow = ilShadowCss(parseInt(val, 10));
  document.getElementById('ilShadowValue').textContent = val + '%';
});

// Curated title/body font pairings — picking a pairing and then marking
// a selected text layer as its "title" or "body" half is the whole font
// match-maker: no font-pairing intelligence needed, just a shortlist of
// combinations that are already known to look professional together.
const IL_FONT_PAIRS = [
  { name: 'Playfair Display + Quicksand', title: "'Playfair Display', serif", body: "'Quicksand', sans-serif" },
  { name: 'Bebas Neue + Helvetica', title: "'Bebas Neue', sans-serif", body: "'Helvetica Neue', Arial, sans-serif" },
  { name: 'Caveat + Georgia', title: "'Caveat', cursive", body: "Georgia, serif" },
  { name: 'Playfair Display + Helvetica', title: "'Playfair Display', serif", body: "'Helvetica Neue', Arial, sans-serif" },
  { name: 'Courier New + Verdana', title: "'Courier New', monospace", body: "Verdana, sans-serif" }
];

(function populateFontPairSelect() {
  const select = document.getElementById('ilFontPairSelect');
  if (!select) return;
  IL_FONT_PAIRS.forEach((pair, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = pair.name;
    select.appendChild(opt);
  });
})();

function ilFindMatchingPairIndex(font) {
  const index = IL_FONT_PAIRS.findIndex(p => p.title === font || p.body === font);
  return index === -1 ? 0 : index;
}

function ilApplyPairFont(role) {
  if (!ilSelectedItem || !ilSelectedItem.classList.contains('text-item')) return;
  const select = document.getElementById('ilFontPairSelect');
  const pair = IL_FONT_PAIRS[Number(select.value)];
  if (!pair) return;
  const font = pair[role];
  ilSelectedItem.dataset.font = font;
  ilSelectedItem.style.fontFamily = font;
}

document.getElementById('ilApplyTitleFontBtn')?.addEventListener('click', () => ilApplyPairFont('title'));
document.getElementById('ilApplyBodyFontBtn')?.addEventListener('click', () => ilApplyPairFont('body'));

// "single font" mode — for a page with just one text layer, picking a title/body pairing and
// marking it as one half of that pairing is more steps than the job needs. This is the same font
// list the pairings above already draw from (deduped), applied directly with no title/body role,
// so a one-off price tag, brand mark, etc. is a single select + one click.
const IL_SINGLE_FONTS = [
  { name: 'Quicksand', value: "'Quicksand', sans-serif" },
  { name: 'Playfair Display', value: "'Playfair Display', serif" },
  { name: 'Bebas Neue', value: "'Bebas Neue', sans-serif" },
  { name: 'Caveat', value: "'Caveat', cursive" },
  { name: 'Helvetica', value: "'Helvetica Neue', Arial, sans-serif" },
  { name: 'Georgia', value: 'Georgia, serif' },
  { name: 'Courier New', value: "'Courier New', monospace" },
  { name: 'Verdana', value: 'Verdana, sans-serif' }
];

(function populateFontSingleSelect() {
  const select = document.getElementById('ilFontSingleSelect');
  if (!select) return;
  IL_SINGLE_FONTS.forEach((font, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = font.name;
    select.appendChild(opt);
  });
})();

function ilFindSingleFontIndex(font) {
  const index = IL_SINGLE_FONTS.findIndex(f => f.value === font);
  return index === -1 ? 0 : index;
}

document.getElementById('ilApplySingleFontBtn')?.addEventListener('click', () => {
  if (!ilSelectedItem || !ilSelectedItem.classList.contains('text-item')) return;
  const select = document.getElementById('ilFontSingleSelect');
  const font = IL_SINGLE_FONTS[Number(select.value)];
  if (!font) return;
  ilSelectedItem.dataset.font = font.value;
  ilSelectedItem.style.fontFamily = font.value;
});

function ilSetFontMode(mode) {
  const isPair = mode === 'pair';
  document.getElementById('ilFontModePairBtn')?.classList.toggle('active', isPair);
  document.getElementById('ilFontModeSingleBtn')?.classList.toggle('active', !isPair);
  document.getElementById('ilFontPairGroup')?.toggleAttribute('hidden', !isPair);
  document.getElementById('ilFontSingleGroup')?.toggleAttribute('hidden', isPair);
}

document.getElementById('ilFontModePairBtn')?.addEventListener('click', () => ilSetFontMode('pair'));
document.getElementById('ilFontModeSingleBtn')?.addEventListener('click', () => ilSetFontMode('single'));

// Collapses the page filmstrip entirely (not just scrolled away) so it stops taking up vertical
// space in the editor card — handy once a lookbook is mid-design and every extra inch of canvas
// height matters. Remembered across sessions (and across every project, like the zoom/font
// choices already are) since it's a personal layout preference, not something tied to one lookbook.
const IL_THUMBNAILS_HIDDEN_KEY = 'il-thumbnails-hidden';
function ilApplyThumbnailsVisibility(hidden) {
  const strip = document.getElementById('ilPageThumbnails');
  const btn = document.getElementById('ilToggleThumbnailsBtn');
  if (strip) strip.classList.toggle('il-thumbnails-hidden', hidden);
  if (btn) btn.textContent = hidden ? 'show pages' : 'hide pages';
}
document.getElementById('ilToggleThumbnailsBtn')?.addEventListener('click', () => {
  const strip = document.getElementById('ilPageThumbnails');
  const nowHidden = !strip?.classList.contains('il-thumbnails-hidden');
  ilApplyThumbnailsVisibility(nowHidden);
  try { localStorage.setItem(IL_THUMBNAILS_HIDDEN_KEY, nowHidden ? '1' : '0'); } catch (e) {}
});
try { ilApplyThumbnailsVisibility(localStorage.getItem(IL_THUMBNAILS_HIDDEN_KEY) === '1'); } catch (e) {}

document.getElementById('ilFontSizeSlider')?.addEventListener('input', e => {
  if (!ilSelectedItem || !ilSelectedItem.classList.contains('text-item')) return;
  const size = e.target.value;
  ilSelectedItem.dataset.fontSize = size;
  ilSelectedItem.style.fontSize = size + 'px';
  document.getElementById('ilFontSizeValue').textContent = size + 'px';
});

// A quick "used colour palette" pulled from the uploaded pattern +
// collection, so text can be coloured to coordinate with the patterns
// on the page instead of guessing a hex code. Shares ilExtractPaletteColors
// (the same min-distance-dedup extractor the canvas colour-palette-group
// feature uses) rather than a plain top-N-by-frequency count — a plain
// count picks up several near-identical shades of whatever colour covers
// the most pixels (usually the background) and can starve out a colour
// like a leaf's green that's visually prominent but a smaller share of
// the pattern's total area.
let ilCustomTextColors = [];

async function ilBuildPaletteFromCollection() {
  // A small thumbnail gives the same colours as the full-resolution source
  // for this purpose, without the transient full decode of several
  // multi-thousand-pixel patterns at once.
  const sources = ilHostPatterns().map(p => p.thumbSrc || p.src);
  (await ilHostImages()).forEach(p => sources.push(p.thumbSrc || p.src));

  const extracted = [];
  for (const src of sources.slice(0, 4)) {
    try {
      const img = await ilLoadImage(src);
      extracted.push(...ilExtractPaletteColors(img, 4));
    } catch (err) {
      // a pattern that fails to load just contributes no colours
    }
  }

  const merged = ['#222222', '#ffffff'];
  const MIN_DISTANCE = 40;
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  extracted.concat(ilCustomTextColors).forEach(hex => {
    const c = hexToRgb(hex);
    const tooClose = merged.some(existing => {
      const e = hexToRgb(existing);
      return Math.hypot(c.r - e.r, c.g - e.g, c.b - e.b) < MIN_DISTANCE;
    });
    if (!tooClose) merged.push(hex);
  });

  ilCurrentPalette = merged.slice(0, 12);
}

function ilRenderPaletteStrip(activeColor) {
  // Text colour uses the same shared swatch component as shape fills/outlines and the page background
  // (see lookbook-tools.js): the page's colours, any colours extracted from collage pictures, and a custom picker.
  ilRenderColourStrip(document.getElementById('ilPaletteStrip'), activeColor, color => {
    if (!ilSelectedItem || !ilSelectedItem.classList.contains('text-item')) return;
    ilSelectedItem.style.color = color;
    ilRenderSinglePageThumbnail(ilActivePageIndex);
  });
}

document.getElementById('ilCustomColorInput')?.addEventListener('input', e => {
  const color = e.target.value;
  if (!ilCurrentPalette.includes(color)) {
    ilCustomTextColors.push(color);
    ilCurrentPalette.push(color);
  }
  // whichever swatch strip asked for a custom colour gets it (text, shape fill, outline, page background)
  if (window.ilCustomColourHandler) window.ilCustomColourHandler(color);
});

// Populate page 1 from whatever mock-ups/scenes are currently selected,
// staggered in a simple grid so nothing starts stacked. Extra pages start
// blank via the "+ page" tab.
function ilRenderPatternStrip() {
  const strip = document.getElementById('ilPatternStrip');
  if (!strip) return;
  strip.innerHTML = '';
  const patterns = ilHostPatterns();
  if (!patterns.length) {
    const p = document.createElement('p'); p.className = 'lookbook-tool-hint'; p.textContent = 'no patterns yet — upload one below.'; strip.appendChild(p);
  }
  patterns.forEach(({ src, thumbSrc, name }) => {
    const swatch = document.createElement('div');
    swatch.className = 'lookbook-pattern-swatch';
    swatch.style.backgroundImage = `url("${thumbSrc || src}")`;
    swatch.title = (name ? name + ' — ' : '') + 'click to add this pattern to the page';
    swatch.addEventListener('click', () => {
      ilCreateImageItem({ src, x: 80, y: 80, w: 220, h: 220, hasPattern: true });
      ilNotifyChange();
    });
    ilAttachSwatchRemove(swatch, 'pattern', src);
    strip.appendChild(swatch);
  });
}

// Optional: a host that lets the user delete library items gets a small x on each swatch.
function ilAttachSwatchRemove(swatch, kind, src) {
  if (!ilHost().removeAsset) return;
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'lb-swatch-x'; x.textContent = '×'; x.title = 'remove from this project\'s library';
  x.setAttribute('aria-label', 'remove from library');
  x.addEventListener('click', e => { e.stopPropagation(); ilHost().removeAsset(kind, src); });
  swatch.appendChild(x);
}

// Pictures (mock-ups, photos, artwork) the host holds. Tap one to place it at its own proportions —
// never stretched.
async function ilRenderImageStrip() {
  const strip = document.getElementById('ilImageStrip');
  if (!strip) return;
  strip.innerHTML = '';
  const images = await ilHostImages();
  if (!images.length) {
    const p = document.createElement('p'); p.className = 'lookbook-tool-hint'; p.textContent = 'no images yet — upload some below.'; strip.appendChild(p);
  }
  images.forEach(({ src, thumbSrc, name, ar }) => {
    const swatch = document.createElement('div');
    swatch.className = 'lookbook-pattern-swatch';
    swatch.style.backgroundImage = `url("${thumbSrc || src}")`;
    swatch.title = (name ? name + ' — ' : '') + 'click to add this picture to the page';
    swatch.addEventListener('click', async () => {
      let a = ar;
      if (!a) { try { const im = await ilLoadImage(src); a = im.naturalWidth / (im.naturalHeight || 1); } catch (e) { a = 1; } }
      const w = a >= 1 ? 420 : Math.round(420 * a), h = a >= 1 ? Math.round(420 / a) : 420;
      ilCreateImageItem({ src, x: 120, y: 100, w, h, hasPattern: false });
      ilNotifyChange();
    });
    ilAttachSwatchRemove(swatch, 'image', src);
    strip.appendChild(swatch);
  });
}

function ilRefreshHostStrips() {
  ilRenderPatternStrip(); ilRenderImageStrip(); if (ilCollagePanel) ilCollagePanel.reloadSources();
  if (window.ilRenderAssetTray) window.ilRenderAssetTray();
  // new uploads add their colours to every colour picker (text, shapes, page background)
  ilBuildPaletteFromCollection().then(() => { if (ilSelectedItem) ilRefreshSelectionControls(ilSelectedItem); if (window.ilRefreshColourStrips) window.ilRefreshColourStrips(); }).catch(() => {});
}

// Page background controls now live directly in the Style panel (the standalone popover they used
// to be in was retired — the Style panel already opens on demand via the tool rail, which made the
// popover one extra nested layer the left-panel redesign was specifically meant to avoid). Reads/
// writes the ACTIVE page's own bg (see ilApplyPageBackground) — re-synced whenever the Style group
// is switched to or the active page changes, so it never goes stale (see ilSetToolGroup/
// ilSwitchToPage below).
function ilSyncPageBgPopover() {
  const page = ilPages[ilActivePageIndex];
  const colorInput = document.getElementById('ilPageBgColorInput');
  if (!page || !colorInput) return;
  colorInput.value = (page.bg && page.bg.type === 'solid' && page.bg.color) || '#ffffff';
}

document.getElementById('ilPageBgColorInput')?.addEventListener('input', e => {
  const page = ilPages[ilActivePageIndex];
  if (!page) return;
  ilSetPageBackground(page, { type: 'solid', color: e.target.value });
});

document.getElementById('ilPageBgImageBtn')?.addEventListener('click', () => {
  document.getElementById('ilPageBgImageFile')?.click();
});

document.getElementById('ilPageBgImageFile')?.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // allow picking the same file again later
  if (!file) return;
  const page = ilPages[ilActivePageIndex];
  if (!page) return;
  const reader = new FileReader();
  reader.onload = ev => {
    ilSetPageBackground(page, { type: 'image', imageSrc: ev.target.result });
  };
  reader.readAsDataURL(file);
});

document.getElementById('ilPageBgClearBtn')?.addEventListener('click', () => {
  const page = ilPages[ilActivePageIndex];
  if (!page) return;
  ilSetPageBackground(page, { type: 'none' });
  ilSyncPageBgPopover();
});

// The whole canvas can be zoomed for a better fit on smaller screens (an
// iPad, say) without changing the underlying page — it's a pure CSS scale,
// so item positions/sizes (and export/thumbnail rendering, which reads
// offsetWidth/style.left directly) are completely unaffected. Any pointer
// math that turns screen-pixel movement into canvas-local px (dragging,
// resizing, double-click placement) divides by ilZoom to compensate.
let ilZoom = 1;
// The page is a fixed 1200x850 native canvas (see .lookbook-canvas and the "do not change export
// resolution" requirement this all exists to satisfy) — ilZoom only ever drives a CSS
// transform:scale() on top of that, same as it always did; nothing below touches the canvas's own
// width/height, so every export (ilRasterizeCanvas reads offsetWidth/item.style.left, neither of
// which transform:scale changes) is completely unaffected by how it's displayed on screen.
const IL_PAGE_W = 1200, IL_PAGE_H = 850;
const IL_ZOOM_MIN = 0.4, IL_ZOOM_MAX = 2; // matches the zoom slider's own min="40" max="200"

// Whether the current zoom is the auto-computed "fit" value (vs. a zoom the user picked by hand).
// Drives whether rotating/resizing the iPad should silently re-fit (true) or leave a deliberate
// manual zoom alone (false) — see the resize/orientationchange handler below.
let ilZoomIsFit = true;

function ilApplyZoom() {
  ilPages.forEach(p => {
    p.el.style.transform = `scale(${ilZoom})`;
    p.el.style.transformOrigin = 'center'; // see the matching comment in ilAddPage() above
  });
}

// transform:scale() only changes PAINT, not the layout box flexbox sizes the viewport's content
// against — .lookbook-canvas keeps its true 1200x850 flex-basis at any zoom (deliberately: that's
// what keeps item coordinates, offsetWidth and every export measurement correct regardless of
// display zoom). That leaves the flex container's own scrollable area sized for the UNscaled page
// even while fit-zoom paints it smaller and perfectly centered — so at fit zoom there's technically
// scrollable space nothing is actually in. overflow:hidden while fit removes the ability to swipe
// into that dead space at all; switching to overflow:auto the moment zoom is manual
// (ilZoomIsFit === false) is what makes "zoom in to inspect detail" actually scrollable, per
// requirement 6.
function ilUpdateViewportOverflow() {
  if (ilViewportEl) ilViewportEl.style.overflow = ilZoomIsFit ? 'hidden' : 'auto';
}

function ilSetZoom(zoom) {
  ilZoom = Math.max(IL_ZOOM_MIN, Math.min(IL_ZOOM_MAX, zoom));
  const pct = Math.round(ilZoom * 100);
  const zoomSlider = document.getElementById('ilZoomSlider');
  if (zoomSlider) zoomSlider.value = pct;
  const zoomValue = document.getElementById('ilZoomValue');
  if (zoomValue) zoomValue.textContent = pct + '%';
  ilApplyZoom();
}

// Reads the viewport's REAL, already-laid-out size — after the header, toolbar, pattern row, layer
// controls and page filmstrip have all taken their own space out of the editor card's fixed height,
// since #lookbookViewport is the one flex:1 child that absorbs whatever's left. That's "the
// available canvas space after accounting for the header, toolbar and other controls" without any
// hardcoded, easily-stale height arithmetic — it's just however big the browser actually rendered
// this element, which is correct in portrait, landscape, split-view, or any future toolbar change.
function ilComputeFitZoom() {
  if (!ilViewportEl) return 1;
  const cs = getComputedStyle(ilViewportEl);
  const availW = ilViewportEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = ilViewportEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return 1;
  return Math.max(IL_ZOOM_MIN, Math.min(IL_ZOOM_MAX, Math.min(availW / IL_PAGE_W, availH / IL_PAGE_H)));
}

function ilFitPage() {
  ilSetZoom(ilComputeFitZoom());
  ilZoomIsFit = true;
  ilUpdateViewportOverflow();
}

document.getElementById('ilZoomSlider')?.addEventListener('input', e => {
  ilZoom = parseInt(e.target.value, 10) / 100;
  ilZoomIsFit = false; // a manual zoom — leave it alone on rotation/resize until "fit page" is pressed again
  ilUpdateViewportOverflow();
  const valueEl = document.getElementById('ilZoomValue');
  if (valueEl) valueEl.textContent = e.target.value + '%';
  ilApplyZoom();
});

document.getElementById('ilFitPageBtn')?.addEventListener('click', ilFitPage);

// Keeps the page correctly fit across an iPad rotation (or a split-view resize) instead of leaving
// it at whatever scale happened to fit the previous orientation — but only while the user hasn't
// since picked their own zoom by hand (ilZoomIsFit), so "zoom in for detailed editing" isn't fought
// every time the device so much as rotates.
let ilResizeDebounce = null;
function ilHandleViewportResize() {
  clearTimeout(ilResizeDebounce);
  ilResizeDebounce = setTimeout(() => {
    const overlay = document.getElementById('interactiveLookbookOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (!ilZoomIsFit) return;
    ilFitPage();
  }, 120);
}
// A ResizeObserver on the viewport itself is a strict superset of the old window
// resize/orientationchange listeners it replaces: it still catches a genuine window resize or
// device rotation (those always change the viewport's own box too), and it ALSO fires whenever the
// left tool panel's expand/collapse width-transition changes the viewport's size — which a
// window-level listener would never see at all, since the window itself hasn't resized, only the
// space the viewport gets inside it. ResizeObserver fires repeatedly *during* a CSS width
// transition; ilHandleViewportResize's existing 120ms debounce already collapses that into a single
// recompute right after the panel finishes animating, so "Automatically recalculate Fit Page when
// the panel expands or collapses" falls out of this for free, no extra timing code needed.
if (typeof ResizeObserver !== 'undefined' && ilViewportEl) {
  new ResizeObserver(() => ilHandleViewportResize()).observe(ilViewportEl);
} else {
  window.addEventListener('resize', ilHandleViewportResize);
  window.addEventListener('orientationchange', ilHandleViewportResize);
}

// ---- Left-hand tool rail: Add / Arrange / Style / Export -------------------------------------
// Starts collapsed (maximum canvas space on open, per the brief); last-open group and whether the
// panel was left open persist in localStorage, mirroring the existing il-thumbnails-hidden pattern.
const IL_TOOL_GROUPS = ['add', 'arrange', 'style', 'export', 'collage'];
const IL_TOOL_GROUP_TITLES = { add: 'Add', arrange: 'Arrange', style: 'Style', export: 'Export', collage: 'Collage builder' };
const IL_TOOL_PANEL_OPEN_KEY = 'il-tool-panel-open';
const IL_TOOL_PANEL_GROUP_KEY = 'il-tool-panel-group';
let ilToolGroup = null; // null = collapsed

function ilToolPanelEls() {
  return {
    rail: document.getElementById('ilToolRail'),
    panel: document.getElementById('ilToolPanel'),
    backdrop: document.getElementById('ilToolPanelBackdrop'),
    title: document.getElementById('ilToolPanelTitle')
  };
}

// Reused by every open/close/switch path below so the panel, its backdrop (overlay mode only —
// see the max-width:980px media query), the rail's own active highlight, and localStorage always
// agree with each other.
function ilApplyToolPanelState() {
  const { rail, panel, backdrop, title } = ilToolPanelEls();
  if (!panel) return;
  const isOpen = ilToolGroup !== null;
  panel.classList.toggle('open', isOpen);
  panel.setAttribute('aria-hidden', String(!isOpen));
  if (backdrop) backdrop.hidden = !isOpen;
  if (title && ilToolGroup) title.textContent = IL_TOOL_GROUP_TITLES[ilToolGroup];
  if (rail) {
    rail.querySelectorAll('.lookbook-rail-btn').forEach(btn => {
      // The Collage builder is a sub-view of Add, so Add stays lit while it's open.
      btn.classList.toggle('active', btn.dataset.group === (ilToolGroup === 'collage' ? 'add' : ilToolGroup));
    });
  }
  IL_TOOL_GROUPS.forEach(group => {
    const section = document.getElementById('ilGroup' + group.charAt(0).toUpperCase() + group.slice(1));
    if (section) section.hidden = group !== ilToolGroup;
  });
  if (ilToolGroup === 'style') ilSyncPageBgPopover();
  if (ilToolGroup === 'collage') ilCollageOnPanelOpen();
}

function ilSetToolGroup(group) {
  ilToolGroup = group;
  try {
    localStorage.setItem(IL_TOOL_PANEL_OPEN_KEY, '1');
    localStorage.setItem(IL_TOOL_PANEL_GROUP_KEY, group);
  } catch (e) {}
  ilApplyToolPanelState();
}

function ilCollapseToolPanel() {
  ilToolGroup = null;
  try { localStorage.setItem(IL_TOOL_PANEL_OPEN_KEY, '0'); } catch (e) {}
  ilApplyToolPanelState();
}

document.getElementById('ilToolRail')?.addEventListener('click', e => {
  const btn = e.target.closest('.lookbook-rail-btn');
  if (!btn) return;
  const group = btn.dataset.group;
  // Tapping the already-open group collapses the panel (toggle); any other tap switches straight
  // to that group without needing a separate close-then-reopen step.
  if (ilToolGroup === group) ilCollapseToolPanel();
  else ilSetToolGroup(group);
});

document.getElementById('ilToolPanelCollapseBtn')?.addEventListener('click', ilCollapseToolPanel);
document.getElementById('ilToolPanelBackdrop')?.addEventListener('click', ilCollapseToolPanel);

function ilNextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

// Host-driven start-up (the Mock-up version opens an overlay; here the host app owns the screen).
async function ilInit() {
  ilRenderPatternStrip();
  ilRenderImageStrip();
  let savedGroup = null;
  try {
    if (localStorage.getItem(IL_TOOL_PANEL_OPEN_KEY) === '1') {
      const g = localStorage.getItem(IL_TOOL_PANEL_GROUP_KEY);
      savedGroup = IL_TOOL_GROUPS.includes(g) ? g : 'add';
    }
  } catch (e) {}
  ilToolGroup = savedGroup;
  ilApplyToolPanelState();
  await ilNextFrame();
  await ilNextFrame();
  ilFitPage();
  await ilBuildPaletteFromCollection();
}

function ilWrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(/\s+/);
  let line = '';
  let cy = y;
  words.forEach(word => {
    const testLine = line ? line + ' ' + word : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, cy);
      line = word;
      cy += lineHeight;
    } else {
      line = testLine;
    }
  });
  if (line) ctx.fillText(line, x, cy);
}

function ilDrawCoverImage(ctx, img, x, y, w, h) {
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const boxRatio = w / h;
  let sx, sy, sw, sh;
  if (imgRatio > boxRatio) {
    sh = img.naturalHeight;
    sw = sh * boxRatio;
    sy = 0;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sw = img.naturalWidth;
    sh = sw / boxRatio;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Mirrors the CSS the live canvas item actually uses (background-size set
// to the scale percentage), which sizes the tile as a percentage of the
// ITEM'S OWN box width, height following automatically to keep the
// image's aspect ratio.
// Sizing the tile off the source image's raw natural pixel dimensions
// instead (as this used to) tiles at a completely different density than
// what's on screen, since an uploaded pattern's natural size has no
// relation to the small box it's previewed in — that's what made an
// export/thumbnail look like a random crop of the artwork instead of the
// repeating swatch shown live.
function ilDrawTiledPattern(ctx, img, w, h, scalePercent) {
  const scale = Math.max(0.05, scalePercent / 100);
  const tileW = Math.max(4, Math.round(w * scale));
  const tileH = Math.max(4, Math.round(tileW * (img.naturalHeight / img.naturalWidth || 1)));
  const tileCanvas = document.createElement('canvas');
  tileCanvas.width = tileW;
  tileCanvas.height = tileH;
  tileCanvas.getContext('2d').drawImage(img, 0, 0, tileW, tileH);
  ctx.fillStyle = ctx.createPattern(tileCanvas, 'repeat');
  ctx.fillRect(0, 0, w, h);
}

// Rasterises the free-form canvas (images honouring their scale/rotate,
// tiled patterns honouring their own scale, text honouring its wrapping)
// into one flat canvas for export, since none of this exists as real DOM
// once it needs to become a PNG or a PDF page.
async function ilRasterizeCanvas(canvasEl, scaleFactor, bg) {
  // Every page is a fixed 1200x850 .lookbook-canvas, so a hidden (inactive)
  // page can still be rasterised for a thumbnail without switching it into
  // view first — offsetWidth/Height just read 0 while display:none.
  const w = canvasEl.offsetWidth || 1200;
  const h = canvasEl.offsetHeight || 850;
  const out = document.createElement('canvas');
  scaleFactor = scaleFactor || 2;
  out.width = w * scaleFactor;
  out.height = h * scaleFactor;
  const ctx = out.getContext('2d');
  ctx.scale(scaleFactor, scaleFactor);

  // Mirrors ilApplyPageBackground's three states exactly, so the export always matches what's on
  // screen: a solid colour fill, a cover-fit uploaded image (white underneath, same as the live
  // CSS background-color fallback for any transparent part of that image), or plain white.
  if (bg && bg.type === 'solid') {
    ctx.fillStyle = bg.color || '#ffffff';
    ctx.fillRect(0, 0, w, h);
  } else if (bg && bg.type === 'image' && bg.imageSrc) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    try {
      const bgImg = await ilLoadImage(bg.imageSrc);
      ilDrawCoverImage(ctx, bgImg, 0, 0, w, h);
    } catch (err) {
      console.error('lookbook export: failed to load page background image', err);
    }
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  const items = [...canvasEl.querySelectorAll('.canvas-item')]
    .sort((a, b) => (parseInt(a.style.zIndex) || 0) - (parseInt(b.style.zIndex) || 0));

  for (const item of items) {
    const x = parseFloat(item.style.left) || 0;
    const y = parseFloat(item.style.top) || 0;
    const iw = item.offsetWidth;
    const ih = item.offsetHeight;
    const rotate = parseFloat(item.dataset.rotate || 0);

    ctx.save();
    ctx.translate(x + iw / 2, y + ih / 2);
    ctx.rotate(rotate * Math.PI / 180);
    ctx.translate(-iw / 2, -ih / 2);
    // item opacity (text and shapes have an opacity control; everything else is 1)
    const itemOpacity = item.style.opacity === '' ? 1 : parseFloat(item.style.opacity);
    if (isFinite(itemOpacity)) ctx.globalAlpha = Math.max(0, Math.min(1, itemOpacity));

    if (item.__collage && window.ScCollage) {
      // Same engine + same maths as the live DOM, so the export matches the screen. Editor
      // chrome (handles, dividers, empty-cell placeholders) is never drawn here.
      await window.ScCollage.drawCanvas(ctx, item.__collage.model, iw, ih, ilCollageLoadImage);
    } else if (item.classList.contains('shape-item')) {
      if (window.ilDrawShapeItem) window.ilDrawShapeItem(ctx, item, iw, ih);
    } else if (item.classList.contains('text-item')) {
      const textEl = item.querySelector('.text-item-content');
      if (textEl && textEl.dataset.placeholder !== 'true') {
        const style = getComputedStyle(item);
        ctx.fillStyle = style.color;
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.textBaseline = 'top';
        ilWrapText(ctx, textEl.innerText, 10, 8, iw - 20, parseFloat(style.fontSize) * 1.3);
      }
    } else if (item.classList.contains('palette-item')) {
      // Mirrors the .palette-item CSS exactly: each dot at 50% of the box
      // height with its hex code below (a fixed 10px, same as the CSS,
      // since neither scales with a resize), laid out with equal gaps at
      // both ends and in between (the canvas equivalent of
      // justify-content: space-evenly), so the export matches the live
      // drag/resizeable group pixel for pixel.
      let colors = [];
      try { colors = JSON.parse(item.dataset.colors || '[]'); } catch (err) { colors = []; }
      const n = colors.length;
      if (n) {
        const radius = 6;
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.moveTo(radius, 0);
        ctx.arcTo(iw, 0, iw, ih, radius);
        ctx.arcTo(iw, ih, 0, ih, radius);
        ctx.arcTo(0, ih, 0, 0, radius);
        ctx.arcTo(0, 0, iw, 0, radius);
        ctx.closePath();
        ctx.fill();

        const dotSize = ih * 0.5;
        const gapPx = ih * 0.03;
        const fontSize = 10;
        const contentHeight = dotSize + gapPx + fontSize;
        const startY = (ih - contentHeight) / 2;
        const dotCenterY = startY + dotSize / 2;
        const textY = startY + dotSize + gapPx;
        const gap = (iw - n * dotSize) / (n + 1);

        colors.forEach((color, i) => {
          const cx = gap * (i + 1) + dotSize * i + dotSize / 2;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(cx, dotCenterY, dotSize / 2, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#333333';
          ctx.font = `${fontSize}px Quicksand, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(color.toUpperCase(), cx, textY);
        });
      }
    } else {
      const match = /url\("?(.*?)"?\)/.exec(item.style.backgroundImage);
      if (match) {
        try {
          const img = await ilLoadImage(match[1]);
          if (item.dataset.hasPattern === 'true') {
            const hue = parseFloat(item.dataset.hueRotate || 0);
            if (hue) ctx.filter = `hue-rotate(${hue}deg)`;
            // Matches the live CSS box-shadow this item gets from the shadow slider (see
            // ilShadowParams) — set on the context before the fillRect inside ilDrawTiledPattern so
            // it casts around the same rotated rect the live box-shadow would, then cleared right
            // after so it can't leak onto anything drawn next (ctx.save()/restore() around this
            // whole per-item block would reset it anyway; cleared explicitly too for the same
            // belt-and-suspenders reason ctx.filter is reset right below instead of just relying on
            // restore()).
            const shadowIntensity = parseInt(item.dataset.shadow || '0', 10);
            if (shadowIntensity) {
              const { blur, offsetY, alpha } = ilShadowParams(shadowIntensity);
              ctx.shadowColor = `rgba(0,0,0,${alpha})`;
              ctx.shadowBlur = blur;
              ctx.shadowOffsetY = offsetY;
            }
            ilDrawTiledPattern(ctx, img, iw, ih, parseFloat(item.dataset.scale || 100));
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;
            ctx.filter = 'none';
          } else {
            ilDrawCoverImage(ctx, img, 0, 0, iw, ih);
          }
        } catch (err) {
          console.error('lookbook export: failed to load layer image', err);
        }
      }
    }

    ctx.restore();
  }

  return out;
}

// Seamlessly Creative suite hook — same rasterisation path as the PNG
// export button right above (ilActiveCanvas + ilRasterizeCanvas),
// read-only. Used by shared/adapters/mockup-adapter.js's "send page to
// project" button. Lives in this exact scope because ilActivePageIndex
// is a plain top-level `let` binding, not a window property, so it's
// only reachable from code that shares this same script's scope — not
// from a separately-loaded <script src>.
window.__scGetLookbookPageCanvas = async function () {
  const canvasEl = ilActiveCanvas();
  if (!canvasEl) return null;
  const out = await ilRasterizeCanvas(canvasEl, undefined, ilPages[ilActivePageIndex] && ilPages[ilActivePageIndex].bg);
  return { canvas: out, name: 'Lookbook page ' + (ilActivePageIndex + 1) };
};


function ilSerializeLookbookItem(item) {
  const base = {
    left: item.style.left,
    top: item.style.top,
    width: item.style.width,
    height: item.style.height,
    zIndex: item.style.zIndex
  };

  // Collage: the whole editable model is saved as plain JSON (arrangement, masks, shadows, decorations,
  // every photo), so it reopens fully editable — never flattened.
  if (item.__collage) {
    return Object.assign(base, { type: 'collage', model: JSON.parse(JSON.stringify(item.__collage.model)) });
  }

  if (item.classList.contains('text-item')) {
    const textEl = item.querySelector('.text-item-content');
    return Object.assign(base, {
      type: 'text',
      text: (textEl && textEl.dataset.placeholder !== 'true') ? textEl.textContent : '',
      font: item.dataset.font || "'Quicksand', sans-serif",
      fontSize: item.dataset.fontSize || '24',
      color: item.style.color || '#222222',
      opacity: item.style.opacity || ''
    });
  }

  if (item.classList.contains('shape-item') && window.ilSerializeShape) {
    return Object.assign(base, window.ilSerializeShape(item));
  }

  if (item.classList.contains('palette-item')) {
    let colors = [];
    try { colors = JSON.parse(item.dataset.colors || '[]'); } catch (err) { colors = []; }
    return Object.assign(base, { type: 'palette', colors });
  }

  const match = /url\("?(.*?)"?\)/.exec(item.style.backgroundImage);
  return Object.assign(base, {
    type: 'image',
    src: match ? match[1] : '',
    hasPattern: item.dataset.hasPattern === 'true',
    scale: item.dataset.scale || '100',
    rotate: item.dataset.rotate || '0',
    shadow: item.dataset.shadow || '0',
    hueRotate: item.dataset.hueRotate || '0'
  });
}

function ilRestoreLookbookItem(data) {
  const x = parseFloat(data.left) || 0;
  const y = parseFloat(data.top) || 0;
  const zIndexNum = parseInt(data.zIndex) || 0;

  if (data.type === 'text') {
    ilCreateTextItem(x, y, {
      text: data.text,
      font: data.font,
      fontSize: data.fontSize,
      color: data.color,
      opacity: data.opacity,
      width: data.width,
      height: data.height,
      zIndex: data.zIndex
    });
  } else if (data.type === 'collage') {
    if (window.ScCollage) {
      ilCreateCollageItem({
        model: window.ScCollage.normalize(data.model),
        x, y,
        w: parseFloat(data.width) || 1000,
        h: parseFloat(data.height) || 700,
        zIndex: data.zIndex
      });
    }
  } else if (data.type === 'shape') {
    if (window.ilRestoreShape) window.ilRestoreShape(data, x, y);
  } else if (data.type === 'palette') {
    ilCreatePaletteItem({
      colors: data.colors || [],
      x, y,
      w: parseFloat(data.width) || undefined,
      h: parseFloat(data.height) || undefined,
      zIndex: data.zIndex
    });
  } else if (data.src) {
    const w = parseFloat(data.width) || 200;
    const h = parseFloat(data.height) || 200;
    ilCreateImageItem({
      src: data.src,
      x, y, w, h,
      hasPattern: data.hasPattern,
      hueRotate: parseFloat(data.hueRotate || 0),
      scale: data.scale,
      rotate: data.rotate,
      shadow: data.shadow,
      zIndex: data.zIndex
    });
  }

  return zIndexNum;
}

// ---- Project (de)serialisation of the whole lookbook: pages -> items (+ page background) ----
function ilSerializeLookbook() {
  return {
    pageW: IL_PAGE_W, pageH: IL_PAGE_H,
    pages: ilPages.map(p => ({
      items: [...p.el.querySelectorAll('.canvas-item')]
        .sort((a, b) => (parseInt(a.style.zIndex) || 0) - (parseInt(b.style.zIndex) || 0))
        .map(ilSerializeLookbookItem),
      bg: p.bg || { type: 'none' }
    }))
  };
}

async function ilRestoreLookbook(data) {
  ilViewportEl.innerHTML = '';
  ilPages = [];
  ilActivePageIndex = 0;
  ilZIndexCounter = 10;
  ilSelectedItem = null;
  const pages = (data && data.pages) || [];
  let maxZ = 10;
  pages.forEach(pageData => {
    const items = Array.isArray(pageData) ? pageData : (pageData.items || []);
    const bg = Array.isArray(pageData) ? null : pageData.bg;
    const page = ilAddPage();
    if (bg) ilSetPageBackground(page, bg);
    items.forEach(itemData => { maxZ = Math.max(maxZ, ilRestoreLookbookItem(itemData)); });
  });
  if (!ilPages.length) ilAddPage();
  ilZIndexCounter = maxZ;
  ilSwitchToPage(0);
  await ilRenderPageThumbnails();
}

async function ilExportPagePng() {
  const canvasEl = ilActiveCanvas();
  if (!canvasEl) return;
  const out = await ilRasterizeCanvas(canvasEl, undefined, ilPages[ilActivePageIndex] && ilPages[ilActivePageIndex].bg);
  downloadCanvasPNG(out, ilProjectFileStem() + '-page-' + (ilActivePageIndex + 1) + '.png');
}

// ---- Exports (self-hosted libraries: /shared/vendor/pdf-lib.min.js, jszip.min.js) ----
function ilProjectFileStem() {
  let n = '';
  try { n = (ilHost().projectName && ilHost().projectName()) || ''; } catch (e) {}
  n = String(n || 'lookbook').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 60);
  return n || 'lookbook';
}
function ilDownloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.download = filename; a.href = url; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}
function ilCanvasToBlob(canvas, type, q) { return new Promise(res => canvas.toBlob(res, type, q)); }

// Rasterising needs real layout, so each page is briefly shown while it is captured (a display:none
// page reports 0 size); the page that was active is restored afterwards.
async function ilRasterizeAllPages(onProgress) {
  const original = ilActivePageIndex, out = [];
  try {
    for (let i = 0; i < ilPages.length; i++) {
      ilPages.forEach((p, idx) => { p.el.style.display = idx === i ? 'block' : 'none'; });
      void ilPages[i].el.offsetHeight;
      out.push(await ilRasterizeCanvas(ilPages[i].el, undefined, ilPages[i].bg));
      if (onProgress) onProgress(i + 1, ilPages.length);
    }
  } finally {
    ilPages.forEach((p, idx) => { p.el.style.display = idx === original ? 'block' : 'none'; });
  }
  return out;
}

async function ilExportPageJpeg() {
  const canvasEl = ilActiveCanvas();
  if (!canvasEl) return;
  const out = await ilRasterizeCanvas(canvasEl, undefined, ilPages[ilActivePageIndex] && ilPages[ilActivePageIndex].bg);
  const blob = await ilCanvasToBlob(out, 'image/jpeg', 0.93);
  ilDownloadBlob(blob, ilProjectFileStem() + '-page-' + (ilActivePageIndex + 1) + '.jpg');
}

async function ilExportAllPdf(onProgress) {
  if (!window.PDFLib) { showToastMessage('the PDF library is still loading — try again in a second.'); return false; }
  if (!ilPages.length) return false;
  const canvases = await ilRasterizeAllPages(onProgress);
  const pdf = await window.PDFLib.PDFDocument.create();
  for (const c of canvases) {
    const w = c.width / 2, h = c.height / 2;   // pt; the raster is 2x the page for a crisp print/screen result
    const blob = await ilCanvasToBlob(c, 'image/jpeg', 0.92);
    const img = await pdf.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  const bytes = await pdf.save();
  ilDownloadBlob(new Blob([bytes], { type: 'application/pdf' }), ilProjectFileStem() + '.pdf');
  return true;
}

async function ilExportAllZip(onProgress) {
  if (!window.JSZip) { showToastMessage('the ZIP library is still loading — try again in a second.'); return false; }
  if (!ilPages.length) return false;
  const canvases = await ilRasterizeAllPages(onProgress);
  const zip = new window.JSZip(), stem = ilProjectFileStem();
  for (let i = 0; i < canvases.length; i++) {
    zip.file(stem + '-page-' + String(i + 1).padStart(2, '0') + '.png', await ilCanvasToBlob(canvases[i], 'image/png'));
  }
  ilDownloadBlob(await zip.generateAsync({ type: 'blob' }), stem + '-pages.zip');
  return true;
}
