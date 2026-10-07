#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/mnt/user/appdata/monzo-proxy}"
REPO_URL="https://github.com/dpremoli/Wealthfolio-Monzo-AddOn.git"
BRANCH="${BRANCH:-main}"

if [ -n "${GIT_TOKEN:-}" ]; then
  REPO_URL="https://dpremoli:${GIT_TOKEN}@github.com/dpremoli/Wealthfolio-Monzo-AddOn.git"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "Cloning $REPO_URL -> $REPO_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
else
  echo "Updating $REPO_DIR"
  git -C "$REPO_DIR" fetch --all --prune
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
fi

cd "$REPO_DIR"

echo "Removing old container..."
docker rm -f monzo-proxy || true

echo "Rebuilding and starting container..."
docker compose up -d --build

echo "✓ monzo-proxy container rebuilt and running"
