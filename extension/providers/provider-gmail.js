/**
 * provider-gmail.js - Gmail 邮箱未读接口探测实现
 *
 * 使用 Gmail REST API + OAuth2 认证
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';

const logger = createLogger('provider-gmail');

// Gmail API scopes
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
];

export async function probeGmail(options = {}) {
  const config = PROVIDER_CONFIG['gmail'];
  
  logger.info('开始探测 Gmail 未读接口');

  // 1. 获取 OAuth2 访问令牌
  const token = await getGmailAccessToken();
  if (!token) {
    logger.warn('Gmail 未授权，需要用户登录');
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      session: { sidObtained: false, loggedIn: false, source: 'none' },
      results: [],
      error: 'Gmail not authorized',
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
      results: [{ endpointName: 'gmail_api', success: true, unreadCount: result.unreadCount, httpStatus: 200 }],
      unreadCount: result.unreadCount,
      newEmails: result.newEmails || [],
    };
  } else {
    logger.warn(`Gmail 探测失败: ${result.error}`);
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: result.error?.includes('auth') || false,
      allFailed: true,
      session: { sidObtained: true, loggedIn: true, source: 'oauth2' },
      results: [],
      error: result.error,
    };
  }
}

async function getGmailAccessToken() {
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: false, scopes: GMAIL_SCOPES }, (t) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      });
    });
    return token;
  } catch (err) {
    logger.warn(`Gmail OAuth2 token failed: ${err.message}`);
    return null;
  }
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

async function refreshGmailToken() {
  try {
    const token = await chrome.identity.getAuthToken({ interactive: true });
    return token;
  } catch (err) {
    logger.error(`Gmail token refresh failed: ${err.message}`);
    return null;
  }
}

export async function disconnectGmail() {
  try {
    const token = await chrome.identity.getAuthToken({ interactive: false });
    if (token) {
      await chrome.identity.disconnect(token);
      logger.info('Gmail disconnected');
    }
  } catch (err) {
    logger.warn(`Gmail disconnect failed: ${err.message}`);
  }
}

export async function isGmailAuthorized() {
  try {
    const token = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t));
    });
    return !!token;
  } catch (err) {
    return false;
  }
}
