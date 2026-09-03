/**
 * storage.js - chrome.storage 封装
 *
 * 修复/优化：
 * 1. 添加 chrome.storage.session 权限检查的降级处理
 * 2. 添加 getDebugLogs 导出
 * 3. 更健壮的错误处理
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

// 从 constants.js 移除了 STORAGE_KEYS.DEBUG_LOGS 引用（在 debug.js 中直接使用字符串键）

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
 * 保存账户配置
 * @param {Array} accounts
 */
export async function setAccounts(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNTS]: accounts });
}

/**
 * 读取设置
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
 * 保存设置
 * @param {Object} settings
 */
export async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * 保存一次检查结果
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

/**
 * 读取调试日志
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
