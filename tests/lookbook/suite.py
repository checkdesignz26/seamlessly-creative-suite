"""
Creative Lookbook inside the Seamlessly Creative suite — end to end in headless Chromium.

  (cd public && python3 -m http.server 8765 &)
  python3 tests/lookbook/suite.py http://localhost:8765 /tmp/fx /tmp/out

Covers: suite tab opens the full Lookbook; project patterns / mock-ups / images arrive at full resolution in the
asset tray (grouped, refresh picks up new items); tapping places them (free picture / into a selected collage);
the editable Lookbook survives a reload; a page is sent to the project as a 'lookbook' asset (flattened, correct
size) and is listed by Pattern Pages' own project panel; the standalone page is unaffected.
"""
import sys, os, base64
from playwright.sync_api import sync_playwright

BASE, FX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
fails, passes = [], 0
def check(name, cond, detail=''):
    global passes
    if cond: passes += 1; print('  ok   ', name)
    else: fails.append(name); print('  FAIL ', name, detail)
def b64(n): return 'data:image/png;base64,' + base64.b64encode(open(os.path.join(FX, n), 'rb').read()).decode()

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    dlg = {'accept': True, 'msgs': []}
    def on_dialog(d):
        dlg['msgs'].append(d.message)
        d.accept(d.default_value or 'Café Test') if dlg['accept'] else d.dismiss()
    pg.on('dialog', on_dialog)
    ev = pg.evaluate

    # --- a suite project with a pattern, a mock-up and a plain graphic, made through the real shared library
    pg.goto(BASE + '/index.html'); pg.wait_for_timeout(600)
    pid = ev("""async ([pat, mock, gfx]) => {
      const p = await SCLibrary.createProject('Café Test');
      await SCLibrary.addAssetFromDataUrl(p.id, pat, {kind:'pattern', name:'Latte swirl', source:{studio:'playground'}});
      await SCLibrary.addAssetFromDataUrl(p.id, mock, {kind:'mockup', name:'Cushion scene', source:{studio:'mockup'}});
      await SCLibrary.addAssetFromDataUrl(p.id, gfx, {kind:'graphic', name:'Logo', source:{studio:'sketchpad'}});
      return p.id; }""", [b64('pattern.png'), b64('wide.png'), b64('sq.png')])
    full_w = ev("""async (pid) => (await SCLibrary.listAssets(pid)).find(a=>a.kind==='pattern').width""", pid)

    # --- 1. the suite shell lists the Lookbook as a module and opens it
    pg.goto(BASE + '/index.html'); pg.wait_for_timeout(500)
    tabs = ev("[...document.querySelectorAll('#scStudioTabs .sc-tab')].map(b=>b.textContent)")
    check('suite nav lists Creative Lookbook', 'Creative Lookbook' in tabs, tabs)
    check('existing studios still listed', all(n in tabs for n in ['Pattern Playground', 'Sketch Pad', 'Creative Resizer', 'Mock-up Studio', 'Pattern Pages']), tabs)
    ev("localStorage.setItem('sc.shell.lastState.v1', JSON.stringify({projectId:%r, studioId:'lookbook'}))" % pid)
    pg.reload(); pg.wait_for_timeout(1500)
    frames = [f for f in pg.frames if '/studios/lookbook/' in f.url]
    check('Lookbook opens in the suite shell', len(frames) == 1, [f.url for f in pg.frames])
    f = frames[0] if frames else None
    if f:
        f.wait_for_selector('#lookbookViewport .lookbook-canvas', timeout=15000)
        f.wait_for_timeout(1500)
        check('start screen skipped inside the suite', f.evaluate("getComputedStyle(document.getElementById('lbStart')).display==='none' && !document.getElementById('lbWorkspace').hidden"))
        check('full editor present (rail, collage, tools)', f.evaluate("!!document.getElementById('ilCollageRoot') && !!document.getElementById('ilRailExportBtn') && typeof ilAddShape==='function'"))
        check('lookbook tagged with the suite project', f.evaluate("window.__lbApp.getProject().suiteProjectId") == pid)

        # --- 2. asset tray: grouped, full resolution, collapsible
        f.wait_for_selector('#ilAssetTray .il-tray-toggle', timeout=10000)
        check('tray starts collapsed on a short (iPad-height) screen', f.evaluate("document.getElementById('ilAssetTray').classList.contains('collapsed')"))
        f.click('#ilAssetTray .il-tray-toggle'); f.wait_for_selector('#ilAssetTray .il-tray-thumb', timeout=10000)
        txt = f.evaluate("document.getElementById('ilAssetTray').innerText")
        check('tray shows grouped counts', 'patterns 1' in txt and 'mock-ups 1' in txt and 'images 1' in txt, txt)
        check('tray starts with the pattern', f.evaluate("document.querySelectorAll('#ilAssetTray .il-tray-thumb').length") == 1)
        got = f.evaluate("""async () => { const it = ilHostPatterns()[0]; const im = await ilLoadImage(it.src); return [im.naturalWidth, !!it.thumbSrc, it.src!==it.thumbSrc]; }""")
        check('placing uses the original-resolution artwork (not the thumbnail)', got[0] == full_w and got[1] and got[2], (got, full_w))
        f.click('#ilAssetTray .il-chip:has-text("mock-ups")')
        check('mock-ups group lists the mock-up', f.evaluate("document.querySelectorAll('#ilAssetTray .il-tray-thumb').length") == 1)
        f.click('#ilAssetTray .il-tray-toggle'); f.wait_for_timeout(200)
        check('tray collapses', f.evaluate("document.getElementById('ilAssetTray').classList.contains('collapsed') && !document.querySelector('#ilAssetTray .il-tray-thumb')"))
        f.click('#ilAssetTray .il-tray-toggle'); f.wait_for_timeout(300)
        check('tray expands again', f.evaluate("!!document.querySelector('#ilAssetTray .il-tray-thumb')"))

        # --- 3. tap to place: free picture, then into a selected collage
        n0 = f.evaluate("ilActiveCanvas().querySelectorAll('.canvas-item').length")
        f.click('#ilAssetTray .il-tray-thumb'); f.wait_for_timeout(500)       # mock-ups group still active
        check('tap places the mock-up as a free picture at its own proportions', f.evaluate("ilActiveCanvas().querySelectorAll('.canvas-item').length") == n0 + 1)
        f.click('#ilAssetTray .il-chip:has-text("patterns")')
        f.evaluate("ilNewCollage()"); f.wait_for_timeout(400)
        slots0 = f.evaluate("ilGetSelectedCollage().model.slots.length")
        f.click('#ilAssetTray .il-tray-thumb'); f.wait_for_timeout(800)
        m = f.evaluate("(()=>{const m=ilGetSelectedCollage().model; return {n:m.slots.length, filled:m.slots.filter(s=>s.src).length}})()")
        check('tap with a collage selected puts the pattern into that collage', m['filled'] >= 1, m)

        # --- 4. refresh picks up newly starred assets
        ev("""async ([pid, pat]) => { await SCLibrary.addAssetFromDataUrl(pid, pat, {kind:'pattern', name:'Second pattern', source:{studio:'playground'}}); }""", [pid, b64('land.png')])
        check('new project asset not shown before refresh', 'patterns 1' in f.evaluate("document.getElementById('ilAssetTray').innerText"))
        f.click('#ilAssetTray .il-tray-refresh'); f.wait_for_timeout(1500)
        check('refresh brings in the newly starred pattern', 'patterns 2' in f.evaluate("document.getElementById('ilAssetTray').innerText"))

        # --- 4b. delete a project asset from the tray (confirm, cancel keeps it)
        n_before = ev("""async (pid) => (await SCLibrary.listAssets(pid)).length""", pid)
        check('every project thumbnail has a delete ×', f.evaluate("document.querySelectorAll('#ilAssetTray .il-tray-thumb').length === document.querySelectorAll('#ilAssetTray .il-tray-x').length && document.querySelectorAll('#ilAssetTray .il-tray-x').length > 0"))
        dlg['accept'] = False; dlg['msgs'].clear()
        f.click('#ilAssetTray .il-tray-x >> nth=1'); f.wait_for_timeout(600)
        check('cancelling the confirmation keeps the asset', ev("""async (pid) => (await SCLibrary.listAssets(pid)).length""", pid) == n_before and len(dlg['msgs']) == 1, dlg['msgs'])
        dlg['accept'] = True; dlg['msgs'].clear()
        f.click('#ilAssetTray .il-tray-x >> nth=1'); f.wait_for_function("document.getElementById('ilAssetTray').innerText.includes('patterns 1')", timeout=10000)
        left = ev("""async (pid) => (await SCLibrary.listAssets(pid)).map(a=>a.name)""", pid)
        check('confirming deletes exactly that asset from the project', len(left) == n_before - 1 and 'Second pattern' not in left and 'Latte swirl' in left, left)
        check('deleted pattern also leaves the Lookbook strips', f.evaluate("ilHostPatterns().length") == 1)
        check('warning names the assets and where else it disappears', 'Mock-up Studio' in dlg['msgs'][0] and 'can’t be undone' in dlg['msgs'][0], dlg['msgs'])
        f.evaluate("window.__lbApp.saveNow()")

        # --- 5. editable lookbook is saved and returns after a reload; project assets are not duplicated into it
        f.evaluate("window.__lbApp.saveNow()"); f.wait_for_timeout(800)
        saved_bytes = f.evaluate("""async () => { const p = await ScLookbookStore.get(window.__lbApp.getProject().id); return {own: p.patterns.length + p.images.length, items: p.lookbook.pages.reduce((n,pg)=>n+pg.items.length,0)}; }""")
        check('project assets are not copied into the saved lookbook', saved_bytes['own'] == 0, saved_bytes)
        pg.reload(); pg.wait_for_timeout(1800)
        f = [x for x in pg.frames if '/studios/lookbook/' in x.url][0]
        f.wait_for_selector('#lookbookViewport .lookbook-canvas', timeout=15000); f.wait_for_timeout(1200)
        n1 = f.evaluate("ilActiveCanvas().querySelectorAll('.canvas-item').length")
        check('reload keeps the composition (picture + collage)', n1 >= 2, n1)
        one = f.evaluate("""async () => (await ScLookbookStore.list()).filter(r=>r.suiteProjectId).length""")
        check('reload reopens the same lookbook (no duplicates)', one == 1, one)

        # --- 6. send the page to the project
        f.click('#ilRailExportBtn'); f.wait_for_selector('#lbSendBtn', state='visible')
        page_w = f.evaluate("ilActiveCanvas().offsetWidth"); page_h = f.evaluate("ilActiveCanvas().offsetHeight")
        f.click('#lbSendBtn'); f.wait_for_function("document.getElementById('lbSendStatus').textContent.startsWith('✓')", timeout=20000)
        assets = ev("""async (pid) => (await SCLibrary.listAssets(pid)).map(a=>({kind:a.kind,name:a.name,w:a.width,h:a.height}))""", pid)
        sent = [a for a in assets if a['kind'] == 'lookbook']
        check('page lands in the project as a lookbook asset', len(sent) == 1, assets)
        if sent:
            check('flattened at 2x page size (aspect preserved)', sent[0]['w'] == page_w * 2 and sent[0]['h'] == page_h * 2, sent[0])
        px = ev("""async (pid) => { const a=(await SCLibrary.listAssets(pid)).find(a=>a.kind==='lookbook'); const u=await SCLibrary.blobToDataUrl(a.file);
            const im=await new Promise(r=>{const i=new Image(); i.onload=()=>r(i); i.src=u;}); const c=document.createElement('canvas'); c.width=im.naturalWidth; c.height=im.naturalHeight;
            const x=c.getContext('2d'); x.drawImage(im,0,0); const d=x.getImageData(0,0,c.width,c.height).data; let non=0; for(let i=0;i<d.length;i+=4*97) if(d[i]!==255||d[i+1]!==255||d[i+2]!==255) non++; return non; }""", pid)
        check('sent image actually contains the page artwork (not blank)', px > 50, px)
        f.select_option('#lbSendSize', '1'); f.click('#lbSendBtn'); f.wait_for_timeout(2500)
        sizes = ev("""async (pid) => (await SCLibrary.listAssets(pid)).filter(a=>a.kind==='lookbook').map(a=>a.width).sort((a,b)=>a-b)""", pid)
        check('standard size option sends the page size, and sending twice never overwrites', sizes == [page_w, page_w * 2], sizes)
        lb_ok = f.evaluate("""async () => (await ScLookbookStore.list()).length""")
        check('editable lookbook still exists after sending', lb_ok >= 1)

        # --- 7. Pattern Pages receives it through its own project panel (Pattern Pages unmodified)
        pg2 = ctx.new_page(); pg2.on('pageerror', lambda e: errs.append('pages: ' + str(e)))
        pg2.goto(BASE + '/studios/pages/index.html?project=' + pid); pg2.wait_for_selector('#scProjectAssetGrid', timeout=30000); pg2.wait_for_timeout(2500)
        titles = pg2.evaluate("[...document.querySelectorAll('#scProjectAssetGrid .thumb')].map(t=>t.title)")
        check('Pattern Pages project panel lists the Lookbook pages', sum('(lookbook)' in t for t in titles) == 2, titles)
        check('Pattern Pages also still lists patterns/mock-ups', any('(pattern)' in t for t in titles) and any('(mockup)' in t for t in titles), titles)
        pg2.close()

    # --- 8. standalone page unaffected: no suite scripts, start screen shown
    pg3 = ctx.new_page(); reqs = []
    pg3.on('request', lambda r: reqs.append(r.url))
    pg3.goto(BASE + '/studios/lookbook/index.html'); pg3.wait_for_timeout(1200)
    check('standalone shows its start screen', pg3.evaluate("getComputedStyle(document.getElementById('lbStart')).display!=='none' && document.getElementById('lbWorkspace').hidden"))
    check('standalone loads no suite files', not [u for u in reqs if any(k in u for k in ('project-library', 'suite-status', 'shell.js', '/adapters/'))], [u for u in reqs if 'shared' in u][:3])
    pg3.click('#lbNewBtn'); pg3.wait_for_selector('#lookbookViewport .lookbook-canvas'); pg3.wait_for_timeout(800)
    check('standalone tray present, no refresh button, no send block',
          pg3.evaluate("!!document.querySelector('#ilAssetTray .il-tray-toggle') && !document.querySelector('.il-tray-refresh') && !document.getElementById('lbSendBlock')"))
    check('standalone has no suiteProjectId', pg3.evaluate("!window.__lbApp.getProject().suiteProjectId"))

    check('no page errors', not [e for e in errs if 'ResizeObserver' not in e], errs[:3])
    b.close()
print('\n%d passed, %d failed' % (passes, len(fails)))
sys.exit(1 if fails else 0)
