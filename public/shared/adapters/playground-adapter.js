/**
 * Pattern Playground suite adapter — SEND side.
 *
 * Only activates when the frozen suite copy of Playground is loaded
 * with a ?project=<id> query param (i.e. from inside the Seamlessly
 * Creative shell). Opened directly/standalone, this script no-ops and
 * the app behaves exactly as it always has.
 *
 * Reads the starred portfolio via the three hooks the frozen copy's
 * portfolio script exposes on window (__scAllPortfolioItems etc. —
 * see the "suite adapter hook" comment in that file) and writes
 * rendered PNGs into the shared project library. Nothing here reads
 * or writes pkmDB / localStorage — Playground's own saving is
 * untouched.
 *
 * The app has FOUR separate toolbars (each a `.topActions` row): the
 * main header, plus the Classics Studio, Background Studio and
 * Portfolio modals — each of those three is a full-screen overlay
 * (position:fixed; inset:0) that sits on top of the main header, so a
 * button only in the header disappears the moment any of them is
 * open. Since Classics/Background Studio is where patterns actually
 * get built and starred, that's exactly where a send button is most
 * needed — so one is attached to every toolbar found, all sharing the
 * same send logic and one status line.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const projectId = params.get('project');
  if (!projectId) return; // standalone / not inside the suite — do nothing

  // Working-resolution export, not the full 3600px an explicit ZIP
  // download would use. Keeps what lands in the shared library (and
  // therefore in Mock-up Studio's / Pattern Pages' own dataURL-based
  // storage once they read it back) well inside iPad Safari's comfort
  // zone. A "send at full resolution" option can be added later
  // without changing this adapter's shape.
  const SEND_PX = 1800;

  function waitForHooks(tries) {
    if (window.__scAllPortfolioItems && (window.__scPortfolioItemVariants || window.__scPortfolioItemDataUrl)) {
      init();
      return;
    }
    if (tries > 200) {
      console.warn('[suite] Playground portfolio hooks never appeared — adapter inactive');
      return;
    }
    setTimeout(() => waitForHooks(tries + 1), 50);
  }

  function kindFor(type) {
    if (type === 'classic') return 'motif';
    if (type === 'background') return 'background';
    if (type === 'hero') return 'graphic';
    return 'pattern';
  }

  // Every button created by attachTo() shares this — clicking any one
  // of them updates every status span at once, so switching panels
  // mid-send (or right after) still shows the latest result.
  const statusEls = [];
  function setStatusText(text) {
    statusEls.forEach((el) => { el.textContent = text; });
  }
  function setButtonsDisabled(disabled) {
    document.querySelectorAll('.scSendBtn').forEach((b) => { b.disabled = disabled; });
  }

  async function performSend() {
    setButtonsDisabled(true);
    window.SCStatus && window.SCStatus.set('saving');
    try {
      const items = window.__scSortPortfolioItems
        ? window.__scSortPortfolioItems(window.__scAllPortfolioItems())
        : window.__scAllPortfolioItems();

      if (!items.length) {
        setStatusText('Nothing starred yet — star an item (★) first.');
        window.SCStatus && window.SCStatus.set('idle');
        return;
      }

      let sent = 0;
      const failures = []; // { name, message } — surfaced inline, not just to console,
                            // since an iPad user can't easily reach devtools mid-session.
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const label = (item.ref && item.ref.name) || item.type;
        setStatusText(`sending ${i + 1}/${items.length}…`);
        try {
          // __scPortfolioItemVariants (added for Half Brick/Half Drop) returns the ORIGINAL/SINGLE
          // ARTWORK plus, when this is a non-Grid classic, a separate REPEAT-SAFE TILE and which
          // repeat layout it is - see project-library.js's asset-shape comment for who reads those.
          // Falls back to the older, single-image hook so this adapter still works against a
          // not-yet-refrozen Playground copy.
          const variants = window.__scPortfolioItemVariants
            ? await window.__scPortfolioItemVariants(item, SEND_PX)
            : { dataUrl: await window.__scPortfolioItemDataUrl(item, SEND_PX), repeatTileDataUrl: null, repeatLayout: null };
          if (!variants || !variants.dataUrl) {
            failures.push({ name: label, message: 'no image was rendered for this item' });
            continue;
          }
          await window.SCLibrary.addAssetFromDataUrl(projectId, variants.dataUrl, {
            kind: kindFor(item.type),
            name: label,
            source: { studio: 'playground' },
            repeatTileDataUrl: variants.repeatTileDataUrl || null,
            repeatLayout: variants.repeatLayout || null,
          });
          sent++;
        } catch (err) {
          console.error('[suite] failed to send portfolio item', item, err);
          failures.push({ name: label, message: (err && err.message) || String(err) });
        }
      }

      if (sent > 0 && !failures.length) {
        setStatusText(`✓ ${sent} sent to project`);
      } else if (sent > 0) {
        setStatusText(`✓ ${sent} sent, ${failures.length} failed — "${failures[0].name}": ${failures[0].message}`);
      } else {
        setStatusText(`⚠ 0 sent — "${failures[0].name}": ${failures[0].message}`);
      }
      window.SCStatus && window.SCStatus.set(sent > 0 ? 'saved' : 'idle', { sent, failures });
    } finally {
      setButtonsDisabled(false);
    }
  }

  function attachTo(topActions) {
    const wrap = document.createElement('span');
    wrap.className = 'scSendBar';
    wrap.innerHTML = `
      <button type="button" class="small primary scSendBtn">Send starred to project</button>
      <span class="scSendStatus"></span>
    `;
    topActions.appendChild(wrap);
    statusEls.push(wrap.querySelector('.scSendStatus'));
    wrap.querySelector('.scSendBtn').addEventListener('click', performSend);
  }

  // ---- RECEIVE side: colour-extract from a pattern sent INTO this project --------------------
  // Pattern Sketch (and anything else that sends a 'pattern' asset) lands here via the same
  // shared project library every other send already uses — this just lists those assets and lets
  // the user pick one as the colour-extraction source, reusing Playground's own existing
  // extraction pipeline via window.__scExtractColoursFromProjectImage (see cmHandleProjectPatternImage
  // in index.html) rather than building a second one. "Upload image" keeps working completely
  // unchanged alongside this — this is an additional source, not a replacement.
  function loadImageFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  async function renderProjectPatternPicker() {
    const box = document.getElementById('cmProjectPatternBox');
    if (!box) return; // standalone Playground (no colour-mode panel changes) — nothing to do

    const assets = (await window.SCLibrary.listAssets(projectId)).filter((a) => a.kind === 'pattern');
    if (!assets.length) {
      box.style.display = 'none';
      box.innerHTML = '';
      return;
    }

    box.style.display = 'block';
    box.innerHTML = `
      <p class="tsHint" style="margin:0 0 6px">or pick a pattern sent to this project (e.g. from Pattern Sketch):</p>
      <div id="cmProjectPatternGrid" style="display:flex;gap:6px;flex-wrap:wrap"></div>
    `;
    const grid = box.querySelector('#cmProjectPatternGrid');

    assets.forEach((asset) => {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.title = asset.name;
      tile.style.cssText =
        'width:44px;height:44px;padding:0;border-radius:9px;overflow:hidden;' +
        'border:2px solid rgba(255,235,250,.18);cursor:pointer;background:#0002;';
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      window.SCLibrary.blobToDataUrl(asset.thumb || asset.file).then((dataUrl) => {
        img.src = dataUrl;
      });
      tile.appendChild(img);

      tile.addEventListener('click', async () => {
        if (typeof window.__scExtractColoursFromProjectImage !== 'function') return;
        tile.disabled = true;
        tile.style.opacity = '0.5';
        try {
          // The repeat-safe tile (when this pattern has one) is the actual seamless artwork —
          // prefer it over the plain original so extraction sees the same pixels the pattern
          // repeats with; falls back to the original file for a pattern sent without one (e.g.
          // Pattern Sketch's own tile, which is already seamless either way).
          const blob = asset.repeatTile || asset.file;
          const img2 = await loadImageFromBlob(blob);
          window.__scExtractColoursFromProjectImage(img2, 'project pattern “' + asset.name + '”');
          document.querySelectorAll('#cmProjectPatternGrid button').forEach((b) => { b.style.borderColor = 'rgba(255,235,250,.18)'; });
          tile.style.borderColor = '#22c55e';
        } catch (err) {
          console.error('[suite] failed to extract colours from project pattern', asset, err);
          tile.style.borderColor = '#ef4444';
        } finally {
          tile.disabled = false;
          tile.style.opacity = '1';
        }
      });
      grid.appendChild(tile);
    });
  }

  function init() {
    // Inserted into the app's OWN toolbars, not a floating overlay — a
    // fixed-position bar was tried first and pushed content off the
    // bottom of the screen (this app's own CSS sets
    // `html,body{height:100%;overflow:hidden}`, so a top margin on
    // body doesn't make room, it clips the bottom instead). Living in
    // normal document flow inside each existing toolbar avoids that.
    const toolbars = document.querySelectorAll('.topActions');
    if (!toolbars.length) {
      console.warn('[suite] Playground toolbars not found — adapter inactive');
      return;
    }
    toolbars.forEach(attachTo);

    const style = document.createElement('style');
    style.textContent = `
      .scSendBar{display:inline-flex;align-items:center;gap:8px;
        margin-left:6px;padding-left:10px;
        border-left:1px solid rgba(255,255,255,.18);}
      .scSendStatus{font-size:12px;opacity:.85;white-space:nowrap;}
    `;
    document.head.appendChild(style);

    renderProjectPatternPicker();
    // Re-list on every "colour mode" open (mountColourMode re-parents the shared #cmPanel into
    // whichever studio opened it) so a pattern sent from Pattern Sketch in the meantime — this
    // tab stayed open, or a project backup was re-imported — shows up without a page reload.
    // Decorates the page's own window.mountColourMode rather than touching index.html for a
    // suite-only refresh concern; still calls straight through if it's missing for any reason.
    if (typeof window.mountColourMode === 'function') {
      const originalMountColourMode = window.mountColourMode;
      window.mountColourMode = function (slotId) {
        originalMountColourMode(slotId);
        renderProjectPatternPicker();
      };
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForHooks(0));
  } else {
    waitForHooks(0);
  }
})();
