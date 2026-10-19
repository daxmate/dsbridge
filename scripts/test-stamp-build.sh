#!/bin/bash
# stamp-build.sh 自测：造最小 .app -> 写入 build 号 -> 校验 plist 三键 + 签名
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/stamp-build-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

APP="$WORK/Test.app"
mkdir -p "$APP/Contents/MacOS"
# /bin/true 在部分 macOS 版本不存在，退回 /usr/bin/true
if [ -x /bin/true ]; then
  cp /bin/true "$APP/Contents/MacOS/Test"
else
  cp /usr/bin/true "$APP/Contents/MacOS/Test"
fi
chmod +x "$APP/Contents/MacOS/Test"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Test</string>
  <key>CFBundleIdentifier</key><string>com.example.test</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>Test</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
</dict>
</plist>
PLIST

codesign --force --deep --sign - "$APP" >/dev/null 2>&1

OUT="$("$ROOT/scripts/stamp-build.sh" "$APP" TEST-BUILD-123)"
echo "$OUT"
if ! printf '%s\n' "$OUT" | grep -q '^\[stamp\] build=TEST-BUILD-123$'; then
  echo "FAIL: 输出缺少 [stamp] build=TEST-BUILD-123" >&2
  exit 1
fi
echo "  PASS: 输出 [stamp] build=..."

fail=0
for key in CFBundleShortVersionString CFBundleVersion DSBridgeBuild; do
  val="$(/usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist")"
  if [ "$val" != "TEST-BUILD-123" ]; then
    echo "FAIL: $key=$val" >&2
    fail=1
  else
    echo "  PASS: $key=$val"
  fi
done

if codesign --verify --deep --strict "$APP"; then
  echo "  PASS: codesign --verify --deep --strict"
else
  echo "FAIL: codesign --verify --deep --strict 未通过" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "全部通过"
