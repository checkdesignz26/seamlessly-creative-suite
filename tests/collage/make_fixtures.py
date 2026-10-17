"""Generates small, recognisable test images (different aspect ratios) for the collage tests."""
import sys, os
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
specs = [("land", (1600, 900), (220, 80, 80)), ("port", (900, 1400), (60, 140, 220)),
         ("sq", (1000, 1000), (80, 180, 100)), ("wide", (2000, 700), (230, 170, 40)),
         ("tall", (700, 1800), (160, 90, 200))]
for name, size, col in specs:
    im = Image.new("RGB", size, col); d = ImageDraw.Draw(im)
    d.rectangle([20, 20, size[0]-20, size[1]-20], outline=(255, 255, 255), width=14)
    d.line([0, 0, size[0], size[1]], fill=(255, 255, 255), width=10)   # diagonal exposes any distortion
    im.save(os.path.join(out, name + ".png"))
# a small seamless-ish pattern tile
t = Image.new("RGB", (240, 240), (250, 240, 225)); d = ImageDraw.Draw(t)
d.ellipse([40, 40, 200, 200], fill=(200, 60, 90)); d.ellipse([90, 90, 150, 150], fill=(255, 220, 120))
t.save(os.path.join(out, "pattern.png"))
print("fixtures ok")
