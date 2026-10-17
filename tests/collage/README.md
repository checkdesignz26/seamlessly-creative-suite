# Collage Builder tests

These run against the Creative Lookbook workspace (`/studios/lookbook/`), which hosts the Collage Builder.
The Quick Lookbook in Mock-up Studio no longer includes it.

```
python3 tests/collage/make_fixtures.py /tmp/fx
(cd public && python3 -m http.server 8765 &)
python3 tests/collage/e2e.py http://localhost:8765 /tmp/fx /tmp/out                          # 40 checks
python3 tests/collage/e2e_touch_suite_standalone.py http://localhost:8765 /tmp/fx /tmp/out   # 17 checks
python3 tests/collage/parity_visual.py http://localhost:8765 /tmp/fx /tmp/out                # live vs export pixels
node tests/collage/parity-pattern-pages.test.js                                              # drift guard vs Pattern Pages
```
Needs Python Playwright + Chromium and Pillow. `jspdf` and Google Fonts load from CDNs; offline they just fail, which does not affect these tests.
