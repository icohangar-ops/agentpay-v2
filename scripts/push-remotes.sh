#!/bin/bash
# Push AgentPay v2 to 2 GitHub repos + 1 Codeberg repo (3 remotes total).
#
# USAGE:
#   1. Create 3 empty repos (NO README, NO .gitignore, NO license — must be empty):
#        - GitHub repo #1 (e.g. your personal copy):  https://github.com/<you>/agentpay-v2
#        - GitHub repo #2 (e.g. hackathon team copy): https://github.com/<team>/agentpay-v2-buidl
#        - Codeberg repo:                              https://codeberg.org/<you>/agentpay-v2
#   2. Set the URLs below (or pass them as env vars).
#   3. Run:  bash scripts/push-remotes.sh
#
# AUTH OPTIONS:
#   - HTTPS with Personal Access Token (PAT):
#       Set GITHUB_TOKEN and CODEBERG_TOKEN env vars, and the script
#       will embed them in the remote URLs.
#   - SSH:
#       Leave the URLs as git@github.com:... / git@codeberg.org:... and
#       make sure your SSH key is loaded.
#
# After the first run, subsequent pushes use: git push --all

set -euo pipefail

REPO_DIR="/home/z/my-project/agentpay-v2"
cd "$REPO_DIR"

# ─── Remote URLs ─────────────────────────────────────────────────────
# Override via env vars: GITHUB_1_URL, GITHUB_2_URL, CODEBERG_URL

if [ -n "${GITHUB_1_URL:-}" ]; then GH1="$GITHUB_1_URL"; else
  read -r -p "GitHub repo #1 URL (e.g. git@github.com:you/agentpay-v2.git): " GH1
fi

if [ -n "${GITHUB_2_URL:-}" ]; then GH2="$GITHUB_2_URL"; else
  read -r -p "GitHub repo #2 URL (e.g. git@github.com:hackathon-team/agentpay-v2-buidl.git): " GH2
fi

if [ -n "${CODEBERG_URL:-}" ]; then CB="$CODEBERG_URL"; else
  read -r -p "Codeberg repo URL (e.g. git@codeberg.org:you/agentpay-v2.git): " CB
fi

echo
echo "Remotes:"
echo "  github-1:   $GH1"
echo "  github-2:   $GH2"
echo "  codeberg:   $CB"
echo

# ─── Optional: embed PAT for HTTPS ───────────────────────────────────
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "Embedding GITHUB_TOKEN into GitHub URLs..."
  GH1=$(echo "$GH1" | sed "s|https://github.com/|https://x-access-token:${GITHUB_TOKEN}@github.com/|")
  GH2=$(echo "$GH2" | sed "s|https://github.com/|https://x-access-token:${GITHUB_TOKEN}@github.com/|")
fi
if [ -n "${CODEBERG_TOKEN:-}" ]; then
  echo "Embedding CODEBERG_TOKEN into Codeberg URL..."
  CB=$(echo "$CB" | sed "s|https://codeberg.org/|https://${CODEBERG_USER:-you}:${CODEBERG_TOKEN}@codeberg.org/|")
fi

# ─── Add remotes ─────────────────────────────────────────────────────
git remote remove github-1 2>/dev/null || true
git remote remove github-2 2>/dev/null || true
git remote remove codeberg 2>/dev/null || true

git remote add github-1 "$GH1"
git remote add github-2 "$GH2"
git remote add codeberg "$CB"

# Add an "all" push target that fans out to every remote
git remote remove all 2>/dev/null || true
git remote add all "$GH1"
git remote set-url --add --push all "$GH1"
git remote set-url --add --push all "$GH2"
git remote set-url --add --push all "$CB"

echo "Configured remotes:"
git remote -v
echo

# ─── Push ────────────────────────────────────────────────────────────
echo "Pushing main branch to all remotes..."

for remote in github-1 github-2 codeberg; do
  echo
  echo "── $remote ──"
  if git push -u "$remote" main 2>&1; then
    echo "✅ $remote pushed"
  else
    echo "❌ $remote push failed (see above)"
  fi
done

echo
echo "── all (fan-out) ──"
if git push all main 2>&1; then
  echo "✅ all remotes pushed via 'all' remote"
else
  echo "❌ fan-out push failed (individual pushes above should have already succeeded)"
fi

echo
echo "Done. Repo is at $REPO_DIR with 3 remotes configured."
echo "Future pushes: git push all main"
