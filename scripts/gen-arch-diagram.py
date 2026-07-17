#!/usr/bin/env python3
"""Generate the AgentPay architecture diagram as a PNG.

Renders a phased-vertical CSS flowchart showing the full request flow:
  AI Agent → x402 Service (402) → Treasury Agent (Policy → GLM-4.6 LLM)
  → Decision (APPROVE/DENY/DEFER/COUNTER) → Casper Testnet → Audit Log
"""

import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

OUTPUT_PATH = "/home/z/my-project/download/agentpay-v2-architecture.png"
HTML_PATH = "/home/z/my-project/agentpay-v2/scripts/_arch_diagram.html"

HTML = r"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Helvetica Neue", sans-serif;
    background: #FFFFFF;
    color: #1F2937;
    padding: 40px;
  }
  #root {
    width: 1180px;
    margin: 0 auto;
  }

  /* ── Hero ── */
  .hero {
    text-align: center;
    margin-bottom: 32px;
  }
  .hero h1 {
    font-size: 28px;
    font-weight: 700;
    color: #0F172A;
    letter-spacing: -0.5px;
  }
  .hero .sub {
    font-size: 14px;
    color: #64748B;
    margin-top: 6px;
    font-weight: 500;
  }
  .hero .tag {
    display: inline-block;
    padding: 4px 12px;
    background: #EFF6FF;
    color: #1E40AF;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    margin-top: 10px;
    letter-spacing: 0.3px;
  }

  /* ── Phase container ── */
  .phase {
    background: #F8FAFC;
    border-left: 4px solid #64748B;
    border-radius: 8px;
    padding: 18px 22px;
    margin-bottom: 18px;
  }
  .phase.phase-2 { background: #F1F5F9; border-left-color: #5B7A99; }
  .phase.phase-3 { background: #E8EDF2; border-left-color: #4B6A8E; }
  .phase.phase-4 { background: #F0F4F8; border-left-color: #3B5C7E; }

  .phase-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 700;
    color: #1E3A5F;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    margin-bottom: 14px;
  }
  .phase-title .num {
    display: inline-flex;
    width: 22px;
    height: 22px;
    background: #1E3A5F;
    color: #FFF;
    border-radius: 50%;
    align-items: center;
    justify-content: center;
    font-size: 11px;
  }

  .phase-body {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: stretch;
  }

  /* ── Node card ── */
  .node {
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 6px;
    padding: 12px 14px;
    flex: 1 1 0;
    min-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .node.accent-blue   { border-color: #3B82F6; background: #EFF6FF; }
  .node.accent-amber  { border-color: #F59E0B; background: #FFF7ED; }
  .node.accent-green  { border-color: #10B981; background: #F0FDF4; }
  .node.accent-red    { border-color: #EF4444; background: #FEF2F2; }
  .node.accent-purple { border-color: #8B5CF6; background: #F5F3FF; }
  .node.accent-dark   { background: #1E3A5F; color: #FFF; border-color: #1E3A5F; }
  .node.accent-dark .n-label { color: #FFF; }
  .node.accent-dark .n-desc  { color: #CBD5E1; }

  .n-label {
    font-size: 13px;
    font-weight: 600;
    color: #1F2937;
  }
  .n-desc {
    font-size: 11px;
    color: #64748B;
    line-height: 1.4;
  }
  .n-meta {
    font-size: 10px;
    color: #94A3B8;
    margin-top: 2px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }

  /* ── Decision fan ── */
  .decision-fan {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }
  .verdict {
    padding: 10px 12px;
    border-radius: 6px;
    text-align: center;
    border: 1.5px solid;
  }
  .verdict .v-name { font-size: 12px; font-weight: 700; letter-spacing: 0.4px; }
  .verdict .v-desc { font-size: 10px; margin-top: 4px; opacity: 0.85; }
  .v-approve { background: #F0FDF4; border-color: #10B981; color: #065F46; }
  .v-deny    { background: #FEF2F2; border-color: #EF4444; color: #991B1B; }
  .v-defer   { background: #FFF7ED; border-color: #F59E0B; color: #92400E; }
  .v-counter { background: #F5F3FF; border-color: #8B5CF6; color: #5B21B6; }

  /* ── Arrow between phases ── */
  .arrow {
    text-align: center;
    color: #94A3B8;
    font-size: 18px;
    margin: -4px 0 4px;
    font-weight: 300;
  }

  /* ── Footer ── */
  .footer {
    text-align: center;
    font-size: 11px;
    color: #94A3B8;
    margin-top: 28px;
    padding-top: 16px;
    border-top: 1px solid #E2E8F0;
  }
  .footer .stack {
    margin-top: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    color: #64748B;
  }
</style>
</head>
<body>
<div id="root">

  <div class="hero">
    <h1>AgentPay v2 — Treasury Agent Architecture</h1>
    <div class="sub">x402 protocol + GLM-4.6 LLM + Casper blockchain</div>
    <div class="tag">BUIDL @ DoraHacks · casper-test</div>
  </div>

  <!-- Phase 1: Request -->
  <div class="phase phase-1">
    <div class="phase-title"><span class="num">1</span> Payment Request</div>
    <div class="phase-body">
      <div class="node accent-blue">
        <div class="n-label">AI Agent</div>
        <div class="n-desc">Wants to call a paid API (search, LLM, image gen, …)</div>
        <div class="n-meta">research-agent-01</div>
      </div>
      <div class="node accent-blue">
        <div class="n-label">x402-protected Service</div>
        <div class="n-desc">Receives HTTP request, responds with 402 + WWW-Authenticate header</div>
        <div class="n-meta">HTTP 402 · WWW-Authenticate: x402</div>
      </div>
      <div class="node accent-blue">
        <div class="n-label">x402 Client</div>
        <div class="n-desc">Parses challenge → forwards to Treasury Agent</div>
        <div class="n-meta">parseX402Challenge()</div>
      </div>
    </div>
  </div>

  <div class="arrow">↓</div>

  <!-- Phase 2: Policy + LLM -->
  <div class="phase phase-2">
    <div class="phase-title"><span class="num">2</span> Treasury Agent — Decision Engine</div>
    <div class="phase-body">
      <div class="node accent-amber">
        <div class="n-label">Gather Context</div>
        <div class="n-desc">Live on-chain balance + hourly/daily spend + service trust score + recent decisions</div>
        <div class="n-meta">Casper RPC · state_get_balance</div>
      </div>
      <div class="node accent-amber">
        <div class="n-label">Policy Engine</div>
        <div class="n-desc">Deterministic checks: block list, balance, budget, auto-approve threshold</div>
        <div class="n-meta">applyPolicy() · ~1ms</div>
      </div>
      <div class="node accent-amber">
        <div class="n-label">GLM-4.6 LLM Review</div>
        <div class="n-desc">If not auto-decided: structured prompt → strict JSON verdict</div>
        <div class="n-meta">zai.chat.completions.create · ~2-3s</div>
      </div>
    </div>
  </div>

  <div class="arrow">↓</div>

  <!-- Phase 3: Decision fan -->
  <div class="phase phase-3">
    <div class="phase-title"><span class="num">3</span> Verdict (4 outcomes)</div>
    <div class="decision-fan">
      <div class="verdict v-approve">
        <div class="v-name">APPROVE</div>
        <div class="v-desc">Pay full amount → execute on-chain</div>
      </div>
      <div class="verdict v-deny">
        <div class="v-name">DENY</div>
        <div class="v-desc">Refuse permanently · rationale returned</div>
      </div>
      <div class="verdict v-defer">
        <div class="v-name">DEFER</div>
        <div class="v-desc">Retry later · transient issue</div>
      </div>
      <div class="verdict v-counter">
        <div class="v-name">COUNTER</div>
        <div class="v-desc">Offer lower amount to the service</div>
      </div>
    </div>
  </div>

  <div class="arrow">↓</div>

  <!-- Phase 4: Execution + Audit -->
  <div class="phase phase-4">
    <div class="phase-title"><span class="num">4</span> Execution &amp; Audit</div>
    <div class="phase-body">
      <div class="node accent-green">
        <div class="n-label">Build Casper Deploy</div>
        <div class="n-desc">Native transfer · bincode serialize body + header</div>
        <div class="n-meta">body_hash = blake2b256(body)</div>
      </div>
      <div class="node accent-green">
        <div class="n-label">Sign + Submit</div>
        <div class="n-desc">deploy_hash signed with secp256k1 → account_put_deploy</div>
        <div class="n-meta">Explorer: testnet.cspr.live/deploy/&lt;hash&gt;</div>
      </div>
      <div class="node accent-dark">
        <div class="n-label">Audit Log (SQLite)</div>
        <div class="n-desc">Every decision persisted with rationale + source + LLM raw output</div>
        <div class="n-meta">Prisma · TreasuryDecision table</div>
      </div>
    </div>
  </div>

  <div class="footer">
    Treasury Account · 02028689d1…f912fcf0b9 (secp256k1) · 5000 CSPR funded on casper-test
    <div class="stack">Bun · TypeScript · Prisma · @noble/curves · z-ai-web-dev-sdk (GLM-4.6)</div>
  </div>

</div>
</body>
</html>
"""

async def main():
    Path(HTML_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(HTML_PATH).write_text(HTML, encoding="utf-8")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(
            viewport={"width": 1280, "height": 1400},
            device_scale_factor=2,
        )
        await page.goto(f"file://{HTML_PATH}", wait_until="networkidle")
        await page.wait_for_timeout(400)

        el = page.locator("#root")
        bbox = await el.bounding_box()
        if bbox:
            fit_w = max(1280, int(bbox["width"] + 80))
            fit_h = int(bbox["height"] + 80)
            await page.set_viewport_size({"width": fit_w, "height": fit_h})
            await page.wait_for_timeout(200)

        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        await el.screenshot(path=OUTPUT_PATH)
        await browser.close()

    size_kb = os.path.getsize(OUTPUT_PATH) / 1024
    print(f"✅ {OUTPUT_PATH} ({size_kb:.0f} KB)")

asyncio.run(main())
