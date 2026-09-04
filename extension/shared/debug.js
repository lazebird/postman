/**
 * debug.js - 统一调试日志工具
 *
 * 优化：
 * 1. 添加 chrome.storage.session 不可用时的降级处理（内存环形缓冲区）
 * 2. 提高日志持久化的健壮性
 * 3. 同步 Console 输出与异步持久化分离，避免 await 阻塞主流程
 * 4. 修复 logLevel 读取键：设置项持久化在 chrome.storage.local 的
 *    settings.logLevel，而非顶层 logLevel 键。
 * 5. 修复并发丢日志：chrome.storage.session 的「读取→合并→写回」改为
 *    串行化队列，消除多模块并发读写同一 key 时的 last-write-wins 竞争。
 *    此前一轮全量检查会并发打出数十上百条日志，其中「收到响应 / 被认证
 *    层拦截 / 未能解析」等关键证据行，常因并发写互相覆盖而丢失，导致
 *    反复无法定位后台自动检查失败的真实原因。
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 内存中的最近日志（环形缓冲区，最新的在头部）
const MAX_MEMORY_LOGS = 200;
const memoryLogs = [];

// chrome.storage.session 持久化串行队列（全局）
// 保证每次 append 的 get→merge→set 都是原子执行、按序排队，
// 不再有两个并发写互相覆盖对方刚写入日志的情况。
let storageWriteChain = Promise.resolve();

const LOG_KEY = 'debugLogs';

// session storage 是否可用（首次写入前探测一次，避免每次重复抛错）
let sessionAvailable = null;

/**
 * 将一条日志追加写入 chrome.storage.session（排队串行执行，fire-and-forget）。
 * 保持「头部为新、尾部为旧」的顺序，与内存环形缓冲区、popup 展示一致。
 */
function persistLog(entry) {
  // 首次探测 session 可用性
  const probe = (async () => {
    if (sessionAvailable === null) {
      try {
        await chrome.storage.session.get(LOG_KEY);
        sessionAvailable = true;
      } catch (e) {
        sessionAvailable = false;
      }
    }
  })();

  // 串行队列：前一次写完成后，再做 read→merge→set
  storageWriteChain = storageWriteChain
    .then(probe)
    .then(() => {
      if (sessionAvailable === false) return;
      return chrome.storage.session.get(LOG_KEY).then(({ [LOG_KEY]: list = [] }) => {
        const arr = Array.isArray(list) ? list : [];
        arr.unshift(entry); // 最新放头部
        const trimmed = arr.length > MAX_MEMORY_LOGS ? arr.slice(0, MAX_MEMORY_LOGS) : arr;
        return chrome.storage.session.set({ [LOG_KEY]: trimmed });
      });
    })
    .catch(() => {
      // session storage 不可用时静默失败（不影响主流程）
      sessionAvailable = false;
    });

  return storageWriteChain;
}

class DebugLogger {
  constructor(module) {
    this.module = module || 'general';
  }

  /**
   * 获取当前调试级别设置
   * 读取路径：chrome.storage.local 的 settings.logLevel（用户持久化设置）
   */
  async _getLogLevel() {
    try {
      const { settings = {} } = await chrome.storage.local.get('settings');
      const level = settings.logLevel || 'INFO';
      return LOG_LEVELS[level] ?? LOG_LEVELS.INFO;
    } catch (e) {
      return LOG_LEVELS.INFO;
    }
  }

  /**
   * 记录一条日志
   */
  async _log(level, message, detail) {
    let currentLevel = LOG_LEVELS.INFO;
    try {
      currentLevel = await this._getLogLevel();
    } catch (e) {
      currentLevel = LOG_LEVELS.INFO;
    }
    if (LOG_LEVELS[level] < currentLevel) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      module: this.module,
      message: String(message),
      detail: detail ? (typeof detail === 'string' ? detail : safeStringify(detail)) : undefined,
    };

    // Console 输出（同步执行，不阻塞）
    const prefix = `[${entry.ts}] [${level}] [${this.module}]`;
    try {
      if (level === 'ERROR') {
        console.error(prefix, entry.message, entry.detail || '');
      } else if (level === 'WARN') {
        console.warn(prefix, entry.message, entry.detail || '');
      } else {
        console.log(prefix, entry.message, entry.detail || '');
      }
    } catch (e) {
      // console 不可用（理论上不会发生）
    }

    // 写入内存环形缓冲区（头部是最新）
    memoryLogs.unshift(entry);
    if (memoryLogs.length > MAX_MEMORY_LOGS) {
      memoryLogs.length = MAX_MEMORY_LOGS;
    }

    // 异步持久化到 chrome.storage.session（串行队列，不 await 阻塞主流程）
    persistLog(entry);
  }

  debug(msg, detail) {
    this._log('DEBUG', msg, detail);
  }
  info(msg, detail) {
    this._log('INFO', msg, detail);
  }
  warn(msg, detail) {
    this._log('WARN', msg, detail);
  }
  error(msg, detail) {
    this._log('ERROR', msg, detail);
  }
}

/**
 * 安全 JSON.stringify，避免循环引用
 */
function safeStringify(obj) {
  try {
    const seen = new Set();
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) {
            return '[Circular]';
          }
          seen.add(value);
        }
        return value;
      },
      2
    );
  } catch (e) {
    return String(obj);
  }
}

// 便捷工具：创建一个模块的 logger
export function createLogger(module) {
  return new DebugLogger(module);
}

// 全局日志工具
export const logger = new DebugLogger('global');

// 导出内存日志（供调试用）
export function getMemoryLogs(limit = 50) {
  return memoryLogs.slice(0, limit);
}
