/**
 * possibility-tests.js - 「所有可能性」SW 后台无标签探测测试集
 *
 * 背景：
 *   多轮实测证实：邮箱标签关闭后，扩展 SW 直接 fetch 163/QQ 内部接口
 *   一律鉴权失败（FA_UNAUTHORIZED / 登录跳转 / 404），而内容脚本在页面
 *   内（第一方 Cookie）能稳定读到未读数。怀疑根因是「浏览器未把 webmail
 *   登录 Cookie 作为 first-party 附加到 chrome-extension 源发出的跨源
 *   fetch」。
 *
 * 本模块针对该唯一不确定点，穷举所有「纯 SW、不开标签、无服务器」的
 * Cookie 附加/请求策略，逐一实测并在同一个目标接口上输出可对比的证据，
 * 以判定究竟哪条路径能真正在后台（无邮箱标签）读到未读数。
 *
 * ⚠️ 完全遵守 AGENTS 规则 1：本模块只做 SW fetch / chrome API 直调，
 *    绝不 chrome.tabs.create/update 打开任何可见或后台标签，也不常驻标签。
 *
 * 触发方式：Popup → 探测页「🧪 全可能性后台测试」。结果同时经 console
 * 与 chrome.storage.session 日志输出，可用日志页「📋 复制」取回反馈。
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';
import { fetchWithTimeout, headersToObject } from '../shared/session.js';
import { getApiPatterns, patternsToProbeEndpoints } from '../shared/api-patterns.js';

const logger = createLogger('possibility-tests');

// ============================================================
// 目标站与 Cookie 作用域
// ============================================================
// 每个测试接口最终落到这些「探测 URL」上，用真实 sid + 该站 Cookie 尝试。
// 163 用 js6/s RPC（已确认接口存在）；QQ 用 wx.mail.qq.com 的候选接口。
const PROVIDER_TARGET = {
  netease_163: {
    label: '163邮箱',
    // 优先用捕获的真实 API；无捕获时用内部候选接口
    sidKey: 'sid_163',
    cookies: { domain: '.163.com' },
    cookieUrls: ['https://mail.163.com/', 'https://www.163.com/'],
    entryDomain: 'https://mail.163.com/',
    defaultEndpoints: [
      {
        name: 'js6_sys_getfolder',
        url: 'https://mail.163.com/js6/s?func=global:getSessionInfo&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        bodyTemplate: 'var=@null',
      },
      {
        name: 'js6_rpc_list',
        url: 'https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        bodyTemplate: 'var=@{type:"listMessages",ver:0,pageSize:1,start:0,folderId:"1",mailto:"",readFlag:"2"}',
      },
    ],
  },
  qq: {
    label: 'QQ邮箱',
    sidKey: 'sid_qq',
    cookies: { domain: '.qq.com' },
    cookieUrls: ['https://mail.qq.com/', 'https://mail.qq.com/cgi-bin/login', 'https://wx.mail.qq.com/'],
    entryDomain: 'https://wx.mail.qq.com/',
    defaultEndpoints: [
      {
        name: 'wx_readdata',
        url: 'https://wx.mail.qq.com/cgi-bin/readdata?sid={sid}&t=inbox',
        method: 'GET',
        headers: { 'Referer': 'https://wx.mail.qq.com/', 'Accept': 'application/json, text/plain, */*' },
      },
      {
        name: 'wx_readindex',
        url: 'https://wx.mail.qq.com/cgi-bin/readindex?sid={sid}&t=inbox&r=0',
        method: 'GET',
        headers: { 'Referer': 'https://wx.mail.qq.com/', 'Accept': 'application/json, text/plain, */*' },
      },
      {
        name: 'wx_unread',
        url: 'https://wx.mail.qq.com/cgi-bin/unread?sid={sid}&t=inbox',
        method: 'GET',
        headers: { 'Referer': 'https://wx.mail.qq.com/', 'Accept': 'application/json, text/plain, */*' },
      },
      {
        name: 'cgi_mail_list',
        url: 'https://mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}',
        method: 'GET',
        headers: {},
      },
    ],
  },
};

/**
 * 读取指定 provider 缓存的 sid（与 service-worker 相同的键）
 */
async function getCachedSid(provider) {
  const key = PROVIDER_TARGET[provider]?.sidKey;
  if (!key) return null;
  try {
    const data = await chrome.storage.local.get([key, `${key}_expiry`]);
    if (data[key]) {
      if (data[`${key}_expiry`] && Date.now() > data[`${key}_expiry`]) return null;
      return data[key];
    }
  } catch (e) {}
  return null;
}

/**
 * 从 chrome.cookies 读取目标站全部 Cookie，拼成一个 Cookie 头字符串。
 * 覆盖：按 domain + 邮箱首页 URL（拿 host-only 子域会话 Cookie）。
 */
async function buildCookieHeader(provider) {
  const cfg = PROVIDER_TARGET[provider];
  if (!cfg) return { header: '', count: 0, names: [] };

  const collected = [];
  const seen = new Set();
  // 按 Cookie 域名
  for (const query of [{ domain: cfg.cookies.domain }, { url: cfg.entryDomain }, ...(cfg.cookieUrls||[]).map(url => ({ url }))]) {
    try {
      const cookies = query.url
        ? await chrome.cookies.getAll({ url: query.url })
        : await chrome.cookies.getAll(query);
      for (const c of cookies || []) {
        const key = `${c.domain}|${c.name}|${c.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(c);
      }
    } catch (e) {
      logger.warn(`[cookie] 读取 ${JSON.stringify(query)} 失败: ${e.message}`);
    }
  }

  // 过滤：优先取高价值会话 Cookie；全部拼入
  const names = collected.map(c => c.name);
  const header = collected
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  return { header, count: collected.length, names };
}

// ============================================================
// 测试策略（Cookie 附加方式）
// ============================================================
const STRATEGIES = [
  {
    id: 'A1',
    label: 'credentials=include（基线，现状）',
    build: async (provider) => ({ credentials: 'include' }),
  },
  {
    id: 'A2',
    label: 'credentials=include + 手动 Cookie 头(chrome.cookies 现读)',
    build: async (provider) => {
      const { header } = await buildCookieHeader(provider);
      return { credentials: 'include', extraHeaders: header ? { Cookie: header } : {} };
    },
  },
  {
    id: 'A3',
    label: 'credentials=same-origin + 手动 Cookie 头',
    build: async (provider) => {
      const { header } = await buildCookieHeader(provider);
      return { credentials: 'same-origin', extraHeaders: header ? { Cookie: header } : {} };
    },
  },
  {
    id: 'A4',
    label: 'credentials=omit + 手动 Cookie 头',
    build: async (provider) => {
      const { header } = await buildCookieHeader(provider);
      return { credentials: 'omit', extraHeaders: header ? { Cookie: header } : {} };
    },
  },
  {
    id: 'A5',
    label: '无 referer/origin 精简请求 + include',
    build: async () => ({ credentials: 'include', stripExtraHeaders: true }),
  },
  {
    id: 'D1',
    label: 'declarativeNetRequest 网图层注入 Cookie + include',
    build: async (provider) => {
      const { header } = await buildCookieHeader(provider);
      return { useDNR: true, cookieHeader: header, credentials: 'include' };
    },
  },
  {
    id: 'D2',
    label: 'declarativeNetRequest 网图层注入 Cookie + omit(仅靠DNR)',
    build: async (provider) => {
      const { header } = await buildCookieHeader(provider);
      return { useDNR: true, cookieHeader: header, credentials: 'omit' };
    },
  },
];

/**
 * 运行一次 DNR 会话规则注入 Cookie，返回规则 id 供随后清理。
 */
async function applyDnrCookieRule(cookieHeader, targetUrl) {
  const ruleId = 10001 + Math.floor(Math.random() * 500);
  if (!chrome.declarativeNetRequest) {
    return { ok: false, reason: '缺少 declarativeNetRequest 权限' };
  }
  const urlFilter = targetUrl.startsWith('https://wx.mail.qq.com')
    ? '||wx.mail.qq.com/'
    : targetUrl.startsWith('https://mail.qq.com')
      ? '||mail.qq.com/'
      : '||mail.163.com/';
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [{
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Cookie', operation: 'set', value: cookieHeader },
          ],
        },
        condition: { urlFilter, resourceTypes: ['xmlhttprequest', 'other', 'main_frame'] },
      }],
    });
    return { ok: true, ruleId };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function clearDnrRule(ruleId) {
  if (!chrome.declarativeNetRequest || !ruleId) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  } catch (e) {}
}

/**
 * 拼接请求头并替换 {sid}
 */
function buildFetchOptions(provider, endpoint, sid, strategyOpts) {
  const headers = {};
  // 端点自身 headers
  for (const [k, v] of Object.entries(endpoint.headers || {})) {
    let value = String(v);
    if (sid) value = value.replace(/\{sid\}/g, sid);
    headers[k] = value;
  }
  // 策略附加 headers（如手动 Cookie 头）
  if (strategyOpts.extraHeaders) {
    for (const [k, v] of Object.entries(strategyOpts.extraHeaders)) {
      headers[k] = v;
    }
  }
  // A5 精简时去掉 referer / origin
  if (strategyOpts.stripExtraHeaders) {
    delete headers['Referer'];
    delete headers['referer'];
    delete headers['Origin'];
    delete headers['origin'];
  }
  // 若策略显式带 cookieHeader（DNR 场景，仍需 header 里给一个，避免受限）
  if (strategyOpts.cookieHeader && strategyOpts.useDNR) {
    // DNR 会在网图层注入，这里不再往 headers 塞 Cookie，避免 forbidden 问题
  }

  const method = (endpoint.method || 'GET').toUpperCase();
  const fetchOptions = {
    method,
    credentials: strategyOpts.credentials || 'include',
    redirect: 'follow',
  };
  if (Object.keys(headers).length) fetchOptions.headers = headers;

  // POST body
  if (method === 'POST' && endpoint.bodyTemplate) {
    fetchOptions.body = String(endpoint.bodyTemplate).replace(/\{sid\}/g, sid || '');
  }
  return fetchOptions;
}

/**
 * 将 endpoint.url 中 {sid} 占位符替换为真实 sid。
 */
function buildUrl(endpoint, sid) {
  let url = endpoint.url;
  if (sid) {
    url = url.replace(/\{sid\}/g, sid);
  } else {
    url = url.replace(/[?&]sid=\{sid\}/g, '');
    url = url.replace(/\{sid\}/g, '');
  }
  return url;
}

/**
 * 对单个 provider 的单个 endpoint，在某个策略下做一次真实请求，返回判定。
 */
async function probeEndpointWithStrategy(provider, endpoint, sid, strategy) {
  const strategyOpts = await strategy.build(provider);
  const url = buildUrl(endpoint, sid);
  const loggerTest = createLogger(`possibility:${provider}:${strategy.id}:${endpoint.name}`);
  loggerTest.debug(`发起 ${strategy.id} 请求 ${endpoint.method || 'GET'} ${url}`);

  const start = performance.now();
  const outcome = {
    strategy: strategy.id,
    strategyLabel: strategy.label,
    endpoint: endpoint.name,
    url,
    hasSid: !!sid,
  };

  let dnrRuleId = null;
  if (strategyOpts.useDNR) {
    const applied = await applyDnrCookieRule(strategyOpts.cookieHeader || '', url);
    if (!applied.ok) {
      outcome.dnr = { ok: false, reason: applied.reason };
      loggerTest.warn('DNR 不可用，跳过该策略', outcome.dnr);
      return { ...outcome, error: 'DNR unavailable: ' + (applied.reason || '') };
    }
    dnrRuleId = applied.ruleId;
    outcome.dnr = { ok: true, ruleId };
  }

  try {
    const fetchOptions = buildFetchOptions(provider, endpoint, sid, strategyOpts);
    const response = await fetchWithTimeout(url, fetchOptions, 15000);
    const elapsed = Math.round(performance.now() - start);

    // 读取响应文本（QQ 可能 GB18030）
    let text = '';
    try {
      const ct = response.headers?.get?.('content-type') || '';
      const ab = await response.arrayBuffer();
      const enc = /gb18030|gbk|gb2312/i.test(ct) ? 'gb18030' : 'utf-8';
      try { text = new TextDecoder(enc, { fatal: false }).decode(ab); }
      catch (e) { text = new TextDecoder('utf-8', { fatal: false }).decode(ab); }
    } catch (e) {
      text = '';
    }

    const preview = text.length > 600 ? text.substring(0, 600) : text;
    const verdict = classifyVerdict(provider, response.status, text, response.url);

    outcome.httpStatus = response.status;
    outcome.elapsedMs = elapsed;
    outcome.finalUrl = response.url;
    outcome.contentType = response.headers?.get?.('content-type') || '';
    outcome.verdict = verdict.type;
    outcome.authReason = verdict.reason;
    outcome.preview = preview;
    outcome.responseHeaders = headersToObject(response.headers);

    loggerTest.info(`结果: verdict=${verdict.type}, status=${response.status}, ${elapsed}ms`, {
      reason: verdict.reason,
      preview: preview.substring(0, 400),
    });

    return outcome;
  } catch (err) {
    const elapsed = Math.round(performance.now() - start);
    outcome.httpStatus = 0;
    outcome.elapsedMs = elapsed;
    outcome.error = err.message;
    outcome.errorName = err.name;
    outcome.verdict = 'ERROR';
    loggerTest.error(`请求异常: ${err.message}`, { name: err.name });
    return outcome;
  } finally {
    if (dnrRuleId) await clearDnrRule(dnrRuleId);
  }
}

/**
 * 归类响应：区分「真正读到数据」「认证拦截」「登录跳转」「404/接口不存在」等。
 */
function classifyVerdict(provider, status, text, finalUrl) {
  if (status === 401 || status === 403) {
    return { type: 'AUTH_BLOCKED', reason: `HTTP ${status}` };
  }
  if (status === 404) {
    return { type: 'ENDPOINT_404', reason: 'HTTP 404' };
  }
  if (provider === 'netease_163') {
    if (/FA_UNAUTHORIZED/.test(text)) return { type: 'AUTH_BLOCKED', reason: 'FA_UNAUTHORIZED' };
    if (/FA_SECURITY/.test(text)) return { type: 'AUTH_BLOCKED', reason: 'FA_SECURITY' };
    if (/No sid parameter/i.test(text)) return { type: 'AUTH_BLOCKED', reason: 'No sid parameter' };
    if (/FA_SESSION_EXPIRED/.test(text)) return { type: 'AUTH_BLOCKED', reason: 'FA_SESSION_EXPIRED' };
  }
  // 登录页特征
  if (/gbIsNoCheck|loginFrame|qm_login|您还未登录|需要登录|登录QQ邮箱|ptlogin/i.test(text)) {
    return { type: 'LOGIN_REDIRECT', reason: 'login markers in response' };
  }
  if (finalUrl && /ptlogin|\/cgi-bin\/login/i.test(finalUrl)) {
    return { type: 'LOGIN_REDIRECT', reason: `redirected to ${finalUrl}` };
  }
  // 含未读字段 → 成功
  if (/unread|未读|"count"|收件箱/i.test(text)) {
    return { type: 'HAS_DATA', reason: 'response contains unread-ish data' };
  }
  // 其余默认：有响应但无未读信息（可能是数据格式不同）
  return { type: 'NO_UNREAD_PARSED', reason: 'got response but no unread marker' };
}

/**
 * 组装某 provider 的候选 endpoint 列表：优先已捕获的真实 API，其次内置。
 */
async function collectEndpoints(provider) {
  const cfg = PROVIDER_TARGET[provider];
  const captured = await getApiPatterns(provider);
  const list = [];
  if (captured.length) {
    const converted = patternsToProbeEndpoints(captured);
    for (const ep of converted.slice(0, 6)) {
      list.push({ name: ep.name, url: ep.url, method: ep.method || 'GET', headers: ep.headers || {}, bodyTemplate: ep.bodyTemplate || null });
    }
  }
  for (const ep of cfg.defaultEndpoints) list.push(ep);
  return list;
}

/**
 * 主入口：运行全可能性测试。
 * @param {string} provider - 'netease_163' | 'qq' | 'all'
 */
export async function runPossibilityTests(provider = 'all') {
  const providers = provider === 'all' ? Object.keys(PROVIDER_TARGET) : [provider];
  logger.info('开始「全可能性」后台无标签测试', { providers });

  const result = { success: true, startedAt: new Date().toISOString(), providers: {} };

  for (const prov of providers) {
    const cfg = PROVIDER_TARGET[prov];
    if (!cfg) continue;

    const sid = await getCachedSid(prov);
    const endpoints = await collectEndpoints(prov);
    const cookieInfo = await buildCookieHeader(prov);

    const providerResults = [];
    for (const strategy of STRATEGIES) {
      // 每个策略在第一个可用 endpoint 上跑，其余 endpoint 用默认 include 策略跑，控制请求量
      for (let ei = 0; ei < endpoints.length; ei++) {
        const ep = endpoints[ei];
        if (ei > 0 && strategy.id !== 'A1') continue; // 非基线策略只打第一个 endpoint，控制并发/风控
        const o = await probeEndpointWithStrategy(prov, ep, sid, strategy);
        providerResults.push(o);
      }
    }

    result.providers[prov] = {
      label: cfg.label,
      hasSid: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      cookieCount: cookieInfo.count,
      cookieNames: cookieInfo.names,
      endpointCount: endpoints.length,
      results: providerResults,
    };

    logger.info(`${cfg.label} 全可能性测试完成`, {
      hasSid: !!sid,
      cookieCount: cookieInfo.count,
      endpointCount: endpoints.length,
      attempts: providerResults.length,
    });
  }

  result.finishedAt = new Date().toISOString();
  logger.info('「全可能性」后台无标签测试结束');
  return result;
}
