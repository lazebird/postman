/**
 * service-worker.js - MV3 Service Worker 入口
 *
 * 方案 B PoC 核心：
 * 1. chrome.alarms 定时唤醒 SW
 * 2. 读取账户配置
 * 3. 对每个启用的邮箱提供商执行未读接口探测
 * 4. 收集并记录探测结果
 * 5. 完整调试信息记录
 *
 * 修复优化：
 * - 更健壮的闹钟注册/错误处理
 * - 会话 sid 管理（通过 shared/session.js）
 * - badge 更新逻辑改进
 */

import { createLogger } from '../shared/debug.js';
import { getAccounts, getSettings, saveCheckResult, getCheckResults } from '../shared/storage.js';
import { PROVIDERS } from '../shared/constants.js';
import { probe163 } from '../providers/provider-163.js';
import { probeQQ } from '../providers/provider-qq.js';

const logger = createLogger('service-worker');

// ===== 事件监听 =====

// 安装/更新事件
chrome.runtime.onInstalled.addListener((details) => {
  logger.info(`扩展安装/更新: reason=${details.reason}, previousVersion=${details.previousVersion || 'none'}`);

  if (details.reason === 'install' || details.reason === 'update') {
    // 首次安装或更新：注册定时检查
    setupAlarms().catch(err => {
      logger.error(`注册定时检查闹钟失败: ${err.message}`);
    });
  }
});

// SW 启动事件
chrome.runtime.onStartup.addListener(() => {
  logger.info('浏览器启动，Service Worker 被唤醒');
  setupAlarms().catch(err => {
    logger.error(`注册定时检查闹钟失败: ${err.message}`);
  });
});

// 闹钟触发事件
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

// 收到来自 Popup / Options 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ success: false, error: 'Invalid message' });
    return;
  }

  logger.debug('收到消息', { type: message.type, sender: sender.tab ? `tab:${sender.tab.id}` : 'extension' });

  // 异步处理消息
  handleMessage(message)
    .then(result => {
      sendResponse(result);
    })
    .catch(err => {
      logger.error(`消息处理失败: ${err.message}`, { type: message.type, stack: err.stack });
      sendResponse({ success: false, error: err.message });
    });

  // 返回 true 以使用异步 sendResponse
  return true;
});

// ===== 消息处理 =====

async function handleMessage(message) {
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
      // 强制刷新会话 sid（如登录态变化后调用）
      return await refreshSession(message.provider);

    case 'settingsChanged':
      logger.info('检测到设置变更，重新注册闹钟');
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

// ===== 核心检查逻辑 =====

/**
 * 执行所有配置的邮箱检查
 */
async function runAllChecks(context = {}) {
  const source = context.source || 'unknown';
  logger.info(`开始全量检查, 触发源=${source}`);

  const accounts = await getAccounts();
  const settings = await getSettings();

  if (!accounts.length) {
    logger.warn('未配置任何邮箱账户，跳过检查');
    return {
      success: true,
      message: 'No accounts configured',
      checkResults: [],
      accountCount: 0,
      source,
    };
  }

  logger.info(`共 ${accounts.length} 个账户待检查`, {
    providers: accounts.map(a => `${a.email} (${a.provider})`),
  });

  const allResults = [];

  for (const account of accounts) {
    const result = await checkSingleAccount(account, settings, context);
    allResults.push(result);
  }

  // 汇总结果
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
  });

  // 保存结果
  await saveCheckResult(summary);

  // 更新 badge
  await updateBadge(summary);

  return summary;
}

/**
 * 检查单个账户
 */
async function checkSingleAccount(account, settings, context) {
  const logger_acc = createLogger(`account:${account.email}`);
  logger_acc.info(`开始检查账户 ${account.email} (provider=${account.provider})`);

  try {
    let providerResult;

    const commonOpts = {
      endpointNames: settings.enabledEndpoints?.[account.provider] || [],
      captureRequestHeaders: false,
    };

    switch (account.provider) {
      case PROVIDERS.NETEASE_163:
        providerResult = await probe163(commonOpts);
        break;

      case PROVIDERS.QQ:
        providerResult = await probeQQ(commonOpts);
        break;

      case PROVIDERS.USTC:
        logger_acc.warn('USTC 提供商暂未实现未读接口探测');
        providerResult = {
          provider: 'ustc',
          success: false,
          needsAuth: true,
          authVerified: false,
          allFailed: true,
          message: 'USTC provider not implemented yet',
        };
        break;

      default:
        logger_acc.warn(`不支持的提供商类型: ${account.provider}`);
        providerResult = {
          provider: account.provider,
          success: false,
          authVerified: false,
          allFailed: true,
          message: `Unsupported provider: ${account.provider}`,
        };
    }

    // 汇总单账户结果
    const accountResult = {
      email: account.email,
      provider: account.provider,
      ...providerResult,
      source: context.source,
    };

    // 保存单账户结果
    await saveCheckResult(accountResult);

    return accountResult;
  } catch (err) {
    logger_acc.error(`账户 ${account.email} 检查异常: ${err.message}`, err.stack);

    const accountResult = {
      email: account.email,
      provider: account.provider,
      success: false,
      authVerified: false,
      needsAuth: false,
      allFailed: true,
      error: err.message,
      source: context.source,
    };

    await saveCheckResult(accountResult);
    return accountResult;
  }
}

/**
 * 单独运行某个提供商的检查
 */
async function runSingleProvider(provider, context = {}) {
  logger.info(`手动运行提供商检查: provider=${provider}, source=${context.source || 'manual'}`);

  const accounts = await getAccounts();
  const matchingAccounts = accounts.filter(a => a.provider === provider);

  if (!matchingAccounts.length) {
    return {
      success: false,
      message: `No accounts configured for provider: ${provider}`,
    };
  }

  const settings = await getSettings();
  const results = [];

  for (const account of matchingAccounts) {
    const result = await checkSingleAccount(account, settings, context);
    results.push(result);
  }

  return {
    success: true,
    provider,
    results,
  };
}

/**
 * 手动测试指定接口
 */
async function runEndpointTest(provider, endpointName, context = {}) {
  logger.info(`手动测试接口: provider=${provider}, endpoint=${endpointName}`);

  let providerResult;
  const opts = { endpointNames: endpointName ? [endpointName] : [] };

  if (provider === PROVIDERS.NETEASE_163) {
    providerResult = await probe163(opts);
  } else if (provider === PROVIDERS.QQ) {
    providerResult = await probeQQ(opts);
  } else {
    return { success: false, error: `Unsupported provider: ${provider}` };
  }

  return {
    success: true,
    provider,
    endpointName,
    result: providerResult,
  };
}

/**
 * 检查认证状态（是否已登录目标站）
 * 通过尝试获取会话 sid 来判断
 */
async function checkAuthStatus(provider) {
  logger.info(`检查 ${provider} 的认证状态`);

  const { getProviderSid } = await import('../shared/session.js');

  const sessionResult = await getProviderSid(provider, { forceRefresh: false });

  return {
    success: true,
    provider,
    loggedIn: sessionResult.loggedIn,
    needsAuth: !sessionResult.loggedIn,
    detail: sessionResult,
  };
}

/**
 * 强制刷新指定提供商的会话 sid
 */
async function refreshSession(provider) {
  logger.info(`强制刷新 ${provider} 的会话 sid`);

  const { getProviderSid, clearSid } = await import('../shared/session.js');

  // 先清除旧缓存
  await clearSid(provider);

  // 重新获取
  const sessionResult = await getProviderSid(provider, { forceRefresh: true });

  return {
    success: true,
    provider,
    loggedIn: sessionResult.loggedIn,
    needsAuth: !sessionResult.loggedIn,
    session: sessionResult,
  };
}

/**
 * 获取扩展当前状态（用于 Popup）
 */
async function getStatus() {
  const accounts = await getAccounts();
  const settings = await getSettings();
  const checkResults = await getCheckResults(10);

  // 检查闹钟状态
  const alarm = await chrome.alarms.get('check-email');

  return {
    success: true,
    accounts: accounts.map(a => ({
      email: a.email,
      provider: a.provider,
    })),
    accountCount: accounts.length,
    settings,
    alarmConfigured: !!alarm,
    alarmInfo: alarm ? {
      periodInMinutes: alarm.periodInMinutes,
      scheduledTime: new Date(alarm.scheduledTime).toISOString(),
    } : null,
    recentResults: checkResults,
    timestamp: new Date().toISOString(),
  };
}

// ===== 辅助函数 =====

/**
 * 注册定时检查闹钟
 */
async function setupAlarms() {
  const settings = await getSettings();
  const intervalMinutes = Math.max(1, settings.checkIntervalMinutes || 5);

  logger.info(`注册定时检查闹钟: interval=${intervalMinutes}分钟`);

  try {
    // 先清除旧闹钟，避免重复
    await chrome.alarms.clear('check-email');

    await chrome.alarms.create('check-email', {
      delayInMinutes: 1, // 首次延迟1分钟后执行
      periodInMinutes: intervalMinutes,
    });
    logger.debug('闹钟注册成功');
  } catch (err) {
    logger.error(`闹钟注册失败: ${err.message}`);
    throw err;
  }
}

/**
 * 更新图标 Badge
 */
async function updateBadge(summary) {
  if (!summary || !summary.results) return;

  try {
    // 统计总未读数（如果有的话）
    let totalUnread = 0;
    let hasUnreadData = false;

    for (const result of summary.results) {
      // 从 provider result 中提取 unreadCount
      if (result.results && Array.isArray(result.results)) {
        for (const endpointResult of result.results) {
          if (typeof endpointResult.unreadCount === 'number') {
            totalUnread += endpointResult.unreadCount;
            hasUnreadData = true;
          }
        }
      }
      // 兼容直接返回未读数的情况
      if (typeof result.unreadCount === 'number') {
        totalUnread += result.unreadCount;
        hasUnreadData = true;
      }
    }

    const badgeText = hasUnreadData && totalUnread > 0 ? String(totalUnread) : '';
    await chrome.action.setBadgeText({ text: badgeText });

    // Badge 颜色：未读数=绿色，需登录=橙色，有错误=红色
    let badgeColor = '#4CAF50';
    if (summary.authBlocked > 0) {
      badgeColor = '#FF9800'; // 橙色 - 需登录
    }
    if (summary.successfulChecks === 0 && summary.failedChecks > 0) {
      badgeColor = '#F44336'; // 红色 - 全部失败
    }
    await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  } catch (err) {
    logger.debug(`Badge 更新失败（可能不影响主功能）: ${err.message}`);
  }
}

// SW 启动时立即尝试注册闹钟（应对 SW 被终止后重新唤醒的情况）
logger.info('Service Worker 启动');
setupAlarms().catch(err => {
  logger.error(`注册闹钟失败: ${err.message}`);
});
