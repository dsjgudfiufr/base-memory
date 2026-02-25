#!/bin/bash
# 后台触发 bm-dispatch.mjs --once
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
nohup node "$SCRIPT_DIR/bm-dispatch.mjs" --once >> /tmp/bm-dispatch-bg.log 2>&1 &
