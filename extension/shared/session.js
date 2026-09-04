/**
 * session.js - 会话管理工具（简化版）
 *
 * 混合方案下 sid 来源：
 *   - 内容脚本从邮箱页面 URL / DOM 提取 sid → 缓存到 chrome.storage.local
 *   - provider 直接从 storage.local 读取缓存 sid → 调 API
 *
 * 本模块提供纯工具函数（URL/内容解析、Headers 转换等），
 * 不再负责从远程页面主动获取 sid（因为 163 新版 SPA 页面无法在静态 HTML 中提取）。
 */

import { clearSid as clearCachedSid } from './session-cache.js';

/**
 * 将 Headers 对象转为普通对象（便于序列化/日志）
 */
export function headersToObject(headers) {
  if (!headers) return {};
  const obj = {};
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      obj[key] = value;
    });
  }
  return obj;
}

/**
 * 从 URL 中提取 sid
 */
export function extractSidFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const sid = parsed.searchParams.get('sid');
    if (sid && sid.length > 4) return sid;
  } catch {
    // URL 解析失败，尝试正则
  }
  const match = url.match(/[?&]sid=([^&]+)/);
  return match ? match[1] : null;
}

/**
 * 从页面内容中提取 sid（多种模式）
 */
export function extractSidFromContent(text) {
  if (!text) return null;

  // 模式1：URL 形式的 sid=xxx
  let m = text.match(/sid["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{6,})["']?/i);
  if (m) return m[1];

  // 模式2：window 变量中的 sid
  m = text.match(/window\.sid\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1];

  // 模式3：JS 变量 sid = "xxx"
  m = text.match(/var\s+sid\s*=\s*["']([a-zA-Z0-9_\-]{6,})["']/i);
  if (m) return m[1];

  // 模式4：URL 中 /sid/xxx/
  m = text.match(/sid[\/=]([a-zA-Z0-9_\-]{6,})/i);
  if (m) return m[1];

  return null;
}

/**
 * 清除某 provider 的缓存 sid（委托 shared/session-cache 统一实现）
 */
export async function clearSid(provider) {
  return clearCachedSid(provider);
}

/**
 * 将 URL 中的 {sid} 占位符替换为实际值
 */
export function replaceSidInUrl(url, sid) {
  if (!url) return url;
  if (!sid) return url;
  return url.replace(/\{sid\}/g, sid);
}

/**
 * 带超时的 fetch。
 *
 * 背景：纯后台（SW 无标签）探测邮箱接口时，部分跨源 fetch 可能长期
 * 不返回（hang），导致该接口既不打「收到响应」也不打「请求异常」日志，
 * 造成诊断黑洞。给 fetch 加一个显式超时，超时后以明确错误落日志，
 * 便于区分「请求挂起」与「响应解析失败」两类情况。
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs 超时毫秒数（默认 12s，SW 30s 生命周期内留出余量）
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { signal, ...rest } = options || {};
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
