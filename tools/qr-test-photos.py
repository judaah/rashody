"""«Фото чека» с QR покупки разной сложности — для проверки распознавания с фото.

    python3 tools/qr-test-photos.py dist/__test__

Нужен purchase.png из tools/qr-test-images.mjs. На 26.10.2026 qr-scanner распознаёт всё,
кроме photo-small-blurry (QR 170 px и сильное размытие) — это ожидаемая граница.
"""

import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else 'dist/__test__'
qr = Image.open(f'{out}/purchase.png').convert('RGB')
font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Courier New.ttf', 30)
lines = ['ООО «ПРОДУКТЫ У ДОМА»', 'КАССОВЫЙ ЧЕК', 'Молоко 3,2%      89.90', 'Хлеб бородинский 64.00',
         'Сыр 200 г       459.00', 'Яблоки 1.2 кг   238.80', 'ИТОГ           1342.50', 'ФН 7380440700076549']

# имя, угол QR (°), размытие (px), размер QR (px) в кадре 1080×1920
cases = [
    ('photo-easy', 6, 0.8, 300),
    ('photo-tilted', 14, 1.2, 230),
    ('photo-small-sharp', 4, 0.8, 170),
    ('photo-mid-blurry', 6, 2.0, 230),
    ('photo-small-blurry', 4, 2.2, 170),
]

for name, angle, blur, size in cases:
    paper = Image.new('RGB', (700, 1700), '#f6f3ea')
    draw = ImageDraw.Draw(paper)
    for i, text in enumerate(lines):
        draw.text((40, 60 + i * 64), text, fill='#3a3a3a', font=font)
    code = qr.resize((size, size), Image.NEAREST).rotate(angle, expand=True, fillcolor='#f6f3ea')
    paper.paste(code, ((700 - code.width) // 2, 1100))
    photo = Image.new('RGB', (1080, 1920), '#b9b3a6')
    photo.paste(paper.rotate(-3, expand=True, fillcolor='#b9b3a6'), (150, 80))
    photo.filter(ImageFilter.GaussianBlur(blur)).save(f'{out}/{name}.jpg', quality=70)
    print(f'{out}/{name}.jpg — QR {size}px, угол {angle}°, размытие {blur}')
