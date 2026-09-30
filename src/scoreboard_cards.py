#!/usr/bin/env python3
"""End-of-game scoreboard cards (1280x720), rendered with Pillow.

Usage: scoreboard_cards.py <compare|boxscore> <out.png> '<json>' [logo.png]

  compare   team-vs-team card: neon team names, rosters, labelled stat bars
  boxscore  full per-player table with game-high values picked out in gold

Everything is drawn at 2x and downsampled, so edges and glows stay clean at 720p.
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from card_logos import paste_logo

S = 2                      # supersampling factor
W, H = 1280, 720

F_COND = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
F_DIN  = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'
FALLBACK = ['/System/Library/Fonts/HelveticaNeue.ttc', '/System/Library/Fonts/Helvetica.ttc']

RED, BLUE   = (232, 56, 62), (52, 140, 255)
RED_L, BLUE_L = (255, 120, 120), (130, 190, 255)
WHITE = (240, 243, 250)
DIM   = (146, 154, 172)
FAINT = (92, 100, 118)
GOLD  = (240, 196, 84)
PANEL = (24, 28, 37)
PANEL_HI = (31, 36, 47)
LINE  = (52, 59, 75)
BG0, BG1 = (13, 15, 21), (22, 26, 35)


def font(size, kind='din'):
    for p in ([F_COND] if kind == 'cond' else [F_DIN]) + [F_DIN, F_COND] + FALLBACK:
        try:
            return ImageFont.truetype(p, int(size * S))
        except Exception:
            pass
    return ImageFont.load_default()


def sc(*v):
    return tuple(int(round(x * S)) for x in v)


def tsize(d, text, f):
    bb = d.textbbox((0, 0), text, font=f)
    return bb[2] - bb[0], bb[3] - bb[1], bb


def text(d, s, f, fill, x, y, anchor='mm'):
    """Draw text positioned by its visual box. x, y are in 720p units."""
    w, h, bb = tsize(d, s, f)
    X, Y = x * S, y * S
    ax = {'l': 0, 'm': w / 2, 'r': w}[anchor[0]]
    ay = {'t': 0, 'm': h / 2, 'b': h}[anchor[1]]
    d.text((X - ax - bb[0], Y - ay - bb[1]), s, font=f, fill=fill)
    return w / S


def fit(d, s, kind, max_w, sizes):
    for sz in sizes:
        f = font(sz, kind)
        if tsize(d, s, f)[0] <= max_w * S:
            return f
    return font(sizes[-1], kind)


def fmt_time(sec):
    sec = int(round(sec or 0))
    return f'{sec // 60}:{sec % 60:02d}'


def layer():
    return Image.new('RGBA', (W * S, H * S), (0, 0, 0, 0))


def glow_rect(img, box, color, radius, blur, alpha=150, width=None):
    """Soft glow behind a rounded rect (filled or, with width, just its outline)."""
    g = layer()
    gd = ImageDraw.Draw(g)
    if width:
        gd.rounded_rectangle(sc(*box), radius=radius * S, outline=(*color, alpha), width=int(width * S))
    else:
        gd.rounded_rectangle(sc(*box), radius=radius * S, fill=(*color, alpha))
    img.alpha_composite(g.filter(ImageFilter.GaussianBlur(blur * S)))


def background():
    img = Image.new('RGBA', (W * S, H * S), (*BG0, 255))
    px = ImageDraw.Draw(img)
    for y in range(H * S):                      # vertical gradient
        t = y / (H * S)
        c = tuple(int(BG1[i] + (BG0[i] - BG1[i]) * abs(t - 0.35) * 1.4) for i in range(3))
        px.line([(0, y), (W * S, y)], fill=(*[max(0, min(255, v)) for v in c], 255))
    # arena lights: soft flares low on both flanks, and a faint team wash
    fl = layer()
    fd = ImageDraw.Draw(fl)
    fd.ellipse(sc(-160, 60, 150, 330), fill=(210, 220, 255, 46))
    fd.ellipse(sc(W - 150, 60, W + 160, 330), fill=(210, 220, 255, 46))
    fd.ellipse(sc(-260, 300, 260, 760), fill=(*RED, 30))
    fd.ellipse(sc(W - 260, 300, W + 260, 760), fill=(*BLUE, 30))
    img.alpha_composite(fl.filter(ImageFilter.GaussianBlur(70 * S)))
    # vignette
    vg = Image.new('L', (W * S, H * S), 0)
    ImageDraw.Draw(vg).ellipse(sc(-260, -220, W + 260, H + 220), fill=255)
    vg = vg.filter(ImageFilter.GaussianBlur(120 * S))
    dark = Image.new('RGBA', (W * S, H * S), (0, 0, 0, 150))
    dark.putalpha(Image.eval(vg, lambda v: int((255 - v) * 0.62)))
    img.alpha_composite(dark)
    return img


def side_rails(img, x_left, x_right):
    for x, col in ((x_left, RED), (x_right, BLUE)):
        glow_rect(img, (x - 1, 0, x + 1, H), col, 0, 9, alpha=200)
        ImageDraw.Draw(img).rectangle(sc(x - 1, 0, x + 1, H), fill=(*col, 255))


def panel(img, box, radius=8, fill=PANEL, outline=LINE, alpha=235):
    p = layer()
    ImageDraw.Draw(p).rounded_rectangle(sc(*box), radius=radius * S, fill=(*fill, alpha),
                                        outline=(*outline, 255), width=max(1, S))
    img.alpha_composite(p)


def glass(img, box, color, radius=9):
    """Team-coloured glass panel: gradient fill, gloss sweep, lit edge."""
    x0, y0, x1, y1 = box
    glow_rect(img, (x0 - 2, y0 - 2, x1 + 2, y1 + 2), color, radius, 12, alpha=120)
    mask = Image.new('L', (W * S, H * S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(sc(*box), radius=radius * S, fill=255)
    g = layer()
    gd = ImageDraw.Draw(g)
    for y in range(int(y0 * S), int(y1 * S)):
        t = (y - y0 * S) / max(1, (y1 - y0) * S)
        k = 0.62 - 0.42 * t                       # brighter at the top
        gd.line([(x0 * S, y), (x1 * S, y)], fill=(*[int(c * k) for c in color], 255))
    gloss = layer()
    wdt = x1 - x0
    ImageDraw.Draw(gloss).polygon(sc(x0 + wdt * 0.42, y0, x0 + wdt * 0.78, y0, x0 + wdt * 0.30, y1, x0 - wdt * 0.06, y1),
                                  fill=(255, 255, 255, 26))
    g.alpha_composite(gloss)
    g.putalpha(Image.composite(g.getchannel('A'), Image.new('L', g.size, 0), mask))
    img.alpha_composite(g)
    light = tuple(min(255, int(c * 1.15 + 40)) for c in color)
    ImageDraw.Draw(img).rounded_rectangle(sc(*box), radius=radius * S, outline=(*light, 230), width=max(1, int(1.5 * S)))


def neon(img, s, f, color, light, x, y, stroke=2.2, blur=11):
    """Outline-only text with a coloured glow, centred on (x, y)."""
    d = ImageDraw.Draw(img)
    w, h, bb = tsize(d, s, f)
    pos = (x * S - w / 2 - bb[0], y * S - h / 2 - bb[1])
    ring = Image.new('L', (W * S, H * S), 0)
    rd = ImageDraw.Draw(ring)
    sw = max(1, int(round(stroke * S)))
    rd.text(pos, s, font=f, fill=255, stroke_width=sw, stroke_fill=255)
    rd.text(pos, s, font=f, fill=0)               # carve the glyph out, leaving the outline
    for b, a in ((blur * 1.8, 0.75), (blur * 0.7, 1.0)):
        g = Image.new('RGBA', (W * S, H * S), (*color, 0))
        g.putalpha(Image.eval(ring.filter(ImageFilter.GaussianBlur(b * S)), lambda v, a=a: min(255, int(v * 1.9 * a))))
        img.alpha_composite(g)
    line = Image.new('RGBA', (W * S, H * S), (*light, 0))
    line.putalpha(ring)
    img.alpha_composite(line)


def score_header(img, D, cx=W // 2, y=56, w=420, h=62):
    """'FINAL / OT' tab over the score pill, with red and blue bracket glows."""
    d = ImageDraw.Draw(img)
    red, blue = D['red'], D['blue']
    x0, x1 = cx - w // 2, cx + w // 2
    # tab
    tab_w, tab_h = 190, 30
    tab = layer()
    ImageDraw.Draw(tab).polygon(sc(cx - tab_w / 2 - 12, y + 1, cx - tab_w / 2 + 2, y - tab_h, cx + tab_w / 2 - 2, y - tab_h,
                                   cx + tab_w / 2 + 12, y + 1), fill=(*PANEL_HI, 245), outline=(*LINE, 255))
    img.alpha_composite(tab)
    d = ImageDraw.Draw(img)
    text(d, 'FINAL / OT' if D.get('overtime') else 'FINAL', font(17), WHITE, cx, y - tab_h / 2 + 1)
    # pill
    glow_rect(img, (x0, y, x0 + 10, y + h), RED, 8, 10, alpha=230)
    glow_rect(img, (x1 - 10, y, x1, y + h), BLUE, 8, 10, alpha=230)
    panel(img, (x0, y, x1, y + h), radius=8, fill=(18, 21, 28), outline=(70, 78, 96), alpha=250)
    d = ImageDraw.Draw(img)
    for xa, xb, col in ((x0, x0 + 9, RED), (x1 - 9, x1, BLUE)):      # brackets
        d.rounded_rectangle(sc(xa, y, xb, y + h), radius=4 * S, fill=(*col, 255))
        inner = (xa + 5, xb + 4) if col == RED else (xa - 4, xb - 5)
        d.rectangle(sc(inner[0], y + 5, inner[1], y + h - 5), fill=(18, 21, 28, 255))
    cy = y + h / 2 + 1
    fs = font(46)
    sr, sb = str(red['score']), str(blue['score'])
    d.rounded_rectangle(sc(cx - 8, cy - 2, cx + 8, cy + 2.5), radius=1 * S, fill=WHITE)
    text(d, sr, fs, WHITE, cx - 22, cy, 'rm')
    text(d, sb, fs, WHITE, cx + 22, cy, 'lm')
    ft = fit(d, red['abbr'], 'din', 120, (40, 34, 28, 24))
    text(d, red['abbr'], ft, WHITE, x0 + 28 + 60, cy)
    ft = fit(d, blue['abbr'], 'din', 120, (40, 34, 28, 24))
    text(d, blue['abbr'], ft, WHITE, x1 - 28 - 60, cy)
    return y + h


def subtitle(D):
    bits = []
    if D.get('gameNumber'):
        bits.append(f"GAME {D['gameNumber']}")
    if D.get('mapName'):
        bits.append(D['mapName'].upper())
    if D.get('durationSec'):
        bits.append(fmt_time(D['durationSec']) + (' OT' if D.get('overtime') else ''))
    return bits


def dotted(d, bits, f, fill, x, y, gap=12, anchor='m', dot=FAINT, max_w=None):
    """Draw parts separated by small drawn dots (DIN Alternate has no middle-dot glyph).
    bits may be a list or a string containing the separator."""
    if isinstance(bits, str):
        bits = [b.strip() for b in bits.split('\u00b7') if b.strip()]
    ws = [tsize(d, b, f)[0] / S for b in bits]
    total = sum(ws) + (len(bits) - 1) * (gap * 2 + 4)
    x = {'l': x, 'm': x - total / 2, 'r': x - total}[anchor]
    for i, (b, w) in enumerate(zip(bits, ws)):
        text(d, b, f, fill, x, y, 'lm')
        x += w
        if i < len(bits) - 1:
            x += gap
            d.ellipse(sc(x, y - 2, x + 4, y + 2), fill=dot)
            x += 4 + gap
    return total


def footer(img, D, logo_path):
    d = ImageDraw.Draw(img)
    if logo_path:
        try:
            logo = Image.open(logo_path).convert('RGBA')
            lh = 26 * S
            logo = logo.resize((int(lh * logo.size[0] / logo.size[1]), lh), Image.LANCZOS)
            img.alpha_composite(logo, (W * S // 2 - logo.size[0] // 2, (H - 38) * S))
        except Exception:
            pass
    d = ImageDraw.Draw(img)
    if D.get('label'):
        dotted(d, D['label'].upper(), font(11), FAINT, 64, H - 25, gap=7, anchor='l', dot=(70, 77, 94))
    if D.get('source'):
        text(d, D['source'], font(11), FAINT, W - 64, H - 25, 'rm')


# ── Team comparison card ──────────────────────────────────────────────────────

STATS = [  # key, label, formatter, lower_is_better
    ('caps',    'CAPS',     str,      False),
    ('grabs',   'GRABS',    str,      False),
    ('hold',    'HOLD',     fmt_time, False),
    ('returns', 'RETURNS',  str,      False),
    ('tags',    'TAGS',     str,      False),
    ('prevent', 'PREVENT',  fmt_time, False),
    ('pups',    'POWERUPS', str,      False),
    ('pops',    'POPS',     str,      True),
]


def team_total(team, key):
    return sum((p.get(key) or 0) for p in team['players'])


def card_compare(D, logo):
    img = background()
    CX0, CX1 = 404, 876                       # centre column
    side_rails(img, 84, W - 84)
    col = layer()
    ImageDraw.Draw(col).rectangle(sc(CX0, 0, CX1, H), fill=(*PANEL, 205))
    img.alpha_composite(col)
    d = ImageDraw.Draw(img)
    d.rectangle(sc(CX0, 0, CX0 + 1, H), fill=LINE)
    d.rectangle(sc(CX1 - 1, 0, CX1, H), fill=LINE)

    bottom = score_header(img, D, w=CX1 - CX0 - 52)
    d = ImageDraw.Draw(img)
    dotted(d, subtitle(D), font(13), DIM, W // 2, bottom + 20)

    # flanks: neon team name, full name, roster
    for team, col_, light, cx in ((D['red'], RED, RED_L, (84 + CX0) // 2), (D['blue'], BLUE, BLUE_L, (CX1 + W - 84) // 2)):
        has_logo = paste_logo(img, team.get('logo'), cx * S, 104 * S, 148 * S)
        f = fit(ImageDraw.Draw(img), team['abbr'], 'din', 270, (84, 76, 68, 56) if has_logo else (104, 92, 80, 68, 56))
        neon(img, team['abbr'], f, col_, light, cx, 252 if has_logo else 232)
        d = ImageDraw.Draw(img)
        if team.get('name') and team['name'] != team['abbr']:
            text(d, team['name'].upper(), fit(d, team['name'].upper(), 'din', 280, (19, 17, 15)), DIM, cx,
                 316 if has_logo else 306)
        players = team['players'][:5]
        rh = 50 if len(players) <= 4 else 42
        top = 642 - rh * len(players) - 16
        glass(img, (cx - 132, top, cx + 132, 642), col_)
        d = ImageDraw.Draw(img)
        for i, p in enumerate(players):
            y = top + 8 + rh * i + rh / 2
            text(d, p['name'], fit(d, p['name'], 'din', 230, (30, 27, 24, 21)), WHITE, cx, y)
            if i:
                d.rectangle(sc(cx - 104, top + 8 + rh * i, cx + 104, top + 8 + rh * i + 0.6),
                            fill=tuple(int(c * 0.72 + 8) for c in col_))

    # stat rows
    y0, y1 = bottom + 50, 676
    rh = (y1 - y0) / len(STATS)
    half = 92                                  # max bar length either side of the centre
    for i, (key, label, fmt, lower) in enumerate(STATS):
        cy = y0 + rh * i + rh / 2
        rv, bv = team_total(D['red'], key), team_total(D['blue'], key)
        if i:
            d.rectangle(sc(CX0 + 34, y0 + rh * i, CX1 - 34, y0 + rh * i + 0.6), fill=(42, 48, 61))
        r_best = (rv < bv) if lower else (rv > bv)
        b_best = (bv < rv) if lower else (bv > rv)
        fv = font(34)
        text(d, fmt(rv), fv, WHITE if r_best or rv == bv else DIM, CX0 + 116, cy + 1, 'rm')
        text(d, fmt(bv), fv, WHITE if b_best or rv == bv else DIM, CX1 - 116, cy + 1, 'lm')
        text(d, label, font(12), DIM, W // 2, cy - 15)
        by = cy + 3
        d.rounded_rectangle(sc(W // 2 - half - 3, by, W // 2 + half + 3, by + 12), radius=3 * S, fill=(14, 16, 22, 255))
        m = max(rv, bv, 1)
        rl, bl = half * rv / m, half * bv / m
        if rl >= 1:
            d.rounded_rectangle(sc(W // 2 - 2 - rl, by + 1, W // 2 - 2, by + 11), radius=2 * S,
                                fill=RED if r_best or rv == bv else tuple(int(c * 0.55) for c in RED))
        if bl >= 1:
            d.rounded_rectangle(sc(W // 2 + 2, by + 1, W // 2 + 2 + bl, by + 11), radius=2 * S,
                                fill=BLUE if b_best or rv == bv else tuple(int(c * 0.55) for c in BLUE))

    footer(img, D, None)
    d = ImageDraw.Draw(img)
    return img


# ── Box score card ────────────────────────────────────────────────────────────

COLS = [  # key, header, formatter, width, lower_is_better, show bar
    ('caps',    'CAPS',    str,      70,  False, False),
    ('grabs',   'GRABS',   str,      78,  False, False),
    ('hold',    'HOLD',    fmt_time, 112, False, True),
    ('returns', 'RETURNS', str,      92,  False, False),
    ('tags',    'TAGS',    str,      70,  False, False),
    ('prevent', 'PREVENT', fmt_time, 112, False, True),
    ('pups',    'PUPS',    str,      70,  False, False),
    ('pops',    'POPS',    str,      70,  True,  False),
    ('score',   'SCORE',   str,      92,  False, False),
]


def card_boxscore(D, logo):
    img = background()
    L, R = 52, W - 52
    hx0, hx1 = W // 2 - 210, W // 2 + 210
    bottom = score_header(img, D, y=50, w=420)
    # flanking info boxes
    panel(img, (L, 50, hx0 - 16, 112), radius=8)
    panel(img, (hx1 + 16, 50, R, 112), radius=8)
    d = ImageDraw.Draw(img)
    text(d, 'MAP', font(12), DIM, L + 22, 81, 'lm')
    mp = D.get('mapName') or ''
    text(d, mp, fit(d, mp, 'din', hx0 - 16 - L - 90, (28, 24, 20)), WHITE, L + 66, 82, 'lm')
    right = (D.get('label') or D.get('source') or 'TagPro').upper()
    dotted(d, right, fit(d, right.replace('\u00b7', '    '), 'din', R - hx1 - 16 - 40, (19, 17, 15, 13)), WHITE,
           (hx1 + 16 + R) / 2, 82, gap=9, dot=DIM)
    bits = []
    if D.get('gameNumber'):
        bits.append(f"GAME {D['gameNumber']}")
    if D.get('durationSec'):
        bits.append(fmt_time(D['durationSec']) + (' OT' if D.get('overtime') else ''))
    dotted(d, bits, font(13), DIM, W // 2, bottom + 18)

    # geometry
    TEAM_W, NAME_W, GAP = 96, 214, 8
    gx0 = L + TEAM_W + GAP + NAME_W + GAP          # stats grid left edge
    total_w = sum(c[3] for c in COLS)
    scale = (R - gx0) / total_w
    widths = [c[3] * scale for c in COLS]
    xs = [gx0 + sum(widths[:i]) for i in range(len(COLS))]

    head_y = 158
    text(d, 'TEAM', font(13), DIM, L + TEAM_W / 2, head_y)
    text(d, 'PLAYER', font(13), DIM, L + TEAM_W + GAP + NAME_W / 2, head_y)
    for (key, hdr, *_), x, w in zip(COLS, xs, widths):
        text(d, hdr, font(13), DIM, x + w / 2, head_y)

    allp = D['red']['players'] + D['blue']['players']
    best = {}
    for key, _, _, _, lower, _ in COLS:
        vals = [p.get(key) or 0 for p in allp]
        best[key] = (min(vals) if lower else max(vals)) if vals else None
    peak = {k: max([p.get(k) or 0 for p in allp] + [1]) for k in ('hold', 'prevent')}

    top, bot = 176, 664
    block_h = (bot - top - 12) / 2
    for bi, (team, col_) in enumerate(((D['red'], RED), (D['blue'], BLUE))):
        y0 = top + bi * (block_h + 12)
        y1 = y0 + block_h
        players = team['players'][:5]
        rh = block_h / max(4, len(players))
        glass(img, (L, y0, L + TEAM_W, y1), col_)
        glass(img, (L + TEAM_W + GAP, y0, L + TEAM_W + GAP + NAME_W, y1), col_)
        panel(img, (gx0, y0, R, y1), radius=8, fill=(18, 21, 28), alpha=240)
        d = ImageDraw.Draw(img)
        mid = (y0 + y1) / 2
        has_logo = paste_logo(img, team.get('logo'), (L + TEAM_W / 2) * S, (mid - 50) * S, 74 * S)
        d = ImageDraw.Draw(img)
        ty = mid + 22 if has_logo else mid - 8
        text(d, team['abbr'], fit(d, team['abbr'], 'din', TEAM_W - 14, (30, 26, 22, 18)), WHITE, L + TEAM_W / 2, ty)
        text(d, str(team['score']), font(24), tuple(min(255, c + 90) for c in col_), L + TEAM_W / 2, ty + 30)
        zebra = layer()                                                 # blended, not overwritten
        zd = ImageDraw.Draw(zebra)
        for i in range(len(players)):
            if i % 2 == 1:
                zd.rectangle(sc(gx0 + 2, y0 + rh * i, R - 2, y0 + rh * (i + 1)), fill=(255, 255, 255, 11))
        img.alpha_composite(zebra)
        d = ImageDraw.Draw(img)
        for i in range(1, len(COLS)):                                   # column rules
            d.rectangle(sc(xs[i], y0 + 8, xs[i] + 0.6, y1 - 8), fill=(38, 44, 56))
        for i, p in enumerate(players):
            ry = y0 + rh * i
            cy = ry + rh / 2
            if i:
                d.rectangle(sc(L + TEAM_W + GAP + 22, ry, L + TEAM_W + GAP + NAME_W - 22, ry + 0.6),
                            fill=tuple(int(c * 0.72 + 8) for c in col_))
                d.rectangle(sc(gx0 + 10, ry, R - 10, ry + 0.6), fill=(36, 41, 53))
            nx = L + TEAM_W + GAP + NAME_W / 2
            text(d, p['name'], fit(d, p['name'], 'din', NAME_W - 30, (28, 25, 22, 19)), WHITE, nx, cy)
            for (key, _, fmt, _, lower, bar), x, w in zip(COLS, xs, widths):
                v = p.get(key) or 0
                is_best = best[key] is not None and v == best[key] and (lower or v > 0)
                vy = cy - (5 if bar else 0)
                text(d, fmt(v), font(27), GOLD if is_best else WHITE, x + w / 2, vy + 1)
                if bar:
                    bw = w - 34
                    bx = x + 17
                    d.rounded_rectangle(sc(bx, cy + 15, bx + bw, cy + 20), radius=2 * S, fill=(12, 14, 19, 255))
                    fl = bw * v / peak[key]
                    if fl >= 1:
                        d.rounded_rectangle(sc(bx, cy + 15, bx + fl, cy + 20), radius=2 * S, fill=col_)

    text(d, 'GOLD = BEST IN GAME', font(11), GOLD, R - 4, head_y - 22, 'rm')
    footer(img, D, logo)
    return img


def main():
    mode, out, data = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    logo = sys.argv[4] if len(sys.argv) > 4 else None
    img = {'compare': card_compare, 'boxscore': card_boxscore}[mode](data, logo)
    img = img.convert('RGB').resize((W, H), Image.LANCZOS)
    img.save(out)


if __name__ == '__main__':
    main()
