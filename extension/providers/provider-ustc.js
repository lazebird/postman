/**
 * provider-ustc.js - USTC邮箱未读接口探测实现
 *
 * USTC 使用 Coremail 系统，API 格式与 163 类似。
 * 主要接口：
 * - getAllFolders: 获取所有文件夹及未读数（返回 unreadMessageCount）
 * - getAttrs: 获取用户属性
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { headersToObject, fetchWithTimeout } from '../shared/session.js';
import { getApiPatterns, patternsToProbeEndpoints } from '../shared/api-patterns.js';

const logger = createLogger('provider-ustc');

/**
 * 探测 USTC 邮箱未读接口
 */
export async function probeUSTC(options = {}) {
  const config = PROVIDER_CONFIG['ustc'];

  const cachedSid = await getSidFromStorage();
  const { sid, source: sidSource } = cachedSid;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口');
    endpoints = config.probeEndpoints;
  }

  // 加入捕获的 API 模式（如果有），优先执行
  const capturedPatterns = await getApiPatterns('ustc');
  let capturedEndpoints = [];
  if (capturedPatterns.length > 0) {
    capturedEndpoints = patternsToProbeEndpoints(capturedPatterns);
    logger.info(`发现 ${capturedPatterns.length} 条捕获的 USTC API 模式`);
  }

  // 组合：先试捕获的真实模式，再试内置候选接口
  const allEndpoints = [...capturedEndpoints, ...endpoints];

  logger.info('开始探测USTC邮箱未读接口', {
    endpoints: allEndpoints.map(e => e.name),
    hasSid: !!sid,
    sidSource: sidSource || 'none',
    capturedCount: capturedEndpoints.length,
  });

  const results = [];
  let anySucceeded = false;
  let lastError = null;

  for (const endpoint of allEndpoints) {
    const result = await probeSingleEndpoint(endpoint, sid, options);
    results.push(result);

    if (result.success) {
      anySucceeded = true;
      break;
    }
    if (result.error) lastError = result.error;
  }

  const allFailed = results.length > 0 && results.every(r => !r.success);
  const authBlocked = results.some(r => r.authBlocked);

  const summary = {
    provider: 'ustc',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded && !authBlocked && !sid,
    allFailed,
    session: {
      sidObtained: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      loggedIn: anySucceeded || (sid !== null),
      source: sidSource || 'none',
    },
    results,
  };

  logger.info('USTC 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
  });

  return summary;
}

/**
 * 从 chrome.storage.local 读取 USTC 的缓存 sid
 */
async function getSidFromStorage() {
  try {
    const data = await chrome.storage.local.get(['sid_ustc', 'sid_ustc_expiry']);
    if (data.sid_ustc) {
      if (data.sid_ustc_expiry && Date.now() > data.sid_ustc_expiry) {
        logger.debug('缓存 sid 已过期');
        await chrome.storage.local.remove(['sid_ustc', 'sid_ustc_expiry']);
        return { sid: null, source: 'expired' };
      }
      return { sid: data.sid_ustc, source: 'cache' };
    }
  } catch (e) {
    logger.warn(`读取缓存 sid 失败: ${e.message}`);
  }
  return { sid: null, source: 'none' };
}

/**
 * 探测单个 USTC 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`ustc:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}${sid ? '' : '（无 sid，仅依赖 Cookie）'}`);

  const startTime = performance.now();

  try {
    // 构造 URL
    let url = endpoint.url;
    try {
      if (sid && url.includes('{sid}')) {
        url = url.replace(/\{sid\}/g, sid);
      }
      if (!sid) {
        url = url.replace(/[?&]sid=\{sid\}/g, '');
        url = url.replace(/\{sid\}/g, '');
        url = url.replace(/[?&]sid=$/g, '');
        url = url.replace(/&sid=$/g, '');
      }
      if (sid && !url.match(/[?&]sid=[a-zA-Z0-9]/)) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sid=${encodeURIComponent(sid)}`;
      }
    } catch (e) {
      if (sid) {
        url = url.replace(/\{sid\}/g, sid);
      } else {
        url = url.replace(/[?&]sid=\{sid\}/g, '');
      }
    }

    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      redirect: 'follow',
    };

    // 构建 headers
    let headers = {};
    if (endpoint.captured && endpoint.headers && typeof endpoint.headers === 'object') {
      headers = { ...endpoint.headers };
    } else {
      headers = { ...(endpoint.headers || {}) };
    }

    // 替换 headers 中的 {sid} 占位符
    for (const [key, value] of Object.entries(headers)) {
      if (sid) {
        headers[key] = String(value).replace(/\{sid\}/g, sid);
      } else if (String(value).includes('{sid}')) {
        delete headers[key];
      }
    }
    fetchOptions.headers = headers;

    // POST body
    if (fetchOptions.method === 'POST' || fetchOptions.method === 'post') {
      let body = endpoint.bodyTemplate;
      if (body) {
        body = body.replace(/\{sid\}/g, sid || '');
        if (endpoint.isUrlEncoded) {
          body = encodeURIComponent(body);
        }
        fetchOptions.body = body;
        logger_ep.debug(`POST body: ${body.substring(0, 200)}`);
      }
    }

    logger_ep.debug(`发起请求 ${fetchOptions.method} ${url}`);
    const response = await fetchWithTimeout(url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms`);

    const text = await response.text();
    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    const authInfo = analyzeAuth(text, response.status);

    if (authInfo.authBlocked) {
      logger_ep.warn('USTC 会话已失效，清除缓存的 sid');
      try {
        await chrome.storage.local.remove(['sid_ustc', 'sid_ustc_expiry']);
      } catch (e) {}
    }

    const parseResult = parseUSTCResponse(text);

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
      preview: preview.substring(0, 500),
      responseHeaders: headersToObject(response.headers),
      sidUsed: !!sid,
    };

    if (result.success) {
      logger_ep.info(`接口 ${endpoint.name} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (result.authBlocked) {
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截: ${authInfo.reason}`);
    } else {
      logger_ep.warn(`接口 ${endpoint.name} 返回但未能解析未读数`);
    }

    return result;
  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.error(`接口 ${endpoint.name} 请求异常: ${err.message}`);

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
 * 分析 USTC 接口响应，判断认证状态
 */
function analyzeAuth(text, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  if (text.includes('FA_UNAUTHORIZED') || text.includes('未登录')) {
    return { authBlocked: true, reason: '未登录' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 USTC 接口响应的未读数
 */
function parseUSTCResponse(text) {
  // 策略1: JSON 格式（标准）
  try {
    const data = JSON.parse(text.trim());
    
    // 检查 getAllFolders 响应
    if (data.code === 'S_OK' && Array.isArray(data.var)) {
      let totalUnread = 0;
      for (const folder of data.var) {
        if (folder.stats && typeof folder.stats.unreadMessageCount === 'number') {
          totalUnread += folder.stats.unreadMessageCount;
        }
      }
      if (totalUnread >= 0) {
        return { hasResult: true, unreadCount: totalUnread };
      }
    }
    
    // 尝试递归查找未读数
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {
    // 继续尝试其他策略
  }

  // 策略2: 正则提取
  const regexes = [
    /unreadMessageCount["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /unread["']?\s*[:=]\s*["']?(\d+)["']?/i,
  ];
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match) {
      return { hasResult: true, unreadCount: parseInt(match[1], 10) };
    }
  }

  return { hasResult: false, unreadCount: null };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'unreadMessageCount', 'messageCount', 'count', 'total'];
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
