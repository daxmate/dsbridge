// ========== dsbridge 注入脚本（DeepSeek 桌面版） ==========
// 用途：全自动把 DeepSeek 对话同步到本地桥（bridge.js），写入 jsonl 供 OpenClaw 读取。
//       新消息出现且内容稳定后自动静默同步，无需点击；三个按钮保留为手动兜底。
// 使用：Pake 打包时注入本文件（--inject deepseek_inject.js）。
// 注意：需要本地桥先运行：node bridge.js（HTTPS 自签证书，需已加入系统信任）

// WebKit 混合内容策略会拦 https 页面到 http:// 的请求，所以桥提供 HTTPS（自签证书）。
// 优先 https://127.0.0.1，失败回退 http（万一证书没被信任时还能确认桥可达）。
const DSBRIDGE_URL = 'https://127.0.0.1:8787';
const DSBRIDGE_FALLBACK_URLS = [
  'http://127.0.0.1:8787',
];

// DeepSeek 品牌蓝
const DS_BLUE = '#3964fe';
const DS_BLUE_LIGHT = '#5686fe';

// 内联 SVG 图标（Feather 风格，stroke=currentColor 跟随按钮白色文字）
const ICON_COMMON = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
// 下载/同步：箭头落入托盘
const ICON_SYNC = `<svg ${ICON_COMMON}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
// 导出：文档 + 向上箭头
const ICON_EXPORT = `<svg ${ICON_COMMON}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/></svg>`;
// 复制：双层矩形
const ICON_COPY = `<svg ${ICON_COMMON}><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

// ========== 添加功能按钮 ==========
function addButtons() {
  const container = document.createElement('div');
  container.id = 'pake-tools';
  container.innerHTML = `
    <button id="pake-sync">${ICON_SYNC}同步到本地</button>
    <button id="pake-export">${ICON_EXPORT}导出</button>
    <button id="pake-copy">${ICON_COPY}复制全部</button>
  `;

  // 样式 —— 用 DeepSeek 品牌蓝
  const style = document.createElement('style');
  style.textContent = `
    #pake-tools {
      position: fixed;
      top: 12px;
      right: 80px;
      z-index: 2147483647;
      display: flex;
      gap: 8px;
    }
    #pake-tools button {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 14px;
      border: none;
      border-radius: 6px;
      background: ${DS_BLUE};
      color: white;
      font-size: 13px;
      cursor: pointer;
      transition: background 0.2s, opacity 0.2s;
    }
    #pake-tools button svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    #pake-tools button:hover {
      background: ${DS_BLUE_LIGHT};
    }
    #pake-tools button:active {
      opacity: 0.85;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(container);

  document.getElementById('pake-sync').onclick = syncToBridge;
  document.getElementById('pake-export').onclick = exportConversation;
  document.getElementById('pake-copy').onclick = copyAll;
}

// ========== 自动同步 ==========
// 聊完自动保存：轮询检测新消息，内容稳定后静默发送到本地桥。
const AUTO_SYNC_INTERVAL_MS = 1500;   // 轮询间隔
const STABLE_ROUNDS = 2;              // 内容连续 N 轮不变才认为写完（防流式误发）

let lastContents = new Map();   // 消息序号 -> 上次内容
let pendingSend = new Map();    // 消息序号 -> { role, content, stable }
let autoSyncEnabled = true;

function messageKey(m, i) { return i; }

async function postToBridge(messages) {
  const urls = [DSBRIDGE_URL, ...DSBRIDGE_FALLBACK_URLS];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(`${url}/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
      const result = await res.json();
      if (result.ok) return { ok: true, appended: result.appended };
      lastErr = new Error(`HTTP ${res.status}: ${result.error || res.statusText}`);
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr };
}

function autoSyncTick() {
  if (!autoSyncEnabled) return;
  let messages;
  try {
    messages = extractMessages();
  } catch { return; }
  if (messages.length === 0) return;

  const nowKeys = new Set();
  messages.forEach((m, i) => {
    const key = messageKey(m, i);
    nowKeys.add(key);
    const prev = lastContents.get(key);

    if (prev === undefined) {
      // 新消息，等下一轮确认
      lastContents.set(key, m.content);
      pendingSend.set(key, { role: m.role, content: m.content, stable: 0 });
    } else if (prev === m.content) {
      // 内容与上轮相同 -> 稳定计数 +1
      const p = pendingSend.get(key);
      if (p) {
        p.stable += 1;
        p.content = m.content;
        if (p.stable >= STABLE_ROUNDS) {
          pendingSend.delete(key);
          lastContents.delete(key);
          postToBridge([{ role: p.role, content: p.content }]);
        }
      } else {
        pendingSend.set(key, { role: m.role, content: m.content, stable: 1 });
      }
    } else {
      // 内容在变（流式输出中），重置稳定计数
      lastContents.set(key, m.content);
      const p = pendingSend.get(key);
      if (p) { p.stable = 0; p.content = m.content; }
    }
  });

  // 清理已消失的消息
  for (const key of lastContents.keys()) {
    if (!nowKeys.has(key)) { lastContents.delete(key); pendingSend.delete(key); }
  }
}

setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);

// ========== 同步到本地桥（手动按钮） ==========
async function syncToBridge() {
  const messages = extractMessages();
  if (messages.length === 0) {
    showTip('⚠️ 没提取到消息，检查选择器', '#f59e0b');
    return;
  }
  const result = await postToBridge(messages);
  if (result.ok) {
    showTip(`✓ 已同步 ${result.appended} 条`, DS_BLUE);
  } else {
    showTip(`✗ ${result.error.name}: ${result.error.message}`, '#ef4444');
  }
}

// ========== 导出功能 ==========
async function exportConversation() {
  const messages = extractMessages();
  const text = formatAsText(messages);

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepseek-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// ========== 复制全部 ==========
async function copyAll() {
  const messages = extractMessages();
  const text = formatAsText(messages);

  await navigator.clipboard.writeText(text);
  showTip('✓ 已复制', '#10b981');
}

// ========== 提示气泡 ==========
function showTip(text, color) {
  document.querySelectorAll('#pake-tip').forEach((el) => el.remove());
  const tip = document.createElement('div');
  tip.id = 'pake-tip';
  tip.textContent = text;
  tip.style.cssText = `position:fixed;top:56px;right:80px;background:${color};color:#fff;padding:6px 14px;border-radius:6px;z-index:2147483647;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.15);`;
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 2000);
}

// ========== 提取 DeepSeek 对话 ==========
function extractMessages() {
  // DeepSeek 实际选择器（需根据页面调整）
  const selectors = [
    '[data-testid="chat-message"]',
    '.ds-chat-message',
    '.message-item',
    '[class*="message"]'
  ];

  let elements = [];
  for (const sel of selectors) {
    elements = document.querySelectorAll(sel);
    if (elements.length > 0) break;
  }

  return Array.from(elements).map((el) => ({
    role: el.classList.contains('user') || el.closest('[data-role="user"]') ? 'user' : 'assistant',
    content: el.innerText.trim(),
  }));
}

function formatAsText(messages) {
  return messages.map((m) =>
    `**${m.role === 'user' ? '👤 用户' : '🤖 DeepSeek'}**\n\n${m.content}`
  ).join('\n\n---\n\n');
}

// ========== 初始化 ==========
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', addButtons);
} else {
  addButtons();
}
