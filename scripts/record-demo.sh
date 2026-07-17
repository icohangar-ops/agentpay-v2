#!/bin/bash
# Record the AgentPay v2 demo as an asciinema cast, then convert to GIF + MP4.
#
# Output:
#   /home/z/my-project/download/agentpay-v2-demo.cast
#   /home/z/my-project/download/agentpay-v2-demo.gif
#   /home/z/my-project/download/agentpay-v2-demo.mp4

set -e

OUT_DIR="/home/z/my-project/download"
CAST="$OUT_DIR/agentpay-v2-demo.cast"
GIF="$OUT_DIR/agentpay-v2-demo.gif"
MP4="$OUT_DIR/agentpay-v2-demo.mp4"
DEMO_SCRIPT="/home/z/my-project/agentpay-v2/scripts/demo-treasury.ts"

mkdir -p "$OUT_DIR"

# 1. Clear DB so the demo starts fresh (otherwise audit log shows old runs)
echo "Resetting audit log..."
rm -f /home/z/my-project/agentpay-v2/prisma/db/dev.db
cd /home/z/my-project/agentpay-v2
bunx prisma db push --skip-generate 2>&1 | tail -3

# 2. Record
echo "Recording to $CAST..."
asciinema rec \
  --command="bash -c 'echo \"╔══════════════════════════════════════════════════════════════════╗\"; echo \"║  AgentPay v2 — Live Demo Recording                                ║\"; echo \"║  x402 + Casper testnet + GLM-4.6 Treasury Agent                   ║\"; echo \"╚══════════════════════════════════════════════════════════════════╝\"; sleep 2; cd /home/z/my-project/agentpay-v2 && bun run scripts/demo-treasury.ts; echo; echo \"Demo recording complete.\"; sleep 2'" \
  --idle-time-limit=2 \
  --title="AgentPay v2 Treasury Agent — Live Demo" \
  "$CAST"

# 3. Convert to GIF (using agg if available, else asciinema2gif)
if command -v agg >/dev/null 2>&1; then
  echo "Converting to GIF via agg..."
  agg --rows 50 --cols 180 --speed 1.0 "$CAST" "$GIF"
elif command -v asciinema2gif >/dev/null 2>&1; then
  echo "Converting to GIF via asciinema2gif..."
  asciinema2gif "$CAST" "$GIF"
else
  echo "agg/asciinema2gif not found, attempting docker-based conversion..."
  # Try the official docker image
  if command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$OUT_DIR:/data" asciinema/asciicast2gif \
      --rows 50 --cols 180 \
      "/data/$(basename "$CAST")" "/data/$(basename "$GIF")" 2>&1 | tail -5 || \
      echo "Docker conversion failed — falling back to text-only cast."
  else
    echo "No GIF conversion tool available. The .cast file is still usable."
  fi
fi

echo
echo "Done."
ls -la "$OUT_DIR"/agentpay-v2-demo.* 2>/dev/null || true
