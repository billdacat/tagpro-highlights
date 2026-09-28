// Export TagPro replay highlight clips using the real TagPro rendering engine.
//
// Usage:
//   node src/export-replay-clips.js [ndjsonPath] [--match=EU_ID[,EU_ID...]] [--mltp=MATCHUP] [flags]
//
// --match=ID[,ID..]  tagpro.eu match ID(s) — looks up UUID, downloads NDJSON, derives replay key.
//                    Several IDs (comma-separated or repeated) are exported as one series reel.
// --mltp=ID|URL      mltp.gg matchup ID or URL — pulls the tagpro.eu match ID of every game in
//                    the series and exports them all into one reel.
// --replay=KEY       Override the replay key (single game only; raw, not URL-encoded)
// --caps-only        Only export clips centered on flag captures
// --clips=N          Max non-cap filler clips per game (default: 10; all caps are kept)
// --max-minutes=M    Cap the reel length; clips are ranked across games to fit.
//                    Default: 8 for multi-game reels, unlimited for a single game.
// --dry-run          Resolve games, score highlights, print the reel plan, then stop.
// --login            Open Chrome so you can log into TagPro, then extract session cookies
//
// Output (single game): output/clips/clip_01.mp4 ... output/game-summary.mp4
// Output (multi game) : output/match/game_NN/... output/match-highlights.mp4

import { chromium }   from 'playwright';
import { mkdirSync, createWriteStream, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import { get as httpsGet } from 'https';
import { parseReplay }    from './parse-replay.js';
import { scoreHighlights } from './score-highlights.js';
import { fetchMatchup, describeMatchup } from './mltp.js';
import { makeSeriesIntroCard, makeGameTitleCard, makeSeriesFinalCard, CARD_SECONDS } from './series-cards.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Args ───────────────────────────────────────────────────────────────────
const LOGIN_MODE = process.argv.includes('--login');
const flag       = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
// All values of a repeatable flag, also split on commas: --match=1,2 --match=3 → ['1','2','3']
const flags      = name => process.argv
  .filter(a => a.startsWith(`--${name}=`))
  .flatMap(a => a.split('=').slice(1).join('=').split(','))
  .map(v => v.trim()).filter(Boolean);
const positional = process.argv.filter(a => !a.startsWith('--'));

const MATCH_IDS  = flags('match');
const MLTP       = flag('mltp');
const CAPS_ONLY  = process.argv.includes('--caps-only');
const MAX_CLIPS  = parseInt(flag('clips') ?? positional[4] ?? '10');
const MAX_MINUTES = flag('max-minutes') != null ? parseFloat(flag('max-minutes')) : null;
const DRY_RUN    = process.argv.includes('--dry-run');
// --debug-clip: record only clip 1, starting from t=0, so you can watch the
// full game start and see exactly where the focal player appears/disappears.
const DEBUG_CLIP = process.argv.includes('--debug-clip');
if (MAX_MINUTES != null && !(MAX_MINUTES > 0)) throw new Error('--max-minutes must be a positive number');

const DISSOLVE_SEC  = 1.5;
const INTRO_SEC     = 4;    // gameplay cold-open recorded at the flags-live moment
const RECAP_SEC     = 7;    // featured-players recap card
const SCOREBOARD_SEC = 8;   // full box-score card (single-game reels only)
const DEFAULT_MULTI_MAX_MINUTES = 8;
const MAX_FILLER_SEC = 30;  // under a budget, non-cap clips longer than this are skipped

// ── Helpers ────────────────────────────────────────────────────────────────

function getVideoDurationSec(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-select_streams', 'v:0',
    filePath,
  ], { encoding: 'utf8' });
  const stream = JSON.parse(out).streams[0];
  return parseFloat(stream.duration);
}

// Stitch clips together with 0.5 s cross-dissolves between each pair.
// Uses chained ffmpeg xfade filters — no intermediate transition files needed.
function stitchWithDissolve(clipPaths, outputPath, dissolveSec = 0.5) {
  if (clipPaths.length === 1) {
    execFileSync('ffmpeg', [
      '-y', '-i', clipPaths[0],
      '-vf', 'fps=30,setpts=PTS-STARTPTS',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-an', outputPath,
    ]);
    return;
  }

  const durations = clipPaths.map(getVideoDurationSec);
  const inputs    = clipPaths.flatMap(p => ['-i', p]);
  const filters   = [];

  // Normalise each clip to 30 fps with PTS reset
  clipPaths.forEach((_, i) => {
    filters.push(`[${i}:v]fps=30,setpts=PTS-STARTPTS[nv${i}]`);
  });

  // Chain xfades: offset accumulates as (sum of prior clip durations) - (dissolves consumed so far)
  let prevLabel  = '[nv0]';
  let cumOffset  = 0;

  for (let i = 1; i < clipPaths.length; i++) {
    cumOffset += durations[i - 1] - dissolveSec;
    const isLast   = i === clipPaths.length - 1;
    const outLabel = isLast ? 'vout' : `xf${i}`;
    filters.push(
      `${prevLabel}[nv${i}]xfade=transition=dissolve:duration=${dissolveSec}:offset=${cumOffset.toFixed(4)}[${outLabel}]`
    );
    prevLabel = `[${outLabel}]`;
  }

  console.log(`  Stitching ${clipPaths.length} clips with ${dissolveSec}s dissolves...`);
  execFileSync('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-an',
    outputPath,
  ]);
}

// ── Game-summary card (PIL renderer) ──────────────────────────────────────────
// Builds a 1280×720 scoreboard PNG and converts it to a short MP4 clip.

const SUMMARY_CARD_PY = String.raw`
import sys, json
from PIL import Image, ImageDraw, ImageFont

def load_font(size):
    for p in [
        '/System/Library/Fonts/Helvetica.ttc',
        '/System/Library/Fonts/HelveticaNeue.ttc',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/Library/Fonts/Arial.ttf',
    ]:
        try: return ImageFont.truetype(p, size)
        except: pass
    return ImageFont.load_default()

def fmt_time(v):
    s = int(v or 0)
    if s == 0: return '0s'
    return f'{s//60}:{s%60:02d}' if s >= 60 else f'{s}s'

def ctr(text, font, color, cx, cy):
    bb = d.textbbox((0,0), text, font=font)
    d.text((cx-(bb[2]-bb[0])//2, cy-(bb[3]-bb[1])//2), text, font=font, fill=color)

def rgt(text, font, color, rx, cy):
    bb = d.textbbox((0,0), text, font=font)
    d.text((rx-(bb[2]-bb[0]), cy-(bb[3]-bb[1])//2), text, font=font, fill=color)

W, H = 1280, 720
D = json.loads(sys.argv[2])
img = Image.new('RGB', (W, H), (8,8,20))
d = ImageDraw.Draw(img)

CR=(220,65,65); CB=(65,120,245); CG=(200,170,55); CW=(225,225,235)
CD=(135,135,160); CL=(35,35,65); R0=(12,12,28); R1=(18,18,42)

# Header
d.rectangle([(0,0),(W,185)], fill=(14,14,34))
d.rectangle([(0,0),(6,185)], fill=CR)
d.rectangle([(W-6,0),(W,185)], fill=CB)

ctr('G A M E   S U M M A R Y', load_font(19), CG, W//2, 24)
d.rectangle([(20,25),(360,26)], fill=CL)
d.rectangle([(920,25),(W-20,26)], fill=CL)

rn=D.get('redName','Red'); bn=D.get('blueName','Blue')
sr=D.get('scoreR',0);      sb=D.get('scoreB',0)
ctr(rn, load_font(40), CR, W//4,   108)
ctr(bn, load_font(40), CB, 3*W//4, 108)
ctr(f'{sr}  -  {sb}', load_font(82), CW, W//2, 108)

if sr > sb: d.rectangle([(W//4-72,148),(W//4+72,151)], fill=CR)
elif sb > sr: d.rectangle([(3*W//4-72,148),(3*W//4+72,151)], fill=CB)

d.rectangle([(0,183),(W,186)], fill=CL)
d.rectangle([(636,183),(640,H-2)], fill=CL)

# Column defs: (x, label, width, right_align)
CLS = [(16,'PLAYER',155,False),(171,'CAP',46,True),(217,'RET',46,True),(263,'GRAB',52,True),(315,'HOLD',68,True),(383,'PREV',68,True),(451,'TAGS',46,True)]
CLR = [(x+644,l,w,ra) for (x,l,w,ra) in CLS]

fh=load_font(15); fn=load_font(20); fs=load_font(21)
HY=196; UY=210

for (x,lbl,w,ra) in CLS+CLR:
    bb=d.textbbox((0,0),lbl,font=fh); tw=bb[2]-bb[0]
    d.text((x+w-tw if ra else x, HY), lbl, font=fh, fill=CD)
d.rectangle([(8,UY),(630,UY+1)], fill=CL)
d.rectangle([(650,UY),(W-8,UY+1)], fill=CL)

RY0=UY+6; RH=88

def draw_rows(players, cols, tc):
    for i,p in enumerate(players[:5]):
        ry=RY0+i*RH; bg=R0 if i%2==0 else R1
        x0=cols[0][0]-3; x1=cols[-1][0]+cols[-1][2]+3
        d.rectangle([(x0,ry),(x1,ry+RH-4)], fill=bg)
        vals=[
            p.get('name','?'),
            str(p.get('caps',0)),
            str(p.get('returns',0)),
            str(p.get('grabs',0)),
            fmt_time(p.get('hold',0)),
            fmt_time(p.get('prevent',0)),
            str(p.get('tags',0)),
        ]
        my=ry+RH//2-2
        for j,(x,_,w,ra) in enumerate(cols):
            v=vals[j]; f=fn if j==0 else fs; c=tc if j==0 else CW
            bb=d.textbbox((0,0),v,font=f); tw=bb[2]-bb[0]; th=bb[3]-bb[1]
            d.text((x+w-tw if ra else x+4, my-th//2), v, font=f, fill=c)

draw_rows(D.get('playersRed',[]),  CLS, CR)
draw_rows(D.get('playersBlue',[]), CLR, CB)

# Footer
fy = max(RY0 + 5*RH + 8, H-90)
d.rectangle([(0,fy-1),(W,fy)], fill=CL)
mn = D.get('mapName','')
if mn: ctr(mn, load_font(18), CD, W//2, fy+30)
ctr('tagpro.koalabeast.com', load_font(14), (65,65,100), W//2, H-18)

img.save(sys.argv[1])
`.trim();

// Collect final per-player stats from the raw playerStats map + meta.players roster.
function buildPlayerSummaries(meta, playerStats) {
  return (meta?.players ?? [])
    .filter(p => p.team === 1 || p.team === 2)
    .map(fp => {
      const s = playerStats[fp.id] ?? {};
      return {
        name:     fp.displayName ?? s.name ?? `Player${fp.id}`,
        team:     fp.team,
        caps:     s['s-captures'] ?? 0,
        returns:  s['s-returns']  ?? 0,
        grabs:    s['s-grabs']   ?? 0,
        tags:     s['s-tags']    ?? 0,
        hold:     s['s-hold']    ?? 0,
        prevent:  s['s-prevent'] ?? 0,
        powerups: s['s-powerups'] ?? 0,
      };
    });
}

// ── Recap card (featured top players) ─────────────────────────────────────────
// Two players spotlighted per team: top offense (caps) and top defense (returns).
// Team aggregate stat comparison bars fill the bottom section.

const RECAP_PY = String.raw`
import sys, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter

F_DISPLAY = '/System/Library/Fonts/Supplemental/DIN Condensed Bold.ttf'
F_UI      = '/System/Library/Fonts/Supplemental/DIN Alternate Bold.ttf'
F_BODY    = '/System/Library/Fonts/Supplemental/Futura.ttc'

def load_font(size, role='body'):
    stacks = {
        'display': [F_DISPLAY, F_UI, '/System/Library/Fonts/Helvetica.ttc'],
        'ui':      [F_UI, F_DISPLAY, '/System/Library/Fonts/Helvetica.ttc'],
        'body':    [F_BODY, '/System/Library/Fonts/HelveticaNeue.ttc'],
    }
    for p in stacks.get(role, stacks['body']):
        try: return ImageFont.truetype(p, size)
        except: pass
    return ImageFont.load_default()

def fmt_t(v):
    s = int(v or 0)
    if s == 0: return '0s'
    return f'{s//60}:{s%60:02d}' if s >= 60 else f'{s}s'

W, H = 1280, 720
D = json.loads(sys.argv[2])
LOGO_PATH = sys.argv[3] if len(sys.argv) > 3 else None

CR, CB = (220, 65, 65), (65, 120, 245)
CG = (210, 175, 60)
CW = (230, 230, 240)
CD = (120, 125, 150)
CL = (40, 40, 72)

DIVX = 641; LW = DIVX; RW = W - DIVX - 3
HDR_H = 132; CH = 193
C1Y = HDR_H + 1; C2Y = C1Y + CH + 4; B0Y = C2Y + CH + 8

# ── Step 1: Background ────────────────────────────────────────────────────────
img = Image.new('RGBA', (W, H), (10, 10, 26, 255))

# Team-colored ambient wash from each side
wash = Image.new('RGBA', (W, H), (0, 0, 0, 0))
wd = ImageDraw.Draw(wash)
wd.rectangle([(0, 0), (W//2 + 80, H)], fill=(*CR, 20))
wd.rectangle([(W//2 - 80, 0), (W, H)], fill=(*CB, 20))
wash = wash.filter(ImageFilter.GaussianBlur(radius=100))
img = Image.alpha_composite(img, wash)

# Card drop shadows
shadows = Image.new('RGBA', (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadows)
for x, y, w in [(0, C1Y, LW), (DIVX+3, C1Y, RW), (0, C2Y, LW), (DIVX+3, C2Y, RW)]:
    sd.rounded_rectangle([x+5, y+5, x+w+4, y+CH+4], radius=9, fill=(0, 0, 0, 85))
shadows = shadows.filter(ImageFilter.GaussianBlur(radius=7))
img = Image.alpha_composite(img, shadows)

# ── Main draw pass ────────────────────────────────────────────────────────────
d = ImageDraw.Draw(img)

rn = D.get('redName', 'Red');  bn = D.get('blueName', 'Blue')
sr = D.get('scoreR', 0);       sb = D.get('scoreB', 0)

# ── Header ────────────────────────────────────────────────────────────────────
d.rectangle([(0, 0), (W, HDR_H)], fill=(9, 9, 24, 235))
d.rectangle([(0, 0), (8, HDR_H)], fill=CR)
d.rectangle([(W-8, 0), (W, HDR_H)], fill=CB)

# Inner glow bloom from edge strips
for side, color in [('left', CR), ('right', CB)]:
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    if side == 'left':
        gd.rectangle([(8, 0), (50, HDR_H)], fill=(*color, 35))
    else:
        gd.rectangle([(W-50, 0), (W-8, HDR_H)], fill=(*color, 35))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=18))
    img = Image.alpha_composite(img, glow)
d = ImageDraw.Draw(img)

# "GAME SUMMARY" label with flanking decorative lines
fl = load_font(13, 'ui')
lbl = 'GAME  SUMMARY'
bb = d.textbbox((0, 0), lbl, font=fl)
lx = W//2 - (bb[2]-bb[0])//2
d.text((lx, 14), lbl, font=fl, fill=CG)
d.rectangle([(22, 23), (lx-16, 24)], fill=CL)
d.rectangle([(lx+(bb[2]-bb[0])+16, 23), (W-22, 24)], fill=CL)

# Ball icon (red/blue split) between the two scores
def draw_ball(cx, cy, r):
    d.pieslice([cx-r, cy-r, cx+r, cy+r], 90, 270, fill=CB)
    d.pieslice([cx-r, cy-r, cx+r, cy+r], 270, 90, fill=CR)
    d.ellipse([cx-r, cy-r, cx+r, cy+r], outline=(10, 10, 28), width=3)
    d.ellipse([cx-r+3, cy-r+3, cx+r-3, cy+r-3], outline=(200, 205, 230), width=1)
    d.line([(cx, cy-r+2), (cx, cy+r-2)], fill=(10, 10, 28), width=2)

# Split score: team-colored numbers in DIN Condensed flanking ball icon
fs = load_font(88, 'display')
r_str, b_str = str(sr), str(sb)
bb_r = d.textbbox((0, 0), r_str, font=fs)
BALL_CX, BALL_CY, BALL_R = W//2, 80, 22
rx = BALL_CX - BALL_R - 28 - (bb_r[2]-bb_r[0])
bx = BALL_CX + BALL_R + 28
sy = 32
d.text((rx+2, sy+2), r_str, font=fs, fill=(0,0,0), stroke_width=2, stroke_fill=(0,0,0))
d.text((rx, sy), r_str, font=fs, fill=CR, stroke_width=2, stroke_fill=(80,0,0))
bb_b = d.textbbox((0, 0), b_str, font=fs)
d.text((bx+2, sy+2), b_str, font=fs, fill=(0,0,0), stroke_width=2, stroke_fill=(0,0,0))
d.text((bx, sy), b_str, font=fs, fill=CB, stroke_width=2, stroke_fill=(0,20,90))
draw_ball(BALL_CX, BALL_CY, BALL_R)

# Team names in DIN Alternate Bold
for name, tc, cx in [(rn, CR, LW//2), (bn, CB, DIVX+3+RW//2)]:
    fn = load_font(34, 'ui')
    bb = d.textbbox((0, 0), name, font=fn)
    tx = cx - (bb[2]-bb[0])//2
    d.text((tx+1, 94), name, font=fn, fill=(0, 0, 0))
    d.text((tx, 93), name, font=fn, fill=tc)

if sr > sb:   d.rectangle([(LW//2-68, 128), (LW//2+68, 131)], fill=CR)
elif sb > sr: d.rectangle([(DIVX+3+RW//2-68, 128), (DIVX+3+RW//2+68, 131)], fill=CB)

d.rectangle([(0, HDR_H), (W, HDR_H+2)], fill=CL)
d.rectangle([(DIVX, HDR_H), (DIVX+3, H-2)], fill=CL)

# Flag icon: pole + triangular flag
def draw_flag(x, y, size, tc):
    pw = max(2, size//9)
    d.rectangle([(x, y), (x+pw, y+size)], fill=(200, 200, 215))
    d.polygon([(x+pw, y+1), (x+int(size*0.65), y+int(size*0.28)), (x+pw, y+int(size*0.55))], fill=tc)

# ── Player card ───────────────────────────────────────────────────────────────
def draw_card(x, y, w, tc, role, p, stats):
    r, g, b = tc
    tcd = (max(0, r//7+4), max(0, g//7+4), max(0, b//7+6))
    d.rounded_rectangle([x, y, x+w, y+CH], radius=9, fill=tcd, outline=tc, width=2)
    d.rounded_rectangle([x, y, x+w, y+7], radius=9, fill=tc)
    d.rectangle([x, y+4, x+w, y+7], fill=tc)
    draw_flag(x+18, y+12, 16, tc)
    d.text((x+38, y+13), role, font=load_font(12, 'ui'), fill=CG)
    name = (p.get('name') or '').upper()
    fn = load_font(52, 'display')
    for sz in (52, 44, 36, 28, 22):
        fn = load_font(sz, 'display')
        bb = d.textbbox((0, 0), name, font=fn)
        if bb[2]-bb[0] <= w-40: break
    sk = (max(0, r-140), max(0, g-90), max(0, b-90))
    d.text((x+20, y+36), name, font=fn, fill=tc, stroke_width=2, stroke_fill=sk)
    d.rectangle([(x+16, y+107), (x+w-16, y+108)], fill=(r//5+6, g//5+6, b//5+22))
    nb = len(stats)
    bw2 = (w-22)//nb
    fv  = load_font(34, 'display')
    fls = load_font(10, 'body')
    for i, (val, lbl2) in enumerate(stats):
        cx2 = x + 11 + i*bw2 + bw2//2
        bb = d.textbbox((0, 0), val, font=fv)
        d.text((cx2-(bb[2]-bb[0])//2, y+113), val, font=fv, fill=CW)
        bb = d.textbbox((0, 0), lbl2, font=fls)
        d.text((cx2-(bb[2]-bb[0])//2, y+162), lbl2, font=fls, fill=CD)

ro = D.get('redOffense', {});  bo = D.get('blueOffense', {})
rd = D.get('redDefense', {});  bd = D.get('blueDefense', {})

def os(p): return [(str(p.get('caps',0)),'CAPS'),(fmt_t(p.get('hold',0)),'HOLD'),(str(p.get('grabs',0)),'GRABS'),(str(p.get('powerups',0)),'POWERUPS')]
def ds(p): return [(str(p.get('returns',0)),'RETURNS'),(fmt_t(p.get('prevent',0)),'PREVENT'),(str(p.get('tags',0)),'TAGS'),(str(p.get('powerups',0)),'POWERUPS')]

draw_card(0,       C1Y, LW, CR, 'TOP OFFENSE', ro, os(ro))
draw_card(DIVX+3,  C1Y, RW, CB, 'TOP OFFENSE', bo, os(bo))
draw_card(0,       C2Y, LW, CR, 'TOP DEFENSE', rd, ds(rd))
draw_card(DIVX+3,  C2Y, RW, CB, 'TOP DEFENSE', bd, ds(bd))

# ── Team stat bars — label above, values on sides ─────────────────────────────
tr = D.get('teamRed', {});  tb = D.get('teamBlue', {})
BX0, BX1, BH, BSP = 185, 1095, 24, 50

def bar(y, label, rv, bv, fmt_fn=str):
    # Label centered above the bar
    fbl = load_font(11, 'ui')
    bb = d.textbbox((0, 0), label, font=fbl)
    tw, th = bb[2]-bb[0], bb[3]-bb[1]
    d.text((W//2 - tw//2, y), label, font=fbl, fill=CD)
    # Bar below label
    by = y + th + 4
    tot = (rv+bv) or 1
    bw2 = BX1-BX0; rw2 = int(bw2*rv/tot); bww = bw2-rw2
    d.rounded_rectangle([BX0, by, BX1, by+BH], radius=BH//2, fill=(18, 18, 44))
    if rw2 > 2: d.rounded_rectangle([BX0, by, BX0+rw2, by+BH], radius=BH//2, fill=CR)
    if bww > 2: d.rounded_rectangle([BX1-bww, by, BX1, by+BH], radius=BH//2, fill=CB)
    d.rectangle([(BX0+rw2-1, by), (BX0+rw2, by+BH)], fill=(8, 8, 20))
    # Values on sides in DIN Condensed
    fv = load_font(20, 'display')
    rv_s, bv_s = fmt_fn(rv), fmt_fn(bv)
    bb = d.textbbox((0, 0), rv_s, font=fv)
    d.text((BX0-(bb[2]-bb[0])-12, by+BH//2-(bb[3]-bb[1])//2), rv_s, font=fv, fill=CW)
    bb = d.textbbox((0, 0), bv_s, font=fv)
    d.text((BX1+12, by+BH//2-(bb[3]-bb[1])//2), bv_s, font=fv, fill=CW)

bar(B0Y+10,        'GRABS',     tr.get('grabs',0),   tb.get('grabs',0))
bar(B0Y+10+BSP,    'RETURNS',   tr.get('returns',0), tb.get('returns',0))
bar(B0Y+10+BSP*2,  'HOLD TIME', tr.get('hold',0),    tb.get('hold',0), fmt_t)

# ── Footer: map name | logo | attribution ─────────────────────────────────────
LOGO_H = 32; logo_y = H - LOGO_H - 5; text_cy = logo_y + LOGO_H//2
mn = D.get('mapName', '')
if mn:
    fm = load_font(13, 'body')
    bb = d.textbbox((0, 0), mn, font=fm)
    d.text((28, text_cy-(bb[3]-bb[1])//2), mn, font=fm, fill=CD)
if LOGO_PATH:
    try:
        logo = Image.open(LOGO_PATH).convert('RGBA')
        logo_w = int(LOGO_H * logo.size[0] / logo.size[1])
        logo = logo.resize((logo_w, LOGO_H), Image.LANCZOS)
        img.alpha_composite(logo, (W//2 - logo_w//2, logo_y))
        d = ImageDraw.Draw(img)
    except:
        pass
fa = load_font(10, 'body')
attr = 'tagpro.koalabeast.com'
bb = d.textbbox((0, 0), attr, font=fa)
d.text((W-(bb[2]-bb[0])-28, text_cy-(bb[3]-bb[1])//2), attr, font=fa, fill=(55, 55, 90))

img.convert('RGB').save(sys.argv[1])
`.trim();

function makeRecapCard(pngPath, mp4Path, meta, playerStats, finalScore) {
  const all  = buildPlayerSummaries(meta, playerStats);
  const red  = all.filter(p => p.team === 1);
  const blue = all.filter(p => p.team === 2);

  const topCap = arr => [...arr].sort((a, b) => b.caps - a.caps || b.hold - a.hold)[0] ?? {};
  const topDef = arr => [...arr].sort((a, b) => b.returns - a.returns || b.prevent - a.prevent)[0] ?? {};
  const totals  = arr => arr.reduce((t, p) => ({
    grabs:   (t.grabs   || 0) + p.grabs,
    returns: (t.returns || 0) + p.returns,
    hold:    (t.hold    || 0) + p.hold,
    prevent: (t.prevent || 0) + p.prevent,
  }), {});

  const redName  = meta?.teamNames?.red  ?? meta?.teams?.red?.name  ?? 'Red';
  const blueName = meta?.teamNames?.blue ?? meta?.teams?.blue?.name ?? 'Blue';

  const data = JSON.stringify({
    redName, blueName,
    scoreR:      finalScore?.r ?? 0,
    scoreB:      finalScore?.b ?? 0,
    mapName:     meta?.map ?? meta?.mapName ?? '',
    redOffense:  topCap(red),
    redDefense:  topDef(red),
    blueOffense: topCap(blue),
    blueDefense: topDef(blue),
    teamRed:     totals(red),
    teamBlue:    totals(blue),
  });

  const logoPath = resolve(__dir, '../tagprologo.png');
  execFileSync('python3', ['-c', RECAP_PY, pngPath, data, logoPath]);
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', pngPath,
    '-t', String(RECAP_SEC), '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1280:720', '-an', mp4Path,
  ]);
}

// Render a 1280×720 scoreboard PNG then convert it to an MP4 still clip.
function makeSummaryCard(pngPath, mp4Path, meta, playerStats, finalScore) {
  const all  = buildPlayerSummaries(meta, playerStats);
  const sort = (arr) => [...arr].sort((a,b) => b.caps - a.caps || b.returns - a.returns);

  // Try to find team names in the meta (some NDJSON formats include them)
  const redName  = meta?.teamNames?.red  ?? meta?.teams?.red?.name  ?? 'Red';
  const blueName = meta?.teamNames?.blue ?? meta?.teams?.blue?.name ?? 'Blue';

  const data = JSON.stringify({
    redName,
    blueName,
    scoreR:      finalScore?.r ?? 0,
    scoreB:      finalScore?.b ?? 0,
    mapName:     meta?.map ?? meta?.mapName ?? meta?.levelName ?? '',
    playersRed:  sort(all.filter(p => p.team === 1)),
    playersBlue: sort(all.filter(p => p.team === 2)),
  });

  execFileSync('python3', ['-c', SUMMARY_CARD_PY, pngPath, data]);

  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', pngPath,
    '-t', String(SCOREBOARD_SEC), '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1280:720',
    '-an', mp4Path,
  ]);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { Accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// TagPro's own hexToBase64: converts hex → binary → base64, then + → _ (NOT standard URL-safe)
function hexToBase64(hexStr) {
  return Buffer.from(hexStr, 'hex').toString('base64').replaceAll('+', '_');
}

async function deriveReplayKey(meta) {
  const uuid = meta?.uuid;
  if (!uuid) throw new Error('No UUID in NDJSON recorder-metadata');

  const data = await fetchJSON(
    `https://tagpro.koalabeast.com/replays/data?uuid=${encodeURIComponent(uuid)}`
  );
  const game = data?.games?.[0];
  if (!game?.id) throw new Error(`No replay found for UUID ${uuid}`);

  // Get recorder's userId from NDJSON metadata
  const followPlayerId  = meta.follow?.[0];
  const recorderUserId  = followPlayerId != null
    ? (meta.players?.find(p => p.id === followPlayerId)?.userId ?? '')
    : '';

  const hexStr = game.id + recorderUserId;
  console.log(`  game.id: ${game.id}  userId: ${recorderUserId || '(none)'}`);
  return hexToBase64(hexStr);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    httpsGet(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Resolves a tagpro.eu match ID → { ndjsonPath, replayKey }
// Downloads the NDJSON directly from TagPro's server (no local recording needed).
async function lookupMatch(matchId) {
  console.log(`  Fetching match ${matchId} from tagpro.eu...`);
  const euData = await fetchJSON(`https://tagpro.eu/data/?match=${encodeURIComponent(matchId)}`);
  const uuid = euData?.uuid;
  if (!uuid) throw new Error(`tagpro.eu returned no UUID for match ${matchId}`);
  console.log(`  UUID: ${uuid}`);

  const replayData = await fetchJSON(
    `https://tagpro.koalabeast.com/replays/data?uuid=${encodeURIComponent(uuid)}`
  );
  const game = replayData?.games?.[0];
  if (!game?.id) throw new Error(`No replay data found for UUID ${uuid}`);
  console.log(`  game.id: ${game.id}`);

  const ndjsonUrl  = `https://tagpro.koalabeast.com/replays/gameFile?gameId=${game.id}`;
  const ndjsonPath = `/tmp/tagpro-match-${matchId}.ndjson`;
  console.log(`  Downloading NDJSON...`);
  await downloadFile(ndjsonUrl, ndjsonPath);

  return { ndjsonPath, replayKey: hexToBase64(game.id) };
}

// ── In-page recording function ─────────────────────────────────────────────
// Seek to sliderMs, wait for the seek to land, play for durationMs while
// capturing the canvas via MediaRecorder.  POV is set inside the 500 ms
// settle window (after rp.play) so tagpro.players reflects the seek position.
const RECORDER_SRC = String.raw`
window.__tpRecord = (sliderMs, durationMs, targetW, targetH, bitrateMbps, focusPlayer, prevFocusPlayer, povSwitchMs) =>
  new Promise((resolve, reject) => {
    const log = m => console.log('[tp-export] ' + m);
    const rp  = window.tagpro?.replayPlayer;
    if (!rp) { reject('tagpro.replayPlayer not found'); return; }

    rp.seek(sliderMs);
    log('seeking to ' + sliderMs + 'ms');

    const seekStart = Date.now();
    // 200 ms guard: on the first seek rp.seeking can flip false before our poll tick
    setTimeout(() => {
      const waitForSeek = () => {
        if (!rp.seeking)                           { onSeekComplete(); }
        else if (Date.now() - seekStart > 8000)    { reject('seek timed out'); }
        else                                       { setTimeout(waitForSeek, 50); }
      };
      waitForSeek();
    }, 200);

    const setPov = (name) => {
      if (!name || !window.tagpro?.players) return;
      const entry = Object.entries(tagpro.players).find(([,p]) => p.name === name);
      if (entry) {
        tagpro.playerId = parseInt(entry[0]);
        if (tagpro.viewport) tagpro.viewport.followPlayer = true;
        log('POV → ' + name + ' (id=' + entry[0] + ')');
      } else {
        const available = Object.values(tagpro.players).map(p => p.name).join(', ');
        log('POV MISS: "' + name + '" — available: [' + available + ']');
      }
    };

    const onSeekComplete = () => {
      log('seek complete, resuming playback');
      rp.play();

      // 500 ms settle: game is running and tagpro.players reflects the seek position.
      // If this clip follows another, start with the previous clip's focal player so
      // the dissolve transition blends two views of the same map location.  Switch to
      // the new focal player at povSwitchMs (≈ mid-dissolve) when the 50/50 blend
      // masks the camera snap.
      setTimeout(() => {
        const startPov = prevFocusPlayer || focusPlayer;
        setPov(startPov);

        if (prevFocusPlayer && focusPlayer && prevFocusPlayer !== focusPlayer && povSwitchMs > 0) {
          setTimeout(() => setPov(focusPlayer), povSwitchMs);
        }

        const src = document.getElementById('viewport');
        if (!src) { reject('#viewport canvas not found'); return; }

        const w   = targetW || src.width  || 1280;
        const h   = targetH || src.height || 720;
        const rc  = document.createElement('canvas');
        rc.width  = w; rc.height = h;
        const ctx = rc.getContext('2d');
        ctx.globalCompositeOperation = 'copy';

        let lastTs = 0, rafId;
        const copyFrame = ts => {
          if (ts - lastTs >= 1000 / 60) { ctx.drawImage(src, 0, 0, w, h); lastTs = ts; }
          rafId = requestAnimationFrame(copyFrame);
        };
        rafId = requestAnimationFrame(copyFrame);

        const mimeType = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']
          .find(t => MediaRecorder.isTypeSupported(t));
        if (!mimeType) { reject('No supported MediaRecorder MIME type'); return; }
        log('mimeType: ' + mimeType);

        const mr = new MediaRecorder(rc.captureStream(60), {
          mimeType,
          videoBitsPerSecond: (bitrateMbps || 8) * 1_000_000,
        });
        const chunks = [];
        mr.ondataavailable = e => e.data.size && chunks.push(e.data);
        mr.onstop = () => {
          cancelAnimationFrame(rafId);
          rp.pause();
          const blob = new Blob(chunks, { type: mimeType });
          const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a');
          a.href = url; a.download = 'tpclip_' + Date.now() + '.' + ext;
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
          log('done — ' + chunks.length + ' chunks, ext=' + ext);
          resolve(ext);
        };

        mr.start(200);
        log('recording started for ' + durationMs + 'ms');
        setTimeout(() => { log('stopping'); mr.stop(); }, durationMs);

      }, 500); // settle after play()
    };
  });
`;


// ── Series / game resolution ───────────────────────────────────────────────

// Which in-game colour (red/blue) each series team played in this game, matched
// by the team name/abbreviation the TagPro server recorded in the NDJSON.
function teamColors(game, series) {
  const red  = game.meta?.teams?.red?.name;
  const blue = game.meta?.teams?.blue?.name;
  const is   = (n, t) => !!n && !!t && (n === t.abbreviation || n === t.name);
  if (is(red, series.home) || is(blue, series.away)) return { home: 'red',  away: 'blue' };
  if (is(blue, series.home) || is(red, series.away)) return { home: 'blue', away: 'red' };
  return { home: null, away: null };
}

// [homeScore, awayScore] for a game — from the replay when we know the colours,
// otherwise from MLTP, otherwise red/blue positional.
function homeAwayScore(game, colors) {
  const fs = game.finalScore;
  if (fs && colors.home) return colors.home === 'red' ? [fs.r, fs.b] : [fs.b, fs.r];
  if (game.mltpScore) return game.mltpScore;
  return fs ? [fs.r, fs.b] : null;
}

// Build the list of games to export from --mltp, --match, or a local NDJSON path.
async function resolveGames() {
  if (MLTP && MATCH_IDS.length) throw new Error('Use either --mltp or --match, not both');

  if (MLTP) {
    console.log(`\nFetching MLTP matchup ${MLTP} ...`);
    const m = await fetchMatchup(MLTP);
    console.log(`  ${describeMatchup(m)}`);
    console.log(`  ${m.home.name} (${m.home.abbreviation}) vs ${m.away.name} (${m.away.abbreviation}) — best of ${m.bestOf}`);
    const games = [];
    for (const g of m.games) {
      const tag = `Game ${g.gameNumber} (${g.mapName || '?'})`;
      if (!g.matchId) {
        console.warn(`  ! ${tag}: no tagpro.eu replay link (status: ${g.status}) — skipping`);
        continue;
      }
      console.log(`  ${tag}: tagpro.eu match ${g.matchId}  score ${g.score?.join('-') ?? '?'}${g.overtime ? ' (OT)' : ''}`);
      games.push({ gameNumber: g.gameNumber, matchId: g.matchId, mapName: g.mapName, mltpScore: g.score, overtime: g.overtime });
    }
    if (!games.length) throw new Error('No games with tagpro.eu replays in this matchup');
    const series = {
      label:       describeMatchup(m),
      footer:      `mltp.gg · ${describeMatchup(m).replace(/^MLTP · /, '')}`,
      home:        m.home,
      away:        m.away,
      bestOf:      m.bestOf,
      scheduledAt: m.scheduledAt,
      seriesScore: m.seriesScore,
      allGames:    m.games,   // including games we could not export, for the final card
    };
    return { series, games };
  }

  if (MATCH_IDS.length) {
    const games = MATCH_IDS.map((id, i) => ({ gameNumber: i + 1, matchId: id }));
    return { series: null, games };
  }

  const ndjsonPath = positional[2]
    ?? `${process.env.HOME}/Downloads/tagpro-bwjtsdpz-rnfstdli.billdacat.ndjson`;
  return { series: null, games: [{ gameNumber: 1, ndjsonPath }] };
}

// Download (if needed), parse, and score one game.  Returns null when the replay
// is unavailable and we are exporting several games (so the rest still export).
async function prepareGame(game, multi) {
  console.log(`\n── Game ${game.gameNumber}${game.mapName ? ` · ${game.mapName}` : ''} ──`);
  if (game.matchId) {
    try {
      ({ ndjsonPath: game.ndjsonPath, replayKey: game.replayKey } = await lookupMatch(game.matchId));
    } catch (err) {
      if (!multi) throw err;
      console.warn(`  ! ${err.message}\n  ! Skipping game ${game.gameNumber}`);
      return null;
    }
  }
  console.log(`  NDJSON : ${game.ndjsonPath}`);

  const parsed = await parseReplay(game.ndjsonPath);
  const { events, playerIndex, meta, gameStartMs, actualDurationMs } = parsed;
  const regulationMs = meta?.duration;
  if (regulationMs && actualDurationMs > regulationMs) {
    const otSec = ((actualDurationMs - regulationMs) / 1000).toFixed(0);
    console.log(`  Overtime detected: +${otSec}s beyond regulation`);
  }

  // MAX_CLIPS controls how many non-cap filler clips to add; all caps are always kept.
  let clips = scoreHighlights({ events, playerIndex, meta, gameStartMs, actualDurationMs, maxNonCapClips: MAX_CLIPS });
  if (CAPS_ONLY) clips = clips.filter(c => c.focalType === 'capture');
  if (DEBUG_CLIP) clips = clips.slice(0, 1);

  if (flag('replay')) {
    game.replayKey = flag('replay');
    console.log(`  Replay : ${game.replayKey} (from --replay flag)`);
  } else if (game.replayKey) {
    console.log(`  Replay : ${game.replayKey} (from --match lookup)`);
  } else {
    console.log('  Deriving replay key...');
    game.replayKey = await deriveReplayKey(meta);
    console.log(`  Replay : ${game.replayKey}`);
  }
  console.log(`  Map    : ${meta?.mapName ?? '?'}   Final: Red ${parsed.finalScore.r} – Blue ${parsed.finalScore.b}   Candidates: ${clips.length} clips`);

  return { ...game, ...parsed, mapName: game.mapName || meta?.mapName || '', clips };
}

// ── Reel planning (duration budget) ────────────────────────────────────────
// Clips from every game compete for one time budget.  Captures always rank
// ahead of filler; filler is ranked by score density and capped in length so a
// single long scramble cannot eat the whole reel.  Each game is guaranteed its
// best clip so no game disappears from the reel entirely.

const clipSec = c => (c.endMs - c.startMs) / 1000;

function planReel(games, { multi, budgetSec }) {
  const cardSec = multi
    ? CARD_SECONDS.intro + CARD_SECONDS.final + games.length * (CARD_SECONDS.game + RECAP_SEC)
    : INTRO_SEC + RECAP_SEC + SCOREBOARD_SEC;
  const cardSegments = multi ? 2 + 2 * games.length : 3;
  let total = cardSec - DISSOLVE_SEC * (cardSegments - 1);

  const all = games.flatMap(g => g.clips.map(c => ({ g, c, dur: clipSec(c), isCap: c.focalType === 'capture' })));

  if (budgetSec == null) {
    total += all.reduce((s, x) => s + x.dur - DISSOLVE_SEC, 0);
    return { estimatedSec: total, kept: all.length, dropped: 0 };
  }

  const eligible = all
    .filter(x => x.isCap || x.dur <= MAX_FILLER_SEC)
    .sort((a, b) => (b.isCap - a.isCap)
      || (a.isCap ? b.c.score - a.c.score : b.c.score / b.dur - a.c.score / a.dur));

  const chosen = new Set();
  const tryAdd = x => {
    const add = x.dur - DISSOLVE_SEC;
    if (total + add > budgetSec) return false;
    chosen.add(x.c); total += add; return true;
  };
  for (const g of games) {                       // seed: best clip of each game
    const best = eligible.find(x => x.g === g);
    if (best) tryAdd(best);
  }
  for (const x of eligible) if (!chosen.has(x.c)) tryAdd(x);

  for (const g of games) g.clips = g.clips.filter(c => chosen.has(c));   // keeps chronological order
  return { estimatedSec: total, kept: chosen.size, dropped: all.length - chosen.size };
}

const fmtSec = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function printPlan(games, plan, budgetSec) {
  console.log('\nReel plan');
  console.log('=========');
  for (const g of games) {
    const caps = g.clips.filter(c => c.focalType === 'capture').length;
    console.log(`\nGame ${g.gameNumber}${g.mapName ? ` · ${g.mapName}` : ''}: ${g.clips.length} clips (${caps} caps, ${fmtSec(g.clips.reduce((s, c) => s + clipSec(c), 0))})`);
    g.clips.forEach((c, i) => {
      const sStart = g.gameStartMs + c.startMs, sEnd = g.gameStartMs + c.endMs;
      console.log(`  [${i + 1}] ${c.description}`);
      console.log(`       players: ${c.players.join(', ')}  |  slider: ${sStart}–${sEnd}ms  (${((sEnd - sStart) / 1000).toFixed(0)}s)`);
    });
  }
  const budget = budgetSec != null ? ` (budget ${fmtSec(budgetSec)}, ${plan.dropped} candidate clip(s) dropped)` : '';
  console.log(`\nEstimated reel length: ~${fmtSec(plan.estimatedSec)}${budget}`);
}

// ── Browser helpers ────────────────────────────────────────────────────────

async function openReplay(browser, context, replayKey, tagproCookies) {
  const url  = `https://tagpro.koalabeast.com/game?replay=${encodeURIComponent(replayKey)}`;
  const page = await context.newPage();
  console.log(`  Opening ${url} ...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Session not valid → guide the user
  if (page.url().includes('/login') || page.url().includes('accounts.google')) {
    const msg = tagproCookies.length === 0
      ? 'No TagPro cookies found in Chrome. Make sure you\'re logged in, then:'
      : 'Session cookies expired. Log into TagPro in Chrome again, then:';
    console.error(`\n⚠  ${msg}\n`);
    console.error('     node src/export-replay-clips.js --login\n');
    await browser.close();
    process.exit(1);
  }

  // Wait for TagPro's replay engine to initialise
  console.log('  Waiting for TagPro to load...');
  await page.waitForFunction(
    () => window.tagpro?.players != null
       && document.getElementById('viewport') != null
       && document.getElementById('replaySeekBar') != null,
    { timeout: 90_000 }
  );
  await page.evaluate(RECORDER_SRC);
  console.log('  TagPro loaded.');
  return page;
}

// Record one clip via the in-page MediaRecorder, save the download, return an MP4 path.
async function recordClip(page, clipsDir, label, { sliderMs, durationMs, focal = null, prevFocal = null, povSwitchMs = 0 }) {
  const downloadPromise = page.waitForEvent('download', { timeout: durationMs + 60_000 });
  const ext = await page.evaluate(
    ({ sliderMs, durationMs, focal, prevFocal, povSwitchMs }) =>
      window.__tpRecord(sliderMs, durationMs, 1280, 720, 8, focal, prevFocal, povSwitchMs),
    { sliderMs, durationMs, focal, prevFocal, povSwitchMs }
  );
  const dl      = await downloadPromise;
  const rawPath = `${clipsDir}/${label}.${ext}`;
  await dl.saveAs(rawPath);
  if (ext === 'mp4') return rawPath;

  const finalPath = `${clipsDir}/${label}.mp4`;
  console.log('  Converting WebM → MP4...');
  execFileSync('ffmpeg', [
    '-y', '-i', rawPath,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    finalPath,
  ]);
  return finalPath;
}

// Record the intro clip plus every planned highlight clip for one game.
async function recordGame(page, game) {
  const { clipsDir, gameStartMs, clips } = game;

  // Intro clip — 4 s of gameplay from the flags-live moment.  Two purposes:
  //  a) Creative cold-open for single-game reels (shows the initial rush).
  //  b) Sprite warm-up: seeking to gameStartMs processes all player-join events
  //     (including mid-game reconnects) so every ball is initialised in the
  //     renderer.  Later seeks keep those sprites, fixing the "invisible player"
  //     issue that occurs on a cold first seek.  Always recorded for that reason.
  console.log('  Recording intro clip (game start)...');
  game.introPath = await recordClip(page, clipsDir, 'intro', { sliderMs: gameStartMs, durationMs: INTRO_SEC * 1000 });
  console.log(`  ✓ intro.mp4  (${(gameStartMs / 1000).toFixed(1)}s mark)\n`);

  game.clipPaths = [];
  let prevFocal = null;  // focal player from the previous clip, for mid-dissolve POV switch
  const povSwitchMs = Math.round(DISSOLVE_SEC * 500);  // switch at 50% of dissolve duration

  for (let i = 0; i < clips.length; i++) {
    const clip  = clips[i];
    const focal = clip.focalPlayer ?? clip.players[0];
    const label = `clip_${String(i + 1).padStart(2, '0')}`;

    // --debug-clip: record only clip 1, from t=0 through the focal event,
    // so you can watch where the focal player is throughout the game start.
    const sliderMs   = (DEBUG_CLIP && i === 0) ? 0 : gameStartMs + clip.startMs;
    const clipEndMs  = gameStartMs + clip.endMs;
    const durationMs = (DEBUG_CLIP && i === 0) ? clipEndMs : clip.endMs - clip.startMs;

    console.log(`  [${i + 1}/${clips.length}] ${clip.description}`);
    if (DEBUG_CLIP && i === 0)
      console.log(`    DEBUG: recording from t=0 → ${clipEndMs}ms (${(clipEndMs / 1000).toFixed(0)}s)`);
    console.log(`    focal=${focal}  prevFocal=${prevFocal ?? '(none)'}  slider=${sliderMs}ms  dur=${(durationMs / 1000).toFixed(0)}s`);

    try {
      const path = await recordClip(page, clipsDir, label, { sliderMs, durationMs, focal, prevFocal, povSwitchMs });
      game.clipPaths.push(path);
      prevFocal = focal;
      console.log(`    ✓ ${label}.mp4\n`);
    } catch (err) {
      console.error(`    ✗ ${label} failed: ${err.message}`);
      console.error(`    Keeping the ${game.clipPaths.length} clip(s) recorded so far for this game.\n`);
      break;
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('\nTagPro Replay Clip Exporter');
console.log('============================');

// 1. Resolve which games to export, then download/parse/score each one.
const { series: mltpSeries, games: requested } = await resolveGames();
const multi = requested.length > 1 || !!MLTP;
if (multi && flag('replay')) throw new Error('--replay only applies to a single game');

const games = [];
for (const g of requested) {
  const prepared = await prepareGame(g, multi);
  if (prepared) games.push(prepared);
}
if (!games.length) { console.error('\nNo games could be prepared'); process.exit(1); }
if (!games.some(g => g.clips.length)) { console.error('\nNo highlights found'); process.exit(1); }

// Series metadata: from MLTP, or derived from game 1's red/blue teams.
const series = mltpSeries ?? (multi ? {
  label:       `${games.length}-game series`,
  footer:      '',
  home:        { name: games[0].meta?.teams?.red?.name  ?? 'Red',  abbreviation: games[0].meta?.teams?.red?.name  ?? 'RED',  colorHex: null },
  away:        { name: games[0].meta?.teams?.blue?.name ?? 'Blue', abbreviation: games[0].meta?.teams?.blue?.name ?? 'BLUE', colorHex: null },
  bestOf:      games.length,
  scheduledAt: null,
  seriesScore: null,
  allGames:    null,
} : null);

if (multi) {
  for (const g of games) {
    g.colors = teamColors(g, series);
    g.homeAwayScore = homeAwayScore(g, g.colors);
    // Let the per-game recap/scoreboard cards show full team names instead of red/blue abbreviations.
    if (g.colors.home && g.meta) {
      g.meta.teamNames = {
        [g.colors.home]: series.home.name,
        [g.colors.away]: series.away.name,
      };
    }
  }
}

// 2. Plan the reel against the duration budget.
const budgetSec = MAX_MINUTES != null ? MAX_MINUTES * 60 : (multi ? DEFAULT_MULTI_MAX_MINUTES * 60 : null);
const plan = planReel(games, { multi, budgetSec });
printPlan(games, plan, budgetSec);
if (DRY_RUN) { console.log('\n--dry-run: stopping before recording.'); process.exit(0); }

// 3. Output layout
//    single game : output/clips/*.mp4                 → output/game-summary.mp4
//    multi game  : output/match/game_NN/clips/*.mp4   → output/match/game_NN/game-summary.mp4
//                  output/match/cards/*.mp4           → output/match-highlights.mp4
const OUT_DIR   = resolve('./output');
const MATCH_DIR = `${OUT_DIR}/match`;
for (const g of games) {
  g.dir      = multi ? `${MATCH_DIR}/game_${String(g.gameNumber).padStart(2, '0')}` : OUT_DIR;
  g.clipsDir = `${g.dir}/clips`;
  mkdirSync(g.clipsDir, { recursive: true });
}
if (multi) mkdirSync(`${MATCH_DIR}/cards`, { recursive: true });

// 4. Auth via cookie injection
//
// Instead of trying to launch Chrome with a debug port (blocked by macOS's
// singleton mechanism), we read TagPro's session cookies directly from
// Chrome's profile database and inject them into Playwright's own Chromium.

const COOKIES_PY = resolve(__dir, 'extract_chrome_cookies.py');

if (LOGIN_MODE) {
  console.log('\nOpening Chrome for TagPro login...');
  execFileSync('open', ['https://tagpro.koalabeast.com/login']);
  console.log('  Log in with your Google account in the Chrome window.');
  console.log('  Press Enter once you\'re on the TagPro home page...\n');
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
  console.log('Cookies will be read from Chrome\'s profile. Continuing...\n');
}

console.log('\nReading TagPro cookies from Chrome profile...');
let tagproCookies = [];
try {
  const raw    = execFileSync('python3', [COOKIES_PY], { encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  if (parsed.error) {
    console.error(`  Cookie extraction warning: ${parsed.error}`);
  } else {
    tagproCookies = parsed.cookies;
    console.log(`  Found ${tagproCookies.length} cookie(s) for tagpro.koalabeast.com`);
  }
} catch (err) {
  console.error(`  Cookie extractor failed: ${err.message}`);
}

// Launch Playwright's own Chromium (no system Chrome needed)
console.log('Launching browser...');
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
if (tagproCookies.length > 0) await context.addCookies(tagproCookies);

// 5. Record every game (one fresh tab per replay).
for (const [i, g] of games.entries()) {
  console.log(`\n[Game ${g.gameNumber}] (${i + 1}/${games.length}) ${g.mapName || ''}`);
  const page = await openReplay(browser, context, g.replayKey, tagproCookies);
  await recordGame(page, g);
  await page.close();
}
await browser.close();

// Result rows for every game in the series, including games we could not export
// (MLTP knows their scores), so running series scores stay right on the title cards.
const exported   = new Map(games.map(g => [g.gameNumber, g]));
const seriesRows = !multi ? [] : (series.allGames ?? games).map(o => {
  const g = exported.get(o.gameNumber);
  return {
    gameNumber: o.gameNumber,
    mapName:    g?.mapName ?? o.mapName ?? '',
    score:      g?.homeAwayScore ?? o.score ?? null,
    overtime:   !!(o.overtime ?? g?.overtime),
  };
});
const seriesScoreAfter = rows => rows.reduce((s, r) => {
  if (r.score) { if (r.score[0] > r.score[1]) s[0]++; else if (r.score[1] > r.score[0]) s[1]++; }
  return s;
}, [0, 0]);

// 6. Per-game ending cards + per-game stitch.
for (const g of games) {
  const { clipsDir, meta, playerStats, finalScore } = g;
  console.log(`\n[Game ${g.gameNumber}] Generating recap card (featured players)...`);
  makeRecapCard(`${clipsDir}/recap.png`, `${clipsDir}/recap.mp4`, meta, playerStats, finalScore);
  console.log('  ✓ recap.mp4');

  let segments;
  if (multi) {
    // Multi-game reels open each game with a title card instead of the cold-open
    // intro, and close with the recap card only (the full box score is skipped
    // to keep the series reel tight).
    const seriesScore = seriesScoreAfter(seriesRows.filter(r => r.gameNumber < g.gameNumber));
    makeGameTitleCard(`${clipsDir}/title.png`, `${clipsDir}/title.mp4`, {
      gameNumber: g.gameNumber, totalGames: series.bestOf ?? games.length,
      mapName: g.mapName, seriesScore, colors: g.colors,
      home: series.home, away: series.away, footer: series.footer,
    });
    console.log('  ✓ title.mp4');
    segments = [`${clipsDir}/title.mp4`, ...g.clipPaths, `${clipsDir}/recap.mp4`];
  } else {
    console.log('  Generating full scoreboard card...');
    makeSummaryCard(`${clipsDir}/scoreboard.png`, `${clipsDir}/scoreboard.mp4`, meta, playerStats, finalScore);
    console.log('  ✓ scoreboard.mp4');
    segments = [g.introPath, ...g.clipPaths, `${clipsDir}/recap.mp4`, `${clipsDir}/scoreboard.mp4`];
  }

  g.reelPath = `${g.dir}/game-summary.mp4`;
  console.log('  Stitching with cross-dissolves...');
  stitchWithDissolve(segments, g.reelPath, DISSOLVE_SEC);
  console.log(`  ✓ ${g.reelPath}`);
}

if (!multi) {
  console.log(`\n✓ ${games[0].reelPath}`);
  console.log(`  open "${games[0].reelPath}"`);
  process.exit(0);
}

// 7. Series cards + final stitch: intro card, each game's reel, series final card.
const cardsDir = `${MATCH_DIR}/cards`;
console.log('\nGenerating series cards...');
makeSeriesIntroCard(`${cardsDir}/series-intro.png`, `${cardsDir}/series-intro.mp4`, {
  label: series.label, home: series.home, away: series.away,
  bestOf: series.bestOf, scheduledAt: series.scheduledAt, footer: series.footer,
});

makeSeriesFinalCard(`${cardsDir}/series-final.png`, `${cardsDir}/series-final.mp4`, {
  home: series.home, away: series.away,
  seriesScore: series.seriesScore ?? seriesScoreAfter(seriesRows),
  games: seriesRows, footer: series.footer,
});
console.log('  ✓ series-intro.mp4, series-final.mp4');

const REEL = `${OUT_DIR}/match-highlights.mp4`;
console.log('\nStitching series reel...');
stitchWithDissolve([`${cardsDir}/series-intro.mp4`, ...games.map(g => g.reelPath), `${cardsDir}/series-final.mp4`], REEL, DISSOLVE_SEC);

console.log(`\n✓ ${REEL}  (~${fmtSec(getVideoDurationSec(REEL))})`);
console.log(`  open "${REEL}"`);
