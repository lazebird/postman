/**
 * provider-gmail.js - Gmail 邮箱未读接口探测实现
 *
 * 使用 Gmail REST API + OAuth2 认证
 *
 * v0.10.0 跨浏览器兼容：
 *   - 令牌获取统一迁移到 shared/gmail-oauth.js（基于 chrome.identity.launchWebAuthFlow，
 *     同时兼容 Chrome 与 Microsoft Edge）。
 *   - 移除对 chrome.identity.getAuthToken 的依赖——该 API 在 Edge 上不被支持，
 *     导致 Gmail 在 Edge 里始终无法检查。
 *   - 后台定时检查仅读取持久化的缓存令牌，绝不开标签、不弹授权页（AGENTS 规则 1）；
 *     令牌缺失/过期时返回 needsAuth，交由上层引导用户手动同步授权。
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';
import { getCachedGmailToken, clearGmailToken } from '../shared/gmail-oauth.js';

const logger = createLogger('provider-gmail');

export async function probeGmail(_options = {}) {
  const config = PROVIDER_CONFIG['gmail'];

  logger.info('开始探测 Gmail 未读接口');

  // 1. 获取缓存的 OAuth2 访问令牌（后台安全路径：仅读缓存，不弹窗/不开标签）
  const token = await getCachedGmailToken();
  if (!token) {
    logger.warn('Gmail 未授权或令牌已过期，需要用户手动同步授权');
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      session: { sidObtained: false, loggedIn: false, source: 'oauth2' },
      results: [],
      error: 'Gmail not authorized (需手动同步授权一次)',
      needsManualAuth: true,
    };
  }

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
      results: [
        {
          endpointName: 'gmail_api',
          success: true,
          unreadCount: result.unreadCount,
          httpStatus: 200,
        },
      ],
      unreadCount: result.unreadCount,
      newEmails: result.newEmails || [],
    };
  } else {
    logger.warn(`Gmail 探测失败: ${result.error}`);
    // 仅当令牌确实失效（401 / 无效凭据 / scope 不足）时才清空缓存令牌并引导重授权。
    // Gmail API 未启用 / 配额受限等 403 属项目配置问题，令牌仍有效，不清令牌也不弹授权，
    // 避免「授权成功 → 又判失效 → 反复弹窗」的死循环。
    if (result.tokenInvalid) {
      await clearGmailToken();
    }
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: result.error?.includes('auth') || result.tokenInvalid || false,
      allFailed: true,
      session: { sidObtained: true, loggedIn: true, source: 'oauth2' },
      results: [],
      error: result.error,
    };
  }
}

async function fetchGmailUnread(token) {
  try {
    const apiUrl =
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5&fields=messageId,snippet,threads';

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const classify = await classifyGmailApiError(response);
      if (classify.tokenInvalid) {
        // 401 / 无效凭据：令牌本身失效，需重新授权
        return {
          success: false,
          error: classify.message || 'Gmail 令牌已失效，需要重新授权',
          unreadCount: 0,
          tokenInvalid: true,
        };
      }
      // 其余（403 等）：令牌通常仍有效，是项目侧「Gmail API 未启用 / 配额 / 权限」问题。
      // 不要清除令牌，避免「授权成功 → 又被判失效 → 反复弹授权窗」的死循环。
      return {
        success: false,
        error: classify.message || `HTTP ${response.status}`,
        unreadCount: 0,
        tokenInvalid: false,
      };
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

/**
 * 解析 Gmail API 的错误响应，区分「令牌失效（需重新授权）」与
 * 「令牌有效但项目/API 配置问题（重授权无济于事）」，并返回可读错误消息。
 *
 * 背景：此前对 401/403 一律视为令牌失效并清空缓存令牌，导致在「Gmail API
 * 未启用 / 配额受限」这类项目侧配置问题时，即便授权成功也会被判为需授权，
 * 进而反复弹出授权窗口、无法真正完成授权（AGENTS 规则 2：体验优先）。
 *
 * @param {Response} response fetch 的非 2xx 响应
 * @returns {Promise<{tokenInvalid: boolean, message: string|null}>}
 */
async function classifyGmailApiError(response) {
  let status = response.status;
  let message = null;
  let reason = null;
  try {
    const body = await response.json();
    const err = body?.error || {};
    status = err.code || status;
    message = err.message || message;
    reason = err.errors?.[0]?.reason || null;
  } catch {
    // 响应体非 JSON（如部分 403 纯文本），保留原始 status
  }

  // 401：令牌/凭据本身失效，需重新授权
  if (status === 401) {
    return {
      tokenInvalid: true,
      message:
        reason === 'invalid_grant'
          ? 'Gmail 授权已过期或已撤销，需重新授权'
          : message || 'Gmail 访问令牌无效，需重新授权',
    };
  }

  // 403：区分「API 未启用 / 配额受限」这类重授权也无法解决的配置问题
  const text = `${message || ''} ${reason || ''}`;
  const configBlocked =
    reason === 'accessNotConfigured' ||
    reason === 'dailyLimitExceeded' ||
    reason === 'userRateLimitExceeded' ||
    reason === 'rateLimitExceeded' ||
    /access not configured/i.test(text) ||
    /has not been used in project/i.test(text) ||
    /not been enabled/i.test(text) ||
    /api is (?:not )?disabled/i.test(text);

  if (configBlocked) {
    return {
      tokenInvalid: false,
      message:
        message ||
        'Gmail API 访问受限：请在 Google Cloud 控制台确认已启用 Gmail API，并核对授权重定向 URI 与账号权限配置',
    };
  }

  // 其他 403（scope 不足 / 账号受限等）：令牌视为不可用，需重新授权
  return {
    tokenInvalid: true,
    message: message || 'Gmail 访问被拒绝，请重新授权',
  };
}

async function fetchGmailMessageDetail(token, messageId) {
  try {
    const apiUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataName=from&metadataName=subject&metadataName=date`;

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    if (!response.ok) return null;

    const data = await response.json();
    const headers = data.payload?.headers || [];
    const from = headers.find((h) => h.name === 'From')?.value || '未知发件人';
    const subject = headers.find((h) => h.name === 'Subject')?.value || '无主题';
    const date = headers.find((h) => h.name === 'Date')?.value || '';

    return { id: data.id, from, subject, date, snippet: data.snippet || '' };
  } catch (err) {
    logger.warn(`Gmail message detail failed: ${err.message}`);
    return null;
  }
}
