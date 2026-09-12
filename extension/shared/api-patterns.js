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
import { getCachedSid } from './session-cache.js';

const logger = createLogger('api-patterns');

/**
 * 将 URL/body/header 中的实际 sid 替换为 {sid} 占位符
 * 以支持 sid 变化后仍可复用捕获的 API 模式
 */
function normalizeSid(text, knownSids) {
  if (!text) return text;
  let result = String(text);

  // 1. 先替换已知的 sid（特定值）
  for (const sid of knownSids) {
    if (!sid) continue;
    result = result.split(sid).join('{sid}');
    try {
      result = result.split(encodeURIComponent(sid)).join('{sid}');
    } catch {}
  }

  // 2. 兜底：如果 URL/body 中还有看起来像 sid 的长字符串，替换为 {sid}
  //    163 sid: 32 字符字母数字混合
  //    QQ sid: 类似 zYhjMIy0SUYuOlo2ABJKYQAA (约 22-32 字符)
  //    只替换已知的 sid=xxx 格式，避免误替换普通数据
  const sidParamPattern = /([?&]sid=)([a-zA-Z0-9_\-]{10,})/g;
  result = result.replace(sidParamPattern, '$1{sid}');

  // 也替换 URL path 中的 sid（如果有）
  const sidPathPattern = /(\/sid\/)([a-zA-Z0-9_\-]{10,})/g;
  result = result.replace(sidPathPattern, '$1{sid}');

  return result;
}

// provider → 存储键 显式映射（各邮箱的捕获 API 模式独立存储，互不串键）。
// netease_163 / qq / ustc 依赖「内容脚本捕获 + {sid} 占位符回放」；
// gmail 走公开 Atom feed（固定 URL + Cookie 鉴权），无需捕获回放，键仅为完整对称而预留。
const PROVIDER_PATTERN_KEYS = {
  netease_163: API_PATTERN_KEYS.CAPTURED_163,
  qq: API_PATTERN_KEYS.CAPTURED_QQ,
  ustc: API_PATTERN_KEYS.CAPTURED_USTC,
  gmail: API_PATTERN_KEYS.CAPTURED_GMAIL,
};

/** 取 provider 对应的 API 模式存储键（未映射的 provider 返回 null，不读不写） */
function patternKeyFor(provider) {
  return PROVIDER_PATTERN_KEYS[provider] || null;
}

/**
 * 保存捕获的 API 模式
 * @param {string} provider - 'netease_163' | 'qq' | 'ustc' | 'gmail'
 * @param {Array<Object>} patterns - 捕获的请求模式数组
 */
export async function saveApiPatterns(provider, patterns) {
  if (!provider || !patterns || !patterns.length) return false;

  const key = patternKeyFor(provider);
  if (!key) {
    logger.warn(`provider ${provider} 无 API 模式存储键，跳过保存`);
    return false;
  }

  try {
    // 读取当前已知的 sid 用于替换（统一走 session-cache）
    const currentSid = (await getCachedSid(provider)) || '';
    const knownSids = [currentSid].filter(Boolean);

    // 规范化每个捕获的模式
    const normalized = patterns.map((p) => ({
      ...p,
      url: normalizeSid(p.url || '', knownSids),
      body: normalizeSid(p.body || null, knownSids),
      headers: p.headers
        ? Object.fromEntries(
            Object.entries(p.headers).map(([k, v]) => [k, normalizeSid(v, knownSids)])
          )
        : {},
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
 * 未映射的 provider（如未来的新邮箱）返回空数组，不读不写。
 */
export async function getApiPatterns(provider) {
  const key = patternKeyFor(provider);
  if (!key) return [];
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
 * 未映射的 provider 返回 false（无键可清）。
 */
export async function clearApiPatterns(provider) {
  const key = patternKeyFor(provider);
  if (!key) return false;
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
