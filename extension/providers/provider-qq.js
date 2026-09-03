/**
 * provider-qq.js - QQ邮箱未读接口探测实现
 *
 * 方案 B 核心：通过 Service Worker 直接 fetch QQ mail 的内部接口。
 *
 * 探测结果（前期HTTP探测）：
 * - 网关: /cgi-bin/mail_list?t=inbox&sid=...
 * - 需要 URL sid 参数 + qm_sk Cookie 双轨鉴权
 * - 未认证返回登录引导页（GB18030编码）
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';

const logger = createLogger('provider-qq');

/**
 * 探测 QQ 邮箱未读接口
 * 
 * @param {Object} options
 * @param {string[]} options.endpointNames
 * @returns {Promise<Object>}
 */
export async function probeQQ(options = {}) {
  const config = PROVIDER_CONFIG['qq'];
  const endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  logger.info('开始探测QQ邮箱未读接口', { endpoints: endpoints.map(e => e.name) });

  const results = [];
  let authVerified = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, options);
    results.push(result);

    if (result.success) {
      authVerified = true;
    }
  }

  const needsAuth = results.some(r => r.authBlocked);
  const allFailed = results.every(r => !r.success);

  const summary = {
    provider: 'qq',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified,
    needsAuth,
    allFailed,
    results,
  };

  logger.info('QQ 探测完成', { authVerified, needsAuth, allFailed });
  return summary;
}

/**
 * 探测单个QQ接口端点
 */
async function probeSingleEndpoint(endpoint, options) {
  const logger_ep = createLogger(`qq:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name} @ ${endpoint.url}`);

  const startTime = performance.now();

  try {
    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      mode: 'cors',
      redirect: 'follow',
      headers: { ...(endpoint.headers || {}) },
    };

    // QQ 邮箱接口可能返回 GB18030 编码，需要特别注意
    if (endpoint.name === 'cgi_mail_list') {
      fetchOptions.headers['Accept'] = 'text/html,application/xhtml+xml,*/*';
    }

    logger_ep.debug(`发起请求 ${endpoint.method} ${endpoint.url}`);

    const response = await fetch(endpoint.url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms`);

    // 读取响应内容 - QQ 使用 GB18030 编码，浏览器会自动处理
    const arrayBuffer = await response.arrayBuffer();
    let text;
    try {
      // 尝试作为 UTF-8 读取
      text = new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
    } catch (e) {
      // 尝试 GB18030（需要 TextDecoder 支持）
      try {
        text = new TextDecoder('gb18030').decode(arrayBuffer);
      } catch (e2) {
        text = new TextDecoder('utf-8').decode(arrayBuffer);
      }
    }

    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    logger_ep.debug(`响应内容(前${DEBUG_FEATURE.maxResponsePreviewBytes}字节): ${preview}`);

    // QQ 特征：登录页有 loginForm 等标识
    // 保守判断：只有当明确出现登录特征时才标记为 authBlocked
    const authBlocked =
      text.includes('loginForm') ||
      text.includes('qm_login') ||
      text.includes('login_frame') ||
      text.includes('需要登录') ||
      text.includes('您还未登录') ||
      response.status === 401 ||
      response.status === 403;

    // 解析未读数
    const parseResult = parseQQResponse(text, endpoint.name);

    const result = {
      endpointName: endpoint.name,
      url: endpoint.url,
      success: response.ok && !authBlocked && parseResult.hasResult,
      httpStatus: response.status,
      elapsedMs: elapsed,
      authBlocked,
      hasResult: parseResult.hasResult,
      unreadCount: parseResult.unreadCount,
      sidExtracted: parseResult.sidExtracted,
      preview,
    };

    if (result.success) {
      logger_ep.info(`接口 ${endpoint.name} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (authBlocked) {
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截（需登录）`);
    } else {
      logger_ep.warn(`接口 ${endpoint.name} 返回但未能解析未读数`);
    }

    return result;
  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.error(`接口 ${endpoint.name} 请求异常: ${err.message}`, {
      url: endpoint.url,
      errorName: err.name,
      stack: DEBUG_FEATURE.verboseFetchErrors ? err.stack : undefined,
    });

    return {
      endpointName: endpoint.name,
      url: endpoint.url,
      success: false,
      authBlocked: false,
      httpStatus: 0,
      elapsedMs: elapsed,
      error: err.message,
      errorName: err.name,
    };
  }
}

/**
 * 解析 QQ 邮箱响应的未读数
 */
function parseQQResponse(text, endpointName) {
  // 策略1：JSON
  try {
    const data = JSON.parse(text.trim());
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {}

  // 策略2：正则查找 QQ 特有的未读字段
  // QQ 的 mail_list 接口可能有 unreadnum 等字段
  const unreadRegex = /["']?(?:unreadnum|unread|unreadCount|total|count)["']?\s*[:=]\s*["']?(\d+)["']?/i;
  const match = text.match(unreadRegex);
  if (match) {
    return { hasResult: true, unreadCount: parseInt(match[1], 10) };
  }

  // 策略3：尝试在 HTML 页面中查找未读图标计数
  // QQ 网页版的未读数可能以 badge 形式出现在 HTML 中
  const htmlUnreadRegex = /class=["'][^"']*unread[^"']*["'][^>]*>\s*(\d+)\s*</i;
  const htmlMatch = text.match(htmlUnreadRegex);
  if (htmlMatch) {
    return { hasResult: true, unreadCount: parseInt(htmlMatch[1], 10) };
  }

  // 提取 sid 参数（QQ 特有的会话标识）
  const sidMatch = text.match(/sid=([a-zA-Z0-9_-]+)/);
  const sidExtracted = sidMatch ? sidMatch[1] : null;

  return {
    hasResult: false,
    unreadCount: null,
    sidExtracted,
  };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 6) return null;

  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'unreadnum', 'messageCount', 'count', 'total'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  for (const key of Object.keys(data)) {
    const val = data[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = findUnreadCount(item, depth + 1);
        if (found !== null) return found;
      }
    } else if (val && typeof val === 'object') {
      const found = findUnreadCount(val, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}
