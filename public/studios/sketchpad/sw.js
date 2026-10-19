/* Pattern Sketch service worker: makes the web version work offline once opened.
 * Network-first, so you always get the newest files when online; falls back to the cache
 * when offline. Bump CACHE if you ever need to force-clear old files. */
const CACHE = 'pattern-sketch-v327';
const FONT_FILES = ["./fonts/fonts.json","./fonts/google-index.json","./fonts/licenses/Lora-OFL.txt","./fonts/Lora-400.woff","./fonts/Lora-700.woff","./fonts/Lora-400i.woff","./fonts/Lora-700i.woff","./fonts/licenses/CrimsonPro-OFL.txt","./fonts/CrimsonPro-400.woff","./fonts/CrimsonPro-700.woff","./fonts/CrimsonPro-400i.woff","./fonts/licenses/LibreBaskerville-OFL.txt","./fonts/LibreBaskerville-400.woff","./fonts/licenses/YoungSerif-OFL.txt","./fonts/YoungSerif-400.woff","./fonts/licenses/InstrumentSerif-OFL.txt","./fonts/InstrumentSerif-400.woff","./fonts/InstrumentSerif-400i.woff","./fonts/licenses/Gloock-OFL.txt","./fonts/Gloock-400.woff","./fonts/licenses/PoiretOne-OFL.txt","./fonts/PoiretOne-400.woff","./fonts/licenses/Italiana-OFL.txt","./fonts/Italiana-400.woff","./fonts/licenses/EricaOne-OFL.txt","./fonts/EricaOne-400.woff","./fonts/licenses/BigShouldersDisplay-OFL.txt","./fonts/BigShouldersDisplay-400.woff","./fonts/BigShouldersDisplay-700.woff","./fonts/licenses/NothingYouCouldDo-OFL.txt","./fonts/NothingYouCouldDo-400.woff","./fonts/licenses/WorkSans-OFL.txt","./fonts/WorkSans-400.woff","./fonts/WorkSans-700.woff","./fonts/WorkSans-400i.woff","./fonts/WorkSans-700i.woff","./fonts/licenses/Outfit-OFL.txt","./fonts/Outfit-400.woff","./fonts/Outfit-700.woff","./fonts/licenses/InstrumentSans-OFL.txt","./fonts/InstrumentSans-400.woff","./fonts/InstrumentSans-700.woff","./fonts/InstrumentSans-400i.woff","./fonts/InstrumentSans-700i.woff","./fonts/licenses/BricolageGrotesque-OFL.txt","./fonts/BricolageGrotesque-400.woff","./fonts/BricolageGrotesque-700.woff","./fonts/licenses/Poppins-OFL.txt","./fonts/Poppins-400.woff","./fonts/Poppins-700.woff","./fonts/Poppins-400i.woff","./fonts/Poppins-700i.woff","./fonts/licenses/JetBrainsMono-OFL.txt","./fonts/JetBrainsMono-400.woff","./fonts/JetBrainsMono-700.woff"];
const FILES = [
  './', './index.html', './brush-engine.js', './polybool.min.js', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './native-bridge.js', './fonts.js',
  ...FONT_FILES,
  './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});
