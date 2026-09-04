/**
 * provider-qq.js - QQ邮箱未读接口探测实现
 *
 * v0.8.0 全面重写：
 *   1. 同时探测 mail.qq.com（旧接口）和 wx.mail.qq.com（新网页版）
 *   2. 从 chrome.storage.local 读取缓存 sid
 *   3. 支持 API pattern 捕获回放（captured patterns 优先）
 *   4. 改进响应解析（QQ 新旧版响应格式差异大）
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG, DEBUG_FEATURE } from '../shared/constants.js';
import { headersToObject, fetchWithTimeout } from '../shared/session.js';
import { getSidRecord, clearSid } from '../shared/session-cache.js';
import { getApiPatterns, patternsToProbeEndpoints } from '../shared/api-patterns.js';

const logger = createLogger('provider-qq');

/**
 * 探测 QQ 邮箱未读接口
 */
export async function probeQQ(options = {}) {
  const config = PROVIDER_CONFIG['qq'];

  const cachedSid = await getSidRecord('qq');
  const { sid, source: sidSource } = cachedSid;

  let endpoints = options.endpointNames?.length
    ? config.probeEndpoints.filter((ep) => options.endpointNames.includes(ep.name))
    : config.probeEndpoints;

  if (!endpoints.length) {
    logger.warn('没有匹配的探测接口，回退到全部接口');
    endpoints = config.probeEndpoints;
  }

  // 加入捕获的 API 模式（如果有），优先执行
  const capturedPatterns = await getApiPatterns('qq');
  let capturedEndpoints = [];
  if (capturedPatterns.length > 0) {
    capturedEndpoints = patternsToProbeEndpoints(capturedPatterns);
    logger.info(`发现 ${capturedPatterns.length} 条捕获的 QQ API 模式`);
  }

  // 组合：先试捕获的真实模式，再试内置候选接口
  const allEndpoints = [...capturedEndpoints, ...endpoints];

  logger.info('开始探测QQ邮箱未读接口', {
    endpoints: allEndpoints.map((e) => e.name),
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
      // 成功即停止（不需要继续探测其他接口）
      break;
    }
    if (result.error) lastError = result.error;
  }

  const allFailed = results.length > 0 && results.every((r) => !r.success);
  const authBlocked = results.some((r) => r.authBlocked);
  const needsSid = !sid && (allFailed || authBlocked);

  const summary = {
    provider: 'qq',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded && !needsSid,
    allFailed,
    needsSid,
    session: {
      sidObtained: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      loggedIn: anySucceeded || sid !== null,
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
 * 探测单个 QQ 接口端点
 */
async function probeSingleEndpoint(endpoint, sid, options) {
  const logger_ep = createLogger(`qq:${endpoint.name}`);
  logger_ep.info(`探测接口 ${endpoint.name}${sid ? '' : '（无 sid，仅依赖 Cookie）'}`);

  const startTime = performance.now();

  try {
    // 构造 URL：优先使用字符串替换 sid（避免 URL.searchParams 编码问题）
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
    } catch {
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

    // 构建 headers：如果端点是捕获的真实模式，使用捕获的 headers
    let headers = {};
    if (endpoint.captured && endpoint.headers && typeof endpoint.headers === 'object') {
      headers = { ...endpoint.headers };
    } else {
      headers = {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(endpoint.headers || {}),
      };
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
        // 如果端点标记为 URL 编码，则对 body 进行编码
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
    logger_ep.info(
      `收到响应: status=${response.status}, 耗时=${elapsed}ms, finalUrl=${response.url}`
    );

    // 解码响应（QQ 使用 GB18030）
    const text = await decodeResponse(response);
    const preview =
      text.length > DEBUG_FEATURE.maxResponsePreviewBytes
        ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
        : text;

    const authInfo = analyzeQQAuth(text, response.status, response.url);

    if (authInfo.authBlocked) {
      // 仅当请求目标为 wx.mail.qq.com（当前实际会话域）时才清除 sid。
      // mail.qq.com 旧接口因 cookie 域不匹配总会报未登录，sid 在 wx.mail.qq.com 上仍有效，
      // 不应因旧域接口失败而误删有效 sid。
      const isWxDomain = /wx\.mail\.qq\.com/i.test(url);
      if (isWxDomain) {
        logger_ep.warn('QQ 会话已失效或未登录，清除缓存 sid');
        try {
          await clearSid('qq');
        } catch {}
      } else {
        logger_ep.debug(
          'mail.qq.com 域接口认证失败（sid 可能仍适用于 wx.mail.qq.com），不清除 sid'
        );
      }
    }

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
      preview: preview.substring(0, 500),
      responseHeaders: headersToObject(response.headers),
      sidUsed: !!sid,
      needsSid: !sid && authInfo.authBlocked,
    };

    if (result.success) {
      logger_ep.info(`接口 ${endpoint.name} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (result.authBlocked) {
      logger_ep.warn(`接口 ${endpoint.name} 被认证层拦截: ${authInfo.reason}`, {
        status: response.status,
        finalUrl: response.url,
        preview: preview.substring(0, 500),
      });
    } else {
      logger_ep.warn(`接口 ${endpoint.name} 返回但未能解析未读数`, {
        status: response.status,
        contentType: result.responseContentType,
        finalUrl: response.url,
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
 * 解码响应内容（处理 GB18030 等非 UTF-8 编码）
 */
async function decodeResponse(response) {
  const contentType = response.headers?.get?.('content-type') || '';
  const isGB18030 =
    contentType.includes('gb18030') ||
    contentType.includes('gbk') ||
    contentType.includes('gb2312');

  try {
    const arrayBuffer = await response.arrayBuffer();
    if (isGB18030) {
      try {
        return new TextDecoder('gb18030').decode(arrayBuffer);
      } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
  } catch {
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

  if (finalUrl && (finalUrl.includes('/cgi-bin/login') || finalUrl.includes('ptlogin'))) {
    return { authBlocked: true, reason: 'Redirected to login page' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 QQ 邮箱响应的未读数
 * 支持 QQ 新旧版接口的不同响应格式
 */
function parseQQResponse(text) {
  // 策略0: QQ 新版 API 返回 unread_num 字段（真实格式）
  try {
    const data = JSON.parse(text.trim());
    if (typeof data.body === 'object' && data.body !== null) {
      const unreadNum = data.body.unread_num;
      if (typeof unreadNum === 'number' && unreadNum >= 0) {
        return { hasResult: true, unreadCount: unreadNum };
      }
    }
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {}

  // 策略1: JSON
  try {
    const data = JSON.parse(text.trim());
    const unread = findUnreadCount(data);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {}

  // 策略2: JSONP 去包裹
  try {
    const jsonpMatch = text.trim().match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      const data = JSON.parse(jsonpMatch[1]);
      const unread = findUnreadCount(data);
      if (unread !== null) {
        return { hasResult: true, unreadCount: unread };
      }
    }
  } catch {}

  // 策略3: QQ 特有格式 - "var xx = {...}" 等 JS 变量赋值格式
  const varPatterns = [
    /(?:var\s+)?(?:unread|unreadnum|unreadCount|folderCount|total)\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?(?:unreadnum|unread|unreadCount|total|count)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["'](?:unread|count)["']\s*:\s*(\d+)/i,
  ];
  for (const pattern of varPatterns) {
    const match = text.match(pattern);
    if (match) {
      const val = parseInt(match[1], 10);
      // QQ 中可能有多处 count，取与文件夹相关的值
      return { hasResult: true, unreadCount: val };
    }
  }

  // 策略4: HTML 页面中的未读计数
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

  // 策略5: QQ 收件箱页面特定格式
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

  const unreadKeys = [
    'unread',
    'unreadCount',
    'unread_count',
    'unreadnum',
    'messageCount',
    'count',
    'total',
    'newCount',
  ];
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
