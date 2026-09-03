/**
 * provider-163.js - 163邮箱未读接口探测实现
 *
 * 方案 B 核心：通过 Service Worker 直接 fetch 163 webmail 的内部接口，
 * 携带浏览器已登录的会话 Cookie，探测未读邮件。
 *
 * 探测结果（前期HTTP探测）：
 * - 统一网关: https://mail.163.com/js6/s?func=<模块>:<动作>
 * - 未登录时返回: {'code':'FA_SECURITY'} (安全层拦截，非404)
 * - 无 CORS 头，需要通过扩展 host_permissions 绕过
 * - 会话载体为登录 Cookie
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';

const logger = createLogger('provider-163');

/**
 * 探测 163 邮箱未读接口
 * 
 * @param {Object} options - 探测选项
 * @param {string[]} options.endpointNames - 要探测的接口名，空数组则全部探测
 * @returns {Promise<Object>} - 探测结果
 */
export async function probe163(options = {}) {
  const config = PROVIDER_CONFIG['netease_163'];
  const endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  logger.info('开始探测163邮箱未读接口', { endpoints: endpoints.map(e => e.name) });

  const results = [];
  let authVerified = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, options);
    results.push(result);

    // 如果探测成功说明认证有效
    if (result.success) {
      authVerified = true;
    }
  }

  // 判断认证状态
  const needsAuth = results.some(r => r.authBlocked);
  const allFailed = results.every(r => !r.success);

  const summary = {
    provider: 'netease_163',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified,
    needsAuth,
    allFailed,
    results,
  };

  logger.info('163 探测完成', { authVerified, needsAuth, allFailed });

  return summary;
}

/**
 * 探测单个接口端点
 */
async function probeSingleEndpoint(endpoint, options) {
  const logger_ep = createLogger(`163:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name} @ ${endpoint.url}`);

  const startTime = performance.now();

  try {
    // 构造 fetch 请求，带凭据（会话 Cookie）
    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      mode: 'cors', // 扩展使用 host_permissions 可绕过 CORS
      redirect: 'follow',
      headers: { ...(endpoint.headers || {}) },
    };

    // 调试选项
    if (DEBUG_FEATURE.captureRequestHeaders && options.captureRequestHeaders) {
      logger_ep.debug('请求详情', {
        url: endpoint.url,
        method: fetchOptions.method,
        headers: fetchOptions.headers,
      });
    }

    logger_ep.debug(`发起请求 ${endpoint.method} ${endpoint.url}`);

    const response = await fetch(endpoint.url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms`);

    // 读取响应文本（截断到安全大小）
    const text = await response.text();
    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    logger_ep.debug(`响应内容(前${DEBUG_FEATURE.maxResponsePreviewBytes}字节): ${preview}`);

    // 判断认证是否被拦截
    // FA_SECURITY 是 163 明确的安全拦截标志
    // login/登录 特征需要与整体响应内容一起判断
    const hasAuthBlockMarkers =
      text.includes('FA_SECURITY') ||
      text.includes('FA_SECURITY_FA') ||
      text.includes('需要登录') ||
      text.includes('请先登录') ||
      text.includes('session expired') ||
      response.status === 401 ||
      response.status === 403;

    // 如果是 HTML 页面且包含明显的登录引导特征
    const hasLoginPageFeatures =
      (text.includes('login') || text.includes('登录')) &&
      text.toLowerCase().includes('html') &&
      text.includes('input') ||
      text.includes('iframe');

    const authBlocked = hasAuthBlockMarkers || hasLoginPageFeatures;

    // 解析未读数（多种策略尝试）
    const parseResult = parse163Response(text, endpoint.name);

    const result = {
      endpointName: endpoint.name,
      url: endpoint.url,
      success: response.ok && !authBlocked && parseResult.hasResult,
      httpStatus: response.status,
      elapsedMs: elapsed,
      authBlocked,
      hasResult: parseResult.hasResult,
      unreadCount: parseResult.unreadCount,
      preview: preview,
      responseHeaders: DEBUG_FEATURE.captureResponseHeaders ? response.headers : undefined,
    };

    if (result.success) {
      logger_ep.info(`接口 ${endpoint.name} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (authBlocked) {
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截: FA_SECURITY或需登录`);
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
 * 解析 163 接口响应的未读数
 * 根据已知接口的返回格式，尝试多种解析策略
 */
function parse163Response(text, endpointName) {
  // 策略1：尝试 JSON.parse（163 接口通常返回 JSONP 格式或 JSON）
  try {
    // 去除 JSONP 包裹
    let jsonText = text.trim();
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      jsonText = jsonpMatch[1];
    }

    const data = JSON.parse(jsonText);

    // 查找未读数字段（多种可能路径）
    const unread = findUnreadCount(data);
    if (unread !== null && unread !== undefined) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {
    // JSON 解析失败，继续尝试其他策略
  }

  // 策略2：正则匹配未读模式
  // 匹配形如 "unread": 3 或 unreadcount: 5 的字段
  const unreadRegex = /["']?(?:unread|unreadCount|unread_count|messageCount)["']?\s*[:=]\s*["']?(\d+)["']?/i;
  const unreadMatch = text.match(unreadRegex);
  if (unreadMatch) {
    return { hasResult: true, unreadCount: parseInt(unreadMatch[1], 10) };
  }

  return { hasResult: false, unreadCount: null };
}

/**
 * 递归查找未读计数字段
 */
function findUnreadCount(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 6) return null;

  // 直接查找已知键名
  const unreadKeys = ['unread', 'unreadCount', 'unread_count', 'messageCount', 'count', 'total'];
  for (const key of unreadKeys) {
    if (typeof data[key] === 'number') {
      return data[key];
    }
    if (typeof data[key] === 'string' && /^\d+$/.test(data[key])) {
      return parseInt(data[key], 10);
    }
  }

  // 递归查找
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
