/**
 * Tiny cross-frame status channel. Each studio adapter calls
 * SCStatus.set('saving'|'saved'|'idle') as it sends/receives assets;
 * the shell's top bar (running in the parent window) listens and
 * rolls every open studio's status into the one indicator the user
 * sees ("Café Latte Collection ✓ Saved"). Nothing here touches a
 * studio's own autosave — it only reports on the shared-library calls
 * the adapter itself makes.
 */
(function (global) {
  'use strict';

  function post(status, detail) {
    try {
      global.parent.postMessage(
        { channel: 'sc-status', status, detail: detail || null },
        '*'
      );
    } catch (e) {
      /* not inside the suite shell (e.g. studio opened directly) */
    }
  }

  global.SCStatus = {
    set: post,
  };
})(window);
