#!/usr/bin/env node
'use strict';
// dsbridge 注入脚本纯函数测试：不依赖 DOM / 浏览器，直接 require 后断言。
// 覆盖：formatContextBlock / isProbablyText / truncateText

const assert = require('node:assert');
const inject = require('../deepseek_inject.js');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS: ' + name);
  } catch (e) {
    failures += 1;
    console.log('  FAIL: ' + name);
    console.log('        ' + (e && e.message ? e.message : e));
  }
}

// ---------- 导出面 ----------
test('导出 formatContextBlock / isProbablyText / truncateText', () => {
  assert.strictEqual(typeof inject.formatContextBlock, 'function');
  assert.strictEqual(typeof inject.isProbablyText, 'function');
  assert.strictEqual(typeof inject.truncateText, 'function');
});

// ---------- formatContextBlock ----------
test('formatContextBlock：文件 + 剪贴板两个来源', () => {
  const block = inject.formatContextBlock([
    { kind: 'file', name: 'foo.md', bytes: 12595, text: '# hi' },
    { kind: 'clipboard', bytes: 3174, text: 'clip' },
  ]);
  assert.strictEqual(
    block,
    '【本地上下文 · 2 个来源】\n\n'
      + '--- 文件：foo.md（12.3 KB）---\n# hi\n\n'
      + '--- 剪贴板（3.1 KB）---\nclip'
  );
});

test('formatContextBlock：空来源返回空串', () => {
  assert.strictEqual(inject.formatContextBlock([]), '');
  assert.strictEqual(inject.formatContextBlock(null), '');
  assert.strictEqual(inject.formatContextBlock([{ kind: 'file', name: 'a.txt', text: '' }]), '');
});

test('formatContextBlock：内容为空字符串的来源被跳过', () => {
  const block = inject.formatContextBlock([
    { kind: 'file', name: 'empty.txt', text: '' },
    { kind: 'file', name: 'b.txt', bytes: 512, text: 'b' },
  ]);
  assert.strictEqual(block, '【本地上下文 · 1 个来源】\n\n--- 文件：b.txt（512 B）---\nb');
});

test('formatContextBlock：没有 bytes 时按内容字节估算', () => {
  const block = inject.formatContextBlock([{ kind: 'clipboard', text: '你好' }]);
  assert.strictEqual(block, '【本地上下文 · 1 个来源】\n\n--- 剪贴板（6 B）---\n你好');
});

// ---------- isProbablyText ----------
test('isProbablyText：纯文本 Buffer -> true', () => {
  assert.strictEqual(inject.isProbablyText(Buffer.from('hello world', 'utf8')), true);
});

test('isProbablyText：含 0x00 的 Buffer -> false', () => {
  assert.strictEqual(inject.isProbablyText(Buffer.from([0x68, 0x00, 0x69])), false);
  assert.strictEqual(inject.isProbablyText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), false);
});

test('isProbablyText：只检查前 1024 字节', () => {
  const buf = Buffer.alloc(2048, 0x61);
  buf[1500] = 0x00;
  assert.strictEqual(inject.isProbablyText(buf), true);
});

// ---------- truncateText ----------
test('truncateText：ASCII 按字节截断', () => {
  assert.strictEqual(inject.truncateText('abcdef', 3), 'abc');
  assert.strictEqual(inject.truncateText('abc', 10), 'abc');
});

test('truncateText：多字节字符边界不产生乱码', () => {
  const out = inject.truncateText('你好世界', 7); // 每个汉字 3 字节
  assert.strictEqual(out, '你好');
  assert.ok(!/\uFFFD/.test(out), '不应出现替换字符');
});

test('truncateText：emoji（代理对）不被截半', () => {
  const out = inject.truncateText('😀😀😀', 9); // 每个 emoji 4 字节
  assert.strictEqual(out, '😀😀');
  assert.ok(!/\uFFFD/.test(out), '不应出现替换字符');
});

test('truncateText：返回结果字节数不超过上限', () => {
  const out = inject.truncateText('a你好😀b', 8);
  const bytes = Buffer.byteLength(out, 'utf8');
  assert.ok(bytes <= 8, 'bytes=' + bytes);
});

console.log('');
if (failures) {
  console.log('失败 ' + failures + ' 项');
  process.exit(1);
}
console.log('全部通过');
