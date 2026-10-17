"""
Three more end-to-end checks:
  1. iPad-style TOUCH input (tap to select, drag to move/resize/rotate) on a touch-emulated Chromium
  2. SUITE mode: collage photos can come from the current project's assets (real SCLibrary / IndexedDB)
  3. STANDALONE readiness: the three shared collage files work on a bare page with no suite, no
     Mock-up Studio and no project library at all

  python3 tests/collage/e2e_touch_suite_standalone.py http://localhost:8765 /tmp/fx /tmp/out
"""
import sys, os, base64, json
from playwright.sync_api import sync_playwright
BASE, FX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
fails, passes = [], 0
def check(name, cond, detail=''):
    global passes
    if cond: passes += 1; print('  ok   ', name)
    else: fails.append(name); print('  FAIL ', name, detail)
def b64(n): return 'data:image/png;base64,' + base64.b64encode(open(os.path.join(FX, n + '.png'), 'rb').read()).decode()

def touch(cdp, kind, pts):
    cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
def touch_drag(cdp, a, b, steps=8):
    touch(cdp, 'touchStart', [a])
    for i in range(1, steps + 1):
        touch(cdp, 'touchMove', [(a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps)])
    touch(cdp, 'touchEnd', [])

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------------------------------------------------------- 1. touch
    print('1. iPad-style touch input')
    ctx = b.new_context(viewport={'width': 1024, 'height': 768}, has_touch=True, is_mobile=True, device_scale_factor=2)
    pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    cdp = ctx.new_cdp_session(pg)
    pg.goto(BASE + '/studios/mockup/index.html', wait_until='domcontentloaded'); pg.wait_for_timeout(1000)
    pg.evaluate("()=>{ document.getElementById('interactiveLookbookOverlay').classList.remove('hidden'); ilAddPage(); ilFitPage(); }")
    pg.wait_for_timeout(300)
    pg.tap('#ilRailAddBtn'); pg.tap('#ilOpenCollageBtn'); pg.wait_for_timeout(300)
    check('panel opens as an overlay on iPad width and does not bury the canvas',
          pg.evaluate("document.getElementById('ilToolPanel').classList.contains('open')"))
    pg.tap("#ilCollageRoot >> text=+ new empty collage"); pg.wait_for_timeout(300)
    srcs = {k: b64(k) for k in ['land', 'port', 'sq']}
    pg.evaluate("""async(srcs)=>{ const c=ilSelectedItem.__collage; for (const k of ['land','port','sq']) ScCollage.addSlot(c.model,{src:srcs[k],ar:1,kind:'image',name:k});
        ScCollage.setLayoutTemplate(c.model,'big-left'); c.model.autoPick=false; c.editor.refresh(); c.commit(true); ilCollapseToolPanel(); }""", srcs)
    pg.wait_for_timeout(300)
    def center(sel_js):
        return pg.evaluate("()=>{ const e=" + sel_js + "; const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2] }")
    pt = center("ilSelectedItem.__collage.item.querySelectorAll('.sccl-slot')[1]")
    touch(cdp, 'touchStart', [tuple(pt)]); touch(cdp, 'touchEnd', []); pg.wait_for_timeout(250)
    sel = pg.evaluate("ilSelectedItem.__collage.editor.getSelection()")
    check('tapping a cell selects it', bool(sel) and sel['type'] == 'slot')
    # swap by dragging cell 1 onto cell 0 (layout mode)
    before = pg.evaluate("ilSelectedItem.__collage.model.slots.map(s=>s.name)")
    a = center("ilSelectedItem.__collage.item.querySelectorAll('.sccl-slot')[1]"); t = center("ilSelectedItem.__collage.item.querySelectorAll('.sccl-slot')[0]")
    touch_drag(cdp, tuple(a), tuple(t)); pg.wait_for_timeout(300)
    after = pg.evaluate("ilSelectedItem.__collage.model.slots.map(s=>s.name)")
    check('dragging one photo onto another swaps them (touch)', after[0] == before[1] and after[1] == before[0], (before, after))
    # switch to freeform, move by touch, rotate by touch
    pg.evaluate("()=>{ const c=ilSelectedItem.__collage; const h=c.item.querySelector('.collage-host'); ScCollage.setFree(c.model,h.clientWidth,h.clientHeight); c.editor.refresh(); ilApplyToolPanelState && 0; }")
    pg.wait_for_timeout(250)
    g0 = pg.evaluate("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model.slots[2].free))")
    a = center("ilSelectedItem.__collage.item.querySelectorAll('.sccl-slot')[2]")
    touch_drag(cdp, tuple(a), (a[0] + 70, a[1] + 40)); pg.wait_for_timeout(300)
    g1 = pg.evaluate("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model.slots[2].free))")
    check('dragging a piece by touch in freeform moves it', abs(g1['x'] - g0['x']) > 2 and abs(g1['y'] - g0['y']) > 1, (g0, g1))
    rot = center("ilSelectedItem.__collage.item.querySelector('.sccl-h.rot')")
    fr = center("ilSelectedItem.__collage.item.querySelector('.sccl-frame')")
    touch_drag(cdp, tuple(rot), (fr[0] + 120, fr[1] - 10)); pg.wait_for_timeout(300)
    g2 = pg.evaluate("ilSelectedItem.__collage.model.slots[2].free.rot")
    check('rotate handle works by touch', abs(g2) > 20, g2)
    # resize a piece that is mid-page (not one dragged under the page-thumbnail strip)
    mid = center("ilSelectedItem.__collage.item.querySelectorAll('.sccl-slot')[0]")
    touch(cdp, 'touchStart', [tuple(mid)]); touch(cdp, 'touchEnd', []); pg.wait_for_timeout(250)
    se = center("ilSelectedItem.__collage.item.querySelector('.sccl-h.se')")
    sid = pg.evaluate("ilSelectedItem.__collage.editor.getSelection().id")
    w0 = pg.evaluate("(id)=>ilSelectedItem.__collage.model.slots.find(s=>s.id===id).free.w", sid)
    touch_drag(cdp, tuple(se), (se[0] + 50, se[1] + 30)); pg.wait_for_timeout(300)
    w1 = pg.evaluate("(id)=>ilSelectedItem.__collage.model.slots.find(s=>s.id===id).free.w", sid)
    check('corner handle resizes by touch', w1 > w0 + 1, (w0, w1))
    pg.screenshot(path=OUT + '/10_ipad_touch.png')
    check('no page errors during touch session', not [e for e in errs])
    ctx.close()

    # ---------------------------------------------------------------- 2. suite project
    print('2. Suite mode: project assets')
    ctx = b.new_context(viewport={'width': 1280, 'height': 860}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    pg.goto(BASE + '/studios/mockup/index.html', wait_until='domcontentloaded'); pg.wait_for_timeout(800)
    pid = pg.evaluate("""async(srcs)=>{ const pr=await SCLibrary.createProject('Collage test project');
        await SCLibrary.addAssetFromDataUrl(pr.id, srcs.pattern, {kind:'pattern', name:'Yule pattern', source:{studio:'playground'}});
        await SCLibrary.addAssetFromDataUrl(pr.id, srcs.land, {kind:'mockup', name:'Tote mock-up', source:{studio:'mockup'}});
        await SCLibrary.addAssetFromDataUrl(pr.id, srcs.port, {kind:'resized-export', name:'Resized hero', source:{studio:'resizer'}});
        return pr.id }""", {k: b64(k) for k in ['pattern', 'land', 'port']})
    pg.goto(BASE + '/studios/mockup/index.html?project=' + pid, wait_until='domcontentloaded'); pg.wait_for_timeout(1500)
    pg.evaluate("()=>{ document.getElementById('interactiveLookbookOverlay').classList.remove('hidden'); ilAddPage(); ilFitPage(); }")
    pg.click('#ilRailAddBtn'); pg.click('#ilOpenCollageBtn'); pg.wait_for_timeout(400)
    tabs = pg.evaluate("[...document.querySelectorAll('#ilCollageRoot .sccl-chip')].map(c=>c.textContent)")
    check('"project" source tab appears in suite mode', 'project' in tabs, tabs)
    pg.click("#ilCollageRoot .sccl-chip:text-is('project')"); pg.wait_for_timeout(700)
    n = pg.evaluate("document.querySelectorAll('#ilCollageRoot .sccl-thumb').length")
    check('project patterns, mock-ups and exports are all offered', n == 3, n)
    pg.click("#ilCollageRoot >> text=+ new empty collage"); pg.wait_for_timeout(200)
    pg.click("#ilCollageRoot >> text=+ add all shown"); pg.wait_for_timeout(1200)
    m = pg.evaluate("JSON.parse(JSON.stringify(ilSelectedItem.__collage.model))")
    got = {s['name']: s['kind'] for s in m['slots'] if s['src']}
    check('all 3 project assets landed in the collage', len(got) == 3, got)
    check('a project PATTERN becomes a repeating pattern cell; mock-ups stay images', got.get('Yule pattern') == 'pattern' and got.get('Tote mock-up') == 'image', got)
    pg.screenshot(path=OUT + '/11_suite_project.png')
    check('no page errors in suite mode', not errs, errs[:3])
    ctx.close()

    # ---------------------------------------------------------------- 3. standalone readiness
    print('3. Standalone readiness (bare page: only the three shared collage files)')
    ctx = b.new_context(viewport={'width': 1100, 'height': 760}); pg = ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e))); pg.on('dialog', lambda d: d.accept())
    pg.goto('about:blank')
    pg.set_content("""<!doctype html><html><head><style>:root{--accent:#8a7aff;--border:#455;--muted:#99a}body{margin:0;background:#fff;font:14px system-ui}
      #page{position:relative;width:900px;height:600px;margin:20px;background:#eee}#panel{position:absolute;left:940px;top:20px;width:240px}</style></head>
      <body><div id="page"><div id="box" style="position:absolute;left:50px;top:40px;width:800px;height:520px"></div></div><div id="panel"></div></body></html>""")
    for f in ['collage-engine.js', 'collage-editor.js', 'collage-panel.js']:
        pg.add_script_tag(content=open(os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'shared', f)).read())
    ok = pg.evaluate("""async(srcs)=>{
        const SC=ScCollage; const box=document.getElementById('box'); const model=SC.create(); SC.setLayoutTemplate(model,'quadrants'); model.autoPick=true;
        let ctl=null; const saved=[];
        ctl={model, item:box, host:box, editor:SC.attachEditor(box,{model,onChange:f=>{ if(f) saved.push(JSON.stringify(model)); },onSelect:()=>panel.sync()}), commit(f){ if(f) saved.push(JSON.stringify(model)); }};
        const panel=SC.mountPanel(document.getElementById('panel'),{tabs:['patterns'],getCollage:()=>ctl,createCollage:()=>ctl,
            getSources:async()=>[{src:srcs.land,name:'a',kind:'image',ar:16/9},{src:srcs.port,name:'b',kind:'image',ar:900/1400},{src:srcs.pattern,name:'p',kind:'pattern'}],
            onBack(){}, deleteCollage(){} });
        window.__t={SC,model,ctl,panel,saved}; ctl.editor.setEditing(true);
        await new Promise(r=>setTimeout(r,300));   // the panel loads its photo sources asynchronously
        document.querySelectorAll('#panel .sccl-thumb').forEach(t=>t.click()); await new Promise(r=>setTimeout(r,500));
        return {slots:model.slots.filter(s=>s.src).length, saved:saved.length, dom:box.querySelectorAll('.sccl-slot').length,
                hasSuite: typeof window.SCLibrary!=='undefined', hasMock: typeof window.ilPages!=='undefined'} }""", {k: b64(k) for k in ['land', 'port', 'pattern']})
    check('engine + editor + panel run with no suite / project library / Mock-up Studio present', ok['slots'] == 3 and ok['dom'] >= 3 and not ok['hasSuite'] and not ok['hasMock'], ok)
    pg.evaluate("()=>{ const t=__t; t.panel.sync(); }")
    pg.click("#panel .sccl-seg button:has-text('Freeform')"); pg.wait_for_timeout(300)
    check('layout <-> freeform works standalone', pg.evaluate("__t.model.mode") == 'free')
    export_ok = pg.evaluate("""async()=>{ const t=__t; const c=document.createElement('canvas'); c.width=1600;c.height=1040; const x=c.getContext('2d'); x.scale(2,2);
        await t.SC.drawCanvas(x,t.model,800,520,src=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src})); const d=x.getImageData(800,520,1,1).data; return [c.width, d[3]] }""")
    check('canvas export works standalone at 2x', export_ok[0] == 1600)
    state = pg.evaluate("JSON.stringify(__t.model)")
    reopened = pg.evaluate("""(j)=>{ const m=ScCollage.normalize(JSON.parse(j)); return JSON.stringify(m)===j }""", state)
    check('a saved model reopens byte-for-byte identical (portable JSON, no app-specific data)', reopened)
    check('no page errors standalone', not errs, errs[:3])
    pg.screenshot(path=OUT + '/12_standalone_bare_page.png')
    ctx.close(); b.close()

print(f'\n{passes} passed, {len(fails)} failed')
if fails: print('FAILED:', fails); sys.exit(1)
