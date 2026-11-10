#!/usr/bin/env python3
"""Фон окна установки Mantis.dmg: стрелка «перетащите в Программы» и подсказка для первого запуска.

  python3 desktop/macos/dmg/make-background.py   → background.png (660×470) и background@2x.png (1320×940)

Положения значков (центры) должны совпадать с tauri.conf.json → bundle.macOS.dmg:
приложение (170, 175), «Программы» (490, 175). Сборка (build.sh) склеивает обе картинки в background.tiff.
Нужны Pillow и шрифт Inter (/usr/share/fonts/opentype/inter или INTER_DIR).
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 660, 470  # снизу запас под заголовок окна Finder
APP, APPS, ICON_Y = (170, 175), (490, 175), 175
FONT_DIR = os.environ.get("INTER_DIR", "/usr/share/fonts/opentype/inter")

BG = (246, 248, 251)
INK = (31, 41, 55)
MUTED = (107, 114, 128)
BLUE = (74, 155, 216)


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(os.path.join(FONT_DIR, f"Inter-{weight}.otf"), size)


def center(d: ImageDraw.ImageDraw, y: float, text: str, f, fill, s: int) -> None:
    w = d.textlength(text, font=f)
    d.text(((W * s - w) / 2, y * s), text, font=f, fill=fill)


def draw(s: int) -> Image.Image:
    img = Image.new("RGB", (W * s, H * s), BG)
    d = ImageDraw.Draw(img)

    center(d, 26, "Перетащите Mantis в папку «Программы»", font("SemiBold", 20 * s), INK, s)

    # стрелка между значками
    x1, x2, y = (APP[0] + 70) * s, (APPS[0] - 70) * s, ICON_Y * s
    d.line([(x1, y), (x2 - 14 * s, y)], fill=BLUE, width=6 * s)
    d.polygon([(x2, y), (x2 - 22 * s, y - 14 * s), (x2 - 22 * s, y + 14 * s)], fill=BLUE)

    # подсказка для первого запуска
    top = 292
    d.rounded_rectangle([(36 * s, top * s), ((W - 36) * s, (top + 112) * s)], radius=14 * s, fill=(255, 255, 255), outline=(229, 231, 235), width=s)
    f_b, f = font("SemiBold", 13 * s), font("Regular", 13 * s)
    lines = [
        (f_b, INK, "Первый запуск"),
        (f, MUTED, "Если macOS пишет, что не может проверить разработчика:"),
        (f, MUTED, "«Системные настройки» → «Конфиденциальность и безопасность» →"),
        (f, MUTED, "внизу «Всё равно открыть». Это нужно сделать один раз."),
    ]
    yy = top + 14
    for fnt, col, text in lines:
        d.text((54 * s, yy * s), text, font=fnt, fill=col)
        yy += 22
    return img


if __name__ == "__main__":
    for s, name in ((1, "background.png"), (2, "background@2x.png")):
        img = draw(s)
        img.save(os.path.join(HERE, name), dpi=(72 * s, 72 * s))
        print(name, img.size)
