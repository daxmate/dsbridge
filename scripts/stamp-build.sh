#!/bin/bash
# 给 macOS .app 写入可追踪的 build 号（Info.plist 三键）并重新 ad-hoc 签名。
# 用法：scripts/stamp-build.sh <app-path> [build-id]
# build-id 缺省顺序：参数 -> DSBRIDGE_BUILD_ID -> YYYYMMDD.HHMM-<git short sha>
set -euo pipefail

APP="${1:-}"
BUILD_ID="${2:-}"

if [ -z "$APP" ]; then
  echo "用法: $0 <app-path> [build-id]" >&2
  exit 2
fi

PLIST="$APP/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "[stamp] 错误: 找不到 $PLIST" >&2
  exit 1
fi

if [ -z "$BUILD_ID" ]; then
  BUILD_ID="${DSBRIDGE_BUILD_ID:-}"
fi

if [ -z "$BUILD_ID" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  BUILD_ID="$(date +%Y%m%d.%H%M)-$SHA"
fi

# 键存在则 Set，不存在则 Add（string 类型）
set_plist_key() {
  local key="$1"
  local value="$2"
  if /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" >/dev/null 2>&1; then
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$PLIST"
  else
    /usr/libexec/PlistBuddy -c "Add :$key string $value" "$PLIST"
  fi
}

set_plist_key CFBundleShortVersionString "$BUILD_ID"
set_plist_key CFBundleVersion "$BUILD_ID"
set_plist_key DSBridgeBuild "$BUILD_ID"

# 改动 Info.plist 后原签名失效，重新 ad-hoc 签名；失败必须非 0 退出
if ! codesign --force --deep --sign - "$APP"; then
  echo "[stamp] 错误: codesign 重新签名失败: $APP" >&2
  exit 1
fi

echo "[stamp] build=$BUILD_ID"
