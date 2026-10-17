# Creative Lookbook tests

```
python3 tests/collage/make_fixtures.py /tmp/fx
(cd public && python3 -m http.server 8765 &)
python3 tests/lookbook/e2e.py http://localhost:8765 /tmp/fx /tmp/out            # 48 checks
python3 tests/lookbook/e2e.py http://localhost:8765 /tmp/fx /tmp/out --touch    # same, with touch input

# the separately built standalone site
node tools/build-lookbook-standalone.mjs
(cd dist/lookbook-standalone && python3 -m http.server 8766 &)
LB_PATH=/index.html python3 tests/lookbook/e2e.py http://localhost:8766 /tmp/fx /tmp/out
```
Covers: no suite requests, uploads, every item type, multi-page, autosave + reopen (collage still editable),
PNG/JPEG/PDF/ZIP exports, `.lookbook` backup round trip, Quick Lookbook import, duplicate/delete.
Needs Python Playwright + Chromium, Pillow, pypdf (optional, for exact PDF checks).
