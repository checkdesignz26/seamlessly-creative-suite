/* Pattern Sketch font library (see IPAD.md, v129).
 * Three sources, kept apart in the picker:
 *   bundled - small set shipped inside the app (fonts/*.woff + licences), always works offline
 *   google  - fonts the user downloaded from Google Fonts; the files are kept on the device afterwards
 *   import  - the user's own .ttf / .otf files (e.g. Seamlessly Script)
 * Downloaded and imported font files live in their own IndexedDB ("sp-fonts"), separate from project storage.
 * No API key is used or needed: the catalogue list is a small bundled index (fonts/google-index.json) and a download is
 * one request to the public css2 endpoint for the chosen family only. Nothing is fetched at startup except the two tiny
 * index files; font files are loaded only when something uses them.
 * Everything here is independent of the drawing code (no access to its variables). */
(function () {
  'use strict';
  var DBN = 'sp-fonts', META = 'meta', DATA = 'data';
  var manifest = null, gindex = null, dbp = null, inited = null;
  var fams = new Map();            // key "src:family" -> family object
  var faceCache = new Map();       // face id -> Promise<bool>
  var listeners = [];

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function cssName(src, family) { return 'sp-' + src + '-' + slug(family); }
  function fkey(src, family) { return src + ':' + family; }
  var WNAME = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };
  function styleLabel(st) { var w = Math.round((st.w || 400) / 100) * 100; return (WNAME[w] || String(st.w)) + (st.i ? ' Italic' : ''); }

  // ---------------------------------------------------------------- storage
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r; try { r = indexedDB.open(DBN, 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains(META)) d.createObjectStore(META); if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA); };
      r.onsuccess = function () { r.result.onversionchange = function () { r.result.close(); dbp = null; }; res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(stores, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(stores, mode), out = fn(t);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('Storage was refused (it may be full).')); };
      });
    });
  }
  function getAllMeta() { return tx([META], 'readonly', function (t) { return t.objectStore(META).getAll(); }); }
  function getData(fid) { return tx([DATA], 'readonly', function (t) { return t.objectStore(DATA).get(fid); }); }

  // ---------------------------------------------------------------- registry
  function addStyle(src, family, st, category) {
    var k = fkey(src, family), f = fams.get(k);
    if (!f) { f = { key: k, src: src, family: family, css: cssName(src, family), category: category || '', styles: [] }; fams.set(k, f); }
    if (category && !f.category) f.category = category;
    var same = f.styles.filter(function (x) { return x.fid === st.fid; })[0];
    if (same) { Object.assign(same, st); return same; }
    f.styles.push(st); f.styles.sort(function (a, b) { return (a.i - b.i) || (a.w - b.w); });
    return st;
  }
  function init() {
    if (inited) return inited;
    inited = (async function () {
      try { var r = await fetch('fonts/fonts.json'); manifest = await r.json(); } catch (e) { manifest = { fonts: [] }; console.warn('[fonts] bundled list unavailable', e); }
      (manifest.fonts || []).forEach(function (f) {
        f.styles.forEach(function (s) { addStyle('bundled', f.family, { w: s.w, i: !!s.i, fid: 'bundled:' + f.family + ':' + s.w + (s.i ? 'i' : ''), url: 'fonts/' + s.file }, f.category); });
        var fam = fams.get(fkey('bundled', f.family)); fam.license = f.licenseFile ? 'fonts/' + f.licenseFile : null; fam.licenseName = f.license;
      });
      try {
        var metas = await getAllMeta();
        metas.forEach(function (m) { addStyle(m.src, m.family, { w: m.w, w2: m.w2 || null, i: !!m.i, fid: m.fid, ur: m.ur || null, rec: true, name: m.name || null }, m.category); });
      } catch (e) { console.warn('[fonts] stored fonts unavailable', e); }
      return true;
    })();
    return inited;
  }
  function families(src) { var out = []; fams.forEach(function (f) { if (!src || f.src === src) out.push(f); }); out.sort(function (a, b) { return a.family.localeCompare(b.family); }); return out; }
  function getFamily(src, family) { return fams.get(fkey(src, family)) || null; }
  // Nearest style of a family to what the text asked for (italic first, then closest weight).
  function pickStyle(fam, w, i) {
    if (!fam || !fam.styles.length) return null;
    var best = null, bs = 1e9;
    fam.styles.forEach(function (s) {
      var lo = s.w, hi = s.w2 || s.w, d = (w >= lo && w <= hi) ? 0 : Math.min(Math.abs(w - lo), Math.abs(w - hi));
      var score = d + (!!s.i === !!i ? 0 : 5000);
      if (score < bs) { bs = score; best = s; }
    });
    return best;
  }
  function has(font) { return !!getFamily(font.src, font.family); }
  function cssFamily(font) { return cssName(font.src, font.family); }
  function cssFont(font, size) { return (font.italic ? 'italic ' : '') + (font.weight || 400) + ' ' + size + 'px "' + cssName(font.src, font.family) + '", sans-serif'; }

  // ---------------------------------------------------------------- loading into the page
  function faceDesc(f, s) { return { weight: s.w2 ? s.w + ' ' + s.w2 : String(s.w), style: s.i ? 'italic' : 'normal', unicodeRange: s.ur || undefined }; }
  function loadFace(f, s) {
    var id = s.fid + '|' + (s.ur || '');
    if (faceCache.has(id)) return faceCache.get(id);
    var p = (async function () {
      var src;
      if (s.url) src = 'url(' + s.url + ')';
      else { var rec = await getData(s.fid); if (!rec) throw new Error('missing data'); src = rec.data.slice(0); }
      var ff = new FontFace(f.css, src, faceDesc(f, s));
      await ff.load(); document.fonts.add(ff); return true;
    })().catch(function (e) { faceCache.delete(id); console.warn('[fonts] could not load', f.family, e); return false; });
    faceCache.set(id, p); return p;
  }
  // Resolves true when the requested look is loaded and usable. Faces for one weight/style (several unicode ranges) load together.
  async function ensure(font) {
    await init();
    var f = getFamily(font.src, font.family); if (!f) return false;
    var s = pickStyle(f, font.weight || 400, !!font.italic); if (!s) return false;
    var group = f.styles.filter(function (x) { return x.w === s.w && x.i === s.i && x.w2 === s.w2; });
    var r = await Promise.all(group.map(function (x) { return loadFace(f, x); }));
    return r.every(Boolean);
  }
  function ensureAll(fonts) {
    var seen = {}, list = [];
    fonts.forEach(function (f) { var k = f.src + '|' + f.family + '|' + (f.weight || 400) + '|' + (f.italic ? 1 : 0); if (!seen[k]) { seen[k] = 1; list.push(f); } });
    return Promise.all(list.map(ensure)).then(function (r) { return r.every(Boolean); });
  }

  // ---------------------------------------------------------------- reading font files
  function be16(v, o) { return v.getUint16(o); }
  function tag(v, o) { return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3)); }
  function readName(v, off, len, plat) {
    var s = '';
    if (plat === 3 || plat === 0) { for (var i = 0; i + 1 < len; i += 2) s += String.fromCharCode(v.getUint16(off + i)); }
    else { for (var j = 0; j < len; j++) s += String.fromCharCode(v.getUint8(off + j)); }
    return s;
  }
  // Checks a file really is a plain TrueType/OpenType font and reads its names. Throws an Error with a plain-English message.
  function inspect(buf, filename) {
    if (!buf || buf.byteLength < 64) throw new Error('is empty or far too small to be a font.');
    var v = new DataView(buf), m = tag(v, 0), m4 = v.getUint32(0);
    if (m === 'wOFF' || m === 'wOF2') throw new Error('is a WOFF web font. Please use the .ttf or .otf version of the font.');
    if (m === 'ttcf') throw new Error('is a font collection (.ttc). Please import the individual .ttf or .otf files.');
    if (m === '%PDF' || m.indexOf('<') === 0 || m === 'PK\u0003\u0004') throw new Error('is not a font file.');
    if (!(m4 === 0x00010000 || m === 'OTTO' || m === 'true')) throw new Error('is not a TrueType or OpenType font (unrecognised file header).');
    var n = be16(v, 4); if (!n || n > 80 || 12 + n * 16 > buf.byteLength) throw new Error('looks damaged (its table list is broken).');
    var T = {}, i;
    for (i = 0; i < n; i++) { var o = 12 + i * 16, t = tag(v, o), to = v.getUint32(o + 8), tl = v.getUint32(o + 12); if (to + tl > buf.byteLength + 3) throw new Error('looks damaged or cut short (the file ends too early).'); T[t] = { o: to, l: tl }; }
    if (!T.cmap || !T.head || !(T.glyf || T['CFF '] || T.CFF2)) throw new Error('is missing the parts a font needs (it looks damaged or incomplete).');
    var info = { family: '', sub: '', w: 400, i: false, fmt: m === 'OTTO' ? 'otf' : 'ttf', glyphs: 0 };
    try {
      if (T.name) {
        var no = T.name.o, cnt = be16(v, no + 2), so = no + be16(v, no + 4), names = {};
        for (i = 0; i < cnt; i++) {
          var r = no + 6 + i * 12, plat = be16(v, r), id = be16(v, r + 6), ln = be16(v, r + 8), of = be16(v, r + 10);
          if (plat !== 3 && plat !== 1 && plat !== 0) continue;
          if (plat === 1 && names[id]) continue;
          if (id === 1 || id === 2 || id === 4 || id === 16 || id === 17) { var str = readName(v, so + of, ln, plat); if (str && (plat === 3 || !names[id])) names[id] = str; }
        }
        info.family = names[16] || names[1] || ''; info.sub = names[17] || names[2] || '';
        if (!info.family && names[4]) info.family = names[4];
      }
      if (T['OS/2'] && T['OS/2'].l >= 64) { var w = v.getUint16(T['OS/2'].o + 4); if (w >= 100 && w <= 900) info.w = Math.round(w / 100) * 100; info.i = !!(v.getUint16(T['OS/2'].o + 62) & 1); }
      if (T.head) { var ms = v.getUint16(T.head.o + 44); if (ms & 2) info.i = true; if ((ms & 1) && info.w < 600 && !T['OS/2']) info.w = 700; }
      if (T.maxp) info.glyphs = v.getUint16(T.maxp.o + 4);
    } catch (e) { /* names are optional: filename is used instead */ }
    if (!info.family) info.family = String(filename || 'Imported font').replace(/\.(ttf|otf)$/i, '').replace(/[-_]?(regular|bold|italic|light|medium)$/i, '').trim() || 'Imported font';
    if (/italic|oblique/i.test(info.sub)) info.i = true;
    return info;
  }
  function hashBuf(buf) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      return crypto.subtle.digest('SHA-256', buf).then(function (d) { return Array.prototype.map.call(new Uint8Array(d), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); });
    }
    var h = 2166136261, u = new Uint8Array(buf); for (var i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619); }
    return Promise.resolve('f' + (h >>> 0).toString(16) + u.length);
  }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { } }); }

  // ---------------------------------------------------------------- importing .ttf / .otf
  async function saveRecord(src, family, st, buf, extra) {
    var meta = Object.assign({ fid: st.fid, src: src, family: family, w: st.w, w2: st.w2 || null, i: !!st.i, ur: st.ur || null, added: Date.now() }, extra || {});
    await tx([META, DATA], 'readwrite', function (t) { t.objectStore(META).put(meta, st.fid); t.objectStore(DATA).put({ data: buf, fmt: meta.fmt || null }, st.fid); });
    return meta;
  }
  // Returns {ok, msg, family, existing}. Never throws.
  async function importFile(file) {
    var name = file.name || 'font';
    try {
      if (!/\.(ttf|otf)$/i.test(name)) {
        if (/\.(woff2?|ttc|otc)$/i.test(name)) return { ok: false, msg: '“' + name + '” is not a .ttf or .otf file. Please choose the .ttf or .otf version.' };
        return { ok: false, msg: '“' + name + '” is not a font file. Choose a .ttf or .otf file.' };
      }
      var buf = await file.arrayBuffer(), info;
      try { info = inspect(buf, name); } catch (e) { return { ok: false, msg: '“' + name + '” ' + e.message }; }
      var h = await hashBuf(buf);
      await init();
      var imp = families('import'), same = null;
      var metas = await getAllMeta();
      metas.forEach(function (m) { if (m.src === 'import' && m.hash === h) same = m; });
      if (same) return { ok: true, existing: true, family: same.family, msg: '“' + same.family + '” is already imported, so nothing was added.' };
      // does it actually decode in this browser?
      try { var test = new FontFace('sp-test-' + Date.now(), buf.slice(0)); await test.load(); }
      catch (e) { return { ok: false, msg: '“' + name + '” could not be read by this device (the font data looks damaged).' }; }
      var family = info.family, fam = getFamily('import', family);
      // same family + style but different bytes: keep both, the newer one gets a numbered name (existing designs keep the exact font they used)
      if (fam && fam.styles.some(function (s) { return s.w === info.w && s.i === info.i; })) {
        var n = 2; while (getFamily('import', info.family + ' (' + n + ')')) n++;
        family = info.family + ' (' + n + ')';
      }
      var st = { w: info.w, i: info.i, fid: 'import:' + family + ':' + info.w + (info.i ? 'i' : '') + ':' + h.slice(0, 8), rec: true, name: name };
      await saveRecord('import', family, st, buf, { hash: h, fmt: info.fmt, name: name, category: 'import' });
      addStyle('import', family, st, 'import');
      notify();
      return { ok: true, family: family, msg: '“' + family + '” (' + styleLabel(st) + ') imported.' + (family !== info.family ? ' A font with that name and style already existed, so this one was added as “' + family + '”.' : '') };
    } catch (e) { return { ok: false, msg: '“' + name + '” could not be saved: ' + (e && e.message || e) }; }
  }
  async function importFiles(files) { var out = []; for (var i = 0; i < files.length; i++) out.push(await importFile(files[i])); return out; }

  // ---------------------------------------------------------------- Google Fonts (browse list is bundled, download is on demand)
  async function googleIndex() {
    if (gindex) return gindex;
    try { var r = await fetch('fonts/google-index.json'); gindex = (await r.json()).fonts || []; } catch (e) { gindex = []; }
    return gindex;
  }
  function parseGoogleCss(css) {
    var out = [], re = /\/\*\s*([^*]+?)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g, m;
    while ((m = re.exec(css))) {
      var body = m[2], get = function (k) { var x = new RegExp(k + '\\s*:\\s*([^;]+);').exec(body); return x ? x[1].trim() : ''; };
      var url = /url\(([^)]+)\)/.exec(get('src')); if (!url) continue;
      var wt = get('font-weight').split(/\s+/).map(Number);
      out.push({ subset: m[1].trim(), url: url[1].replace(/['"]/g, ''), i: get('font-style') === 'italic', w: wt[0] || 400, w2: wt[1] || null, ur: get('unicode-range') || null });
    }
    return out;
  }
  // Downloads one family. progress(text) is optional. Returns {ok,msg}.
  async function googleDownload(family, progress) {
    if (!navigator.onLine) return { ok: false, msg: 'You appear to be offline. Fonts can only be downloaded while online; ones you already have still work offline.' };
    await init();
    var fq = encodeURIComponent(family).replace(/%20/g, '+'), tries = [':ital,wght@0,400;0,700;1,400;1,700', ':wght@400;700', ''], faces = null, lastErr = null;
    for (var t = 0; t < tries.length && !faces; t++) {
      try {
        progress && progress('Asking Google Fonts for “' + family + '”…');
        var r = await fetch('https://fonts.googleapis.com/css2?family=' + fq + tries[t] + '&display=swap');
        if (r.status === 400 || r.status === 404) { lastErr = r.status; continue; }
        if (!r.ok) throw new Error('Google Fonts answered with an error (' + r.status + ').');
        var f = parseGoogleCss(await r.text()).filter(function (x) { return /^latin(-ext)?$/.test(x.subset); });
        if (f.length) faces = f;
      } catch (e) { if (e instanceof TypeError) return { ok: false, msg: 'Could not reach Google Fonts. Check your connection and try again.' }; return { ok: false, msg: String(e.message || e) }; }
    }
    if (!faces) return { ok: false, msg: lastErr ? '“' + family + '” was not found on Google Fonts. Check the spelling (for example “Playfair Display”).' : 'Google Fonts returned nothing usable for “' + family + '”.' };
    var done = 0, cat = ((await googleIndex()).filter(function (g) { return g.f === family; })[0] || {}).c || '';
    try {
      for (var k = 0; k < faces.length; k++) {
        var fc = faces[k];
        progress && progress('Downloading ' + family + ' (' + (k + 1) + '/' + faces.length + ')…');
        var fr = await fetch(fc.url); if (!fr.ok) throw new Error('A font file could not be downloaded (' + fr.status + ').');
        var buf = await fr.arrayBuffer();
        var st = { w: fc.w, w2: fc.w2, i: fc.i, ur: fc.ur, rec: true, fid: 'google:' + family + ':' + fc.w + (fc.w2 ? '-' + fc.w2 : '') + (fc.i ? 'i' : '') + ':' + fc.subset };
        await saveRecord('google', family, st, buf, { fmt: 'woff2', category: cat, subset: fc.subset });
        addStyle('google', family, st, cat); done++;
      }
    } catch (e) { return { ok: false, msg: 'Download stopped: ' + (e && e.message || e) + (done ? ' (' + done + ' file(s) were saved.)' : '') }; }
    notify();
    return { ok: true, family: family, msg: '“' + family + '” downloaded. It now works offline.' };
  }

  // ---------------------------------------------------------------- remove / embed
  async function removeFamily(src, family) {
    var f = getFamily(src, family); if (!f || src === 'bundled') return false;
    await tx([META, DATA], 'readwrite', function (t) { f.styles.forEach(function (s) { t.objectStore(META).delete(s.fid); t.objectStore(DATA).delete(s.fid); }); });
    fams.delete(f.key); notify(); return true;
  }
  function b64(buf) { var u = new Uint8Array(buf), s = '', c = 0x8000; for (var i = 0; i < u.length; i += c) s += String.fromCharCode.apply(null, u.subarray(i, i + c)); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
  // Font files for the fonts a project uses (downloaded + imported only), to be saved inside the project so it opens anywhere.
  async function embedFor(fonts) {
    await init(); var seen = {}, out = [];
    for (var n = 0; n < fonts.length; n++) {
      var ft = fonts[n]; if (ft.src === 'bundled') continue;
      var f = getFamily(ft.src, ft.family); if (!f) continue;
      var s = pickStyle(f, ft.weight || 400, !!ft.italic); if (!s) continue;
      f.styles.filter(function (x) { return x.w === s.w && x.i === s.i && x.w2 === s.w2; }).forEach(function (x) { seen[x.fid] = { f: f, x: x }; });
    }
    var ids = Object.keys(seen);
    for (var i = 0; i < ids.length; i++) {
      var e = seen[ids[i]], rec = await getData(e.x.fid); if (!rec) continue;
      out.push({ src: e.f.src, family: e.f.family, w: e.x.w, w2: e.x.w2 || null, i: !!e.x.i, ur: e.x.ur || null, fid: e.x.fid, fmt: rec.fmt || 'ttf', category: e.f.category || '', data: b64(rec.data) });
    }
    return out;
  }
  // Adds fonts embedded in an opened project that this device does not have yet. Returns the number added.
  async function restoreEmbedded(list) {
    await init(); var added = 0;
    for (var i = 0; i < (list || []).length; i++) {
      var e = list[i]; if (!e || !e.data || !e.family || (e.src !== 'import' && e.src !== 'google')) continue;
      var f = getFamily(e.src, e.family);
      if (f && f.styles.some(function (s) { return s.fid === e.fid || (s.w === e.w && s.i === !!e.i && s.ur === (e.ur || null)); })) continue;
      try {
        var buf = unb64(e.data), st = { w: e.w, w2: e.w2 || null, i: !!e.i, ur: e.ur || null, rec: true, fid: e.fid || (e.src + ':' + e.family + ':' + e.w + (e.i ? 'i' : '')) };
        await saveRecord(e.src, e.family, st, buf, { fmt: e.fmt, category: e.category || '' });
        addStyle(e.src, e.family, st, e.category); added++;
      } catch (err) { console.warn('[fonts] could not restore embedded font', e.family, err); }
    }
    if (added) notify();
    return added;
  }
  async function fileFor(font) { // raw bytes + format for SVG embedding
    var f = getFamily(font.src, font.family); if (!f) return null;
    var s = pickStyle(f, font.weight || 400, !!font.italic); if (!s) return null;
    if (s.url) { try { var r = await fetch(s.url); return { buf: await r.arrayBuffer(), fmt: 'woff', style: s }; } catch (e) { return null; } }
    var rec = await getData(s.fid); return rec ? { buf: rec.data, fmt: rec.fmt || 'ttf', style: s } : null;
  }

  // ---------------------------------------------------------------- favourites / recents (small, per device)
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || '[]') || []; } catch (e) { return []; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  var favs = lsGet('sp-fontFavs'), recents = lsGet('sp-fontRecents');
  function isFav(font) { return favs.indexOf(fkey(font.src, font.family)) >= 0; }
  function toggleFav(font) { var k = fkey(font.src, font.family), i = favs.indexOf(k); if (i >= 0) favs.splice(i, 1); else favs.push(k); lsSet('sp-fontFavs', favs); return i < 0; }
  function touchRecent(font) { var k = fkey(font.src, font.family); recents = recents.filter(function (x) { return x !== k; }); recents.unshift(k); recents = recents.slice(0, 12); lsSet('sp-fontRecents', recents); }
  function keyToFont(k) { var i = k.indexOf(':'); return { src: k.slice(0, i), family: k.slice(i + 1) }; }

  window.SPFonts = {
    init: init, families: families, getFamily: getFamily, pickStyle: pickStyle, has: has, cssFamily: cssFamily, cssFont: cssFont, styleLabel: styleLabel,
    ensure: ensure, ensureAll: ensureAll, inspect: inspect, importFile: importFile, importFiles: importFiles,
    googleIndex: googleIndex, googleDownload: googleDownload, removeFamily: removeFamily,
    embedFor: embedFor, restoreEmbedded: restoreEmbedded, fileFor: fileFor, b64: b64,
    isFav: isFav, toggleFav: toggleFav, touchRecent: touchRecent, favKeys: function () { return favs.slice(); }, recentKeys: function () { return recents.slice(); }, keyToFont: keyToFont,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
