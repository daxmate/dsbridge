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
const MAIL_MAX_LIMIT = 100;      // /mails 单次上限（配合 offset 翻页，一次最多 100 封）
const MAIL_CACHE_DEPTH_MAX = 200; // 前缀缓存最深层数（刷新保留已加载深度的上限）
const MAIL_SCAN_MAX = 50;        // /mail 兜底扫描迭代上限（whose 未命中时才走；由 200 收紧）
const MAIL_SCAN_BUDGET_S = 5;    // /mail 兜底扫描时间闸（秒）；实测 Mail 的 tell 块内 with timeout 无效，靠 current date 自计时
const MAIL_BODY_MAX = 20000;     // 正文最大字符数（超出砍尾部、保留头部）
const MAIL_OS_TIMEOUT_MS = 30000;      // 单次 osascript 调用超时（正文）
const MAIL_LIST_TIMEOUT_MS = 60000;    // 列表 osascript 超时（要取多封属性，比正文慢；大邮箱 100 条实测可达数十秒）
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
function runAppleScript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs || MAIL_OS_TIMEOUT_MS }, (err, stdout) => {
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
        const depth = entry.messages.length;
        mailCache.set(mb, {
          messages: entry.messages,
          limit: Number(entry.limit) || depth || MAIL_DEFAULT_LIMIT,
          total: Number.isFinite(Number(entry.total)) ? Number(entry.total) : depth,
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

// 现场取窗口（先确保 Mail 就绪，再走 osascript 超时）
// 返回 { ok, mailbox, messages, total }；total = 邮箱总封数（用于 hasMore 判定）
async function fetchMailWindow(mailbox, offset, limit) {
  const ready = await ensureMailReady();
  if (!ready.ok) return { ok: false, error: ready.error };
  const stdout = await runAppleScript(buildListScript(mailbox, offset, limit), MAIL_LIST_TIMEOUT_MS);
  const parsed = parseListOutput(stdout, mailbox);
  return { ok: true, mailbox, messages: parsed.messages, total: parsed.total };
}

// 后台刷新（同一 mailbox 并发去重）；depth = 要保留的已加载深度，刷新不缩表
function refreshMailBoxInBackground(mailbox, depth) {
  if (mailRefreshing.has(mailbox)) return;
  const want = Math.min(MAIL_CACHE_DEPTH_MAX, Math.max(MAIL_DEFAULT_LIMIT, depth || 0));
  const p = (async () => {
    try {
      const result = await fetchMailWindow(mailbox, 0, want);
      if (result.ok) {
        mailCache.set(mailbox, { messages: result.messages, limit: result.messages.length, total: result.total, at: Date.now() });
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

// 列出某邮箱的窗口 [offset, offset+limit)（messages 1 thru N 即最新在前，已实测）
// 性能：一次性取消息列表（messages firstI thru lastI）再逐条取属性，避免每条重复做邮箱查找；
//       Mail 不支持对「消息列表」做属性批取（id/subject of 列表 报 -1728），故逐条取属性。
// 取某邮箱的窗口 [offset, offset+limit)：先取总封数，再按范围取。
// 越界/空邮箱不再靠 error 兜底：范围先夹到 count 内，first > last 时返回空列表，只回 TOTAL 行。
function buildListScript(mailbox, offset, limit) {
  return `tell application "Mail"
	set mb to mailbox ${asStr(mailbox)} of account ${asStr(MAIL_ACCOUNT)}
	set cnt to count of messages of mb
	set off to ${offset}
	set lim to ${limit}
	set firstI to off + 1
	set lastI to off + lim
	if lastI > cnt then set lastI to cnt
	set out to "TOTAL" & tab & cnt & linefeed
	if cnt > 0 and firstI >= 1 and firstI <= lastI then
		try
			set msgs to messages firstI thru lastI of mb
		on error
			set msgs to {}
			repeat with i from firstI to lastI
				set end of msgs to message i of mb
			end repeat
		end try
		repeat with k from 1 to (count of msgs)
			set m to item k of msgs
			set out to out & (id of m) & tab & my asSanitized(subject of m) & tab & my asSanitized(sender of m) & tab & (((date received of m) as «class isot») as string) & linefeed
		end repeat
	end if
	return out
end tell

${AS_SANITIZE_HANDLER}`;
}

// 取某封正文：优先用 whose by id 直取（实测 Archive 53k 稳定 ≈0.7s，与邮件位置无关），
// 未命中（whose 对不存在的 id 报 -1728）或报错时，再回退到有界扫描：迭代上限 MAIL_SCAN_MAX 封，
// 且靠 current date 自计时、超 MAIL_SCAN_BUDGET_S 秒即停（实测 Mail 的 tell 块内 with timeout 无效）。
function buildBodyScript(mailbox, id) {
  return `tell application "Mail"
	set mb to mailbox ${asStr(mailbox)} of account ${asStr(MAIL_ACCOUNT)}
	set found to missing value
	try
		set found to (first message of mb whose id = ${id})
	on error
		set found to missing value
	end try
	if found is missing value then
		set cnt to count of messages of mb
		set lim to ${MAIL_SCAN_MAX}
		if cnt > lim then set cnt to lim
		set t0 to current date
		repeat with i from 1 to cnt
			set m to message i of mb
			if (id of m) = ${id} then
				set found to m
				exit repeat
			end if
			if ((current date) - t0) ≥ ${MAIL_SCAN_BUDGET_S} then exit repeat
		end repeat
	end if
	if found is missing value then return "ERROR:notfound"
	set bodyText to (content of found) as text
	return (my asSanitized(subject of found)) & tab & (my asSanitized(sender of found)) & tab & (((date received of found) as «class isot») as string) & linefeed & bodyText
end tell

${AS_SANITIZE_HANDLER}`;
}

function parseListOutput(stdout, mailbox) {
  const messages = [];
  let total = null;
  for (const line of String(stdout).split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts[0] === 'TOTAL') { total = Number(parts[1]); continue; }
    if (parts.length < 4) continue;
    const id = Number(parts[0]);
    if (!Number.isFinite(id)) continue;
    messages.push({ id, subject: parts[1], sender: parts[2], date: parts[3], mailbox });
  }
  if (!Number.isFinite(total)) total = messages.length;
  return { total, messages };
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

// ---- /mails 分页辅助 ----
// 整数夹取（offset / limit 都走这里，杜绝 NaN / 负数 / 巨大值）
function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// 从 { messages, total } 切出响应窗口；hasMore 由「绝对 offset + 本页条数」与 total 比较决定
// （不是靠「本页是否满」；from 是相对本次 entry 的切片起点，absoluteOffset 是请求的真实 offset）
function sliceMailPage(entry, from, limit, absoluteOffset) {
  const total = Number.isFinite(entry.total) ? entry.total : entry.messages.length;
  const messages = entry.messages.slice(from, from + limit);
  const base = Number.isFinite(absoluteOffset) ? absoluteOffset : from;
  return { messages, total, hasMore: base + messages.length < total };
}

// POST /mails —— 列表分页：offset（默认 0）+ limit（默认 20，单次上限 100）
// 返回 { ok, mailbox, messages, offset, limit, total, hasMore }
async function handleMails(body) {
  const mailbox = body && body.mailbox;
  if (!MAIL_BOXES.includes(mailbox)) return { ok: false, error: 'invalid mailbox' };
  const offset = clampInt(body && body.offset, 0, 100000, 0);
  const limit = clampInt(body && body.limit, 1, MAIL_MAX_LIMIT, MAIL_DEFAULT_LIMIT);
  const refresh = !!(body && body.refresh === true);
  const end = offset + limit;

  const cached = mailCache.get(mailbox);
  if (!refresh && cached && Array.isArray(cached.messages)) {
    // 缓存覆盖本次窗口（已到最后时用 total 兜底），才算命中
    const covered = cached.messages.length >= Math.min(end, cached.total);
    if (covered) {
      const fresh = (Date.now() - cached.at) <= MAIL_CACHE_TTL_MS;
      if (!fresh) {
        // 过期但有旧值：立即返回旧的 + 后台按「已加载深度」刷新（不缩表）
        refreshMailBoxInBackground(mailbox, Math.max(cached.messages.length, end));
      }
      return {
        ok: true, cached: true, stale: !fresh, mailbox, offset, limit,
        ...sliceMailPage(cached, offset, limit),
      };
    }
  }

  try {
    // 刷新且从头取：一次拉到「请求深度 / 既有深度」的较大者，避免刷新把缓存（和前端列表）缩回 limit
    const keepDepth = refresh && offset === 0 && cached && Array.isArray(cached.messages)
      ? cached.messages.length
      : 0;
    const fromHead = keepDepth > limit;
    const fetchOffset = fromHead ? 0 : offset;
    const fetchLimit = fromHead ? Math.min(MAIL_CACHE_DEPTH_MAX, keepDepth) : limit;
    const result = await fetchMailWindow(mailbox, fetchOffset, fetchLimit);
    if (!result.ok) return result;
    if (fetchOffset === 0) {
      mailCache.set(mailbox, {
        messages: result.messages,
        limit: result.messages.length,
        total: result.total,
        at: Date.now(),
      });
      saveMailCache();
    }
    // 窗口取回后按「相对本次 fetch 起点」切片，响应仍是请求的 [offset, offset+limit)
    const entry = { messages: result.messages, total: result.total };
    return {
      ok: true, cached: false, mailbox, offset, limit,
      ...sliceMailPage(entry, offset - fetchOffset, limit, offset),
    };
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
