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
 * IMPORTANT, found while testing this against the real app: Mock-up
 * Studio's own "quick save" (idbSaveProject, keyed MSTUDIO_IDB_KEY)
 * only runs when the user clicks its "quick save" button by hand —
 * adding a pattern to the collection does NOT itself trigger it, and
 * there's a separate 20s-interval "autosave" slot that's only ever
 * offered back via a confirm() prompt on next load, not restored
 * silently. Neither matches the suite's "one project, no per-studio
 * save button" promise on its own, so this adapter calls Mock-up
 * Studio's existing idbSaveProject()/idbLoadProject() directly, right
 * after a project asset is added and once on load — same storage
 * mechanism the "quick save"/"quick load" buttons already use, just
 * triggered automatically instead of left to the user.
 *
 * KNOWN PHASE 1 LIMIT (flagging rather than hiding): that quick-save
 * slot is a single GLOBAL key in mockupStudioDB, not scoped per suite
 * project — Mock-up Studio itself has no concept of "project". Two
 * different suite projects will currently share the same restored
 * mock-up layout/session; only the shared asset library (what's
 * listed in the panel below) is genuinely project-scoped. Making
 * Mock-up Studio's own state project-aware is Phase 2+ work, not
 * something this adapter can safely paper over on its own.
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
      const thumbUrl = URL.createObjectURL(asset.thumb || asset.file);
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.title = asset.name;
      tile.style.cssText =
        'width:64px;height:64px;padding:0;border-radius:8px;overflow:hidden;' +
        'border:2px solid transparent;cursor:pointer;position:relative;background:#0002;';
      tile.innerHTML = `<img src="${thumbUrl}" style="width:100%;height:100%;object-fit:cover;display:block;">`;
      tile.addEventListener('click', async () => {
        tile.disabled = true;
        tile.style.opacity = '0.5';
        window.SCStatus && window.SCStatus.set('saving');
        try {
          const workingSrc = await toWorkingDataUrl(asset.file);
          await addQuickCollectionPattern(workingSrc);
          // addQuickCollectionPattern does not itself persist — see the
          // file header. Save immediately through the app's own "quick
          // save" mechanism so the change survives a reload without the
          // user needing to press Mock-up Studio's own save button.
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

  // Restores Mock-up Studio's own last-saved session (see the file
  // header's "known Phase 1 limit" note — this is one global slot, not
  // per-project) so re-opening the suite doesn't leave the pattern
  // collection empty until the user manually clicks "quick load". Runs
  // once, before checkForAutosaveRecovery's own confirm()-prompted
  // crash-recovery check further down the app's own boot sequence —
  // that check reads a *different* key (the 20s-interval autosave
  // slot) and is left exactly as-is; this only pre-fills the quick-save
  // slot the app already treats as the normal "last session".
  async function restoreLastSession() {
    try {
      const data = await idbLoadProject();
      if (data) await restoreProject(data);
    } catch (err) {
      console.warn('[suite] could not restore last Mock-up Studio session', err);
    }
  }

  async function init() {
    await restoreLastSession();
    const panel = buildPanel();
    if (!panel) {
      console.warn('[suite] Mock-up Studio collection strip not found — adapter inactive');
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
