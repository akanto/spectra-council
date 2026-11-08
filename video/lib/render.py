"""Draws the video's frames from edit.ts's plan and pipes them to ffmpeg.

Run by edit.ts: python -I render.py <plan.json> <out.mp4>. The plan is {fps, width, height, frames: [...]}, each frame
{layers: [{src, rect: [x, y, w, h], alpha}], black}: the layers are cropped to their rect (in the source's pixels), made
the output's size, laid over each other with their alpha, then darkened by black (0 to 1).
"""

import json
import subprocess
import sys

from PIL import Image

plan_path, out = sys.argv[1:3]
with open(plan_path) as file:
    plan = json.load(file)
width, height, fps = plan["width"], plan["height"], plan["fps"]

ffmpeg = subprocess.Popen(
    ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-r", str(fps), "-i", "-",
     "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
    stdin=subprocess.PIPE,
)

cache: dict[str, Image.Image] = {}


def source(path: str) -> Image.Image:
    if path not in cache:
        if len(cache) > 8:
            cache.pop(next(iter(cache)))
        cache[path] = Image.open(path).convert("RGB")
    return cache[path]


def layer(src: str, rect: list[float]) -> Image.Image:
    """The rect is in a 2560 x 1440 frame's pixels; a frame of another size is cropped in proportion."""
    image = source(src)
    kx, ky = image.width / 2560, image.height / 1440
    x, y, w, h = rect
    box = (max(0, x * kx), max(0, y * ky), min(image.width, (x + w) * kx), min(image.height, (y + h) * ky))
    return image.resize((width, height), Image.LANCZOS, box=box)


black = Image.new("RGB", (width, height))
for index, frame in enumerate(plan["frames"]):
    image = None
    for item in frame["layers"]:
        drawn = layer(item["src"], item["rect"])
        image = drawn if image is None or item["alpha"] >= 1 else Image.blend(image, drawn, item["alpha"])
    if image is None:
        image = black
    if frame["black"] > 0:
        image = Image.blend(image, black, frame["black"])
    ffmpeg.stdin.write(image.tobytes())
    if index % 300 == 0:
        print(f"frame {index}/{len(plan['frames'])}", file=sys.stderr, flush=True)

ffmpeg.stdin.close()
sys.exit(ffmpeg.wait())
