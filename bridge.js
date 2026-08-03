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

function handleRequest(req, res) {
  // CORS：允许 DeepSeek 页面跨域调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'POST' && req.url === '/append') {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try {
        const result = handleAppend(JSON.parse(data));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'dsbridge', port: PORT, dataDir: DATA_DIR }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
}

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
