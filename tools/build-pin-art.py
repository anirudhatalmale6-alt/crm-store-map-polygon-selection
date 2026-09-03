#!/usr/bin/env python3
"""Turn the customer's pin artwork into the inline table the map reads.

Run:  python3 tools/build-pin-art.py  <dir with Pin-*.png>  > ../pin-art.js

Three things happen here, and each one is a defect that would otherwise reach the
map:

1. A marker is a picture built by the page, and a picture cannot fetch a SECOND
   picture. The artwork therefore has to travel as its own bytes, inline. The
   originals are 1353x1868 and ~130 KB each; at the size a marker is actually drawn
   that is 40x more data than the screen can use, so they are resampled first.

2. Pin-Pura arrived as a JPEG (named .png). JPEG has no transparency, so the corners
   around the teardrop are WHITE, and a white box is exactly what the map would draw.
   The background is recovered by flood-filling white inward FROM THE BORDER rather
   than by "make white transparent": the white disc in the middle of the pin is
   enclosed by the blue body and is not reachable from the edge, so it survives. The
   naive version punches a hole straight through the logo.

3. The body colour is SAMPLED from the artwork rather than typed in by hand, so the
   round markers and the cluster rings are the same blue/grey/turquoise as the pins
   to the byte. A hex copied by eye is how the legend ends up not matching the map.
"""
import base64, io, os, sys
from collections import deque, Counter
from PIL import Image, ImageFilter

SRC = [('active', 'Pin-Pura'), ('potential', 'Pin-Potential'), ('inactive', 'Pin-Inactive')]
HEIGHT = 88          # 2x the ~44px a marker is drawn at, so it stays sharp on retina
WHITE = 232          # a pixel this bright on every channel counts as background


def find(dirname, stem):
    for ext in ('.png', '.jpg', '.jpeg', '.PNG', '.JPG'):
        p = os.path.join(dirname, stem + ext)
        if os.path.exists(p):
            return p
    raise SystemExit(f'missing artwork: {stem}.png in {dirname}')


def background_mask(im):
    """Pixels reachable from the border through white. See point 2 above."""
    w, h = im.size
    px = im.convert('RGB').load()
    bg = bytearray(w * h)
    q = deque()

    def push(x, y):
        r, g, b = px[x, y]
        if r > WHITE and g > WHITE and b > WHITE and not bg[y * w + x]:
            bg[y * w + x] = 1
            q.append((x, y))

    for x in range(w):
        push(x, 0); push(x, h - 1)
    for y in range(h):
        push(0, y); push(w - 1, y)
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                push(nx, ny)
    return bg


def load(path):
    im = Image.open(path)
    if im.mode in ('RGBA', 'LA') and im.getchannel('A').getextrema()[0] < 255:
        return im.convert('RGBA')          # already has a usable alpha channel
    im = im.convert('RGBA')
    w, h = im.size
    bg = background_mask(im)
    a = Image.frombytes('L', (w, h), bytes(0 if v else 255 for v in bg))
    im.putalpha(a.filter(ImageFilter.GaussianBlur(1.2)))   # soften the staircase
    return im


def body_colour(im):
    """The pin TIP is pure body colour in every one of these - no logo, no highlight."""
    w, h = im.size
    px = im.load()
    votes = Counter()
    for y in range(int(h * .80), int(h * .93)):
        for x in range(int(w * .42), int(w * .58)):
            r, g, b, al = px[x, y]
            if al > 200:
                votes[(r, g, b)] += 1
    (r, g, b), _ = votes.most_common(1)[0]
    return '#%02x%02x%02x' % (r, g, b)


def head_circle(im):
    """Where the round part of the teardrop is, as fractions of the image box.

    Every state the map used to show by RECOLOURING the pin - selected, imprecise,
    address-changed - cannot recolour a photograph. Those states have to be drawn as
    a ring instead, and a ring needs to know where the head is. Measuring it from the
    artwork beats hard-coding it: the day they send a differently-proportioned pin,
    the ring still lands on the head instead of across the point.

    The head is the widest part of the silhouette, so: take the opaque run on every
    row, and the widest row is the head's centre line.
    """
    a = im.getchannel('A').load()
    w, h = im.size
    best_y, best_run = 0, 0
    for y in range(h):
        run = sum(1 for x in range(w) if a[x, y] > 128)
        if run > best_run:
            best_run, best_y = run, y
    return {'cx': 0.5, 'cy': round(best_y / h, 4), 'r': round(best_run / 2 / w, 4)}


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else '.'
    rows = []
    for key, stem in SRC:
        im = load(find(d, stem))
        colour = body_colour(im)
        w = round(im.width * HEIGHT / im.height)
        sm = im.resize((w, HEIGHT), Image.LANCZOS)
        # Trim the transparent margin so the pin's POINT is the bottom edge of the
        # image. The marker is anchored to that edge, so a stray margin would hang
        # every pin a few pixels off its own coordinates.
        box = sm.getchannel('A').point(lambda p: 255 if p > 8 else 0).getbbox()
        sm = sm.crop(box)
        head = head_circle(sm)
        buf = io.BytesIO()
        sm.save(buf, 'PNG', optimize=True)
        uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()
        rows.append(f'  {key}: {{\n    color: {colour!r},\n'
                    f'    w: {sm.width}, h: {sm.height},\n'
                    f'    head: {{ cx: {head["cx"]}, cy: {head["cy"]}, r: {head["r"]} }},\n'
                    f'    art: "{uri}",\n  }},')
        print(f'{key:10s} {sm.size} {colour} head={head} {len(buf.getvalue()):6d} B',
              file=sys.stderr)
    print('/* Generated by tools/build-pin-art.py from the customer\'s own artwork.\n'
          '   Not in git: it is their branding, not mine to publish. */\n'
          'window.__PIN_ART__ = {\n' + '\n'.join(rows) + '\n};')


if __name__ == '__main__':
    main()
