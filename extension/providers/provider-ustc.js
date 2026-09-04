/**
 * provider-ustc.js - USTC邮箱未读接口探测实现
 *
 * v0.9.6 重构：使用 shared/endpoint-probe.js 通用请求层消除与 163/QQ 的重复。
 * 本文件只保留 USTC 特有的逻辑：
 *   - USTC (Coremail) 认证拦截特征识别
 *   - USTC getAllFolders 响应解析（unreadMessageCount 累加）
 *
 * USTC 使用 Coremail 系统，API 格式与 163 类似。
 * 主要接口：
 * - getAllFolders: 获取所有文件夹及未读数（返回 unreadMessageCount）
 * - getAttrs: 获取用户属性
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';
import { clearSid } from '../shared/session-cache.js';
import {
  probeSingleEndpoint,
  findUnreadCount,
  loadProbeContext,
} from '../shared/endpoint-probe.js';

const logger = createLogger('provider-ustc');
const PROVIDER_ID = 'ustc';
const SID_KEYS = [
  'unread',
  'unreadCount',
  'unread_count',
  'unreadMessageCount',
  'messageCount',
  'count',
  'total',
];

/**
 * 探测 USTC 邮箱未读接口
 */
export async function probeUSTC(options = {}) {
  const config = PROVIDER_CONFIG[PROVIDER_ID];
  const ctx = await loadProbeContext(PROVIDER_ID, config.probeEndpoints, options.endpointNames);
  const { sid, endpoints } = ctx;

  logger.info('开始探测USTC邮箱未读接口', {
    endpoints: endpoints.map((e) => e.name),
    hasSid: !!sid,
    sidSource: ctx.sidSource,
    capturedCount: ctx.capturedCount,
  });

  const results = [];
  let anySucceeded = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, sid, {
      loggerPrefix: 'ustc',
      parseResponse: parseUSTCResponse,
      analyzeAuth,
      onAuthBlocked: async () => {
        logger.warn('USTC 会话已失效，清除缓存的 sid');
        await clearSid(PROVIDER_ID);
      },
    });
    results.push(result);

    if (result.success) {
      anySucceeded = true;
      break;
    }
  }

  const allFailed = results.length > 0 && results.every((r) => !r.success);
  const authBlocked = results.some((r) => r.authBlocked);

  const summary = {
    provider: PROVIDER_ID,
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded && !authBlocked && !sid,
    allFailed,
    session: {
      sidObtained: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      loggedIn: anySucceeded || sid !== null,
      source: ctx.sidSource,
    },
    results,
  };

  logger.info('USTC 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
  });

  return summary;
}

/**
 * 分析 USTC 接口响应，判断认证状态
 */
function analyzeAuth(text, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  if (text.includes('FA_UNAUTHORIZED') || text.includes('未登录')) {
    return { authBlocked: true, reason: '未登录' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 USTC 接口响应的未读数
 */
function parseUSTCResponse(text) {
  // ===== 策略1: JSON 格式（标准）=====
  try {
    const data = JSON.parse(text.trim());

    // 检查 getAllFolders 响应
    if (data.code === 'S_OK' && Array.isArray(data.var)) {
      let totalUnread = 0;
      for (const folder of data.var) {
        if (folder.stats && typeof folder.stats.unreadMessageCount === 'number') {
          totalUnread += folder.stats.unreadMessageCount;
        }
      }
      if (totalUnread >= 0) {
        return { hasResult: true, unreadCount: totalUnread };
      }
    }

    // 尝试递归查找未读数
    const unread = findUnreadCount(data, SID_KEYS);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {
    // 继续尝试其他策略
  }

  // ===== 策略2: 正则提取 =====
  const regexes = [
    /unreadMessageCount["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /unread["']?\s*[:=]\s*["']?(\d+)["']?/i,
  ];
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match) {
      return { hasResult: true, unreadCount: parseInt(match[1], 10) };
    }
  }

  return { hasResult: false, unreadCount: null };
}
