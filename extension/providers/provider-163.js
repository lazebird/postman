/**
 * provider-163.js - 163邮箱未读接口探测实现
 *
 * v0.8.0 改进：
 *   1. 加入 API pattern 捕获回放支持
 *   2. 多接口格式探测（listMessages / getFolderCount / getUnread）
 *   3. 优化 POST body 构造与 header 处理
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { headersToObject, fetchWithTimeout } from '../shared/session.js';
import { getApiPatterns, patternsToProbeEndpoints } from '../shared/api-patterns.js';

const logger = createLogger('provider-163');

/**
 * 探测 163 邮箱未读接口
 */
export async function probe163(options = {}) {
  const config = PROVIDER_CONFIG['netease_163'];

  const cachedSid = await getSidFromStorage();
  const { sid, source: sidSource } = cachedSid;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口');
    endpoints = config.probeEndpoints;
  }

  // 加入捕获的 API 模式（优先执行真实捕获的请求）
  const capturedPatterns = await getApiPatterns('netease_163');
  let capturedEndpoints = [];
  if (capturedPatterns.length > 0) {
    capturedEndpoints = patternsToProbeEndpoints(capturedPatterns);
    logger.info(`发现 ${capturedPatterns.length} 条捕获的 163 API 模式`);
  }

  const allEndpoints = [...capturedEndpoints, ...endpoints];

  logger.info('开始探测163邮箱未读接口', {
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
      // 成功即停止，不再继续探测其他接口
      break;
    }
    if (result.error) lastError = result.error;
  }

  const allFailed = results.length > 0 && results.every(r => !r.success);
  const authBlocked = results.some(r => r.authBlocked);

  const summary = {
    provider: 'netease_163',
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

  logger.info('163 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
  });

  return summary;
}

/**
 * 从 chrome.storage.local 读取 163 的缓存 sid
 */
async function getSidFromStorage() {
  try {
    const data = await chrome.storage.local.get(['sid_163', 'sid_163_expiry']);
    if (data.sid_163) {
      if (data.sid_163_expiry && Date.now() > data.sid_163_expiry) {
        logger.debug('缓存 sid 已过期');
        await chrome.storage.local.remove(['sid_163', 'sid_163_expiry']);
        return { sid: null, source: 'expired' };
      }
      return { sid: data.sid_163, source: 'cache' };
    }
  } catch (e) {
    logger.warn(`读取缓存 sid 失败: ${e.message}`);
  }
  return { sid: null, source: 'none' };
}

/**
 * 探测单个 163 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`163:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}${sid ? '' : '（无 sid，仅依赖 Cookie）'}`);

  const startTime = performance.now();

  try {
    // 构造 URL：避免用 URL.searchParams.toString() 自动编码 func 参数中的冒号
    // （163 的 js6 RPC 接口要求 func=mbox:listMessages 等未编码格式）
    let url = endpoint.url;
    try {
      // 替换 {sid} 占位符（在 query 或 path 中）
      if (sid && url.includes('{sid}')) {
        url = url.replace(/\{sid\}/g, sid);
      }
      // 清理残留的 sid={sid} / sid=占位符（当 sid 为空时）
      if (!sid) {
        url = url.replace(/[?&]sid=\{sid\}/g, '');
        url = url.replace(/\{sid\}/g, '');
        url = url.replace(/[?&]sid=$/g, '');
        url = url.replace(/&sid=$/g, '');
        url = url.replace(/\?sid=$/g, '');
      }
      // 若无 sid 参数但已有有效 sid，需补充
      if (sid && !url.includes('sid=') && !url.match(/[?&]sid=[a-zA-Z0-9]/)) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sid=${encodeURIComponent(sid)}`;
      }
    } catch (e) {
      // fallback
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
      // 捕获的真实模式：使用页面实际发送的 headers
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
        fetchOptions.body = body;
        logger_ep.debug(`POST body: ${body.substring(0, 300)}`);
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
      logger_ep.warn('163 会话已失效，清除缓存的 sid');
      try {
        await chrome.storage.local.remove(['sid_163', 'sid_163_expiry']);
      } catch (e) {}
    }

    const parseResult = parse163Response(text);

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
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截: ${authInfo.reason}`, {
        status: response.status,
        preview: preview.substring(0, 500),
      });
    } else {
      logger_ep.warn(`接口 ${endpoint.name} 返回但未能解析未读数`, {
        status: response.status,
        contentType: result.responseContentType,
        preview: preview.substring(0, 500),
        sidUsed: !!sid,
      });
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
 * 分析 163 接口响应，判断认证状态
 */
function analyzeAuth(text, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  if (text.includes('FA_UNAUTHORIZED')) {
    return { authBlocked: true, reason: 'FA_UNAUTHORIZED' };
  }
  if (text.includes('FA_SECURITY')) {
    return { authBlocked: true, reason: 'FA_SECURITY' };
  }
  if (text.includes('No sid parameter')) {
    return { authBlocked: true, reason: 'No sid parameter' };
  }
  if (text.includes('FA_SESSION_EXPIRED')) {
    return { authBlocked: true, reason: 'FA_SESSION_EXPIRED' };
  }
  if (text.includes('FA_INVALID_SESSION')) {
    return { authBlocked: true, reason: 'FA_INVALID_SESSION' };
  }
  if (text.toLowerCase().includes('session expired')) {
    return { authBlocked: true, reason: 'Session expired' };
  }
  if (text.includes('登录后可使用') || text.includes('请先登录') || text.includes('需要登录')) {
    return { authBlocked: true, reason: 'Login required' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 163 接口响应的未读数
 */
function parse163Response(text) {
  // ===== 策略1: XML 格式 =====
  if (text.includes('<result>') || text.includes('<?xml')) {
    const patterns = [
      /<unread[^>]*>\s*(\d+)\s*<\/unread>/i,
      /<count[^>]*>\s*(\d+)\s*<\/count>/i,
      /<unreadCount[^>]*>\s*(\d+)\s*<\/unreadCount>/i,
      /<total[^>]*>\s*(\d+)\s*<\/total>/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return { hasResult: true, unreadCount: parseInt(m[1], 10) };
    }
  }

  // ===== 策略2: JSON =====
  try {
    let jsonText = text.trim();
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) jsonText = jsonpMatch[1];
    const data = JSON.parse(jsonText);
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {}

  // ===== 策略3: 正则提取 =====
  const regexes = [
    /["']?(?:unread|unreadCount|unread_count|messageCount)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?(?:unreadnum|unreadnumList|unReadCount)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /(?:unread|new|newMessage)["']?\s*[:=]\s*['"]?\s*(\d+)/i,
  ];
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match) {
      return { hasResult: true, unreadCount: parseInt(match[1], 10) };
    }
  }

  // ===== 策略4: count 模式 =====
  const countMatch = text.match(/[\[,\{]\s*["']?(?:count|total)["']?\s*[:=]\s*(\d+)/i);
  if (countMatch) {
    return { hasResult: true, unreadCount: parseInt(countMatch[1], 10) };
  }

  // ===== 策略5: 163 特有 var 编码格式 =====
  // 163 可能用 var=@ 或类似编码，尝试搜索
  const varUnread = text.match(/["']?unreadCount["']?\s*:\s*(\d+)/i) || 
                    text.match(/["']?unreadnum["']?\s*:\s*(\d+)/i);
  if (varUnread) {
    return { hasResult: true, unreadCount: parseInt(varUnread[1], 10) };
  }

  // ===== 策略6: 163 js6 RPC var 编码格式 =====
  // 163 的 js6 接口可能返回类似: var @={...} 或 var @(...)
  // 尝试提取 var @ 包裹的数据
  if (text.includes('var @') || text.includes('@=')) {
    try {
      // 尝试提取 @{...} 中的 JSON
      const atJsonMatch = text.match(/@\{([\s\S]*)\}/);
      if (atJsonMatch) {
        try {
          const data = JSON.parse(atJsonMatch[1]);
          const unread = findUnreadCount(data);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch (e) {}
      }
      // 尝试 var @=... 格式中的 JSON
      const atEqMatch = text.match(/var\s*@=\s*([\s\S]*?)(?:;|$)/);
      if (atEqMatch) {
        try {
          const data = JSON.parse(atEqMatch[1]);
          const unread = findUnreadCount(data);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch (e) {}
      }
      // 在 var 编码中搜索 unread 数字
      const varMatch = text.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
      if (varMatch) return { hasResult: true, unreadCount: parseInt(varMatch[1], 10) };
      const countMatch2 = text.match(/count["']?\s*[:=]\s*["']?(\d+)/i);
      if (countMatch2) return { hasResult: true, unreadCount: parseInt(countMatch2[1], 10) };
    } catch (e) {}
  }

  // ===== 策略7: 163 特有的 t="..."/c="..." 编码 =====
  // 163 可能用 base64 或转义字符串编码数据
  if (text.includes('t="') || text.includes("t='")) {
    const tMatch = text.match(/t=["']([^"']+)["']/);
    if (tMatch) {
      try {
        const decoded = decodeURIComponent(tMatch[1]);
        const uMatch = decoded.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
        if (uMatch) return { hasResult: true, unreadCount: parseInt(uMatch[1], 10) };
      } catch (e) {}
    }
  }

  // ===== 策略8: 163 var 编码中的 @listMessages 格式 =====
  // 检查像 "listMessages":{...} 这样的嵌套结构
  if (text.includes('listMessages') || text.includes('getFolderCount') || text.includes('getUnread')) {
    // 在深层 JSON 中搜索
    const jsonMatches = text.match(/\{[^{}]*\}/g);
    if (jsonMatches) {
      for (const seg of jsonMatches) {
        try {
          const data = JSON.parse(seg);
          const unread = findUnreadCount(data);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch (e) {}
      }
    }
  }

  return { hasResult: false, unreadCount: null };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'unreadnum', 'newCount', 'newMessageCount', 'messageCount', 'unReadCount', 'folder_unread', 'inboxCount', 'inbox_count'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  if (data.var && typeof data.var === 'string') {
    const varMatch = data.var.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
    if (varMatch) return parseInt(varMatch[1], 10);
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
