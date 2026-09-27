/**
 * Creative Resizer suite adapter — SEND + RECEIVE.
 *
 * Only activates with ?project=<id> in the URL (i.e. loaded from the
 * Seamlessly Creative shell). Opened standalone — including on the
 * real, live, paying-customer deployment — this script no-ops and
 * nothing about Creative Resizer changes. Local upload/import stays
 * exactly as it was; Project access is an additional input method,
 * not a replacement.
 *
 * SEND: a "send to project" button next to the existing #downloadBtn,
 * scoped to exactly the products the user has already ticked for
 * download (the app's own existing "deliberate choice" mechanism —
 * see downloadBtn.onclick) via window.__scGetSelectedResizerExports(),
 * a tiny read-only hook added next to that same handler in index.html.
 * Nothing here dumps every generated size or an intermediate canvas —
 * only what's selected, exactly like a real download would produce.
 * Sent with kind: 'pattern' so it lands in Mock-up Studio's existing
 * project panel unchanged (that panel already filters to
 * pattern/motif/background — see mockup-adapter.js) and in Pattern
 * Pages' pattern tray (see pages-adapter.js's trayTypeFor).
 *
 * RECEIVE: a "seamlessly creative project" panel, styled with the
 * app's own existing .pattern-tray-box/.pattern-library-tile classes
 * (same visual language, no new CSS), listing every asset in the
 * project. Tapping one wraps its file Blob in a real File and calls
 * window.handlePickedPatternFile(file) directly — the app's own,
 * already-hardened upload entry point (Safari-safe decode, large-
 * image downscaling, black-canvas detection all already handled
 * there) — so a Project-sourced pattern goes through the exact same
 * path a local upload does, no duplicated logic here. The Blob
 * reference is handed straight through; nothing here keeps its own
 * extra full-resolution copy around.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) return;

  // === SEND side ======================================================

  function attachSendButton() {
    const downloadBtn = document.getElementById('downloadBtn');
    if (!downloadBtn || !downloadBtn.parentNode) return;

    const wrap = document.createElement('span');
    wrap.className = 'scSendBar';
    wrap.innerHTML = `
      <button type="button" class="topbar-utility-btn scSendBtn" disabled>send to project</button>
      <span class="scSendStatus"></span>
    `;
    downloadBtn.insertAdjacentElement('afterend', wrap);
    const btn = wrap.querySelector('.scSendBtn');
    const statusEl = wrap.querySelector('.scSendStatus');

    // The app's own script enables/disables #downloadBtn based on
    // whether an image is loaded and something is selected (see
    // loadImage / selectAllBtn / deselectAllBtn) — there's no single
    // event for that, so mirror its disabled state the same
    // MutationObserver way already used elsewhere in this suite for
    // state that can't be directly observed any other way.
    function syncDisabled() {
      btn.disabled = downloadBtn.disabled;
    }
    syncDisabled();
    new MutationObserver(syncDisabled).observe(downloadBtn, { attributes: true, attributeFilter: ['disabled'] });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      window.SCStatus && window.SCStatus.set('saving');
      try {
        const items = window.__scGetSelectedResizerExports ? await window.__scGetSelectedResizerExports() : [];
        if (!items.length) {
          statusEl.textContent = 'select at least one product first';
          window.SCStatus && window.SCStatus.set('idle');
          return;
        }
        let sent = 0;
        const failures = [];
        for (let i = 0; i < items.length; i++) {
          statusEl.textContent = `sending ${i + 1}/${items.length}…`;
          try {
            await window.SCLibrary.addAssetFromDataUrl(projectId, items[i].dataUrl, {
              kind: 'pattern',
              name: items[i].name,
              source: { studio: 'resizer' },
            });
            sent++;
          } catch (err) {
            console.error('[suite] failed to send resizer export', items[i].name, err);
            failures.push(items[i].name);
          }
        }
        if (sent > 0 && !failures.length) {
          statusEl.textContent = `✓ ${sent} sent to project`;
        } else if (sent > 0) {
          statusEl.textContent = `✓ ${sent} sent, ${failures.length} failed`;
        } else {
          statusEl.textContent = '⚠ 0 sent — see console';
        }
        window.SCStatus && window.SCStatus.set(sent > 0 ? 'saved' : 'idle');
      } finally {
        syncDisabled();
      }
    });

    const style = document.createElement('style');
    style.textContent = `
      .scSendBar{display:inline-flex;align-items:center;gap:8px;margin-left:8px;}
      .scSendStatus{font-size:12px;opacity:.85;white-space:nowrap;}
    `;
    document.head.appendChild(style);
  }

  // === RECEIVE side ====================================================

  function buildPanel() {
    const anchor = document.querySelector('.privacy-note');
    if (!anchor || !anchor.parentNode) return null;

    const panel = document.createElement('div');
    panel.className = 'pattern-tray-box';
    panel.id = 'scProjectPanel';
    panel.innerHTML = `
      <label>seamlessly creative project</label>
      <div class="pattern-tray-help" id="scProjectStatus">loading project…</div>
      <div class="pattern-library-strip" id="scProjectAssetGrid" style="overflow-x:auto;"></div>
      <button class="batch-add-btn" id="scRefreshBtn" type="button">refresh</button>
    `;
    anchor.insertAdjacentElement('afterend', panel);
    return panel;
  }

  async function renderGrid(grid, statusEl) {
    grid.innerHTML = '';
    statusEl.textContent = 'loading project…';
    const assets = await window.SCLibrary.listAssets(projectId);
    if (!assets.length) {
      statusEl.textContent = 'No assets in this project yet — send some from Pattern Playground or another studio first.';
      return;
    }
    statusEl.textContent = `${assets.length} available — tap one to open it here`;

    for (const asset of assets) {
      const tile = document.createElement('div');
      tile.className = 'pattern-library-tile';
      tile.setAttribute('role', 'button');
      tile.setAttribute('tabindex', '0');
      tile.title = `${asset.name} (${asset.kind})`;

      const img = document.createElement('img');
      img.alt = '';
      let triedFallback = false;
      function showFallback() {
        img.remove();
        tile.style.background = '#463a66';
        tile.style.borderRadius = '12px';
        tile.style.color = '#fff';
        tile.style.fontSize = '20px';
        tile.style.lineHeight = '56px';
        tile.style.width = '56px';
        tile.style.height = '56px';
        tile.textContent = (asset.name || '?').trim().charAt(0).toUpperCase();
      }
      function trySrcFrom(blob) {
        if (!blob) { showFallback(); return; }
        window.SCLibrary.blobToDataUrl(blob).then(
          (dataUrl) => { img.src = dataUrl; },
          () => {
            if (!triedFallback && asset.thumb) { triedFallback = true; trySrcFrom(asset.file); return; }
            showFallback();
          }
        );
      }
      img.addEventListener('error', () => {
        if (!triedFallback && asset.thumb) { triedFallback = true; trySrcFrom(asset.file); return; }
        showFallback();
      });
      trySrcFrom(asset.thumb || asset.file);
      tile.appendChild(img);

      const nameEl = document.createElement('div');
      nameEl.className = 'pattern-library-tile-name';
      nameEl.textContent = asset.name || 'untitled';
      tile.appendChild(nameEl);

      async function activate() {
        try {
          window.SCStatus && window.SCStatus.set('saving');
          // Hand the existing full-res Blob straight to the app's own
          // upload entry point — no extra full-resolution copy kept
          // here, no dataURL round-trip, same memory shape as a local
          // file pick.
          const safeName = (asset.name || 'project-asset').replace(/[^a-z0-9_\-]/gi, '_') + '.png';
          const file = new File([asset.file], safeName, { type: asset.file.type || 'image/png' });
          await window.handlePickedPatternFile(file);
          window.SCStatus && window.SCStatus.set('saved');
        } catch (err) {
          console.error('[suite] failed to open project asset', asset, err);
          window.SCStatus && window.SCStatus.set('idle');
        }
      }
      tile.addEventListener('click', activate);
      tile.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
      });
      grid.appendChild(tile);
    }
  }

  function init() {
    attachSendButton();

    const panel = buildPanel();
    if (!panel) {
      console.warn('[suite] Creative Resizer project panel anchor not found — receive side inactive');
      return;
    }
    const grid = panel.querySelector('#scProjectAssetGrid');
    const statusEl = panel.querySelector('#scProjectStatus');
    panel.querySelector('#scRefreshBtn').addEventListener('click', () => renderGrid(grid, statusEl));
    renderGrid(grid, statusEl);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
