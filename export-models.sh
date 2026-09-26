#!/usr/bin/env bash
# One-time model export: safetensors (Hugging Face) -> split ONNX for laya-ts.
# This is the only step that needs Python; after it, the server runs on Node alone.
#
# Usage: ./export-models.sh [target-dir]   (default: ./models)
set -euo pipefail

OUT="${1:-models}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning laya (for the export script) and creating a throwaway venv"
git clone --depth 1 https://github.com/NandhaKishorM/laya "$WORK/laya"
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q --upgrade pip
"$WORK/venv/bin/pip" install -q -e "$WORK/laya" onnx onnxruntime onnxscript

echo "==> exporting english checkpoint (ModernBERT-large, ~1.7 GB download)"
"$WORK/venv/bin/python" "$WORK/laya/laya-ts/scripts/export_onnx.py" \
  --repo convaiinnovations/laya --out-dir "$OUT/english"

echo "==> exporting multilingual checkpoint (mmBERT-base, ~1.3 GB download)"
"$WORK/venv/bin/python" "$WORK/laya/laya-ts/scripts/export_onnx.py" \
  --repo convaiinnovations/laya --subfolder multilingual --out-dir "$OUT/multilingual"

echo "==> done. Both exports were verified torch-vs-ONNX within 1e-4."
echo "    Optional: reclaim ~3 GB with:  rm -rf ~/.cache/huggingface/hub/models--convaiinnovations--laya"
