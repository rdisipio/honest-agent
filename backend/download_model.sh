#!/usr/bin/env bash
# Downloads the GGUF model recommended in backend/README.md into backend/models/.
set -euo pipefail

REPO="bartowski/Qwen2.5-7B-Instruct-GGUF"
FILE="Qwen2.5-7B-Instruct-Q4_K_M.gguf"
DEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/models"
DEST="$DEST_DIR/$FILE"
URL="https://huggingface.co/$REPO/resolve/main/$FILE"

mkdir -p "$DEST_DIR"

if [ -f "$DEST" ]; then
  echo "Already downloaded: $DEST"
  exit 0
fi

echo "Downloading $FILE (~4.7GB) from $REPO..."
curl -L -f -C - -o "$DEST" "$URL"
echo "Done: $DEST"
