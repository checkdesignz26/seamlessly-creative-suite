/**
 * Sketch Pad suite adapter.
 *
 * Only activates with ?project=<id> in the URL (i.e. loaded from the
 * Seamlessly Creative shell). Opened standalone, this script no-ops.
 *
 * RECEIVE side: lists the project's source assets — pattern/motif/
 * background/graphic — from the shared library (same kinds Mock-up
 * Studio's own picker uses, see mockup-adapter.js) and loads whichever
 * one is tapped as Sketch Pad's "Load as Background" tile, via
 * window.__scLoadBackgroundFromDataUrl — a small hook added next to the
 * app's own bgInput file-upload handler in index.html, reusing that
 * exact same code path rather than duplicating it.
 *
 * SEND side: one "send pattern to project" button that reads the same
 * composited tile canvas the app's own Export button builds, via
 * window.__scGetSketchpadExportCanvas — another small read-only hook
 * next to that button, so this adapter can never drift from what a
 * manual Export actually produces.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) return;

  function buildPanel() {
    const anchor = document.querySelector('.sidebar .section');
    if (!anchor || !anchor.parentNode) return null;

    const panel = document.createElement('section');
    panel.className = 'section';
    panel.innerHTML = `
      <div class="section-title">☁️ Seamlessly Creative Project</div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span class="hint" style="margin:0;">Tap a pattern to load it as your background.</span>
        <button id="scRefreshBtn" class="btn mini" type="button">refresh</button>
      </div>
      <div id="scProjectAssetGrid" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
      <div id="scProjectStatus" class="hint" style="margin-top:6px;"></div>
      <button id="scSendToProjectBtn" class="btn mini primary" type="button" style="width:100%;margin-top:10px;">📤 send pattern to project</button>
      <div id="scSendStatus" class="hint" style="margin-top:6px;"></div>
    `;
    anchor.insertAdjacentElement('afterend', panel);
    return panel;
  }

  async function renderGrid(grid, statusEl) {
    grid.innerHTML = '';
    statusEl.textContent = 'loading project…';
    const assets = (await window.SCLibrary.listAssets(projectId)).filter((a) =>
      ['pattern', 'motif', 'background', 'graphic'].includes(a.kind)
    );
    if (!assets.length) {
      statusEl.textContent = 'No patterns in this project yet — send one from Pattern Playground or Sketch Pad itself.';
      return;
    }
    statusEl.textContent = `${assets.length} available`;

    for (const asset of assets) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.title = asset.name;
      tile.style.cssText =
        'width:56px;height:56px;padding:0;border-radius:10px;overflow:hidden;' +
        'border:2px solid transparent;cursor:pointer;position:relative;background:#0002;';

      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      let triedFallback = false;

      function showFallback(reason) {
        console.error('[suite] project asset image failed to load entirely', asset.name, reason);
        tile.innerHTML = '';
        tile.style.background = '#463a66';
        tile.style.display = 'flex';
        tile.style.alignItems = 'center';
        tile.style.justifyContent = 'center';
        tile.style.color = '#fff';
        tile.style.fontSize = '18px';
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
          trySrcFrom(asset.file);
          return;
        }
        showFallback('img decode failed');
      });
      trySrcFrom(asset.thumb || asset.file);
      tile.appendChild(img);

      tile.addEventListener('click', async () => {
        if (typeof window.__scLoadBackgroundFromDataUrl !== 'function') return;
        tile.disabled = true;
        tile.style.opacity = '0.5';
        window.SCStatus && window.SCStatus.set('saving');
        try {
          const dataUrl = await window.SCLibrary.blobToDataUrl(asset.repeatTile || asset.file);
          window.__scLoadBackgroundFromDataUrl(dataUrl);
          tile.style.borderColor = '#22c55e';
          window.SCStatus && window.SCStatus.set('saved');
        } catch (err) {
          console.error('[suite] failed to load project asset as background', asset, err);
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

  // Same working-resolution convention every other adapter uses (see
  // mockup-adapter.js) — keeps what lands in the shared library well
  // inside iPad Safari's comfort zone.
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

  function initSendButton(panel) {
    const btn = panel.querySelector('#scSendToProjectBtn');
    const statusEl = panel.querySelector('#scSendStatus');
    btn.addEventListener('click', async () => {
      if (typeof window.__scGetSketchpadExportCanvas !== 'function') return;
      btn.disabled = true;
      window.SCStatus && window.SCStatus.set('saving');
      try {
        const info = window.__scGetSketchpadExportCanvas();
        const dataUrl = canvasToWorkingDataUrl(info.canvas);
        await window.SCLibrary.addAssetFromDataUrl(projectId, dataUrl, {
          kind: 'pattern',
          name: info.name,
          source: { studio: 'sketchpad' },
        });
        statusEl.textContent = `✓ sent to project`;
        window.SCStatus && window.SCStatus.set('saved');
      } catch (err) {
        console.error('[suite] failed to send Sketch Pad pattern to project', err);
        statusEl.textContent = '⚠ failed to send — see console';
        window.SCStatus && window.SCStatus.set('idle');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function init() {
    const panel = buildPanel();
    if (!panel) {
      console.warn('[suite] Sketch Pad sidebar not found — adapter inactive');
      return;
    }
    const grid = panel.querySelector('#scProjectAssetGrid');
    const statusEl = panel.querySelector('#scProjectStatus');
    panel.querySelector('#scRefreshBtn').addEventListener('click', () => renderGrid(grid, statusEl));
    renderGrid(grid, statusEl);
    initSendButton(panel);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
