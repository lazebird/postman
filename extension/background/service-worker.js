/**
 * service-worker.js - MV3 Service Worker 入口
 *
 * 方案 C PoC 核心（v0.3.0）：
 *   经多轮验证，纯 SW 跨源 fetch 无法复用 163/QQ 的 SameSite=Lax 登录 Cookie，
 *   因此切换到「内容脚本 in-origin 探测」：
 *     1. 用户在真实邮箱页面打开/刷新时，内容脚本自动注入并上报基线
 *     2. SW 可发送探测指令给已加载的内容脚本，读取页面真实未读数
 *     3. 附带 Cookie 诊断（chrome.cookies），用数据判定会话可复用性
 *
 * 仍保留 alarms + 账户管理 + 全量检查调度框架。
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

    // ===== 方案 C：内容脚本 in-origin 探测 =====
    case 'probeContent163':
    case 'probeContentQQ': {
      const provider = message.type === 'probeContent163' ? 'netease_163' : 'qq';
      return await runContentProbe(provider, { openTab: message.openTab !== false });
    }

    case 'openMailboxTab':
      return await openMailboxTab(message.provider);

    case 'contentPageReady':
      logger.info(`内容脚本就绪 @ ${message.detail?.host || 'unknown'}`);
      return { success: true };

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

// ===== 方案 C 内容脚本探测 =====

const PROVIDER_HOME = {
  netease_163: 'https://mail.163.com/',
  qq: 'https://mail.qq.com/',
};

/**
 * 打开目标邮箱首页（用于注入内容脚本并获取真实登录态）
 */
async function openMailboxTab(provider) {
  const url = PROVIDER_HOME[provider];
  if (!url) return { success: false, error: `Unknown provider: ${provider}` };
  const tab = await chrome.tabs.create({ url, active: true });
  logger.info(`已打开邮箱标签: ${url}, tabId=${tab.id}`);
  return { success: true, tabId: tab.id, url };
}

/**
 * 向已打开的目标邮箱标签内容脚本发送探测指令
 */
async function probeTabContent(provider, tabId, timeoutMs = 12000) {
  const url = PROVIDER_HOME[provider];
  const type = provider === 'qq' ? 'probeContentQQ' : 'probeContent163';

  // 若未指定 tab，则查找已打开的对应邮箱标签
  let targetTabId = tabId;
  if (!targetTabId) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(t => t.url && t.url.startsWith(url));
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
 * 运行一次内容脚本探测：优先用已有邮箱标签，必要时自动打开。
 */
async function runContentProbe(provider, opts = {}) {
  logger.info(`运行内容脚本探测: provider=${provider}, openTab=${opts.openTab}`);

  // 先看是否有现成标签
  let probe = await probeTabContent(provider, null);
  if (!probe.success && probe.needsTab && opts.openTab) {
    logger.info(`无现成邮箱标签，自动打开 ${provider} 邮箱页`);
    await openMailboxTab(provider);
    // 等待页面加载与内容脚本注入
    await new Promise(r => setTimeout(r, 3500));
    probe = await probeTabContent(provider, null);
  }

  return {
    success: true,
    provider,
    method: 'content-script',
    probe,
  };
}

/**
 * Cookie 会话诊断
 */
async function runCookieDiagnosis(provider) {
  const result = provider ? await diagnoseCookies(provider) : await diagnoseAll();
  return { success: true, ...result };
}

// ===== 核心检查逻辑 =====

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

  logger.info('全量检查完成', { authVerified: summary.successfulChecks, needsAuth: summary.authBlocked });
  await saveCheckResult(summary);
  await updateBadge(summary);
  return summary;
}

async function checkSingleAccount(account, settings, context) {
  const logger_acc = createLogger(`account:${account.email}`);
  logger_acc.info(`开始检查账户 ${account.email} (provider=${account.provider})`);

  try {
    // 方案 C：优先用内容脚本探测真实页面
    const contentResult = await runContentProbe(account.provider, { openTab: false });

    // 若内容脚本探测成功拿到未读数，直接作为结果
    if (contentResult.probe && contentResult.probe.success && typeof contentResult.probe.unreadCount === 'number') {
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
        contentResult,
      };
      await saveCheckResult(accountResult);
      return accountResult;
    }

    // 内容脚本不可用（无打开标签）→ 回退到原 SW 接口探测（记录到诊断，便于对比）
    logger_acc.warn('内容脚本不可用或无未读数，回退到 SW 接口探测（仅供诊断对比）', {
      contentError: contentResult.probe?.error,
    });

    let providerResult;
    const commonOpts = {
      endpointNames: settings.enabledEndpoints?.[account.provider] || [],
      captureRequestHeaders: false,
    };

    switch (account.provider) {
      case PROVIDERS.NETEASE_163: providerResult = await probe163(commonOpts); break;
      case PROVIDERS.QQ: providerResult = await probeQQ(commonOpts); break;
      case PROVIDERS.USTC:
        providerResult = { provider: 'ustc', success: false, needsAuth: true, authVerified: false, allFailed: true, message: 'USTC not implemented' };
        break;
      default:
        providerResult = { provider: account.provider, success: false, authVerified: false, allFailed: true, message: `Unsupported: ${account.provider}` };
    }

    const accountResult = {
      email: account.email,
      provider: account.provider,
      ...providerResult,
      source: context.source,
      contentResult,
    };
    await saveCheckResult(accountResult);
    return accountResult;
  } catch (err) {
    logger_acc.error(`账户 ${account.email} 检查异常: ${err.message}`);
    const accountResult = {
      email: account.email, provider: account.provider, success: false,
      authVerified: false, needsAuth: false, allFailed: true, error: err.message, source: context.source,
    };
    await saveCheckResult(accountResult);
    return accountResult;
  }
}

async function runSingleProvider(provider, context = {}) {
  logger.info(`手动运行提供商检查: provider=${provider}, source=${context.source || 'manual'}`);
  const accounts = await getAccounts();
  const matchingAccounts = accounts.filter(a => a.provider === provider);

  if (!matchingAccounts.length) {
    // 即使没配置账户，也允许手动触发内容脚本探测 + Cookie 诊断（诊断场景）
    const contentProbe = await runContentProbe(provider, { openTab: true });
    const cookieDiag = await diagnoseCookies(provider);
    return { success: true, provider, results: [], contentProbe, cookieDiag };
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
  const { getProviderSid } = await import('../shared/session.js');
  const sessionResult = await getProviderSid(provider, { forceRefresh: false });
  const cookieDiag = await diagnoseCookies(provider);
  return {
    success: true, provider,
    loggedIn: sessionResult.loggedIn,
    needsAuth: !sessionResult.loggedIn,
    detail: { session: sessionResult, cookieDiag },
  };
}

async function refreshSession(provider) {
  logger.info(`强制刷新 ${provider} 的会话 sid`);
  const { getProviderSid, clearSid } = await import('../shared/session.js');
  await clearSid(provider);
  const sessionResult = await getProviderSid(provider, { forceRefresh: true });
  return { success: true, provider, loggedIn: sessionResult.loggedIn, needsAuth: !sessionResult.loggedIn, session: sessionResult };
}

async function getStatus() {
  const accounts = await getAccounts();
  const settings = await getSettings();
  const checkResults = await getCheckResults(10);
  const alarm = await chrome.alarms.get('check-email');
  return {
    success: true,
    accounts: accounts.map(a => ({ email: a.email, provider: a.provider })),
    accountCount: accounts.length,
    settings,
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
      if (typeof result.unreadCount === 'number') { totalUnread += result.unreadCount; hasUnreadData = true; }
      if (result.results && Array.isArray(result.results)) {
        for (const er of result.results) {
          if (typeof er.unreadCount === 'number') { totalUnread += er.unreadCount; hasUnreadData = true; }
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
