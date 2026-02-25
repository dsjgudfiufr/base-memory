#!/bin/bash
# 后台触发 bm-dispatch.mjs --once（单实例保证）
LOCKFILE="/tmp/bm-dispatch.lock"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

# 检查锁：如果锁文件存在且进程还活着，跳过
if [ -f "$LOCKFILE" ]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    exit 0
  fi
  rm -f "$LOCKFILE"
fi

# 后台启动，写入 PID
nohup bash -c "
  echo \$\$ > $LOCKFILE
  node $SCRIPT_DIR/bm-dispatch.mjs --once >> /tmp/bm-dispatch-bg.log 2>&1
  rm -f $LOCKFILE
" >> /tmp/bm-dispatch-bg.log 2>&1 &
