#!/bin/bash
# 打包 DeepSeek 桌面版（Pake）+ dsbridge 注入
set -e

# 脚本所在目录（兼容从任意位置调用）
cd "$(dirname "$0")"

# ========== 0. 前置条件检查（缺失则自动安装） ==========
MISSING=""
for cmd in node openssl pake; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    MISSING="$MISSING $cmd"
  fi
done

if [ -n "$MISSING" ]; then
  echo "[pack] 缺少依赖:$MISSING"
  if ! command -v brew >/dev/null 2>&1; then
    echo "[pack] 未检测到 Homebrew，请先手动安装依赖:"
    echo "      brew install node openssl pake"
    echo "      或安装 Homebrew: https://brew.sh"
    exit 1
  fi
  for cmd in $MISSING; do
    echo "[pack] brew install $cmd ..."
    brew install "$cmd"
  done
  # 重新验证
  for cmd in node openssl pake; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "[pack] 安装后仍缺少: $cmd，请手动安装: brew install $cmd"
      exit 1
    fi
  done
fi
echo "[pack] 依赖检查通过 (node/openssl/pake)"

# ========== 1. 清理可能干扰 Rust 编译的环境变量 ==========
# Pake 打包需要编译 Rust，若外部设置了 CC/CXX（如某些工具链），
# 会导致编译失败，这里统一 unset。
if [ -n "${CC:-}" ]; then
  echo "[pack] unset CC (was: $CC)"
  unset CC
fi
if [ -n "${CXX:-}" ]; then
  echo "[pack] unset CXX (was: $CXX)"
  unset CXX
fi

# ========== 2. 生成并信任 dsbridge 自签名证书 ==========
# 注入脚本通过 https://127.0.0.1:8787 与本地桥通信，
# 需要自签证书且被系统信任，否则 WKWebView 会拒绝连接。
CERT_FILE="cert.pem"
KEY_FILE="key.pem"

if [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; then
  echo "[pack] 生成自签名证书..."
  openssl req -x509 -newkey rsa:2048 -keyout "$KEY_FILE" -out "$CERT_FILE" -days 825 -nodes \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -addext "extendedKeyUsage=serverAuth"
fi

# 检查证书是否已被系统信任，没有才需要 sudo 添加
if security find-certificate -c "localhost" /Library/Keychains/System.keychain >/dev/null 2>&1; then
  echo "[pack] 证书已受信任，跳过"
else
  echo "[pack] 信任自签名证书（需要管理员密码）..."
  sudo security add-trusted-cert -d -r trustRoot \
    -k /Library/Keychains/System.keychain "$(pwd)/$CERT_FILE"
fi

# ========== 3. 安装并启动 dsbridge 本地桥服务（launchd） ==========
# 把 plist 模板拷贝到 ~/Library/LaunchAgents，路径替换为当前项目目录，
# 未加载则 bootstrap 安装并运行。
PLIST_SRC="$(pwd)/com.dax.dsbridge.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.dax.dsbridge.plist"
LABEL="com.dax.dsbridge"
UID_NUM=$(id -u)

mkdir -p "$HOME/Library/LaunchAgents"

# 模板中的 __DSBRIDGE_DIR__ 替换为当前项目绝对路径
sed "s|__DSBRIDGE_DIR__|$(pwd)|g" "$PLIST_SRC" > "$PLIST_DST"

echo "[pack] launchd 服务文件已安装到 $PLIST_DST"

# 未加载则 bootstrap 安装
if ! launchctl list | grep -q "$LABEL"; then
  echo "[pack] 启动 dsbridge 服务..."
  launchctl bootstrap "gui/$UID_NUM" "$PLIST_DST"
  sleep 1
fi

# 验证端口在监听（服务已加载但进程挂了就 kickstart 拉起）
if ! lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[pack] 桥未监听，kickstart 拉起..."
  launchctl kickstart "gui/$UID_NUM/$LABEL"
  sleep 1
fi

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[pack] dsbridge 服务运行中 (https://127.0.0.1:8787)"
else
  echo "[pack] 警告: dsbridge 服务未能启动，请检查 bridge.log"
fi

# ========== 4. 打包 ==========
echo "[pack] 开始打包 DeepSeek..."
pake https://chat.deepseek.com --name DeepSeek \
  --inject "$(pwd)/deepseek_inject.js" \
  --hide-on-close --install
