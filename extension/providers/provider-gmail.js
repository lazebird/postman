/**
 * provider-gmail.js - Gmail 邮箱未读接口探测实现
 *
 * 仅保留 Atom feed（cookie）单路径（v1.0.2 起）。
 *   通过 SW 跨源 fetch + credentials:'include' 附带浏览器登录态 Cookie，
 *   直调 Google 隐藏 Atom feed（<fullcount> 即全邮箱精确未读数），
 *   零 token、无需 OAuth 商业授权。用户浏览器登录过 Gmail 即可用。
 *   原 OAuth2 / gmail.googleapis.com REST 路径已彻底移除（2026-09-12 决定）。
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';

const logger = createLogger('provider-gmail');

export async function probeGmail(options = {}) {
  const config = PROVIDER_CONFIG['gmail'];

  logger.info('开始探测 Gmail 未读接口');

  // 仅 atom_feed 一个有效端点（cookie 路径）；启用了未知端点名时跳过并告警
  const enabledNames = options.endpointNames?.length
    ? options.endpointNames
    : config.probeEndpoints?.map((e) => e.name) || ['atom_feed'];

  for (const epName of enabledNames) {
    if (epName !== 'atom_feed') {
      logger.warn(`Gmail 未知端点名: ${epName}，跳过`);
      continue;
    }

    const atomResult = await probeGmailAtomFeed();
    if (atomResult.success) {
      logger.info(`Gmail Atom feed 探测成功: unread=${atomResult.unreadCount}`);
      return {
        provider: 'gmail',
        providerName: config.name,
        timestamp: new Date().toISOString(),
        authVerified: true,
        needsAuth: false,
        allFailed: false,
        session: { sidObtained: true, loggedIn: true, source: 'cookie' },
        results: [
          {
            endpointName: 'atom_feed',
            success: true,
            unreadCount: atomResult.unreadCount,
            httpStatus: 200,
          },
        ],
        unreadCount: atomResult.unreadCount,
        newEmails: [],
      };
    }

    // Atom feed 失败：不弹授权、不开标签，标记需手动同步（引导用户在浏览器登录 Gmail）
    logger.warn(`Gmail Atom feed 探测失败: ${atomResult.error}`);
    return {
      provider: 'gmail',
      providerName: config.name,
      timestamp: new Date().toISOString(),
      authVerified: false,
      needsAuth: true,
      allFailed: true,
      session: { sidObtained: false, loggedIn: false, source: 'cookie' },
      results: [],
      error: atomResult.error || 'Gmail Atom feed 不可用，请确认浏览器已登录 Gmail 后重试',
      needsManualAuth: true,
    };
  }

  // 启用的端点均非 atom_feed（默认配置已保证不会发生，防御性兜底）
  return {
    provider: 'gmail',
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: false,
    needsAuth: false,
    allFailed: true,
    session: { sidObtained: false, loggedIn: false, source: 'cookie' },
    results: [],
    error: 'Gmail 无可用探测端点',
  };
}

/**
 * Atom feed 探测（cookie 路径）。
 * 直接 fetch Google 隐藏 Atom feed，浏览器登录态 Cookie 自动附带（credentials:'include'），
 * 无需任何 token。响应 XML 的 <fullcount> 标签即全邮箱精确未读数（非仅返回的 ~20 条 entry）。
 *
 * 端点 URL 取自 PROVIDER_CONFIG.gmail.probeEndpoints 中 name='atom_feed' 的条目，
 * 保持与 163/QQ/USTC 一致的「配置驱动」风格；若配置缺失则回退到内置默认 URL。
 *
 * @returns {Promise<{success: boolean, unreadCount: number|null, error?: string}>}
 */
async function probeGmailAtomFeed() {
  const config = PROVIDER_CONFIG['gmail'];
  const atomEp = (config.probeEndpoints || []).find((e) => e.name === 'atom_feed');
  const url = atomEp?.url || 'https://mail.google.com/mail/u/0/feed/atom';
  try {
    const response = await fetch(url, {
      method: atomEp?.method || 'GET',
      credentials: 'include',
      headers: atomEp?.headers || { Accept: 'application/atom+xml, application/xml' },
    });

    if (!response.ok) {
      // 401/403：Google 风控或端点已废弃（或用户浏览器无有效 Gmail 登录态）
      logger.debug(`Atom feed 返回 ${response.status}`);
      return { success: false, unreadCount: null, error: `atom feed HTTP ${response.status}` };
    }

    const text = await response.text();
    const m = text.match(/<fullcount>(\d+)<\/fullcount>/);
    if (!m) {
      // 200 但无 fullcount 标签（端点响应结构变更）
      logger.debug('Atom feed 响应缺少 <fullcount>');
      return { success: false, unreadCount: null, error: 'atom feed 缺少 fullcount' };
    }

    return { success: true, unreadCount: parseInt(m[1], 10) };
  } catch (err) {
    // 网络层错误（中国大陆网络 / 未登录）：下次检查自动重试
    logger.debug(`Atom feed 网络错误: ${err.message}`);
    return { success: false, unreadCount: null, error: err.message };
  }
}
