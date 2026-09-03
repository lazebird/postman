/**
 * storage.js - chrome.storage 封装（存储分层）
 *
 * 存储分层约定（关系到"扩展更新时数据是否丢失"）：
 *
 *  ┌──────────────────────────────┬─────────────────────────────────────────┬──────────────────────┐
 *  │ 数据                          │ 存储区                                  │ 扩展更新 / 浏览器重启 │
 *  ├──────────────────────────────┼─────────────────────────────────────────┼──────────────────────┤
 *  │ 账号配置 accounts            │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ 用户设置 settings            │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ 检查历史 checkResults        │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ sid 会话令牌                 │ chrome.storage.local（持久化）         │ ✅ 保留              │
 *  │ 调试日志 debugLogs           │ chrome.storage.session（会话级）        │ ⚠️ 清空              │
 *  └──────────────────────────────┴─────────────────────────────────────────┴──────────────────────┘
 *
 * 关键结论：
 *  - 账号配置、用户设置、检查历史等【用户数据】一律写入 chrome.storage.local，
 *    该存储区在扩展更新（update）时不丢失，卸载前始终保留 —— 避免"每次插件更新后
 *    账号配置丢失、需重新添加"的体验问题。
 *  - sid 会话令牌持久化到 chrome.storage.local（7 天 TTL），浏览器重启不清空，
 *    减少因 sid 丢失导致的后台检查失败与频繁自动打开标签。
 *  - MV3 Service Worker 上下文【没有】页面级 localStorage，跨上下文共享用户数据
 *    只能使用 chrome.storage.local（等价于持久化的 localStorage 语义）。
 *
 * 优化历史：
 * 1. 添加 chrome.storage.session 权限检查的降级处理
 * 2. 添加 getDebugLogs 导出
 * 3. 更健壮的错误处理
 * 4. 明确持久化/会话两级存储分层，账号配置等用户数据统一落 chrome.storage.local
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

/* ============================================================
 * 持久级用户数据（chrome.storage.local）
 * —— 扩展更新/浏览器重启均保留，卸载扩展前不丢失
 * ============================================================ */

/**
 * 读取全部账户配置
 * @returns {Promise<Array>}
 */
export async function getAccounts() {
  try {
    const { [STORAGE_KEYS.ACCOUNTS]: accounts = [] } = await chrome.storage.local.get(STORAGE_KEYS.ACCOUNTS);
    return Array.isArray(accounts) ? accounts : [];
  } catch (e) {
    console.error('[storage] getAccounts failed:', e.message);
    return [];
  }
}

/**
 * 保存账户配置（持久化，扩展更新不丢失）
 * @param {Array} accounts
 */
export async function setAccounts(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNTS]: accounts });
}

/**
 * 读取设置（持久化）
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  try {
    const { [STORAGE_KEYS.SETTINGS]: settings = {} } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  } catch (e) {
    console.error('[storage] getSettings failed:', e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存设置（持久化，扩展更新不丢失）
 * @param {Object} settings
 */
export async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * 保存一次检查结果（持久化，保留最近 100 条）
 * @param {Object} result - { provider, timestamp, success, unreadCount, detail, endpoints }
 */
export async function saveCheckResult(result) {
  try {
    const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(STORAGE_KEYS.CHECK_RESULTS);
    // 避免无限增长：最多保留 100 条
    const newResults = [result, ...(Array.isArray(results) ? results : [])].slice(0, 100);
    await chrome.storage.local.set({ [STORAGE_KEYS.CHECK_RESULTS]: newResults });
  } catch (e) {
    console.error('[storage] saveCheckResult failed:', e.message);
  }
}

/**
 * 读取最近的检查结果
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getCheckResults(limit = 20) {
  try {
    const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(STORAGE_KEYS.CHECK_RESULTS);
    return (Array.isArray(results) ? results : []).slice(0, limit);
  } catch (e) {
    console.error('[storage] getCheckResults failed:', e.message);
    return [];
  }
}

/* ============================================================
 * 会话级数据（chrome.storage.session）
 * —— 浏览器重启/扩展更新会清空；属临时数据，丢失不影响功能
 * ============================================================ */


/**
 * 读取调试日志（会话级）
 * @param {number} limit
 */
export async function getDebugLogs(limit = 100) {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    return (Array.isArray(debugLogs) ? debugLogs : []).slice(0, limit);
  } catch (e) {
    console.error('[storage] getDebugLogs failed:', e.message);
    return [];
  }
}
