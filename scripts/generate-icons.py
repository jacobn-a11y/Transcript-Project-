#!/usr/bin/env python3
"""
Generate Noo-noo (Teletubbies vacuum cleaner) app icons in all required formats.

Noo-noo is a round, friendly blue-green vacuum cleaner with:
- A dome-shaped body
- A long trunk/nozzle
- Two expressive eyes on stalks
- Wheels underneath
"""

import math
import os
import struct
from PIL import Image, ImageDraw

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
BUILD_DIR = os.path.join(PROJECT_DIR, "build")
PUBLIC_DIR = os.path.join(PROJECT_DIR, "public")


def draw_noonoo(size):
    """Draw a stylized Noo-noo icon at the given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Scale factor relative to 512
    s = size / 512.0

    # Colors - Noo-noo is a blue-green/teal color
    body_color = (64, 160, 180)       # Teal body
    body_dark = (45, 130, 150)        # Darker shade
    body_highlight = (100, 195, 210)  # Highlight
    nozzle_color = (55, 140, 160)     # Nozzle
    nozzle_tip = (75, 170, 190)       # Nozzle tip
    eye_white = (245, 248, 250)
    eye_pupil = (30, 30, 35)
    eye_shine = (255, 255, 255)
    stalk_color = (55, 140, 160)
    wheel_color = (50, 55, 65)
    wheel_highlight = (80, 85, 95)
    mouth_color = (45, 120, 140)
    bg_circle = (52, 140, 158)        # Background accent

    cx, cy = size / 2, size / 2

    # --- Background circle (subtle) ---
    pad = int(10 * s)
    draw.ellipse(
        [pad, pad, size - pad, size - pad],
        fill=(235, 248, 252),
    )

    # --- Wheels ---
    wheel_y = int(390 * s)
    wheel_r = int(28 * s)
    # Left wheel
    draw.ellipse(
        [int(150 * s) - wheel_r, wheel_y - wheel_r,
         int(150 * s) + wheel_r, wheel_y + wheel_r],
        fill=wheel_color,
    )
    draw.ellipse(
        [int(150 * s) - int(12 * s), wheel_y - int(12 * s),
         int(150 * s) + int(12 * s), wheel_y + int(12 * s)],
        fill=wheel_highlight,
    )
    # Right wheel
    draw.ellipse(
        [int(360 * s) - wheel_r, wheel_y - wheel_r,
         int(360 * s) + wheel_r, wheel_y + wheel_r],
        fill=wheel_color,
    )
    draw.ellipse(
        [int(360 * s) - int(12 * s), wheel_y - int(12 * s),
         int(360 * s) + int(12 * s), wheel_y + int(12 * s)],
        fill=wheel_highlight,
    )

    # --- Main body (dome shape) ---
    body_left = int(100 * s)
    body_right = int(412 * s)
    body_top = int(180 * s)
    body_bottom = int(390 * s)

    # Body ellipse (main dome)
    draw.ellipse(
        [body_left, body_top, body_right, body_bottom],
        fill=body_color,
    )

    # Top dome (rounder on top)
    dome_top = int(150 * s)
    draw.ellipse(
        [int(120 * s), dome_top, int(392 * s), int(310 * s)],
        fill=body_color,
    )

    # Highlight on dome
    draw.ellipse(
        [int(150 * s), int(170 * s), int(330 * s), int(270 * s)],
        fill=body_highlight,
    )

    # --- Nozzle / Trunk (signature vacuum hose) ---
    # The trunk extends from the right side of the body, curving down
    trunk_points = []
    trunk_start_x = int(370 * s)
    trunk_start_y = int(250 * s)

    # Draw trunk as a curved thick line using polygon
    # Upper edge of trunk
    upper = []
    lower = []
    steps = 30
    for i in range(steps + 1):
        t = i / steps
        # Curve from body to the right and slightly down
        x = trunk_start_x + t * int(100 * s) + math.sin(t * 2.5) * int(15 * s)
        y = trunk_start_y - int(40 * s) * t + math.sin(t * 3.5) * int(25 * s)
        thickness = int((18 - 6 * t) * s)  # Tapers from thick to thin
        upper.append((x, y - thickness))
        lower.append((x, y + thickness))

    lower.reverse()
    trunk_poly = upper + lower
    draw.polygon(trunk_poly, fill=nozzle_color)

    # Nozzle tip (suction end) - small oval at the end
    tip_x = upper[-1][0]
    tip_y = (upper[-1][1] + lower[0][1]) / 2
    tip_r = int(12 * s)
    draw.ellipse(
        [tip_x - tip_r, tip_y - int(8 * s), tip_x + tip_r + int(5 * s), tip_y + int(8 * s)],
        fill=nozzle_tip,
    )

    # --- Eye stalks ---
    stalk_width = int(10 * s)

    # Left eye stalk
    left_eye_x = int(195 * s)
    left_eye_base_y = int(185 * s)
    left_eye_top_y = int(115 * s)
    draw.rectangle(
        [left_eye_x - stalk_width // 2, left_eye_top_y,
         left_eye_x + stalk_width // 2, left_eye_base_y],
        fill=stalk_color,
    )

    # Right eye stalk
    right_eye_x = int(310 * s)
    right_eye_base_y = int(185 * s)
    right_eye_top_y = int(105 * s)
    draw.rectangle(
        [right_eye_x - stalk_width // 2, right_eye_top_y,
         right_eye_x + stalk_width // 2, right_eye_base_y],
        fill=stalk_color,
    )

    # --- Eyes ---
    eye_r = int(32 * s)
    pupil_r = int(14 * s)
    shine_r = int(6 * s)

    # Left eye
    draw.ellipse(
        [left_eye_x - eye_r, left_eye_top_y - eye_r,
         left_eye_x + eye_r, left_eye_top_y + eye_r],
        fill=eye_white,
        outline=body_dark,
        width=max(1, int(2 * s)),
    )
    # Pupil (looking slightly right and down for personality)
    px, py = left_eye_x + int(5 * s), left_eye_top_y + int(4 * s)
    draw.ellipse(
        [px - pupil_r, py - pupil_r, px + pupil_r, py + pupil_r],
        fill=eye_pupil,
    )
    # Shine
    sx, sy = px - int(5 * s), py - int(5 * s)
    draw.ellipse(
        [sx - shine_r, sy - shine_r, sx + shine_r, sy + shine_r],
        fill=eye_shine,
    )

    # Right eye
    draw.ellipse(
        [right_eye_x - eye_r, right_eye_top_y - eye_r,
         right_eye_x + eye_r, right_eye_top_y + eye_r],
        fill=eye_white,
        outline=body_dark,
        width=max(1, int(2 * s)),
    )
    # Pupil
    px2, py2 = right_eye_x + int(5 * s), right_eye_top_y + int(4 * s)
    draw.ellipse(
        [px2 - pupil_r, py2 - pupil_r, px2 + pupil_r, py2 + pupil_r],
        fill=eye_pupil,
    )
    # Shine
    sx2, sy2 = px2 - int(5 * s), py2 - int(5 * s)
    draw.ellipse(
        [sx2 - shine_r, sy2 - shine_r, sx2 + shine_r, sy2 + shine_r],
        fill=eye_shine,
    )

    # --- Smile / mouth area ---
    mouth_y = int(310 * s)
    mouth_w = int(60 * s)
    draw.arc(
        [int(cx) - mouth_w, mouth_y - int(20 * s),
         int(cx) + mouth_w, mouth_y + int(25 * s)],
        start=0, end=180,
        fill=mouth_color,
        width=max(1, int(4 * s)),
    )

    # --- Bumper strip on body ---
    bumper_y = int(350 * s)
    draw.rectangle(
        [int(115 * s), bumper_y, int(397 * s), bumper_y + int(10 * s)],
        fill=body_dark,
    )

    return img


def create_ico(images, output_path):
    """Create an ICO file from a list of PIL Images."""
    # Save using Pillow's built-in ICO support
    # The first image should be the largest
    largest = max(images, key=lambda im: im.size[0])
    others = [im for im in images if im is not largest]
    largest.save(output_path, format="ICO", append_images=others,
                 sizes=[(im.size[0], im.size[1]) for im in images])


def main():
    os.makedirs(BUILD_DIR, exist_ok=True)
    os.makedirs(PUBLIC_DIR, exist_ok=True)

    print("Generating Noo-noo icons...")

    # Generate at various sizes
    sizes = [512, 256, 128, 64, 48, 32, 16]
    images = {}
    for sz in sizes:
        images[sz] = draw_noonoo(sz)
        print(f"  Drew {sz}x{sz}")

    # Save main PNG (512x512 for Linux / general use)
    icon_png_path = os.path.join(BUILD_DIR, "icon.png")
    images[512].save(icon_png_path, "PNG")
    print(f"  Saved {icon_png_path}")

    # Save 256x256 PNG (for Electron window icon)
    icon_256_path = os.path.join(BUILD_DIR, "icon-256.png")
    images[256].save(icon_256_path, "PNG")
    print(f"  Saved {icon_256_path}")

    # Save ICO (for Windows and favicon)
    ico_sizes = [256, 128, 64, 48, 32, 16]
    ico_images = [images[sz] for sz in ico_sizes]

    icon_ico_path = os.path.join(BUILD_DIR, "icon.ico")
    create_ico(ico_images, icon_ico_path)
    print(f"  Saved {icon_ico_path}")

    # Save favicon.ico (32x32 and 16x16)
    favicon_images = [images[32], images[16]]
    favicon_path = os.path.join(PUBLIC_DIR, "favicon.ico")
    create_ico([images[48], images[32], images[16]], favicon_path)
    print(f"  Saved {favicon_path}")

    # Save favicon PNG for modern browsers
    favicon_png_path = os.path.join(PUBLIC_DIR, "favicon-32.png")
    images[32].save(favicon_png_path, "PNG")
    print(f"  Saved {favicon_png_path}")

    # Save apple-touch-icon (180x180)
    apple_icon = draw_noonoo(180)
    apple_path = os.path.join(PUBLIC_DIR, "apple-touch-icon.png")
    apple_icon.save(apple_path, "PNG")
    print(f"  Saved {apple_path}")

    print("\nAll icons generated successfully!")


if __name__ == "__main__":
    main()
