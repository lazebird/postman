/**
 * session.js - 会话管理模块
 *
 * 负责获取和缓存各邮箱提供商（163/QQ）的会话令牌（sid），
 * 供 provider 探测接口使用。
 *
 * 163 邮箱：
 *   - 登录态下访问 /js6/main.jsp 页面会携带/重定向到含 sid 的 URL
 *   - 从 response.url 或页面内容中提取 sid
 *
 * QQ 邮箱：
 *   - 登录态下访问 /cgi-bin/login?fun=passport 会重定向到含 sid 的 URL
 *   - 从 response.url 或页面内容中提取 sid
 */

import { createLogger } from './debug.js';
import { PROVIDER_CONFIG, SESSION_KEYS, PROVIDERS } from './constants.js';

const logger = createLogger('session');

// sid 在存储中的最大缓存时间（分钟）
const SID_CACHE_TTL_MINUTES = 30;

/**
 * 将 Headers 对象转为普通对象（便于序列化/日志）
 */
export function headersToObject(headers) {
  if (!headers) return {};
  const obj = {};
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      obj[key] = value;
    });
  }
  return obj;
}

/**
 * 从 URL 中提取 sid
 */
export function extractSidFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const sid = parsed.searchParams.get('sid');
    if (sid && sid.length > 4) return sid;
  } catch (e) {
    // URL 解析失败，尝试正则
  }
  // 兜底：从 URL 字符串中提取 sid
  const match = url.match(/[?&]sid=([^&]+)/);
  return match ? match[1] : null;
}

/**
 * 从页面内容中提取 sid（多种模式）
 */
export function extractSidFromContent(text) {
  if (!text) return null;

  // 模式1：URL 形式的 sid=xxx
  let m = text.match(/sid["']?\s*[:=]\s*["']?([a-zA-Z0-9_\-]{6,})["']?/i);
  if (m) return m[1];

  // 模式2：window 变量中的 sid
  m = text.match(/window\.sid\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1];

  // 模式3：JS 变量 sid = "xxx"
  m = text.match(/var\s+sid\s*=\s*["']([a-zA-Z0-9_\-]{6,})["']/i);
  if (m) return m[1];

  // 模式4：URL 中 /sid/xxx/
  m = text.match(/sid[\/=]([a-zA-Z0-9_\-]{6,})/i);
  if (m) return m[1];

  return null;
}

/**
 * 读取缓存的 sid
 */
async function getCachedSid(sessionKey) {
  const { [sessionKey]: sid } = await chrome.storage.session.get(sessionKey);
  if (!sid) return null;

  // 检查过期
  const expiryKey = `${sessionKey}_expiry`;
  const { [expiryKey]: expiry } = await chrome.storage.session.get(expiryKey);
  if (expiry && Date.now() > expiry) {
    logger.debug(`缓存的 sid 已过期，需重新获取`);
    await chrome.storage.session.remove(sessionKey);
    return null;
  }

  return sid;
}

/**
 * 缓存 sid
 */
async function cacheSid(sessionKey, sid) {
  const expiryKey = `${sessionKey}_expiry`;
  await chrome.storage.session.set({
    [sessionKey]: sid,
    [expiryKey]: Date.now() + SID_CACHE_TTL_MINUTES * 60 * 1000,
  });
  logger.debug(`sid 已缓存, TTL=${SID_CACHE_TTL_MINUTES}分钟`);
}

/**
 * 清除缓存的 sid
 */
export async function clearSid(provider) {
  const sessionKey = provider === PROVIDERS.NETEASE_163 ? SESSION_KEYS.SID_163 : SESSION_KEYS.SID_QQ;
  await chrome.storage.session.remove([sessionKey, `${sessionKey}_expiry`]);
}

/**
 * 获取 163 邮箱的会话 sid
 *
 * 策略：
 * 1. 先尝试从缓存读取
 * 2. 若无缓存，访问 163 的登录后入口页面，从重定向 URL 或页面内容中提取 sid
 * 3. 提取失败则返回 null（调用方需判断是否未登录）
 *
 * @param {boolean} forceRefresh - 是否强制刷新（忽略缓存）
 * @returns {Promise<{sid: string|null, source: string, loggedIn: boolean, detail: Object}>}
 */
export async function getSid163({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getCachedSid(SESSION_KEYS.SID_163);
    if (cached) {
      return {
        sid: cached,
        source: 'cache',
        loggedIn: true,
        detail: { cached: true },
      };
    }
  }

  const config = PROVIDER_CONFIG[PROVIDERS.NETEASE_163];
  const logger163 = createLogger('session:163');

  logger163.info('尝试获取 163 会话 sid');

  // 依次尝试各入口端点
  for (const entry of config.sessionEndpoints) {
    try {
      const resp = await fetch(entry.url, {
        method: entry.method || 'GET',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          ...(entry.headers || {}),
        },
      });

      const elapsed = Date.now();
      const finalUrl = resp.url || '';
      logger163.debug(`请求入口: ${entry.url} → 最终URL: ${finalUrl}, status=${resp.status}`);

      // 尝试从最终 URL 提取 sid
      let sid = extractSidFromUrl(finalUrl);
      let source = 'url';

      // URL 中没找到，尝试从页面内容提取
      if (!sid) {
        const text = await resp.text();
        sid = extractSidFromContent(text);
        source = 'content';

        // 如果内容是登录页，说明未登录
        // 登录页特征：包含用户名/密码表单元素 或 163 登录专用页面标记
        const isLoginPage = text.includes('loginFrame') ||
                            text.includes('fm-login') ||
                            text.includes('login-form') ||
                            text.includes('j-inputtext') ||
                            text.includes('登录后可使用') ||
                            text.includes('请输入账号') ||
                            text.includes('请输入密码') ||
                            text.includes('未登录') ||
                            text.includes('not-login') ||
                            text.includes('login.jsp');
        if (!sid && isLoginPage) {
          logger163.warn('163 会话获取失败：返回了登录页面，Cookie 未生效或未登录');
          return {
            sid: null,
            source: 'none',
            loggedIn: false,
            detail: {
              entry: entry.name,
              httpStatus: resp.status,
              finalUrl: finalUrl.substring(0, 200),
              responsePreview: text.substring(0, 500),
            },
          };
        }
      }

      if (sid) {
        logger163.info(`成功获取 163 sid (来源: ${source})`);
        await cacheSid(SESSION_KEYS.SID_163, sid);
        return {
          sid,
          source,
          loggedIn: true,
          detail: { entry: entry.name, httpStatus: resp.status },
        };
      }

      logger163.warn(`从 ${entry.name} 未能提取 sid`);
    } catch (err) {
      logger163.error(`访问 ${entry.url} 失败: ${err.message}`);
    }
  }

  logger163.warn('所有 163 会话入口均未获得 sid');
  return {
    sid: null,
    source: 'none',
    loggedIn: false,
    detail: { message: 'Failed to obtain sid from all session endpoints' },
  };
}

/**
 * 获取 QQ 邮箱的会话 sid
 *
 * @param {boolean} forceRefresh - 是否强制刷新
 * @returns {Promise<{sid: string|null, source: string, loggedIn: boolean, detail: Object}>}
 */
export async function getSidQQ({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = await getCachedSid(SESSION_KEYS.SID_QQ);
    if (cached) {
      return {
        sid: cached,
        source: 'cache',
        loggedIn: true,
        detail: { cached: true },
      };
    }
  }

  const config = PROVIDER_CONFIG[PROVIDERS.QQ];
  const loggerQQ = createLogger('session:qq');

  loggerQQ.info('尝试获取 QQ 会话 sid');

  for (const entry of config.sessionEndpoints) {
    try {
      const resp = await fetch(entry.url, {
        method: entry.method || 'GET',
        credentials: 'include',
        redirect: 'follow',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...(entry.headers || {}),
        },
      });

      const finalUrl = resp.url || '';
      loggerQQ.debug(`请求入口: ${entry.url} → 最终URL: ${finalUrl}, status=${resp.status}`);

      // 尝试从最终 URL 提取 sid
      let sid = extractSidFromUrl(finalUrl);
      let source = 'url';

      if (!sid) {
        // 尝试从重定向链中的 Location 头获取 sid
        const location = resp.headers?.get?.('Location');
        if (location) {
          sid = extractSidFromUrl(location);
          source = 'location-header';
        }
      }

      if (!sid) {
        const text = await resp.text();
        sid = extractSidFromContent(text);
        source = 'content';

        // QQ 登录页特征：包含 gbIsNoCheck 或 loginFrame
        if (!sid && (text.includes('gbIsNoCheck') || text.includes('loginForm'))) {
          loggerQQ.warn('QQ 会话获取失败：返回了登录页面，Cookie 未生效或未登录');
          return {
            sid: null,
            source: 'none',
            loggedIn: false,
            detail: {
              entry: entry.name,
              httpStatus: resp.status,
              finalUrl: finalUrl.substring(0, 200),
              responsePreview: text.substring(0, 500),
            },
          };
        }
      }

      if (sid) {
        loggerQQ.info(`成功获取 QQ sid (来源: ${source})`);
        await cacheSid(SESSION_KEYS.SID_QQ, sid);
        return {
          sid,
          source,
          loggedIn: true,
          detail: { entry: entry.name, httpStatus: resp.status },
        };
      }

      loggerQQ.warn(`从 ${entry.name} 未能提取 sid`);
    } catch (err) {
      loggerQQ.error(`访问 ${entry.url} 失败: ${err.message}`);
    }
  }

  loggerQQ.warn('所有 QQ 会话入口均未获得 sid');
  return {
    sid: null,
    source: 'none',
    loggedIn: false,
    detail: { message: 'Failed to obtain sid from all session endpoints' },
  };
}

/**
 * 通用：获取指定提供商的 sid
 */
export async function getProviderSid(provider, options = {}) {
  if (provider === PROVIDERS.NETEASE_163) return getSid163(options);
  if (provider === PROVIDERS.QQ) return getSidQQ(options);
  return { sid: null, source: 'unsupported', loggedIn: false, detail: {} };
}

/**
 * 将 URL 中的 {sid} 占位符替换为实际值
 */
export function replaceSidInUrl(url, sid) {
  if (!url) return url;
  if (!sid) return url;
  return url.replace(/\{sid\}/g, sid);
}
