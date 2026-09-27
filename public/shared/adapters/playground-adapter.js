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
    // Inserted into the app's OWN header toolbar (next to "classics
    // studio" / "portfolio" / "download" etc.), not a floating overlay.
    // A fixed-position bar was tried first and pushed content off the
    // bottom of the screen: this app's own CSS sets
    // `html,body{height:100%;overflow:hidden}`, so adding a top margin
    // to body doesn't grow the page to make room — it just clips
    // whatever no longer fits at the bottom. Living inside the header's
    // existing normal-flow toolbar avoids that class of bug entirely,
    // and matches how the Mock-up Studio adapter already works.
    const topActions = document.querySelector('header .topActions');
    if (!topActions) {
      console.warn('[suite] Playground header toolbar not found — adapter inactive');
      return;
    }

    const wrap = document.createElement('span');
    wrap.id = 'scSendBar';
    wrap.innerHTML = `
      <button id="scSendBtn" type="button" class="small primary">Send starred items to project</button>
      <span id="scSendStatus"></span>
    `;
    topActions.appendChild(wrap);

    const style = document.createElement('style');
    style.textContent = `
      #scSendBar{display:inline-flex;align-items:center;gap:8px;
        margin-left:6px;padding-left:10px;
        border-left:1px solid rgba(255,255,255,.18);}
      #scSendStatus{font-size:12px;opacity:.85;white-space:nowrap;}
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
        const failures = []; // { name, message } — surfaced inline, not just to console,
                              // since an iPad user can't easily reach devtools mid-session.
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const label = (item.ref && item.ref.name) || item.type;
          status.textContent = `sending ${i + 1}/${items.length}…`;
          try {
            const dataUrl = await window.__scPortfolioItemDataUrl(item, SEND_PX);
            if (!dataUrl) {
              failures.push({ name: label, message: 'no image was rendered for this item' });
              continue;
            }
            await window.SCLibrary.addAssetFromDataUrl(projectId, dataUrl, {
              kind: kindFor(item.type),
              name: label,
              source: { studio: 'playground' },
            });
            sent++;
          } catch (err) {
            console.error('[suite] failed to send portfolio item', item, err);
            failures.push({ name: label, message: (err && err.message) || String(err) });
          }
        }

        if (sent > 0 && !failures.length) {
          status.textContent = `✓ ${sent} sent to project`;
        } else if (sent > 0) {
          status.textContent = `✓ ${sent} sent, ${failures.length} failed — "${failures[0].name}": ${failures[0].message}`;
        } else {
          status.textContent = `⚠ 0 sent — "${failures[0].name}": ${failures[0].message}`;
        }
        window.SCStatus && window.SCStatus.set(sent > 0 ? 'saved' : 'idle', { sent, failures });
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
