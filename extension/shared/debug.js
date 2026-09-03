/**
 * debug.js - 统一调试日志工具
 *
 * 优化：
 * 1. 添加 chrome.storage.session 不可用时的降级处理（内存环形缓冲区）
 * 2. 提高日志持久化的健壮性
 * 3. 同步 Console 输出与异步持久化分离，避免 await 阻塞主流程
 * 4. 修复 logLevel 读取键：设置项持久化在 chrome.storage.local 的
 *    settings.logLevel，而非顶层 logLevel 键。
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 内存中的最近日志（环形缓冲区）
const MAX_MEMORY_LOGS = 200;
const memoryLogs = [];

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

    // 写入内存环形缓冲区
    memoryLogs.unshift(entry);
    if (memoryLogs.length > MAX_MEMORY_LOGS) {
      memoryLogs.length = MAX_MEMORY_LOGS;
    }

    // 异步持久化到 chrome.storage.session（不 await，避免阻塞主流程）
    try {
      chrome.storage.session.get('debugLogs')
        .then(({ debugLogs = [] }) => {
          const merged = [entry, ...(Array.isArray(debugLogs) ? debugLogs : [])].slice(0, MAX_MEMORY_LOGS);
          return chrome.storage.session.set({ debugLogs: merged });
        })
        .catch(() => { /* session storage 不可用时静默失败 */ });
    } catch (e) {
      // storage 不可用时静默失败
    }
  }

  debug(msg, detail) { this._log('DEBUG', msg, detail); }
  info(msg, detail) { this._log('INFO', msg, detail); }
  warn(msg, detail) { this._log('WARN', msg, detail); }
  error(msg, detail) { this._log('ERROR', msg, detail); }
}

/**
 * 安全 JSON.stringify，避免循环引用
 */
function safeStringify(obj) {
  try {
    const seen = new Set();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    }, 2);
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
