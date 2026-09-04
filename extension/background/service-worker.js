/**
 * service-worker.js - MV3 Service Worker 入口
 *
 * 混合方案（v0.7.0）：
 *   1. 内容脚本在邮箱页面（同源）提取 sid → 缓存到 chrome.storage.local
 *   2. SW 使用缓存 sid + 登录 Cookie 调用 webmail 内部 API → 后台独立检查
 *   3. 无缓存 sid 或 API 失败 → 回退到内容脚本 DOM 探测（需页面打开）
 *
 * v0.7.0 修复（本版核心）：自动检查绝不自动打开可见标签
 *   - 后台定时检查（alarm）失败时仅标记「需手动同步会话」，不自动开标签
 *   - 仅用户主动触发（手动检查/同步）才打开邮箱标签获取 sid
 *   - sid 持久化至 chrome.storage.local（7天 TTL），浏览器重启不丢失
 *
 * v0.6.0：标签页关闭时全量/自动检查均能执行
 * v0.5.0：不再依赖标签页开启即可独立运行，延长 sid 缓存有效期
 */

import { createLogger } from '../shared/debug.js';
import {
  getAccounts,
  getSettings,
  saveCheckResult,
  getCheckResults,
  getDebugLogs,
} from '../shared/storage.js';
import { PROVIDERS } from '../shared/constants.js';
import { probe163 } from '../providers/provider-163.js';
import { probeQQ } from '../providers/provider-qq.js';
import { probeUSTC } from '../providers/provider-ustc.js';
import { probeGmail } from '../providers/provider-gmail.js';
import { authorizeGmailInteractive, hasGmailToken } from '../shared/gmail-oauth.js';
import { diagnoseAll, diagnoseCookies } from '../shared/session-diagnose.js';
import { saveApiPatterns, getApiPatterns, clearApiPatterns } from '../shared/api-patterns.js';
import { runPossibilityTests } from './possibility-tests.js';
import {
  cacheSid as sessionCacheSid,
  getCachedSid as sessionGetCachedSid,
  clearSid as sessionClearSid,
} from '../shared/session-cache.js';

const logger = createLogger('service-worker');

// ===== 常量 =====
// sid 缓存有效期(7天)统一由 shared/session-cache.js 管理

// 判断检查是否为用户主动触发（只有用户主动触发时才允许自动开标签）
// 用户主动触发来源：manual（Popup 全量检查）、manual-test（Popup/Options 单提供商测试）
// 自动触发来源：alarm（后台定时检查）—— 此类检查绝不自动打开可见标签
function isUserInitiated(context) {
  const src = (context && context.source) || 'unknown';
  return src === 'manual' || src === 'manual-test';
}

// ===== 事件监听 =====

chrome.runtime.onInstalled.addListener((details) => {
  logger.info(
    `扩展安装/更新: reason=${details.reason}, previousVersion=${details.previousVersion || 'none'}`
  );
  if (details.reason === 'install' || details.reason === 'update') {
    setupAlarms().catch((err) => {
      logger.error(`注册定时检查闹钟失败: ${err.message}`);
    });
    // 注意：安装/更新时不再自动触发 Gmail OAuth（避免非用户主动弹授权页）。
    // 需等用户在 Popup/Options 点击"同步 Gmail"才走 launchWebAuthFlow 授权。
    void hasGmailToken().then((has) =>
      logger.info(has ? '检测到已缓存 Gmail 令牌' : '尚未授权 Gmail，需手动同步')
    );
  }
});

chrome.runtime.onStartup.addListener(() => {
  logger.info('浏览器启动，Service Worker 被唤醒');
  setupAlarms().catch((err) => {
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
    .then((result) => {
      sendResponse(result);
    })
    .catch((err) => {
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
  logger.debug('收到消息', {
    type: message.type,
    fromTab: sender?.tab ? sender.tab.id : 'extension',
  });

  switch (message.type) {
    case 'runCheck':
      return await runAllChecks({ source: 'manual' });

    case 'getStatus':
      return await getStatus();

    case 'testProvider': {
      const result = await runSingleProvider(message.provider, { source: 'manual-test' });
      // 单提供商检查后更新 badge
      if (result.results?.length) {
        await updateBadgeFromLatest();
      }
      return result;
    }

    case 'testEndpoint':
      return await runEndpointTest(message.provider, message.endpointName);

    case 'possibilityTest': {
      // 「所有可能性」后台无标签测试：穷举 Cookie 附加策略 + 各端点，
      // 判定关闭邮箱标签后 SW 是否仍能读到未读数。纯 SW 直调、不开标签，符合 AGENTS 规则 1。
      return await runPossibilityTests(message.provider || 'all');
    }

    case 'checkBridge':
      return await checkAuthStatus(message.provider);

    case 'refreshSession':
      return await refreshSession(message.provider);

    case 'diagnoseCookies':
      return await runCookieDiagnosis(message.provider);

    // ===== 混合方案：内容脚本 in-origin 探测 =====
    case 'probeContent163':
    case 'probeContentQQ':
    case 'probeContentUSTC': {
      const provider =
        message.type === 'probeContentQQ'
          ? 'qq'
          : message.type === 'probeContentUSTC'
            ? 'ustc'
            : 'netease_163';
      const result = await runContentProbe(provider, { openTab: message.openTab !== false });
      // 内容脚本探测成功时，保存结果供 getStatus / badge 使用
      const p = result.probe;
      if (p && p.success) {
        // 找到匹配该 provider 的账户并保存结果
        const accounts = await getAccounts();
        const matching = accounts.filter((a) => a.provider === provider);
        for (const acc of matching) {
          await saveCheckResult({
            email: acc.email,
            provider: acc.provider,
            authVerified: p.authVerified === true || typeof p.unreadCount === 'number',
            needsAuth: p.loginRequired === true || p.needsTab === true,
            allFailed: !p.success,
            source: 'content-probe',
            method: 'content-script',
            unreadCount: typeof p.unreadCount === 'number' ? p.unreadCount : null,
            unreadSource: p.unreadSource || null,
            detail: p.detail || {},
            needsInboxPage: p.needsInboxPage === true,
            timestamp: new Date().toISOString(),
          });
        }
      }
      // 探测后更新 badge（含当前所有账户的未读总和）
      await updateBadgeFromLatest();
      return result;
    }

    case 'gmailAuthorize': {
      // Gmail OAuth2 授权流程（Chrome / Edge 通用，基于 launchWebAuthFlow）
      // 仅由用户主动点击"同步 Gmail"触发，会弹出 Google 授权页。
      const result = await authorizeGmailInteractive();
      if (result.success) {
        return { success: true, token: 'obtained' };
      }
      return {
        success: false,
        error: result.error || 'Gmail 授权失败',
        needsManual: !!result.needsManual,
      };
    }

    case 'openMailboxTab':
      // 显式"打开邮箱"用前台打开，便于用户操作；探测自开的后台标签不抢焦点
      return await openMailboxTab(message.provider, { active: true });

    case 'openInbox':
      // 从 Popup 状态页快速跳转到邮箱收件箱（前台打开）
      return await openMailboxTab(message.provider, { active: true });

    case 'contentPageReady': {
      // 内容脚本上报：如果有 sid，缓存下来供 SW 后续独立调用
      const sid = message.detail?.sid;
      const provider =
        message.detail?.provider ||
        (message.detail?.host?.includes('qq.com')
          ? 'qq'
          : message.detail?.host?.includes('ustc.edu.cn')
            ? 'ustc'
            : 'netease_163');
      if (sid) {
        await sessionCacheSid(provider, sid);
        logger.info(`从内容脚本缓存 ${provider} sid: ${sid.substring(0, 8)}...`);
      }
      const unread = message.detail?.unreadCount;
      // 页面跳转链路落点日志：配合「邮箱页多级跳转后最终呈现邮件内容」的验证，
      // 内容脚本每被注入一次就上报当前页面的 URL / 上一跳(referrer) / 导航阶段 / 帧角色，
      // 便于确认当前到底落到了跳转链的哪一段（登录重定向 / webmail 应用 / 辅助子帧）。
      const navStage = message.detail?.navStage || 'unknown';
      const frameRole = message.detail?.frameRole || (message.detail?.url ? '?' : 'ext');
      const referrer = message.detail?.referrer ? `, referrer=${message.detail?.referrer}` : '';
      const contentReached = message.detail?.contentReached;
      if (typeof unread === 'number') {
        logger.info(
          `内容脚本上报: ${provider} 未读=${unread} @ ${message.detail?.host || ''} | url=${message.detail?.url || ''}${referrer} | stage=${navStage} (${frameRole})`,
          { unread }
        );
      } else {
        logger.info(
          `页面落点: ${provider} @ ${message.detail?.url || message.detail?.host || 'unknown'} | stage=${navStage} (${frameRole})${referrer}${contentReached ? ' | 已到内容页(读到未读或sid)' : ' | 尚未到内容页'}`
        );
        logger.debug(
          `内容脚本就绪 @ ${message.detail?.host || 'unknown'} (${navStage}, ${frameRole})`
        );
      }
      return { success: true };
    }

    case 'apiCaptureBatch': {
      // 批量接收 API 捕获
      const provider = message.provider;
      const captures = message.captures || [];
      if (provider && captures.length > 0) {
        const patterns = captures.map((c) => ({
          url: c.url || '',
          method: c.method || 'GET',
          body: c.body || null,
          headers: c.headers || {},
          timestamp: c.timestamp || Date.now(),
          description: `页面捕获: ${c.type || 'unknown'} ${c.method || 'GET'} ${c.url || ''}`,
        }));
        // 缓存 sid（从第一条捕获中获取）
        const firstCapture = captures[0];
        const sidToUse = firstCapture?.currentSid;
        if (sidToUse && !(await sessionGetCachedSid(provider))) {
          await sessionCacheSid(provider, sidToUse);
        }
        const saved = await saveApiPatterns(provider, patterns);
        logger.info(`批量保存 ${provider} API 模式 ${patterns.length} 条`, {
          saved,
          fromFrame: message.fromFrame,
          totalCaptured: message.totalCaptured,
        });
        // 反馈本批捕获到的真实请求端点，便于日志确认捕获链路是否真正工作
        try {
          const seen = new Set();
          const distinct = patterns
            .map((p) => `${p.method} ${p.url}`)
            .filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
          logger.debug(`[capture:${provider}] 本批捕获端点:\n${distinct.join('\n')}`);
        } catch {}
      }
      return { success: true };
    }

    case 'apiCapture': {
      // 内容脚本捕获到页面的真实 API 请求，保存供 SW 后续精确复现
      const capture = message.capture;
      const provider = message.provider;
      if (capture && provider) {
        const pattern = {
          url: capture.url || '',
          method: capture.method || 'GET',
          body: capture.body || null,
          headers: capture.headers || {},
          timestamp: capture.timestamp || Date.now(),
          description: `页面捕获: ${capture.type || 'unknown'} ${capture.method || 'GET'} ${capture.url || ''}`,
        };
        // 如果消息中带了 currentSid 且 SW 还没有缓存，先临时缓存
        const sidToUse = capture.currentSid || message.sid;
        if (sidToUse && !(await sessionGetCachedSid(provider))) {
          await sessionCacheSid(provider, sidToUse);
          logger.info(`通过 API 捕获缓存 ${provider} sid`);
        }
        const saved = await saveApiPatterns(provider, [pattern]);
        logger.info(`已捕获并保存 ${provider} API 请求: ${pattern.method} ${pattern.url}`, {
          saved,
        });
      }
      return { success: true };
    }

    case 'apiCaptureCount': {
      // 内容脚本上报其在页面捕获到的请求总数（用于确认捕获链路工作）
      const provider = message.provider;
      if (provider) {
        logger.info(
          `[capture:${provider}] 页面累计捕获请求 ${message.count || 0} 条 @ ${message.host || 'unknown'}`
        );
      }
      return { success: true };
    }

    case 'getApiPatterns': {
      const provider = message.provider;
      if (!provider) return { success: false, error: 'Provider required' };
      const patterns = await getApiPatterns(provider);
      return { success: true, patterns };
    }

    case 'clearApiPatterns': {
      const provider = message.provider;
      if (!provider) return { success: false, error: 'Provider required' };
      await clearApiPatterns(provider);
      return { success: true, message: 'API patterns cleared' };
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

    case 'getDebugLogs': {
      // 获取调试日志（供外部工具读取）
      const limit = message.limit || 100;
      const logs = await getDebugLogs(limit);
      return { success: true, logs };
    }

    case 'getMemoryLogs': {
      // 获取内存中的实时日志
      const limit = message.limit || 50;
      try {
        const { getMemoryLogs: getMem } = await import('../shared/debug.js');
        const logs = typeof getMem === 'function' ? getMem(limit) : [];
        return { success: true, logs };
      } catch (e) {
        return { success: false, error: e.message };
      }
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
  ustc: 'http://mail.ustc.edu.cn/',
  gmail: 'https://mail.google.com/',
};

// 自动打开标签时使用的「登录后直达」URL：
const PROVIDER_OPEN_URL = {
  netease_163: 'https://mail.163.com/js6/main.jsp',
  qq: 'https://wx.mail.qq.com/',
  ustc: 'http://mail.ustc.edu.cn/coremail/XT/index.jsp',
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
};

// 支持内容脚本探测的提供商（有 content_scripts 注入 + 邮箱主页）
const CONTENT_PROBE_PROVIDERS = new Set([
  PROVIDERS.NETEASE_163,
  PROVIDERS.QQ,
  PROVIDERS.USTC,
  PROVIDERS.GMAIL,
]);

/**
 * QQ 邮箱主机判断：新网页版 QQ 邮箱运行在 wx.mail.qq.com 或 mail.qq.com
 */
function isQQMailUrl(url) {
  return /^https?:\/\/(?:wx\.)?mail\.qq\.com\//i.test(url || '');
}
function isQQLoginUrl(url) {
  // QQ 未登录时会被重定向到登录域（不在内容脚本注入范围）
  return (
    /^(?!https?:\/\/(?:wx\.)?mail\.qq\.com\/)/i.test(url || '') &&
    /ptlogin|ssl\.ptlogin|login\.qq|xui\.qq|passport/i.test(url || '')
  );
}

/**
 * 打开目标邮箱首页（用于注入内容脚本并获取真实登录态 + sid）
 */
async function openMailboxTab(provider, opts = {}) {
  let url = PROVIDER_OPEN_URL[provider] || PROVIDER_HOME[provider];

  // USTC 需要 sid 参数，尝试从缓存读取
  if (provider === 'ustc') {
    const cachedSid = await getCachedSid('ustc');
    if (cachedSid) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}sid=${cachedSid}`;
    }
  }

  if (!url) return { success: false, error: `Unknown provider: ${provider}` };
  // 默认后台打开（active:false）：避免当从 Popup 触发"获取未读数"时，因新建前台标签抢焦点
  // 而把 Popup 自动关闭，导致只打开了邮箱页面却看不到任何输出。
  const active = opts.active === true;
  const tab = await chrome.tabs.create({ url, active });
  logger.info(`已打开邮箱标签: ${url}, tabId=${tab.id}, active=${active}`);
  return { success: true, tabId: tab.id, url, active };
}

/**
 * 查找已打开的目标邮箱标签
 */
async function findMailboxTab(provider) {
  const tabs = await chrome.tabs.query({});
  if (provider === 'qq') {
    // QQ 邮箱可能落在 mail.qq.com 或 wx.mail.qq.com（新网页版），都要匹配
    return tabs.find((t) => t.url && isQQMailUrl(t.url));
  }
  const url = PROVIDER_HOME[provider];
  return tabs.find((t) => t.url && t.url.startsWith(url));
}

/**
 * 返回提供商的中文名，用于错误消息展示
 */
function providerNameForError(provider) {
  switch (provider) {
    case 'qq':
      return 'QQ';
    case 'netease_163':
      return '163';
    case 'ustc':
      return '中科大';
    case 'gmail':
      return 'Gmail';
    default:
      return provider || '目标';
  }
}

/**
 * 向已打开的邮箱标签内容脚本发送探测指令
 */
async function probeTabContent(provider, tabId, timeoutMs = 15000) {
  const type =
    provider === 'qq'
      ? 'probeContentQQ'
      : provider === 'ustc'
        ? 'probeContentUSTC'
        : 'probeContent163';

  // 若未指定 tab，查找已打开的目标邮箱标签
  let targetTabId = tabId;
  if (!targetTabId) {
    const match = await findMailboxTab(provider);
    if (match) targetTabId = match.id;
  }

  if (!targetTabId) {
    return {
      success: false,
      error: `未找到已打开的${providerNameForError(provider)}邮箱标签。请先打开邮箱页面登录，或使用 openTab 自动打开。`,
      needsTab: true,
    };
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ success: false, error: '等待内容脚本响应超时', reason: 'timeout' }),
      timeoutMs
    );
    try {
      chrome.tabs.sendMessage(targetTabId, { type }, (resp) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            error: chrome.runtime.lastError.message,
            reason: 'connection',
          });
        } else {
          resolve(resp || { success: false, error: '空响应', reason: 'empty' });
        }
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ success: false, error: e.message, reason: 'throw' });
    }
  });

  // 内容脚本无法注入（连接失败）时，读取标签当前 URL，判断是否被重定向到了登录页等
  if (result.reason && result.reason !== 'timeout') {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      const tabUrl = (tab && tab.url) || '';
      const hostOk =
        provider === 'qq' ? isQQMailUrl(tabUrl) : /^https:\/\/mail\.163\.com\//i.test(tabUrl);
      // QQ 未登录时 mail.qq.com 会重定向到 ptlogin2/xui.qq.com 等登录域（不在内容脚本注入范围）
      if (provider === 'qq' && isQQLoginUrl(tabUrl)) {
        result.qqLoginRedirect = true;
        result.loginRequired = true;
        result.error =
          'QQ 邮箱未登录：标签已被重定向到 QQ 登录页。请先在浏览器中登录 QQ 邮箱后重试。';
      } else if (!hostOk) {
        result.hostMismatch = true;
        result.tabUrl = tabUrl;
      } else {
        result.tabUrl = tabUrl;
      }
    } catch {
      /* 忽略 URL 读取失败 */
    }
  }

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
  // 记录本次是否新开了后台标签——调用方需要时可在探测后自行关闭
  let openedTabId = null;
  logger.info(`运行内容脚本探测: provider=${provider}, openTab=${opts.openTab !== false}`);
  const allowOpen = opts.openTab !== false;

  // 1) 先看是否有现成标签并探测
  let probe = await probeTabContent(provider, null);

  // 2) 如果已成功读到未读数 → 直接返回，不做多余导航
  if (probe.success && typeof probe.unreadCount === 'number') {
    if (probe.sid) await cacheProviderSid(provider, probe.sid);
    return { success: true, provider, method: 'content-script', probe };
  }

  // 3) 若 allowOpen=false：直接返回当前探测结果（不管是否成功），交由上层判断
  if (!allowOpen) {
    if (probe.success && probe.sid) await cacheProviderSid(provider, probe.sid);
    return { success: true, provider, method: 'content-script', probe };
  }

  // 4) 需要打开新标签 / 导航已有标签的情况：
  //    无标签、连接失败、或标签在辅助页无未读数时，均尝试打开或导航。
  //    扩展先打开/导航，再用「轮询」机制等待内容脚本注入后多次探测，
  //    避免只等一次(如3.5s固定等待)就放弃导致探测失败。
  const needsTabOpen =
    probe.success === false &&
    (probe.needsTab || probe.reason === 'connection' || probe.reason === 'empty');
  const needsNav = probe.success && probe.pageType && probe.pageType !== 'inbox';

  if (needsTabOpen || needsNav) {
    let tabId = probe.tabId;

    if (needsTabOpen && !probe.tabId) {
      // 该提供商不支持内容脚本 → 直接返回失败
      if (!CONTENT_PROBE_PROVIDERS.has(provider)) {
        logger.warn(`提供商 ${provider} 不支持内容脚本探测，跳过开标签`);
        return {
          success: false,
          provider,
          error: `提供商 ${provider} 不支持内容脚本探测`,
          probe: {
            success: false,
            error: `提供商 ${provider} 不支持内容脚本探测`,
            unsupportedProvider: true,
          },
        };
      }

      // 无现成标签 → 新建后台标签
      const opened = await openMailboxTab(provider);
      if (!opened.success || !opened.tabId) {
        logger.warn(`打开 ${provider} 邮箱标签失败: ${opened.error || '未知错误'}`);
        return {
          success: false,
          provider,
          error: opened.error || `打开 ${provider} 邮箱标签失败`,
          probe: { success: false, error: opened.error || '打开邮箱标签失败', needsTab: true },
        };
      }
      tabId = opened.tabId;
      openedTabId = tabId;
      logger.info(`无现成邮箱标签，已打开 ${provider} 邮箱首页 tabId=${tabId}`);
    } else if (tabId && (needsNav || probe.reason === 'connection')) {
      // 已有标签但连接失败或落在辅助页 → 导航到邮箱主应用刷新
      try {
        let openUrl = PROVIDER_OPEN_URL[provider] || PROVIDER_HOME[provider];
        // USTC 需要 sid 参数
        if (provider === 'ustc') {
          const cachedSid = await getCachedSid('ustc');
          if (cachedSid) {
            const sep = openUrl.includes('?') ? '&' : '?';
            openUrl = `${openUrl}${sep}sid=${cachedSid}`;
          }
        }
        await chrome.tabs.update(tabId, { url: openUrl, active: false });
        logger.info(`导航 ${provider} 标签(tabId=${tabId})到主应用刷新`);
      } catch (e) {
        logger.warn(`导航邮箱标签失败: ${e.message}`);
      }
    }

    // 轮询等待内容脚本就绪：延长超时给后台标签页面更多加载时间
    probe = await probeWithRetry(provider, tabId, 10, 2000, 30000);
  }

  // 5) 如果内容脚本返回了 sid，缓存供 SW 独立使用
  if (probe.success && probe.sid) {
    await cacheProviderSid(provider, probe.sid);
  }

  // 若本次新开了标签且调用方要求探测后关闭，则关闭（避免后台标签堆积）
  if (opts.closeAfterProbe && openedTabId) {
    try {
      await chrome.tabs.remove(openedTabId);
      logger.info(`已关闭自动打开的 ${provider} 标签 tabId=${openedTabId}`);
    } catch (e) {
      logger.warn(`关闭自动打开的 ${provider} 标签失败: ${e.message}`);
    }
  }

  return {
    success: true,
    provider,
    method: 'content-script',
    probe,
    openedTabId,
  };
}

/**
 * 轮询探测：最多 maxAttempts 次、间隔 intervalMs，总超时 timeoutMs。
 * 用于等待新打开的标签内容脚本注入完成后再探测。
 *
 * 对刚打开的后台标签，Chrome 可能延迟加载/节流，首次连接失败或 URL 未稳定
 * 不能立即放弃——需多轮重试，直到页面加载完成。
 */
async function probeWithRetry(
  provider,
  tabId,
  maxAttempts = 10,
  intervalMs = 2000,
  timeoutMs = 30000
) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  let consecutiveHostMismatch = 0;

  // 跳转链路观测：记录标签先后经历的不同 URL，用于确认「邮箱页多级跳转后
  // 最终落到哪个内容 URL」的整条链路（如 mail.qq.com → ptlogin/登录 → wx.mail.qq.com → 内容）。
  const seenUrls = new Set();
  const observedChain = [];

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() > deadline) break;
    lastProbe = await probeTabContent(provider, tabId, 8000);
    // 记录该轮标签实际 URL（多级跳转 / SPA 加载中的真实落点）
    try {
      const tabNow = await chrome.tabs.get(tabId);
      const curUrl = (tabNow && tabNow.url) || '';
      if (curUrl && !seenUrls.has(curUrl)) {
        seenUrls.add(curUrl);
        observedChain.push(curUrl);
        logger.info(
          `[redirect-trace:${provider}] tabId=${tabId} 跳转落点 #${observedChain.length}: ${curUrl}`
        );
      }
    } catch {
      /* 标签可能已关闭 */
    }
    // 成功读到未读数或已授权 → 退出轮询
    if (
      lastProbe.success &&
      (typeof lastProbe.unreadCount === 'number' || lastProbe.authVerified)
    ) {
      break;
    }
    // 明确登录页 → 退出（用户未登录，重试无意义）
    if (lastProbe.loginRequired) break;

    // hostMismatch：允许最多 3 次连续 hostMismatch 才退出——
    // 新开标签可能经历 URL 重定向/加载中的短暂状态，不应立即判定失败
    if (lastProbe.hostMismatch) {
      consecutiveHostMismatch++;
      if (consecutiveHostMismatch >= 3) break;
    } else {
      consecutiveHostMismatch = 0;
    }

    // 等待后重试
    if (i < maxAttempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  // 汇总整条跳转链路，便于日志确认最终内容页
  if (observedChain.length > 1) {
    logger.info(
      `[redirect-trace:${provider}] tabId=${tabId} 跳转链路共 ${observedChain.length} 段:\n${observedChain.join('\n→ ')}`
    );
  } else if (observedChain.length === 1) {
    logger.info(
      `[redirect-trace:${provider}] tabId=${tabId} 无二次跳转，最终停留: ${observedChain[0]}`
    );
  }
  return lastProbe;
}

/**
 * 缓存某提供商的 sid（委托 shared/session-cache 统一实现）
 */
async function cacheProviderSid(provider, sid) {
  const ok = await sessionCacheSid(provider, sid);
  if (ok) logger.info(`已缓存 ${provider} sid (来自内容脚本)`);
  return ok;
}

/**
 * 读取某提供商缓存的 sid（委托 shared/session-cache 统一实现）
 */
async function getCachedSid(provider) {
  return sessionGetCachedSid(provider);
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
  // 记录 API 探测的详细信息（含端点和错误），供最终诊断
  let apiProbeDiagnostics = null;

  try {
    // ===== 模式 1：SW API 优先（hybrid / sw-api） =====
    if (mode === 'hybrid' || mode === 'sw-api') {
      // 先看有没有缓存 sid
      const cachedSid = await getCachedSid(account.provider);
      logger_acc.debug(`缓存 sid 状态: ${cachedSid ? '存在' : '无'}`);

      // v0.5.0 修复：即使无缓存 sid，也尝试调 API（163 依赖 Cookie 鉴权可工作）
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

      // API 失败，记录诊断信息
      apiProbeDiagnostics = {
        error: apiResult.error,
        sidExpired: apiResult.sidExpired,
        authBlocked: apiResult.authBlocked,
        needsSid: apiResult.needsSid,
        detail: apiResult.detail,
      };
      // API 失败，sid 可能失效
      if (apiResult.sidExpired) {
        logger_acc.warn('缓存的 sid 已失效，尝试刷新');
        await clearCachedSid(account.provider);
      }

      // 如果 sw-api 模式且 API 失败 → 仅用户主动触发时尝试自动恢复 sid
      // （自动检查不自动开标签，避免影响用户体验）
      if (mode === 'sw-api' && isUserInitiated(context)) {
        // 尝试自动打开后台标签恢复 sid，然后重试 API
        const rec = await autoRecoverSid(account.provider);
        if (rec.success) {
          const apiResult2 = await runSWApiProbe(account.provider, settings);
          if (apiResult2.success) {
            const accountResult = {
              email: account.email,
              provider: account.provider,
              authVerified: true,
              needsAuth: false,
              allFailed: false,
              source: context.source,
              method: 'sw-api',
              unreadCount: apiResult2.unreadCount,
              unreadSource: apiResult2.unreadSource,
              detail: apiResult2.detail,
              timestamp: new Date().toISOString(),
            };
            await saveCheckResult(accountResult);
            logger_acc.info(`自动恢复 sid 后 SW API 探测成功: unread=${apiResult2.unreadCount}`);
            return accountResult;
          }
        }
      }
    }

    // ===== 模式 2：内容脚本探测 =====
    if (mode === 'hybrid' || mode === 'content-script') {
      const contentResult = await runContentProbe(account.provider, { openTab: false });

      if (
        contentResult.probe &&
        contentResult.probe.success &&
        typeof contentResult.probe.unreadCount === 'number'
      ) {
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

      // 已授权但仅落在辅助 frame（如 /contacts/call.do）：单独返回一个更明确的中间态
      if (contentSid) {
        const accountResult = {
          email: account.email,
          provider: account.provider,
          authVerified: true,
          needsAuth: false,
          allFailed: false,
          needsInboxPage: true,
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

      // 标签页关闭后自动检查。
      // 仅用户主动触发（手动全量检查等）时自动打开邮箱后台标签读未读；
      // 后台定时检查（alarm）绝不自动开可见标签，改为标记「需手动同步会话」。
      if ((mode === 'hybrid' || mode === 'content-script') && isUserInitiated(context)) {
        // 跳过不支持内容脚本探测的提供商
        if (!CONTENT_PROBE_PROVIDERS.has(account.provider)) {
          logger_acc.warn(`提供商 ${account.provider} 不支持内容脚本探测，跳过自动恢复`);
        } else {
          logger_acc.info('API 与现有标签探测均失败，尝试自动打开邮箱后台标签读取未读...');
          // 自动打开/复用邮箱后台标签，由内容脚本 in-origin 读取未读（最可靠路径）
          const auto = await runContentProbe(account.provider, {
            openTab: true,
            closeAfterProbe: true,
          });
          const ap = (auto && auto.probe) || {};

          // 1) 内容脚本读到未读数 → 直接作为成功结果返回
          if (ap.success && typeof ap.unreadCount === 'number') {
            const accountResult = {
              email: account.email,
              provider: account.provider,
              authVerified: true,
              needsAuth: false,
              allFailed: false,
              needsInboxPage: false,
              source: context.source,
              method: 'content-script',
              unreadCount: ap.unreadCount,
              unreadSource: ap.unreadSource || null,
              detail: ap.detail || {},
              timestamp: new Date().toISOString(),
            };
            await saveCheckResult(accountResult);
            logger_acc.info(`自动打开后台标签后内容脚本探测成功: unread=${ap.unreadCount}`);
            return accountResult;
          }

          // 2) 已授权（拿到 sid）但未能读到未读数 → 需打开收件箱主页面才能读数
          if (ap.sid || ap.authVerified || ap.success) {
            const accountResult = {
              email: account.email,
              provider: account.provider,
              authVerified: true,
              needsAuth: false,
              allFailed: false,
              needsInboxPage: true,
              source: context.source,
              method: 'content-script',
              unreadCount: typeof ap.unreadCount === 'number' ? ap.unreadCount : null,
              unreadSource: ap.unreadSource || null,
              detail: ap.detail || {},
              timestamp: new Date().toISOString(),
            };
            await saveCheckResult(accountResult);
            logger_acc.info('已授权（sid 已提取），但需打开收件箱主页面才能读到未读数');
            return accountResult;
          }

          // 3) 内容脚本仍失败：hybrid 模式下再用缓存的 sid 重试 SW API 作为兜底
          if (mode === 'hybrid') {
            const apiRetry = await runSWApiProbe(account.provider, settings);
            if (apiRetry.success) {
              const accountResult = {
                email: account.email,
                provider: account.provider,
                authVerified: true,
                needsAuth: false,
                allFailed: false,
                source: context.source,
                method: 'sw-api',
                unreadCount: apiRetry.unreadCount,
                unreadSource: apiRetry.unreadSource,
                detail: apiRetry.detail,
                timestamp: new Date().toISOString(),
              };
              await saveCheckResult(accountResult);
              logger_acc.info(`自动恢复后 SW API 探测成功: unread=${apiRetry.unreadCount}`);
              return accountResult;
            }
          }
        }
      }
    }

    // ===== 所有方法都失败 =====
    // 区分「不支持提供商」与「未授权/无法读取」两种情况
    const unsupported = !CONTENT_PROBE_PROVIDERS.has(account.provider);
    const userTriggered = isUserInitiated(context);
    const autoCheck = context.source === 'alarm';
    const accountResult = {
      email: account.email,
      provider: account.provider,
      authVerified: false,
      needsAuth: !unsupported,
      allFailed: true,
      source: context.source,
      method: 'none',
      needsTab: unsupported ? false : true,
      error: unsupported
        ? `提供商 ${account.provider} 暂不支持自动读取`
        : autoCheck && !userTriggered
          ? '会话已过期：自动检查无法获取邮箱未读数（无有效会话，后台检查不会自动打开标签）'
          : '未授权：无法获取邮箱会话（未检测到 sid / 未打开邮箱登录页）',
      detail: {
        mode,
        apiDiagnostics: apiProbeDiagnostics,
        hint: unsupported
          ? `提供商 ${account.provider} 尚未接入内容脚本或 API 探测，暂时无法自动读取未读数。`
          : autoCheck && !userTriggered
            ? '请在浏览器中打开并登录对应邮箱网页，扩展会自动同步会话并恢复后台自动检查。'
            : '请先在浏览器打开并登录对应邮箱网页（163 / QQ），再点击「同步会话」授权一次，之后扩展即可后台自动读取未读数。',
        action: unsupported ? 'providerNotSupported' : 'openMailboxAndSync',
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
 * v0.5.0 修复：不再因无缓存 sid 返回失败，
 * 交由 provider 自行处理（163 依赖 Cookie 可工作，QQ 无 sid 会标记需要恢复）
 */
async function runSWApiProbe(provider, settings) {
  try {
    // 直接调用 provider 的探测接口（provider 内部会自行读取缓存 sid）
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
      case PROVIDERS.USTC:
        providerResult = await probeUSTC(commonOpts);
        break;
      case PROVIDERS.GMAIL:
        providerResult = await probeGmail(commonOpts);
        break;
      default:
        return { success: false, error: `Unsupported provider: ${provider}` };
    }

    // 解析结果
    const endpointResults = providerResult.results || [];
    const successfulEndpoints = endpointResults.filter(
      (r) => r.success && typeof r.unreadCount === 'number'
    );

    if (successfulEndpoints.length > 0) {
      return {
        success: true,
        unreadCount: successfulEndpoints[0].unreadCount,
        unreadSource: `api:${successfulEndpoints[0].endpointName}`,
        detail: providerResult,
      };
    }

    // 检查是否 sid 过期 / 认证被拦截
    // 对于 QQ：mail.qq.com 旧域接口的 authBlocked 不代表 sid 过期——
    // 用户会话实际在 wx.mail.qq.com，旧域接口因 cookie 域不匹配必然失败。
    // 仅当 wx.mail.qq.com 域接口也报告 authBlocked 时才判定 sid 过期。
    const isQQ = provider === PROVIDERS.QQ;
    const authBlockedAny = endpointResults.some((r) => r.authBlocked);
    const authBlockedOnSessionDomain = isQQ
      ? endpointResults.some((r) => r.authBlocked && /wx\.mail\.qq\.com/i.test(r.url || ''))
      : authBlockedAny;
    const authBlocked = authBlockedAny;
    const needsSid =
      providerResult.needsSid === true ||
      endpointResults.some((r) => r.needsSid === true) ||
      (isQQ && !providerResult.session?.sidObtained && authBlocked);
    return {
      success: false,
      sidExpired: authBlockedOnSessionDomain,
      authBlocked,
      needsSid,
      error: 'API 探测未返回未读数',
      detail: providerResult,
    };
  } catch (err) {
    logger.error(`SW API 探测异常: ${err.message}`, { provider });
    return { success: false, error: err.message };
  }
}

/**
 * 自动恢复 sid：当无现成标签且 API 失败时，自动打开一个隐藏/后台标签
 * 等待内容脚本注入 → 提取 sid → 缓存 → 关闭标签
 * 之后上层可重试 API 探测
 *
 * @returns {Promise<Object>} - { success, probe, tabId }
 *   success: 是否成功恢复 sid
 *   probe: 内容脚本探测结果（含 sid / unreadCount）
 *   tabId: 自动打开的标签 ID（content-script 模式需要保留时返回）
 */
async function autoRecoverSid(provider, { keepTabOpen = false } = {}) {
  const logger_ar = createLogger(`auto-recover:${provider}`);
  logger_ar.info(`尝试自动恢复 ${provider} 的 sid`);

  try {
    // 1. 先检查是否已有打开的邮箱标签（如果有，直接从中探测）
    const existingTab = await findMailboxTab(provider);
    if (existingTab) {
      const probe = await probeTabContent(provider, existingTab.id);
      if (probe && probe.success && probe.sid) {
        await cacheProviderSid(provider, probe.sid);
        logger_ar.info(`从现有标签恢复 ${provider} sid 成功`);
        return { success: true, probe, tabId: existingTab.id };
      }
      // 已有标签但未提取到 sid，尝试导航刷新
      try {
        let openUrl = PROVIDER_OPEN_URL[provider] || PROVIDER_HOME[provider];
        // USTC 需要 sid 参数
        if (provider === 'ustc') {
          const cachedSid = await getCachedSid('ustc');
          if (cachedSid) {
            const sep = openUrl.includes('?') ? '&' : '?';
            openUrl = `${openUrl}${sep}sid=${cachedSid}`;
          }
        }
        await chrome.tabs.update(existingTab.id, {
          url: openUrl,
          active: false,
        });
      } catch (e) {
        logger_ar.warn(`导航现有标签刷新失败: ${e.message}`);
      }
      // 等待页面加载后探测
      const probe2 = await probeWithRetry(provider, existingTab.id, 5, 1500, 20000);
      if (probe2 && probe2.success && probe2.sid) {
        await cacheProviderSid(provider, probe2.sid);
        logger_ar.info(`刷新现有标签后恢复 ${provider} sid 成功`);
        return { success: true, probe: probe2, tabId: existingTab.id };
      }
      return { success: false, probe: probe2, tabId: existingTab.id };
    }

    // 2. 没有现成标签 → 新建后台标签
    const opened = await openMailboxTab(provider);
    if (!opened.success) return { success: false, probe: null, tabId: null };

    const tabId = opened.tabId;
    logger_ar.info(`已打开 ${provider} 后台标签 tabId=${tabId}，等待内容脚本提取 sid...`);

    // 轮询等待内容脚本注入并提取 sid（最多 25 秒）
    const probe = await probeWithRetry(provider, tabId, 8, 2000, 25000);

    if (probe && probe.success && probe.sid) {
      await cacheProviderSid(provider, probe.sid);
      logger_ar.info(`自动恢复 ${provider} sid 成功: ${probe.sid.substring(0, 8)}...`);

      // 默认关闭自动打开的标签；keepTabOpen=true 时保留（content-script 模式需要）
      if (!keepTabOpen) {
        try {
          await chrome.tabs.remove(tabId);
          logger_ar.info('已关闭自动打开的标签');
        } catch (e) {
          logger_ar.warn(`关闭自动标签失败: ${e.message}`);
        }
      }
      return { success: true, probe, tabId };
    }

    // 提取失败
    logger_ar.warn('自动恢复 sid 失败：未能从打开的标签中提取到 sid', {
      probeSuccess: probe?.success,
      probeError: probe?.error,
    });

    // 关闭自动打开的标签
    if (!keepTabOpen) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* ignore */
      }
    }

    return { success: false, probe, tabId };
  } catch (err) {
    logger_ar.error(`自动恢复 sid 异常: ${err.message}`, { stack: err.stack });
    return { success: false, probe: null, tabId: null };
  }
}

/**
 * 清除某提供商的 sid 缓存（委托 shared/session-cache 统一实现）
 */
async function clearCachedSid(provider) {
  const ok = await sessionClearSid(provider);
  if (ok) logger.info(`已清除 ${provider} 的 sid 缓存`);
  return ok;
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
    return {
      success: true,
      message: 'No accounts configured',
      checkResults: [],
      accountCount: 0,
      source,
    };
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
    successfulChecks: allResults.filter((r) => r.authVerified).length,
    failedChecks: allResults.filter((r) => !r.authVerified).length,
    authBlocked: allResults.filter((r) => r.needsAuth).length,
    results: allResults,
  };

  logger.info('全量检查完成', {
    authVerified: summary.successfulChecks,
    needsAuth: summary.authBlocked,
    methods: allResults.map((r) => r.method || 'none').join(','),
  });

  // 检查新邮件并发送通知
  await checkNewEmails(allResults);

  await saveCheckResult(summary);
  await updateBadge(summary);
  return summary;
}

/**
 * 检查新邮件并发送通知
 */
async function checkNewEmails(results) {
  try {
    const lastResults = await getCheckResults(10);
    if (!lastResults.length) return;

    const lastSummary = lastResults.find((r) => r.results && Array.isArray(r.results));
    if (!lastSummary) return;

    const lastByEmail = {};
    for (const r of lastSummary.results) {
      if (r.email && typeof r.unreadCount === 'number') {
        lastByEmail[r.email] = r.unreadCount;
      }
    }

    for (const result of results) {
      if (!result.email || typeof result.unreadCount !== 'number') continue;

      const lastCount = lastByEmail[result.email] || 0;
      const newCount = result.unreadCount;

      if (newCount > lastCount && result.authVerified) {
        // 有新邮件，发送通知
        await sendNewEmailNotification(result);
      }
    }
  } catch (err) {
    logger.warn(`新邮件检查失败: ${err.message}`);
  }
}

/**
 * 发送新邮件通知
 */
async function sendNewEmailNotification(result) {
  try {
    const provider = result.provider;
    const unreadCount = result.unreadCount;

    // 获取提供商名称
    const providerNames = {
      netease_163: '163邮箱',
      qq: 'QQ邮箱',
      ustc: '中科大',
      gmail: 'Gmail',
    };
    const providerName = providerNames[provider] || provider;

    // 构建通知内容
    const notification = {
      type: 'basic',
      iconUrl: 'icons/icon-ok-48.png',
      title: `📧 新邮件通知 - ${providerName}`,
      message: `您有 ${unreadCount} 封未读邮件`,
    };

    // 如果有最新邮件详情，显示详细信息
    if (result.newEmails && result.newEmails.length > 0) {
      const latest = result.newEmails[0];
      notification.message = `新邮件: ${latest.subject}\n来自: ${latest.from}`;
    }

    await chrome.notifications.create(`new-email-${Date.now()}`, notification);
    logger.info(`已发送新邮件通知: ${providerName}, 未读数=${unreadCount}`);
  } catch (err) {
    logger.warn(`发送新邮件通知失败: ${err.message}`);
  }
}

async function runSingleProvider(provider, context = {}) {
  logger.info(`手动运行提供商检查: provider=${provider}, source=${context.source || 'manual'}`);
  const accounts = await getAccounts();
  const matchingAccounts = accounts.filter((a) => a.provider === provider);

  if (!matchingAccounts.length) {
    // 即使没配置账户，也允许手动触发探测（诊断场景）
    const cachedSid = await getCachedSid(provider);
    const cookieDiag = await diagnoseCookies(provider);

    // 尝试 API 探测（v0.5.0：不再需要先有缓存 sid）
    let apiResult = null;
    const settings = await getSettings();
    apiResult = await runSWApiProbe(provider, settings);

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

async function runEndpointTest(provider, endpointName) {
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
  const checkResults = await getCheckResults(50);
  const alarm = await chrome.alarms.get('check-email');

  // 检查是否有缓存 sid
  const sid163 = await getCachedSid('netease_163');
  const sidQQ = await getCachedSid('qq');

  // 检查 API pattern 数量
  const apiP163 = await getApiPatterns('netease_163');
  const apiPQQ = await getApiPatterns('qq');

  // ===== 聚合每个账户的最新状态 =====
  // recentResults 中保存了各账户单独的检查结果（含 email/provider/unreadCount 字段），
  // 以及 runAllChecks 的 summary 结果（含嵌套 results 数组）。这里提取每个账号最新状态。
  const perAccount = accounts.map((acc) => {
    // 找到匹配该账号 email 的最新单账户结果
    const result = checkResults.find(
      (r) =>
        r.email === acc.email &&
        (typeof r.unreadCount === 'number' ||
          r.authVerified !== undefined ||
          r.needsAuth !== undefined)
    );
    // 也可能是 summary.results 里嵌套的对应账号条目
    const nested = checkResults
      .find((r) => Array.isArray(r.results))
      ?.results?.find((rr) => rr.email === acc.email);

    const matched = result || nested;
    return {
      email: acc.email,
      provider: acc.provider,
      authVerified: matched?.authVerified === true,
      needsAuth: matched?.needsAuth === true,
      needsInboxPage: matched?.needsInboxPage === true,
      unreadCount: matched && typeof matched.unreadCount === 'number' ? matched.unreadCount : null,
      method: matched?.method || null,
      error: matched?.error || null,
      timestamp: matched?.timestamp || null,
      hasSid: acc.provider === 'netease_163' ? !!sid163 : acc.provider === 'qq' ? !!sidQQ : false,
    };
  });

  return {
    success: true,
    accounts: accounts.map((a) => ({ email: a.email, provider: a.provider })),
    accountStatus: perAccount,
    accountCount: accounts.length,
    settings,
    cachedSids: {
      netease_163: !!sid163,
      qq: !!sidQQ,
    },
    apiPatternCounts: {
      netease_163: apiP163.length,
      qq: apiPQQ.length,
    },
    alarmConfigured: !!alarm,
    alarmInfo: alarm
      ? {
          periodInMinutes: alarm.periodInMinutes,
          scheduledTime: new Date(alarm.scheduledTime).toISOString(),
        }
      : null,
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
    await chrome.alarms.create('check-email', {
      delayInMinutes: 1,
      periodInMinutes: intervalMinutes,
    });
  } catch (err) {
    logger.error(`闹钟注册失败: ${err.message}`);
    throw err;
  }
}

// ===== 工具栏图标状态（图标颜色反映插件运行状态）=====
// 资源: extension/icons/icon-{ok|err|off}-{16|32|48|128}.png
//   ok  = 正常（绿）  ：至少一个账户正常读取到未读/已授权
//   err = 错误（红）  ：存在真实检查错误或异常
//   off = 停用/不可用（灰）：未配置账户，或会话全部失效需手动同步
const TOOLBAR_ICON_SIZES = [16, 32, 48, 128];
const TOOLBAR_STATE_COLORS = { ok: '#26A65B', err: '#E74C3C', off: '#95A5A6' };

function iconPaths(state) {
  const paths = {};
  for (const s of TOOLBAR_ICON_SIZES) paths[s] = 'icons/icon-' + state + '-' + s + '.png';
  return paths;
}

/**
 * 预解码 + 缓存各状态图标为 ImageData。
 *
 * 背景：在 MV3 Service Worker（Chrome/Edge）中，用 `chrome.action.setIcon({ path })`
 * 传入图标文件路径，存在偶发「未生效 / 静默失败」的问题 —— 图标一直停留在
 * manifest 里 default_icon（灰 off）而不随运行状态变色，但 badge 颜色却能正常切换。
 * 改用 `imageData`（像素级）设置工具栏图标是官方推荐的可靠方式，
 * 可规避路径图标异步加载/缓存导致的颜色不刷新问题。
 */
let ICON_IMAGEDATA_CACHE = null;

async function decodeIconToImageData(state, size) {
  const url = chrome.runtime.getURL(`icons/icon-${state}-${size}.png`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`);
  const blob = await resp.blob();
  const bmp = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return ctx.getImageData(0, 0, bmp.width, bmp.height);
  } finally {
    if (bmp.close) bmp.close();
  }
}

/** 懒加载各状态图标 ImageData 缓存 */
async function ensureIconImageDataCache() {
  if (ICON_IMAGEDATA_CACHE) return ICON_IMAGEDATA_CACHE;
  const cache = {};
  for (const state of Object.keys(TOOLBAR_STATE_COLORS)) {
    cache[state] = {};
    for (const s of TOOLBAR_ICON_SIZES) {
      try {
        cache[state][s] = await decodeIconToImageData(state, s);
      } catch (err) {
        logger.debug(`解码工具栏图标失败 ${state}-${s}: ${err.message}`);
      }
    }
  }
  ICON_IMAGEDATA_CACHE = cache;
  return cache;
}

/** 切换工具栏图标为指定状态颜色（优先用 imageData，失败时回退 path） */
async function applyToolbarIcon(state) {
  try {
    const cache = await ensureIconImageDataCache();
    const sizes = cache && cache[state];
    if (sizes && Object.keys(sizes).length > 0) {
      await chrome.action.setIcon({ imageData: sizes });
    } else {
      // 解码全部失败时的兜底：仍走路径方案
      await chrome.action.setIcon({ path: iconPaths(state) });
    }
  } catch (err) {
    logger.debug('设置工具栏图标失败: ' + err.message);
  }
}

/** 账户结果是否「正常」：能读到未读或已授权 */
function accountNormal(r) {
  return r && (r.authVerified === true || typeof r.unreadCount === 'number');
}
/** 账户是否「不可用/需授权」：会话失效、需打开收件箱或需手动同步 */
function accountNeedAuth(r) {
  return (
    r &&
    (r.needsAuth === true ||
      r.needsInboxPage === true ||
      r.loginRequired === true ||
      r.sidExpired === true ||
      r.needsSid === true)
  );
}
/** 账户是否「真实错误」：检查抛出异常/明确失败，且并非单纯的"需授权"问题 */
function accountError(r) {
  return (
    r &&
    (r.success === false ||
      (r.allFailed === true && r.needsAuth !== true) ||
      (r.error && !accountNeedAuth(r)))
  );
}

/**
 * 由聚合的账户级结果推算出整体运行状态：
 *   有真实错误 → err(红) ；有正常账户 → ok(绿) ；否则 → off(灰/需同步)
 */
function computeIconState(allResults) {
  const list = Array.isArray(allResults) ? allResults : [];
  if (list.length === 0) return 'off';
  if (list.some(accountError)) return 'err';
  if (list.some(accountNormal)) return 'ok';
  return 'off';
}

async function updateBadge(summary) {
  if (!summary) return;
  const rawResults = summary.results || [];
  const allResults = [];
  for (const result of rawResults) {
    allResults.push(result);
    if (Array.isArray(result.results)) allResults.push(...result.results);
  }
  // 去重：同 email+provider 只取最新一条
  const seen = new Set();
  const uniq = [];
  for (const result of allResults) {
    const key = result.email || result.provider || '';
    if (result.email && seen.has(key)) continue;
    if (result.email) seen.add(key);
    uniq.push(result);
  }
  try {
    // badge 文本：所有账户未读总数
    let totalUnread = 0;
    let hasUnreadData = false;
    for (const r of uniq) {
      if (typeof r.unreadCount === 'number') {
        totalUnread += r.unreadCount;
        hasUnreadData = true;
      }
    }
    const badgeText = hasUnreadData && totalUnread > 0 ? String(totalUnread) : '';
    await chrome.action.setBadgeText({ text: badgeText });

    // 整体运行状态 → 红(错误)/绿(正常)/灰(停用或不可用)
    const state = computeIconState(uniq);
    await applyToolbarIcon(state);
    await chrome.action.setBadgeBackgroundColor({ color: TOOLBAR_STATE_COLORS[state] });
  } catch (err) {
    logger.debug('工具栏状态更新失败: ' + err.message);
  }
}
/**
 * 从 storage 最近结果重建 badge（用于手动探测等非全量检查场景）
 */
async function updateBadgeFromLatest() {
  try {
    const results = await getCheckResults(20);
    // 提取所有含 email 的账户级结果
    const accountResults = [];
    const seen = new Set();
    for (const r of results) {
      if (r.email && !seen.has(r.email)) {
        seen.add(r.email);
        accountResults.push(r);
      }
      // summary 里的嵌套 results 也要处理
      if (Array.isArray(r.results)) {
        for (const rr of r.results) {
          if (rr.email && !seen.has(rr.email)) {
            seen.add(rr.email);
            accountResults.push(rr);
          }
        }
      }
    }
    if (accountResults.length === 0) {
      // 无任何账户/检查记录 → 置为「停用/不可用」灰色图标
      await applyToolbarIcon('off');
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setBadgeBackgroundColor({ color: TOOLBAR_STATE_COLORS.off });
      return;
    }
    const summary = {
      results: accountResults,
      successfulChecks: accountResults.filter((r) => r.authVerified).length,
      failedChecks: accountResults.filter((r) => !r.authVerified).length,
      authBlocked: accountResults.filter((r) => r.needsAuth).length,
    };
    await updateBadge(summary);
  } catch (err) {
    logger.debug(`Badge 从最近结果更新失败: ${err.message}`);
  }
}

logger.info('Service Worker 启动');
setupAlarms().catch((err) => {
  logger.error(`注册闹钟失败: ${err.message}`);
});
// 启动/安装后按最近一次检查结果刷新工具栏图标颜色与未读徽标
updateBadgeFromLatest().catch(() => {});
