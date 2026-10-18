"""
Creative Lookbook — Phase 1 UX polish, end to end in headless Chromium.

  python3 tests/collage/make_fixtures.py /tmp/fx
  (cd public && python3 -m http.server 8765 &)
  python3 tests/lookbook/phase1.py http://localhost:8765 /tmp/fx /tmp/out [--touch]

Covers: free decorative shapes (move anywhere / overlap / optional snapping), shape + text colours and opacity,
colour extraction from a pattern placed inside a collage, the two pattern resize modes + repositioning, alignment
(page / selection, distribute) and save -> reload -> export of all of it.
--touch drives the drags with real touch events (CDP Input.dispatchTouchEvent) instead of the mouse.
"""
import sys, os, json
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
    ctx = b.new_context(viewport={'width': 1180, 'height': 820}, has_touch=TOUCH, is_mobile=False)
    pg = ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept())
    ev = pg.evaluate
    cdp = ctx.new_cdp_session(pg) if TOUCH else None
    def settle(ms=250): pg.wait_for_timeout(ms)
    def tap(sel):
        if TOUCH: pg.tap(sel)
        else: pg.click(sel)

    def drag(x0, y0, x1, y1, steps=8):
        """one drag gesture, mouse or real touch events"""
        if TOUCH:
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0}]})
            for i in range(1, steps + 1):
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / steps, 'y': y0 + (y1 - y0) * i / steps}]})
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        else:
            pg.mouse.move(x0, y0); pg.mouse.down()
            pg.mouse.move(x1, y1, steps=steps); pg.mouse.up()
        settle(200)

    def centre(sel_js):
        return ev("(()=>{const r=(" + sel_js + ").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,l:r.x,t:r.y,w:r.width,h:r.height}})()")
    def pos(i):  # page-px left/top/w/h of the i-th shape on the page
        return ev("(()=>{const e=ilActiveCanvas().querySelectorAll('.shape-item')[%d]; return {l:parseFloat(e.style.left),t:parseFloat(e.style.top),w:parseFloat(e.style.width),h:parseFloat(e.style.height)}})()" % i)
    def raster_px(x, y, scale=1):
        return ev("""async ([x,y,s])=>{ const c=await ilRasterizeCanvas(ilActiveCanvas(), s, ilPages[ilActivePageIndex].bg); const d=c.getContext('2d').getImageData(Math.round(x*s),Math.round(y*s),1,1).data; return [d[0],d[1],d[2],d[3]]; }""", [x, y, scale])
    def hexrgb(h): h = h.lstrip('#'); return [int(h[i:i+2], 16) for i in (0, 2, 4)]
    def near(a, b, tol=6): return all(abs(a[i] - b[i]) <= tol for i in range(3))

    pg.goto(URL, wait_until='domcontentloaded'); settle(1200)
    tap('#lbNewBtn'); settle(1200)
    pg.fill('#lbProjectName', 'Phase One'); settle(150)
    pg.set_input_files('#lbFilePatterns', fx('pattern.png')); settle(900)
    pg.set_input_files('#lbFileImages', fx('land.png', 'port.png')); settle(1000)
    zoom = ev('ilZoom')

    print('1. Decorative shapes are free page objects')
    kinds = ev("[...document.querySelectorAll('#ilShapeKinds .il-chip')].map(c=>c.textContent).join()")
    check('Add panel offers the shapes', 'diamond' in kinds and 'heart' in kinds and 'star' in kinds, kinds)
    tap("#ilShapeKinds .il-chip:has-text('diamond')"); settle(250)
    check('a diamond is a .shape-item on the page (not inside any collage)', ev("document.querySelectorAll('.shape-item').length") == 1 and ev("!document.querySelector('.shape-item').closest('.collage-item')"))
    check('the colour controls open (Style) and are shown for it', ev('ilToolGroup') == 'style' and ev("!document.getElementById('ilShapeControls').hidden"))
    # a collage underneath, so we can prove shapes overlap it and move beyond it
    tap('#ilRailAddBtn'); settle(150)
    tap('#ilOpenCollageBtn'); settle(250)
    pg.click("#ilCollageRoot >> text=+ new empty collage"); settle(300)
    pg.click("#ilCollageRoot .sccl-chip:has-text('patterns')"); settle(400)
    pg.click("#ilCollageRoot .sccl-thumb:nth-child(1)"); settle(300)
    pg.click("#ilCollageRoot .sccl-tpl[data-id='halves-v']"); settle(300)
    ev("()=>{ const c=ilSelectedItem.__collage; c.editor.setEditing(false); }")
    tap('#ilToolPanelCollapseBtn'); settle(200)
    ev("()=>{ const col=document.querySelector('.collage-item'); col.style.left='150px'; col.style.top='120px'; col.style.width='600px'; col.style.height='420px'; }"); settle(300)
    cb = ev("(()=>{const c=document.querySelector('.collage-item'); return {l:parseFloat(c.style.left),t:parseFloat(c.style.top),w:parseFloat(c.style.width),h:parseFloat(c.style.height)}})()")

    # drag the diamond right over the collage, then to the far corner of the page
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='900px'; s.style.top='80px'; s.style.zIndex=9999; }"); settle(150)
    sc = centre("document.querySelector('.shape-item')")
    before = pos(0)
    drag(sc['x'], sc['y'], sc['x'] - 600 * zoom, sc['y'] + 200 * zoom)
    after = pos(0)
    check('dragging a shape moves it exactly with the pointer (any direction)', abs((after['l'] - before['l']) - (-600)) < 4 and abs((after['t'] - before['t']) - 200) < 4, (before, after))
    cx, cy = after['l'] + after['w'] / 2, after['t'] + after['h'] / 2
    check('it now overlaps the collage and sits above it', cb['l'] < cx < cb['l'] + cb['w'] and cb['t'] < cy < cb['t'] + cb['h'] and ev("+document.querySelector('.shape-item').style.zIndex > +document.querySelector('.collage-item').style.zIndex"))
    sc = centre("document.querySelector('.shape-item')")
    drag(sc['x'], sc['y'], sc['x'] + 700 * zoom, sc['y'] + 330 * zoom)
    far = pos(0)
    check('no grid / frame restriction: it travels all the way to the page corner area', far['l'] > 900 and far['t'] > 500, far)
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='-60px'; s.style.top='-40px'; }")
    check('a shape can also sit partly off the page edge', pos(0)['l'] < 0)
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='600px'; s.style.top='300px'; }")

    print('2. Snapping is optional')
    check('snapping is OFF by default', ev("document.getElementById('ilSnapBtn').textContent").endswith('off'))
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='60px'; s.style.top='460px'; }"); settle(100)
    tap('#ilRailArrangeBtn'); settle(250)
    sc = centre("document.querySelector('.shape-item')"); b0 = pos(0)
    drag(sc['x'], sc['y'], sc['x'] - 56 * zoom, sc['y'])      # left edge would land at ~4px
    check('without snapping the shape lands exactly where dropped (4px, not 0)', abs(pos(0)['l'] - 4) < 3 and pos(0)['l'] > 1.5, pos(0))
    tap('#ilSnapBtn'); settle(100)
    check('snapping toggle turns on', ev("document.getElementById('ilSnapBtn').textContent").endswith('on'))
    sc = centre("document.querySelector('.shape-item')")
    drag(sc['x'], sc['y'], sc['x'] - 1 * zoom, sc['y'] - 0)   # left edge ~3px -> snaps to the page edge
    check('with snapping on the left edge locks to the page edge', abs(pos(0)['l']) < 0.6, pos(0))
    tap('#ilSnapBtn'); settle(100)
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='600px'; s.style.top='300px'; }")

    print('3. Shape colours (fill / outline / width / opacity / none)')
    ev("()=>{ ilSelectItem(document.querySelector('.shape-item')); ilSetToolGroup('style'); }"); settle(250)
    sw = ev("document.querySelectorAll('#ilShapeFillStrip .il-sw:not(.il-sw-add)').length")
    check('shared swatch strip offers the page colours', sw >= 2, sw)
    # pick the 2nd swatch for fill
    col = ev("document.querySelectorAll('#ilShapeFillStrip .il-sw:not(.il-sw-add)')[1].title")
    tap("#ilShapeFillStrip .il-sw:not(.il-sw-add):nth-child(2)"); settle(150)
    check('fill colour applied from a swatch', ev("document.querySelector('.shape-item').dataset.fill").lower() == col.lower())
    # custom colour (the + opens the native picker; drive the same input it uses)
    tap('#ilShapeFillStrip .il-sw-add'); settle(100)
    ev("()=>{ const i=document.getElementById('ilCustomColorInput'); i.value='#1e90ff'; i.dispatchEvent(new Event('input',{bubbles:true})); }"); settle(150)
    check('custom fill colour works', ev("document.querySelector('.shape-item').dataset.fill") == '#1e90ff')
    ev("()=>{ const s=document.querySelector('.shape-item'); s.style.left='500px'; s.style.top='620px'; s.style.width='200px'; s.style.height='200px'; }"); settle(200)
    s0 = pos(0); mid = (s0['l'] + s0['w'] / 2, s0['t'] + s0['h'] / 2)
    px = raster_px(s0['l'] + s0['w'] / 2, s0['t'] + s0['h'] / 2)
    check('export paints the fill colour (#1e90ff)', near(px, hexrgb('#1e90ff')), px)
    # outline
    tap('#ilShapeStrokeStrip .il-sw:not(.il-sw-add):nth-child(1)'); settle(100)
    ev("()=>{ const r=document.getElementById('ilShapeStrokeWSlider'); r.value=24; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }"); settle(200)
    ocol = ev("document.querySelector('.shape-item').dataset.stroke")
    check('outline colour + width set', ev("document.querySelector('.shape-item').dataset.strokeOn") == '1' and ev("document.querySelector('.shape-item').dataset.strokeW") == '24')
    s0 = pos(0)
    # diamond: outline reaches the middle of each edge; sample just inside the left tip
    px = raster_px(s0['l'] + 12, s0['t'] + s0['h'] / 2)
    check('export paints the outline in the outline colour', near(px, hexrgb(ocol)), (px, ocol))
    # opacity
    ev("()=>{ const r=document.getElementById('ilShapeOpacitySlider'); r.value=50; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }"); settle(150)
    check('opacity stored', abs(float(ev("document.querySelector('.shape-item').style.opacity")) - 0.5) < 0.01)
    px = raster_px(s0['l'] + s0['w'] / 2, s0['t'] + s0['h'] / 2)
    check('export blends the shape at 50% over white', abs(px[0] - (0x1e + 255) / 2) < 8 and abs(px[2] - 255) < 8, px)
    ev("()=>{ const r=document.getElementById('ilShapeOpacitySlider'); r.value=100; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }")
    # no fill / no outline
    tap('#ilShapeNoFillBtn'); settle(150)
    px = raster_px(s0['l'] + s0['w'] / 2, s0['t'] + s0['h'] / 2)
    check('no-fill leaves the middle empty (white page)', near(px, [255, 255, 255]), px)
    tap('#ilShapeNoFillBtn'); tap('#ilShapeNoStrokeBtn'); settle(150)
    check('no-outline switches the outline off', ev("document.querySelector('.shape-item').dataset.strokeOn") == '0')
    px = raster_px(s0['l'] + 6, s0['t'] + s0['h'] / 2)
    check('…and the export has no outline (the fill reaches the edge)', near(px, hexrgb('#1e90ff')), px)
    # rotation handle/slider
    ev("()=>{ const r=document.getElementById('ilShapeRotateSlider'); r.value=45; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }"); settle(150)
    check('rotation applied (slider)', ev("document.querySelector('.shape-item').dataset.rotate") == '45' and 'rotate(45deg)' in ev("document.querySelector('.shape-item').style.transform"))
    hd = centre("document.querySelector('.shape-item .item-rotate-handle')")
    ic = centre("document.querySelector('.shape-item')")
    drag(hd['x'], hd['y'], ic['x'] + 200 * zoom, ic['y'], steps=6)
    check('rotation handle can be dragged (pointing right = 90°)', abs(float(ev("document.querySelector('.shape-item').dataset.rotate")) - 90) < 6, ev("document.querySelector('.shape-item').dataset.rotate"))
    pg.screenshot(path=OUT + '/p1_shapes.png')

    print('4. Text colour, custom colour and opacity')
    ev("()=>{ ilSetToolGroup('add'); }"); tap('#ilAddTextBtn'); settle(250)
    ev("()=>{ const t=ilSelectedItem; t.querySelector('.text-item-content').textContent='Colour test'; t.querySelector('.text-item-content').dataset.placeholder='false'; t.style.left='60px'; t.style.top='40px'; t.style.fontSize='96px'; t.dataset.fontSize='96'; t.style.width='700px'; document.activeElement.blur(); ilSetToolGroup('style'); }"); settle(250)
    tap('#ilPaletteStrip .il-sw:not(.il-sw-add):nth-child(1)'); settle(100)
    check('text colour from swatch', ev("ilSelectedItem.style.color") in ('rgb(34, 34, 34)', '#222222'))
    tap('#ilPaletteStrip .il-sw-add'); settle(80)
    ev("()=>{ const i=document.getElementById('ilCustomColorInput'); i.value='#c0392b'; i.dispatchEvent(new Event('input',{bubbles:true})); }"); settle(150)
    check('custom text colour', ev("ilSelectedItem.style.color") in ('rgb(192, 57, 43)', '#c0392b'))
    def darkness():
        return ev("""async ()=>{ const c=await ilRasterizeCanvas(ilActiveCanvas(),1,ilPages[ilActivePageIndex].bg); const d=c.getContext('2d').getImageData(60,40,700,130).data; let g=0; for(let i=0;i<d.length;i+=4){ g+=255-d[i+1]; } return g; }""")
    full = darkness()
    ev("()=>{ const r=document.getElementById('ilTextOpacitySlider'); r.value=40; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }"); settle(150)
    half = darkness()
    check('text opacity control present and stored', ev("ilSelectedItem.style.opacity") == '0.4')
    check('export draws the text lighter at 40% opacity', half < full * 0.6, (full, half))
    ev("()=>{ const r=document.getElementById('ilTextOpacitySlider'); r.value=100; r.dispatchEvent(new Event('input',{bubbles:true})); }")
    check('font controls are still there', ev("!!document.getElementById('ilFontPairSelect') && !!document.getElementById('ilFontSizeSlider')"))

    print('5. Colour extraction straight from a pattern inside a collage')
    ev("()=>{ ilSelectItem(document.querySelector('.collage-item')); ilSetToolGroup('collage'); const c=ilSelectedItem.__collage; c.editor.setEditing(true); }"); settle(300)
    slot_ctr = ev("""()=>{ const c=ilSelectedItem.__collage; const e=c.item.querySelector('.sccl-slot'); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; }""")
    pg.mouse.click(slot_ctr['x'], slot_ctr['y']); settle(300)
    check('selecting a frame with a pattern shows "extract colours"', ev("[...document.querySelectorAll('#ilCollageRoot button')].some(b=>/extract colours/.test(b.textContent) && b.offsetParent!==null)"))
    n_before = ev("window.__lbApp.getProject().patterns.length")
    pg.click("#ilCollageRoot button:has-text('extract colours')"); settle(500)
    got = ev("[...document.querySelectorAll('#ilCollageRoot .sccl-sw')].map(b=>b.title)")
    expect = ev("""async ()=>{ const c=ilSelectedItem.__collage; const o=c.editor.getSelectedObject(); const img=await ilLoadImage(o.src); return ilExtractPaletteColors(img,6); }""")
    check('palette shown, 6 colours', len(got) == 6, got)
    check('they are the colours of the frame\'s own picture (no re-import)', [g.lower() for g in got] == [e.lower() for e in expect] and ev("window.__lbApp.getProject().patterns.length") == n_before, (got, expect))
    check('extracted colours also appear in the Style panel', ev("!document.getElementById('ilExtractedBlock').hidden") )
    # apply to a shape, text and page background
    ev("()=>{ ilSelectItem(document.querySelector('.shape-item')); }"); settle(200)
    ev("(c)=>ilApplyColour(c)", got[1]); settle(150)
    check('extracted colour applies to a decoration (fill)', ev("document.querySelector('.shape-item').dataset.fill").lower() == got[1].lower())
    ev("()=>{ ilSelectItem(document.querySelector('.text-item')); }"); settle(150)
    ev("(c)=>ilApplyColour(c)", got[2]); settle(150)
    check('…to text', ev("ilSelectedItem.style.color") != 'rgb(192, 57, 43)')
    ev("()=>{ ilDeselectAll(); }"); ev("(c)=>ilApplyColour(c)", got[3]); settle(150)
    check('…and to the page background', ev("ilPages[ilActivePageIndex].bg.type") == 'solid' and ev("ilPages[ilActivePageIndex].bg.color").lower() == got[3].lower())
    ev("()=>{ ilSelectItem(document.querySelector('.shape-item')); ilSetToolGroup('style'); }"); settle(200)
    strip_cols = [x.lower() for x in ev("[...document.querySelectorAll('#ilShapeFillStrip .il-sw')].map(b=>b.title)")]
    check('every colour picker (here: shape fill) now lists the extracted colours', all(g.lower() in strip_cols for g in got), (got, strip_cols))
    ev("()=>{ ilSetPageBackground(ilPages[ilActivePageIndex], {type:'none'}); }")

    print('6. Pattern scale modes + repositioning inside the frame')
    ev("()=>{ ilSelectItem(document.querySelector('.collage-item')); ilSetToolGroup('collage'); const c=ilSelectedItem.__collage; c.editor.setEditing(true); const e=c.item.querySelector('.sccl-slot'); }"); settle(250)
    def tile_px():
        return ev("parseFloat(document.querySelector('.collage-item .sccl-slot .sccl-pat').style.backgroundSize)")
    def frame_w():
        return ev("document.querySelector('.collage-item .sccl-slot').offsetWidth")
    def set_item_w(w):
        ev("(w)=>{ document.querySelector('.collage-item').style.width = w+'px'; }", w); settle(350)
    set_item_w(600); t0, w0 = tile_px(), frame_w()
    check('default mode is "scale with frame"', ev("ilSelectedItem.__collage.model.scaleMode") == 'frame')
    set_item_w(900); t1, w1 = tile_px(), frame_w()
    check('scale with frame: bigger frame -> proportionally bigger pattern', abs(t1 / t0 - w1 / w0) < 0.02, (t0, t1, w0, w1))
    pg.click("#ilCollageRoot button:has-text('keep pattern scale')"); settle(300)
    check('switching to "keep pattern scale" does not make the pattern jump', abs(tile_px() - t1) < 0.5, (tile_px(), t1))
    set_item_w(600); t2, w2 = tile_px(), frame_w()
    set_item_w(1100); t3, w3 = tile_px(), frame_w()
    check('keep pattern scale: pattern size unchanged while the frame resizes', abs(t2 - t1) < 0.5 and abs(t3 - t1) < 0.5 and w3 > w2 * 1.5, (t1, t2, t3, w2, w3))
    # export agrees: tile period in the exported image equals the tile size
    s_ctr = ev("""()=>{ const e=document.querySelector('.collage-item .sccl-slot'); const it=document.querySelector('.collage-item'); const r=e.getBoundingClientRect(), pr=ilActiveCanvas().getBoundingClientRect(); return {l:(r.left-pr.left)/ilZoom, t:(r.top-pr.top)/ilZoom}; }""")
    tw = round(t1)
    a = raster_px(s_ctr['l'] + 20, s_ctr['t'] + 20); b2 = raster_px(s_ctr['l'] + 20 + tw, s_ctr['t'] + 20)
    check('export repeats at the same tile size (fixed mode)', near(a, b2, 10), (a, b2, tw))
    pg.click("#ilCollageRoot button:has-text('scale with frame')"); settle(300)
    check('switching back keeps the current size too', abs(tile_px() - t1) < 0.5, tile_px())
    set_item_w(550); t5, w5 = tile_px(), frame_w()
    check('…and the pattern follows the frame again', abs(t5 / t1 - w5 / w3) < 0.03, (t5, t1, w5, w3))
    # scale slider + position
    ev("()=>{ const c=ilSelectedItem.__collage; const e=c.item.querySelector('.sccl-slot'); const r=e.getBoundingClientRect(); window.__sc={x:r.x+r.width/2,y:r.y+r.height/2}; }")
    sc2 = ev('window.__sc'); pg.mouse.click(sc2['x'], sc2['y']); settle(250)
    pg.click("#ilCollageRoot button:has-text('move picture inside frame')"); settle(150)
    check('"move picture inside frame" mode switches on', ev("ilSelectedItem.__collage.editor.isPanMode()"))
    tw_now = tile_px()
    drag(sc2['x'], sc2['y'], sc2['x'] + 30 * zoom, sc2['y'] + 18 * zoom, steps=6)
    pxv = ev("(()=>{const o=ilSelectedItem.__collage.editor.getSelectedObject(); return [o.patX,o.patY]})()")
    check('dragging slides the pattern inside the frame (frame itself did not move)', abs(pxv[0] - 30 / tw_now * 100) < 4 and abs(pxv[1] - 18 / tw_now * 100) < 4, (pxv, tw_now))
    bgpos = ev("document.querySelector('.collage-item .sccl-slot .sccl-pat').style.backgroundPosition")
    check('background position follows the offset', abs(float(bgpos.split('px')[0]) - pxv[0] / 100 * tw_now) < 1.5, bgpos)
    pg.click("#ilCollageRoot button:has-text('done moving picture')"); settle(150)
    pg.click("#ilCollageRoot button:has-text('reset picture position')"); settle(200)
    check('reset picture position', ev("(()=>{const o=ilSelectedItem.__collage.editor.getSelectedObject(); return o.patX===0&&o.patY===0})()"))
    ev("()=>{ const r=[...document.querySelectorAll('#ilCollageRoot label')].find(l=>l.textContent.startsWith('pattern scale')).nextElementSibling; r.value=70; r.dispatchEvent(new Event('input',{bubbles:true})); r.dispatchEvent(new Event('change',{bubbles:true})); }"); settle(250)
    check('independent pattern scale slider still works', abs(tile_px() / frame_w() - 0.70) < 0.03, (tile_px(), frame_w()))
    check('existing grid templates still apply', ev("""()=>{ document.querySelector("#ilCollageRoot .sccl-tpl[data-id='grid-six']").click(); return true }""") and ev("ilSelectedItem.__collage.model.layout.templateId") == 'grid-six')
    pg.click("#ilCollageRoot .sccl-tpl[data-id='halves-v']"); settle(250)
    ev("()=>{ ilSelectedItem.__collage.editor.setEditing(false); }")
    pg.screenshot(path=OUT + '/p1_scale.png')

    print('7. Alignment, distribution, multi-select')
    ev("()=>{ ilSetToolGroup('arrange'); ilDeselectAll(); [...document.querySelectorAll('.shape-item')].forEach(e=>e.remove()); }"); settle(150)
    def add_shape(kind, l, t, w, h):
        ev("""([k,l,t,w,h])=>{ const s=ilCreateShapeItem({kind:k,x:l,y:t,w:w,h:h}); }""", [kind, l, t, w, h])
    add_shape('square', 100, 700, 100, 60); add_shape('circle', 400, 720, 80, 80); add_shape('star', 900, 690, 120, 120)
    col_model_before = ev("JSON.stringify(document.querySelector('.collage-item').__collage.model)")
    text_pos = ev("[ilActiveCanvas().querySelector('.text-item').style.left, ilActiveCanvas().querySelector('.text-item').style.top]")
    tap('#ilMultiBtn'); settle(100)
    for i in range(3):
        c = centre("document.querySelectorAll('.shape-item')[%d]" % i); pg.mouse.click(c['x'], c['y']) if not TOUCH else pg.touchscreen.tap(c['x'], c['y']); settle(120)
    check('"select several" selects the three shapes', ev("ilMultiSel.size") == 3 and ev("document.querySelectorAll('.multi-selected').length") == 3, ev("ilMultiSel.size"))
    check('alignment tools are enabled for a multi-selection', ev("!document.querySelector('#ilAlignBlock [data-distribute=h]').disabled && !document.querySelector('#ilAlignRel button[data-rel=selection]').disabled"))
    tap("#ilAlignRel button[data-rel=selection]"); settle(80)
    tap("#ilAlignBlock [data-align=left]"); settle(150)
    L = [pos(i)['l'] for i in range(3)]
    check('align left (to the selection): all share the leftmost edge', max(L) - min(L) < 1 and abs(min(L) - 100) < 1, L)
    tap("#ilAlignBlock [data-align=middle]"); settle(150)
    mids = [pos(i)['t'] + pos(i)['h'] / 2 for i in range(3)]
    check('align middle (to the selection): same vertical centre', max(mids) - min(mids) < 1, mids)
    tap("#ilAlignBlock [data-align=bottom]"); settle(150)
    bots = [pos(i)['t'] + pos(i)['h'] for i in range(3)]
    check('align bottom (to the selection)', max(bots) - min(bots) < 1, bots)
    tap("#ilAlignBlock [data-align=top]"); settle(150)
    tops = [pos(i)['t'] for i in range(3)]
    check('align top (to the selection)', max(tops) - min(tops) < 1, tops)
    tap("#ilAlignBlock [data-align=right]"); settle(150)
    R = [pos(i)['l'] + pos(i)['w'] for i in range(3)]
    check('align right (to the selection)', max(R) - min(R) < 1, R)
    tap("#ilAlignBlock [data-align=center]"); settle(150)
    C = [pos(i)['l'] + pos(i)['w'] / 2 for i in range(3)]
    check('align centre (to the selection)', max(C) - min(C) < 1, C)
    # relative to the page
    tap("#ilAlignRel button[data-rel=page]"); settle(80)
    tap("#ilAlignBlock [data-align=left]"); settle(150)
    check('align left to the PAGE: edges at 0', all(abs(pos(i)['l']) < 1 for i in range(3)), [pos(i)['l'] for i in range(3)])
    tap("#ilAlignBlock [data-align=right]"); settle(150)
    check('align right to the PAGE: edges at 1200', all(abs(pos(i)['l'] + pos(i)['w'] - 1200) < 1 for i in range(3)), [pos(i)['l'] + pos(i)['w'] for i in range(3)])
    tap("#ilAlignBlock [data-align=center]"); settle(150)
    check('centre on the PAGE: 600', all(abs(pos(i)['l'] + pos(i)['w'] / 2 - 600) < 1 for i in range(3)))
    tap("#ilAlignBlock [data-align=bottom]"); settle(150)
    check('bottom on the PAGE: 850', all(abs(pos(i)['t'] + pos(i)['h'] - 850) < 1 for i in range(3)))
    tap("#ilAlignBlock [data-align=middle]"); settle(150)
    check('middle on the PAGE: 425', all(abs(pos(i)['t'] + pos(i)['h'] / 2 - 425) < 1 for i in range(3)))
    tap("#ilAlignBlock [data-align=top]"); settle(150)
    check('top on the PAGE: 0', all(abs(pos(i)['t']) < 1 for i in range(3)))
    # distribute
    ev("()=>{ const s=document.querySelectorAll('.shape-item'); s[0].style.left='50px'; s[1].style.left='200px'; s[2].style.left='1000px'; s.forEach((e,i)=>e.style.top=(300+i*10)+'px'); }"); settle(150)
    tap("#ilAlignBlock [data-distribute=h]"); settle(200)
    bx = sorted([(pos(i)['l'], pos(i)['l'] + pos(i)['w']) for i in range(3)])
    g1, g2 = bx[1][0] - bx[0][1], bx[2][0] - bx[1][1]
    check('distribute horizontally: equal gaps, outer two stay put', abs(g1 - g2) < 1 and abs(bx[0][0] - 50) < 1 and abs(bx[2][1] - 1120) < 1, (g1, g2, bx))
    ev("()=>{ const s=document.querySelectorAll('.shape-item'); s.forEach((e,i)=>{e.style.left=(100+i*40)+'px'}); s[0].style.top='40px'; s[1].style.top='140px'; s[2].style.top='700px'; }"); settle(150)
    tap("#ilAlignBlock [data-distribute=v]"); settle(200)
    by = sorted([(pos(i)['t'], pos(i)['t'] + pos(i)['h']) for i in range(3)])
    check('distribute vertically: equal gaps', abs((by[1][0] - by[0][1]) - (by[2][0] - by[1][1])) < 1, by)
    check('unrelated objects were not touched (collage model + text position)', ev("JSON.stringify(document.querySelector('.collage-item').__collage.model)") == col_model_before and ev("[ilActiveCanvas().querySelector('.text-item').style.left, ilActiveCanvas().querySelector('.text-item').style.top]") == text_pos)
    # group drag
    s_c = centre("document.querySelectorAll('.shape-item')[0]"); p_before = [pos(i) for i in range(3)]
    tap('#ilMultiBtn'); settle(80)   # leave select-several mode; the three stay selected
    ev("()=>{ const s=[...document.querySelectorAll('.shape-item')]; s.forEach(e=>{ ilMultiSel.add(e); e.classList.add('multi-selected'); }); ilSelectedItem=s[0]; s[0].classList.add('selected'); }")
    drag(s_c['x'], s_c['y'], s_c['x'] + 100 * zoom, s_c['y'] + 40 * zoom)
    p_after = [pos(i) for i in range(3)]
    check('dragging one of a multi-selection moves them all together', all(abs((p_after[i]['l'] - p_before[i]['l']) - 100) < 4 and abs((p_after[i]['t'] - p_before[i]['t']) - 40) < 4 for i in range(3)), (p_before, p_after))
    ev("()=>{ ilDeselectAll(); }")
    # single object to page centre
    ev("()=>{ ilSelectItem(document.querySelector('.shape-item')); }"); settle(150)
    tap("#ilAlignBlock [data-align=center]"); settle(150)
    check('single object aligns to the page centre', abs(pos(0)['l'] + pos(0)['w'] / 2 - 600) < 1)
    ev("()=>{ ilDeselectAll(); }")
    check('alignment disabled when nothing is selected', ev("document.querySelector('#ilAlignBlock [data-align=left]').disabled"))

    print('8. Save, reload, export keep it all')
    ev("()=>{ const s=document.querySelectorAll('.shape-item'); s.forEach(e=>e.remove()); }")
    ev("""()=>{ const s=ilCreateShapeItem({kind:'heart',x:700,y:560,w:220,h:200,fill:'#ff3366',stroke:'#003366',strokeW:12,fillOn:true,strokeOn:true,rotate:30,opacity:0.8}); }"""); settle(150)
    ev("()=>{ const o=document.querySelector('.collage-item').__collage.model; o.scaleMode='fixed'; o.slots[0].tilePx=77; o.slots[0].patX=12; o.slots[0].patY=-8; document.querySelector('.collage-item').__collage.editor.refresh(); }"); settle(200)
    before_ser = ev("JSON.parse(JSON.stringify(ilSerializeLookbook()))")
    ev("window.__lbApp.saveNow()"); settle(800)
    pg.reload(wait_until='domcontentloaded'); settle(1200)
    pg.click('.lb-card-open'); settle(1800)
    after_ser = ev("JSON.parse(JSON.stringify(ilSerializeLookbook()))")
    shp = [i for i in after_ser['pages'][0]['items'] if i['type'] == 'shape']
    check('shape survives reload with fill / outline / width / rotation / opacity', len(shp) == 1 and shp[0]['kind'] == 'heart' and shp[0]['fill'] == '#ff3366' and shp[0]['stroke'] == '#003366' and shp[0]['strokeW'] == 12 and shp[0]['strokeOn'] is True and str(shp[0]['rotate']) == '30' and shp[0]['opacity'] == '0.8', shp)
    txt = [i for i in after_ser['pages'][0]['items'] if i['type'] == 'text']
    txt0 = [i for i in before_ser['pages'][0]['items'] if i['type'] == 'text']
    check('text colour + opacity survive reload', txt and txt0 and txt[0]['color'] == txt0[0]['color'] and txt[0]['opacity'] == txt0[0]['opacity'], (txt, txt0))
    colm = [i for i in after_ser['pages'][0]['items'] if i['type'] == 'collage'][0]['model']
    check('collage resize mode + pattern position survive reload', colm['scaleMode'] == 'fixed' and colm['slots'][0]['tilePx'] == 77 and colm['slots'][0]['patX'] == 12 and colm['slots'][0]['patY'] == -8, (colm['scaleMode'], colm['slots'][0].get('tilePx')))
    check('whole page identical before and after the round trip', json.dumps(before_ser['pages'][0]['items'], sort_keys=True) == json.dumps(after_ser['pages'][0]['items'], sort_keys=True))
    px = raster_px(810, 660)
    check('after reload the export still paints the shape (#ff3366 at 80% over white)', near(px, [255, 92, 133], 14), px)
    old = ev("ilActiveCanvas().querySelectorAll('.canvas-item').length")
    check('everything still on the page after reopening', old >= 3)

    print('Console')
    check('no page errors during the whole run', not errs, errs)

    b.close()
print()
print('%d passed, %d failed' % (passes, len(fails)))
if fails: print('FAILED:', fails); sys.exit(1)
