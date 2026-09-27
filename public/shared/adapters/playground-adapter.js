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
    if (window.__scAllPortfolioItems && window.__scPortfolioItemDataUrl) {
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

  function init() {
    const bar = document.createElement('div');
    bar.id = 'scSendBar';
    bar.innerHTML = `
      <span id="scSendLabel">Seamlessly Creative</span>
      <button id="scSendBtn" type="button">Send starred items to project</button>
      <span id="scSendStatus"></span>
    `;
    document.body.appendChild(bar);

    const style = document.createElement('style');
    style.textContent = `
      #scSendBar{position:fixed;top:0;left:0;right:0;z-index:99999;
        display:flex;align-items:center;gap:10px;padding:8px 14px;
        background:#2b2440;color:#fff;font:600 13px/1.3 system-ui,
        -apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25);}
      #scSendLabel{opacity:.75;font-weight:700;letter-spacing:.02em;}
      #scSendBtn{background:#7c5cff;color:#fff;border:0;border-radius:8px;
        padding:6px 12px;font:inherit;font-weight:700;cursor:pointer;}
      #scSendBtn:disabled{opacity:.55;cursor:default;}
      #scSendBtn:hover:not(:disabled){background:#8f72ff;}
      #scSendStatus{opacity:.9;}
      body{margin-top:38px !important;}
    `;
    document.head.appendChild(style);

    const btn = document.getElementById('scSendBtn');
    const status = document.getElementById('scSendStatus');

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      window.SCStatus && window.SCStatus.set('saving');
      try {
        const items = window.__scSortPortfolioItems
          ? window.__scSortPortfolioItems(window.__scAllPortfolioItems())
          : window.__scAllPortfolioItems();

        if (!items.length) {
          status.textContent = 'Nothing starred yet — star an item in the portfolio (★) first.';
          window.SCStatus && window.SCStatus.set('idle');
          return;
        }

        let sent = 0;
        for (const item of items) {
          status.textContent = `sending ${sent + 1}/${items.length}…`;
          try {
            const dataUrl = await window.__scPortfolioItemDataUrl(item, SEND_PX);
            if (!dataUrl) continue;
            await window.SCLibrary.addAssetFromDataUrl(projectId, dataUrl, {
              kind: kindFor(item.type),
              name: item.ref && item.ref.name ? item.ref.name : item.type,
              source: { studio: 'playground' },
            });
            sent++;
          } catch (err) {
            console.error('[suite] failed to send portfolio item', item, err);
          }
        }

        status.textContent = `✓ ${sent} sent to project`;
        window.SCStatus && window.SCStatus.set('saved', { sent });
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => waitForHooks(0));
  } else {
    waitForHooks(0);
  }
})();
