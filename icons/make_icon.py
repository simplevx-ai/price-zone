"""AI 마켓 스캐너 앱 아이콘(옛 이름 가격 위치) — 남색→보라 그라데이션, 흰·빨강 캔들 + 노란 검토 구간 띠,
오른쪽 위 돋보기(스캐너)와 'AI' 표시, 아래 'AI 마켓 스캐너'.
사용: python make_icon.py OUT_DIR"""
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
FONT = r'C:\Windows\Fonts\malgunbd.ttf'
C1, C2 = (16, 28, 74), (109, 40, 217)
UP, DOWN, BAND, LENS = (255, 107, 107), (255, 255, 255), (255, 200, 61), (94, 234, 212)


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
    d.rounded_rectangle([X(10), X(52), X(70), X(62)], radius=3 * u, fill=BAND + (235,))
    # 캔들: (x, 시가, 종가, 고가, 저가) — 화면 좌표는 값이 작을수록 위
    cs = [(16, 34, 44, 30, 48), (27, 44, 54, 40, 58), (38, 54, 60, 50, 63), (49, 59, 52, 48, 62), (60, 52, 40, 36, 55)]
    for x, op, cl, hi, lo in cs:
        col = UP if cl < op else DOWN
        d.line([(X(x), X(hi)), (X(x), X(lo))], fill=col, width=max(2, int(1.6 * u)))
        d.rounded_rectangle([X(x - 3.6), X(min(op, cl)), X(x + 3.6), X(max(op, cl))], radius=1.2 * u, fill=col)
    # 돋보기(스캐너)
    cx, cy, r = 72, 30, 15
    d.ellipse([X(cx - r), X(cy - r), X(cx + r), X(cy + r)], outline=LENS + (255,), width=max(3, int(3.2 * u)), fill=C1 + (235,))
    d.line([(X(cx + r * 0.7), X(cy + r * 0.7)), (X(cx + r * 1.35), X(cy + r * 1.35))], fill=LENS + (255,), width=max(4, int(4.5 * u)))
    fa = ImageFont.truetype(FONT, int(12 * u))
    d.text((X(cx), X(cy)), 'AI', font=fa, fill=(255, 255, 255), anchor='mm')
    # 이름
    f = ImageFont.truetype(FONT, int(11.5 * u))
    d.text((S / 2, o + 84 * u), 'AI 마켓 스캐너', font=f, fill=(255, 255, 255), anchor='mm')
    if not maskable:
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
        im.putalpha(m)
    return im


for name, size, mask in (('icon-192.png', 192, False), ('icon-512.png', 512, False), ('icon-maskable-512.png', 512, True)):
    draw(size * 3, mask).resize((size, size), Image.LANCZOS).save(f'{OUT}/{name}', optimize=True)
print('ok')
