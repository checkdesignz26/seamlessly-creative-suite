/**
 * Pattern Pages suite adapter — RECEIVE side.
 *
 * Only activates with ?project=<id> in the URL (i.e. loaded from the
 * Seamlessly Creative shell). Opened standalone — including on the
 * real, live, paying-customer deployment — this script no-ops and
 * nothing about Pattern Pages changes.
 *
 * Lists the current project's assets from the shared library and
 * adds a chosen one into Pattern Pages' OWN tray system via
 * window.scAddToTray(type, src, name) — a tiny hook added to this
 * frozen copy right next to window.ppRecolorAddToAssets, which
 * already does exactly this same "push an externally-sourced image
 * into a tray" job for the recolour tool. Everything downstream
 * (rendering the tray, placing on the canvas, Showcase, Magic Fill,
 * autosave picking it up) is entirely Pattern Pages' own existing
 * code — this adapter never writes into patternPagesAutoSaveDB
 * itself, and never touches or removes the original project asset;
 * it only reads it once and pushes a copy into the live tray, the
 * same as if the designer had uploaded that same image by hand.
 *
 * Asset kinds and where they land:
 *   pattern / motif / background  -> the pattern tray (state.trays.pattern)
 *   anything else (mockup, lookbook, graphic, ...) -> the design-assets
 *     tray (state.trays.asset) — Pattern Pages' own second tray for
 *     non-pattern images (logos, photos, etc.)
 * Only 'pattern' kind assets exist in shared projects today (sent
 * from Pattern Playground) — the other kinds are supported here
 * ahead of time so nothing needs to change on this side once Mock-up
 * Studio (or anything else) starts sending its own outputs into a
 * project.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) return;

  // Matches the working-resolution convention already used by the
  // other adapters (Playground sends at 1800px; Mock-up Studio
  // downscales to the same) — keeps what lands in Pattern Pages'
  // autosave (which serialises the whole live tray on every tick)
  // well inside its existing capacity assumptions, the same size
  // class as a real manual upload already produces.
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

  function trayTypeFor(kind) {
    return kind === 'pattern' || kind === 'motif' || kind === 'background' ? 'pattern' : 'asset';
  }

  function buildPanel() {
    const trayEl = document.getElementById('patternTray');
    const host = trayEl && trayEl.closest('.box.trayTop');
    if (!host || !host.parentNode) return null;

    const panel = document.createElement('div');
    panel.className = 'box trayTop';
    panel.id = 'scProjectPanel';
    panel.innerHTML = `
      <h2>seamlessly creative project</h2>
      <div class="panelBody">
        <p class="smallText" id="scProjectStatus">loading project…</p>
        <div id="scProjectAssetGrid" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;"></div>
        <button class="full" id="scRefreshBtn" style="margin-top:8px;" type="button">refresh</button>
      </div>
    `;
    host.parentNode.insertBefore(panel, host.nextSibling);
    // Real bug found from testing: Pattern Pages runs two boot-time
    // sweeps (flashmop-collapsed-start-final, flashmop-pattern-tray-
    // open-default) that each re-collapse every .box on staggered
    // timers up to 560ms out, to catch panels that didn't exist yet
    // at page load — this panel is exactly one of those, since the
    // adapter inserts it after DOMContentLoaded. Both sweeps skip any
    // box whose dataset.ppUserToggled is '1' (their own way of saying
    // "a real person already decided this one, leave it alone") — the
    // same marker the app's real collapse handler
    // (ppages-v182q-all-panels-tap-only-js's toggle()) sets. Setting
    // it here up front, alongside removing 'collapsed', opts this
    // panel out of those sweeps the same way; without it,
    // classList.remove('collapsed') alone kept getting silently
    // undone within half a second.
    panel.classList.remove('collapsed');
    panel.dataset.ppUserToggled = '1';
    // Match the app's own collapse toggle (see ppages-v182q-all-panels
    // -tap-only-js) so tapping this heading behaves the same as every
    // other panel's heading.
    panel.querySelector('h2').addEventListener('click', () => panel.classList.toggle('collapsed'));
    return panel;
  }

  async function renderGrid(grid, statusEl) {
    grid.innerHTML = '';
    statusEl.textContent = 'loading project…';
    const assets = await window.SCLibrary.listAssets(projectId);
    if (!assets.length) {
      statusEl.textContent = 'No assets in this project yet — send some from Pattern Playground first.';
      return;
    }
    statusEl.textContent = `${assets.length} available — tap one to add it to your tray`;

    for (const asset of assets) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.title = `${asset.name} (${asset.kind})`;
      tile.style.cssText =
        'width:64px;height:64px;padding:0;border-radius:8px;overflow:hidden;' +
        'border:2px solid transparent;cursor:pointer;position:relative;background:#0002;';

      // Same fix as Mock-up Studio's adapter, learned from a real
      // iPad bug there: a rejected blobToDataUrl (a Blob that failed
      // to read back out of IndexedDB) must not leave the tile
      // silently stuck — retry with the full-res file, then fall back
      // to a plain letter tile instead of hanging forever.
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      let triedFallback = false;
      function showFallback() {
        tile.innerHTML = '';
        tile.style.background = '#463a66';
        tile.style.display = 'flex';
        tile.style.alignItems = 'center';
        tile.style.justifyContent = 'center';
        tile.style.color = '#fff';
        tile.style.fontSize = '20px';
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

      tile.addEventListener('click', async () => {
        tile.disabled = true;
        tile.style.opacity = '0.5';
        window.SCStatus && window.SCStatus.set('saving');
        try {
          const workingSrc = await toWorkingDataUrl(asset.file);
          const trayType = trayTypeFor(asset.kind);
          const ok = window.scAddToTray(trayType, workingSrc, asset.name);
          if (!ok) throw new Error('Pattern Pages state not ready');
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

  function init() {
    const panel = buildPanel();
    if (!panel) {
      console.warn('[suite] Pattern Pages tray panel not found — adapter inactive');
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
