/**
 * gmail-oauth.js - Gmail OAuth2 跨浏览器令牌管理与静默续期
 *
 * 目标：同时兼容 Chrome 与 Microsoft Edge。
 *
 * 背景：
 *   - Chrome：官方推荐 chrome.identity.getAuthToken（依赖浏览器托管的身份令牌）。
 *   - Edge：  对本地侧载 / 未发布扩展不提供 chrome.identity.getAuthToken，
 *             直接返回 "This API is not supported on Microsoft Edge."，
 *             但 chrome.identity.launchWebAuthFlow 在两个浏览器上都受支持。
 *
 * 因此统一改为 launchWebAuthFlow 获取 access token，并将令牌持久化到
 * chrome.storage.local（符合 AGENTS 规则 3：会话数据优先持久化存储）。
 *
 * 关键约定（遵守 AGENTS 规则 1）：
 *   - 交互式授权 authorizeGmailInteractive()：仅用户主动触发（Popup/Options 点击
 *     "同步 Gmail"）时调用，launchWebAuthFlow interactive=true + prompt=consent 会
 *     弹出 Google 授权页——属用户主动操作。
 *   - 静默续期 renewGmailTokenSilently()：令牌过期时，用 interactive=false +
 *     prompt=none 在**不弹窗、不开任何可见标签**的前提下尝试重新换取令牌（此时
 *     浏览器里仍保有 Google 登录会话则可静默成功；否则 Google 返回
 *     interaction_required 等错误并失败）。该路径可安全用于后台定时检查，
 *     不会打断用户（AGENTS 规则 1/2）。
 *   - 定时自动检查优先走「静默续期」恢复令牌；仅当续期也失败（确需用户交互）时
 *     标记"需手动同步"，由上层发节流通知引导用户在 Popup/Options 手动授权一次。
 *
 * 令牌说明：
 *   - launchWebAuthFlow 采用 implicit flow（response_type=token），拿到的是短时效
 *     access token（默认约 1 小时），无法在纯静态扩展内做 refresh token 交换
 *     （那需要后端）。因此令牌带 expires 时间戳缓存；过期后先尝试静默续期，
 *     续期失败才退回"需手动同步"。
 */

import { createLogger } from './debug.js';
import { GMAIL_TOKEN_KEYS, GMAIL_RENEWAL_KEYS, PROVIDER_CONFIG } from './constants.js';

const logger = createLogger('gmail-oauth');

// Gmail API 权限范围
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

// 提前多少毫秒认为令牌"即将过期"，避免边界竞态
const EXPIRY_SLACK_MS = 60 * 1000;

// 静默续期两次尝试的最小间隔：无有效会话时每次续期都会请求 Google 授权端点并失败，
// 若每次 alarm 都重试既浪费又可能触达限流，故做节流（默认 30 分钟重试一次）。
const SILENT_RENEW_RETRY_MS = 30 * 60 * 1000;

/**
 * 读取 Gmail 缓存的 access token（后台自动检查用，绝不开标签、不弹窗）。
 *
 * 注意：这是"纯缓存读取"，过期令牌会被视为无效并返回 null。令牌续期走
 * resolveGmailToken()/renewGmailTokenSilently()，本函数不触发任何网络请求。
 *
 * @returns {Promise<string|null>} 有效令牌；未授权 / 过期 / 读取失败时返回 null
 */
export async function getCachedGmailToken() {
  const { token } = await readTokenState();
  if (!token) {
    logger.debug('无缓存的 Gmail 令牌或已过期，需静默续期 / 手动授权');
  }
  return token;
}

/**
 * 读取令牌原始状态（含"是否曾经授权过"）。
 *
 * @returns {Promise<{token:string|null, hadToken:boolean, expired:boolean}>}
 *   token    ：仅当仍有效（未过期）时返回令牌；过期则返回 null
 *   hadToken ：是否曾缓存过令牌（用于判断是否值得尝试静默续期）
 *   expired  ：令牌存在但已过期
 */
async function readTokenState() {
  try {
    const data = await chrome.storage.local.get([GMAIL_TOKEN_KEYS.TOKEN, GMAIL_TOKEN_KEYS.EXPIRY]);
    const stored = data[GMAIL_TOKEN_KEYS.TOKEN];
    const expiry = data[GMAIL_TOKEN_KEYS.EXPIRY];
    if (!stored) return { token: null, hadToken: false, expired: false };
    const expired = !!(expiry && Date.now() >= expiry - EXPIRY_SLACK_MS);
    if (expired) {
      return { token: null, hadToken: true, expired: true };
    }
    return { token: stored, hadToken: true, expired: false };
  } catch (err) {
    logger.warn(`读取 Gmail 令牌状态失败: ${err.message}`);
    return { token: null, hadToken: false, expired: false };
  }
}

/**
 * 读取有效 Gmail access token；若缓存已过期，则（可选）先尝试静默续期。
 *
 * 这是后台自动检查的推荐入口：
 *   1. 有有效缓存令牌 → 直接返回（source='cache'）。
 *   2. 令牌缺失/过期且 allowSilentRenew=true 且曾授权过 → 尝试静默续期
 *      （不弹窗/不开标签），成功则返回（source='silent-renew'）。
 *   3. 否则返回 null，并给出可用于节流通知的原因（needsManual / renewalFailed）。
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.allowSilentRenew=false] 是否允许在后台触发静默续期
 * @returns {Promise<{token:string|null, source:string, hadToken:boolean,
 *                     renewalAttempted:boolean, renewalFailed:boolean, reason?:string}>}
 */
export async function resolveGmailToken({ allowSilentRenew = false } = {}) {
  const { token, hadToken } = await readTokenState();
  if (token) return { token, source: 'cache', hadToken, renewalAttempted: false };

  if (allowSilentRenew && hadToken) {
    const renew = await renewGmailTokenSilently();
    if (renew.success && renew.token) {
      return {
        token: renew.token,
        source: 'silent-renew',
        hadToken,
        renewalAttempted: true,
        renewalFailed: false,
      };
    }
    return {
      token: null,
      source: hadToken ? 'renew-failed' : 'no-token',
      hadToken,
      renewalAttempted: true,
      renewalFailed: true,
      reason: renew.reason || renew.error || '静默续期失败',
    };
  }

  return {
    token: null,
    source: hadToken ? 'expired' : 'no-token',
    hadToken,
    renewalAttempted: false,
    renewalFailed: false,
    reason: hadToken ? '令牌已过期' : '尚未授权',
  };
}

/**
 * 持久化 Gmail access token（含过期时间）。
 *
 * @param {string} token
 * @param {number} expiresInSec 令牌有效秒数（来自 OAuth 响应 expires_in）
 */
async function persistGmailToken(token, expiresInSec) {
  const expiry = expiresInSec ? Date.now() + expiresInSec * 1000 : Date.now() + 55 * 60 * 1000; // 无 expires_in 时兜底按 55 分钟
  await chrome.storage.local.set({
    [GMAIL_TOKEN_KEYS.TOKEN]: token,
    [GMAIL_TOKEN_KEYS.EXPIRY]: expiry,
  });
  logger.info(`Gmail 令牌已缓存，有效期至 ${new Date(expiry).toISOString()}`);
}

/**
 * 清除缓存的 Gmail 令牌。
 */
export async function clearGmailToken() {
  try {
    await chrome.storage.local.remove([GMAIL_TOKEN_KEYS.TOKEN, GMAIL_TOKEN_KEYS.EXPIRY]);
    logger.info('已清除缓存的 Gmail 令牌');
  } catch (err) {
    logger.warn(`清除 Gmail 令牌失败: ${err.message}`);
  }
}

/**
 * 解析 launchWebAuthFlow 返回的 redirectUrl 中的 access_token。
 *
 * implicit flow 的 redirectUrl 形如：
 *   https://<extension-id>.chromiumapp.org/#access_token=...&expires_in=3600&token_type=Bearer
 * 或携带错误：
 *   ...#error=access_denied / error=interaction_required
 *
 * @param {string} redirectUrl
 * @returns {{token:string, expiresIn:number}|{error:string}|null}
 */
function parseAuthResponse(redirectUrl) {
  try {
    const url = new URL(redirectUrl);
    const params = new URLSearchParams(url.hash ? url.hash.slice(1) : url.search.slice(1));
    const error = params.get('error');
    if (error) return { error };
    const token = params.get('access_token');
    if (!token) return null;
    const expiresIn = parseInt(params.get('expires_in') || '0', 10);
    return { token, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 0 };
  } catch (err) {
    logger.warn(`解析 OAuth 回调失败: ${err.message}`);
    return null;
  }
}

/**
 * 构造 Google OAuth2 授权 URL。
 *
 * @param {string} prompt 'consent'（强制重新授权，交互式用）或 'none'（静默续期用）
 */
function buildAuthUrl(prompt) {
  const cfg = PROVIDER_CONFIG['gmail']?.oauth2;
  const clientId = cfg?.clientId;
  const scopes = (cfg?.scopes?.length ? cfg.scopes : GMAIL_SCOPES).join(' ');
  // Chrome 扩展 OAuth2 约定：redirect_uri 使用 chromiumapp.org 域。
  // Edge 的 launchWebAuthFlow 同样支持该 redirect（需在 Google Cloud 的 OAuth
  // 客户端中同时登记 Chrome 与 Edge 两条 chromiumapp.org 重定向，或使用相同客户端）。
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  return (
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_type=token' +
    `&scope=${encodeURIComponent(scopes)}` +
    `&prompt=${encodeURIComponent(prompt)}`
  );
}

/**
 * 校验 clientId 是否已配置。
 */
function clientIdReady() {
  const cfg = PROVIDER_CONFIG['gmail']?.oauth2;
  const clientId = cfg?.clientId;
  return !!(clientId && clientId !== 'YOUR_CLIENT_ID.apps.googleusercontent.com');
}

/**
 * 统一的 launchWebAuthFlow 封装（可按 interactive 开关静默/交互）。
 *
 * @param {Object} opts { prompt:'consent'|'none', interactive:boolean, force?:boolean }
 * @returns {Promise<{success:boolean, token?:string, error?:string, needsManual?:boolean,
 *                    reason?:string}>}
 */
async function runWebAuthFlow({ prompt, interactive, force = false }) {
  if (!clientIdReady()) {
    return {
      success: false,
      error: 'Gmail OAuth Client ID 未配置，请在 constants.js 中填写正确的 clientId',
      reason: 'client-id-missing',
    };
  }

  // 静默续期做节流：距上次尝试不足 SILENT_RENEW_RETRY_MS 时直接放弃本次重试
  // （force 用于手动触发时跳过节流检查）。
  if (prompt === 'none' && interactive === false && !force) {
    const allow = await silentRenewGate();
    if (!allow) {
      return {
        success: false,
        error: '静默续期尝试过于频繁，已跳过本次',
        reason: 'throttled',
        throttled: true,
      };
    }
  }

  const authUrl = buildAuthUrl(prompt);
  try {
    logger.info(
      `启动 Gmail OAuth2 ${interactive ? '交互授权' : '静默续期'}（launchWebAuthFlow）...`
    );
    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });

    if (!redirectUrl) {
      return {
        success: false,
        error: '授权流程未返回跳转地址，可能被用户取消',
        needsManual: true,
        reason: 'no-redirect',
      };
    }

    const parsed = parseAuthResponse(redirectUrl);
    if (!parsed) {
      return {
        success: false,
        error: '无法解析授权回调结果',
        needsManual: true,
        reason: 'parse-fail',
      };
    }
    if (parsed.error) {
      logger.warn(`Gmail 授权/续期未完成: ${parsed.error}`);
      // interaction_required / login_required：说明无可用 Google 会话，需用户交互授权。
      const needsManual = !interactive;
      return {
        success: false,
        error: `Gmail ${interactive ? '授权' : '续期'}失败：${parsed.error}`,
        needsManual,
        reason: parsed.error,
      };
    }

    await persistGmailToken(parsed.token, parsed.expiresIn);
    return { success: true, token: parsed.token };
  } catch (err) {
    logger.warn(`Gmail OAuth2 异常: ${err.message}`);
    // interactive=false 静默续期失败最常见的表现是抛错
    // "Authorization page could not be loaded." / "User interaction is required"，
    // 此时**绝不弹窗/开标签**，交由上层引导用户手动授权。
    return {
      success: false,
      error: err.message,
      needsManual: !interactive,
      reason: 'web-auth-error',
    };
  }
}

/**
 * 用户主动授权的交互式 OAuth 流程（Chrome / Edge 通用）。
 * 通过 chrome.identity.launchWebAuthFlow（interactive=true + prompt=consent）弹出
 * Google 授权页，用户确认后取得 access token 并持久化。仅可在用户主动点击时调用。
 *
 * @returns {Promise<{success:boolean, token?:string, error?:string, needsManual?:boolean}>}
 */
export async function authorizeGmailInteractive() {
  return runWebAuthFlow({ prompt: 'consent', interactive: true, force: true });
}

/**
 * 静默续期 Gmail access token（后台安全路径，绝不开标签、不弹授权窗）。
 *
 * 使用 launchWebAuthFlow interactive=false + prompt=none：浏览器中若仍保有 Google
 * 登录会话则可无感换取新令牌；否则静默失败（interaction_required / 内部错误），
 * 需用户手动授权。带节流：距上次尝试不足 SILENT_RENEW_RETRY_MS 时跳过重试。
 *
 * @returns {Promise<{success:boolean, token?:string, error?:string, needsManual?:boolean,
 *                    reason?:string, throttled?:boolean}>}
 */
export async function renewGmailTokenSilently() {
  return runWebAuthFlow({ prompt: 'none', interactive: false });
}

/**
 * 静默续期节流门：距上次静默续期尝试是否已足够久（或从未尝试过）。
 * 每次（无论成败）都会更新尝试时间戳。
 *
 * @returns {Promise<boolean>}
 */
async function silentRenewGate() {
  try {
    const data = await chrome.storage.local.get([GMAIL_RENEWAL_KEYS.SILENT_LAST_ATTEMPT]);
    const last = data[GMAIL_RENEWAL_KEYS.SILENT_LAST_ATTEMPT] || 0;
    const now = Date.now();
    // 无论是否放行都刷新时间戳，防止"频繁被限流重试"死循环
    await chrome.storage.local.set({ [GMAIL_RENEWAL_KEYS.SILENT_LAST_ATTEMPT]: now });
    return now - last >= SILENT_RENEW_RETRY_MS;
  } catch (err) {
    logger.warn(`静默续期节流判断失败: ${err.message}`);
    return true;
  }
}

/**
 * 检查当前是否有有效的 Gmail 令牌（用于 UI 展示授权状态）。
 *
 * @returns {Promise<boolean>}
 */
export async function hasGmailToken() {
  return !!(await getCachedGmailToken());
}

/**
 * 判断"需手动授权提醒"是否已到可再次通知的时间（节流）。
 *
 * @param {number} throttleMs 两次提醒的最小间隔毫秒数
 * @returns {Promise<{shouldNotify:boolean, lastNotify:number}>}
 *   当 shouldNotify=true 时，调用方应随后调用 markGmailNotifySent() 记录本次提醒时间。
 */
export async function gmailNotifyGate(throttleMs) {
  try {
    const data = await chrome.storage.local.get([GMAIL_RENEWAL_KEYS.NOTIFY_LAST_TIME]);
    const last = data[GMAIL_RENEWAL_KEYS.NOTIFY_LAST_TIME] || 0;
    const now = Date.now();
    return { shouldNotify: now - last >= throttleMs, lastNotify: last };
  } catch (err) {
    logger.warn(`Gmail 提醒节流判断失败: ${err.message}`);
    return { shouldNotify: true, lastNotify: 0 };
  }
}

/**
 * 记录本次"需手动授权"提醒已发送的时间（配合 gmailNotifyGate 节流）。
 */
export async function markGmailNotifySent() {
  try {
    await chrome.storage.local.set({ [GMAIL_RENEWAL_KEYS.NOTIFY_LAST_TIME]: Date.now() });
  } catch (err) {
    logger.warn(`记录 Gmail 提醒时间失败: ${err.message}`);
  }
}
