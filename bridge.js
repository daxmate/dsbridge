#!/usr/bin/env node
/**
 * dsbridge — DeepSeek 对话本地桥
 *
 * 作用：接收 DeepSeek 桌面版（Pake）注入脚本发来的对话内容，
 *       追加写入按天拆分的 jsonl 文件，供 OpenClaw 按需读取。
 *
 * 用法：
 *   node bridge.js                    # 默认 localhost:8787（HTTP + HTTPS）
 *   DSBRIDGE_PORT=8788 node bridge.js # 换端口
 *   DSBRIDGE_DATA_DIR=/path node bridge.js  # 换数据目录
 *
 * HTTPS：自签名证书（key.pem / cert.pem），需先加入系统信任：
 *   sudo security add-trusted-cert -d -r trustRoot \
 *     -k /Library/Keychains/System.keychain cert.pem
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.DSBRIDGE_PORT) || 8787;   // HTTPS 端口
const HTTP_PORT = Number(process.env.DSBRIDGE_HTTP_PORT) || 8786; // HTTP 备用端口
const HOST = process.env.DSBRIDGE_HOST || '127.0.0.1';
const DATA_DIR = process.env.DSBRIDGE_DATA_DIR || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// 统一监听 127.0.0.1（IPv4）。HTTPS 下不再有混合内容问题，无需 localhost。
const HOSTS = [HOST];

// TLS 证书（自签名，需加入系统信任后才能被 WKWebView 接受）
const TLS_OPTIONS = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};

function todayFile() {
  const d = new Date();
  const ymd = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  return path.join(DATA_DIR, `${ymd}.jsonl`);
}

/**
 * 追加消息，同日按 content 去重（重复点"同步"不会重复写入）。
 * 入参可以是消息数组，也可以是 { messages: [...] }。
 */
function handleAppend(body) {
  const messages = Array.isArray(body) ? body : (body.messages || [body]);
  const file = todayFile();

  // 已存在的 content 集合（同日去重）
  const seen = new Set();
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { seen.add(JSON.parse(line).content); } catch { /* 跳过坏行 */ }
    }
  }

  const out = [];
  for (const m of messages) {
    const content = (m && typeof m.content === 'string' ? m.content : '').trim();
    if (!content || seen.has(content)) continue;
    seen.add(content);
    out.push(JSON.stringify({
      ts: new Date().toISOString(),
      role: (m && m.role) || 'unknown',
      content,
    }));
  }

  if (out.length > 0) {
    fs.appendFileSync(file, out.join('\n') + '\n');
  }
  return { ok: true, file, appended: out.length, total: seen.size };
}

/**
 * 在系统默认浏览器中打开指定 URL（当前对话的 chat.deepseek.com 地址）。
 */
function handleOpenUrl(body) {
  const url = (body && body.url) || '';
  // 安全校验：只允许 DeepSeek 站内 http(s) 地址
  if (typeof url !== 'string' || !/^https?:\/\/(www\.)?chat\.deepseek\.com/i.test(url)) {
    return { ok: false, error: 'invalid url' };
  }
  execFile('open', [url], (err) => {
    if (err) console.error('[dsbridge] 打开 URL 失败:', err.message);
  });
  return { ok: true, url };
}

// ========== 邮件（Apple Mail / AppleScript，免登录） ==========
// 仅本机 Apple Mail 的 Senkori 账号；只读三个文件夹，排除 Junk/Deleted/Drafts/Starred。
const MAIL_ACCOUNT = 'Senkori';
const MAIL_BOXES = ['INBOX', 'Archive', 'Sent Messages'];
const MAIL_DEFAULT_LIMIT = 20;   // /mails 默认返回条数
const MAIL_MAX_LIMIT = 50;       // /mails 单次上限
const MAIL_LOOKUP_WINDOW = 200;  // /mail 按 id 命中的最近消息范围（避免全库 whose）
const MAIL_BODY_MAX = 20000;     // 正文最大字符数（超出砍尾部、保留头部）
const MAIL_OS_TIMEOUT_MS = 30000;      // 单次 osascript 调用超时（列表 / 正文）
const MAIL_CACHE_TTL_MS = 60000;       // 邮件列表内存缓存 TTL（60s）
const MAIL_READY_DEADLINE_MS = 45000;  // 等待 Mail 就绪（含拉起）的上限
const MAIL_READY_POLL_MS = 1000;       // 就绪轮询间隔
const MAIL_CACHE_FILE = path.join(DATA_DIR, '.mail-cache.json'); // 列表缓存落盘（重开后仍热）

// AppleScript 字符串字面量转义（只用固定白名单值 / 数字，不拼用户输入）
function asStr(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 字段清洗 handler：把 CR/LF/Tab 换成空格，保证 TSV 输出不串行
const AS_SANITIZE_HANDLER = `
on asSanitized(s)
	set s to s as text
	set AppleScript's text item delimiters to {return, linefeed, tab}
	set chunks to every text item of s
	set AppleScript's text item delimiters to " "
	set r to chunks as text
	set AppleScript's text item delimiters to ""
	return r
end asSanitized`;

// AppleScript 调用唯一入口（任何 Apple Mail 交互都走这里）
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { maxBuffer: 32 * 1024 * 1024, timeout: MAIL_OS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        if (err.killed || err.signal) reject(new Error('osascript timeout'));
        else reject(err);
      } else resolve(stdout);
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Mail 是否在运行（不会拉起 Mail）
function isMailRunning() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'application "Mail" is running'], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim() === 'true');
    });
  });
}

// AppleScript 是否已就绪（running ≠ AppleScript 就绪）
function mailReadyOnce() {
  return new Promise((resolve) => {
    execFile('osascript', [
      '-e', 'with timeout of 5 seconds',
      '-e', 'tell application "Mail" to count of accounts',
      '-e', 'end timeout',
    ], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

// 确保 Mail 就绪：未运行则拉起，随后轮询直到 deadline
async function ensureMailReady(deadlineMs = MAIL_READY_DEADLINE_MS) {
  if (!(await isMailRunning())) {
    execFile('open', ['-a', 'Mail'], (err) => {
      if (err) console.error('[dsbridge] 拉起 Mail 失败:', err.message);
    });
  }
  const deadline = Date.now() + deadlineMs;
  while (true) {
    if (await mailReadyOnce()) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, error: 'mail-not-ready' };
    await sleep(MAIL_READY_POLL_MS);
  }
}

// ---- 邮件列表缓存（内存 TTL + 落盘）----
const mailCache = new Map();      // mailbox -> { messages, limit, at }
const mailRefreshing = new Map(); // mailbox -> Promise（后台刷新并发去重）

function loadMailCache() {
  try {
    const obj = JSON.parse(fs.readFileSync(MAIL_CACHE_FILE, 'utf8'));
    for (const [mb, entry] of Object.entries(obj)) {
      if (entry && Array.isArray(entry.messages)) {
        mailCache.set(mb, {
          messages: entry.messages,
          limit: Number(entry.limit) || MAIL_DEFAULT_LIMIT,
          at: Number(entry.at) || 0,
        });
      }
    }
  } catch { /* 坏文件 / 不存在：静默降级 */ }
}

function saveMailCache() {
  try {
    const obj = {};
    for (const [mb, entry] of mailCache.entries()) obj[mb] = entry;
    fs.writeFileSync(MAIL_CACHE_FILE, JSON.stringify(obj));
  } catch (e) {
    console.error('[dsbridge] 写邮件缓存失败:', e.message);
  }
}

// 现场取列表（先确保 Mail 就绪，再走 osascript 超时）
async function fetchMailList(mailbox, limit) {
  const ready = await ensureMailReady();
  if (!ready.ok) return { ok: false, error: ready.error };
  const stdout = await runAppleScript(buildListScript(mailbox, limit));
  return { ok: true, mailbox, messages: parseListOutput(stdout, mailbox) };
}

// 后台刷新（同一 mailbox 并发去重）
function refreshMailBoxInBackground(mailbox, limit) {
  if (mailRefreshing.has(mailbox)) return;
  const p = (async () => {
    try {
      const result = await fetchMailList(mailbox, limit);
      if (result.ok) {
        mailCache.set(mailbox, { messages: result.messages, limit, at: Date.now() });
        saveMailCache();
      } else {
        console.error('[dsbridge] 后台刷新邮件失败:', result.error);
      }
    } catch (e) {
      console.error('[dsbridge] 后台刷新邮件异常:', e.message);
    } finally {
      mailRefreshing.delete(mailbox);
    }
  })();
  mailRefreshing.set(mailbox, p);
}

// 列出某邮箱最近 limit 封（messages 1 thru N 即最新在前，已实测）
// 性能：一次性解析消息列表（messages 1 thru lim）再逐条取属性，避免每条重复做邮箱查找；
//       Mail 不支持对「消息列表」做属性批取（id/subject of 列表 报 -1728），故逐条取属性。
function buildListScript(mailbox, limit) {
  return `tell application "Mail"
	set mb to mailbox ${asStr(mailbox)} of account ${asStr(MAIL_ACCOUNT)}
	set lim to ${limit}
	try
		set msgs to messages 1 thru lim of mb
	on error
		set msgs to {}
		set cnt to count of messages of mb
		if cnt > lim then set cnt to lim
		repeat with i from 1 to cnt
			set end of msgs to message i of mb
		end repeat
	end try
	set out to ""
	set n to count of msgs
	repeat with k from 1 to n
		set m to item k of msgs
		set out to out & (id of m) & tab & my asSanitized(subject of m) & tab & my asSanitized(sender of m) & tab & (((date received of m) as «class isot») as string) & linefeed
	end repeat
	return out
end tell

${AS_SANITIZE_HANDLER}`;
}

// 取某封正文：先在最近窗口内按 id 命中，未命中才回退全库 whose（实测 Archive 52k 也仅约 1s）
function buildBodyScript(mailbox, id) {
  return `tell application "Mail"
	set mb to mailbox ${asStr(mailbox)} of account ${asStr(MAIL_ACCOUNT)}
	set cnt to count of messages of mb
	set lim to ${MAIL_LOOKUP_WINDOW}
	if cnt > lim then set cnt to lim
	set found to missing value
	repeat with i from 1 to cnt
		set m to message i of mb
		if (id of m) = ${id} then
			set found to m
			exit repeat
		end if
	end repeat
	if found is missing value then
		try
			set found to (first message of mb whose id = ${id})
		end try
	end if
	if found is missing value then return "ERROR:notfound"
	set bodyText to (content of found) as text
	return (my asSanitized(subject of found)) & tab & (my asSanitized(sender of found)) & tab & (((date received of found) as «class isot») as string) & linefeed & bodyText
end tell

${AS_SANITIZE_HANDLER}`;
}

function parseListOutput(stdout, mailbox) {
  const messages = [];
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const id = Number(parts[0]);
    if (!Number.isFinite(id)) continue;
    messages.push({ id, subject: parts[1], sender: parts[2], date: parts[3], mailbox });
  }
  return messages;
}

// 保留头部、砍掉尾部；避免把代理对（emoji 等）拦腰截断
function truncateBody(text, max) {
  const s = text == null ? '' : String(text);
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const code = cut.charCodeAt(cut.length - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

// POST /mails —— 列出某邮箱最近 N 封（内存 TTL 缓存 + 落盘；refresh 绕过）
async function handleMails(body) {
  const mailbox = body && body.mailbox;
  if (!MAIL_BOXES.includes(mailbox)) return { ok: false, error: 'invalid mailbox' };
  let limit = Number(body && body.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = MAIL_DEFAULT_LIMIT;
  if (limit > MAIL_MAX_LIMIT) limit = MAIL_MAX_LIMIT;
  const refresh = !!(body && body.refresh === true);

  const cached = mailCache.get(mailbox);
  if (!refresh && cached && Array.isArray(cached.messages)) {
    const hit = (Date.now() - cached.at) <= MAIL_CACHE_TTL_MS && cached.limit >= limit;
    if (hit) {
      return { ok: true, cached: true, mailbox, messages: cached.messages.slice(0, limit) };
    }
    // 过期（或请求范围更大）但有旧值：立即返回旧的 + 后台刷新
    refreshMailBoxInBackground(mailbox, Math.max(limit, cached.limit));
    return { ok: true, cached: true, stale: true, mailbox, messages: cached.messages.slice(0, limit) };
  }

  try {
    const result = await fetchMailList(mailbox, limit);
    if (!result.ok) return result;
    mailCache.set(mailbox, { messages: result.messages, limit, at: Date.now() });
    saveMailCache();
    return { ok: true, cached: false, mailbox, messages: result.messages };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// POST /mail —— 取某封正文
async function handleMail(body) {
  const mailbox = body && body.mailbox;
  if (!MAIL_BOXES.includes(mailbox)) return { ok: false, error: 'invalid mailbox' };
  const id = Number(body && body.id);
  if (!Number.isFinite(id)) return { ok: false, error: 'invalid id' };
  try {
    const ready = await ensureMailReady();
    if (!ready.ok) return { ok: false, error: ready.error };
    const stdout = await runAppleScript(buildBodyScript(mailbox, id));
    if (String(stdout).startsWith('ERROR:notfound')) return { ok: false, error: 'message not found' };
    const nl = stdout.indexOf('\n');
    const header = nl >= 0 ? stdout.slice(0, nl) : stdout;
    const rawBody = nl >= 0 ? stdout.slice(nl + 1) : '';
    const [subject, sender, date] = header.split('\t');
    return {
      ok: true,
      message: { id, subject, sender, date, mailbox, body: truncateBody(rawBody, MAIL_BODY_MAX) },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// POST /probe —— 注入脚本上报 DOM 探测信息，仅写 bridge.log，不落 data/
function handleProbe(body) {
  console.log('[dsbridge][probe]', JSON.stringify(body));
  return { ok: true };
}

function handleRequest(req, res) {
  // CORS：允许 DeepSeek 页面跨域调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const pathname = req.url.split('?')[0];
  const postRoutes = ['/append', '/open-url', '/mails', '/mail', '/probe'];

  if (req.method === 'POST' && postRoutes.includes(pathname)) {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(data);
        let result;
        const t0 = Date.now();
        if (pathname === '/open-url') result = handleOpenUrl(parsed);
        else if (pathname === '/append') result = handleAppend(parsed);
        else if (pathname === '/mails') result = await handleMails(parsed);
        else if (pathname === '/mail') result = await handleMail(parsed);
        else result = handleProbe(parsed);
        // 诊断日志：仅 /mails、/mail（定位「app 到不了桥 / 结果与耗时」）；不改协议与返回
        if (pathname === '/mails' || pathname === '/mail') {
          console.log('[dsbridge][req]', pathname, JSON.stringify(parsed), result && result.ok ? (result.cached ? (result.stale ? 'cached(stale)' : 'cached') : 'ok') : ('error:' + ((result && result.error) || 'unknown')), (Date.now() - t0) + 'ms');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'dsbridge', port: PORT, dataDir: DATA_DIR }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
}

loadMailCache(); // 启动时载入落盘列表缓存（桥重启后仍热；坏文件静默降级）

const server = http.createServer(handleRequest);
const serverTls = https.createServer(TLS_OPTIONS, handleRequest);

// HTTP 备用端口（仅诊断用，注入脚本不依赖它）
server.listen(HTTP_PORT, HOST, () => {
  console.log(`[dsbridge] HTTP  监听 http://${HOST}:${HTTP_PORT}`);
});

// HTTPS 主端口
serverTls.listen(PORT, HOST, () => {
  console.log(`[dsbridge] HTTPS 监听 https://${HOST}:${PORT}`);
  console.log(`[dsbridge] 对话写入 ${DATA_DIR}/YYYY-MM-DD.jsonl`);
});
