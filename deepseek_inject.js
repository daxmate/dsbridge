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

// 打包时由 pack_deepseek.sh 把占位符替换成本次 build 号；未替换则回退 dev。
// 占位符在文件里只出现这一处，且兜底判断不重复字面量（避免 sed 全局替换后误判成 dev）。
var DSBRIDGE_BUILD = '__DSBRIDGE_BUILD__';
if (DSBRIDGE_BUILD.slice(0, 2) === '__') DSBRIDGE_BUILD = 'dev';

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
// 浏览器打开：外部链接箭头
const ICON_EXTERNAL = `<svg ${ICON_COMMON}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
// 邮件：信封
const ICON_MAIL = `<svg ${ICON_COMMON}><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>`;
// 本机上下文：回形针
const ICON_CONTEXT = `<svg ${ICON_COMMON}><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;

// ========== 注入 UI 主题（浅/深）自适应 ==========
// 目标：4 个工具按钮、邮件按钮、「选择邮件」弹窗（含筛选输入框）跟随 DeepSeek
//       页面实际主题（不只系统）变色；页面切主题时实时跟随。
// 实现：单一切换点 dsApplyTheme() —— 读当前主题 -> 给注入根元素加/去 'ds-dark' 类；
//       两套调色板只在 DS_THEME_STYLE_TEXT 里定义一处（其余样式只引用 var(--ds-*)）。

// ---- 纯判定（无 DOM 依赖，可被 node 直接单测）----
// 解析 CSS 颜色字符串 -> [r,g,b]；全透明 / 无法识别 -> null
function dsParseColor(value) {
  if (typeof value !== 'string') return null;
  var s = value.trim();
  var m = s.match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+))?\s*\)$/i);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null; // 全透明 = 未设色
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) {
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
}

// 相对亮度（0=黑，1=白），WCAG 相对亮度公式
function dsRelLuminance(rgb) {
  var c = rgb.map(function (v) {
    v = v / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// DOM 主题信号（类名 / data-theme / color-scheme）-> 'dark' | 'light' | null
// 只认「明确且不矛盾」的信号（如 color-scheme: 'light dark' 视为无结论）
function dsThemeSignal(className, dataTheme, colorScheme) {
  var cls = String(className || '').toLowerCase();
  var dt = String(dataTheme || '').toLowerCase();
  var cs = String(colorScheme || '').toLowerCase();
  var hasDark = /(^|\s)dark(\s|$)/.test(cls) || dt === 'dark' || /(^|\s)dark(\s|$)/.test(cs);
  var hasLight = /(^|\s)light(\s|$)/.test(cls) || dt === 'light' || /(^|\s)light(\s|$)/.test(cs);
  if (hasDark && !hasLight) return 'dark';
  if (hasLight && !hasDark) return 'light';
  return null;
}

// 纯判定：按优先级 (a) DOM 信号 -> (b) 背景色相对亮度 -> (c) prefers-color-scheme
// input: { className, dataTheme, colorScheme, bgColor, prefersDark }
function dsResolveDark(input) {
  input = input || {};
  var signal = dsThemeSignal(input.className, input.dataTheme, input.colorScheme);
  if (signal === 'dark') return true;
  if (signal === 'light') return false;
  var rgb = dsParseColor(input.bgColor);
  if (rgb) return dsRelLuminance(rgb) < 0.5; // 兜底主力：不依赖任何类名/变量名
  return !!input.prefersDark;
}

// ---- 调色板（唯一一处定义：浅色默认 / .ds-dark 覆盖深色）----
// 能引 DeepSeek 页面变量 --dsw-alias-* 就引（均带自研回退，缺变量也不脆）。
var DS_THEME_STYLE_TEXT = `
#pake-tools, #ds-mail-btn, #ds-mail-overlay, #ds-ctx-btn, #ds-ctx-overlay {
  color-scheme: light;
  --ds-fg: var(--dsw-alias-label-primary, #0f1115);
  --ds-fg-mid: var(--dsw-alias-label-secondary, #374151);
  --ds-fg-dim: var(--dsw-alias-label-tertiary, #6b7280);
  --ds-border: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  --ds-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --ds-active: rgba(38, 49, 72, 0.1);
  --ds-panel: var(--dsw-alias-bg-base, #ffffff);
  --ds-panel-border: rgba(0, 0, 0, 0.08);
  --ds-overlay: rgba(15, 17, 21, 0.45);
  --ds-input-bg: var(--dsw-alias-bg-base, #ffffff);
  --ds-input-border: rgba(0, 0, 0, 0.15);
  --ds-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
#pake-tools.ds-dark, #ds-mail-btn.ds-dark, #ds-mail-overlay.ds-dark {
  color-scheme: dark;
  --ds-fg: var(--dsw-alias-label-primary, #e6e6e6);
  --ds-fg-mid: var(--dsw-alias-label-secondary, #c2c7cf);
  --ds-fg-dim: var(--dsw-alias-label-tertiary, #9aa0a6);
  --ds-border: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16));
  --ds-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  --ds-active: rgba(255, 255, 255, 0.14);
  --ds-panel: var(--dsw-alias-bg-base, #1f2023);
  --ds-panel-border: rgba(255, 255, 255, 0.1);
  --ds-overlay: rgba(0, 0, 0, 0.6);
  --ds-input-bg: var(--dsw-alias-bg-base, #2a2b2f);
  --ds-input-border: rgba(255, 255, 255, 0.2);
  --ds-shadow: 0 12px 40px rgba(0, 0, 0, 0.6);
}
`;

// 注入调色板样式（幂等）
function dsInjectThemeStyle() {
  if (document.getElementById('ds-theme-style')) return;
  var st = document.createElement('style');
  st.id = 'ds-theme-style';
  st.textContent = DS_THEME_STYLE_TEXT;
  document.head.appendChild(st);
}

// 参与切换的注入根元素（其内部元素经 CSS 变量继承）
function dsInjectedRoots() {
  return ['pake-tools', 'ds-mail-btn', 'ds-mail-overlay', 'ds-ctx-btn', 'ds-ctx-overlay']
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
}

// 读当前页面主题环境（供上面的纯判定函数消费）
function dsReadThemeEnv() {
  var root = document.documentElement;
  var bodyBg = '';
  var htmlBg = '';
  var scheme = '';
  try { if (document.body) bodyBg = getComputedStyle(document.body).backgroundColor; } catch (e) { /* 忽略 */ }
  try { htmlBg = getComputedStyle(root).backgroundColor; } catch (e) { /* 忽略 */ }
  try { scheme = getComputedStyle(root).colorScheme || ''; } catch (e) { /* 忽略 */ }
  return {
    className: (root ? root.className : '') + ' ' + (document.body ? document.body.className : ''),
    dataTheme: (root && root.getAttribute('data-theme')) || '',
    colorScheme: scheme,
    bgColor: dsParseColor(bodyBg) ? bodyBg : htmlBg,
    prefersDark: !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
  };
}

// 单一切换点：算主题 -> 给所有注入根元素加/去 'ds-dark'
function dsApplyTheme() {
  dsInjectThemeStyle();
  var dark = dsResolveDark(dsReadThemeEnv());
  var els = dsInjectedRoots();
  for (var i = 0; i < els.length; i++) {
    if (dark) els[i].classList.add('ds-dark');
    else els[i].classList.remove('ds-dark');
  }
  return dark;
}

// 实时跟随：观察 html/body 的 class/style/data-theme + 监听系统主题变化
var dsThemeObserver = null;
var dsThemeMedia = null;
function dsWatchTheme() {
  if (typeof MutationObserver !== 'undefined' && !dsThemeObserver) {
    dsThemeObserver = new MutationObserver(function () { dsApplyTheme(); });
    dsThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    if (document.body) {
      dsThemeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    }
  }
  if (window.matchMedia && !dsThemeMedia) {
    dsThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { dsApplyTheme(); };
    if (dsThemeMedia.addEventListener) dsThemeMedia.addEventListener('change', onChange);
    else if (dsThemeMedia.addListener) dsThemeMedia.addListener(onChange);
  }
}

// ========== 添加功能按钮 ==========
function addButtons() {
  const container = document.createElement('div');
  container.id = 'pake-tools';
  container.innerHTML = `
    <button id="pake-sync">${ICON_SYNC}同步到本地</button>
    <button id="pake-export">${ICON_EXPORT}导出</button>
    <button id="pake-copy">${ICON_COPY}复制全部</button>
    <button id="pake-open">${ICON_EXTERNAL}浏览器打开</button>
  `;

  // 样式 —— 对齐 DeepSeek 原生按钮（ds-button outlinedNeutral 变体）：
  //   胶囊圆角 / 透明底 / 1px 浅灰边框 / 深色文字 / hover 浅灰底
  // 取值来自 chat.deepseek.com 的 main.css 变量：
  //   --dsw-alias-border-l2: rgba(0,0,0,.1)
  //   --dsw-alias-interactive-bg-hover: rgba(38,49,72,.06)
  //   --dsw-alias-label-primary: #0f1115
  const style = document.createElement('style');
  style.textContent = `
    /* 注：红绿灯避让不再需要 —— 打包时已去掉 --hide-title-bar，
       由 macOS 原生标题栏容纳红绿灯，页面内容天然从标题栏下方开始 */
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
      gap: 6px;
      height: 36px;
      padding: 0 14px;
      border: 1px solid var(--ds-border);
      border-radius: 999px;
      background: transparent;
      color: var(--ds-fg);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.2s, border-color 0.2s;
    }
    #pake-tools button svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }
    #pake-tools button:hover {
      background: var(--ds-hover);
    }
    #pake-tools button:active {
      background: var(--ds-active);
    }
    /* 打印相关样式已移除：方案 B 走本地桥生成打印页，不再依赖页面内 @media print */
  `;

  document.head.appendChild(style);
  document.body.appendChild(container);

  document.getElementById('pake-sync').onclick = syncToBridge;
  document.getElementById('pake-export').onclick = exportConversation;
  document.getElementById('pake-copy').onclick = copyAll;
  document.getElementById('pake-open').onclick = openInBrowser;

  dsApplyTheme(); // 首次上色（页面主题可能已是深色）
}

// ========== 自动同步 ==========
// 聊完自动保存：轮询检测新消息，内容稳定后静默发送到本地桥。
const AUTO_SYNC_INTERVAL_MS = 1500;   // 轮询间隔
const STABLE_ROUNDS = 2;              // 内容连续 N 轮不变才认为写完（防流式误发）

let lastContents = new Map();   // 消息序号 -> 上次内容
let pendingSend = new Map();    // 消息序号 -> { role, content, stable }
let autoSyncEnabled = true;

function messageKey(m, i) { return i; }

async function postToBridge(messages, endpoint = '/append', options) {
  const urls = [DSBRIDGE_URL, ...DSBRIDGE_FALLBACK_URLS];
  const opts = options || {};
  let lastErr = null;
  let controller = null;
  let timer = null;
  if (opts.timeoutMs) {
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  }
  try {
    for (const url of urls) {
      try {
        const res = await fetch(`${url}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(messages),
          ...(controller ? { signal: controller.signal } : {}),
        });
        const result = await res.json();
        if (result.ok) return { ok: true, ...result };
        lastErr = new Error(`HTTP ${res.status}: ${result.error || res.statusText}`);
      } catch (e) {
        lastErr = e;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
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

// 仅在浏览器（注入）环境启动轮询；node 直接 require 本文件做单测时跳过
if (typeof window !== 'undefined') {
  setInterval(autoSyncTick, AUTO_SYNC_INTERVAL_MS);
}

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

// ========== 在浏览器打开当前对话 ==========
// 把当前对话的 chat.deepseek.com 地址交给系统默认浏览器打开，
// 利用网页版的 Markdown/LaTeX 渲染能力查看/复制/打印。
async function openInBrowser() {
  const url = window.location.href;
  if (!url || !/^https?:\/\//i.test(url)) {
    showTip('⚠️ 获取当前地址失败', '#f59e0b');
    return;
  }
  const result = await postToBridge({ url }, '/open-url');
  if (result.ok) {
    showTip('✓ 已在浏览器打开', '#10b981');
  } else {
    showTip(`✗ 打开失败: ${(result.error && result.error.message) || result.error}`, '#ef4444');
  }
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

// ========== 邮件作为附件（Apple Mail → DeepSeek） ==========
// 依赖本地桥：/mails（列表）、/mail（正文）、/probe（诊断）。仅 Senkori 账号。
const MAIL_TABS = [
  { key: 'INBOX', label: '收件箱' },
  { key: 'Archive', label: '归档' },
  { key: 'Sent Messages', label: '已发送' },
];
const MAIL_PAGE_STEP = 20;
const MAIL_PAGE_MAX = 50;
const MAIL_FETCH_TIMEOUT_MS = 90000; // /mails 请求超时上限：> 服务端 osascript(30s) + Mail 就绪等待(45s)，保证前端晚于服务端拿到结果

const mailState = {
  tab: 'INBOX',
  lists: {},            // mailbox -> { messages:[], limit, reachedEnd, loading, error }
  selected: new Set(),  // 'mailbox:id'
  filter: '',
};

function mailKey(mailbox, id) { return mailbox + ':' + id; }

function getMailList(mailbox) {
  if (!mailState.lists[mailbox]) {
    mailState.lists[mailbox] = { messages: [], limit: MAIL_PAGE_STEP, reachedEnd: false, loading: false, error: null };
  }
  return mailState.lists[mailbox];
}

// 定位 DeepSeek 输入框工具栏的"添加附件/回形针"按钮（启发式）
function findAttachButton() {
  var sels = [
    'button[aria-label*="附件"]',
    'button[aria-label*="attach" i]',
    'button[aria-label*="upload" i]',
    'button[aria-label*="file" i]',
    '[data-testid*="attach" i] button',
  ];
  for (var i = 0; i < sels.length; i++) {
    try { var b = document.querySelector(sels[i]); if (b) return b; } catch (e) { /* 忽略非法选择器 */ }
  }
  var input = document.querySelector('input[type=file]');
  if (input) {
    var p = input.parentElement;
    for (var k = 0; k < 4 && p; k++) { var btn = p.querySelector('button'); if (btn) return btn; p = p.parentElement; }
  }
  return null;
}

function findFileInput() { return document.querySelector('input[type=file]'); }
function findComposer() {
  return document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea');
}

function createMailButton() {
  var existing = document.getElementById('ds-mail-btn');
  if (existing) return existing;
  var btn = document.createElement('button');
  btn.id = 'ds-mail-btn';
  btn.type = 'button';
  btn.title = '选择邮件作为附件';
  btn.setAttribute('aria-label', '选择邮件作为附件');
  btn.innerHTML = ICON_MAIL;
  btn.onclick = openMailPicker;
  return btn;
}

// 把按钮挂到指定容器（afterEl 之后）；已存在则移动到目标位置
function mountMailButton(root, afterEl) {
  var btn = createMailButton();
  if (afterEl && afterEl.parentElement === root && afterEl.nextSibling !== btn) {
    root.insertBefore(btn, afterEl.nextSibling);
  } else if (root && btn.parentElement !== root) {
    root.appendChild(btn);
  } else if (!root && btn.parentElement !== document.body) {
    document.body.appendChild(btn);
  }
  dsApplyTheme(); // 邮件按钮创建/移动后按当前主题上色
  return btn;
}

// ① 立即渲染：先挂 #pake-tools（找不到回退 body）——禁止「找不到锚点就不渲染」
function renderMailButtonImmediately() {
  var tools = document.getElementById('pake-tools') || document.body;
  mountMailButton(tools, null);
}

// ② 随后尝试移到回形针右侧（找到 attach 锚点才移动；找不到就保持已渲染位置）
function tryPlaceMailButton(triesLeft) {
  var anchor = findAttachButton();
  if (anchor && anchor.parentElement) { mountMailButton(anchor.parentElement, anchor); return; }
  if (triesLeft > 0) { setTimeout(function () { tryPlaceMailButton(triesLeft - 1); }, 1500); return; }
}

// 邮件 → Markdown（唯一一处转换实现）
function mailToMarkdown(msg) {
  var label = msg.mailbox;
  for (var i = 0; i < MAIL_TABS.length; i++) { if (MAIL_TABS[i].key === msg.mailbox) label = MAIL_TABS[i].label; }
  return '# ' + msg.subject + '\n\n'
    + '- **发件人：** ' + msg.sender + '\n'
    + '- **日期：** ' + msg.date + '\n'
    + '- **邮箱：** ' + label + '\n\n'
    + '---\n\n' + msg.body + '\n';
}

// 文件名清洗：去非法字符与控制字符、压缩空白、限长 60，空则 email
function sanitizeFilename(name) {
  var s = String(name || '').replace(/[\/\\:*?"<>|]/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 60) s = s.slice(0, 60);
  return s || 'email';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------- 弹窗样式（内联注入） ----------
function injectMailStyles() {
  if (document.getElementById('ds-mail-style')) return;
  var st = document.createElement('style');
  st.id = 'ds-mail-style';
  st.textContent = [
    '#ds-mail-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ds-fg);cursor:pointer;line-height:0}',
    '#ds-mail-btn:hover{background:var(--ds-hover)}',
    '#ds-mail-btn svg{width:18px;height:18px}',
    '#ds-mail-overlay{position:fixed;inset:0;background:var(--ds-overlay);z-index:2147483646;display:flex;align-items:center;justify-content:center}',
    '.ds-mail-panel{width:560px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;background:var(--ds-panel);border-radius:12px;box-shadow:var(--ds-shadow);overflow:hidden;font-size:14px;color:var(--ds-fg)}',
    '.ds-mail-head{padding:14px 16px;font-weight:600;border-bottom:1px solid var(--ds-panel-border)}',
    '.ds-mail-tabs{display:flex;gap:6px;padding:10px 16px 0}',
    '.ds-mail-tab{padding:6px 12px;border:1px solid var(--ds-border);border-radius:999px;background:transparent;cursor:pointer;font-size:13px;color:var(--ds-fg)}',
    '.ds-mail-tab.active{background:#3964fe;color:#fff;border-color:#3964fe}',
    '.ds-mail-filter{margin:10px 16px;padding:8px 10px;border:1px solid var(--ds-input-border);border-radius:8px;font-size:13px;outline:none;background:var(--ds-input-bg);color:var(--ds-fg)}',
    '.ds-mail-filter::placeholder{color:var(--ds-fg-dim)}',
    '.ds-mail-list{flex:1;overflow:auto;padding:0 8px 8px}',
    '.ds-mail-row{display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;cursor:pointer}',
    '.ds-mail-row:hover{background:var(--ds-hover)}',
    '.ds-mail-row .ds-mail-date{color:var(--ds-fg-dim);font-size:12px;white-space:nowrap}',
    '.ds-mail-row .ds-mail-sender{color:var(--ds-fg-mid);font-size:13px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ds-mail-row .ds-mail-subj{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ds-mail-status{padding:18px;text-align:center;color:var(--ds-fg-dim)}',
    '.ds-mail-more{margin:8px;padding:8px;width:calc(100% - 16px);border:1px solid var(--ds-border);border-radius:8px;background:transparent;color:var(--ds-fg);cursor:pointer}',
    '.ds-mail-foot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid var(--ds-panel-border)}',
    '.ds-mail-foot button{padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid var(--ds-border);background:transparent;color:var(--ds-fg)}',
    '.ds-mail-foot .ds-mail-ok{background:#3964fe;border-color:#3964fe;color:#fff}',
    '.ds-mail-foot .ds-mail-ok:disabled{opacity:.5;cursor:not-allowed}',
    '.ds-mail-foot .ds-mail-refresh{background:transparent;color:var(--ds-fg)}',
    '.ds-mail-foot .ds-mail-refresh:disabled{opacity:.6;cursor:default}',
    '.ds-mail-count{color:var(--ds-fg-dim);font-size:13px}',
  ].join('\n');
  document.head.appendChild(st);
}

// ---------- 弹窗 ----------
function openMailPicker() {
  if (document.getElementById('ds-mail-overlay')) return;
  injectMailStyles();
  var overlay = document.createElement('div');
  overlay.id = 'ds-mail-overlay';
  var tabsHtml = '';
  for (var i = 0; i < MAIL_TABS.length; i++) {
    tabsHtml += '<button class="ds-mail-tab" data-mb="' + MAIL_TABS[i].key + '">' + MAIL_TABS[i].label + '</button>';
  }
  overlay.innerHTML = '<div class="ds-mail-panel">'
    + '<div class="ds-mail-head">选择邮件作为附件</div>'
    + '<div class="ds-mail-tabs">' + tabsHtml + '</div>'
    + '<input class="ds-mail-filter" type="text" placeholder="按发件人 / 主题过滤（仅已加载）">'
    + '<div class="ds-mail-list"><div class="ds-mail-status">加载中…</div></div>'
    + '<div class="ds-mail-foot"><span class="ds-mail-count">已选 0 封</span>'
    + '<button class="ds-mail-refresh" type="button">刷新</button><span style="flex:1"></span>'
    + '<button class="ds-mail-cancel">取消</button><button class="ds-mail-ok" disabled>确定</button></div>'
    + '</div>';
  document.body.appendChild(overlay);
  dsApplyTheme(); // 弹窗可能开在主题已切换之后：创建即上色

  var tabEls = overlay.querySelectorAll('.ds-mail-tab');
  for (var t = 0; t < tabEls.length; t++) {
    tabEls[t].onclick = (function (el) {
      return function () { switchMailTab(el.getAttribute('data-mb')); };
    })(tabEls[t]);
  }
  overlay.querySelector('.ds-mail-filter').oninput = function (e) {
    mailState.filter = e.target.value || '';
    renderMailList();
  };
  overlay.querySelector('.ds-mail-cancel').onclick = closeMailPicker;
  overlay.querySelector('.ds-mail-ok').onclick = confirmMailPick;
  overlay.querySelector('.ds-mail-refresh').onclick = refreshMailTab;
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeMailPicker(); });

  updateMailTabs();
  renderMailList();
  mailLoadTab(mailState.tab, false);
}

function closeMailPicker() {
  clearMailSlowHint();
  // 关闭弹窗即清空选择：重开为干净状态，避免「已选 N 封」与当前实际勾选不符
  // （取消 / 点遮罩 / 成功附加都走这里；取正文失败的「重试」路径不关闭弹窗，选择得以保留）
  mailState.selected.clear();
  var o = document.getElementById('ds-mail-overlay');
  if (o) { updateMailFooter(); o.remove(); }
}

function switchMailTab(mailbox) {
  mailState.tab = mailbox;
  updateMailTabs();
  var st = mailState.lists[mailbox];
  if (!st || (!st.messages.length && !st.loading)) mailLoadTab(mailbox, false);
  else renderMailList();
}

function updateMailTabs() {
  var overlay = document.getElementById('ds-mail-overlay');
  if (!overlay) return;
  var tabEls = overlay.querySelectorAll('.ds-mail-tab');
  for (var i = 0; i < tabEls.length; i++) {
    var on = tabEls[i].getAttribute('data-mb') === mailState.tab;
    tabEls[i].className = 'ds-mail-tab' + (on ? ' active' : '');
  }
}

// 慢加载提示：>3s 仍无数据时把「加载中…」换成更具体的文案
var mailSlowTimer = null;
function clearMailSlowHint() {
  if (mailSlowTimer) { clearTimeout(mailSlowTimer); mailSlowTimer = null; }
}
function startMailSlowHint(mailbox) {
  clearMailSlowHint();
  mailSlowTimer = setTimeout(function () {
    mailSlowTimer = null;
    if (mailState.tab !== mailbox) return;
    var list = document.querySelector('#ds-mail-overlay .ds-mail-list');
    var st = mailState.lists[mailbox];
    if (list && st && st.loading && !st.messages.length) {
      list.innerHTML = '<div class="ds-mail-status">正在启动 Mail，首次可能较慢，请稍候…</div>';
    }
  }, 3000);
}

// 底部刷新按钮：以 refresh:true 重载当前 tab（绕过缓存）
function refreshMailTab() {
  var st = getMailList(mailState.tab);
  if (st.loading) return;
  mailLoadTab(mailState.tab, false, { refresh: true });
}

async function mailLoadTab(mailbox, more, opts) {
  var st = getMailList(mailbox);
  if (st.loading) return;
  var refresh = !!(opts && opts.refresh);
  st.loading = true;
  st.error = null;
  var limit = more ? Math.min(st.limit + MAIL_PAGE_STEP, MAIL_PAGE_MAX) : MAIL_PAGE_STEP;
  renderMailList();
  startMailSlowHint(mailbox);
  try {
    var r = await postToBridge({ mailbox: mailbox, limit: limit, refresh: refresh }, '/mails', { timeoutMs: MAIL_FETCH_TIMEOUT_MS });
    if (!r.ok) {
      var msg = (r.error && r.error.message) ? r.error.message : String(r.error);
      if ((r.error && r.error.name === 'AbortError') || /abort/i.test(msg) || /timeout/i.test(msg)) {
        st.error = '请求超时，请点刷新重试';
      } else if (/mail-not-ready/.test(msg)) {
        st.error = 'Mail 未能就绪，请点重试';
      } else {
        st.error = msg;
      }
      return;
    }
    st.messages = r.messages || [];
    st.limit = limit;
    st.reachedEnd = st.messages.length < limit || limit >= MAIL_PAGE_MAX;
  } finally {
    st.loading = false;
    clearMailSlowHint();
    renderMailList();
  }
}

function renderMailList() {
  var overlay = document.getElementById('ds-mail-overlay');
  if (!overlay) return;
  var list = overlay.querySelector('.ds-mail-list');
  var st = getMailList(mailState.tab);
  var filter = mailState.filter.toLowerCase();

  if (st.loading && !st.messages.length) { list.innerHTML = '<div class="ds-mail-status">加载中…</div>'; updateMailFooter(); return; }
  if (st.error) { list.innerHTML = '<div class="ds-mail-status">加载失败：' + escapeHtml(st.error) + '</div>'; updateMailFooter(); return; }

  var rows = [];
  for (var i = 0; i < st.messages.length; i++) {
    var m = st.messages[i];
    var hay = (m.subject + ' ' + m.sender).toLowerCase();
    if (filter && hay.indexOf(filter) === -1) continue;
    rows.push(m);
  }
  if (!rows.length) {
    list.innerHTML = '<div class="ds-mail-status">' + (st.messages.length ? '无匹配邮件' : '暂无邮件') + '</div>';
  } else {
    var html = '';
    for (var j = 0; j < rows.length; j++) {
      var msg = rows[j];
      var key = mailKey(mailState.tab, msg.id);
      var checked = mailState.selected.has(key) ? ' checked' : '';
      var d = (msg.date || '').slice(0, 10);
      html += '<label class="ds-mail-row">'
        + '<input type="checkbox" class="ds-mail-cb" data-key="' + key + '"' + checked + '>'
        + '<span class="ds-mail-date">' + escapeHtml(d) + '</span>'
        + '<span class="ds-mail-sender">' + escapeHtml(msg.sender) + '</span>'
        + '<span class="ds-mail-subj">' + escapeHtml(msg.subject) + '</span>'
        + '</label>';
    }
    list.innerHTML = html;
    var cbs = list.querySelectorAll('.ds-mail-cb');
    for (var c = 0; c < cbs.length; c++) {
      cbs[c].onchange = (function (el) {
        return function () { toggleMailSelect(el.getAttribute('data-key'), el.checked); };
      })(cbs[c]);
    }
    if (!st.reachedEnd) {
      var more = document.createElement('button');
      more.className = 'ds-mail-more';
      more.textContent = st.loading ? '加载中…' : '加载更多';
      more.onclick = function () { mailLoadTab(mailState.tab, true); };
      list.appendChild(more);
    }
  }
  updateMailFooter();
}

function toggleMailSelect(key, on) {
  if (on) mailState.selected.add(key); else mailState.selected.delete(key);
  updateMailFooter();
}

function updateMailFooter() {
  var overlay = document.getElementById('ds-mail-overlay');
  if (!overlay) return;
  var n = mailState.selected.size;
  overlay.querySelector('.ds-mail-count').textContent = '已选 ' + n + ' 封';
  var ok = overlay.querySelector('.ds-mail-ok');
  ok.disabled = n === 0;
  ok.textContent = n > 0 ? ('确定（附加 ' + n + ' 封）') : '确定';
  var st = getMailList(mailState.tab);
  var refresh = overlay.querySelector('.ds-mail-refresh');
  if (refresh) {
    if (st.loading) { refresh.disabled = true; refresh.textContent = '刷新中…'; }
    else { refresh.disabled = false; refresh.textContent = st.error ? '重试' : '刷新'; }
  }
}

async function confirmMailPick() {
  var keys = [];
  mailState.selected.forEach(function (k) { keys.push(k); });
  if (!keys.length) return;
  var okBtn = document.querySelector('.ds-mail-ok');
  if (okBtn) { okBtn.disabled = true; okBtn.textContent = '获取正文…'; }
  var files = [];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var sep = key.lastIndexOf(':');
    var mailbox = key.slice(0, sep);
    var id = Number(key.slice(sep + 1));
    var r = await postToBridge({ mailbox: mailbox, id: id }, '/mail');
    if (!r.ok || !r.message) {
      var reason = (r.error && r.error.message) ? r.error.message : String(r.error || '未知错误');
      reason = reason.replace(/^HTTP \d+:\s*/, '');
      showTip('✗ 取邮件正文失败：' + reason, '#ef4444');
      if (okBtn) { okBtn.disabled = false; updateMailFooter(); }
      return;
    }
    var msg = r.message;
    var md = mailToMarkdown(msg);
    var fname = (msg.date || '').slice(0, 10) + '-' + sanitizeFilename(msg.subject) + '.md';
    files.push(new File([md], fname, { type: 'text/markdown' }));
  }
  closeMailPicker();
  attachMails(files);
}

// ---------- 附件注入 ----------
function attachMails(files) {
  if (!files.length) return;
  var input = findFileInput();
  if (input && typeof DataTransfer !== 'undefined') {
    try {
      if (input.multiple === false && files.length > 1) {
        for (var i = 0; i < files.length; i++) {
          var dt1 = new DataTransfer();
          dt1.items.add(files[i]);
          input.files = dt1.files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        showTip('已附加（逐封依次注入）', DS_BLUE);
        return;
      }
      var dt = new DataTransfer();
      if (input.files) { for (var j = 0; j < input.files.length; j++) { dt.items.add(input.files[j]); } }
      for (var k = 0; k < files.length; k++) { dt.items.add(files[k]); }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      showTip('已附加 ' + files.length + ' 封邮件', DS_BLUE);
      return;
    } catch (e) { /* 落到文本兜底 */ }
  }
  insertMailsAsText(files);
}

function insertMailsAsText(files) {
  var composer = findComposer();
  if (!composer) { showTip('✗ 找不到输入框，无法插入', '#ef4444'); return; }
  Promise.all(files.map(function (f) { return f.text(); })).then(function (texts) {
    var text = texts.join('\n\n---\n\n');
    if (composer.tagName === 'TEXTAREA') {
      composer.value = (composer.value ? composer.value + '\n\n' : '') + text;
    } else {
      composer.textContent = (composer.textContent ? composer.textContent + '\n\n' : '') + text;
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    showTip('已插入为文本', DS_BLUE);
  });
}

// ---------- 诊断上报（失败静默，不影响主流程） ----------
function mailProbe() {
  try {
    var attach = findAttachButton();
    var fileInput = findFileInput();
    var composer = findComposer();
    postToBridge({
      attachButton: !!attach,
      attachLabel: attach ? (attach.getAttribute('aria-label') || attach.className || '') : null,
      fileInput: !!fileInput,
      composer: !!composer,
      href: location.href,
    }, '/probe');
  } catch (e) { /* 静默 */ }
}

// ========== 本机上下文（文件 / 剪贴板） ==========
// 点开面板挑本机文件或读剪贴板，拼成文本块插入输入框：不自动发送、不联网上传。
// 文件内容只在本地读取；剪贴板经本地桥 pbpaste 读取（桥端日志只记大小，不记内容）。

const CTX_MAX_FILE_BYTES = 200 * 1024;    // 单文件上限（UTF-8 字节）
const CTX_MAX_TOTAL_BYTES = 1024 * 1024;  // 单次插入总上限
const CTX_SNIFF_BYTES = 1024;             // 二进制嗅探字节数
const CTX_ACCEPT = '.txt,.md,.markdown,.json,.jsonl,.csv,.log,.py,.js,.ts,.swift,.go,.java,.rs,.c,.h,.cpp,.html,.css,.sh,.yaml,.yml,.toml,.xml,.sql,.ini,.conf';

var ctxState = { tab: 'file', items: [], clipboard: null, status: '', statusError: false };
var ctxSeq = 0;
var ctxEscHandler = null;

// ---- 纯函数（无 DOM 依赖，可被 node 直接单测）----

// 统一转字节视图：string -> UTF-8；TypedArray / ArrayBuffer 原样
function ctxToBytes(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (typeof Uint8Array !== 'undefined' && data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

// 是否像文本：前 1024 字节里出现 0x00 即判二进制
function isProbablyText(data) {
  var bytes = ctxToBytes(data);
  if (!bytes) return false;
  var n = Math.min(bytes.length, CTX_SNIFF_BYTES);
  for (var i = 0; i < n; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

// UTF-8 字节长度（浏览器 / Node 通用，不依赖 Buffer）
function utf8ByteLength(text) {
  var bytes = ctxToBytes(typeof text === 'string' ? text : String(text == null ? '' : text));
  return bytes ? bytes.length : 0;
}

// 按 UTF-8 字节上限截断：只保留完整码点，不产生乱码 / 半个代理对
function truncateText(text, maxBytes) {
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  var max = Number(maxBytes);
  if (!Number.isFinite(max) || max <= 0) return '';
  if (utf8ByteLength(text) <= max) return text;
  var parts = [];
  var used = 0;
  for (var i = 0; i < text.length;) {
    var code = text.codePointAt(i);
    var units = code > 0xFFFF ? 2 : 1;
    var bytes = code <= 0x7F ? 1 : code <= 0x7FF ? 2 : code <= 0xFFFF ? 3 : 4;
    if (used + bytes > max) break;
    parts.push(text.slice(i, i + units));
    used += bytes;
    i += units;
  }
  return parts.join('');
}

function formatBytes(n) {
  var v = Number(n);
  if (!Number.isFinite(v) || v < 0) v = 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

// sources: [{ kind: 'file'|'clipboard', name?, text, bytes? }] -> 文本块；全空返回 ''
function formatContextBlock(sources) {
  if (!Array.isArray(sources)) return '';
  var parts = [];
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (!s || typeof s.text !== 'string' || s.text === '') continue;
    var size = formatBytes(s.bytes != null ? s.bytes : utf8ByteLength(s.text));
    var label = s.kind === 'clipboard'
      ? '--- 剪贴板（' + size + '）---'
      : '--- 文件：' + (s.name || '未命名') + '（' + size + '）---';
    parts.push(label + '\n' + s.text);
  }
  if (!parts.length) return '';
  return '【本地上下文 · ' + parts.length + ' 个来源】\n\n' + parts.join('\n\n');
}

// ---- 样式（幂等；颜色全部用 --ds-* 变量，跟随主题）----
function injectContextStyles() {
  if (document.getElementById('ds-ctx-style')) return;
  var st = document.createElement('style');
  st.id = 'ds-ctx-style';
  st.textContent = [
    '#ds-ctx-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--ds-fg);cursor:pointer;line-height:0}',
    '#ds-ctx-btn:hover{background:var(--ds-hover)}',
    '#ds-ctx-btn:active{background:var(--ds-active)}',
    '#ds-ctx-btn svg{width:18px;height:18px}',
    '.ds-ctx-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:var(--ds-overlay)}',
    '.ds-ctx-panel{width:560px;max-width:92vw;max-height:78vh;display:flex;flex-direction:column;background:var(--ds-panel);color:var(--ds-fg);border:1px solid var(--ds-panel-border);border-radius:12px;box-shadow:var(--ds-shadow);overflow:hidden;font-size:14px}',
    '.ds-ctx-head{padding:14px 16px;font-weight:600;border-bottom:1px solid var(--ds-border)}',
    '.ds-ctx-head span{margin-left:8px;font-weight:400;font-size:12px;color:var(--ds-fg-dim)}',
    '.ds-ctx-tabs{display:flex;gap:8px;padding:10px 16px;border-bottom:1px solid var(--ds-border)}',
    '.ds-ctx-tab{height:30px;padding:0 12px;border:1px solid var(--ds-border);border-radius:999px;background:transparent;color:var(--ds-fg-mid);font-size:13px;cursor:pointer}',
    '.ds-ctx-tab:hover{background:var(--ds-hover)}',
    '.ds-ctx-tab.active{background:var(--ds-active);color:var(--ds-fg);border-color:transparent}',
    '.ds-ctx-body{padding:12px 16px;overflow:auto;flex:1;min-height:160px}',
    '.ds-ctx-pane{display:flex;flex-direction:column;gap:10px}',
    '.ds-ctx-filelist{display:flex;flex-direction:column;gap:6px}',
    '.ds-ctx-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--ds-border);border-radius:8px}',
    '.ds-ctx-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ds-ctx-meta{color:var(--ds-fg-dim);font-size:12px;white-space:nowrap}',
    '.ds-ctx-remove{border:none;background:transparent;color:var(--ds-fg-dim);font-size:16px;line-height:1;cursor:pointer;padding:0 2px}',
    '.ds-ctx-remove:hover{color:var(--ds-fg)}',
    '.ds-ctx-empty{color:var(--ds-fg-dim);font-size:13px}',
    '.ds-ctx-clip-info{color:var(--ds-fg-mid);font-size:13px}',
    '.ds-ctx-preview{white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;padding:8px;border:1px solid var(--ds-input-border);border-radius:8px;background:var(--ds-input-bg);color:var(--ds-fg-mid);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
    '.ds-ctx-actions{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--ds-border)}',
    '.ds-ctx-btn{height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--ds-border);background:transparent;color:var(--ds-fg);font-size:13px;font-weight:500;cursor:pointer}',
    '.ds-ctx-btn:hover{background:var(--ds-hover)}',
    '.ds-ctx-btn.primary{background:' + DS_BLUE + ';border-color:' + DS_BLUE + ';color:#fff}',
    '.ds-ctx-btn.primary:hover{background:' + DS_BLUE_LIGHT + ';border-color:' + DS_BLUE_LIGHT + '}',
    '.ds-ctx-btn:disabled{opacity:.5;cursor:default}',
    '.ds-ctx-status{color:var(--ds-fg-dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}',
    '.ds-ctx-status.ds-ctx-error{color:#ef4444}',
    '.ds-ctx-build{margin-left:auto;font-size:11px;color:var(--ds-fg-dim);opacity:.8;white-space:nowrap}',
    '.ds-ctx-spacer{flex:1}',
  ].join('\n');
  document.head.appendChild(st);
}

// ---- 按钮（幂等；跟随邮件按钮定位）----
function createContextButton() {
  var existing = document.getElementById('ds-ctx-btn');
  if (existing) return existing;
  injectContextStyles();
  var btn = document.createElement('button');
  btn.id = 'ds-ctx-btn';
  btn.type = 'button';
  btn.title = '本机上下文（文件 / 剪贴板）';
  btn.setAttribute('aria-label', '本机上下文（文件 / 剪贴板）');
  btn.innerHTML = ICON_CONTEXT;
  btn.onclick = openContextPanel;
  return btn;
}

// 挂在邮件按钮右侧；没有邮件按钮时退回 #pake-tools / body
function placeContextButton() {
  var btn = createContextButton();
  var mail = document.getElementById('ds-mail-btn');
  if (mail && mail.parentElement) {
    if (mail.nextSibling !== btn) mail.parentElement.insertBefore(btn, mail.nextSibling);
    return btn;
  }
  var root = document.getElementById('pake-tools');
  if (root) {
    if (btn.parentElement !== root) root.appendChild(btn);
  } else if (btn.parentElement !== document.body) {
    document.body.appendChild(btn);
  }
  return btn;
}

function renderContextButtonImmediately() { placeContextButton(); }

// 邮件按钮可能稍后才移到回形针右侧 —— 跟随重定位（幂等）
function tryPlaceContextButton(triesLeft) {
  placeContextButton();
  if (triesLeft > 0) setTimeout(function () { tryPlaceContextButton(triesLeft - 1); }, 1500);
}

// ---- 面板 ----
function ctxSetStatus(msg, isError) {
  ctxState.status = msg || '';
  ctxState.statusError = !!isError;
  var overlay = document.getElementById('ds-ctx-overlay');
  if (!overlay) return;
  var st = overlay.querySelector('.ds-ctx-status');
  if (st) {
    st.textContent = ctxState.status;
    st.className = 'ds-ctx-status' + (ctxState.statusError ? ' ds-ctx-error' : '');
  }
}

function ctxPanelHtml() {
  return '<div class="ds-ctx-panel">'
    + '<div class="ds-ctx-head">本机上下文<span>只插入，不发送</span></div>'
    + '<div class="ds-ctx-tabs">'
    + '<button class="ds-ctx-tab" type="button" data-tab="file">文件</button>'
    + '<button class="ds-ctx-tab" type="button" data-tab="clipboard">剪贴板</button>'
    + '</div>'
    + '<div class="ds-ctx-body">'
    + '<input class="ds-ctx-file-input" type="file" multiple style="display:none" accept="' + CTX_ACCEPT + '">'
    + '<div class="ds-ctx-pane ds-ctx-file-pane">'
    + '<div><button class="ds-ctx-btn ds-ctx-pick" type="button">选择文件</button></div>'
    + '<div class="ds-ctx-filelist"></div>'
    + '</div>'
    + '<div class="ds-ctx-pane ds-ctx-clip-pane">'
    + '<div><button class="ds-ctx-btn ds-ctx-read-clip" type="button">读取剪贴板</button></div>'
    + '<div class="ds-ctx-clip-info"></div>'
    + '<div class="ds-ctx-preview"></div>'
    + '</div>'
    + '</div>'
    + '<div class="ds-ctx-actions">'
    + '<span class="ds-ctx-status"></span><span class="ds-ctx-spacer"></span>'
    + '<span class="ds-ctx-build">build ' + DSBRIDGE_BUILD + '</span>'
    + '<button class="ds-ctx-btn ds-ctx-cancel" type="button">取消</button>'
    + '<button class="ds-ctx-btn primary ds-ctx-insert" type="button">插入到输入框</button>'
    + '</div>'
    + '</div>';
}

function openContextPanel() {
  if (document.getElementById('ds-ctx-overlay')) return;
  injectContextStyles();
  var overlay = document.createElement('div');
  overlay.id = 'ds-ctx-overlay';
  overlay.className = 'ds-ctx-overlay';
  overlay.innerHTML = ctxPanelHtml();
  document.body.appendChild(overlay);
  bindContextPanel(overlay);
  ctxState.tab = 'file';
  ctxState.status = '';
  ctxState.statusError = false;
  renderContextPanel();
  dsApplyTheme();
  if (!ctxEscHandler) {
    ctxEscHandler = function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); closeContextPanel(); }
    };
    document.addEventListener('keydown', ctxEscHandler, true);
  }
}

function bindContextPanel(overlay) {
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closeContextPanel(); });
  var tabs = overlay.querySelectorAll('.ds-ctx-tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].onclick = function () {
      ctxState.tab = this.getAttribute('data-tab');
      renderContextPanel();
    };
  }
  var fileInput = overlay.querySelector('.ds-ctx-file-input');
  overlay.querySelector('.ds-ctx-pick').onclick = function () { fileInput.click(); };
  fileInput.onchange = function (e) {
    handleContextFiles(e.target.files).catch(function (err) {
      ctxSetStatus('读取失败：' + (err && err.message ? err.message : '未知错误'), true);
    }).then(function () {
      try { fileInput.value = ''; } catch (e2) { /* 忽略 */ }
    });
  };
  overlay.querySelector('.ds-ctx-read-clip').onclick = function () {
    readClipboardIntoPanel().catch(function (err) {
      ctxSetStatus('剪贴板读取失败：' + (err && err.message ? err.message : '未知错误'), true);
    });
  };
  overlay.querySelector('.ds-ctx-cancel').onclick = closeContextPanel;
  overlay.querySelector('.ds-ctx-insert').onclick = insertContextFromPanel;
}

function renderContextPanel() {
  var overlay = document.getElementById('ds-ctx-overlay');
  if (!overlay) return;
  var tabs = overlay.querySelectorAll('.ds-ctx-tab');
  for (var i = 0; i < tabs.length; i++) {
    var on = tabs[i].getAttribute('data-tab') === ctxState.tab;
    tabs[i].className = 'ds-ctx-tab' + (on ? ' active' : '');
  }
  overlay.querySelector('.ds-ctx-file-pane').style.display = ctxState.tab === 'file' ? '' : 'none';
  overlay.querySelector('.ds-ctx-clip-pane').style.display = ctxState.tab === 'clipboard' ? '' : 'none';

  var list = overlay.querySelector('.ds-ctx-filelist');
  list.innerHTML = '';
  if (!ctxState.items.length) {
    var empty = document.createElement('div');
    empty.className = 'ds-ctx-empty';
    empty.textContent = '还没有选择文件';
    list.appendChild(empty);
  } else {
    for (var j = 0; j < ctxState.items.length; j++) {
      list.appendChild(ctxFileRow(ctxState.items[j]));
    }
  }

  var info = overlay.querySelector('.ds-ctx-clip-info');
  var preview = overlay.querySelector('.ds-ctx-preview');
  if (ctxState.clipboard) {
    info.textContent = '已读取 ' + formatBytes(ctxState.clipboard.bytes) + (ctxState.clipboard.truncated ? '（超出上限，已截断）' : '');
    preview.textContent = ctxState.clipboard.text.slice(0, 500);
    preview.style.display = '';
  } else {
    info.textContent = '尚未读取剪贴板';
    preview.textContent = '';
    preview.style.display = 'none';
  }

  var st = overlay.querySelector('.ds-ctx-status');
  st.textContent = ctxState.status;
  st.className = 'ds-ctx-status' + (ctxState.statusError ? ' ds-ctx-error' : '');

  overlay.querySelector('.ds-ctx-insert').disabled = !(ctxState.items.length || ctxState.clipboard);
}

function ctxFileRow(item) {
  var row = document.createElement('div');
  row.className = 'ds-ctx-row';
  var name = document.createElement('span');
  name.className = 'ds-ctx-name';
  name.textContent = item.name;
  var meta = document.createElement('span');
  meta.className = 'ds-ctx-meta';
  meta.textContent = formatBytes(item.bytes) + (item.truncated ? ' · 已截断' : '');
  var rm = document.createElement('button');
  rm.className = 'ds-ctx-remove';
  rm.type = 'button';
  rm.title = '移除';
  rm.textContent = '×';
  rm.onclick = function () {
    for (var k = 0; k < ctxState.items.length; k++) {
      if (ctxState.items[k].id === item.id) { ctxState.items.splice(k, 1); break; }
    }
    renderContextPanel();
  };
  row.appendChild(name);
  row.appendChild(meta);
  row.appendChild(rm);
  return row;
}

// ---- 文件读取 ----
function readFileHead(file, maxBytes) {
  var blob = file.slice(0, maxBytes);
  if (blob && typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(reader.result); };
    reader.onerror = function () { reject(reader.error || new Error('读取失败')); };
    reader.readAsArrayBuffer(blob);
  });
}

function readFileText(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result == null ? '' : reader.result)); };
    reader.onerror = function () { reject(reader.error || new Error('读取失败')); };
    reader.readAsText(file, 'utf-8');
  });
}

function ctxTotalBytes() {
  var total = 0;
  for (var i = 0; i < ctxState.items.length; i++) total += ctxState.items[i].bytes || 0;
  return total;
}

// 读一批文件：空文件 / 二进制跳过；单文件 200 KB、总量 1 MB 上限
async function handleContextFiles(fileList) {
  var files = [];
  for (var i = 0; i < (fileList ? fileList.length : 0); i++) files.push(fileList[i]);
  if (!files.length) return;
  var added = 0;
  var skipped = 0;
  var hitCap = false;
  for (var j = 0; j < files.length; j++) {
    var file = files[j];
    try {
      if (!file || !file.size) { skipped++; continue; }
      var head = await readFileHead(file, CTX_SNIFF_BYTES);
      if (!isProbablyText(head)) { skipped++; continue; }
      var raw = await readFileText(file);
      if (typeof raw !== 'string' || raw === '') { skipped++; continue; }
      var bytes = utf8ByteLength(raw);
      if (ctxTotalBytes() + bytes > CTX_MAX_TOTAL_BYTES) { hitCap = true; break; }
      ctxState.items.push({
        id: 'ctx-' + (++ctxSeq),
        name: file.name || ('文件' + (j + 1)),
        text: bytes > CTX_MAX_FILE_BYTES ? truncateText(raw, CTX_MAX_FILE_BYTES) : raw,
        bytes: bytes,
        truncated: bytes > CTX_MAX_FILE_BYTES,
      });
      added++;
    } catch (e) {
      skipped++;
    }
  }
  if (hitCap) ctxSetStatus('已达总上限 1 MB，其余文件未加入', true);
  else if (added && skipped) ctxSetStatus('已加入 ' + added + ' 个文件，跳过 ' + skipped + ' 个空 / 二进制文件', false);
  else if (added) ctxSetStatus('已加入 ' + added + ' 个文件', false);
  else if (skipped) ctxSetStatus('已跳过 ' + skipped + ' 个空 / 二进制文件', true);
  renderContextPanel();
}

// ---- 剪贴板（经本地桥 pbpaste）----
// 直接返回桥的响应体（postToBridge 只认 ok:true，无法区分「剪贴板不可用」与「桥不可达」）
async function postJsonRaw(payload, endpoint, timeoutMs) {
  var urls = [DSBRIDGE_URL].concat(DSBRIDGE_FALLBACK_URLS);
  var lastErr = null;
  for (var i = 0; i < urls.length; i++) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 5000) : null;
    try {
      const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      };
      if (controller) options.signal = controller.signal;
      const res = await fetch(urls[i] + endpoint, options);
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (body) return body;
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) {
      lastErr = e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return { ok: false, error: 'bridge-unreachable', detail: lastErr && lastErr.message ? lastErr.message : '' };
}

async function readClipboardIntoPanel() {
  ctxSetStatus('正在读取剪贴板…', false);
  var result = await postJsonRaw({}, '/context/clipboard', 5000);
  if (!result || result.ok !== true) {
    if (result && result.error === 'clipboard-unavailable') ctxSetStatus('剪贴板不可用（pbpaste 失败或超时）', true);
    else if (result && result.error === 'bridge-unreachable') ctxSetStatus('本地桥不可达，请确认 bridge.js 在运行', true);
    else ctxSetStatus('剪贴板读取失败：' + (result && result.error ? String(result.error) : '未知错误'), true);
    return;
  }
  var text = typeof result.text === 'string' ? result.text : '';
  if (!text) { ctxSetStatus('剪贴板为空', true); return; }
  var bytes = Number(result.bytes);
  ctxState.clipboard = {
    kind: 'clipboard',
    text: text,
    bytes: Number.isFinite(bytes) ? bytes : utf8ByteLength(text),
    truncated: !!result.truncated,
  };
  ctxSetStatus(result.truncated ? '已读取剪贴板（超出 200 KB，已截断）' : '已读取剪贴板', false);
  renderContextPanel();
}

// ---- 插入 ----
function insertContextFromPanel() {
  var sources = [];
  for (var i = 0; i < ctxState.items.length; i++) {
    var it = ctxState.items[i];
    sources.push({ kind: 'file', name: it.name, text: it.text, bytes: it.bytes });
  }
  if (ctxState.clipboard) sources.push(ctxState.clipboard);
  var block = formatContextBlock(sources);
  if (!block) { ctxSetStatus('没有可插入的内容', true); return; }
  if (insertContextToComposer(block)) closeContextPanel();
}

function insertContextToComposer(text) {
  if (typeof text !== 'string' || !text) return false;
  var composer = findComposer();
  if (!composer) { showTip('找不到输入框，请等页面加载完成', '#ef4444'); return false; }
  try { composer.focus(); } catch (e) { /* 忽略 */ }
  var inserted = false;
  var editable = composer.getAttribute && composer.getAttribute('contenteditable') === 'true';
  if (editable && typeof document.execCommand === 'function') {
    try { inserted = document.execCommand('insertText', false, text); } catch (e) { inserted = false; }
  }
  if (!inserted) {
    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      composer.value = (composer.value ? composer.value + '\n\n' : '') + text;
    } else {
      composer.textContent = (composer.textContent ? composer.textContent + '\n\n' : '') + text;
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    inserted = true;
  }
  return inserted;
}

function closeContextPanel() {
  if (ctxEscHandler) { document.removeEventListener('keydown', ctxEscHandler, true); ctxEscHandler = null; }
  var overlay = document.getElementById('ds-ctx-overlay');
  if (overlay) overlay.remove();
  ctxState.items = [];
  ctxState.clipboard = null;
  ctxState.status = '';
  ctxState.statusError = false;
}

// ========== 初始化 ==========
function initDsbridge() {
  addButtons();
  renderMailButtonImmediately(); // 邮件按钮先渲染（不等锚点）
  tryPlaceMailButton(20);        // 随后再尝试移到回形针右侧
  renderContextButtonImmediately(); // 本机上下文按钮：挂在邮件按钮右侧
  tryPlaceContextButton(20);        // 跟随邮件按钮的重定位（幂等）
  dsWatchTheme();                // 页面切主题时实时跟随
  dsApplyTheme();                // 初始化先算一次（给已存在的注入元素上色）
  setTimeout(mailProbe, 4000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDsbridge);
  } else {
    initDsbridge();
  }
}

// 本地单测出口（浏览器注入时 module 未定义，自动跳过；不影响页面行为）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    dsParseColor: dsParseColor,
    dsRelLuminance: dsRelLuminance,
    dsThemeSignal: dsThemeSignal,
    dsResolveDark: dsResolveDark,
    formatContextBlock: formatContextBlock,
    isProbablyText: isProbablyText,
    truncateText: truncateText,
  };
}
