#!/usr/bin/env python3
"""Render the AgentPay demo transcript as a polished PNG image.

Takes the raw text output of `bun run scripts/demo-treasury.ts` and
renders it as a terminal-style screenshot with proper monospace styling,
syntax highlighting of key fields, and section dividers.

Output: /home/z/my-project/download/agentpay-demo.png
"""

import asyncio
import html
import os
import re
from pathlib import Path
from playwright.async_api import async_playwright

TRANSCRIPT_PATH = "/home/z/my-project/download/agentpay-demo-transcript.txt"
OUTPUT_PATH = "/home/z/my-project/download/agentpay-demo.png"
HTML_PATH = "/home/z/my-project/agentpay/scripts/_demo_render.html"

def colorize(line: str) -> str:
    """Apply minimal syntax highlighting to a single terminal line."""
    # Escape HTML first
    s = html.escape(line)

    # Box drawing header lines → cyan
    if line.startswith("╔") or line.startswith("╚") or line.startswith("║"):
        return f'<span class="box">{s}</span>'

    # Scenario dividers
    if line.startswith("──"):
        return f'<span class="div">{s}</span>'
    if "SCENARIO:" in line:
        return f'<span class="scenario">{s}</span>'
    if line.startswith("SCENARIO"):
        return f'<span class="scenario">{s}</span>'

    # Section headers (uppercase lines without colons)
    if re.match(r"^[A-Z][A-Z ]{6,}$", line.strip()):
        return f'<span class="hdr">{s}</span>'

    # Key verdict words
    s_color = s
    s_color = re.sub(r"\bAPPROVE\b", '<span class="v-approve">APPROVE</span>', s_color)
    s_color = re.sub(r"\bDENY\b",    '<span class="v-deny">DENY</span>',       s_color)
    s_color = re.sub(r"\bDEFER\b",   '<span class="v-defer">DEFER</span>',     s_color)
    s_color = re.sub(r"\bCOUNTER\b", '<span class="v-counter">COUNTER</span>', s_color)

    # Source labels (after verdict in audit log)
    s_color = re.sub(
        r"(AUTO_APPROVE_POLICY|AUTO_DENY_BLOCKED|AUTO_DENY_BUDGET|AUTO_DENY_BALANCE|LLM_REVIEW|LLM_PARSE_ERROR)",
        r'<span class="src">\1</span>',
        s_color,
    )

    # Highlight CSPR amounts
    s_color = re.sub(
        r"(\d+\.\d{4,6})\s+CSPR",
        r'<span class="amount">\1 CSPR</span>',
        s_color,
    )

    # Highlight hashes (64-char hex)
    s_color = re.sub(
        r"\b([0-9a-f]{64})\b",
        r'<span class="hash">\1</span>',
        s_color,
    )

    # Highlight uref- and account-hash- prefixes
    s_color = re.sub(
        r"(uref-[0-9a-f]+-\d{3}|account-hash-[0-9a-f]{64})",
        r'<span class="addr">\1</span>',
        s_color,
    )

    # Labels (Verdict:, Source:, Amount:, etc.)
    s_color = re.sub(
        r"^(\s*)(Verdict|Source|Approved amount|Counter amount|Rationale|Next step|Service|Recipient|Amount|From|Body hash|Deploy hash|Source purse|Target purse|Chain|TTL|Timestamp|Approvals|Mode|Note|Block Hash|State Root Hash|Account Hash|Main Purse|Associated Keys|Balance|Public Key|Computed|Expected):\s*",
        r'\1<span class="label">\2:</span> ',
        s_color,
    )

    return s_color


def build_html(transcript: str) -> str:
    lines = transcript.rstrip().split("\n")
    rendered = "\n".join(colorize(line) for line in lines)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    background: #0F172A;
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    padding: 30px 40px;
  }}
  #root {{
    background: #0B1018;
    border: 1px solid #1E293B;
    border-radius: 8px;
    padding: 24px 28px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  }}
  .topbar {{
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 14px;
    margin-bottom: 16px;
    border-bottom: 1px solid #1E293B;
    font-size: 12px;
    color: #64748B;
  }}
  .topbar .dot {{
    width: 11px;
    height: 11px;
    border-radius: 50%;
    display: inline-block;
  }}
  .topbar .dot.r {{ background: #EF4444; }}
  .topbar .dot.y {{ background: #F59E0B; }}
  .topbar .dot.g {{ background: #10B981; }}
  .topbar .title {{
    margin-left: 12px;
    color: #94A3B8;
    font-weight: 600;
  }}
  .topbar .meta {{
    margin-left: auto;
    color: #475569;
    font-size: 11px;
  }}
  pre {{
    font-family: inherit;
    font-size: 11px;
    line-height: 1.55;
    color: #CBD5E1;
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: anywhere;
  }}

  /* Highlight classes */
  .box       {{ color: #06B6D4; font-weight: 600; }}
  .div       {{ color: #475569; }}
  .scenario  {{ color: #FBBF24; font-weight: 700; }}
  .hdr       {{ color: #E2E8F0; font-weight: 700; }}
  .label     {{ color: #818CF8; font-weight: 600; }}
  .amount    {{ color: #34D399; font-weight: 600; }}
  .hash      {{ color: #F472B6; }}
  .addr      {{ color: #22D3EE; }}
  .src       {{ color: #A78BFA; font-weight: 600; font-size: 10px; padding: 0 4px; border: 1px solid #4C1D95; border-radius: 3px; }}
  .v-approve {{ color: #34D399; font-weight: 700; }}
  .v-deny    {{ color: #F87171; font-weight: 700; }}
  .v-defer   {{ color: #FBBF24; font-weight: 700; }}
  .v-counter {{ color: #C084FC; font-weight: 700; }}

  /* Footer */
  .footer {{
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid #1E293B;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: #475569;
  }}
</style>
</head>
<body>
<div id="root">
  <div class="topbar">
    <span class="dot r"></span>
    <span class="dot y"></span>
    <span class="dot g"></span>
    <span class="title">agentpay@treasury: bun run scripts/demo-treasury.ts</span>
    <span class="meta">casper-test · GLM-4.6 · 2026-07-17</span>
  </div>
  <pre>{rendered}</pre>
  <div class="footer">
    <span>Treasury · 02028689d1…f912fcf0b9 · secp256k1</span>
    <span>5000 CSPR funded · 4 scenarios · 13s runtime</span>
  </div>
</div>
</body>
</html>
"""


async def main():
    transcript = Path(TRANSCRIPT_PATH).read_text(encoding="utf-8")
    html_content = build_html(transcript)
    Path(HTML_PATH).write_text(html_content, encoding="utf-8")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            viewport={"width": 1400, "height": 2400},
            device_scale_factor=2,
        )
        await page.goto(f"file://{HTML_PATH}", wait_until="networkidle")
        await page.wait_for_timeout(400)

        el = page.locator("#root")
        bbox = await el.bounding_box()
        if bbox:
            fit_w = max(1400, int(bbox["width"] + 80))
            fit_h = int(bbox["height"] + 80)
            await page.set_viewport_size({"width": fit_w, "height": fit_h})
            await page.wait_for_timeout(200)

        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        await el.screenshot(path=OUTPUT_PATH)
        await browser.close()

    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"✅ {OUTPUT_PATH} ({size_kb:.0f} KB)")


asyncio.run(main())
