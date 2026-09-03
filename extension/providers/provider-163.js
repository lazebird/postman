/**
 * provider-163.js - 163邮箱未读接口探测实现
 *
 * 混合方案下：
 *   1. 优先从 chrome.storage.session 读取缓存 sid（内容脚本提取）
 *   2. 带 sid 调 API 获取未读数
 *   3. 解析响应中的未读消息
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { headersToObject } from '../shared/session.js';

const logger = createLogger('provider-163');

/**
 * 探测 163 邮箱未读接口
 *
 * @param {Object} options - 探测选项
 * @param {string[]} options.endpointNames - 要探测的接口名
 * @returns {Promise<Object>} - 探测结果
 */
export async function probe163(options = {}) {
  const config = PROVIDER_CONFIG['netease_163'];

  // 读取缓存的 sid（由内容脚本从页面 URL 提取）
  const cachedSid = await getSidFromStorage();
  const { sid, source: sidSource } = cachedSid;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  // 如果过滤后为空，回退到所有接口
  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口', { requested: options.endpointNames });
    endpoints = config.probeEndpoints;
  }

  logger.info('开始探测163邮箱未读接口', {
    endpoints: endpoints.map(e => e.name),
    hasSid: !!sid,
    sidSource: sidSource || 'none',
  });

  if (!sid) {
    // 没有 sid = 无会话信息
    const result = {
      provider: 'netease_163',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      session: {
        sidObtained: false,
        loggedIn: false,
      },
      results: [],
    };
    logger.warn('163 探测中止：无缓存 sid，需先通过内容脚本获取');
    return result;
  }

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

  const summary = {
    provider: 'netease_163',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded,
    allFailed,
    session: {
      sidObtained: true,
      sid: sid.substring(0, 8) + '...', // 只显示前几位避免泄露
      loggedIn: true,
      source: sidSource,
    },
    results,
  };

  logger.info('163 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
  });

  return summary;
}

/**
 * 从 chrome.storage.session 读取 163 的缓存 sid
 */
async function getSidFromStorage() {
  try {
    const data = await chrome.storage.session.get(['sid_163', 'sid_163_expiry']);
    if (data.sid_163) {
      // 检查过期（30 分钟 TTL）
      if (data.sid_163_expiry && Date.now() > data.sid_163_expiry) {
        logger.debug('缓存 sid 已过期');
        await chrome.storage.session.remove(['sid_163', 'sid_163_expiry']);
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
  logger_ep.info(`探测接口 ${endpoint.name}`);

  const startTime = performance.now();

  try {
    // 构造 URL：替换 {sid} 占位符 + 追加 sid 参数
    let url = endpoint.url.replace(/\{sid\}/g, sid);
    try {
      const urlObj = new URL(url);
      if (!urlObj.searchParams.has('sid')) {
        urlObj.searchParams.set('sid', sid);
      }
      url = urlObj.toString();
    } catch (e) {
      // URL 解析失败，手动追加
      if (!url.includes('sid=')) {
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sid=${sid}`;
      }
    }

    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      redirect: 'follow',
    };

    // 设置 headers
    const headers = { ...(endpoint.headers || {}) };
    // 替换 headers 中的 {sid} 占位符
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = String(value).replace(/\{sid\}/g, sid);
    }
    fetchOptions.headers = headers;

    // 对 POST 请求，添加 body
    if (fetchOptions.method === 'POST' || fetchOptions.method === 'post') {
      let body = endpoint.bodyTemplate;
      if (body) {
        // 替换 body 中的 {sid} 占位符
        body = body.replace(/\{sid\}/g, sid);
        fetchOptions.body = body;
        logger_ep.debug(`POST body: ${body}`);
      }
    }

    logger_ep.debug(`发起请求 ${fetchOptions.method} ${url}`);
    const response = await fetch(url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms`);

    // 读取响应文本
    const text = await response.text();
    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    // 判断认证状态
    const authInfo = analyzeAuth(text, response.status);

    // 如果会话失效，清除缓存的 sid
    if (authInfo.authBlocked) {
      logger_ep.warn('163 会话已失效，清除缓存的 sid');
      try {
        await chrome.storage.session.remove(['sid_163', 'sid_163_expiry']);
      } catch (e) { /* ignore */ }
    }

    // 解析响应
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
      preview,
      responseHeaders: headersToObject(response.headers),
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
 * 支持 XML / JSON / 自定义格式
 */
function parse163Response(text) {
  // ===== 策略1: XML 格式 =====
  // 163 的 /js6/s 接口可能返回 XML
  if (text.includes('<result>') || text.includes('<?xml')) {
    // 尝试匹配各种 XML 模式中的未读计数
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

  // ===== 策略2: JSON 格式 =====
  try {
    // 尝试清理前导/尾随
    let jsonText = text.trim();
    // JSONP 去包裹
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      jsonText = jsonpMatch[1];
    }
    const data = JSON.parse(jsonText);
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {
    // JSON 解析失败，继续
  }

  // ===== 策略3: 正则提取（通用） =====
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

  // ===== 策略4: 查找字符串中的 count 模式 =====
  // 163 可能使用类似 {"count":8} 或 count:8 的格式
  const countMatch = text.match(/[\[,\{]\s*["']?(?:count|total)["']?\s*[:=]\s*(\d+)/i);
  if (countMatch) {
    return { hasResult: true, unreadCount: parseInt(countMatch[1], 10) };
  }

  return { hasResult: false, unreadCount: null };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  // 直接查找已知键名
  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'unreadnum', 'newCount', 'newMessageCount', 'messageCount'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  // 查找 var 值中可能包含的未读信息
  if (data.var && typeof data.var === 'string') {
    const varMatch = data.var.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
    if (varMatch) return parseInt(varMatch[1], 10);
  }

  // 递归查找数组
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUnreadCount(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  // 递归查找对象属性
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val && typeof val === 'object') {
      const found = findUnreadCount(val, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}
