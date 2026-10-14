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
// 浏览器打开：外部链接箭头
const ICON_EXTERNAL = `<svg ${ICON_COMMON}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
// 邮件：信封
const ICON_MAIL = `<svg ${ICON_COMMON}><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>`;

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
      border: 1px solid rgba(0, 0, 0, 0.1);
      border-radius: 999px;
      background: transparent;
      color: #0f1115;
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
      background: rgba(38, 49, 72, 0.06);
    }
    #pake-tools button:active {
      background: rgba(38, 49, 72, 0.1);
    }
    /* 打印相关样式已移除：方案 B 走本地桥生成打印页，不再依赖页面内 @media print */
  `;

  document.head.appendChild(style);
  document.body.appendChild(container);

  document.getElementById('pake-sync').onclick = syncToBridge;
  document.getElementById('pake-export').onclick = exportConversation;
  document.getElementById('pake-copy').onclick = copyAll;
  document.getElementById('pake-open').onclick = openInBrowser;
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
const MAIL_FETCH_TIMEOUT_MS = 45000; // /mails 请求超时上限（含 Mail 拉起等待）

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
    '#ds-mail-btn{display:inline-flex;align-items:center;justify-content:center;padding:6px;border:1px solid transparent;border-radius:8px;background:transparent;color:#0f1115;cursor:pointer;line-height:0}',
    '#ds-mail-btn:hover{background:rgba(38,49,72,.06)}',
    '#ds-mail-btn svg{width:18px;height:18px}',
    '#ds-mail-overlay{position:fixed;inset:0;background:rgba(15,17,21,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center}',
    '.ds-mail-panel{width:560px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden;font-size:14px;color:#0f1115}',
    '.ds-mail-head{padding:14px 16px;font-weight:600;border-bottom:1px solid rgba(0,0,0,.08)}',
    '.ds-mail-tabs{display:flex;gap:6px;padding:10px 16px 0}',
    '.ds-mail-tab{padding:6px 12px;border:1px solid rgba(0,0,0,.1);border-radius:999px;background:transparent;cursor:pointer;font-size:13px;color:#0f1115}',
    '.ds-mail-tab.active{background:#3964fe;color:#fff;border-color:#3964fe}',
    '.ds-mail-filter{margin:10px 16px;padding:8px 10px;border:1px solid rgba(0,0,0,.15);border-radius:8px;font-size:13px;outline:none}',
    '.ds-mail-list{flex:1;overflow:auto;padding:0 8px 8px}',
    '.ds-mail-row{display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;cursor:pointer}',
    '.ds-mail-row:hover{background:rgba(38,49,72,.06)}',
    '.ds-mail-row .ds-mail-date{color:#6b7280;font-size:12px;white-space:nowrap}',
    '.ds-mail-row .ds-mail-sender{color:#374151;font-size:13px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ds-mail-row .ds-mail-subj{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ds-mail-status{padding:18px;text-align:center;color:#6b7280}',
    '.ds-mail-more{margin:8px;padding:8px;width:calc(100% - 16px);border:1px solid rgba(0,0,0,.12);border-radius:8px;background:transparent;cursor:pointer}',
    '.ds-mail-foot{display:flex;align-items:center;gap:10px;padding:12px 16px;border-top:1px solid rgba(0,0,0,.08)}',
    '.ds-mail-foot button{padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px;border:1px solid rgba(0,0,0,.12);background:transparent;color:#0f1115}',
    '.ds-mail-foot .ds-mail-ok{background:#3964fe;border-color:#3964fe;color:#fff}',
    '.ds-mail-foot .ds-mail-ok:disabled{opacity:.5;cursor:not-allowed}',
    '.ds-mail-foot .ds-mail-refresh{background:transparent;color:#0f1115}',
    '.ds-mail-foot .ds-mail-refresh:disabled{opacity:.6;cursor:default}',
    '.ds-mail-count{color:#6b7280;font-size:13px}',
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
  var o = document.getElementById('ds-mail-overlay');
  if (o) o.remove();
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
      showTip('✗ 取邮件正文失败', '#ef4444');
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

// ========== 初始化 ==========
function initDsbridge() {
  addButtons();
  renderMailButtonImmediately(); // 邮件按钮先渲染（不等锚点）
  tryPlaceMailButton(20);        // 随后再尝试移到回形针右侧
  setTimeout(mailProbe, 4000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDsbridge);
} else {
  initDsbridge();
}
