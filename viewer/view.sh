#!/usr/bin/env bash
# 启动 Conductor Workflow Viewer（离线 DAG 可视化器 + conductor-validate 校验）
#
#   ./view.sh                          # 打开空界面，拖入自己的 JSON
#   ./view.sh path/to/workflow.json    # 启动并直接加载指定文件
#   PORT=8080 ./view.sh                # 指定端口
#
# 说明：viewer 是 conductor-validate 里的一个独立子项目，不参与 npm 包构建；
# 校验内核会在浏览器里跑（src → viewer/vendor 的 ESM 编译产物）。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
PORT="${PORT:-5173}"
FILE_PARAM=""

# 校验内核：编译成浏览器能直接 import 的 ESM
#
# 页面和 CLI 跑的是同一份 src/core.ts，靠的就是这个产物。两种情况必须重建：
#   1) 产物不存在；
#   2) 源码比产物新（改过 src/core.ts 但没重新构建）——否则页面跑的是旧规则，
#      看起来"和 CLI 不一致"，其实是本地没重新编译。
NEEDS_BUILD=0
if [ ! -f "$DIR/vendor/core.js" ]; then
  NEEDS_BUILD=1
else
  for src_file in "$ROOT/src/core.ts" "$ROOT/src/util.ts" "$ROOT/src/types.ts"; do
    if [ "$src_file" -nt "$DIR/vendor/core.js" ]; then
      NEEDS_BUILD=1
      break
    fi
  done
fi

if [ "$NEEDS_BUILD" -eq 1 ]; then
  if [ ! -d "$ROOT/node_modules" ]; then
    echo "缺少依赖，请先在 $ROOT 执行: npm install" >&2
    exit 1
  fi
  echo "正在构建校验内核（npm run build:viewer）..."
  (cd "$ROOT" && npm run --silent build:viewer)
fi

if [ $# -ge 1 ]; then
  SRC="$1"
  if [ ! -f "$SRC" ]; then
    echo "找不到文件: $SRC" >&2
    exit 1
  fi
  cp "$SRC" "$DIR/_user-workflow.json"
  FILE_PARAM="?file=_user-workflow.json"
  echo "已加载: $SRC"
fi

# 服务根目录是 conductor-validate 项目根，这样 /viewer/ 和 /examples/ 都能访问到
# 用 127.0.0.1 而不是 localhost，避免本机代理把请求拦掉
URL="http://127.0.0.1:${PORT}/viewer/${FILE_PARAM}"

echo
echo "  Conductor Workflow Viewer"
echo "  → ${URL}"
echo "  (Ctrl+C 停止)"
echo
echo "  提示: 改了 src/core.ts 之后另开一个终端跑 npm run dev:viewer（增量重编译），"
echo "        刷新页面即可看到新规则；本脚本在下次启动时也会自动重建过期产物。"
echo

cd "$ROOT"
if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server "$PORT" &
  SERVER_PID=$!
  sleep 1
  (command -v open >/dev/null 2>&1 && open "$URL") || true
  cleanup() {
    kill $SERVER_PID 2>/dev/null || true
    [ -n "$FILE_PARAM" ] && rm -f "$DIR/_user-workflow.json"
  }
  trap cleanup EXIT INT TERM
  wait $SERVER_PID
else
  echo "需要 python3 来提供静态服务" >&2
  exit 1
fi
