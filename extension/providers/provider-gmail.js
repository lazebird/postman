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
    // 401/403 说明令牌失效，清掉缓存令牌，引导用户重新授权
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
      if (response.status === 401 || response.status === 403) {
        return { success: false, error: 'Gmail auth failed', unreadCount: 0, tokenInvalid: true };
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
