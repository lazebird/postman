/**
 * provider-163.js - 163邮箱未读接口探测实现
 *
 * 修复要点：
 * 1. 先通过会话初始化获取 sid，再使用 sid 调用业务接口
 * 2. POST 请求正确携带 body
 * 3. 修复 response headers 序列化（Headers → 普通对象）
 * 4. 更准确的登录/会话状态判断
 * 5. 改进响应解析（支持 XML / JSON / 自定义格式）
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { getSid163, replaceSidInUrl, headersToObject, clearSid } from '../shared/session.js';

const logger = createLogger('provider-163');

/**
 * 探测 163 邮箱未读接口
 *
 * 流程：
 * 1. 获取会话 sid（先查缓存，无则访问入口页）
 * 2. 对每个启用的接口，使用 sid 构造 URL 并调用
 * 3. 解析响应中的未读数
 *
 * @param {Object} options - 探测选项
 * @param {string[]} options.endpointNames - 要探测的接口名
 * @returns {Promise<Object>} - 探测结果
 */
export async function probe163(options = {}) {
  const config = PROVIDER_CONFIG['netease_163'];

  // 第一步：获取会话 sid
  const sessionResult = await getSid163({ forceRefresh: options.forceRefreshSid });
  const { sid, loggedIn: sessionLoggedIn, source: sidSource } = sessionResult;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  // 如果过滤后为空（可能是旧配置引用了不存在的接口名），回退到所有接口
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
    // 没有 sid = 会话无效或未登录
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
        detail: sessionResult.detail,
      },
      results: [],
    };
    logger.warn('163 探测中止：未能获得会话 sid');
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
    authVerified: anySucceeded || sessionLoggedIn,
    // needsAuth 仅在 sid 存在但所有请求都被拦截时才为 true
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
 * 探测单个 163 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`163:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}`);

  const startTime = performance.now();

  try {
    // 使用 sid 替换 URL 占位符
    let url = replaceSidInUrl(endpoint.url, sid);
    const urlObj = new URL(url);
    // 添加 sid 参数
    if (!urlObj.searchParams.has('sid')) {
      urlObj.searchParams.set('sid', sid);
    }

    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      mode: 'cors',
      redirect: 'follow',
      headers: { ...(endpoint.headers || {}) },
    };

    // 对 POST 请求，添加正确的 body
    if (fetchOptions.method === 'POST' || fetchOptions.method === 'post') {
      // 使用 bodyTemplate 或默认参数
      let body = endpoint.bodyTemplate;
      if (!body) {
        // 默认的 mbox:listMessages 查询参数
        body = 'var=@{type:"getunreadmsgs",ver:0,mailid:"",folderid:""}';
      }
      fetchOptions.body = body;
      logger_ep.debug(`POST body: ${body}`);
    }

    // 调试选项
    if (DEBUG_FEATURE.captureRequestHeaders && options.captureRequestHeaders) {
      logger_ep.debug('请求详情', {
        url: urlObj.toString(),
        method: fetchOptions.method,
        headers: fetchOptions.headers,
        body: fetchOptions.body,
      });
    }

    logger_ep.debug(`发起请求 ${fetchOptions.method} ${urlObj.toString()}`);
    const response = await fetch(urlObj.toString(), fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms, finalUrl=${response.url}`);

    // 读取响应文本
    const text = await response.text();
    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    // 判断认证状态
    const authInfo = analyzeAuth(text, response.status);

    // 解析响应
    const parseResult = parse163Response(text, endpoint.name);

    // 检查最终 URL 中是否出现了 sid（防止 sid 失效后重定向到登录页）
    if (authInfo.authBlocked) {
      // 会话失效，清除缓存的 sid
      logger_ep.warn('163 会话已失效，清除缓存的 sid');
      try {
        await clearSid('netease_163');
      } catch (e) { /* ignore */ }
    }

    const result = {
      endpointName: endpoint.name,
      url: urlObj.toString(),
      success: response.ok && !authInfo.authBlocked && parseResult.hasResult,
      httpStatus: response.status,
      elapsedMs: elapsed,
      authBlocked: authInfo.authBlocked,
      authReason: authInfo.reason,
      hasResult: parseResult.hasResult,
      unreadCount: parseResult.unreadCount,
      responseContentType: response.headers?.get?.('content-type') || '',
      preview: preview,
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
        parseError: parseResult.error || null,
      });
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
 * 分析 163 接口响应，判断认证状态
 */
function analyzeAuth(text, httpStatus) {
  // HTTP 状态码判断
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  // 163 的 XML 响应格式中的认证错误
  if (text.includes('FA_UNAUTHORIZED')) {
    return { authBlocked: true, reason: 'FA_UNAUTHORIZED' };
  }
  if (text.includes('FA_SECURITY')) {
    return { authBlocked: true, reason: 'FA_SECURITY' };
  }
  if (text.includes('No sid parameter')) {
    return { authBlocked: true, reason: 'No sid parameter' };
  }

  // 登录引导页特征
  if (text.includes('需要登录') || text.includes('请先登录')) {
    return { authBlocked: true, reason: 'Login required' };
  }

  // session expired
  if (text.toLowerCase().includes('session expired')) {
    return { authBlocked: true, reason: 'Session expired' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 163 接口响应的未读数
 */
function parse163Response(text, endpointName) {
  // 策略1: XML 格式（163 的 /js6/s 在错误时返回 XML，成功时可能是 JSON 或 XML）
  // 检查是否包含 code=FA_OK 等成功标记
  if (text.includes('FA_OK') || text.includes('<code>FA_OK</code>')) {
    // XML 成功响应，尝试提取未读数
    const unreadMatch = text.match(/<count[^>]*>\s*(\d+)\s*<\/count>/i) ||
                        text.match(/<unread[^>]*>\s*(\d+)\s*<\/unread>/i) ||
                        text.match(/unread_count["']?\s*[=:]\s*["']?(\d+)/i);
    if (unreadMatch) {
      return { hasResult: true, unreadCount: parseInt(unreadMatch[1], 10) };
    }
    // FA_OK 但找不到数字 → 可能是 data 嵌套在 XML CDATA 中
  }

  // 策略2: JSON / JSONP
  try {
    let jsonText = text.trim();
    // 去除 JSONP 包裹
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      jsonText = jsonpMatch[1];
    }

    const data = JSON.parse(jsonText);
    const unread = findUnreadCount(data);
    if (unread !== null && unread !== undefined) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {
    // JSON 解析失败，继续
  }

  // 策略3: 正则匹配未读模式
  const unreadRegex = /["']?(?:unread|unreadCount|unread_count|messageCount|totalCount)["']?\s*[:=]\s*["']?(\d+)["']?/i;
  const unreadMatch = text.match(unreadRegex);
  if (unreadMatch) {
    return { hasResult: true, unreadCount: parseInt(unreadMatch[1], 10) };
  }

  // 策略4: 匹配 163 XML 结构中的变量形式
  const xmlVarRegex = /<var[^>]*>([^<]*(?:unread|count)[^<]*)<\/var>/i;
  const xmlMatch = text.match(xmlVarRegex);
  if (xmlMatch) {
    const inner = xmlMatch[1];
    const countMatch = inner.match(/(\d+)/);
    if (countMatch) {
      return { hasResult: true, unreadCount: parseInt(countMatch[1], 10) };
    }
  }

  return { hasResult: false, unreadCount: null, error: 'No unread count found in response' };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  // 直接查找已知键名
  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'messageCount', 'count', 'total', 'totalCount'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  // 递归查找数组中的对象
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
