/**
 * session.js - 会话管理工具（简化版）
 *
 * 混合方案下 sid 来源：
 *   - 内容脚本从邮箱页面 URL / DOM 提取 sid → 缓存到 chrome.storage.session
 *   - provider 直接从 storage.session 读取缓存 sid → 调 API
 *
 * 本模块提供纯工具函数（URL/内容解析、Headers 转换等），
 * 不再负责从远程页面主动获取 sid（因为 163 新版 SPA 页面无法在静态 HTML 中提取）。
 */

import { createLogger } from './debug.js';

const logger = createLogger('session');

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
  } catch (e) {
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
 * 清除 163 或 QQ 的缓存 sid
 */
export async function clearSid(provider) {
  const key = provider === 'qq' ? 'sid_qq' : 'sid_163';
  try {
    await chrome.storage.session.remove([key, `${key}_expiry`]);
  } catch (e) {
    logger.warn(`清除 ${provider} sid 失败: ${e.message}`);
  }
}

/**
 * 将 URL 中的 {sid} 占位符替换为实际值
 */
export function replaceSidInUrl(url, sid) {
  if (!url) return url;
  if (!sid) return url;
  return url.replace(/\{sid\}/g, sid);
}
