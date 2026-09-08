"""Runway logo and cover image.

The mark is the project's own claim, drawn: three streams committed at three
different rates (the faint continuations), all shed down to one floor line
(amber) that the keeper never crosses. That is literally what the live Sepolia
run produced -- three rates, three floors, nothing below.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent

BG = "#0b0d10"
CARD = "#14171b"
BORDER = "#2a2e33"
BRIGHT = "#6cb6ff"
FAINT = "#3a4653"
FLOOR = "#f0b429"
TEXT = "#e6e6e6"
MUTED = "#9aa3ad"

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuisb.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def font(size: int, bold_first: bool = True) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def draw_mark(d: ImageDraw.ImageDraw, x0: int, y0: int, size: int) -> None:
    """Draws the three-streams-to-a-floor mark inside a square box."""
    u = size / 100.0  # one unit = 1% of the box

    bar_h = int(11 * u)
    gap = int(9 * u)
    left = x0 + int(10 * u)
    floor_x = x0 + int(46 * u)
    committed = [int(88 * u), int(74 * u), int(63 * u)]  # critical, standard, discretionary

    total_h = 3 * bar_h + 2 * gap
    top = y0 + (size - total_h) // 2

    for i, width in enumerate(committed):
        y = top + i * (bar_h + gap)
        # what the treasury committed to: still visible, no longer paid
        d.rounded_rectangle(
            [left, y, x0 + width, y + bar_h], radius=bar_h // 2, fill=FAINT
        )
        # what the keeper decided to keep paying: down to the floor, never below
        d.rounded_rectangle(
            [left, y, floor_x, y + bar_h], radius=bar_h // 2, fill=BRIGHT
        )

    # the floor: the line the mandate stops at
    line_w = max(2, int(2.6 * u))
    d.rounded_rectangle(
        [
            floor_x - line_w // 2,
            top - int(6 * u),
            floor_x + line_w // 2 + line_w % 2,
            top + total_h + int(6 * u),
        ],
        radius=line_w,
        fill=FLOOR,
    )


def make_icon(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    inset = int(size * 0.035)
    d.rounded_rectangle(
        [inset, inset, size - inset - 1, size - inset - 1],
        radius=int(size * 0.19),
        fill=CARD,
        outline=BORDER,
        width=max(1, size // 256),
    )
    box = int(size * 0.74)
    draw_mark(d, (size - box) // 2, (size - box) // 2, box)
    return img


def make_cover(w: int = 1200, h: int = 630) -> Image.Image:
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([28, 28, w - 29, h - 29], radius=28, fill=CARD, outline=BORDER, width=2)

    box = 300
    draw_mark(d, 80, (h - box) // 2, box)

    x = 80 + box + 70
    d.text((x, 214), "Runway", font=font(84), fill=TEXT)
    d.text(
        (x, 322),
        "Who keeps getting paid when a",
        font=font(34),
        fill=MUTED,
    )
    d.text((x, 366), "treasury runs short.", font=font(34), fill=MUTED)
    d.text(
        (x, 428),
        "Superfluid streams, throttled by a keeper",
        font=font(27),
        fill=BRIGHT,
    )
    d.text((x, 464), "under a bounded on-chain mandate.", font=font(27), fill=BRIGHT)
    return img


for s in (1024, 512, 256):
    p = OUT / f"runway-logo-{s}.png"
    make_icon(s).save(p)
    print("wrote", p)

p = OUT / "runway-cover-1200x630.png"
make_cover().save(p)
print("wrote", p)
