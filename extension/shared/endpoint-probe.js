/**
 * endpoint-probe.js - 邮箱接口探测的通用请求层（消除 provider 间重复）
 *
 * 背景：
 *   provider-163 / provider-qq / provider-ustc 三个模块中，单端点请求执行
 *   （sid 占位符替换 → headers 构建 → POST body 处理 → fetch → 认证分析 →
 *   未读解析 → 结果汇总）逻辑几乎完全相同，三个文件各自重复约 150+ 行。
 *   仅因提供商差异而不同：
 *     1. 响应解码（QQ 需 GB18030 TextDecoder）
 *     2. 认证拦截判定（各站登录特征不同）
 *     3. 未读计数的响应解析（163/USTC Coremail 风格，QQ 自研）
 *     4. 认证失败时的 sid 清理策略（QQ 仅 wx 域清理）
 *
 * 本模块将这些共同逻辑收敛为单一实现，provider 只需提供差异化的回调。
 */

import { createLogger } from './debug.js';
import { DEBUG_FEATURE } from './constants.js';
import { headersToObject, fetchWithTimeout } from './session.js';
import { getSidRecord } from './session-cache.js';
import { getApiPatterns, patternsToProbeEndpoints } from './api-patterns.js';

const logger = createLogger('endpoint-probe');

/**
 * 将 URL 中的 {sid} 占位符替换为实际值。
 * 若无 sid，同时清理占位符与空参数。
 *
 * @param {string} url 模板 URL
 * @param {string|null} sid 实际的 sid 值
 * @returns {string} 处理后的 URL
 */
export function applySidToUrl(url, sid) {
  if (!url) return url;
  try {
    if (sid && url.includes('{sid}')) {
      url = url.replace(/\{sid\}/g, sid);
    }
    // 无 sid 时清理残留占位符与空参数
    if (!sid) {
      url = url.replace(/[?&]sid=\{sid\}/g, '');
      url = url.replace(/\{sid\}/g, '');
      url = url.replace(/[?&]sid=$/g, '');
      url = url.replace(/&sid=$/g, '');
      url = url.replace(/\?sid=$/g, '');
    }
    // 已有 sid 但 URL 中没有 sid 参数时补充
    if (sid && !url.includes('sid=') && !url.match(/[?&]sid=[a-zA-Z0-9]/)) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}sid=${encodeURIComponent(sid)}`;
    }
  } catch {
    // URL 解析异常时的兜底
    if (sid) {
      url = url.replace(/\{sid\}/g, sid);
    } else {
      url = url.replace(/[?&]sid=\{sid\}/g, '');
      url = url.replace(/\{sid\}/g, '');
    }
  }
  return url;
}

/**
 * 替换 headers 中的 {sid} 占位符。无 sid 时删除含 {sid} 的 header。
 *
 * @param {Object} headers 原始 headers
 * @param {string|null} sid sid 值
 * @returns {Object} 处理后的 headers（新对象）
 */
export function applySidToHeaders(headers, sid) {
  if (!headers || typeof headers !== 'object') return {};
  const result = { ...headers };
  for (const [key, value] of Object.entries(result)) {
    if (sid) {
      result[key] = String(value).replace(/\{sid\}/g, sid);
    } else if (String(value).includes('{sid}')) {
      delete result[key];
    }
  }
  return result;
}

/**
 * 递归查找对象中的未读计数字段（多个 provider 共用）。
 *
 * 兼容的字段形态：
 *   - 数值类型：{ unread: 5 }
 *   - 数字字符串：{ unread: "5" }
 *   - 字符串内含模式：data.var = 'unread=5'（Coremail 编码格式）
 *
 * @param {Object|Array} data 要搜索的对象/数组
 * @param {Array<string>} unreadKeys 要匹配的字段名列表
 * @param {number} depth 当前递归深度
 * @returns {number|null}
 */
export function findUnreadCount(data, unreadKeys, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return null;

  // 1. 直接匹配已知 key
  for (const key of unreadKeys) {
    const val = data[key];
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && /^\d+$/.test(val)) return parseInt(val, 10);
  }

  // 2. Coremail 特殊格式：data.var 为含 unread=N 的字符串
  if (data.var && typeof data.var === 'string') {
    const varMatch = data.var.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
    if (varMatch) return parseInt(varMatch[1], 10);
  }

  // 3. 数组递归
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findUnreadCount(item, unreadKeys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  // 4. 对象递归
  for (const key of Object.keys(data)) {
    const val = data[key];
    if (val && typeof val === 'object') {
      const found = findUnreadCount(val, unreadKeys, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

/**
 * 探测单个邮箱接口端点（通用实现）。
 *
 * @param {Object} endpoint 端点配置（PROVIDER_CONFIG 或捕获模式）
 * @param {string|null} sid 缓存的 sid（可为 null）
 * @param {Object} opts
 * @param {string} opts.loggerPrefix 日志前缀（如 '163'）
 * @param {Function} [opts.analyzeAuth] (text, httpStatus, finalUrl) => {authBlocked, reason}
 *        认证拦截判定。缺省按 HTTP 401/403 判定。
 * @param {Function} [opts.parseResponse] (text) => {hasResult, unreadCount}
 *        未读计数解析器。缺省返回 hasResult=false。
 * @param {Function} [opts.decodeResponse] (response) => Promise<string>
 *        响应解码器（如 QQ 需 GB18030）。缺省用 response.text()。
 * @param {Function} [opts.onAuthBlocked] (url, reason) => Promise<void>|void
 *        认证失败副作用（如按域条件清除 sid）。可 async。
 * @param {Function} [opts.defaultHeaders] () => Object
 *        非捕获模式下附加的默认 headers（如 QQ 的 Accept 列表）。
 * @returns {Promise<Object>} 统一的探测结果对象
 */
export async function probeSingleEndpoint(endpoint, sid, opts = {}) {
  const epName = endpoint?.name || 'unknown';
  const loggerEp = createLogger(`${opts.loggerPrefix || 'provider'}:${epName}`);
  loggerEp.info(`探测接口 ${epName}${sid ? '' : '（无 sid，仅依赖 Cookie）'}`);

  const startTime = performance.now();

  try {
    // ---- 构造 URL ----
    const url = applySidToUrl(endpoint?.url || '', sid);

    // ---- requiresSid 守卫：无 sid 时跳过需 sid 的接口 ----
    // 目的：避免在 sid 过期/缺失时对服务器发起注定失败的请求（表现为
    // "Failed to fetch" 等网络层异常），改为明确标记 needsSid 供上层引导。
    // 注意：captured 模式（页面真实捕获回放）与部分 Cookie 鉴权接口
    // 即便无 sid 也可能成功，因此仅对 `requiresSid && !sid` 的内置端点跳过。
    if (endpoint?.requiresSid && !sid && !endpoint?.captured) {
      const elapsedSkip = Math.round(performance.now() - startTime);
      loggerEp.warn(`接口 ${epName} 需要 sid 但无可用 sid，跳过探测`);
      return {
        endpointName: epName,
        url,
        success: false,
        skippedNoSid: true,
        authBlocked: false,
        httpStatus: 0,
        elapsedMs: elapsedSkip,
        error: 'requires sid but no sid available',
        errorName: 'SkipNoSid',
        needsSid: true,
        sidUsed: false,
      };
    }

    // ---- 构建 fetch options ----
    const fetchOptions = {
      method: endpoint?.method || 'GET',
      credentials: 'include',
      redirect: 'follow',
    };

    // headers：捕获模式直接用捕获的 headers；否则叠加默认 + 端点 headers
    let headers = {};
    if (endpoint?.captured && endpoint.headers && typeof endpoint.headers === 'object') {
      headers = { ...endpoint.headers };
    } else {
      headers = {
        ...(opts.defaultHeaders ? opts.defaultHeaders() : {}),
        ...(endpoint?.headers || {}),
      };
    }
    fetchOptions.headers = applySidToHeaders(headers, sid);

    // POST body
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    if (method === 'POST' && endpoint?.bodyTemplate) {
      let body = endpoint.bodyTemplate.replace(/\{sid\}/g, sid || '');
      // 仅 URL 编码 key=value 中 value 部分，保留表单键值分隔符 `=`。
      // 此前对整个 body（含 var= 前缀）整体 encodeURIComponent 会把 `=`
      // 也编码为 %3D，导致服务器无法按 key=value 表单解析请求体，
      // 可能表现为请求异常（Failed to fetch）。
      if (endpoint.isUrlEncoded) {
        const eqIdx = body.indexOf('=');
        if (eqIdx > 0) {
          const key = body.slice(0, eqIdx);
          const rawVal = body.slice(eqIdx + 1);
          body = `${key}=${encodeURIComponent(rawVal)}`;
        } else {
          body = encodeURIComponent(body);
        }
      }
      fetchOptions.body = body;
      loggerEp.debug(`POST body: ${body.substring(0, 300)}`);
    }

    // ---- 发起请求 ----
    loggerEp.debug(`发起请求 ${method} ${url}`);
    const response = await fetchWithTimeout(url, fetchOptions);
    const elapsed = Math.round(performance.now() - startTime);
    loggerEp.info(
      `收到响应: status=${response.status}, 耗时=${elapsed}ms${response.url ? `, finalUrl=${response.url}` : ''}`
    );

    // ---- 解码响应文本 ----
    const text = opts.decodeResponse ? await opts.decodeResponse(response) : await response.text();
    const preview =
      text.length > DEBUG_FEATURE.maxResponsePreviewBytes
        ? text.substring(0, DEBUG_FEATURE.maxResponsePreviewBytes)
        : text;

    // ---- 认证分析 ----
    const authInfo = opts.analyzeAuth
      ? opts.analyzeAuth(text, response.status, response.url)
      : { authBlocked: response.status === 401 || response.status === 403, reason: null };

    if (authInfo.authBlocked && opts.onAuthBlocked) {
      try {
        await opts.onAuthBlocked(url, authInfo.reason);
      } catch (e) {
        loggerEp.warn(`auth-blocked 回调异常: ${e.message}`);
      }
    }

    // ---- 解析未读数 ----
    const parseResult = opts.parseResponse
      ? opts.parseResponse(text)
      : { hasResult: false, unreadCount: null };

    const result = {
      endpointName: epName,
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
      loggerEp.info(`接口 ${epName} 探测成功: unreadCount=${parseResult.unreadCount}`);
    } else if (result.authBlocked) {
      loggerEp.warn(`接口 ${epName} 被认证层拦截: ${authInfo.reason}`, {
        status: response.status,
        preview: preview.substring(0, 500),
      });
    } else {
      loggerEp.warn(`接口 ${epName} 返回但未能解析未读数`, {
        status: response.status,
        contentType: result.responseContentType,
        preview: preview.substring(0, 500),
        sidUsed: !!sid,
      });
    }

    return result;
  } catch (err) {
    const elapsed = Math.round(performance.now() - startTime);
    loggerEp.error(`接口 ${epName} 请求异常: ${err.message}`);

    return {
      endpointName: epName,
      url: endpoint?.url || '',
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
 * 从 storage 读取某 provider 的缓存 sid + 捕获的 API 模式，
 * 构建最终要探测的端点列表（捕获模式优先）。
 *
 * @param {string} provider 提供商标识
 * @param {Array} configuredEndpoints 内置端点列表
 * @param {Array<string>} endpointNames 用户启用的端点名（空则全部）
 * @returns {Promise<Object>} { sid, sidSource, capturedCount, endpoints }
 */
export async function loadProbeContext(provider, configuredEndpoints, endpointNames) {
  const cachedSid = await getSidRecord(provider);
  const { sid, source: sidSource } = cachedSid;

  let endpoints = endpointNames?.length
    ? configuredEndpoints.filter((ep) => endpointNames.includes(ep.name))
    : [...configuredEndpoints];

  if (!endpoints.length) {
    logger.warn(`[${provider}] 没有匹配的探测接口，回退到全部接口`);
    endpoints = [...configuredEndpoints];
  }

  const capturedPatterns = await getApiPatterns(provider);
  let capturedEndpoints = [];
  if (capturedPatterns.length > 0) {
    capturedEndpoints = patternsToProbeEndpoints(capturedPatterns);
    logger.info(`[${provider}] 发现 ${capturedPatterns.length} 条捕获的 API 模式`);
  }

  return {
    sid,
    sidSource: sidSource || 'none',
    capturedCount: capturedEndpoints.length,
    endpoints: [...capturedEndpoints, ...endpoints],
  };
}
