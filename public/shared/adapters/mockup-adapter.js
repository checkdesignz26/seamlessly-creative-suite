/**
 * Mock-up Studio suite adapter — RECEIVE side.
 *
 * Only activates with ?project=<id> in the URL (i.e. loaded from the
 * Seamlessly Creative shell). Opened standalone, this script no-ops.
 *
 * Lists the project's pattern-ish assets (pattern/motif/background)
 * from the shared library and adds each chosen one through Mock-up
 * Studio's OWN existing entry point, addQuickCollectionPattern(src) —
 * that function is a genuine top-level global in this app (it is not
 * wrapped in an IIFE), so it's called directly rather than needing a
 * hook to be added, the way Playground's portfolio internals did.
 *
 * REAL USER REPORT this file (and the small inline patch at the top
 * of index.html's <head>) fixes: Mock-up Studio has TWO overlapping
 * save slots — a "quick save" (idbSaveProject, MSTUDIO_IDB_KEY,
 * written only when the user clicks that button by hand) and a
 * separate 20s-interval "autosave" (MSTUDIO_IDB_AUTOSAVE_KEY, written
 * continuously in the background) that's only ever offered back via a
 * native confirm() popup on the next load — and this adapter was
 * ALSO running its own silent restore from the quick-save slot on top
 * of that. Result: the user saw a confusing native "found autosaved
 * work — restore it?" popup, with no clear idea whether cancelling
 * would delete anything, while a second, invisible restore from a
 * DIFFERENT, likely-staler slot happened right after it regardless.
 *
 * Fixed as ONE restore path, not two: index.html's inline patch
 * answers that popup silently (always "yes, restore" — the one
 * answer that can never delete anything) instead of showing it, and
 * this adapter no longer runs a second, separate restore of its own —
 * the continuously-updated autosave slot is the more complete
 * snapshot anyway (it captures every manual edit made directly in
 * Mock-up Studio's own UI, not just patterns added from the project
 * panel below). This adapter still calls idbSaveProject() itself
 * right after adding a project asset — a zero-latency safety net so
 * that specific action is captured instantly rather than waiting up
 * to 20s for the next autosave tick, and it also keeps the app's own
 * "quick load" button (still visible, untouched) meaningful if the
 * user reaches for it directly.
 *
 * KNOWN PHASE 1 LIMIT (flagging rather than hiding): both of these
 * slots are single GLOBAL keys in mockupStudioDB, not scoped per
 * suite project — Mock-up Studio itself has no concept of "project".
 * Two different suite projects will currently share the same restored
 * mock-up layout/session; only the shared asset library (what's
 * listed in the panel below) is genuinely project-scoped. Making
 * Mock-up Studio's own state project-aware is Phase 2+ work, not
 * something this adapter can safely paper over on its own.
 *
 * --- SEND side (Phase 2) -------------------------------------------
 *
 * Two small "send to project" buttons, mirroring Pattern Playground's
 * send button (see playground-adapter.js) but for Mock-up Studio's
 * own two output kinds:
 *   - a rendered product mock-up (kind 'mockup')
 *   - an exported interactive-lookbook page (kind 'lookbook')
 * Both read the SAME canvas the app's own existing "download" buttons
 * already use, via two tiny read-only window hooks added right next
 * to those download handlers in index.html
 * (window.__scGetCurrentMockupCanvas, window.__scGetLookbookPageCanvas)
 * — nothing here duplicates or second-guesses how those images
 * actually get rendered, and neither hook changes what those download
 * buttons do. Pattern Pages already routes any non-pattern/motif/
 * background kind into its design-assets tray (see pages-adapter.js's
 * trayTypeFor), so 'mockup' and 'lookbook' assets show up there with
 * no changes needed on that side.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) return;

  // addQuickCollectionPattern persists whatever src string it's given
  // into mockupStudioDB via the app's own autosave — a blob: URL would
  // go stale the moment the tab closes, so assets are converted to a
  // real dataURL first. Downscaled to a working resolution (matching
  // what Playground's adapter sends) rather than left at full size,
  // to keep that autosave payload iPad-friendly.
  const WORKING_PX = 1800;

  async function toWorkingDataUrl(blob) {
    const fullDataUrl = await window.SCLibrary.blobToDataUrl(blob);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = fullDataUrl;
    });
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= WORKING_PX) return fullDataUrl;
    const scale = WORKING_PX / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  }

  function buildPanel() {
    const host = document.getElementById('quickCollectionStrip');
    if (!host || !host.parentNode) return null;

    const panel = document.createElement('section');
    panel.id = 'scAddFromProjectPanel';
    panel.className = 'upload-strip';
    panel.style.cssText = 'margin-top:10px;flex-direction:column;align-items:stretch;gap:8px;';
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <strong>Seamlessly Creative project</strong>
        <button id="scRefreshBtn" class="secondary" type="button">refresh</button>
      </div>
      <div id="scProjectAssetGrid" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      <div id="scProjectStatus" style="font-size:12px;opacity:.75;"></div>
    `;
    host.parentNode.insertBefore(panel, host.nextSibling);
    return panel;
  }

  async function renderGrid(grid, statusEl) {
    grid.innerHTML = '';
    statusEl.textContent = 'loading project…';
    const assets = (await window.SCLibrary.listAssets(projectId)).filter((a) =>
      ['pattern', 'motif', 'background'].includes(a.kind)
    );
    if (!assets.length) {
      statusEl.textContent = 'No patterns in this project yet — send some from Pattern Playground first.';
      return;
    }
    statusEl.textContent = `${assets.length} available — tap one to add it to your collection`;

    for (const asset of assets) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.title = asset.name;
      tile.style.cssText =
        'width:64px;height:64px;padding:0;border-radius:8px;overflow:hidden;' +
        'border:2px solid transparent;cursor:pointer;position:relative;background:#0002;';

      // CONFIRMED on real hardware: an <img src> pointed at
      // URL.createObjectURL(blob) for a Blob that came back out of
      // IndexedDB can fail to decode on iPad Safari, even though the
      // exact same Blob decodes fine everywhere else in this app (the
      // "add to collection" click below, converting via
      // blobToDataUrl -> new Image(), works — that's proven by the
      // mockups actually rendering the pattern correctly). So the
      // thumbnail uses that same proven data:-URL path instead of an
      // object URL, rather than a fallback for a rarer edge case.
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      let triedFallback = false;

      // REAL BUG found from a live screenshot: 4 tiles stuck as plain
      // grey squares forever — not slow, permanently stuck, no letter
      // fallback and no broken-image icon either. Root cause: this had
      // no .catch() on the blobToDataUrl() promise. When reading a
      // Blob back out of IndexedDB fails (same class of iPad Safari
      // issue already hit once with object URLs), the promise just
      // rejects silently — img.src is never set, so img's own 'error'
      // event (the ONLY thing the old code listened for) never fires
      // either, since nothing was ever assigned to fail. Both failure
      // modes — a rejected promise, and an <img> that fails to decode
      // a successfully-set src — now go through this one place.
      function showFallback(reason) {
        console.error('[suite] project asset image failed to load entirely', asset.name, reason, {
          thumbBytes: asset.thumb ? asset.thumb.size : null,
          fileBytes: asset.file ? asset.file.size : null,
        });
        tile.innerHTML = '';
        tile.style.background = '#463a66';
        tile.style.display = 'flex';
        tile.style.alignItems = 'center';
        tile.style.justifyContent = 'center';
        tile.style.fontSize = '20px';
        tile.textContent = (asset.name || '?').trim().charAt(0).toUpperCase();
      }
      function trySrcFrom(blob) {
        if (!blob) {
          if (!triedFallback && asset.thumb) { triedFallback = true; return trySrcFrom(asset.file); }
          showFallback('no blob available');
          return;
        }
        window.SCLibrary.blobToDataUrl(blob).then(
          (dataUrl) => { img.src = dataUrl; },
          (err) => {
            if (!triedFallback && asset.thumb) {
              triedFallback = true;
              console.warn('[suite] reading thumb blob failed, retrying with full-res file', asset.name, err);
              trySrcFrom(asset.file);
              return;
            }
            showFallback(err);
          }
        );
      }
      img.addEventListener('error', () => {
        if (!triedFallback && asset.thumb) {
          triedFallback = true;
          console.warn('[suite] thumb data URL failed to decode, retrying with full-res file', asset.name);
          trySrcFrom(asset.file);
          return;
        }
        showFallback('img decode failed');
      });
      trySrcFrom(asset.thumb || asset.file);
      tile.appendChild(img);

      tile.addEventListener('click', async () => {
        tile.disabled = true;
        tile.style.opacity = '0.5';
        window.SCStatus && window.SCStatus.set('saving');
        try {
          const workingSrc = await toWorkingDataUrl(asset.file);
          await addQuickCollectionPattern(workingSrc);
          // addQuickCollectionPattern does not itself persist — see the
          // file header. performAutosave writes to the SAME key
          // (MSTUDIO_IDB_AUTOSAVE_KEY) that's now the sole thing
          // restored on load, so an add-then-immediately-reload can't
          // lose this addition while waiting for the next 20s tick.
          // idbSaveProject also keeps the app's own separate "quick
          // load" button (still visible, untouched) meaningful too.
          await performAutosave(false);
          await idbSaveProject(serializeProject());
          tile.style.borderColor = '#22c55e';
          window.SCStatus && window.SCStatus.set('saved');
        } catch (err) {
          console.error('[suite] failed to add project asset', asset, err);
          tile.style.borderColor = '#ef4444';
          window.SCStatus && window.SCStatus.set('idle');
        } finally {
          tile.disabled = false;
          tile.style.opacity = '1';
        }
      });
      grid.appendChild(tile);
    }
  }

  // --- SEND side (Phase 2) ------------------------------------------

  // Same working-resolution convention as every other adapter (Playground
  // sends at 1800px; Pattern Pages downscales incoming assets to the
  // same) — keeps what lands in the shared library well inside iPad
  // Safari's comfort zone, the same size class a real export already is.
  const SEND_PX = 1800;

  function canvasToWorkingDataUrl(canvas) {
    const longest = Math.max(canvas.width, canvas.height);
    if (longest <= SEND_PX) return canvas.toDataURL('image/png');
    const scale = SEND_PX / longest;
    const scaled = document.createElement('canvas');
    scaled.width = Math.round(canvas.width * scale);
    scaled.height = Math.round(canvas.height * scale);
    scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
    return scaled.toDataURL('image/png');
  }

  // One shared button-builder for both send buttons — same shape, same
  // status/error handling, only the source hook, asset kind and copy
  // differ.
  function attachSendButton({ afterEl, label, kind, getCanvasInfo, emptyMessage }) {
    if (!afterEl || !afterEl.parentNode) return;
    const wrap = document.createElement('div');
    wrap.className = 'scSendBar';
    wrap.style.cssText = 'margin-top:8px;display:flex;flex-direction:column;gap:4px;';
    wrap.innerHTML = `
      <button type="button" class="secondary scSendToProjectBtn" style="width:100%;">${label}</button>
      <span class="scSendStatus" style="font-size:12px;opacity:.75;"></span>
    `;
    afterEl.insertAdjacentElement('afterend', wrap);
    const btn = wrap.querySelector('.scSendToProjectBtn');
    const statusEl = wrap.querySelector('.scSendStatus');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      window.SCStatus && window.SCStatus.set('saving');
      try {
        const info = await getCanvasInfo();
        if (!info) {
          statusEl.textContent = emptyMessage;
          window.SCStatus && window.SCStatus.set('idle');
          return;
        }
        const dataUrl = canvasToWorkingDataUrl(info.canvas);
        await window.SCLibrary.addAssetFromDataUrl(projectId, dataUrl, {
          kind,
          name: info.name,
          source: { studio: 'mockup' },
        });
        statusEl.textContent = `✓ sent "${info.name}" to project`;
        window.SCStatus && window.SCStatus.set('saved');
      } catch (err) {
        console.error('[suite] failed to send', kind, 'to project', err);
        statusEl.textContent = '⚠ failed to send — see console';
        window.SCStatus && window.SCStatus.set('idle');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function initSendButtons() {
    attachSendButton({
      afterEl: document.getElementById('downloadPreviewBtn'),
      label: 'send mock-up to project',
      kind: 'mockup',
      getCanvasInfo: () =>
        window.__scGetCurrentMockupCanvas ? window.__scGetCurrentMockupCanvas() : null,
      emptyMessage: 'open or render a mock-up first',
    });
    attachSendButton({
      afterEl: document.getElementById('ilExportPngBtn'),
      label: 'send page to project',
      kind: 'lookbook',
      getCanvasInfo: () =>
        window.__scGetLookbookPageCanvas ? window.__scGetLookbookPageCanvas() : null,
      emptyMessage: 'design a lookbook page first',
    });
  }

  // No separate restore call here on purpose — see the file header.
  // The app's own boot sequence already restores the freshest session
  // by the time this runs (its checkForAutosaveRecovery(), patched
  // silent by index.html's inline script, has already resolved before
  // DOMContentLoaded fires); a second restore here would just race it
  // with a likely-staler snapshot.
  async function init() {
    const panel = buildPanel();
    if (!panel) {
      console.warn('[suite] Mock-up Studio collection strip not found — adapter inactive');
    } else {
      const grid = panel.querySelector('#scProjectAssetGrid');
      const statusEl = panel.querySelector('#scProjectStatus');
      panel.querySelector('#scRefreshBtn').addEventListener('click', () => renderGrid(grid, statusEl));
      renderGrid(grid, statusEl);
    }
    initSendButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
