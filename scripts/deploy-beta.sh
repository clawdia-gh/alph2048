#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[beta] compile"
npm run compile

echo "[beta] deploy to testnet"
npm run deploy:testnet

echo "[beta] export ui contract artifact"
npm run contracts:artifact

echo "[beta] self-verify binding/health"
npm run check:beta-health

echo "[beta] done"
