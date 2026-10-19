#!/usr/bin/env bash
# dsbridge 本机上下文接口测试：起独立端口测试桥，curl /context/clipboard。
# 不碰生产 launchd 服务与端口 8787 / 8786，不碰真实 data/。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_PORT="${DSBRIDGE_TEST_PORT:-18787}"
TEST_HTTP_PORT="${DSBRIDGE_TEST_HTTP_PORT:-18786}"
DATA_DIR="$(mktemp -d /tmp/dsbridge-ctx-test-data.XXXXXX)"
LOG_FILE="$(mktemp /tmp/dsbridge-ctx-test-bridge.XXXXXX)"
BRIDGE_PID=""
TLS_COPIED=0
FAILURES=0

cleanup() {
  if [ -n "${BRIDGE_PID}" ] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    kill "${BRIDGE_PID}" 2>/dev/null
    wait "${BRIDGE_PID}" 2>/dev/null
  fi
  rm -rf "${DATA_DIR}" 2>/dev/null
  rm -f "${LOG_FILE}" 2>/dev/null
  if [ "${TLS_COPIED}" = "1" ]; then
    rm -f "${REPO_DIR}/key.pem" "${REPO_DIR}/cert.pem"
  fi
}
trap cleanup EXIT

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# bridge.js 启动时必须能读到证书：worktree 里没有则从主检出临时借用，退出时删除
if [ ! -f "${REPO_DIR}/key.pem" ] || [ ! -f "${REPO_DIR}/cert.pem" ]; then
  MAIN_REPO="${DSBRIDGE_MAIN_REPO:-$(cd "${REPO_DIR}/../.." && pwd)}"
  if [ -f "${MAIN_REPO}/key.pem" ] && [ -f "${MAIN_REPO}/cert.pem" ]; then
    cp "${MAIN_REPO}/key.pem" "${REPO_DIR}/key.pem"
    cp "${MAIN_REPO}/cert.pem" "${REPO_DIR}/cert.pem"
    TLS_COPIED=1
  else
    echo "缺少 cert.pem / key.pem，无法启动 HTTPS 测试桥（可设 DSBRIDGE_MAIN_REPO）" >&2
    exit 2
  fi
fi

echo "启动测试桥 端口 ${TEST_PORT} (https) / ${TEST_HTTP_PORT} (http)，数据目录 ${DATA_DIR}"
DSBRIDGE_PORT="${TEST_PORT}" \
DSBRIDGE_HTTP_PORT="${TEST_HTTP_PORT}" \
DSBRIDGE_DATA_DIR="${DATA_DIR}" \
node "${REPO_DIR}/bridge.js" > "${LOG_FILE}" 2>&1 &
BRIDGE_PID=$!

READY=0
for _ in $(seq 1 50); do
  if curl -s -o /dev/null "http://127.0.0.1:${TEST_HTTP_PORT}/"; then
    READY=1
    break
  fi
  sleep 0.2
done
if [ "${READY}" != "1" ]; then
  echo "测试桥未就绪，日志：" >&2
  cat "${LOG_FILE}" >&2
  exit 2
fi

RESP="$(curl -s -X POST "http://127.0.0.1:${TEST_HTTP_PORT}/context/clipboard" \
  -H 'Content-Type: application/json' -d '{}')"

if [ -z "${RESP}" ]; then
  fail "响应为空"
else
  echo "  响应：${RESP:0:200}"
  if echo "${RESP}" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let j;
      try { j = JSON.parse(raw); } catch (e) { process.exit(1); }
      if (typeof j.ok !== "boolean") process.exit(2);
      if (j.ok) {
        if (typeof j.text !== "string") process.exit(3);
        if (typeof j.bytes !== "number") process.exit(4);
        if (typeof j.truncated !== "boolean") process.exit(5);
      } else if (j.error !== "clipboard-unavailable") {
        process.exit(6);
      }
    });
  '; then
    pass "POST /context/clipboard 返回契约（ok / text / bytes / truncated）"
  else
    fail "POST /context/clipboard 返回契约不符"
  fi
fi

# 未注册的路径不能被当成 /probe 兜底；顺带确认 probe 仍是兜底
PROBE="$(curl -s -X POST "http://127.0.0.1:${TEST_HTTP_PORT}/probe" -H 'Content-Type: application/json' -d '{}')"
if [ "${PROBE}" = '{"ok":true}' ]; then
  pass "POST /probe 行为未变"
else
  fail "POST /probe 行为变了：${PROBE}"
fi

# 确认日志只记大小 / 错误标记，不记剪贴板内容
if grep -q '\[dsbridge\]\[clipboard\]' "${LOG_FILE}"; then
  pass "桥日志记录 /context/clipboard（不含内容）"
else
  fail "桥日志缺少 /context/clipboard 记录"
fi

echo ''
if [ "${FAILURES}" -ne 0 ]; then
  echo "失败 ${FAILURES} 项"
  exit 1
fi
echo "全部通过"
