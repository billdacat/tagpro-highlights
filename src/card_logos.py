"""Team logo handling shared by the card renderers.

Logos come from mltp.gg in whatever form the team uploaded: some are transparent
PNGs, some are opaque square images.  Transparent logos are trimmed and shown as
they are; opaque ones are shown as a rounded tile so they read as a badge rather
than a pasted rectangle.
"""
from PIL import Image, ImageDraw, ImageFilter


def load_logo(path, size):
    """Return an RGBA image no larger than size x size, or None if unusable."""
    if not path:
        return None
    try:
        im = Image.open(path).convert('RGBA')
    except Exception:
        return None
    size = int(size)
    alpha = im.getchannel('A')
    clear = sum(alpha.histogram()[:128]) / float(im.width * im.height)

    if clear > 0.02:                                   # has real transparency
        box = alpha.getbbox()
        if box:
            im = im.crop(box)
        k = size / float(max(im.size))
        return im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)

    side = min(im.size)                                # opaque: square tile, rounded
    left, top = (im.width - side) // 2, (im.height - side) // 2
    im = im.crop((left, top, left + side, top + side)).resize((size, size), Image.LANCZOS)
    ss = 4                                             # supersample the mask for clean corners
    mask = Image.new('L', (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=int(size * ss * 0.17), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    im.putalpha(mask)
    edge = Image.new('RGBA', (size * ss, size * ss), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=int(size * ss * 0.17),
                                           outline=(255, 255, 255, 70), width=max(1, int(size * ss * 0.012)))
    im.alpha_composite(edge.resize((size, size), Image.LANCZOS))
    return im


def paste_logo(img, path, cx, cy, size, shadow=True):
    """Draw the logo centred on (cx, cy), in the image's own pixel units.  Returns True if drawn."""
    logo = load_logo(path, size)
    if logo is None:
        return False
    x, y = int(round(cx - logo.width / 2)), int(round(cy - logo.height / 2))
    if shadow:
        pad = int(size * 0.25)
        sh = Image.new('RGBA', (logo.width + pad * 2, logo.height + pad * 2), (0, 0, 0, 0))
        blk = Image.new('RGBA', logo.size, (0, 0, 0, 150))
        blk.putalpha(logo.getchannel('A').point(lambda v: int(v * 0.6)))
        sh.alpha_composite(blk, (pad, pad + int(size * 0.035)))
        sh = sh.filter(ImageFilter.GaussianBlur(size * 0.06))
        img.alpha_composite(sh, (x - pad, y - pad))
    img.alpha_composite(logo, (x, y))
    return True


def readable(rgb, floor=95):
    """Team colours are chosen for a light website; near-black ones vanish on a dark
    card.  Lift those to a light neutral so names and accents stay visible.  The test
    is the brightest channel, not perceived brightness, so a saturated red or blue
    (dim by luminance, but perfectly visible) keeps its colour."""
    if max(rgb) < floor:
        return (214, 218, 228)
    return rgb
