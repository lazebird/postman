/**
 * service-worker.js - MV3 Service Worker 入口
 *
 * 混合方案（v0.4.0）：
 *   1. 内容脚本在邮箱页面（同源）提取 sid → 缓存到 chrome.storage.session
 *   2. SW 使用缓存 sid + 登录 Cookie 调用 webmail 内部 API → 后台独立检查
 *   3. 无缓存 sid 或 API 失败 → 回退到内容脚本 DOM 探测（需页面打开）
 *
 * 相比纯内容脚本方案，混合方案的核心优势：
 *   - 只需用户偶尔打开邮箱页面「激活」一次会话
 *   - 之后 SW 可定期调用 API 获取未读数，无需持续保持邮箱页面打开
 */

import { createLogger } from '../shared/debug.js';
import { getAccounts, getSettings, saveCheckResult, getCheckResults } from '../shared/storage.js';
import { PROVIDERS } from '../shared/constants.js';
import { probe163 } from '../providers/provider-163.js';
import { probeQQ } from '../providers/provider-qq.js';
import { diagnoseAll, diagnoseCookies } from '../shared/session-diagnose.js';

const logger = createLogger('service-worker');

// ===== 事件监听 =====

chrome.runtime.onInstalled.addListener((details) => {
  logger.info(`扩展安装/更新: reason=${details.reason}, previousVersion=${details.previousVersion || 'none'}`);
  if (details.reason === 'install' || details.reason === 'update') {
    setupAlarms().catch(err => {
      logger.error(`注册定时检查闹钟失败: ${err.message}`);
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  logger.info('浏览器启动，Service Worker 被唤醒');
  setupAlarms().catch(err => {
    logger.error(`注册定时检查闹钟失败: ${err.message}`);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'check-email') {
    logger.info(`定时检查触发: scheduledTime=${new Date(alarm.scheduledTime).toISOString()}`);
    try {
      await runAllChecks({ source: 'alarm' });
    } catch (err) {
      logger.error(`定时检查失败: ${err.message}`, { stack: err.stack });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => { sendResponse(result); })
    .catch(err => {
      logger.error(`消息处理失败: ${err.message}`, { type: message?.type, stack: err.stack });
      sendResponse({ success: false, error: err.message });
    });
  return true; // 异步响应
});

// ===== 消息处理 =====

async function handleMessage(message, sender) {
  if (!message || !message.type) {
    return { success: false, error: 'Invalid message' };
  }
  logger.debug('收到消息', { type: message.type, fromTab: sender?.tab ? sender.tab.id : 'extension' });

  switch (message.type) {
    case 'runCheck':
      return await runAllChecks({ source: 'manual' });

    case 'getStatus':
      return await getStatus();

    case 'testProvider':
      return await runSingleProvider(message.provider, { source: 'manual-test' });

    case 'testEndpoint':
      return await runEndpointTest(message.provider, message.endpointName, { source: 'manual-test' });

    case 'checkBridge':
      return await checkAuthStatus(message.provider);

    case 'refreshSession':
      return await refreshSession(message.provider);

    case 'diagnoseCookies':
      return await runCookieDiagnosis(message.provider);

    // ===== 混合方案：内容脚本 in-origin 探测 =====
    case 'probeContent163':
    case 'probeContentQQ': {
      const provider = message.type === 'probeContent163' ? 'netease_163' : 'qq';
      return await runContentProbe(provider, { openTab: message.openTab !== false });
    }

    case 'openMailboxTab':
      return await openMailboxTab(message.provider);

    case 'contentPageReady': {
      // 内容脚本上报：如果有 sid，缓存下来供 SW 后续独立调用
      const sid = message.detail?.sid;
      const provider = message.detail?.provider ||
                       (message.detail?.host?.includes('qq.com') ? 'qq' : 'netease_163');
      if (sid) {
        try {
          const key = provider === 'qq' ? 'sid_qq' : 'sid_163';
          await chrome.storage.session.set({
            [key]: sid,
            [`${key}_expiry`]: Date.now() + 30 * 60 * 1000,
          });
          logger.info(`从内容脚本缓存 ${provider} sid (来自页面 URL)`);
        } catch (e) {
          logger.warn(`缓存 ${provider} sid 失败: ${e.message}`);
        }
      }
      const unread = message.detail?.unreadCount;
      if (typeof unread === 'number') {
        logger.info(`内容脚本上报: ${provider} 未读=${unread} @ ${message.detail?.host}`);
      } else {
        logger.debug(`内容脚本就绪 @ ${message.detail?.host || 'unknown'}`);
      }
      return { success: true };
    }

    case 'settingsChanged':
      await setupAlarms();
      return { success: true, message: 'Alarms re-registered' };

    case 'accountsChanged': {
      const accountCount = (await getAccounts()).length;
      logger.info(`账户配置变更，当前共 ${accountCount} 个账户`);
      await setupAlarms();
      return { success: true, accountCount };
    }

    default:
      logger.warn(`未知消息类型: ${message.type}`);
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}

// ===== 混合方案：内容脚本探测 & sid 管理 =====

const PROVIDER_HOME = {
  netease_163: 'https://mail.163.com/',
  qq: 'https://mail.qq.com/',
};

/**
 * 打开目标邮箱首页（用于注入内容脚本并获取真实登录态 + sid）
 */
async function openMailboxTab(provider) {
  const url = PROVIDER_HOME[provider];
  if (!url) return { success: false, error: `Unknown provider: ${provider}` };
  const tab = await chrome.tabs.create({ url, active: true });
  logger.info(`已打开邮箱标签: ${url}, tabId=${tab.id}`);
  return { success: true, tabId: tab.id, url };
}

/**
 * 查找已打开的目标邮箱标签
 */
async function findMailboxTab(provider) {
  const url = PROVIDER_HOME[provider];
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url && t.url.startsWith(url));
}

/**
 * 向已打开的邮箱标签内容脚本发送探测指令
 */
async function probeTabContent(provider, tabId, timeoutMs = 15000) {
  const type = provider === 'qq' ? 'probeContentQQ' : 'probeContent163';

  // 若未指定 tab，查找已打开的目标邮箱标签
  let targetTabId = tabId;
  if (!targetTabId) {
    const match = await findMailboxTab(provider);
    if (match) targetTabId = match.id;
  }

  if (!targetTabId) {
    return {
      success: false,
      error: `未找到已打开的${provider === 'qq' ? 'QQ' : '163'}邮箱标签。请先打开邮箱页面登录，或使用 openTab 自动打开。`,
      needsTab: true,
    };
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, error: '等待内容脚本响应超时' }), timeoutMs);
    try {
      chrome.tabs.sendMessage(targetTabId, { type }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { success: false, error: '空响应' });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ success: false, error: e.message });
    }
  });

  result.tabId = targetTabId;
  return result;
}

/**
 * 打开/复用某个提供商的邮箱「收件箱」主页面标签，并尝试读出未读数。
 * 处理两类场景：
 *   a) 无邮箱标签 → 打开首页
 *   b) 有邮箱标签但落在辅助页面（如 /contacts/call.do）读不到未读 → 导航到主收件箱入口刷新
 */
async function runContentProbe(provider, opts = {}) {
  logger.info(`运行内容脚本探测: provider=${provider}, openTab=${opts.openTab !== false}`);
  const allowOpen = opts.openTab !== false;

  // 1) 先看是否有现成标签并探测
  let probe = await probeTabContent(provider, null);

  // 2) 有标签但落在辅助页（无未读且已授权），或没标签需要打开时
  const needNavigate =
    (probe.success && probe.pageType && probe.pageType !== 'inbox' && allowOpen) ||
    (probe.success === false && probe.needsTab && allowOpen);

  if (needNavigate) {
    // 若有标签但页面不对，导航到该标签的主入口；否则新建标签打开首页
    let tabId = probe.tabId;
    if (probe.needsTab) {
      const opened = await openMailboxTab(provider);
      tabId = opened.tabId;
      logger.info(`无现成邮箱标签，已打开 ${provider} 邮箱首页`);
    } else {
      try {
        await chrome.tabs.update(tabId, { url: PROVIDER_HOME[provider], active: false });
        logger.info(`导航 ${provider} 标签到首页以刷新到收件箱主框架`);
      } catch (e) {
        logger.warn(`导航邮箱标签失败: ${e.message}`);
      }
    }
    await new Promise(r => setTimeout(r, 3500));
    probe = await probeTabContent(provider, tabId);
  }

  // 如果内容脚本返回了 sid，缓存供 SW 独立使用
  if (probe.success && probe.sid) {
    await cacheProviderSid(provider, probe.sid);
  }

  return {
    success: true,
    provider,
    method: 'content-script',
    probe,
  };
}

/**
 * 缓存某提供商的 sid
 */
async function cacheProviderSid(provider, sid) {
  const key = provider === 'qq' ? 'sid_qq' : 'sid_163';
  try {
    await chrome.storage.session.set({
      [key]: sid,
      [`${key}_expiry`]: Date.now() + 30 * 60 * 1000,
    });
    logger.info(`已缓存 ${provider} sid (来自内容脚本)`);
    return true;
  } catch (e) {
    logger.warn(`缓存 ${provider} sid 失败: ${e.message}`);
    return false;
  }
}

/**
 * 读取某提供商缓存的 sid
 */
async function getCachedSid(provider) {
  const key = provider === 'qq' ? 'sid_qq' : 'sid_163';
  try {
    const data = await chrome.storage.session.get([key, `${key}_expiry`]);
    if (data[key]) {
      // 检查过期（30 分钟 TTL）
      if (data[`${key}_expiry`] && Date.now() > data[`${key}_expiry`]) {
        logger.debug(`${provider} sid 已过期`);
        return null;
      }
      return data[key];
    }
  } catch (e) {
    logger.warn(`读取 ${provider} sid 失败: ${e.message}`);
  }
  return null;
}

/**
 * Cookie 会话诊断
 */
async function runCookieDiagnosis(provider) {
  const result = provider ? await diagnoseCookies(provider) : await diagnoseAll();
  return { success: true, ...result };
}

// ===== 核心检查逻辑 =====

/**
 * 混合模式检查单个账户：
 *   1. 尝试用缓存的 sid 调 API（无需页面打开）
 *   2. 若 API 失败或无缓存 sid → 内容脚本 DOM 探测
 *   3. 若内容脚本不可用（无页面）→ 尝试自动打开页面获取 sid
 */
async function checkSingleAccount(account, settings, context) {
  const logger_acc = createLogger(`account:${account.email}`);
  logger_acc.info(`开始检查账户 ${account.email} (provider=${account.provider})`);

  const mode = settings.checkMode || 'hybrid';

  try {
    // ===== 模式 1：SW API 优先（hybrid / sw-api） =====
    if (mode === 'hybrid' || mode === 'sw-api') {
      // 先看有没有缓存 sid
      const cachedSid = await getCachedSid(account.provider);
      logger_acc.debug(`缓存 sid 状态: ${cachedSid ? '存在' : '无'}`);

      if (cachedSid) {
        // 使用缓存的 sid 调 API
        const apiResult = await runSWApiProbe(account.provider, settings);
        if (apiResult.success) {
          const accountResult = {
            email: account.email,
            provider: account.provider,
            authVerified: true,
            needsAuth: false,
            allFailed: false,
            source: context.source,
            method: 'sw-api',
            unreadCount: apiResult.unreadCount,
            unreadSource: apiResult.unreadSource,
            detail: apiResult.detail,
            timestamp: new Date().toISOString(),
          };
          await saveCheckResult(accountResult);
          logger_acc.info(`SW API 探测成功: unread=${apiResult.unreadCount}`);
          return accountResult;
        }

        // API 失败，sid 可能失效
        if (apiResult.sidExpired) {
          logger_acc.warn('缓存的 sid 已失效，尝试刷新');
          await clearCachedSid(account.provider);
        }
      }

      // 无缓存 sid 或 API 失败
      // 如果是 sw-api 模式（不需要页面），返回失败
      if (mode === 'sw-api' && !cachedSid) {
        logger_acc.warn('sw-api 模式但无缓存 sid，无法独立探测');
      }
    }

    // ===== 模式 2：内容脚本探测 =====
    if (mode === 'hybrid' || mode === 'content-script') {
      const contentResult = await runContentProbe(account.provider, { openTab: false });

      if (contentResult.probe && contentResult.probe.success &&
          typeof contentResult.probe.unreadCount === 'number') {
        const accountResult = {
          email: account.email,
          provider: account.provider,
          authVerified: true,
          needsAuth: false,
          allFailed: false,
          source: context.source,
          method: 'content-script',
          unreadCount: contentResult.probe.unreadCount,
          unreadSource: contentResult.probe.unreadSource,
          detail: contentResult.probe.detail,
          timestamp: new Date().toISOString(),
        };
        await saveCheckResult(accountResult);
        logger_acc.info(`内容脚本探测成功: unread=${contentResult.probe.unreadCount}`);
        return accountResult;
      }

      // 内容脚本探测返回但未能读出未读数。
      // 区分两种情况：
      //   a) 已授权（拿到 sid / 邮箱主页面已登录）但恰好落在无未读的辅助 frame → 需切到收件箱主框架
      //   b) 完全无 sid / 未登录 → 需要用户登录邮箱
      const probe = contentResult.probe || {};
      const contentSid = probe.sid || probe.loggedIn;
      logger_acc.warn('内容脚本未能读出未读数', {
        success: probe.success,
        loggedIn: probe.loggedIn,
        authVerified: probe.authVerified,
        pageType: probe.pageType,
        needsInboxPage: probe.needsInboxPage,
        unreadCount: probe.unreadCount,
        contentError: probe.error,
        needsTab: probe.needsTab,
      });

      // 已授权但仅落在辅助 frame（如 /contacts/call.do）：单独返回一个更明确的中间态，
      // 提示用户打开收件箱主页面即可读到未读数（并缓存 sid 供 SW API 检查）。
      if (contentSid) {
        const accountResult = {
          email: account.email,
          provider: account.provider,
          authVerified: true,        // 已授权（拿到 sid）
          needsAuth: false,
          allFailed: false,
          needsInboxPage: true,      // 需切到收件箱主页面才能读未读数
          source: context.source,
          method: 'content-script',
          unreadCount: typeof probe.unreadCount === 'number' ? probe.unreadCount : null,
          unreadSource: probe.unreadSource || null,
          detail: probe.detail || {},
          timestamp: new Date().toISOString(),
        };
        await saveCheckResult(accountResult);
        logger_acc.info('已授权（sid 已提取），但需打开收件箱主页面才能读到未读数');
        return accountResult;
      }
    }

    // ===== 所有方法都失败 =====
    const accountResult = {
      email: account.email,
      provider: account.provider,
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      source: context.source,
      method: 'none',
      needsTab: true,
      error: '未授权：无法获取邮箱会话（未检测到 sid / 未打开邮箱登录页）',
      detail: {
        mode,
        hint: '请先在浏览器打开并登录对应邮箱网页（163 / QQ），再点击「同步会话」授权一次，之后扩展即可后台自动读取未读数。',
        action: 'openMailboxAndSync',
      },
      timestamp: new Date().toISOString(),
    };
    await saveCheckResult(accountResult);
    return accountResult;
  } catch (err) {
    logger_acc.error(`账户 ${account.email} 检查异常: ${err.message}`);
    const accountResult = {
      email: account.email,
      provider: account.provider,
      success: false,
      authVerified: false,
      needsAuth: false,
      allFailed: true,
      error: err.message,
      source: context.source,
      timestamp: new Date().toISOString(),
    };
    await saveCheckResult(accountResult);
    return accountResult;
  }
}

/**
 * 使用 SW fetch + 缓存 sid 调用邮箱 API
 * 需要: chrome.storage.session 中缓存了 sid
 */
async function runSWApiProbe(provider, settings) {
  try {
    // 获取缓存 sid
    const cachedSid = await getCachedSid(provider);
    if (!cachedSid) {
      return { success: false, sidExpired: false, error: 'No cached sid' };
    }

    // 直接调用 provider 的探测接口（provider 内部会读取缓存 sid）
    const commonOpts = {
      endpointNames: settings.enabledEndpoints?.[provider] || [],
      captureRequestHeaders: false,
    };

    let providerResult;
    switch (provider) {
      case PROVIDERS.NETEASE_163:
        providerResult = await probe163(commonOpts);
        break;
      case PROVIDERS.QQ:
        providerResult = await probeQQ(commonOpts);
        break;
      default:
        return { success: false, error: `Unsupported provider: ${provider}` };
    }

    // 解析结果
    const endpointResults = providerResult.results || [];
    const successfulEndpoints = endpointResults.filter(r => r.success && typeof r.unreadCount === 'number');

    if (successfulEndpoints.length > 0) {
      return {
        success: true,
        unreadCount: successfulEndpoints[0].unreadCount,
        unreadSource: `api:${successfulEndpoints[0].endpointName}`,
        detail: providerResult,
      };
    }

    // 检查是否 sid 过期 / 认证被拦截
    const authBlocked = endpointResults.some(r => r.authBlocked);
    return {
      success: false,
      sidExpired: authBlocked,
      authBlocked,
      error: 'API 探测未返回未读数',
      detail: providerResult,
    };
  } catch (err) {
    logger.error(`SW API 探测异常: ${err.message}`, { provider });
    return { success: false, error: err.message };
  }
}

/**
 * 清除某提供商的 sid 缓存
 */
async function clearCachedSid(provider) {
  const key = provider === 'qq' ? 'sid_qq' : 'sid_163';
  try {
    await chrome.storage.session.remove([key, `${key}_expiry`]);
    logger.info(`已清除 ${provider} 的 sid 缓存`);
  } catch (e) {
    logger.warn(`清除 ${provider} sid 失败: ${e.message}`);
  }
}

/**
 * 全量检查所有账户
 */
async function runAllChecks(context = {}) {
  const source = context.source || 'unknown';
  logger.info(`开始全量检查, 触发源=${source}`);

  const accounts = await getAccounts();
  const settings = await getSettings();

  if (!accounts.length) {
    logger.warn('未配置任何邮箱账户，跳过检查');
    return { success: true, message: 'No accounts configured', checkResults: [], accountCount: 0, source };
  }

  const allResults = [];
  for (const account of accounts) {
    const result = await checkSingleAccount(account, settings, context);
    allResults.push(result);
  }

  const summary = {
    success: true,
    source,
    timestamp: new Date().toISOString(),
    accountCount: accounts.length,
    successfulChecks: allResults.filter(r => r.authVerified).length,
    failedChecks: allResults.filter(r => !r.authVerified).length,
    authBlocked: allResults.filter(r => r.needsAuth).length,
    results: allResults,
  };

  logger.info('全量检查完成', {
    authVerified: summary.successfulChecks,
    needsAuth: summary.authBlocked,
    methods: allResults.map(r => r.method || 'none').join(','),
  });

  await saveCheckResult(summary);
  await updateBadge(summary);
  return summary;
}

async function runSingleProvider(provider, context = {}) {
  logger.info(`手动运行提供商检查: provider=${provider}, source=${context.source || 'manual'}`);
  const accounts = await getAccounts();
  const matchingAccounts = accounts.filter(a => a.provider === provider);

  if (!matchingAccounts.length) {
    // 即使没配置账户，也允许手动触发探测（诊断场景）
    const cachedSid = await getCachedSid(provider);
    const cookieDiag = await diagnoseCookies(provider);

    // 如果有缓存 sid，尝试 API 探测
    let apiResult = null;
    if (cachedSid) {
      const settings = await getSettings();
      apiResult = await runSWApiProbe(provider, settings);
    }

    // 再试内容脚本
    const contentProbe = await runContentProbe(provider, { openTab: true });

    return {
      success: true,
      provider,
      results: [],
      cachedSid: !!cachedSid,
      apiResult,
      contentProbe,
      cookieDiag,
    };
  }

  const settings = await getSettings();
  const results = [];
  for (const account of matchingAccounts) {
    const result = await checkSingleAccount(account, settings, context);
    results.push(result);
  }
  return { success: true, provider, results };
}

async function runEndpointTest(provider, endpointName, context = {}) {
  logger.info(`手动测试接口: provider=${provider}, endpoint=${endpointName}`);
  let providerResult;
  const opts = { endpointNames: endpointName ? [endpointName] : [] };
  if (provider === PROVIDERS.NETEASE_163) providerResult = await probe163(opts);
  else if (provider === PROVIDERS.QQ) providerResult = await probeQQ(opts);
  else return { success: false, error: `Unsupported provider: ${provider}` };
  return { success: true, provider, endpointName, result: providerResult };
}

async function checkAuthStatus(provider) {
  logger.info(`检查 ${provider} 的认证状态`);
  const cachedSid = await getCachedSid(provider);
  const cookieDiag = await diagnoseCookies(provider);
  const contentProbe = await runContentProbe(provider, { openTab: false });

  const hasSid = !!cachedSid;
  const probe = contentProbe.probe || {};
  const contentLoggedIn = probe.loggedIn === true || probe.authVerified === true || !!probe.sid;
  const hasUnreadData = typeof probe.unreadCount === 'number';
  const pageType = probe.pageType || null;
  const needsInboxPage = probe.needsInboxPage === true;

  // 明确的授权状态机：
  //   authed        : 已授权（拿到 sid 或内容脚本确认登录）→ 可尝试读取未读数
  //   authed_no_unread : 已授权但当前落在无未读的辅助页 → 需切到收件箱
  //   needs_auth    : 未授权（无 sid / 无邮箱登录页）→ 需登录邮箱
  let authState = 'needs_auth';
  if (hasSid || contentLoggedIn) {
    authState = needsInboxPage ? 'authed_no_unread' : 'authed';
  }

  return {
    success: true,
    provider,
    authState,
    loggedIn: hasSid || contentLoggedIn,
    needsAuth: !(hasSid || contentLoggedIn),
    hasCachedSid: hasSid,
    detail: {
      cachedSid: hasSid,
      contentScriptLoggedIn: contentLoggedIn,
      contentUnreadCount: hasUnreadData ? probe.unreadCount : null,
      pageType,
      needsInboxPage,
      cookieDiag,
    },
  };
}

async function refreshSession(provider) {
  logger.info(`刷新 ${provider} 的会话`);

  // 清除旧 sid
  await clearCachedSid(provider);

  // 尝试内容脚本获取（可能需要打开页面）
  const contentProbe = await runContentProbe(provider, { openTab: true });
  const sid = contentProbe.probe?.sid;

  if (sid) {
    await cacheProviderSid(provider, sid);
  }

  return {
    success: true,
    provider,
    loggedIn: !!sid,
    needsAuth: !sid,
    hasSid: !!sid,
    sid: sid ? sid.substring(0, 8) + '...' : null,
    contentProbe,
  };
}

async function getStatus() {
  const accounts = await getAccounts();
  const settings = await getSettings();
  const checkResults = await getCheckResults(10);
  const alarm = await chrome.alarms.get('check-email');

  // 检查是否有缓存 sid
  const sid163 = await getCachedSid('netease_163');
  const sidQQ = await getCachedSid('qq');

  return {
    success: true,
    accounts: accounts.map(a => ({ email: a.email, provider: a.provider })),
    accountCount: accounts.length,
    settings,
    cachedSids: {
      netease_163: !!sid163,
      qq: !!sidQQ,
    },
    alarmConfigured: !!alarm,
    alarmInfo: alarm ? { periodInMinutes: alarm.periodInMinutes, scheduledTime: new Date(alarm.scheduledTime).toISOString() } : null,
    recentResults: checkResults,
    timestamp: new Date().toISOString(),
  };
}

async function setupAlarms() {
  const settings = await getSettings();
  const intervalMinutes = Math.max(1, settings.checkIntervalMinutes || 5);
  logger.info(`注册定时检查闹钟: interval=${intervalMinutes}分钟`);
  try {
    await chrome.alarms.clear('check-email');
    await chrome.alarms.create('check-email', { delayInMinutes: 1, periodInMinutes: intervalMinutes });
  } catch (err) {
    logger.error(`闹钟注册失败: ${err.message}`);
    throw err;
  }
}

async function updateBadge(summary) {
  if (!summary || !summary.results) return;
  try {
    let totalUnread = 0;
    let hasUnreadData = false;
    for (const result of summary.results) {
      if (typeof result.unreadCount === 'number') {
        totalUnread += result.unreadCount;
        hasUnreadData = true;
      }
      // 兼容嵌套的 results 数组
      if (result.results && Array.isArray(result.results)) {
        for (const er of result.results) {
          if (typeof er.unreadCount === 'number') {
            totalUnread += er.unreadCount;
            hasUnreadData = true;
          }
        }
      }
    }
    const badgeText = hasUnreadData && totalUnread > 0 ? String(totalUnread) : '';
    await chrome.action.setBadgeText({ text: badgeText });
    let color = '#4CAF50';
    if (summary.authBlocked > 0) color = '#FF9800';
    if (summary.successfulChecks === 0 && summary.failedChecks > 0) color = '#F44336';
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (err) {
    logger.debug(`Badge 更新失败: ${err.message}`);
  }
}

logger.info('Service Worker 启动');
setupAlarms().catch(err => { logger.error(`注册闹钟失败: ${err.message}`); });
