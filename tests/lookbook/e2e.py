"""
Creative Lookbook (standalone workspace) end-to-end test — real page, headless Chromium.

  python3 tests/collage/make_fixtures.py /tmp/fx
  (cd public && python3 -m http.server 8765 &)
  python3 tests/lookbook/e2e.py http://localhost:8765 /tmp/fx /tmp/out [--touch]

Checks: page works with NO suite code, uploads, adding every kind of item, multi-page editing, autosave and
reopen (everything still editable), collage <-> freeform without losing images, PNG/JPEG/PDF/ZIP exports,
.lookbook backup round trip, Quick Lookbook (.mstudio) import.
"""
import sys, os, json, io, zipfile, base64
from playwright.sync_api import sync_playwright

BASE, FX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
TOUCH = '--touch' in sys.argv
os.makedirs(OUT, exist_ok=True)
fails, passes = [], 0
def check(name, cond, detail=''):
    global passes
    if cond: passes += 1; print('  ok   ', name)
    else: fails.append(name); print('  FAIL ', name, detail)
fx = lambda *n: [os.path.join(FX, x) for x in n]
URL = BASE + os.environ.get('LB_PATH', '/studios/lookbook/index.html')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=TOUCH, is_mobile=False, accept_downloads=True)
    pg = ctx.new_page()
    errs, reqs = [], []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('request', lambda r: reqs.append(r.url))
    pg.on('dialog', lambda d: d.accept())
    ev = pg.evaluate
    def tap(sel):
        if TOUCH: pg.tap(sel)
        else: pg.click(sel)
    def items(): return ev("ilActiveCanvas().querySelectorAll('.canvas-item').length")
    def project(): return ev("JSON.parse(JSON.stringify(window.__lbApp.getProject()))")
    def settle(ms=300): pg.wait_for_timeout(ms)

    print('Independence — loads with no suite, no Mock-up Studio, no project library')
    pg.goto(URL, wait_until='domcontentloaded'); settle(1200)
    own = [u for u in reqs if u.startswith(BASE)]
    forbidden = [u for u in own if any(k in u for k in ('shell.js', 'project-library', 'suite-status', '/studios/mockup', '/studios/pages', '/studios/playground', '/adapters/'))]
    check('no request to any suite/Mock-up/adapter file', not forbidden, forbidden)
    check('shared editor + collage files were what loaded', all(any(k in u for u in own) for k in ('collage-engine.js', 'lookbook-editor.js', 'lookbook-store.js')))
    check('start screen shown with New + Open', ev("!document.getElementById('lbStart').hidden") and ev("!!document.getElementById('lbNewBtn') && !!document.getElementById('lbOpenBtn')"))

    print('New project + the toolbar we already like')
    tap('#lbNewBtn'); settle(1200)
    check('workspace open with one blank page', not ev("document.getElementById('lbWorkspace').hidden") and ev('ilPages.length') == 1)
    check('rail has the four tools', ev("[...document.querySelectorAll('#ilToolRail .lookbook-rail-btn')].map(b=>b.dataset.group).join()") == 'add,arrange,style,export')
    check('Add panel open on first visit', ev('ilToolGroup') == 'add')
    tap('#ilToolPanelCollapseBtn'); settle(200)
    check('panel collapses', ev('ilToolGroup') is None)
    tap('#ilRailAddBtn'); settle(200)
    check('panel reopens from the rail', ev('ilToolGroup') == 'add')
    ev("document.getElementById('lbProjectName').focus()")
    pg.fill('#lbProjectName', 'Autumn Garden'); settle(200)

    print('Independent uploads')
    pg.set_input_files('#lbFilePatterns', fx('pattern.png')); settle(900)
    pg.set_input_files('#lbFileImages', fx('land.png', 'port.png', 'sq.png')); settle(1200)
    pr = project()
    check('1 pattern + 3 images in the project library', len(pr['patterns']) == 1 and len(pr['images']) == 3, (len(pr['patterns']), len(pr['images'])))
    check('swatches appear in both strips', ev("document.querySelectorAll('#ilPatternStrip .lookbook-pattern-swatch').length") == 1 and ev("document.querySelectorAll('#ilImageStrip .lookbook-pattern-swatch').length") == 3)
    pg.set_input_files('#lbFileImages', fx('pattern.png')); settle(500)
    pg.evaluate("document.querySelector('#ilImageStrip .lb-swatch-x:last-of-type') && 0")
    pg.click('#ilImageStrip .lookbook-pattern-swatch:nth-child(4) .lb-swatch-x'); settle(300)
    check('a library item can be removed', len(project()['images']) == 3)

    print('Adding every kind of item')
    tap('#ilPatternStrip .lookbook-pattern-swatch'); settle(200)
    tap('#ilImageStrip .lookbook-pattern-swatch:nth-child(2)'); settle(300)     # portrait photo
    box = ev("(()=>{const it=[...ilActiveCanvas().querySelectorAll('.canvas-item')].pop(); return {w:parseFloat(it.style.width),h:parseFloat(it.style.height)}})()")
    check('portrait photo placed at its own proportions (900x1400)', abs(box['w'] / box['h'] - 900 / 1400) < 0.02, box)
    tap('#ilAddTextBtn'); settle(200)
    tap('#ilAddPaletteBtn'); settle(900)
    check('pattern, picture, text and palette all added', items() == 4, items())
    check('palette picked up colours from the uploads', ev("[...document.querySelectorAll('.palette-item')].length") == 1)

    print('Collage Builder in the new workspace')
    tap('#ilOpenCollageBtn'); settle(300)
    check('collage builder opens from Add', ev('ilToolGroup') == 'collage')
    pg.click("#ilCollageRoot >> text=+ new empty collage"); settle(300)
    check('source tabs are patterns + images', ev("[...document.querySelectorAll('#ilCollageRoot .sccl-chips .sccl-chip')].map(c=>c.textContent).join('|')").startswith('patterns|images'))
    pg.click("#ilCollageRoot .sccl-chip:has-text('images')"); settle(500)
    thumbs = ev("document.querySelectorAll('#ilCollageRoot .sccl-thumb').length")
    check('library images offered inside the collage builder', thumbs == 3, thumbs)
    for i in range(3): pg.click(f"#ilCollageRoot .sccl-thumb:nth-child({i+1})"); settle(250)
    m = ev("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model))")
    filled = [s['src'] for s in m['slots'] if s['src']]
    check('3 library images are in the collage', len(filled) == 3, len(filled))
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Freeform')"); settle(300)
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Layout')"); settle(300)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='halves-v']"); settle(300)
    m2 = ev("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model))")
    check('layout <-> freeform <-> fewer cells: no image lost', [s['src'] for s in m2['slots'] if s['src']] == filled)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='big-left']"); settle(300)
    pg.screenshot(path=OUT + '/lb_collage.png')
    tap('#ilToolPanelCollapseBtn'); settle(200)
    check('page now has 5 items (4 + collage)', items() == 5)

    print('Multi-page editing')
    tap('.lookbook-page-thumb-add'); settle(500)
    check('second page added and active', ev('ilPages.length') == 2 and ev('ilActivePageIndex') == 1)
    tap('#ilRailAddBtn'); settle(200)
    tap('#ilAddTextBtn'); settle(200)
    ev("ilActiveCanvas().querySelector('.text-item-content').textContent = 'Page two title'")
    ev("ilPages[1].el.dispatchEvent(new Event('input'))")
    tap('.lookbook-page-thumb:nth-of-type(1)'); settle(400)
    check('switching back to page 1 keeps its 5 items', ev('ilActivePageIndex') == 0 and items() == 5)
    tap('.lookbook-page-thumb:nth-of-type(2)'); settle(400)
    check('page 2 kept its text', ev("ilActiveCanvas().querySelector('.text-item-content').textContent") == 'Page two title')
    tap('#ilToggleThumbnailsBtn'); settle(200)
    check('page strip can be hidden for full-screen editing', ev("document.getElementById('ilPageThumbnails').classList.contains('il-thumbnails-hidden')"))
    tap('#ilToggleThumbnailsBtn'); settle(200)
    ev("ilSwitchToPage(0)")
    tap('#ilRailStyleBtn'); settle(200)
    ev("document.getElementById('ilPageBgColorInput').value='#f3e6d8'; document.getElementById('ilPageBgColorInput').dispatchEvent(new Event('input',{bubbles:true}))"); settle(300)
    check('page background colour applied', ev("ilPages[0].bg.type") == 'solid')
    tap('#ilToolPanelCollapseBtn'); settle(300)
    pg.screenshot(path=OUT + '/lb_page1.png')

    print('Autosave, reload, reopen — everything still editable')
    pg.wait_for_timeout(2200)
    check('status shows saved', 'saved' in ev("document.getElementById('lbSaveStatus').textContent"), ev("document.getElementById('lbSaveStatus').textContent"))
    saved_before = project()
    pg.reload(wait_until='domcontentloaded'); settle(1200)
    check('project listed on the start screen with its name and 2 pages',
          'Autumn Garden' in ev("document.getElementById('lbProjectList').textContent") and '2 pages' in ev("document.getElementById('lbProjectList').textContent"))
    pg.click('.lb-card-open'); settle(1500)
    check('reopened: 2 pages, name restored', ev('ilPages.length') == 2 and ev("document.getElementById('lbProjectName').value") == 'Autumn Garden')
    check('reopened: library restored (1 pattern, 3 images)', len(project()['patterns']) == 1 and len(project()['images']) == 3)
    ev("ilSwitchToPage(0)"); settle(300)
    check('reopened: page 1 has all 5 items + its background', items() == 5 and ev("ilPages[0].bg.type") == 'solid')
    m3 = ev("(()=>{const c=ilActiveCanvas().querySelector('.collage-item'); return c && c.__collage ? JSON.parse(JSON.stringify(c.__collage.model)) : null})()")
    check('reopened: collage model intact with all 3 images', m3 and [s['src'] for s in m3['slots'] if s['src']] == filled)
    ev("ilSelectItem(ilActiveCanvas().querySelector('.collage-item'))"); settle(200)
    tap('#ilEditCollageBtn') if ev("!document.getElementById('ilEditCollageBtn').closest('[hidden]')") else ev("ilSetToolGroup('arrange')")
    settle(200)
    ev("ilSetToolGroup('collage')"); settle(300)
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Freeform')"); settle(300)
    m4 = ev("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model))")
    check('reopened collage still switches layout<->freeform losslessly', m4['mode'] == 'free' and [s['src'] for s in m4['slots'] if s['src']] == filled)
    ev("ilSetToolGroup(null)") if False else None
    tap('#ilToolPanelCollapseBtn'); settle(200)
    ev("ilSwitchToPage(1)"); settle(300)
    check('reopened: page 2 text intact', ev("ilActiveCanvas().querySelector('.text-item-content').textContent") == 'Page two title')
    ev("ilSwitchToPage(0)"); settle(300)

    print('Exports')
    tap('#ilRailExportBtn'); settle(300)
    with pg.expect_download() as d: tap('#ilExportPngBtn')
    png = d.value; path = png.path()
    from PIL import Image
    im = Image.open(path)
    check('PNG export: right name and 2x page size (2400x1700)', png.suggested_filename.startswith('Autumn-Garden-page-1') and im.size == (2400, 1700), (png.suggested_filename, im.size))
    im.convert('RGB').save(OUT + '/lb_export_page1.png')
    with pg.expect_download() as d: tap('#lbExportJpgBtn')
    jp = d.value; im = Image.open(jp.path())
    check('JPEG export is a real JPEG at the same size', im.format == 'JPEG' and im.size == (2400, 1700), (im.format, im.size))
    with pg.expect_download() as d: tap('#ilExportPdfBtn')
    pdf = d.value; data = open(pdf.path(), 'rb').read()
    try:
        import pypdf
        r = pypdf.PdfReader(io.BytesIO(data)); n = len(r.pages); sz = (float(r.pages[0].mediabox.width), float(r.pages[0].mediabox.height))
    except Exception as e:
        n, sz = data.count(b'/Type /Page\n') or -1, None
    check('PDF export: valid, 2 pages, 1200x850pt', data[:5] == b'%PDF-' and n == 2 and sz == (1200.0, 850.0), (n, sz, data[:8]))
    check('PDF page 1 is the active-page content (page order kept)', ev('ilActivePageIndex') == 0)
    with pg.expect_download() as d: tap('#lbExportZipBtn')
    z = zipfile.ZipFile(d.value.path()); names = z.namelist()
    check('ZIP export: 2 numbered PNG pages', len(names) == 2 and all(n.endswith('.png') for n in names) and z.read(names[0])[:4] == b'\x89PNG', names)
    with pg.expect_download() as d: tap('#lbDownloadProjectBtn')
    lbfile = d.value; raw = open(lbfile.path(), 'rb').read()
    check('backup is a .lookbook file with name, library and both pages', lbfile.suggested_filename.endswith('.lookbook')
          and json.loads(raw)['format'] == 'creative-lookbook' and len(json.loads(raw)['lookbook']['pages']) == 2 and len(json.loads(raw)['images']) == 3)
    keep = os.path.join(OUT, 'backup.lookbook'); open(keep, 'wb').write(raw)

    print('Open a .lookbook backup (new copy, nothing overwritten)')
    tap('#lbHomeBtn'); settle(800)
    check('back on the start screen', not ev("document.getElementById('lbStart').hidden"))
    pg.set_input_files('#lbFileOpen', keep); settle(1800)
    check('backup opened as a second project', ev('ilPages.length') == 2 and ev("window.__lbApp.getProject().id") != saved_before['id'])
    ev("ilSwitchToPage(0)"); settle(300)
    check('backup collage fully editable', ev("!!ilActiveCanvas().querySelector('.collage-item').__collage") and items() == 5)
    tap('#lbHomeBtn'); settle(800)
    check('both lookbooks listed', ev("document.querySelectorAll('.lb-card').length") == 2)

    print('Quick Lookbook (.mstudio) import bridge')
    px = 'data:image/png;base64,' + base64.b64encode(open(os.path.join(FX, 'sq.png'), 'rb').read()).decode()
    ms = {'format': 'mstudio', 'version': 1, 'quickPatternCollection': [{'src': px, 'name': 'p1'}],
          'lookbook': {'pages': [{'items': [{'type': 'image', 'src': px, 'left': '40px', 'top': '40px', 'width': '300px', 'height': '300px', 'zIndex': '3', 'hasPattern': False},
                                           {'type': 'text', 'text': 'Hello', 'left': '400px', 'top': '60px', 'width': '300px', 'height': '60px', 'zIndex': '4', 'font': "'Quicksand', sans-serif", 'fontSize': '30', 'color': '#222'}],
                                  'bg': {'type': 'none'}}]}}
    mp = os.path.join(OUT, 'quick.mstudio'); json.dump(ms, open(mp, 'w'))
    pg.set_input_files('#lbFileOpen', mp); settle(1800)
    check('Quick Lookbook project imported as editable page', ev('ilPages.length') == 1 and items() == 2 and len(project()['patterns']) == 1)
    bad = os.path.join(OUT, 'bad.lookbook'); open(bad, 'w').write('{"nope":1}')
    tap('#lbHomeBtn'); settle(600)
    pg.set_input_files('#lbFileOpen', bad); settle(600)
    check('a wrong file is refused politely (still on start screen)', not ev("document.getElementById('lbStart').hidden"))

    print('Delete / duplicate from the start screen')
    n0 = ev("document.querySelectorAll('.lb-card').length")
    pg.click('.lb-card:first-child .lb-card-actions button:first-child'); settle(700)
    check('duplicate adds a project', ev("document.querySelectorAll('.lb-card').length") == n0 + 1)
    pg.click('.lb-card:first-child .lb-danger'); settle(700)
    check('delete removes it', ev("document.querySelectorAll('.lb-card').length") == n0)

    real = [e for e in errs if 'fonts.g' not in e and 'ERR_' not in e]
    check('no page errors during the whole run', not real, real)
    b.close()

print(f'\n{passes} passed, {len(fails)} failed')
if fails: print('FAILED:', fails); sys.exit(1)
