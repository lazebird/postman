/**
 * session-diagnose.js - 会话 Cookie 诊断模块
 *
 * 目标：用「数据」而非「猜测」判定方案 B 是否可行。
 *
 * 关键判断依据：
 *   MV3 Service Worker 的跨源 fetch 属于第三方上下文。只有当目标站登录 Cookie
 *   满足以下条件时，SW fetch(credentials:'include') 才会附带它们：
 *     - SameSite=None 且 Secure（可跨站发送），或
 *     - Chrome 把扩展请求视作 first-party（chrome.cookies + host_permissions 下，
 *       从扩展页面/背景页发出的请求在 cookie 属性层面通常被视为 first-party）
 *
 * 但 163/QQ 的登录 Cookie 若为 SameSite=Lax（默认），在「浏览器未打开该站页面」时
 * 跨站背景请求是带不上这些 Cookie 的——这正是前 4 轮在 SW 里怎么都拿不到登录态的原因。
 *
 * 本诊断通过 chrome.cookies.getAll 输出扩展可见的目标站 Cookie 及其 SameSite/Secure/HttpOnly
 * 标志，一次性判断「SW 是否真能复用浏览器登录会话」。
 */

import { createLogger } from './debug.js';

const logger = createLogger('session-diagnose');

/**
 * 目标站的 Cookie 域名
 */
const COOKIE_DOMAINS = {
  netease_163: ['.163.com', 'mail.163.com', '.mail.163.com'],
  qq: ['.qq.com', 'mail.qq.com', '.mail.qq.com'],
};

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

  // 收集域名下的全部 Cookie
  const seen = new Set();
  for (const domain of domains) {
    try {
      const cookies = await chrome.cookies.getAll({ domain });
      for (const c of cookies || []) {
        const key = `${c.domain}|${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allCookies.push(c);
      }
    } catch (e) {
      logger.error(`读取 ${domain} Cookie 失败: ${e.message}`);
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
    sameSite: c.sameSite,          // 'no_restriction'|'lax'|'strict'|'unspecified'
    valueLen: (c.value || '').length,
  }));

  // 判断是否存在「登录会话」级 Cookie（名称特征 + 长度）
  const authHints = ['SESS', 'sk', 'sid', 'session', 'P_INFO', 'NTES', 'login', 'S_INFO', 'UT_LOGIN', 'MAIL', 'qm_sk', 'eudb'];
  const likelyAuth = allCookies.filter((c) => {
    const name = c.name.toUpperCase();
    return authHints.some((h) => name.includes(h.toUpperCase()));
  });

  result.authCookies = likelyAuth.map((c) => ({
    name: c.name,
    domain: c.domain,
    sameSite: c.sameSite,
    secure: c.secure,
    httpOnly: c.httpOnly,
    valueLen: (c.value || '').length,
  }));

  // 核心结论判定
  // 场景A：能看到 auth cookie 且为 no_restriction（SameSite=None）→ SW 大概率可行
  // 场景B：能看到 auth cookie 但 sameSite 是 lax/strict → SW 跨站请求带不上 → 方案B基本不可行
  // 场景C：完全看不到任何 auth cookie → 浏览器没有该站登录会话，或 cookie 为 host-only 未匹配
  const crossSiteOk = likelyAuth.some((c) => c.sameSite === 'no_restriction' && c.secure);
  const onlyLax = likelyAuth.length > 0 && likelyAuth.every((c) => c.sameSite !== 'no_restriction');
  const noAuth = likelyAuth.length === 0;

  if (crossSiteOk) {
    result.conclusion = 'SW_CAN_ATTACH_COOKIES';
    result.summary = '存在 SameSite=None(no_restriction)+Secure 的登录 Cookie，SW 跨源 fetch 大概率能带上登录态。方案 B 可行性较高。';
  } else if (onlyLax) {
    result.conclusion = 'SW_CANNOT_ATTACH_COOKIES';
    result.summary = `检测到 ${likelyAuth.length} 个登录相关 Cookie，但均为 SameSite=Lax/Strict。浏览器未打开该站页面时，SW 的第三方跨源请求不会附带这些 Cookie → 方案 B 在纯 SW 场景下不可行，需改用内容脚本(方案C)。`;
  } else if (noAuth) {
    result.conclusion = 'NO_AUTH_COOKIE_VISIBLE';
    result.summary = `在扩展可见范围内未发现该站的登录会话 Cookie（共 ${allCookies.length} 个常规 Cookie）。可能原因：① 浏览器当前确实未登录该邮箱；② Cookie 被设为主机私有/隔离（CHIPS），扩展无法直接读取。请在已登录的浏览器标签里刷新一次邮箱页再诊断。`;
  }

  logger.info(`Cookie 诊断完成 [${provider}]: ${result.conclusion}`, {
    found: result.found,
    authCount: likelyAuth.length,
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
