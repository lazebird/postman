/**
 * debug.js - 统一调试日志工具
 * 
 * 调试信息策略：
 * 1. 所有关键操作都有日志记录
 * 2. 日志带时间戳、级别、模块标识
 * 3. 支持持久化到 chrome.storage.local，方便查看历史
 * 4. 日志分级：DEBUG / INFO / WARN / ERROR
 * 5. 可通过 chrome.storage 动态开关 verbose 级别
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// 内存中的最近日志（环形缓冲区）
const MAX_MEMORY_LOGS = 200;

class DebugLogger {
  constructor(module) {
    this.module = module || 'general';
  }

  /**
   * 获取当前调试级别设置
   */
  async _getLogLevel() {
    try {
      const { logLevel } = await chrome.storage.local.get({ logLevel: 'INFO' });
      return LOG_LEVELS[logLevel] ?? LOG_LEVELS.INFO;
    } catch (e) {
      return LOG_LEVELS.INFO;
    }
  }

  /**
   * 记录一条日志
   * @param {string} level - 'DEBUG'|'INFO'|'WARN'|'ERROR'
   * @param {string} message - 日志消息
   * @param {object} detail - 附加数据
   */
  async _log(level, message, detail) {
    const currentLevel = await this._getLogLevel();
    if (LOG_LEVELS[level] < currentLevel) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      module: this.module,
      message,
      detail: detail ? JSON.stringify(detail) : undefined,
    };

    // Console 输出
    const prefix = `[${entry.ts}] [${level}] [${this.module}]`;
    if (level === 'ERROR') {
      console.error(prefix, message, detail || '');
    } else if (level === 'WARN') {
      console.warn(prefix, message, detail || '');
    } else {
      console.log(prefix, message, detail || '');
    }

    // 持久化到内存日志（通过 chrome.storage.session 不持久化到磁盘，浏览器重启即清空）
    try {
      const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
      const newLogs = [entry, ...debugLogs].slice(0, MAX_MEMORY_LOGS);
      await chrome.storage.session.set({ debugLogs: newLogs });
    } catch (e) {
      // storage 不可用时静默失败
    }
  }

  debug(msg, detail) { return this._log('DEBUG', msg, detail); }
  info(msg, detail) { return this._log('INFO', msg, detail); }
  warn(msg, detail) { return this._log('WARN', msg, detail); }
  error(msg, detail) { return this._log('ERROR', msg, detail); }
}

// 便捷工具：创建一个模块的 logger
export function createLogger(module) {
  return new DebugLogger(module);
}

// 全局日志工具
export const logger = new DebugLogger('global');
