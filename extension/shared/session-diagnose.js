/**
 * session-diagnose.js - 会话 Cookie 诊断模块
 *
 * 目标：用「数据」判定 MV3 SW 是否能在跨源 fetch 中复用浏览器登录 Cookie。
 *
 * Chrome MV3 扩展机制说明：
 *   扩展声明了 host_permissions 后，从 SW / 扩展页面发出的对该源的 fetch
 *   在 Cookie 属性层面通常被视为 first-party（扩展是 "privileged context"）。
 *   因此 SameSite=Lax 的 Cookie 在这些请求中应当被附带。
 *
 * 本诊断输出 Cookie 的 SameSite 标志，用于判断是否有跨站发送的能力。
 * 注意：诊断仅反映 Cookie 属性，实际是否生效需通过接口响应验证。
 */

import { createLogger } from './debug.js';

const logger = createLogger('session-diagnose');

/**
 * 目标站的 Cookie 域名（限定到具体邮箱服务域名，避免误抓无关子域）
 */
const COOKIE_DOMAINS = {
  netease_163: ['.163.com', '.mail.163.com'],
  qq: ['.qq.com', '.mail.qq.com', '.wx.mail.qq.com'],
};

// 通过邮箱首页 URL 直接读取 Cookie（能拿到 host-only 于 mail.qq.com 等子域的会话 Cookie）
const COOKIE_URLS = {
  netease_163: ['https://mail.163.com/', 'https://www.163.com/'],
  qq: ['https://mail.qq.com/', 'https://mail.qq.com/cgi-bin/login', 'https://wx.mail.qq.com/'],
};

/**
 * 各提供商的「真实登录会话」Cookie 名称特征
 * 只将高置信度的会话 Cookie 视为 auth cookie
 */
const AUTH_COOKIE_PATTERNS = {
  netease_163: [
    // 网易通行证登录 Cookie
    { name: 'NTES_SESS', domains: ['.163.com'] },
    // 163 邮箱独立会话
    { name: 'MAIL_SESS', domains: ['.mail.163.com'] },
    { name: 'MAIL_PASSPORT', domains: ['.mail.163.com'] },
    { name: 'Coremail', domains: ['.mail.163.com'] },
    { name: 'mixmailTokens', domains: ['.mail.163.com'] },
    { name: 'NTES_P_UTID', domains: ['.163.com'] },
  ],
  qq: [
    // QQ 邮箱真实会话 Cookie
    { name: 'qm_sk', domains: ['mail.qq.com', 'wx.mail.qq.com'] },
    { name: 'qm_ssum', domains: ['mail.qq.com', 'wx.mail.qq.com'] },
    { name: 'skey', domains: ['mail.qq.com', 'wx.mail.qq.com', '.qq.com'] },
    { name: 'wx_mail_sk', domains: ['wx.mail.qq.com'] },
    { name: 'wx_mail_sid', domains: ['wx.mail.qq.com'] },
    // QQ 通行证登录 Cookie
    { name: 'p_skey', domains: ['.qq.com'] },
    { name: 'p_uin', domains: ['.qq.com'] },
    { name: 'pt2gguin', domains: ['.qq.com'] },
    { name: 'uin', domains: ['.qq.com'] },
    // QQ 邮箱早期/备用会话 Cookie
    { name: 'qqmail', domains: ['.qq.com', 'mail.qq.com', 'wx.mail.qq.com'] },
  ],
};

/**
 * 判断 Cookie 是否属于指定提供商的「高置信度 auth cookie」
 */
function isAuthCookie(provider, cookie) {
  const patterns = AUTH_COOKIE_PATTERNS[provider] || [];
  const domain = cookie.domain || '';
  const name = cookie.name || '';

  for (const pattern of patterns) {
    if (name !== pattern.name) continue;
    // 域名匹配：检查 cookie.domain 是否以 pattern.domain 结尾（或相等）
    for (const patternDomain of pattern.domains) {
      const pd = patternDomain.startsWith('.') ? patternDomain : `.${patternDomain}`;
      if (domain === patternDomain || domain.endsWith(pd)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 读取指定提供商域下的所有 Cookie，并判断能否在 SW 跨源 fetch 中附带。
 */
export async function diagnoseCookies(provider) {
  const domains = COOKIE_DOMAINS[provider] || [];
  const allCookies = [];
  const result = { provider, checkedAt: new Date().toISOString(), found: 0 };

  if (!chrome.cookies || typeof chrome.cookies.getAll !== 'function') {
    result.error = '缺少 cookies 权限，请在 manifest 中添加 "cookies" 权限后重新加载扩展。';
    logger.error('diagnoseCookies', result.error);
    return result;
  }

  // 收集域名下的全部 Cookie（含通过邮箱首页 URL 读取的 host-only 子域 Cookie）
  const seen = new Set();
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const c of cookies || []) {
        const key = `${c.domain}|${c.name}|${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCookies.push(c);
      }
    } catch (e) {
      logger.error(`读取 ${domain} Cookie 失败: ${e.message}`);
    }
  }
  for (const url of COOKIE_URLS[provider] || []) {
    try {
      const cookies = await chrome.cookies.getAll({ url });
      for (const c of cookies || []) {
        const key = `${c.domain}|${c.name}|${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCookies.push(c);
      }
    } catch (e) {
      logger.error(`读取 ${url} Cookie 失败: ${e.message}`);
    }
  }

  result.found = allCookies.length;
  result.cookies = allCookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    session: c.session,
    sameSite: c.sameSite,
    valueLen: (c.value || '').length,
  }));

  // 高置信度 auth cookie
  const authCookies = allCookies.filter((c) => isAuthCookie(provider, c));
  result.authCookies = authCookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    sameSite: c.sameSite,
    secure: c.secure,
    httpOnly: c.httpOnly,
    valueLen: (c.value || '').length,
  }));

  // ===== 核心结论判定 =====
  // 在 Chrome MV3 中，扩展具有 host_permissions 时，SW fetch 被视为 first-party 请求
  // SameSite=Lax 的 Cookie 应当被附带
  // 因此只要有 auth cookie（不管 SameSite 是什么），SW 理论上有机会带上

  if (authCookies.length === 0) {
    result.conclusion = 'NO_AUTH_COOKIE_VISIBLE';
    result.summary =
      '未发现该站的高置信度登录会话 Cookie。可能原因：① 浏览器当前确实未登录该邮箱；② Cookie 被隔离或主机私有。请先在浏览器中打开并登录邮箱页面，然后刷新扩展再诊断。';
  } else {
    // 记录所有 auth cookie 的 SameSite 分布
    const sameSiteSet = new Set(authCookies.map((c) => c.sameSite));
    const hasNone = authCookies.some((c) => c.sameSite === 'no_restriction' && c.secure);
    const hasLax = authCookies.some((c) => c.sameSite === 'lax' || c.sameSite === 'unspecified');

    if (hasNone) {
      result.conclusion = 'SW_CAN_ATTACH_COOKIES';
      result.summary = `检测到 ${authCookies.length} 个登录 Cookie，其中包含 SameSite=None 的 Cookie。在 MV3 扩展 host_permissions 下，SW 跨源 fetch 大概率能携带登录态。`;
    } else if (hasLax) {
      // MV3 扩展 + host_permissions → first-party context → Lax cookies 也应附带
      result.conclusion = 'SW_MAY_ATTACH_COOKIES';
      result.summary = `检测到 ${authCookies.length} 个登录 Cookie，SameSite=${[...sameSiteSet].join('/')}。在 MV3 扩展的 host_permissions 特权上下文中，SameSite=Lax Cookie 通常会被当作 first-party 附带。需通过实际 API 调用验证。`;
    } else {
      result.conclusion = 'SW_MIGHT_ATTACH_COOKIES';
      result.summary = `检测到 ${authCookies.length} 个登录 Cookie，SameSite=${[...sameSiteSet].join('/')}。SameSite=Strict 的 Cookie 在跨站请求中通常不会被附带。`;
    }
  }

  logger.info(`Cookie 诊断完成 [${provider}]: ${result.conclusion}`, {
    found: result.found,
    authCount: authCookies.length,
  });

  return result;
}

/**
 * 诊断所有已配置提供商
 */
export async function diagnoseAll() {
  const out = {};
  for (const p of Object.keys(COOKIE_DOMAINS)) {
    out[p] = await diagnoseCookies(p);
  }
  return out;
}
