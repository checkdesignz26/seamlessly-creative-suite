"""
Collage Builder end-to-end test, run against the REAL Mock-up Studio page (and so the real Lookbook
editor + the shared /shared/collage-*.js files) in headless Chromium.

  python3 tests/collage/make_fixtures.py /tmp/fx
  (cd public && python3 -m http.server 8765 &)
  python3 tests/collage/e2e.py http://localhost:8765 /tmp/fx /tmp/out
"""
import sys, json, os
from playwright.sync_api import sync_playwright

BASE, FX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
fails, passes = [], 0
def check(name, cond, detail=''):
    global passes
    if cond: passes += 1; print('  ok   ', name)
    else: fails.append(name); print('  FAIL ', name, detail)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1180, 'height': 820})
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept('Test layout') if d.type == 'prompt' else d.accept())
    pg.goto(BASE + '/studios/mockup/index.html', wait_until='domcontentloaded'); pg.wait_for_timeout(1200)

    def ev(js): return pg.evaluate(js)
    def open_editor():
        ev("""()=>{ document.getElementById('interactiveLookbookOverlay').classList.remove('hidden'); if(!ilPages.length) ilAddPage(); ilFitPage(); }""")
        pg.wait_for_timeout(250)
    def upload(names, kind_chip='＋ upload'):
        with pg.expect_file_chooser() as fc:
            pg.click(f"#ilCollageRoot .sccl-chip:has-text('{kind_chip}')")
        fc.value.set_files([os.path.join(FX, n) for n in names]); pg.wait_for_timeout(700)
    def model(): return ev("ilSelectedItem && ilSelectedItem.__collage ? JSON.parse(JSON.stringify(ilSelectedItem.__collage.model)) : null")
    def filled(m): return [s['name'] for s in m['slots'] if s['src']]
    def vis():  # drawn geometry of each slot (px) in the live collage
        return ev("""()=>{ const c=ilSelectedItem.__collage; const r=c.editor.getResolved(); return r.items.map(i=>({id:i.slot.id,v:i.visible,x:i.x,y:i.y,w:i.w,h:i.h})) }""")

    print('Existing Lookbook behaviour (regression)')
    open_editor()
    pg.click('#ilRailAddBtn'); pg.wait_for_timeout(150)
    ev("""()=>{ ilCreateImageItem({src:(()=>{const c=document.createElement('canvas');c.width=c.height=64;const x=c.getContext('2d');x.fillStyle='#c33';x.fillRect(0,0,64,64);return c.toDataURL()})(), x:20,y:20,w:150,h:150,hasPattern:true}); ilCreateTextItem(40,200); }""")
    check('pattern swatch + text items still create', ev("ilActiveCanvas().querySelectorAll('.canvas-item').length") == 2)
    check('Add panel still has all original controls', all(ev(f"!!document.getElementById('{i}')") for i in ['ilAddSelectedBtn','ilPatternStrip','ilAddPaletteBtn','ilAddTextBtn']))
    check('rail still has exactly four tools', ev("document.querySelectorAll('#ilToolRail .lookbook-rail-btn').length") == 4)

    print('Opening the Collage Builder from the Add panel')
    pg.click('#ilOpenCollageBtn'); pg.wait_for_timeout(300)
    check('Collage builder opens from Add', ev("ilToolGroup") == 'collage' and ev("document.getElementById('ilGroupCollage').hidden") is False)
    check('Add stays lit in the rail while in the builder', ev("document.getElementById('ilRailAddBtn').classList.contains('active')"))

    print('Creating a collage from uploaded artwork')
    pg.click("#ilCollageRoot >> text=+ new empty collage"); pg.wait_for_timeout(300)
    m = model()
    check('new collage starts with 4 visible empty cells', m and len(m['slots']) == 4 and not filled(m))
    upload(['land.png', 'port.png', 'sq.png'])
    m = model()
    check('3 uploaded photos landed', len(filled(m)) == 3, filled(m))
    check('auto layout chose a 3-photo template', m['layout']['kind'] == 'template' and m['layout']['templateId'] == 'big-left', m['layout'])
    pg.screenshot(path=OUT + '/01_layout_big_left.png')
    ids_before = [s['id'] for s in m['slots']]
    srcs_before = [s['src'] for s in m['slots']]

    print('Layout <-> Freeform without losing images')
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Freeform')"); pg.wait_for_timeout(300)
    m2 = model()
    check('switched to freeform', m2['mode'] == 'free')
    check('all 3 photos survived the switch', [s['src'] for s in m2['slots']] == srcs_before)
    g = vis()
    check('freeform starts exactly where the layout was (no jump)', all(abs(a['x'] - (s['free']['x'] / 100 * 1000)) < 1.5 for a, s in zip(g, m2['slots'])))
    pg.screenshot(path=OUT + '/02_freeform.png')

    # drag the first photo in freeform with the real mouse
    box = ev("""()=>{ const e=ilSelectedItem.__collage.item.querySelector('.sccl-slot'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} }""")
    pg.mouse.move(box['x'], box['y']); pg.mouse.down(); pg.mouse.move(box['x'] + 60, box['y'] + 40, steps=6); pg.mouse.up(); pg.wait_for_timeout(250)
    m3 = model()
    check('dragging moved the photo and flagged it as hand-arranged', m3['slots'][0]['freeEdited'] and abs(m3['slots'][0]['free']['x'] - m2['slots'][0]['free']['x']) > 1)
    moved_x = m3['slots'][0]['free']['x']

    pg.click("#ilCollageRoot .sccl-seg button:has-text('Layout')"); pg.wait_for_timeout(250)
    m4 = model()
    check('back to layout: still 3 photos, same order', [s['src'] for s in m4['slots']] == srcs_before and m4['mode'] == 'layout')
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Freeform')"); pg.wait_for_timeout(250)
    m5 = model()
    check('toggling back restores the hand-arranged freeform positions', abs(m5['slots'][0]['free']['x'] - moved_x) < 0.01)

    print('Predefined layouts with more / fewer cells than photos')
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Layout')"); pg.wait_for_timeout(200)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='grid-nine']"); pg.wait_for_timeout(250)
    m = model(); check('9-cell grid: 9 slots, 3 photos kept', len(m['slots']) == 9 and len(filled(m)) == 3)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='halves-v']"); pg.wait_for_timeout(250)
    m = model(); check('2-cell grid with 3 photos: no photo deleted', len(filled(m)) == 3 and [s['src'] for s in m['slots']] == srcs_before)
    g = vis(); check('only 2 are drawn; 1 is parked, not lost', sum(1 for a in g if a['v']) == 2)
    check('panel explains the parked photo', 'not shown' in ev("document.querySelector('#ilCollageRoot .sccl-empty-note:not([hidden])') ? [...document.querySelectorAll('#ilCollageRoot .sccl-empty-note')].map(n=>n.textContent).join('|') : ''"))
    pg.click("#ilCollageRoot .sccl-tpl[data-id='grid-six']"); pg.wait_for_timeout(250)
    g = vis(); check('bigger layout brings the parked photo back', sum(1 for a in g if a['v'] and True) >= 3 and len(filled(model())) == 3)
    pg.click("#ilCollageRoot button:has-text('auto-fit')"); pg.wait_for_timeout(250)
    m = model(); g = vis()
    check('auto-fit: all 3 photos drawn, no empty cells kept', m['layout']['kind'] == 'auto' and sum(1 for a in g if a['v']) == 3)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='quadrants']"); pg.wait_for_timeout(250)
    m = model(); check('back to a grid: still the same 3 photos + an empty cell', len(filled(m)) == 3 and len(m['slots']) == 4)

    print('Auto-fit keeps each photo undistorted')
    pg.click("#ilCollageRoot button:has-text('auto-fit')"); pg.wait_for_timeout(250)
    m = model(); g = vis()
    ok = True
    for s, a in zip([s for s in m['slots'] if s['src']], [a for a in g if a['v']]):
        ok = ok and abs((a['w'] / a['h']) - s['ar']) / s['ar'] < 0.02
    check('every auto-fit cell keeps its photo\'s own aspect ratio', ok)

    print('Editable grid (gutter handles)')
    pg.click("#ilCollageRoot .sccl-tpl[data-id='quadrants']"); pg.wait_for_timeout(250)
    before = ev("ilSelectedItem.__collage.model.layout.colWeights")
    d = ev("""()=>{ const e=ilSelectedItem.__collage.item.querySelector('.sccl-grip.v'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} }""")
    pg.mouse.move(d['x'], d['y']); pg.mouse.down(); pg.mouse.move(d['x'] + 50, d['y'], steps=5); pg.mouse.up(); pg.wait_for_timeout(250)
    after = ev("ilSelectedItem.__collage.model.layout.colWeights")
    check('dragging a divider resizes the columns', before is None and after and after[0] > 0.55 and abs(sum(after) - 1) < 1e-6, after)

    print('Masks, borders, shadows, zoom, decorations')
    pg.click("#ilCollageRoot .sccl-tpl[data-id='big-left']"); pg.wait_for_timeout(200)
    c0 = ev("""()=>{ const e=ilSelectedItem.__collage.item.querySelector('.sccl-slot'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} }""")
    pg.mouse.click(c0['x'], c0['y']); pg.wait_for_timeout(250)
    check('tapping a cell selects it and shows the photo controls', ev("document.querySelector('#ilCollageRoot .lookbook-tool-block h4') && [...document.querySelectorAll('#ilCollageRoot h4')].some(h=>h.textContent==='selected photo' && !h.parentElement.hidden)"))
    pg.click("#ilCollageRoot .sccl-chip[data-mask='heart']"); pg.wait_for_timeout(150)
    ev("""()=>{ const c=ilSelectedItem.__collage; const o=c.editor.getSelectedObject(); o.shadow=60; o.border={w:3,color:'#ffffff'}; o.zoom=1.6; o.offX=5; c.editor.refresh(); c.commit(true); }""")
    pg.click("#ilCollageRoot summary:has-text('decorations')"); pg.click("#ilCollageRoot .sccl-chip:has-text('tape')"); pg.wait_for_timeout(200)
    pg.click("#ilCollageRoot .sccl-chip:has-text('star')"); pg.wait_for_timeout(200)
    m = model()
    check('mask / shadow / border / zoom stored on the photo', m['slots'][0]['mask'] == 'heart' and m['slots'][0]['shadow'] == 60 and m['slots'][0]['border']['w'] == 3)
    check('two decorations added', len(m['decor']) == 2)
    pg.screenshot(path=OUT + '/03_styled.png')

    print('Saving as a reusable template')
    pg.click("#ilCollageRoot summary:has-text('my collage templates')"); pg.click("#ilCollageRoot button:has-text('save this layout as a template')"); pg.wait_for_timeout(200)
    tpls = ev("ScCollage.userTemplates.list()")
    check('template saved without any photos in it', len(tpls) == 1 and 'src' not in json.dumps(tpls[0]).replace('"src"', '', 0) or all(s.get('src') is None for s in tpls[0]['slots']))
    check('template JSON contains no image data', 'data:image' not in json.dumps(tpls))

    print('Save, restore (fully editable afterwards)')
    ser = ev("JSON.parse(JSON.stringify(serializeProject()))")
    items = ser['lookbook']['pages'][0]['items']
    col = [i for i in items if i['type'] == 'collage']
    check('project serialises the collage as type=collage with its model', len(col) == 1 and len(col[0]['model']['slots']) >= 3)
    check('old item types still serialise', any(i['type'] == 'text' for i in items) and any(i['type'] == 'image' for i in items))
    saved_model = col[0]['model']
    # wipe the page and restore it the way restoreProject does
    ev("""(data)=>{ const pgobj=ilPages[ilActivePageIndex]; pgobj.el.querySelectorAll('.canvas-item').forEach(e=>e.remove()); ilDeselectAll(); data.forEach(d=>ilRestoreLookbookItem(d)); }""" if False else
       "()=>0")
    ev("window.__items = " + json.dumps(items))
    ev("""()=>{ const pgobj=ilPages[ilActivePageIndex]; pgobj.el.querySelectorAll('.canvas-item').forEach(e=>e.remove()); ilDeselectAll(); window.__items.forEach(d=>ilRestoreLookbookItem(d)); }""")
    pg.wait_for_timeout(300)
    restored = ev("""()=>{ const e=ilActiveCanvas().querySelector('.collage-item'); return e ? JSON.parse(JSON.stringify(e.__collage.model)) : null }""")
    check('collage restored with an identical model', restored == saved_model)
    ev("""()=>{ const e=ilActiveCanvas().querySelector('.collage-item'); ilSelectItem(e); e.__collage.editor.setEditing(true); }""")
    pg.wait_for_timeout(250)
    pg.click("#ilCollageRoot .sccl-seg button:has-text('Freeform')"); pg.wait_for_timeout(250)
    check('restored collage is still fully editable (layout switch works)', model()['mode'] == 'free' and len(filled(model())) == 3)
    pg.screenshot(path=OUT + '/04_restored.png')

    print('Autosave -> page reload -> restore')
    ev("performAutosave(false)"); pg.wait_for_timeout(600)
    pg.reload(wait_until='domcontentloaded'); pg.wait_for_timeout(2200)
    n = ev("ilPages.length ? ilPages[0].el.querySelectorAll('.collage-item').length : -1")
    check('collage survives a full page reload via autosave', n == 1, n)
    if n == 1:
        m = ev("JSON.parse(JSON.stringify(ilPages[0].el.querySelector('.collage-item').__collage.model))")
        check('reloaded collage has the same photos', len([s for s in m['slots'] if s['src']]) == 3)

    print('Export')
    open_editor()
    res = ev("""async()=>{ const pgo=ilPages[0]; const c=await ilRasterizeCanvas(pgo.el, 1, pgo.bg); const x=c.getContext('2d');
        const px=(a,b)=>Array.from(x.getImageData(a,b,1,1).data); return {w:c.width,h:c.height, url:c.toDataURL('image/png'),
        corner:px(5,5), centre:px(600,425)} }""")
    check('export is the full page size (1200x850 @1x)', res['w'] == 1200 and res['h'] == 850)
    check('export has the collage drawn (centre is not page-white)', res['centre'][:3] != [255, 255, 255])
    import base64
    open(OUT + '/05_export.png', 'wb').write(base64.b64decode(res['url'].split(',')[1]))
    hi = ev("""async()=>{ const pgo=ilPages[0]; const c=await ilRasterizeCanvas(pgo.el, 3, pgo.bg); return {w:c.width,h:c.height} }""")
    check('high-resolution export scales (3x)', hi['w'] == 3600 and hi['h'] == 2550)
    thumb_ok = ev("""async()=>{ await ilRenderPageThumbnails(); return !!document.querySelector('#ilPageThumbnails .lookbook-page-thumb img') }""")
    check('page thumbnails render with a collage on the page', thumb_ok)

    print('Page switching keeps the collage')
    ev("ilAddPage()"); pg.wait_for_timeout(200); ev("ilSwitchToPage(0)"); pg.wait_for_timeout(200)
    check('collage still on page 1 after switching pages', ev("ilPages[0].el.querySelectorAll('.collage-item').length") == 1)

    real_errs = [e for e in errs if 'ERR_TUNNEL' not in e]
    check('no uncaught page errors', not real_errs, real_errs[:5])
    b.close()

print(f'\n{passes} passed, {len(fails)} failed')
if fails: print('FAILED:', fails); sys.exit(1)
