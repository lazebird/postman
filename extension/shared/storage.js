/**
 * storage.js - chrome.storage 封装
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

/**
 * 读取全部账户配置
 * @returns {Promise<Array>}
 */
export async function getAccounts() {
  const { [STORAGE_KEYS.ACCOUNTS]: accounts = [] } = await chrome.storage.local.get(STORAGE_KEYS.ACCOUNTS);
  return accounts;
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
  const { [STORAGE_KEYS.SETTINGS]: settings = {} } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...settings };
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
 * @param {Object} result - { provider, timestamp, success, unreadCount, emails, detail, endpoints }
 */
export async function saveCheckResult(result) {
  const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(STORAGE_KEYS.CHECK_RESULTS);
  const newResults = [result, ...results].slice(0, 50); // 最多保留50条
  await chrome.storage.local.set({ [STORAGE_KEYS.CHECK_RESULTS]: newResults });
}

/**
 * 读取最近的检查结果
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getCheckResults(limit = 20) {
  const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(STORAGE_KEYS.CHECK_RESULTS);
  return results.slice(0, limit);
}

/**
 * 读取调试日志
 * @param {number} limit
 */
export async function getDebugLogs(limit = 100) {
  const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
  return debugLogs.slice(0, limit);
}
