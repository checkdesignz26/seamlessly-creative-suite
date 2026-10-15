/* SketchPad native bridge
 *
 * One tiny platform layer so the SAME index.html runs as:
 *   - the online browser app
 *   - a tool inside the Seamless Creative suite
 *   - the iPad app (Capacitor)
 *
 * Everything here is a no-op or a plain-browser fallback unless window.Capacitor reports a
 * native platform, so the web and suite builds behave exactly as before.
 */
(function () {
  'use strict';

  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());

  function plugin(name) {
    return cap && cap.Plugins ? cap.Plugins[name] : null;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // Plain browser behaviour (the original approach).
  function browserDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return Promise.resolve('download');
  }

  // Native iPad behaviour: write to the app cache, then open the iOS share sheet
  // (Save to Files, AirDrop, Photos, Mail, etc.).
  function nativeShare(blob, filename) {
    var FS = plugin('Filesystem');
    var Share = plugin('Share');
    if (!FS || !Share) return browserDownload(blob, filename);
    return blobToBase64(blob)
      .then(function (data) {
        return FS.writeFile({ path: filename, data: data, directory: 'CACHE' });
      })
      .then(function (res) {
        return Share.share({ title: filename, url: res.uri, dialogTitle: 'Save or share' });
      })
      .then(function () { return 'share'; });
  }

  /**
   * Save or export a Blob.
   * Web: triggers a normal download. iPad app: opens the share sheet.
   * Resolves to 'download' | 'share' | 'cancelled'. Never rejects for a user cancel.
   */
  function saveBlob(blob, filename) {
    var p = isNative ? nativeShare(blob, filename) : browserDownload(blob, filename);
    return p.catch(function (err) {
      var msg = String((err && err.message) || err || '');
      if (/cancel/i.test(msg)) return 'cancelled';
      console.warn('[sketchpad] save failed, falling back to download', err);
      return browserDownload(blob, filename);
    });
  }

  function hapticTick() {
    var H = plugin('Haptics');
    if (isNative && H && H.impact) { try { H.impact({ style: 'LIGHT' }); } catch (e) {} }
  }

  function init() {
    if (!isNative) return;
    document.documentElement.classList.add('is-native-app');

    var SB = plugin('StatusBar');
    if (SB && SB.hide) { try { SB.hide(); } catch (e) {} }

    // Stop iPadOS from selecting text / showing the callout menu on long-press while drawing.
    var s = document.createElement('style');
    s.textContent =
      'html.is-native-app,html.is-native-app body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      'html.is-native-app input,html.is-native-app textarea{-webkit-user-select:text;user-select:text}';
    document.head.appendChild(s);

    var SS = plugin('SplashScreen');
    if (SS && SS.hide) { try { SS.hide(); } catch (e) {} }
  }

  window.SketchpadNative = {
    isNative: isNative,
    platform: isNative && cap.getPlatform ? cap.getPlatform() : 'web',
    saveBlob: saveBlob,
    hapticTick: hapticTick
  };

  // Web only: cache the app so the browser / Add-to-Home-Screen version works offline too.
  // Silently does nothing in the iPad app, inside the suite, or if sw.js isn't deployed.
  if (!isNative && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
