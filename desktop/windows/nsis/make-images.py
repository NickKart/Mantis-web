#!/usr/bin/env python3
"""Картинки мастера установки Mantis-Setup.exe (NSIS, tauri.conf.json → bundle.windows.nsis).

  python3 desktop/windows/nsis/make-images.py   → sidebar.bmp (164×314) и header.bmp (150×57)

sidebar.bmp – полоса слева на первой и последней странице мастера: значок Mantis на тёмно-синем фоне.
header.bmp – картинка в шапке остальных страниц (справа): значок на белом.
NSIS понимает только 24-битные BMP без сжатия. Нужны Pillow и шрифт Inter (/usr/share/fonts/opentype/inter или INTER_DIR).
"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ICON = os.path.join(HERE, "..", "src-tauri", "icons", "icon.png")
FONT_DIR = os.environ.get("INTER_DIR", "/usr/share/fonts/opentype/inter")
TOP, BOTTOM = (16, 30, 70), (9, 15, 38)  # тот же тёмно-синий, что фон значка


def font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(os.path.join(FONT_DIR, f"Inter-{weight}.otf"), size)


def tile(size: int) -> Image.Image:
    """Значок со скруглёнными углами – как плитка приложения."""
    icon = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=size, fill=255)
    icon.putalpha(mask.resize((size, size), Image.LANCZOS))
    return icon


def sidebar() -> None:
    w, h = 164, 314
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    icon = tile(104)
    im.paste(icon, ((w - 104) // 2, 70), icon)
    for text, f, y, fill in ((("Mantis", font("Bold", 22), 190, (232, 237, 247))), ("Подсчёт посетителей", font("Regular", 12), 222, (154, 167, 194)), ("витрины", font("Regular", 12), 238, (154, 167, 194))):
        d.text(((w - d.textlength(text, font=f)) / 2, y), text, font=f, fill=fill)
    im.save(os.path.join(HERE, "sidebar.bmp"))


def header() -> None:
    w, h = 150, 57
    im = Image.new("RGB", (w, h), (255, 255, 255))
    icon = tile(44)
    im.paste(icon, (w - 44 - 8, (h - 44) // 2), icon)
    im.save(os.path.join(HERE, "header.bmp"))


if __name__ == "__main__":
    sidebar()
    header()
