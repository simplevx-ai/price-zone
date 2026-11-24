"""가격 위치 앱 아이콘 — 평면 디자인: 남색→청록 그라데이션, 흰 캔들, 노란 검토 구간 띠, 아래 '가격 위치'.
사용: python make_icon.py OUT_DIR"""
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
FONT = r'C:\Windows\Fonts\malgunbd.ttf'
C1, C2 = (30, 64, 175), (20, 184, 166)
UP, DOWN, BAND = (255, 107, 107), (255, 255, 255), (255, 200, 61)


def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw(S, maskable):
    g = Image.new('RGB', (64, 64))
    px = g.load()
    for y in range(64):
        for x in range(64):
            px[x, y] = lerp(C1, C2, (x + y) / 126)
    im = g.resize((S, S), Image.BICUBIC).convert('RGBA')
    d = ImageDraw.Draw(im, 'RGBA')
    k = 0.70 if maskable else 1.0
    u = S * k / 100; o = (S - S * k) / 2
    X = lambda v: o + v * u
    # 검토 구간 띠
    d.rounded_rectangle([X(14), X(50), X(86), X(62)], radius=3 * u, fill=BAND + (235,))
    # 캔들: (x, 시가, 종가, 고가, 저가)
    cs = [(20, 30, 40, 26, 44), (31, 40, 50, 36, 55), (42, 50, 58, 46, 61), (53, 57, 52, 49, 60), (64, 51, 40, 37, 54), (75, 40, 28, 24, 43)]
    for x, op, cl, hi, lo in cs:
        col = UP if cl < op else DOWN  # 화면 좌표: 값이 작을수록 위 = 상승
        d.line([(X(x), X(hi)), (X(x), X(lo))], fill=col, width=max(2, int(1.6 * u)))
        d.rounded_rectangle([X(x - 3.6), X(min(op, cl)), X(x + 3.6), X(max(op, cl))], radius=1.2 * u, fill=col)
    f = ImageFont.truetype(FONT, int(13.5 * u))
    d.text((S / 2, o + 84 * u), '가격 위치', font=f, fill=(255, 255, 255), anchor='mm')
    if not maskable:
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
        im.putalpha(m)
    return im


for name, size, mask in (('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)):
    draw(size * 3, mask).resize((size, size), Image.LANCZOS).save(f'{OUT}/{name}', optimize=True)
print('ok')
