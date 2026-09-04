/**
 * session-cache.js - sid 会话缓存的统一封装（单一数据源）
 *
 * 背景：
 *   sid（webmail 会话令牌）的存储逻辑此前在多处重复实现且键名硬编码
 *   （service-worker / provider-163 / provider-qq / provider-ustc /
 *    api-patterns / possibility-tests 各写一遍，且映射规则互相不一致）。
 *
 * 本模块将「提供商标识 → sid 存储键」的映射、TTL 过期、读/写/清除收敛为
 * 唯一实现，供 background 与各 provider 统一调用，消除重复并降低耦合。
 *
 * 存储格式：
 *   chrome.storage.local[sid_<provider>]         = sid 字符串
 *   chrome.storage.local[sid_<provider>_expiry]  = 过期时间戳(ms)
 */

import { createLogger } from './debug.js';
import { SID_TTL_MS } from './constants.js';

const logger = createLogger('session-cache');

/** 会话过期后缀 */
const EXPIRY_SUFFIX = '_expiry';

/**
 * 将提供商标识映射为 sid 存储键。
 * 兼容历史命名：netease_163→sid_163、qq→sid_qq、ustc→sid_ustc、163→sid_163。
 * @param {string} provider
 * @returns {string} sid 存储键
 */
export function sidStorageKey(provider) {
  const p = String(provider || '')
    .toLowerCase()
    .trim();
  if (p === 'netease_163' || p === '163') return 'sid_163';
  if (p === 'qq') return 'sid_qq';
  if (p === 'ustc') return 'sid_ustc';
  if (p === 'gmail') return 'sid_gmail';
  // 兜底：其他提供商沿用 sid_<name>
  return p ? `sid_${p}` : '';
}

/** 会话过期存储键 */
export function sidExpiryKey(provider) {
  const key = sidStorageKey(provider);
  return key ? `${key}${EXPIRY_SUFFIX}` : '';
}

/**
 * 缓存 sid（带 TTL 过期时间）。
 * @param {string} provider
 * @param {string} sid
 * @param {number} [ttlMs] 覆盖默认 TTL
 * @returns {Promise<boolean>} 是否成功
 */
export async function cacheSid(provider, sid, ttlMs = SID_TTL_MS) {
  const key = sidStorageKey(provider);
  if (!key || !sid) return false;
  try {
    await chrome.storage.local.set({
      [key]: sid,
      [sidExpiryKey(provider)]: Date.now() + ttlMs,
    });
    return true;
  } catch (e) {
    logger.warn(`缓存 ${provider} sid 失败: ${e.message}`);
    return false;
  }
}

/**
 * 读取缓存 sid，若过期则清除并视为不存在。
 * 返回形如 { sid, source }，source ∈ 'cache' | 'expired' | 'none'。
 * @param {string} provider
 * @returns {Promise<{sid: string|null, source: string}>}
 */
export async function getSidRecord(provider) {
  const key = sidStorageKey(provider);
  if (!key) return { sid: null, source: 'none' };
  try {
    const data = await chrome.storage.local.get([key, sidExpiryKey(provider)]);
    if (data[key]) {
      if (data[sidExpiryKey(provider)] && Date.now() > data[sidExpiryKey(provider)]) {
        logger.debug(`${provider} 缓存 sid 已过期`);
        await chrome.storage.local.remove([key, sidExpiryKey(provider)]);
        return { sid: null, source: 'expired' };
      }
      return { sid: data[key], source: 'cache' };
    }
  } catch (e) {
    logger.warn(`读取 ${provider} 缓存 sid 失败: ${e.message}`);
  }
  return { sid: null, source: 'none' };
}

/**
 * 仅读取缓存 sid（不做清理）。无缓存或已过期时返回 null。
 * 适用于不关心 source 的调用方。
 * @param {string} provider
 * @returns {Promise<string|null>}
 */
export async function getCachedSid(provider) {
  const key = sidStorageKey(provider);
  if (!key) return null;
  try {
    const data = await chrome.storage.local.get([key, sidExpiryKey(provider)]);
    if (data[key]) {
      if (data[sidExpiryKey(provider)] && Date.now() > data[sidExpiryKey(provider)]) {
        return null;
      }
      return data[key];
    }
  } catch (e) {
    logger.warn(`读取 ${provider} sid 失败: ${e.message}`);
  }
  return null;
}

/**
 * 判断某 provider 是否存在未过期 sid 缓存。
 */
export async function hasValidSid(provider) {
  const sid = await getCachedSid(provider);
  return !!sid;
}

/**
 * 清除某 provider 的 sid 缓存。
 * @returns {Promise<boolean>}
 */
export async function clearSid(provider) {
  const key = sidStorageKey(provider);
  if (!key) return false;
  try {
    await chrome.storage.local.remove([key, sidExpiryKey(provider)]);
    return true;
  } catch (e) {
    logger.warn(`清除 ${provider} sid 失败: ${e.message}`);
    return false;
  }
}
