"""
Live-vs-export parity: build one collage that uses every feature (every mask, border, shadow, zoom/pan,
fit modes, seamless pattern cell, rotation, decorations, background), render it as the live DOM and as
the exported canvas at the same size, and diff the pixels.

  python3 tests/collage/parity_visual.py http://localhost:8765 /tmp/fx /tmp/out
"""
import sys, os, base64, io, json
from playwright.sync_api import sync_playwright
from PIL import Image, ImageChops, ImageStat
BASE, FX, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(OUT, exist_ok=True)
def b64(n): return 'data:image/png;base64,' + base64.b64encode(open(os.path.join(FX, n + '.png'), 'rb').read()).decode()

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1500, 'height': 1000})
    pg.on('dialog', lambda d: d.accept())
    pg.goto(BASE + '/studios/mockup/index.html', wait_until='domcontentloaded'); pg.wait_for_timeout(1000)
    pg.evaluate("()=>{ document.getElementById('interactiveLookbookOverlay').classList.remove('hidden'); ilAddPage(); ilSetZoom(1); }")
    pg.wait_for_timeout(300)
    srcs = {k: b64(k) for k in ['land', 'port', 'sq', 'wide', 'tall', 'pattern']}
    ok = pg.evaluate("""async(srcs)=>{
      const SC=ScCollage; const m=SC.create(); m.bg={type:'solid',color:'#f4efe6'}; m.radius=14;
      const add=(k,extra)=>{ const s=SC.addSlot(m,{src:srcs[k],ar:1,kind:k==='pattern'?'pattern':'image',name:k}); Object.assign(s,extra); return s; };
      SC.setFree(m,1000,700); m.mode='free';
      const defs=[['land',{mask:'rect',shadow:50,rot:0,free:{x:3,y:4,w:40,h:34,rot:-4}}],
                  ['port',{mask:'ellipse',border:{w:2.5,color:'#ffffff'},free:{x:46,y:3,w:24,h:42,rot:3}}],
                  ['sq',{mask:'heart',border:{w:3,color:'#ffffff'},shadow:40,free:{x:72,y:5,w:25,h:36,rot:0}}],
                  ['wide',{mask:'hexagon',zoom:1.5,offX:6,offY:-3,free:{x:4,y:44,w:36,h:30,rot:5}}],
                  ['tall',{mask:'arch',fit:'contain',free:{x:44,y:50,w:20,h:44,rot:0}}],
                  ['pattern',{mask:'diamond',tile:30,border:{w:2,color:'#c33'},shadow:30,free:{x:68,y:48,w:28,h:42,rot:-6}}]];
      for (const [k,e] of defs){ const s=add(k,e); s.free=e.free; s.freeEdited=true; delete e.free; }
      for (const [i,s] of m.slots.entries()){ const im=await ilLoadImage(s.src); s.ar=im.naturalWidth/im.naturalHeight; s.z=i+1; }
      m.nextZ=20;
      const d1=SC.addDecor(m,'tape'); d1.x=30; d1.y=36; const d2=SC.addDecor(m,'star'); d2.x=60; d2.y=42; d2.w=10; d2.h=14; d2.shadow=40;
      const d3=SC.addDecor(m,'ring'); d3.x=84; d3.y=70; const d4=SC.addDecor(m,'heart'); d4.x=2; d4.y=82; d4.w=8; d4.h=11;
      const ctl=ilCreateCollageItem({model:m,x:100,y:75,w:1000,h:700}); ilDeselectAll(); ctl.editor.refresh(); window.__m=m; return true }""", srcs)
    pg.wait_for_timeout(600)
    # live render (editor chrome is off when not editing; the dashed selection outline is item chrome, not collage content)
    host = pg.locator('.collage-item .collage-host')
    host.screenshot(path=OUT + '/parity_live.png')
    url = pg.evaluate("""async()=>{ const c=document.createElement('canvas'); c.width=1000; c.height=700; const x=c.getContext('2d');
        await ScCollage.drawCanvas(x, window.__m, 1000, 700, ilLoadImage); return c.toDataURL('image/png') }""")
    open(OUT + '/parity_export.png', 'wb').write(base64.b64decode(url.split(',')[1]))
    live = Image.open(OUT + '/parity_live.png').convert('RGB')
    exp = Image.open(OUT + '/parity_export.png').convert('RGBA')
    bg = Image.new('RGBA', exp.size, (255, 255, 255, 255)); bg.alpha_composite(exp); exp = bg.convert('RGB')
    # live view has a white page under it; the export has the collage bg only -> same here since bg is solid
    live = live.resize(exp.size)
    diff = ImageChops.difference(live, exp)
    mean = sum(ImageStat.Stat(diff).mean) / 3
    px_bad = sum(1 for v in diff.convert('L').getdata() if v > 48) / (exp.size[0] * exp.size[1])
    diff.point(lambda v: min(255, v * 4)).save(OUT + '/parity_diff.png')
    side = Image.new('RGB', (2000, 700)); side.paste(live, (0, 0)); side.paste(exp, (1000, 0)); side.save(OUT + '/parity_side_by_side.png')
    print(f'mean abs diff per channel: {mean:.2f}/255 ; pixels differing >48: {px_bad*100:.2f}%')
    b.close()
    sys.exit(0 if (mean < 4 and px_bad < 0.02) else 1)
