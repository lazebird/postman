#!/usr/bin/env node
/**
 * get-logs.js - 自动获取扩展调试日志
 *
 * 用法:
 *   node get-logs.js              # 获取最近 100 条日志
 *   node get-logs.js --limit 50   # 获取最近 50 条
 *   node get-logs.js --filter 163 # 过滤包含 "163" 的日志
 *   node get-logs.js --tail       # 持续跟踪日志
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 扩展 ID（需要从 edge://extensions/ 获取）
const EXTENSION_ID = 'YOUR_EXTENSION_ID';

// 获取日志
async function getLogs(options = {}) {
  const { limit = 100, filter = null, tail = false } = options;

  // 使用 Chrome DevTools Protocol 获取日志
  // 注意：这需要启用远程调试端口
  const cmd = `chrome.exe --remote-debugging-port=9222`;

  try {
    // 方法 1: 通过 chrome.storage.session 获取
    const result = await fetchLogsFromStorage(limit);

    if (filter) {
      return result.filter((log) => log.message.includes(filter) || log.detail?.includes(filter));
    }

    return result;
  } catch (e) {
    console.error('获取日志失败:', e.message);
    return [];
  }
}

// 通过 storage.session 获取日志
async function fetchLogsFromStorage(limit) {
  // 这个方法需要扩展提供 API
  // 我们使用 chrome.runtime.sendMessage 来获取
  return new Promise((resolve, reject) => {
    // 注意：这只能在扩展的上下文中运行
    // 外部脚本无法直接调用
    reject(new Error('需要在扩展上下文中运行'));
  });
}

// 打印日志
function printLogs(logs) {
  console.log('\n=== 调试日志 (最近 ' + logs.length + ' 条) ===\n');

  for (const log of logs) {
    const timestamp = log.ts ? new Date(log.ts).toLocaleTimeString() : '??:??:??';
    const level = log.level || 'INFO';
    const module = log.module || 'unknown';
    const message = log.message || '';
    const detail = log.detail ? ' ' + log.detail.substring(0, 200) : '';

    console.log(`[${timestamp}] [${level}] [${module}] ${message}${detail}`);
  }

  console.log('\n=== 结束 ===\n');
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const options = {
    limit: 100,
    filter: null,
    tail: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--limit':
        options.limit = parseInt(args[++i]) || 100;
        break;
      case '--filter':
        options.filter = args[++i];
        break;
      case '--tail':
        options.tail = true;
        break;
    }
  }

  if (options.tail) {
    console.log('持续跟踪模式（按 Ctrl+C 退出）...\n');
    while (true) {
      const logs = await getLogs(options);
      printLogs(logs);
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    const logs = await getLogs(options);
    printLogs(logs);
  }
}

// 运行
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { getLogs, printLogs };
