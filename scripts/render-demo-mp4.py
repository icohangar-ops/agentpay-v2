#!/usr/bin/env python3
"""Render the AgentPay v2 asciinema cast as an MP4 video using pyte + ffmpeg.

Pipeline:
  1. Parse the .cast file (JSONL: header line + [timestamp, "o", text] events)
  2. Use pyte to simulate an 80x24 terminal, applying events in order
  3. At sampled intervals (15 fps), render the terminal screen as a PNG frame
  4. Pipe the PNG sequence to ffmpeg to produce the final MP4

Output: /home/z/my-project/download/agentpay-v2-demo.mp4
"""

import asyncio
import html
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pyte
from playwright.async_api import async_playwright

CAST_PATH = "/home/z/my-project/download/agentpay-v2-demo.cast"
OUTPUT_PATH = "/home/z/my-project/download/agentpay-v2-demo.mp4"
FRAMES_DIR = "/home/z/my-project/agentpay-v2/scripts/_frames"

# Video params
FPS = 15
WIDTH_CHARS = 80   # cast header says 80
HEIGHT_CHARS = 24  # cast header says 24
SCALE = 1          # terminal pixel scale (we render at high DPI via Playwright)
PX_PER_CHAR_X = 9   # font width (monospace 14px)
PX_PER_CHAR_Y = 18  # font line height
PADDING_X = 24
PADDING_Y = 24


def parse_cast(path: str):
    """Parse an asciinema v2 cast file. Returns (header, events)."""
    with open(path, "r", encoding="utf-8") as f:
        header = json.loads(f.readline())
        events = []
        for line in f:
            line = line.strip()
            if not line:
                continue
            events.append(json.loads(line))
    return header, events


def render_terminal_html(screen: pyte.Screen, cursor_pos=None) -> str:
    """Render a pyte screen to HTML with inline-styled spans for colors."""
    # pyte character style: each char has a foreground/background color
    # based on SGR (color) escape codes
    rows = []
    for y, line in enumerate(screen.display):
        # Build line as a sequence of styled spans
        spans = []
        current_style = None
        current_text = ""
        for x, char in enumerate(line):
            char_def = screen.buffer[y][x]
            fg = char_def.fg if hasattr(char_def, "fg") else "default"
            bg = char_def.bg if hasattr(char_def, "bg") else "default"
            bold = char_def.bold if hasattr(char_def, "bold") else False
            style = (fg, bg, bold)
            if style != current_style and current_text:
                spans.append((current_style, current_text))
                current_text = ""
            current_style = style
            current_text += char
        if current_text:
            spans.append((current_style, current_text))

        # Convert to HTML
        line_html = ""
        for (fg, bg, bold), text in spans:
            text = html.escape(text.rstrip("\x00")) or "&nbsp;"
            css_parts = []
            if fg and fg != "default":
                css_parts.append(f"color: {normalize_color(fg)}")
            if bg and bg != "default":
                css_parts.append(f"background: {normalize_color(bg)}")
            if bold:
                css_parts.append("font-weight: 700")
            style_attr = f' style="{"; ".join(css_parts)}"' if css_parts else ""
            line_html += f"<span{style_attr}>{text}</span>"
        rows.append(f'<div class="row">{line_html if line_html else "&nbsp;"}</div>')

    # Cursor block (optional)
    cursor_html = ""
    if cursor_pos:
        cx, cy = cursor_pos
        cursor_html = (
            f'<div class="cursor" style="left: {cx * PX_PER_CHAR_X}px; top: {cy * PX_PER_CHAR_Y}px;"></div>'
        )

    return "\n".join(rows) + cursor_html


def normalize_color(c) -> str:
    """Convert pyte color name/hex to CSS color."""
    if not c or c == "default":
        return "#CBD5E1"
    if isinstance(c, str):
        # pyte uses names like "gray", "red", "brightcyan", or hex like "#RRGGBB"
        color_map = {
            "black": "#0F172A",
            "red": "#EF4444",
            "green": "#34D399",
            "brown": "#D97706",
            "yellow": "#FBBF24",
            "blue": "#60A5FA",
            "magenta": "#F472B6",
            "cyan": "#22D3EE",
            "white": "#E5E7EB",
            "default": "#CBD5E1",
            "brightblack": "#475569",
            "brightred": "#F87171",
            "brightgreen": "#4ADE80",
            "brightbrown": "#FBBF24",
            "brightyellow": "#FCD34D",
            "brightblue": "#93C5FD",
            "brightmagenta": "#F9A8D4",
            "brightcyan": "#67E8F9",
            "brightwhite": "#F8FAFC",
        }
        if c.startswith("#"):
            return c
        return color_map.get(c, "#CBD5E1")
    return "#CBD5E1"


def build_full_html(body_html: str, terminal_width_px: int, terminal_height_px: int) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    background: #0B1018;
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: {PX_PER_CHAR_Y}px;
    padding: 0;
    margin: 0;
  }}
  #root {{
    background: #0B1018;
    border: 1px solid #1E293B;
    border-radius: 8px;
    padding: {PADDING_Y}px {PADDING_X}px;
    width: {terminal_width_px + 2 * PADDING_X}px;
    height: {terminal_height_px + 2 * PADDING_Y}px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    position: relative;
    overflow: hidden;
  }}
  .topbar {{
    position: absolute;
    top: 8px;
    left: 16px;
    right: 16px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #64748B;
    pointer-events: none;
  }}
  .topbar .dot {{
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }}
  .topbar .dot.r {{ background: #EF4444; }}
  .topbar .dot.y {{ background: #F59E0B; }}
  .topbar .dot.g {{ background: #10B981; }}
  .topbar .title {{
    margin-left: 8px;
    color: #94A3B8;
    font-weight: 600;
  }}
  .topbar .meta {{
    margin-left: auto;
    color: #475569;
    font-size: 10px;
  }}
  .terminal {{
    margin-top: 28px;
    position: relative;
    color: #CBD5E1;
    white-space: pre;
    font-family: inherit;
    font-size: 13px;
    line-height: {PX_PER_CHAR_Y}px;
    letter-spacing: 0;
  }}
  .row {{
    height: {PX_PER_CHAR_Y}px;
    overflow: hidden;
  }}
  .cursor {{
    position: absolute;
    width: {PX_PER_CHAR_X}px;
    height: {PX_PER_CHAR_Y}px;
    background: rgba(255,255,255,0.4);
    pointer-events: none;
  }}
</style>
</head>
<body>
<div id="root">
  <div class="topbar">
    <span class="dot r"></span>
    <span class="dot y"></span>
    <span class="dot g"></span>
    <span class="title">agentpay-v2@treasury: bun run scripts/demo-treasury.ts</span>
    <span class="meta">casper-test · GLM-4.6</span>
  </div>
  <div class="terminal">
{body_html}
  </div>
</div>
</body>
</html>
"""


async def render_frames():
    """Render cast events into PNG frames in FRAMES_DIR."""
    header, events = parse_cast(CAST_PATH)
    width = header.get("width", WIDTH_CHARS)
    height = header.get("height", HEIGHT_CHARS)
    print(f"Cast: {width}x{height}, {len(events)} events, title='{header.get('title')}'")

    # Simulate terminal
    screen = pyte.Screen(width, height)
    stream = pyte.Stream(screen)

    terminal_w_px = width * PX_PER_CHAR_X
    terminal_h_px = height * PX_PER_CHAR_Y

    Path(FRAMES_DIR).mkdir(parents=True, exist_ok=True)
    # Clear existing frames
    for f in Path(FRAMES_DIR).glob("*.png"):
        f.unlink()

    # Sample frame times: every 1/FPS seconds
    total_duration = events[-1][0] if events else 0
    print(f"Total duration: {total_duration:.2f}s → {int(total_duration * FPS) + 1} frames")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            viewport={
                "width": terminal_w_px + 2 * PADDING_X + 4,
                "height": terminal_h_px + 2 * PADDING_Y + 4,
            },
            device_scale_factor=1,
        )

        # Walk through events, rendering a frame at each 1/FPS tick
        frame_idx = 0
        next_frame_time = 0.0
        event_idx = 0
        # Apply events up to current time, then render

        while next_frame_time <= total_duration + 0.5:
            # Apply all events up to next_frame_time
            while event_idx < len(events) and events[event_idx][0] <= next_frame_time:
                _, etype, text = events[event_idx]
                if etype == "o":
                    try:
                        stream.feed(text)
                    except Exception as e:
                        # pyte can choke on some escape sequences — skip
                        pass
                event_idx += 1

            # Render current state
            body_html = render_terminal_html(screen)
            full_html = build_full_html(body_html, terminal_w_px, terminal_h_px)
            html_path = Path(FRAMES_DIR) / f"frame_{frame_idx:05d}.html"
            html_path.write_text(full_html, encoding="utf-8")

            await page.goto(f"file://{html_path}", wait_until="networkidle")
            el = page.locator("#root")
            png_path = Path(FRAMES_DIR) / f"frame_{frame_idx:05d}.png"
            await el.screenshot(path=str(png_path))

            frame_idx += 1
            next_frame_time = frame_idx / FPS

            if frame_idx % 30 == 0:
                print(f"  rendered frame {frame_idx}/{int(total_duration * FPS) + 1}")

        await browser.close()

    print(f"Rendered {frame_idx} frames to {FRAMES_DIR}")
    return frame_idx, total_duration


def encode_video(frame_count: int, fps: int = FPS):
    """Use ffmpeg to encode the PNG frames into MP4."""
    # Use libx264 with yuv420p for browser compatibility
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(fps),
        "-i", str(Path(FRAMES_DIR) / "frame_%05d.png"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-crf", "20",
        "-movflags", "+faststart",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",  # ensure even dimensions
        OUTPUT_PATH,
    ]
    print(f"Running ffmpeg: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("ffmpeg STDERR:", result.stderr[-2000:])
        raise RuntimeError(f"ffmpeg failed with code {result.returncode}")
    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"✅ {OUTPUT_PATH} ({size_kb:.0f} KB)")


async def main():
    frame_count, duration = await render_frames()
    encode_video(frame_count, fps=FPS)
    # Cleanup HTML files
    for f in Path(FRAMES_DIR).glob("*.html"):
        f.unlink()


if __name__ == "__main__":
    asyncio.run(main())
