/**
 * provider-gmail.js - Gmail 邮箱未读接口探测实现
 *
 * 使用 Gmail REST API + OAuth2 认证
 *
 * v0.9.6 兼容性重构：
 *   - `chrome.identity` 在 Microsoft Edge 中【不受支持】，
 *     直接调用会抛 "This API is not supported on Microsoft Edge ..."。
 *   - 遵循 AGENTS 规则 3：授权得到的 access_token 优先持久化到
 *     chrome.storage.local，后台（alarm）检查优先读缓存，避免每次
 *     后台检查都依赖 chrome.identity（这既是 Edge 崩溃的来源，也符合
 *     "会话令牌持久化、后台用缓存直调"的既定约束）。
 *   - Edge 上 identity 不可用时返回可读、可操作的中文错误，而不是把
 *     浏览器引擎的原始英文报错原样抛给用户。
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, GMAIL_TOKEN_KEYS } from '../shared/constants.js';

const logger = createLogger('provider-gmail');

// Gmail API scopes
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
];

// 访问令牌安全提前量：距过期不足此毫秒数即视为已失效，需刷新
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 检测当前浏览器。
 * 关键：chrome.identity 仅 Chromium(Chrome) 完整支持；Microsoft Edge 不支持。
 * @returns {'edge'|'chrome'|'other'}
 */
export function detectBrowser() {
  try {
    const uaData = navigator.userAgentData;
    if (uaData && Array.isArray(uaData.brands)) {
      for (const b of uaData.brands) {
        if (b && b.brand && /Microsoft Edge|Edge/i.test(b.brand)) return 'edge';
      }
    }
  } catch (e) { /* ignore */ }
  try {
    const ua = navigator.userAgent || '';
    if (/Edg\/|Edge\//.test(ua)) return 'edge';
    if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';
  } catch (e) { /* ignore */ }
  return 'other';
}

/**
 * 读取缓存的 Gmail access_token（未过期才返回）。
 * @returns {Promise<string|null>}
 */
export async function getCachedGmailToken() {
  try {
    const { [GMAIL_TOKEN_KEYS.TOKEN]: token, [GMAIL_TOKEN_KEYS.EXPIRY]: expiry } =
      await chrome.storage.local.get([GMAIL_TOKEN_KEYS.TOKEN, GMAIL_TOKEN_KEYS.EXPIRY]);
    if (!token) return null;
    if (expiry && Date.now() >= expiry - TOKEN_EXPIRY_BUFFER_MS) {
      logger.warn('缓存的 Gmail token 已过期，忽略');
      return null;
    }
    return token;
  } catch (e) {
    logger.warn(`读取缓存 Gmail token 失败: ${e.message}`);
    return null;
  }
}

/**
 * 缓存 Gmail access_token 到 chrome.storage.local（跨浏览器重启保留）。
 * @param {string} token
 * @param {number} [expiresInSec] access_token 有效期（秒），默认 3600
 */
export async function cacheGmailToken(token, expiresInSec = 3600) {
  try {
    await chrome.storage.local.set({
      [GMAIL_TOKEN_KEYS.TOKEN]: token,
      [GMAIL_TOKEN_KEYS.EXPIRY]: Date.now() + expiresInSec * 1000,
    });
    logger.info('已缓存 Gmail access_token');
  } catch (e) {
    logger.warn(`缓存 Gmail token 失败: ${e.message}`);
  }
}

/**
 * 清除缓存的 Gmail token。
 */
export async function clearCachedGmailToken() {
  try {
    await chrome.storage.local.remove([GMAIL_TOKEN_KEYS.TOKEN, GMAIL_TOKEN_KEYS.EXPIRY]);
  } catch (e) {
    logger.warn(`清除缓存 Gmail token 失败: ${e.message}`);
  }
}

/**
 * 识别 Edge 抛出的 "chrome.identity 不受支持" 引擎错误。
 * @param {Error|string} err
 * @returns {boolean}
 */
function isIdentityUnsupportedError(err) {
  const msg = (err && (err.message || err)) || '';
  return /not supported on Microsoft Edge|not supported/i.test(msg);
}

/**
 * 通过 chrome.identity 获取访问令牌（仅 Chromium/Chrome 受支持）。
 * 在 Edge 上该 API 被禁用，会抛 "This API is not supported on Microsoft Edge"，
 * 这里把原始错误统一归一化为结构化结果，避免晦涩英文直接抛出。
 *
 * @param {{interactive?:boolean}} opts
 * @returns {Promise<{ok:boolean, token?:string, reason?:string}>}
 */
async function fetchFromIdentity({ interactive = false } = {}) {
  const browser = detectBrowser();
  if (browser === 'edge') {
    return {
      ok: false,
      reason: 'unsupported',
      error: 'Microsoft Edge 不支持 chrome.identity（Gmail OAuth 依赖该 API）。' +
             '请在 Chrome 中为 Gmail 完成一次授权（token 会自动缓存，Edge 后台即可复用），' +
             '或在 Edge 中使用「手动授权」流程。',
    };
  }
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive, scopes: GMAIL_SCOPES }, (t) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) reject(new Error(lastErr.message));
        else resolve(t);
      });
    });
    return { ok: true, token };
  } catch (err) {
    if (isIdentityUnsupportedError(err)) {
      return { ok: false, reason: 'unsupported', error: err.message };
    }
    logger.warn(`chrome.identity.getAuthToken 失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * 统一获取 Gmail access_token（缓存优先，交互授权兜底）。
 *
 * - 后台 / 非交互（alarm 定时检查、手动探测）：
 *     只读缓存 token，绝不触发交互式授权（符合 AGENTS 规则 1——自动运行不开标签、不打扰）。
 * - 交互（用户点击「同步Gmail」）：
 *     Chrome 走 chrome.identity；Edge 不支持时返回可读提示。
 *
 * @param {{interactive?:boolean}} opts
 * @returns {Promise<{ok:boolean, token?:string, needsAuth?:boolean, error?:string}>}
 */
export async function getGmailAccessToken({ interactive = false } = {}) {
  // 非交互路径：优先用缓存，避免每次后台检查都触碰 chrome.identity
  if (!interactive) {
    const cached = await getCachedGmailToken();
    if (cached) return { ok: true, token: cached };
    const r = await fetchFromIdentity({ interactive: false });
    if (r.ok && r.token) {
      // 顺手缓存，供 Edge 后台复用
      await cacheGmailToken(r.token);
      return { ok: true, token: r.token };
    }
    return { ok: false, needsAuth: true, error: r.error || 'Gmail not authorized', reason: r.reason };
  }

  // 交互路径（用户主动授权，允许打开授权流程）
  const r = await fetchFromIdentity({ interactive: true });
  if (r.ok && r.token) {
    await cacheGmailToken(r.token);
    return { ok: true, token: r.token };
  }
  return { ok: false, error: r.error, reason: r.reason };
}

/**
 * 探测 Gmail 未读接口（与 SW / popup 的既有调用契约保持一致）。
 */
export async function probeGmail(options = {}) {
  const config = PROVIDER_CONFIG['gmail'];

  logger.info('开始探测 Gmail 未读接口');

  // 1. 获取 OAuth2 访问令牌（非交互，优先缓存）
  const tokenResult = await getGmailAccessToken({ interactive: false });
  if (!tokenResult.ok || !tokenResult.token) {
    logger.warn('Gmail 未授权 / 无法获取 token，需要用户登录');
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      session: { sidObtained: false, loggedIn: false, source: 'none' },
      results: [],
      error: tokenResult.error || 'Gmail not authorized',
      edgeUnsupported: tokenResult.reason === 'unsupported',
    };
  }
  const token = tokenResult.token;

  // 2. 调用 Gmail API 获取未读数
  const result = await fetchGmailUnread(token);

  if (result.success) {
    logger.info(`Gmail 探测成功: unread=${result.unreadCount}`);
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: true,
      needsAuth: false,
      allFailed: false,
      session: { sidObtained: true, loggedIn: true, source: 'oauth2' },
      results: [{ endpointName: 'gmail_api', success: true, unreadCount: result.unreadCount, httpStatus: 200 }],
      unreadCount: result.unreadCount,
      newEmails: result.newEmails || [],
    };
  }

  logger.warn(`Gmail 探测失败: ${result.error}`);
  return {
    provider: 'gmail',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: false,
    needsAuth: /auth/i.test(result.error || ''),
    allFailed: true,
    session: { sidObtained: true, loggedIn: true, source: 'oauth2' },
    results: [],
    error: result.error,
  };
}

async function fetchGmailUnread(token) {
  try {
    const apiUrl = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5&fields=messageId,snippet,threads';

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // token 失效：清除缓存，下次需重新授权
        await clearCachedGmailToken();
        return { success: false, error: 'Gmail auth failed', unreadCount: 0 };
      }
      return { success: false, error: `HTTP ${response.status}`, unreadCount: 0 };
    }

    const data = await response.json();
    const unreadCount = data.resultSizeEstimate || 0;
    const messages = data.messages || [];

    // 获取最新邮件详情
    const newEmails = [];
    for (const msg of messages.slice(0, 3)) {
      const detail = await fetchGmailMessageDetail(token, msg.id);
      if (detail) newEmails.push(detail);
    }

    return { success: true, unreadCount, newEmails };
  } catch (err) {
    logger.error(`Gmail API fetch failed: ${err.message}`);
    return { success: false, error: err.message, unreadCount: 0 };
  }
}

async function fetchGmailMessageDetail(token, messageId) {
  try {
    const apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataName=from&metadataName=subject&metadataName=date`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) return null;

    const data = await response.json();
    const headers = data.payload?.headers || [];
    const from = headers.find(h => h.name === 'From')?.value || '未知发件人';
    const subject = headers.find(h => h.name === 'Subject')?.value || '无主题';
    const date = headers.find(h => h.name === 'Date')?.value || '';

    return { id: data.id, from, subject, date, snippet: data.snippet || '' };
  } catch (err) {
    logger.warn(`Gmail message detail failed: ${err.message}`);
    return null;
  }
}

/**
 * 用户主动授权 Gmail（「同步Gmail」按钮）。
 * @returns {Promise<{success:boolean, token?:string|null, error?:string, edgeUnsupported?:boolean}>}
 */
export async function authorizeGmail() {
  const r = await getGmailAccessToken({ interactive: true });
  return {
    success: r.ok,
    token: r.ok ? 'obtained' : null,
    error: r.error,
    edgeUnsupported: r.reason === 'unsupported',
  };
}

export async function isGmailAuthorized() {
  const cached = await getCachedGmailToken();
  if (cached) return true;
  const r = await fetchFromIdentity({ interactive: false });
  return r.ok && !!r.token;
}

export async function disconnectGmail() {
  // 清除本地缓存的 token
  await clearCachedGmailToken();
  try {
    const r = await fetchFromIdentity({ interactive: false });
    if (r.ok && r.token) {
      // chrome.identity.removeCachedAuthToken 需要匹配目标 token
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: r.token }, () => resolve());
      });
      logger.info('Gmail disconnected');
    }
  } catch (err) {
    logger.warn(`Gmail disconnect failed: ${err.message}`);
  }
}
