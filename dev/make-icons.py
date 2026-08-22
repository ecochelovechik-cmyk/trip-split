#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dev/make-icons.py — рисует иконки приложения «Кто кому должен».

Знак уже утверждён (см. эскиз в scratchpad/icon180.png): тёмный фон #0F2124,
две встречные горизонтальные стрелки — верхняя амбровая вправо, нижняя светлая
влево. Пропорции стрелок (толщина, длина, размер наконечника) сняты пиксельным
промером с эталонного эскиза, чтобы новые иконки выглядели так же, просто в
других разрешениях. Рисуем каждый размер заново (супersampling 4x + downscale),
а не растягиваем маленькую растровую картинку — так контур остаётся резким
и на 512x512.

Запуск: python dev/make-icons.py
Результат: docs/icon-192.png, docs/icon-512.png, docs/apple-touch-icon.png
"""

import os
from PIL import Image, ImageDraw

BG = (15, 33, 36)        # #0F2124
AMBER = (224, 169, 63)   # #E0A93F
LIGHT = (230, 238, 235)  # #E6EEEB

HERE = os.path.dirname(os.path.abspath(__file__))
DOCS_DIR = os.path.abspath(os.path.join(HERE, "..", "docs"))

# доли размера канвы (сняты промером эталонного icon180.png: бар x37..117 при
# толщине 13px и высоте наконечника 30px на канве 180 — то есть половина
# толщины бара 6.5/180, половина высоты наконечника 15/180 и т.д.)
BAR_HALF_H = 6.5 / 180.0
HEAD_HALF_H = 15.0 / 180.0
BAR_X0 = 37.0 / 180.0
BAR_X1 = 117.0 / 180.0
HEAD_X1 = 145.0 / 180.0
TOP_CY = 63.0 / 180.0
BOT_CY = 117.0 / 180.0
MARGIN_X = 35.0 / 180.0  # симметричный отступ для зеркальной (нижней) стрелки


def draw_arrow_right(draw, size, cy_frac, color):
    """Стрелка вправо: бар слева, треугольный наконечник справа."""
    cy = size * cy_frac
    bar_half = size * BAR_HALF_H
    head_half = size * HEAD_HALF_H
    x0 = size * BAR_X0
    x1 = size * BAR_X1
    x2 = size * HEAD_X1
    draw.rectangle([x0, cy - bar_half, x1, cy + bar_half], fill=color)
    draw.polygon([(x1, cy - head_half), (x2, cy), (x1, cy + head_half)], fill=color)


def draw_arrow_left(draw, size, cy_frac, color):
    """Стрелка влево — зеркало draw_arrow_right по горизонтали."""
    cy = size * cy_frac
    bar_half = size * BAR_HALF_H
    head_half = size * HEAD_HALF_H
    x0 = size * MARGIN_X
    bar_len = size * (BAR_X1 - BAR_X0)
    head_len = size * (HEAD_X1 - BAR_X1)
    x_tip = x0
    x_head_base = x0 + head_len
    x_bar_end = x_head_base + bar_len
    draw.polygon([(x_head_base, cy - head_half), (x_tip, cy), (x_head_base, cy + head_half)], fill=color)
    draw.rectangle([x_head_base, cy - bar_half, x_bar_end, cy + bar_half], fill=color)


def make_icon(size):
    scale = 4  # супersampling для гладких краёв
    big = size * scale
    img = Image.new("RGB", (big, big), BG)
    d = ImageDraw.Draw(img)
    draw_arrow_right(d, big, TOP_CY, AMBER)
    draw_arrow_left(d, big, BOT_CY, LIGHT)
    img = img.resize((size, size), Image.LANCZOS)
    return img


def main():
    os.makedirs(DOCS_DIR, exist_ok=True)
    targets = [
        (192, "icon-192.png"),
        (512, "icon-512.png"),
        (180, "apple-touch-icon.png"),
    ]
    for size, name in targets:
        img = make_icon(size)
        path = os.path.join(DOCS_DIR, name)
        img.save(path, "PNG")
        print(f"{name}: {img.size[0]}x{img.size[1]} -> {path}")


if __name__ == "__main__":
    main()
