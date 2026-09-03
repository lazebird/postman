/**
 * provider-qq.js - QQ邮箱未读接口探测实现
 *
 * 修复要点：
 * 1. 先通过会话初始化获取 sid，再使用 sid 调用业务接口
 * 2. 修复 response headers 序列化
 * 3. 正确处理 QQ 的 GB18030 编码
 * 4. 更准确的登录/会话状态判断
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { getSidQQ, replaceSidInUrl, headersToObject, clearSid } from '../shared/session.js';

const logger = createLogger('provider-qq');

/**
 * 探测 QQ 邮箱未读接口
 *
 * 流程：
 * 1. 获取会话 sid（先查缓存，无则访问入口页）
 * 2. 使用 sid 构造 URL 并调用
 * 3. 解析响应
 *
 * @param {Object} options
 * @param {string[]} options.endpointNames
 * @returns {Promise<Object>}
 */
export async function probeQQ(options = {}) {
  const config = PROVIDER_CONFIG['qq'];

  // 第一步：获取会话 sid
  const sessionResult = await getSidQQ({ forceRefresh: options.forceRefreshSid });
  const { sid, loggedIn: sessionLoggedIn, source: sidSource } = sessionResult;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter(ep => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  // 如果过滤后为空（可能是旧配置引用了不存在的接口名），回退到所有接口
  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口', { requested: options.endpointNames });
    endpoints = config.probeEndpoints;
  }

  logger.info('开始探测QQ邮箱未读接口', {
    endpoints: endpoints.map(e => e.name),
    hasSid: !!sid,
    sidSource: sidSource || 'none',
  });

  if (!sid) {
    const result = {
      provider: 'qq',
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
    logger.warn('QQ 探测中止：未能获得会话 sid');
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
    provider: 'qq',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded || sessionLoggedIn,
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

  logger.info('QQ 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
  });

  return summary;
}

/**
 * 探测单个 QQ 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`qq:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}`);

  const startTime = performance.now();

  try {
    // 使用 sid 替换 URL 中的 {sid} 占位符
    let url = replaceSidInUrl(endpoint.url, sid);

    // 如果 URL 中没有 sid 参数，且接口需要 sid，则添加
    if (!url.includes('sid=')) {
      try {
        const urlObj = new URL(url);
        urlObj.searchParams.set('sid', sid);
        url = urlObj.toString();
      } catch (e) {
        // URL 解析失败，尝试手动拼接
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}sid=${sid}`;
      }
    }

    const fetchOptions = {
      method: endpoint.method || 'GET',
      credentials: 'include',
      mode: 'cors',
      redirect: 'follow',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(endpoint.headers || {}),
      },
    };

    logger_ep.debug(`发起请求 ${fetchOptions.method} ${url}`);
    const response = await fetch(url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    logger_ep.info(`收到响应: status=${response.status}, 耗时=${elapsed}ms, finalUrl=${response.url}`);

    // QQ 使用 GB18030 编码，需要正确解码
    const text = await decodeResponse(response);

    const preview = text.length > DEBUG_FEATURE.maxResponsePreviewBytes
      ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
      : text;

    // 判断认证状态
    const authInfo = analyzeQQAuth(text, response.status, response.url);

    // 如果登录页, 清除 sid 缓存
    if (authInfo.authBlocked) {
      logger_ep.warn('QQ 会话已失效或未登录，清除缓存的 sid');
      try {
        await clearSid('qq');
      } catch (e) { /* ignore */ }
    }

    // 解析响应
    const parseResult = parseQQResponse(text, endpoint.name, sid);

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
      sidUsed: sid ? sid.substring(0, 8) + '...' : null,
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
        // TextDecoder 可能不支持 gb18030，使用 UTF-8 兜底
        return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
      }
    }

    return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
  } catch (e) {
    // 兜底使用 response.text()
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

  // QQ 登录页特征
  const loginMarkers = [
    'gbIsNoCheck',        // QQ 邮箱登录页脚本标记
    'loginFrame',         // QQ 登录 iframe
    'qm_login',           // QQ 登录 JS
    '需要登录',
    '您还未登录',
    'session expired',
    'cgierrorcode:-2',    // QQ CGI 异常代码（未登录时出现）
  ];

  for (const marker of loginMarkers) {
    if (text.includes(marker)) {
      return { authBlocked: true, reason: marker };
    }
  }

  // 检查最终 URL 是否被重定向到登录页
  if (finalUrl && finalUrl.includes('/cgi-bin/login')) {
    return { authBlocked: true, reason: 'Redirected to login page' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 QQ 邮箱响应的未读数
 */
function parseQQResponse(text, endpointName, sid) {
  // 策略1: JSON
  try {
    const data = JSON.parse(text.trim());
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch (e) {}

  // 策略2: 正则查找 QQ 特有的未读字段
  const unreadRegex = /["']?(?:unreadnum|unread|unreadCount|total|count|unreadcount)["']?\s*[:=]\s*["']?(\d+)["']?/i;
  const match = text.match(unreadRegex);
  if (match) {
    return { hasResult: true, unreadCount: parseInt(match[1], 10) };
  }

  // 策略3: QQ HTML 页面中的未读计数标记
  // QQ 的收件箱页面使用特定 class/attr 来显示未读数
  // 例如: class="MuiFolderName__unread" 或 data-unread="5"
  const htmlUnreadPatterns = [
    /data-unread=["'](\d+)["']/i,
    /class=["'][^"']*unread[^"']*["'][^>]*>\s*(\d+)\s*</i,
    /class=["'][^"']*count[^"']*["'][^>]*>\s*(\d+)\s*</i,
    />(\d+)\s*<\/[^>]+>\s*<[^>]+>\s*收件箱/i,
  ];

  for (const pattern of htmlUnreadPatterns) {
    const htmlMatch = text.match(pattern);
    if (htmlMatch) {
      return { hasResult: true, unreadCount: parseInt(htmlMatch[1], 10) };
    }
  }

  // 策略4: 查找 QQ 特有的 "收件箱(5)" 格式
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
