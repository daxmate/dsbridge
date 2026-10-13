#!/usr/bin/env bash
# dsbridge 邮件接口测试：起独立端口测试桥，curl /mails 与 /mail，含负向用例。
# 不碰生产 launchd 服务与端口 8787 / 8786。
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEST_PORT="${DSBRIDGE_TEST_PORT:-8899}"
TEST_HTTP_PORT="${DSBRIDGE_TEST_HTTP_PORT:-8898}"
DATA_DIR="$(mktemp -d /tmp/dsbridge-test-data.XXXXXX)"
BRIDGE_URL="http://127.0.0.1:${TEST_HTTP_PORT}"
LOG_FILE="$(mktemp /tmp/dsbridge-test-bridge.XXXXXX)"
BRIDGE_PID=""
FAILURES=0

cleanup() {
  if [ -n "${BRIDGE_PID}" ] && kill -0 "${BRIDGE_PID}" 2>/dev/null; then
    kill "${BRIDGE_PID}" 2>/dev/null
    wait "${BRIDGE_PID}" 2>/dev/null
  fi
  rm -rf "${DATA_DIR}" 2>/dev/null
}
trap cleanup EXIT

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

# worktree 里 cert.pem/key.pem 被 .gitignore 忽略；缺失则从主检出复制（仅本机测试，不提交）
for f in cert.pem key.pem; do
  if [ ! -f "${REPO_DIR}/${f}" ]; then
    COMMON_DIR="$(git -C "${REPO_DIR}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    if [ -n "${COMMON_DIR}" ]; then
      MAIN_DIR="$(dirname "${COMMON_DIR}")"
      if [ -f "${MAIN_DIR}/${f}" ]; then cp "${MAIN_DIR}/${f}" "${REPO_DIR}/${f}"; fi
    fi
  fi
done
if [ ! -f "${REPO_DIR}/cert.pem" ] || [ ! -f "${REPO_DIR}/key.pem" ]; then
  echo "缺少 cert.pem / key.pem，无法启动 HTTPS 测试桥" >&2
  exit 2
fi

echo "启动测试桥 端口 ${TEST_PORT} (https) / ${TEST_HTTP_PORT} (http)，数据目录 ${DATA_DIR}"
export DSBRIDGE_PORT="${TEST_PORT}"
export DSBRIDGE_HTTP_PORT="${TEST_HTTP_PORT}"
export DSBRIDGE_DATA_DIR="${DATA_DIR}"
node "${REPO_DIR}/bridge.js" > "${LOG_FILE}" 2>&1 &
BRIDGE_PID=$!

READY=0
for i in $(seq 1 60); do
  if curl -s "${BRIDGE_URL}/" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.2
done
if [ "${READY}" != "1" ]; then
  echo "测试桥未就绪，日志如下：" >&2
  cat "${LOG_FILE}" >&2
  exit 3
fi

echo "== 1) 既有 GET / =="
ROOT_JSON="$(mktemp /tmp/t-root.XXXXXX)"
curl -s "${BRIDGE_URL}/" -o "${ROOT_JSON}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.ok===true&&j.name==="dsbridge"?0:1)' "${ROOT_JSON}" && pass "GET / 返回 ok 且 name=dsbridge" || fail "GET / 返回 ok 且 name=dsbridge"

echo "== 2) POST /mails（INBOX，limit 20） =="
MAILS_JSON="$(mktemp /tmp/t-mails.XXXXXX)"
curl -s -X POST "${BRIDGE_URL}/mails" -H "Content-Type: application/json" -d '{"mailbox":"INBOX","limit":20}' -o "${MAILS_JSON}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.ok===true&&j.mailbox==="INBOX"&&Array.isArray(j.messages)&&j.messages.length>0&&j.messages.length<=20?0:1)' "${MAILS_JSON}" && pass "/mails ok + mailbox + messages 数组 <=20" || fail "/mails ok + mailbox + messages 数组 <=20"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=j.messages[0];process.exit(m&&typeof m.id==="number"&&typeof m.subject==="string"&&typeof m.sender==="string"&&typeof m.date==="string"&&typeof m.mailbox==="string"?0:1)' "${MAILS_JSON}" && pass "/mails 每条含 id/subject/sender/date/mailbox" || fail "/mails 每条含 id/subject/sender/date/mailbox"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const d=j.messages[0].date;process.exit(typeof d==="string"&&d.length>=19&&d[4]==="-"&&d[10]==="T"?0:1)' "${MAILS_JSON}" && pass "/mails date 为 ISO 形态" || fail "/mails date 为 ISO 形态"

FIRST_ID="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.messages[0].id))' "${MAILS_JSON}")"

echo "== 3) POST /mail（取首封正文） =="
MAIL_JSON="$(mktemp /tmp/t-mail.XXXXXX)"
PAYLOAD="$(printf '{"mailbox":"INBOX","id":%s}' "${FIRST_ID}")"
curl -s -X POST "${BRIDGE_URL}/mail" -H "Content-Type: application/json" -d "${PAYLOAD}" -o "${MAIL_JSON}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const m=j.message;process.exit(j.ok===true&&m&&typeof m.body==="string"&&m.body.length>0&&typeof m.subject==="string"&&m.subject.length>0&&typeof m.date==="string"&&typeof m.id==="number"?0:1)' "${MAIL_JSON}" && pass "/mail ok + body 非空 + subject/date/id" || fail "/mail ok + body 非空 + subject/date/id"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.message.body.length<=20000?0:1)' "${MAIL_JSON}" && pass "/mail body 长度 <=20000（截断）" || fail "/mail body 长度 <=20000（截断）"

echo "== 4) 负向用例 =="
NEG1="$(mktemp /tmp/t-neg1.XXXXXX)"
curl -s -X POST "${BRIDGE_URL}/mails" -H "Content-Type: application/json" -d '{"mailbox":"Junk","limit":5}' -o "${NEG1}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.ok===false?0:1)' "${NEG1}" && pass "非法 mailbox 返回 ok:false" || fail "非法 mailbox 返回 ok:false"

NEG2="$(mktemp /tmp/t-neg2.XXXXXX)"
curl -s -X POST "${BRIDGE_URL}/mail" -H "Content-Type: application/json" -d '{"mailbox":"INBOX","id":999999999}' -o "${NEG2}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.ok===false?0:1)' "${NEG2}" && pass "不存在的 id 返回 ok:false" || fail "不存在的 id 返回 ok:false"

echo "== 5) 既有 POST /append =="
APP_JSON="$(mktemp /tmp/t-append.XXXXXX)"
curl -s -X POST "${BRIDGE_URL}/append" -H "Content-Type: application/json" -d '{"role":"user","content":"mail-endpoint-test-keep-existing"}' -o "${APP_JSON}"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.ok===true&&j.appended===1?0:1)' "${APP_JSON}" && pass "/append 追加 1 条" || fail "/append 追加 1 条"
if ls "${DATA_DIR}"/*.jsonl >/dev/null 2>&1; then pass "对话 jsonl 已写入测试数据目录"; else fail "对话 jsonl 已写入测试数据目录"; fi

echo "--- /mails 返回片段（前 400 字节）---"
head -c 400 "${MAILS_JSON}"
echo

echo "================================"
if [ "${FAILURES}" -eq 0 ]; then
  echo "全部通过"
  exit 0
else
  echo "失败 ${FAILURES} 项"
  exit 1
fi
