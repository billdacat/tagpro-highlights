#!/usr/bin/env python3
"""Render 1280x720 title cards for a multi-game highlight reel.

Usage: series_cards.py <intro|game|final> <out.png> '<json>' [logo.png]

Visual language matches the in-game recap card in export-replay-clips.js:
dark navy background, DIN Condensed / DIN Alternate type, team-coloured accents.
"""
import json
import sys
from datetime import datetime

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from card_logos import paste_logo, readable

F_DISPLAY = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
F_UI      = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'
F_BODY    = '/System/Library/Fonts/Supplemental/Futura.ttc'

W, H = 1280, 720
BG   = (10, 10, 26)
CG   = (210, 175, 60)     # gold label
CW   = (230, 230, 240)    # white text
CD   = (120, 125, 150)    # dim text
CL   = (40, 40, 72)       # rule lines
CRED, CBLUE = (220, 65, 65), (65, 120, 245)


def load_font(size, role='body'):
    stacks = {
        'display': [F_DISPLAY, F_UI, '/System/Library/Fonts/Helvetica.ttc'],
        'ui':      [F_UI, F_DISPLAY, '/System/Library/Fonts/Helvetica.ttc'],
        'body':    [F_BODY, '/System/Library/Fonts/HelveticaNeue.ttc'],
    }
    for p in stacks.get(role, stacks['body']):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def hex_to_rgb(h, fallback):
    try:
        h = h.lstrip('#')
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except Exception:
        return fallback


def text_size(d, text, font):
    bb = d.textbbox((0, 0), text, font=font)
    return bb[2] - bb[0], bb[3] - bb[1], bb


def draw_centered(d, text, font, fill, cx, cy, **kw):
    w, h, bb = text_size(d, text, font)
    d.text((cx - w // 2 - bb[0], cy - h // 2 - bb[1]), text, font=font, fill=fill, **kw)


def fit_font(d, text, role, max_w, sizes):
    for sz in sizes:
        f = load_font(sz, role)
        if text_size(d, text, f)[0] <= max_w:
            return f
    return load_font(sizes[-1], role)


def background(home_c, away_c):
    img = Image.new('RGBA', (W, H), (*BG, 255))
    wash = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wash)
    wd.rectangle([(0, 0), (W // 2 + 80, H)], fill=(*home_c, 22))
    wd.rectangle([(W // 2 - 80, 0), (W, H)], fill=(*away_c, 22))
    wash = wash.filter(ImageFilter.GaussianBlur(radius=110))
    img = Image.alpha_composite(img, wash)
    d = ImageDraw.Draw(img)
    d.rectangle([(0, 0), (8, H)], fill=home_c)
    d.rectangle([(W - 8, 0), (W, H)], fill=away_c)
    return img


def draw_dotted(d, text, font, fill, cx, cy, gap=14, dot=3):
    """Draw `text` centred at (cx, cy); ' · ' separators become small drawn dots
    (DIN Alternate has no U+00B7 glyph)."""
    parts = [p.strip() for p in text.split('\u00b7')]
    parts = [p for p in parts if p]
    widths = [text_size(d, p, font)[0] for p in parts]
    total = sum(widths) + (len(parts) - 1) * (gap * 2 + dot * 2)
    x = cx - total // 2
    for i, (p, w) in enumerate(zip(parts, widths)):
        _, h, bb = text_size(d, p, font)
        d.text((x - bb[0], cy - h // 2 - bb[1]), p, font=font, fill=fill)
        x += w
        if i < len(parts) - 1:
            x += gap
            d.ellipse([x, cy - dot, x + dot * 2, cy + dot], fill=fill)
            x += dot * 2 + gap
    return total


def label_line(d, text, y):
    f = load_font(14, 'ui')
    cy = y + 10
    w = draw_dotted(d, text, f, CG, W // 2, cy)
    lx = W // 2 - w // 2
    d.rectangle([(40, cy - 1), (lx - 18, cy)], fill=CL)
    d.rectangle([(lx + w + 18, cy - 1), (W - 40, cy)], fill=CL)


def footer(img, d, logo_path, left_text=''):
    logo_h = 32
    logo_y = H - logo_h - 6
    cy = logo_y + logo_h // 2
    fa = load_font(11, 'body')
    if left_text:
        w, h, bb = text_size(d, left_text, fa)
        d.text((30, cy - h // 2 - bb[1]), left_text, font=fa, fill=CD)
    if logo_path:
        try:
            logo = Image.open(logo_path).convert('RGBA')
            lw = int(logo_h * logo.size[0] / logo.size[1])
            logo = logo.resize((lw, logo_h), Image.LANCZOS)
            img.alpha_composite(logo, (W // 2 - lw // 2, logo_y))
        except Exception:
            pass
    d = ImageDraw.Draw(img)
    attr = 'tagpro.koalabeast.com'
    w, h, bb = text_size(d, attr, fa)
    d.text((W - w - 30, cy - h // 2 - bb[1]), attr, font=fa, fill=(55, 55, 90))
    return d


def team_name(d, name, color, cx, cy, max_w, sizes=(64, 56, 48, 40, 34, 28)):
    f = fit_font(d, name.upper(), 'display', max_w, sizes)
    r, g, b = color
    stroke = (max(0, r - 140), max(0, g - 140), max(0, b - 140))
    draw_centered(d, name.upper(), f, color, cx + 2, cy + 2, stroke_width=2, stroke_fill=(0, 0, 0))
    draw_centered(d, name.upper(), f, color, cx, cy, stroke_width=2, stroke_fill=stroke)


def fmt_date(iso):
    if not iso:
        return ''
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
        return dt.strftime('%b %-d, %Y')
    except Exception:
        return ''


# ── Cards ─────────────────────────────────────────────────────────────────────

def card_intro(D, logo):
    home, away = D['home'], D['away']
    hc = readable(hex_to_rgb(home.get('colorHex'), CRED))
    ac = readable(hex_to_rgb(away.get('colorHex'), CBLUE))
    img = background(hc, ac)
    d = ImageDraw.Draw(img)

    label_line(d, D.get('label', 'HIGHLIGHTS').upper(), 42)

    # Team logos (when the matchup provides them) sit over the names.
    hx, ax = W // 4 + 10, 3 * W // 4 - 10
    has_h = paste_logo(img, home.get('logoPath'), hx, 196, 210)
    has_a = paste_logo(img, away.get('logoPath'), ax, 196, 210)
    d = ImageDraw.Draw(img)
    logos = has_h or has_a
    name_y = 356 if logos else 300

    fvs = load_font(60, 'display')
    draw_centered(d, 'VS', fvs, CD, W // 2, 196 if logos else 300)

    half = W // 2 - 120
    team_name(d, home['name'], hc, hx, name_y, half - 40, (60, 54, 48, 40, 34, 28))
    team_name(d, away['name'], ac, ax, name_y, half - 40, (60, 54, 48, 40, 34, 28))

    fab = load_font(20, 'ui')
    draw_centered(d, home.get('abbreviation', ''), fab, CD, hx, name_y + 54)
    draw_centered(d, away.get('abbreviation', ''), fab, CD, ax, name_y + 54)

    base = 500 if logos else 445
    fh = load_font(30, 'display')
    draw_centered(d, 'HIGHLIGHT  REEL', fh, CW, W // 2, base)
    sub = []
    if D.get('bestOf'):
        sub.append(f"BEST OF {D['bestOf']}")
    date = fmt_date(D.get('scheduledAt'))
    if date:
        sub.append(date.upper())
    if sub:
        draw_dotted(d, ' · '.join(sub), load_font(16, 'ui'), CD, W // 2, base + 42)

    d.rectangle([(W // 2 - 120, base + 80), (W // 2 + 120, base + 82)], fill=CL)
    footer(img, d, logo, D.get('footer', ''))
    return img


def card_game(D, logo):
    home, away = D['home'], D['away']
    # This card introduces one game, so the teams wear the colours they play in it:
    # names, side rails and wash are in-game red/blue.  That tells the viewer who is
    # who in the footage without a separate line of text.  If the colours are not
    # known, fall back to the teams' own colours.
    in_game = {'red': CRED, 'blue': CBLUE}
    colors = D.get('colors') or {}
    hc = in_game.get(colors.get('home')) or readable(hex_to_rgb(home.get('colorHex'), CRED))
    ac = in_game.get(colors.get('away')) or readable(hex_to_rgb(away.get('colorHex'), CBLUE))
    img = background(hc, ac)
    d = ImageDraw.Draw(img)
    dy = 30                                   # vertical centring of the whole block

    # Game number is the headline, so nobody mistakes which game the card introduces.
    n, total = D.get('gameNumber', 1), D.get('totalGames', 1)
    fg = load_font(104, 'display')
    draw_centered(d, f'GAME {n}', fg, CG, W // 2, 98 + dy)          # flat: no outline or shadow
    gw = text_size(d, f'GAME {n}', fg)[0]
    d.rectangle([(40, 97 + dy), (W // 2 - gw // 2 - 28, 98 + dy)], fill=CL)
    d.rectangle([(W // 2 + gw // 2 + 28, 97 + dy), (W - 40, 98 + dy)], fill=CL)
    draw_centered(d, f'OF  {total}', load_font(16, 'ui'), CD, W // 2, 166 + dy)

    # Map name
    map_name = (D.get('mapName') or 'TagPro').upper()
    fm = fit_font(d, map_name, 'display', W - 240, (118, 104, 90, 76, 62))
    draw_centered(d, map_name, fm, CW, W // 2, 280 + dy)             # flat, like the heading
    draw_centered(d, 'MAP', load_font(14, 'ui'), CD, W // 2, 356 + dy)

    # Series score ENTERING this game: results of earlier games only, never this one.
    ss = D.get('seriesScore') or [0, 0]
    fss = load_font(84, 'display')
    draw_centered(d, f'{ss[0]}  \u2013  {ss[1]}', fss, CW, W // 2, 470 + dy)
    series_label = 'SERIES' if n <= 1 else f'SERIES  AFTER  GAME  {n - 1}'
    draw_centered(d, series_label, load_font(14, 'ui'), CD, W // 2, 528 + dy)
    has_h = paste_logo(img, home.get('logoPath'), W // 4 - 20, 412 + dy, 92)
    has_a = paste_logo(img, away.get('logoPath'), 3 * W // 4 + 20, 412 + dy, 92)
    d = ImageDraw.Draw(img)
    ny = (494 if (has_h or has_a) else 470) + dy
    team_name(d, home['name'], hc, W // 4 - 20, ny, W // 2 - 220, (44, 40, 36, 32, 28, 24))
    team_name(d, away['name'], ac, 3 * W // 4 + 20, ny, W // 2 - 220, (44, 40, 36, 32, 28, 24))

    footer(img, d, logo, D.get('footer', ''))
    return img


def card_final(D, logo):
    home, away = D['home'], D['away']
    hc = readable(hex_to_rgb(home.get('colorHex'), CRED))
    ac = readable(hex_to_rgb(away.get('colorHex'), CBLUE))
    img = background(hc, ac)
    d = ImageDraw.Draw(img)

    label_line(d, 'SERIES  FINAL', 42)

    ss = D.get('seriesScore') or [0, 0]
    fss = load_font(120, 'display')
    draw_centered(d, f'{ss[0]}  –  {ss[1]}', fss, CW, W // 2, 172)     # flat: no outline or shadow

    has_h = paste_logo(img, home.get('logoPath'), W // 4 - 30, 122, 96)
    has_a = paste_logo(img, away.get('logoPath'), 3 * W // 4 + 30, 122, 96)
    d = ImageDraw.Draw(img)
    logos = has_h or has_a
    ny = 202 if logos else 172
    sizes = (40, 36, 32, 28, 24) if logos else (52, 46, 40, 34, 28)
    team_name(d, home['name'], hc, W // 4 - 30, ny, W // 2 - 260, sizes)
    team_name(d, away['name'], ac, 3 * W // 4 + 30, ny, W // 2 - 260, sizes)
    uy = ny + (32 if logos else 42)
    if ss[0] > ss[1]:
        d.rectangle([(W // 4 - 30 - 70, uy), (W // 4 - 30 + 70, uy + 3)], fill=hc)
    elif ss[1] > ss[0]:
        d.rectangle([(3 * W // 4 + 30 - 70, uy), (3 * W // 4 + 30 + 70, uy + 3)], fill=ac)

    d.rectangle([(200, 262), (W - 200, 263)], fill=CL)

    # Per-game result rows
    games = D.get('games') or []
    fg = load_font(15, 'ui')
    fmap = load_font(20, 'body')
    fsc = load_font(34, 'display')
    row_h = 54
    y0 = 288
    for i, g in enumerate(games[:6]):
        y = y0 + i * row_h
        bg = (14, 14, 34, 200) if i % 2 == 0 else (18, 18, 42, 200)
        d.rectangle([(200, y), (W - 200, y + row_h - 6)], fill=bg)
        cy = y + (row_h - 6) // 2
        w, h, bb = text_size(d, f"GAME {g.get('gameNumber', i + 1)}", fg)
        d.text((222, cy - h // 2 - bb[1]), f"GAME {g.get('gameNumber', i + 1)}", font=fg, fill=CG)
        mn = (g.get('mapName') or '')
        w, h, bb = text_size(d, mn, fmap)
        d.text((330, cy - h // 2 - bb[1]), mn, font=fmap, fill=CW)
        sc = g.get('score')
        if sc:
            hs, as_ = sc
            hcol = hc if hs > as_ else CD
            acol = ac if as_ > hs else CD
            ot = '  OT' if g.get('overtime') else ''
            w, h, bb = text_size(d, str(hs), fsc)
            d.text((W - 200 - 150 - w - bb[0], cy - h // 2 - bb[1]), str(hs), font=fsc, fill=hcol)
            draw_centered(d, '–', fsc, CD, W - 200 - 130, cy)
            w, h, bb = text_size(d, str(as_), fsc)
            d.text((W - 200 - 110 - bb[0], cy - h // 2 - bb[1]), str(as_), font=fsc, fill=acol)
            if ot:
                d.text((W - 200 - 60, cy - 8), 'OT', font=fg, fill=CD)
        else:
            w, h, bb = text_size(d, 'not played', fg)
            d.text((W - 200 - 150 - bb[0], cy - h // 2 - bb[1]), 'not played', font=fg, fill=CD)

    footer(img, d, logo, D.get('footer', ''))
    return img


# ── Lower-third caption badge (transparent, sized to its text) ────────────────
# Burned onto the first seconds of each clip: a small gold label (event type)
# over the clip description, with a team-coloured bar on the left.

def card_caption(D, logo=None):
    label = (D.get('label') or '').upper()
    text = D.get('text') or ''
    accent = {'red': CRED, 'blue': CBLUE}.get(D.get('team'), CG)
    fl, ft = load_font(13, 'ui'), load_font(30, 'display')
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    lw = text_size(probe, label.replace('\u00b7', '  '), fl)[0] + 12 if label else 0
    tw, th, tbb = text_size(probe, text, ft)
    bar, pad = 5, 16
    w = bar + pad + max(lw, tw) + pad
    h = 12 + (20 if label else 0) + th + 14
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=6, fill=(10, 10, 26, 215))
    d.rounded_rectangle([0, 0, bar + 6, h - 1], radius=6, fill=accent)
    d.rectangle([bar, 0, bar + 6, h - 1], fill=(10, 10, 26, 215))
    y = 12
    if label:
        parts = [p.strip() for p in label.split('\u00b7') if p.strip()]
        x = bar + pad
        for i, part in enumerate(parts):
            pw, ph, pbb = text_size(d, part, fl)
            d.text((x - pbb[0], y - pbb[1]), part, font=fl, fill=CG)
            x += pw
            if i < len(parts) - 1:
                x += 8
                d.ellipse([x, y + ph // 2 - 2, x + 4, y + ph // 2 + 2], fill=CG)
                x += 12
        y += 20
    d.text((bar + pad - tbb[0], y - tbb[1]), text, font=ft, fill=CW)
    return img


def main():
    mode, out, data = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
    logo = sys.argv[4] if len(sys.argv) > 4 else None
    fn = {'intro': card_intro, 'game': card_game, 'final': card_final, 'caption': card_caption}[mode]
    img = fn(data, logo)
    if mode == 'caption':
        img.save(out)                      # keep alpha for overlaying
    else:
        img.convert('RGB').save(out)


if __name__ == '__main__':
    main()
