#!/usr/bin/env python3
"""Generate all VGS overlay PNGs (RGBA transparent) for the TagPro VGS demo."""

import sys, os
from PIL import Image, ImageDraw, ImageFont

SW  = int(sys.argv[1]) if len(sys.argv) > 1 else 884
SH  = int(sys.argv[2]) if len(sys.argv) > 2 else 672
OUT = sys.argv[3]      if len(sys.argv) > 3 else './output/overlays'
os.makedirs(OUT, exist_ok=True)

# RGBA colors
MENU_BG = (0,   0,   0,   200)
CHAT_BG = (0,   0,   0,   160)
WHITE   = (255, 255, 255, 255)
BLUE    = (68,  153, 255, 255)
RED     = (255,  80,  80, 255)
GOLD    = (255, 200,  50, 255)
TRANS   = (0,   0,   0,   0)

def load_font(size):
    for p in ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Arial.ttf']:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

F15 = load_font(15)
F14 = load_font(14)
F12 = load_font(12)

# Menu layout constants
MX, MY = 12, 95
MW     = 352
COL2   = MX + 180

def blank():
    return Image.new('RGBA', (SW, SH), TRANS)

def menu_bg(d, h):
    d.rectangle([MX, MY, MX + MW, MY + h], fill=MENU_BG)

def kv(d, key, label, x, y, color=WHITE):
    d.text((x, y), f'[{key}] {label}', font=F12, fill=color)

# ── Shared phase-1 overlay (V pressed → category list) ─────────────────────
def make_categories():
    img = blank()
    d   = ImageDraw.Draw(img)
    menu_bg(d, 132)
    d.text((MX+8, MY+8),   'VGS — select category', font=F15, fill=WHITE)
    kv(d, 'A', 'Attack', MX+8,  MY+34)
    kv(d, 'D', 'Defend', COL2,  MY+34)
    kv(d, 'G', 'Global', MX+8,  MY+56)
    kv(d, 'S', 'Self',   COL2,  MY+56)
    kv(d, 'T', 'Team',   MX+8,  MY+78)
    d.text((MX+8, MY+106), 'V pressed', font=F12, fill=BLUE)
    return img

# ── Phase-2 submenu (second key pressed, active item highlighted) ───────────
def make_submenu(title, items, breadcrumb, hint):
    """
    items: list of (key, label, is_active)
    Lays items out in 2 columns; active one shown in BLUE.
    """
    rows = (len(items) + 1) // 2
    h    = 34 + rows * 22 + 46          # title + item rows + 2 breadcrumb lines
    img  = blank()
    d    = ImageDraw.Draw(img)
    menu_bg(d, h)
    d.text((MX+8, MY+8), title, font=F15, fill=WHITE)
    for i, (key, label, active) in enumerate(items):
        col = i % 2
        row = i // 2
        x = (MX+8) if col == 0 else COL2
        y = MY + 34 + row * 22
        kv(d, key, label, x, y, BLUE if active else WHITE)
    y_b = MY + 34 + rows * 22 + 4
    d.text((MX+8, y_b),      breadcrumb, font=F12, fill=BLUE)
    d.text((MX+8, y_b + 18), hint,       font=F12, fill=GOLD)
    return img

# ── Chat message overlay ────────────────────────────────────────────────────
def make_chat(message, color):
    img = blank()
    d   = ImageDraw.Draw(img)
    d.rectangle([0, SH - 54, SW, SH - 14], fill=CHAT_BG)
    d.text((10, SH - 42), message, font=F14, fill=color)
    return img

# ── Generate everything ─────────────────────────────────────────────────────
pngs = {
    # Phase 1 — shared across all VGS events (V pressed → category menu)
    'ovl_phase1.png': make_categories(),

    # Phase 2 — one per VGS event (second key pressed)
    'ovl_p2_attack.png': make_submenu(
        'VGS > Attack',
        [
            ('A', 'Get the flag!',   False),
            ('F', 'Attacking flag!', True),    # ← [F] highlighted
            ('B', 'Need backup!',    False),
            ('G', 'Incoming!',       False),
            ('R', 'Retrieve flag!',  False),
            ('S', 'I got it!',       False),
        ],
        'V > A  (press key)',
        'F: I am attacking the flag!',
    ),

    'ovl_p2_global.png': make_submenu(
        'VGS > Global',
        [
            ('W', 'Woo hoo!',  True),          # ← [W] highlighted
            ('N', 'Nice!',     False),
            ('O', 'Oh no!',    False),
            ('S', 'Sorry!',    False),
        ],
        'V > G  (press key)',
        'W: Woo hoo!',
    ),

    'ovl_p2_team.png': make_submenu(
        'VGS > Team',
        [
            ('G', 'Get the gate!', True),       # ← [G] highlighted
            ('B', 'Base!',         False),
            ('H', 'Help!',         False),
            ('D', 'Defend!',       False),
            ('F', 'Flag carrier!', False),
        ],
        'V > T  (press key)',
        'G: Get the gate!',
    ),

    # Chat overlays — one per event
    'ovl_chat_attack.png':  make_chat('(BilldaCat): I am attacking the flag!', BLUE),
    'ovl_chat_woohoo.png':  make_chat('(ALL) BilldaCat: Woo hoo!',            GOLD),
    'ovl_chat_handoff.png': make_chat('(Cbad): Handoff!',                       RED),
    'ovl_chat_gate.png':    make_chat('(BilldaCat): Get the gate!',            BLUE),
    'ovl_chat_idiots.png':  make_chat('(ALL) Kobe Maybe: You idiots!',         GOLD),
}

for fname, img in pngs.items():
    img.save(f'{OUT}/{fname}')

print(f'Generated {len(pngs)} overlay PNGs → {OUT}')
