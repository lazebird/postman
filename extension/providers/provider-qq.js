/**
 * provider-qq.js - QQ邮箱未读接口探测实现
 *
 * v0.9.6 重构：使用 shared/endpoint-probe.js 通用请求层消除与 163/USTC 的重复。
 * 本文件只保留 QQ 特有的逻辑：
 *   - GB18030 响应解码
 *   - QQ 登录特征识别（ptlogin / 登录页 markers）
 *   - QQ 新版 wx.mail.qq.com 响应格式解析
 *   - sid 清理的 wx 域条件判断
 *
 * v0.8.0 全面重写：
 *   1. 同时探测 mail.qq.com（旧接口）和 wx.mail.qq.com（新网页版）
 *   2. 从 chrome.storage.local 读取缓存 sid
 *   3. 支持 API pattern 捕获回放（captured patterns 优先）
 *   4. 改进响应解析（QQ 新旧版响应格式差异大）
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';
import { clearSid } from '../shared/session-cache.js';
import {
  probeSingleEndpoint,
  findUnreadCount,
  loadProbeContext,
} from '../shared/endpoint-probe.js';

const logger = createLogger('provider-qq');
const PROVIDER_ID = 'qq';
const SID_KEYS = [
  'unread',
  'unreadCount',
  'unread_count',
  'unreadnum',
  'unread_num',
  'messageCount',
  'count',
  'total',
  'newCount',
];

/**
 * 探测 QQ 邮箱未读接口
 */
export async function probeQQ(options = {}) {
  const config = PROVIDER_CONFIG[PROVIDER_ID];
  const ctx = await loadProbeContext(PROVIDER_ID, config.probeEndpoints, options.endpointNames);
  const { sid, endpoints } = ctx;

  logger.info('开始探测QQ邮箱未读接口', {
    endpoints: endpoints.map((e) => e.name),
    hasSid: !!sid,
    sidSource: ctx.sidSource,
    capturedCount: ctx.capturedCount,
  });

  const results = [];
  let anySucceeded = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, sid, {
      loggerPrefix: 'qq',
      decodeResponse,
      analyzeAuth: analyzeQQAuth,
      parseResponse: parseQQResponse,
      onAuthBlocked: (url) => {
        // 仅当请求目标为 wx.mail.qq.com（当前实际会话域）时才清除 sid。
        // mail.qq.com 旧接口因 cookie 域不匹配总会报未登录，sid 在 wx.mail.qq.com 上仍有效，
        // 不应因旧域接口失败而误删有效 sid。
        const isWxDomain = /wx\.mail\.qq\.com/i.test(url);
        if (isWxDomain) {
          logger.warn('QQ 会话已失效或未登录，清除缓存 sid');
          return clearSid(PROVIDER_ID);
        }
        logger.debug('mail.qq.com 域接口认证失败（sid 可能仍适用于 wx.mail.qq.com），不清除 sid');
      },
      defaultHeaders: () => ({
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      }),
    });
    // QQ 特有：单端点结果附加 needsSid 字段（service-worker 据此判断）
    if (result.authBlocked) {
      result.needsSid = !sid;
    }
    results.push(result);

    if (result.success) {
      anySucceeded = true;
      // 成功即停止（不需要继续探测其他接口）
      break;
    }
  }

  const allFailed = results.length > 0 && results.every((r) => !r.success);
  const authBlocked = results.some((r) => r.authBlocked);
  const needsSid = !sid && (allFailed || authBlocked);

  const summary = {
    provider: PROVIDER_ID,
    providerName: config.name,
    timestamp: new Date().toISOString(),
    authVerified: anySucceeded,
    needsAuth: allFailed && !anySucceeded && !needsSid,
    allFailed,
    needsSid,
    session: {
      sidObtained: !!sid,
      sid: sid ? sid.substring(0, 8) + '...' : null,
      loggedIn: anySucceeded || sid !== null,
      source: ctx.sidSource,
    },
    results,
  };

  logger.info('QQ 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
    needsSid,
  });

  return summary;
}

/**
 * 解码响应内容（处理 GB18030 等非 UTF-8 编码）
 */
async function decodeResponse(response) {
  const contentType = response.headers?.get?.('content-type') || '';
  const isGB18030 =
    contentType.includes('gb18030') ||
    contentType.includes('gbk') ||
    contentType.includes('gb2312');

  try {
    const arrayBuffer = await response.arrayBuffer();
    if (isGB18030) {
      try {
        return new TextDecoder('gb18030').decode(arrayBuffer);
      } catch {
        return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer);
  } catch {
    return await response.text();
  }
}

/**
 * 分析 QQ 接口响应，判断认证状态
 */
function analyzeQQAuth(text, httpStatus, finalUrl) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  const loginMarkers = [
    'gbIsNoCheck',
    'loginFrame',
    'qm_login',
    '需要登录',
    '您还未登录',
    'session expired',
    'cgierrorcode:-2',
    '登录QQ邮箱',
  ];

  for (const marker of loginMarkers) {
    if (text.includes(marker)) {
      return { authBlocked: true, reason: marker };
    }
  }

  if (finalUrl && (finalUrl.includes('/cgi-bin/login') || finalUrl.includes('ptlogin'))) {
    return { authBlocked: true, reason: 'redirected to login' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 QQ 邮箱响应的未读数（多种格式探测）
 */
function parseQQResponse(text) {
  // ===== 策略0: QQ 新版 API 返回 unread_num 字段 =====
  try {
    const data = JSON.parse(text.trim());
    if (typeof data.body === 'object' && data.body !== null) {
      const unreadNum = data.body.unread_num;
      if (typeof unreadNum === 'number' && unreadNum >= 0) {
        return { hasResult: true, unreadCount: unreadNum };
      }
    }
    const unread = findUnreadCount(data, SID_KEYS);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {
    // 非标准 JSON，继续
  }

  // ===== 策略1: JSON 直接解析 =====
  try {
    const data = JSON.parse(text.trim());
    const unread = findUnreadCount(data, SID_KEYS);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {
    // ignore
  }

  // ===== 策略2: JSONP 去包裹 =====
  try {
    const jsonpMatch = text.trim().match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) {
      const data = JSON.parse(jsonpMatch[1]);
      const unread = findUnreadCount(data, SID_KEYS);
      if (unread !== null) {
        return { hasResult: true, unreadCount: unread };
      }
    }
  } catch {
    // ignore
  }

  // ===== 策略3: QQ 特有格式 - JS 变量赋值 =====
  const varPatterns = [
    /(?:var\s+)?(?:unread|unreadnum|unreadCount|folderCount|total)\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?(?:unreadnum|unread|unreadCount|total|count)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["'](?:unread|count)["']\s*:\s*(\d+)/i,
  ];
  for (const pattern of varPatterns) {
    const match = text.match(pattern);
    if (match) {
      return { hasResult: true, unreadCount: parseInt(match[1], 10) };
    }
  }

  // ===== 策略4: HTML 页面中的未读计数 =====
  const htmlPatterns = [
    /data-unread=["'](\d+)["']/i,
    /class=["'][^"']*unread[^"']*["'][^>]*>\s*(\d+)\s*</i,
    /class=["'][^"']*count[^"']*["'][^>]*>\s*(\d+)\s*</i,
    />(\d+)\s*<\/[^>]+>\s*<[^>]+>\s*收件箱/i,
  ];
  for (const pattern of htmlPatterns) {
    const m = text.match(pattern);
    if (m) {
      return { hasResult: true, unreadCount: parseInt(m[1], 10) };
    }
  }

  // ===== 策略5: QQ 收件箱页面特定格式 =====
  const folderMatch = text.match(/收件箱[^>]{0,50}?[\(（]\s*(\d+)\s*[\)）]/);
  if (folderMatch) {
    return { hasResult: true, unreadCount: parseInt(folderMatch[1], 10) };
  }

  return { hasResult: false, unreadCount: null };
}
