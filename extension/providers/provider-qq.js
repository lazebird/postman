/**
 * provider-qq.js - QQ邮箱未读接口探测实现
 *
 * 混合方案下：
 *   1. 优先从 chrome.storage.session 读取缓存 sid（内容脚本提取）
 *   2. 带 sid 调 API 获取未读数
 *
 * 修复：不再因无缓存 sid 就直接中止探测。
 *   - 有 sid：拼入 URL 调 API
 *   - 无 sid：尝试不带 sid 直接调 API（部分 QQ 端点可仅靠 Cookie 工作），
 *     若被拦截则标记 needsSid=true，交由上层自动恢复 sid。
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { headersToObject } from '../shared/session.js';

const logger = createLogger('provider-qq');

/**
 * 探测 QQ 邮箱未读接口
 *
 * @param {Object} options
 * @returns {Promise<Object>}
 */
export async function probeQQ(options = {}) {
  const config = PROVIDER_CONFIG['qq'];

  // 读取缓存 sid
  const cachedSid = await getSidFromStorage();
  const { sid, source: sidSource } = cachedSid;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口', { requested: options.endpointNames });
    endpoints = config.probeEndpoints;
  }

  logger.info('开始探测QQ邮箱未读接口', {
    endpoints: endpoints.map(e => e.name),
    hasSid: !!sid,
    sidSource: sidSource || 'none',
  });

  // 核心修复：不再因无 sid 直接返回失败。
  // QQ 部分接口（如 fr_show）可能在无 sid 时也能通过 Cookie 工作，
  // 至少应尝试发起请求；若响应明确要求 sid，则由上层触发自动恢复。
  const results = [];
  let anySucceeded = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, sid, options);
    results.push(result);

    if (result.success) {
      anySucceeded = true;
    }
  }

  const allFailed = results.length > 0 && results.every(r => !r.success);
  const authBlocked = results.some(r => r.authBlocked);
  const needsSid = !sid && (allFailed || authBlocked);

  const summary = {
    provider: 'qq',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded && !needsSid,
    allFailed,
    needsSid, // 新增：无 sid 且 API 失败 → 上层需要自动恢复 sid
    session: {
      sidObtained: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      loggedIn: anySucceeded || (sid !== null),
      source: sidSource || 'none',
    },
    results,
  };

  logger.info('QQ 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
    needsSid,
  });

  return summary;
}

/**
 * 从 chrome.storage.session 读取 QQ 的缓存 sid
 */
async function getSidFromStorage() {
  try {
    const data = await chrome.storage.session.get(['sid_qq', 'sid_qq_expiry']);
    if (data.sid_qq) {
      if (data.sid_qq_expiry && Date.now() > data.sid_qq_expiry) {
        logger.debug('缓存 sid 已过期');
        await chrome.storage.session.remove(['sid_qq', 'sid_qq_expiry']);
        return { sid: null, source: 'expired' };
      }
      return { sid: data.sid_qq, source: 'cache' };
    }
  } catch (e) {
    logger.warn(`读取缓存 sid 失败: ${e.message}`);
  }
  return { sid: null, source: 'none' };
}

/**
 * 探测单个 QQ 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`qq:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}${sid ? '' : '（无 sid，仅依赖 Cookie）'}`);

  const startTime = performance.now();

  try {
    // 构造 URL：有 sid 时替换 {sid} 占位符；无 sid 时移除占位符
    let url = endpoint.url;
    try {
      const urlObj = new URL(url);
      // 移除 {sid} 占位符参数
      urlObj.searchParams.delete('sid');
      if (sid) {
        urlObj.searchParams.set('sid', sid);
      }
      // 移除 URL 路径中的 {sid} 占位符
      let pathname = urlObj.pathname.replace(/\{sid\}/g, '');
      urlObj.pathname = pathname;
      url = urlObj.toString();
    } catch (e) {
      // URL 解析失败，手动处理
      if (sid) {
        url = url.replace(/\{sid\}/g, sid);
      } else {
        url = url.replace(/[?&]sid=\{sid\}/g, '');
        url = url.replace(/\{sid\}/g, '');
      }
      if (sid && !url.includes('sid=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sid=${sid}`;
      }
    }

    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      redirect: 'follow',
    };

    const headers = {
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(endpoint.headers || {}),
    };
    // 替换 headers 中的 {sid} 占位符
    for (const [key, value] of Object.entries(headers)) {
      if (sid) {
        headers[key] = String(value).replace(/\{sid\}/g, sid);
      } else if (String(value).includes('{sid}')) {
        // 无 sid：移除含 sid 的 header
        delete headers[key];
      }
    }
    fetchOptions.headers = headers;

    logger_ep.debug(`发起请求 ${fetchOptions.method} ${url}`);
    const response = await fetch(url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms, finalUrl=${response.url}`);

    // 解码响应（QQ 使用 GB18030）
    const text = await decodeResponse(response);
    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    // 判断认证状态
    const authInfo = analyzeQQAuth(text, response.status, response.url);

    // 如果登录页, 清除 sid 缓存
    if (authInfo.authBlocked) {
      logger_ep.warn('QQ 会话已失效或未登录，清除缓存 sid');
      try {
        await chrome.storage.session.remove(['sid_qq', 'sid_qq_expiry']);
      } catch (e) { /* ignore */ }
    }

    // 解析响应
    const parseResult = parseQQResponse(text);

    const result = {
      endpointName: endpoint.name,
      url,
      success: response.ok && !authInfo.authBlocked && parseResult.hasResult,
      httpStatus: response.status,
      elapsedMs: elapsed,
      authBlocked: authInfo.authBlocked,
      authReason: authInfo.reason,
      hasResult: parseResult.hasResult,
      unreadCount: parseResult.unreadCount,
      responseContentType: response.headers?.get?.('content-type') || '',
      preview,
      responseHeaders: headersToObject(response.headers),
      sidUsed: !!sid,
      needsSid: !sid && authInfo.authBlocked,
    };

    if (result.success) {
      logger_ep.info(`接口 ${endpoint.name} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (result.authBlocked) {
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截: ${authInfo.reason}`);
    } else {
      logger_ep.warn(`接口 ${endpoint.name} 返回但未能解析未读数`, {
        status: response.status,
        hasResult: parseResult.hasResult,
        preview: preview.substring(0, 300),
      });
    }

    return result;
  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.error(`接口 ${endpoint.name} 请求异常: ${err.message}`, {
      url: endpoint.url,
      errorName: err.name,
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
      sidUsed: !!sid,
    };
  }
}

/**
 * 解码响应内容（处理 GB18030 等非 UTF-8 编码）
 */
async function decodeResponse(response) {
  const contentType = response.headers?.get?.('content-type') || '';
  const isGB18030 = contentType.includes('gb18030') || contentType.includes('gbk') || contentType.includes('gb2312');

  try {
    const arrayBuffer = await response.arrayBuffer();
    if (isGB18030) {
      try {
        return new TextDecoder('gb18030').decode(arrayBuffer);
      } catch (e) {
        return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
  } catch (e) {
    return await response.text();
  }
}

/**
 * 判断 QQ 响应是否处于登录/认证拦截状态
 */
function analyzeQQAuth(text, httpStatus, finalUrl) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  const loginMarkers = [
    'gbIsNoCheck',
    'loginFrame',
    'qm_login',
    '需要登录',
    '您还未登录',
    'session expired',
    'cgierrorcode:-2',
    '登录QQ邮箱',
  ];

  for (const marker of loginMarkers) {
    if (text.includes(marker)) {
      return { authBlocked: true, reason: marker };
    }
  }

  if (finalUrl && finalUrl.includes('/cgi-bin/login')) {
    return { authBlocked: true, reason: 'Redirected to login page' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 QQ 邮箱响应的未读数
 */
function parseQQResponse(text) {
  // 策略1: JSON
  try {
    const data = JSON.parse(text.trim());
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {}

  // 策略2: 正则查找 QQ 特有的未读字段
  const unreadRegex = /["']?(?:unreadnum|unread|unreadCount|total|count)["']?\s*[:=]\s*["']?(\d+)["']?/i;
  const match = text.match(unreadRegex);
  if (match) {
    return { hasResult: true, unreadCount: parseInt(match[1], 10) };
  }

  // 策略3: HTML 页面中的未读计数标记
  const htmlPatterns = [
    /data-unread=["'](\d+)["']/i,
    /class=["'][^"']*unread[^"']*["'][^>]*>\s*(\d+)\s*</i,
    /class=["'][^"']*count[^"']*["'][^>]*>\s*(\d+)\s*</i,
    />(\d+)\s*<\/[^>]+>\s*<[^>]+>\s*收件箱/i,
  ];
  for (const pattern of htmlPatterns) {
    const m = text.match(pattern);
    if (m) {
      return { hasResult: true, unreadCount: parseInt(m[1], 10) };
    }
  }

  // 策略4: QQ 收件箱页面的特定格式
  const folderMatch = text.match(/收件箱[^>]{0,50}?[\(（]\s*(\d+)\s*[\)）]/);
  if (folderMatch) {
    return { hasResult: true, unreadCount: parseInt(folderMatch[1], 10) };
  }

  return { hasResult: false, unreadCount: null };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'unreadnum', 'messageCount', 'count', 'total'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUnreadCount(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val && typeof val === 'object') {
      const found = findUnreadCount(val, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}
