/**
 * api-patterns.js - API 请求模式捕获与存储
 *
 * 核心思路：
 *   当用户偶尔打开邮箱页面时，内容脚本可捕获页面发出的实际 API 请求
 *   （URL、headers、body），存储为「可回放的 API 模式」。
 *   SW 在后台检查时，直接使用这些捕获到的真实请求模式来调用 API。
 *
 * 关键处理：
 *   - 捕获时会将 URL/body/header 中的 sid 值替换为 {sid} 占位符
 *   - 回放时从 chrome.storage.local 读取当前 sid 并替换回 {sid}
 *   - 每次捕获仅保留有限数量模式，避免存储膨胀
 */

import { createLogger } from './debug.js';
import { API_PATTERN_KEYS } from './constants.js';

const logger = createLogger('api-patterns');

/**
 * 将 URL/body/header 中的实际 sid 替换为 {sid} 占位符
 * 以支持 sid 变化后仍可复用捕获的 API 模式
 */
function normalizeSid(text, knownSids) {
  if (!text) return text;
  let result = String(text);
  for (const sid of knownSids) {
    if (!sid) continue;
    // 全局替换（URL encode / 原样匹配）
    result = result.split(sid).join('{sid}');
    try {
      result = result.split(encodeURIComponent(sid)).join('{sid}');
    } catch(e) {}
  }
  return result;
}

/**
 * 保存捕获的 API 模式
 * @param {string} provider - 'netease_163' 或 'qq'
 * @param {Array<Object>} patterns - 捕获的请求模式数组
 */
export async function saveApiPatterns(provider, patterns) {
  if (!provider || !patterns || !patterns.length) return false;
  
  const key = provider === 'qq' ? API_PATTERN_KEYS.CAPTURED_QQ : API_PATTERN_KEYS.CAPTURED_163;
  
  try {
    // 读取当前已知的 sid 用于替换
    const sidKey = provider === 'qq' ? 'sid_qq' : 'sid_163';
    const sidData = await chrome.storage.local.get(sidKey);
    const currentSid = sidData[sidKey] || '';
    const knownSids = [currentSid].filter(Boolean);
    
    // 规范化每个捕获的模式
    const normalized = patterns.map(p => ({
      ...p,
      url: normalizeSid(p.url || '', knownSids),
      body: normalizeSid(p.body || null, knownSids),
      headers: p.headers ? Object.fromEntries(
        Object.entries(p.headers).map(([k, v]) => [k, normalizeSid(v, knownSids)])
      ) : {},
    }));
    
    // 与已有模式合并（去重）
    const existing = await getApiPatterns(provider);
    const merged = [...normalized, ...existing];
    
    // 去重：相同 URL + method + body 只保留一份
    const seen = new Set();
    const unique = [];
    for (const p of merged) {
      const dedupeKey = `${p.method}|${p.url}|${JSON.stringify(p.body || '')}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      unique.push(p);
    }
    
    // 最多保留 30 条模式
    const trimmed = unique.slice(0, 30);
    
    await chrome.storage.local.set({ [key]: trimmed });
    
    logger.info(`已保存 ${provider} 的 API 模式 ${trimmed.length} 条`);
    return true;
  } catch (e) {
    logger.warn(`保存 ${provider} API 模式失败: ${e.message}`);
    return false;
  }
}

/**
 * 读取已捕获的 API 模式
 */
export async function getApiPatterns(provider) {
  const key = provider === 'qq' ? API_PATTERN_KEYS.CAPTURED_QQ : API_PATTERN_KEYS.CAPTURED_163;
  try {
    const data = await chrome.storage.local.get(key);
    return Array.isArray(data[key]) ? data[key] : [];
  } catch (e) {
    logger.warn(`读取 ${provider} API 模式失败: ${e.message}`);
    return [];
  }
}

/**
 * 清除已捕获的 API 模式
 */
export async function clearApiPatterns(provider) {
  const key = provider === 'qq' ? API_PATTERN_KEYS.CAPTURED_QQ : API_PATTERN_KEYS.CAPTURED_163;
  try {
    await chrome.storage.local.remove(key);
    return true;
  } catch (e) {
    logger.warn(`清除 ${provider} API 模式失败: ${e.message}`);
    return false;
  }
}

/**
 * 将捕获的 API 模式转为可执行的探测端点
 * 回放时会将 {sid} 替换为当前缓存的 sid
 */
export function patternsToProbeEndpoints(patterns) {
  if (!patterns || !patterns.length) return [];
  
  return patterns.map((p, idx) => ({
    name: `captured_${idx + 1}`,
    url: p.url || '',
    method: p.method || 'GET',
    headers: p.headers || {},
    requiresSid: (p.url || '').includes('{sid}'),
    bodyTemplate: p.body || null,
    description: p.description || `捕获的 API 模式 #${idx + 1}`,
    captured: true,
  }));
}
