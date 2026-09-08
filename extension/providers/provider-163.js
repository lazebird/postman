/**
 * provider-163.js - 163邮箱未读接口探测实现
 *
 * v0.9.6 重构：使用 shared/endpoint-probe.js 通用请求层消除与 QQ/USTC 的重复。
 * 本文件只保留 163 特有的逻辑：
 *   - 163 RPC 接口的认证拦截特征识别
 *   - 163 响应中的未读数解析（Coremail 风格多种格式）
 *
 * v0.8.0 改进：
 *   1. 加入 API pattern 捕获回放支持
 *   2. 多接口格式探测（listMessages / getFolderCount / getUnread）
 *   3. 优化 POST body 构造与 header 处理
 */

import { createLogger } from '../shared/debug.js';
import { PROVIDER_CONFIG } from '../shared/constants.js';
import { clearSid } from '../shared/session-cache.js';
import {
  probeSingleEndpoint,
  findUnreadCount,
  loadProbeContext,
} from '../shared/endpoint-probe.js';

const logger = createLogger('provider-163');
const PROVIDER_ID = 'netease_163';
const SID_KEYS = [
  'unread',
  'unreadCount',
  'unread_count',
  'unreadnum',
  'newCount',
  'newMessageCount',
  'messageCount',
  'unReadCount',
  'folder_unread',
  'inboxCount',
  'inbox_count',
];

/**
 * 探测 163 邮箱未读接口
 */
export async function probe163(options = {}) {
  const config = PROVIDER_CONFIG[PROVIDER_ID];
  const ctx = await loadProbeContext(PROVIDER_ID, config.probeEndpoints, options.endpointNames);
  const { sid, endpoints } = ctx;

  logger.info('开始探测163邮箱未读接口', {
    endpoints: endpoints.map((e) => e.name),
    hasSid: !!sid,
    sidSource: ctx.sidSource,
    capturedCount: ctx.capturedCount,
  });

  const results = [];
  let anySucceeded = false;

  for (const endpoint of endpoints) {
    const result = await probeSingleEndpoint(endpoint, sid, {
      loggerPrefix: '163',
      parseResponse: parse163Response,
      analyzeAuth,
      onAuthBlocked: async () => {
        logger.warn('163 会话已失效，清除缓存的 sid');
        await clearSid(PROVIDER_ID);
      },
    });
    results.push(result);

    if (result.success) {
      anySucceeded = true;
      // 成功即停止，不再继续探测其他接口
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

  logger.info('163 探测完成', {
    authVerified: summary.authVerified,
    needsAuth: summary.needsAuth,
    allFailed,
    authBlocked,
  });

  return summary;
}

/**
 * 分析 163 接口响应，判断认证状态
 */
function analyzeAuth(text, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    return { authBlocked: true, reason: `HTTP ${httpStatus}` };
  }

  if (text.includes('FA_UNAUTHORIZED')) {
    return { authBlocked: true, reason: 'FA_UNAUTHORIZED' };
  }
  if (text.includes('FA_SECURITY')) {
    return { authBlocked: true, reason: 'FA_SECURITY' };
  }
  if (text.includes('No sid parameter')) {
    return { authBlocked: true, reason: 'No sid parameter' };
  }
  if (text.includes('FA_SESSION_EXPIRED')) {
    return { authBlocked: true, reason: 'FA_SESSION_EXPIRED' };
  }
  if (text.includes('FA_INVALID_SESSION')) {
    return { authBlocked: true, reason: 'FA_INVALID_SESSION' };
  }
  if (text.toLowerCase().includes('session expired')) {
    return { authBlocked: true, reason: 'Session expired' };
  }
  if (text.includes('登录后可使用') || text.includes('请先登录') || text.includes('需要登录')) {
    return { authBlocked: true, reason: 'Login required' };
  }

  return { authBlocked: false, reason: null };
}

/**
 * 解析 163 接口响应的未读数
 */
function parse163Response(text) {
  // ===== 策略0: 163 真实 API 响应格式（包含 new Date() 和非标准 JSON）=====
  try {
    let jsonText = text.trim();

    // 移除可能的 JSONP 包裹
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) jsonText = jsonpMatch[1];

    // 将 new Date(...) 替换为 null（日期非必要，只关心 read 标志）
    jsonText = jsonText.replace(/\bnew\s+Date\([^)]*\)/g, 'null');

    // 使用正则提取 var 数组中的邮件列表
    const varMatch = jsonText.match(/'var'\s*:\s*\[([\s\S]*)\]/);
    if (!varMatch) {
      const varMatch2 = jsonText.match(/"var"\s*:\s*\[([\s\S]*)\]/);
      if (!varMatch2) {
        return { hasResult: false, unreadCount: null };
      }
    }

    // 统计未读邮件（没有 read:true 标志）
    let unreadCount = 0;
    const emailRegex = /\{\s*'id'\s*:/g;
    let emailMatch;

    while ((emailMatch = emailRegex.exec(jsonText)) !== null) {
      const nextEmail = jsonText.substring(emailMatch.index + 1).match(/\{\s*'id'\s*:/);
      let emailEnd;
      if (nextEmail) {
        // 有下一封邮件：当前邮件到下一封的 '{' 之前结束
        emailEnd = emailMatch.index + 1 + nextEmail.index;
      } else {
        // 最后一封邮件：用括号计数找到匹配的 '}'，而非 indexOf(']')
        // indexOf(']') 会错误命中嵌套数组中的 ']'，导致截断过早
        let braceCount = 0;
        for (let i = emailMatch.index; i < jsonText.length; i++) {
          if (jsonText[i] === '{') braceCount++;
          else if (jsonText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              emailEnd = i + 1;
              break;
            }
          }
        }
      }
      const emailText = jsonText.substring(emailMatch.index, emailEnd);
      const hasRead = /'read'\s*:\s*true/.test(emailText);

      if (!hasRead) unreadCount++;
    }

    if (unreadCount > 0 || text.includes("'code':'S_OK'")) {
      return { hasResult: true, unreadCount };
    }
  } catch {
    // 解析失败，继续尝试其他策略
  }

  // ===== 策略1: XML 格式 =====
  if (text.includes('<result>') || text.includes('<?xml')) {
    const patterns = [
      /<unread[^>]*>\s*(\d+)\s*<\/unread>/i,
      /<count[^>]*>\s*(\d+)\s*<\/count>/i,
      /<unreadCount[^>]*>\s*(\d+)\s*<\/unreadCount>/i,
      /<total[^>]*>\s*(\d+)\s*<\/total>/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return { hasResult: true, unreadCount: parseInt(m[1], 10) };
    }
  }

  // ===== 策略2: 标准 JSON =====
  try {
    let jsonText = text.trim();
    const jsonpMatch = jsonText.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
    if (jsonpMatch) jsonText = jsonpMatch[1];
    const data = JSON.parse(jsonText);
    const unread = findUnreadCount(data, SID_KEYS);
    if (unread !== null) {
      return { hasResult: true, unreadCount: unread };
    }
  } catch {
    // fallthrough
  }

  // ===== 策略3: 正则提取 =====
  const regexes = [
    /["']?(?:unread|unreadCount|unread_count|messageCount)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /["']?(?:unreadnum|unreadnumList|unReadCount)["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /(?:unread|new|newMessage)["']?\s*[:=]\s*['"]?\s*(\d+)/i,
  ];
  for (const regex of regexes) {
    const match = text.match(regex);
    if (match) {
      return { hasResult: true, unreadCount: parseInt(match[1], 10) };
    }
  }

  // ===== 策略4: count 模式 =====
  const countMatch = text.match(/[\[,\{]\s*["']?(?:count|total)["']?\s*[:=]\s*(\d+)/i);
  if (countMatch) {
    return { hasResult: true, unreadCount: parseInt(countMatch[1], 10) };
  }

  // ===== 策略5: 163 特有 var 编码格式 =====
  const varUnread =
    text.match(/["']?unreadCount["']?\s*:\s*(\d+)/i) ||
    text.match(/["']?unreadnum["']?\s*:\s*(\d+)/i);
  if (varUnread) {
    return { hasResult: true, unreadCount: parseInt(varUnread[1], 10) };
  }

  // ===== 策略6: 163 js6 RPC var 编码格式 =====
  if (text.includes('var @') || text.includes('@=')) {
    try {
      const atJsonMatch = text.match(/@\{([\s\S]*)\}/);
      if (atJsonMatch) {
        try {
          const data = JSON.parse(atJsonMatch[1]);
          const unread = findUnreadCount(data, SID_KEYS);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch {
          // ignore parse error
        }
      }
      const atEqMatch = text.match(/var\s*@=\s*([\s\S]*?)(?:;|$)/);
      if (atEqMatch) {
        try {
          const data = JSON.parse(atEqMatch[1]);
          const unread = findUnreadCount(data, SID_KEYS);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch {
          // ignore
        }
      }
      const varMatch = text.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
      if (varMatch) return { hasResult: true, unreadCount: parseInt(varMatch[1], 10) };
      const countMatch2 = text.match(/count["']?\s*[:=]\s*["']?(\d+)/i);
      if (countMatch2) return { hasResult: true, unreadCount: parseInt(countMatch2[1], 10) };
    } catch {
      // ignore
    }
  }

  // ===== 策略7: t="..."/c="..." 编码 =====
  if (text.includes('t="') || text.includes("t='")) {
    const tMatch = text.match(/t=["']([^"']+)["']/);
    if (tMatch) {
      try {
        const decoded = decodeURIComponent(tMatch[1]);
        const uMatch = decoded.match(/unread["']?\s*[:=]\s*["']?(\d+)/i);
        if (uMatch) return { hasResult: true, unreadCount: parseInt(uMatch[1], 10) };
      } catch {
        // ignore
      }
    }
  }

  // ===== 策略8: listMessages/getFolderCount/getUnread 嵌套结构 =====
  if (
    text.includes('listMessages') ||
    text.includes('getFolderCount') ||
    text.includes('getUnread')
  ) {
    const jsonMatches = text.match(/\{[^{}]*\}/g);
    if (jsonMatches) {
      for (const seg of jsonMatches) {
        try {
          const data = JSON.parse(seg);
          const unread = findUnreadCount(data, SID_KEYS);
          if (unread !== null) return { hasResult: true, unreadCount: unread };
        } catch {
          // ignore
        }
      }
    }
  }

  return { hasResult: false, unreadCount: null };
}
