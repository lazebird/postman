/**
 * gmail-oauth.js - Gmail OAuth2 跨浏览器令牌管理
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
 *   - 仅用户主动触发（Popup/Options 点击"同步 Gmail"）时调用 authorizeGmailInteractive()，
 *     launchWebAuthFlow 会弹出 Google 授权页——属用户主动操作。
 *   - 后台定时检查（alarm）绝不开新标签、不弹授权页，只读取已缓存的令牌
 *     （getCachedGmailToken），令牌缺失/过期则标记"需手动同步"，引导用户手动授权一次。
 *
 * 令牌说明：
 *   - launchWebAuthFlow 采用 implicit flow（response_type=token），拿到的是短时效 access token
 *     （默认约 1 小时），无法在纯静态扩展内做 refresh token 交换（那需要后端）。
 *   - 因此令牌带 expires 时间戳缓存：后台检查读到过期令牌时返回 null，
 *     交由调用方提示"需手动同步"（引导用户到 Popup/Options 点击同步授权，重新换取新令牌）。
 */

import { createLogger } from './debug.js';
import { PROVIDER_CONFIG } from './constants.js';

const logger = createLogger('gmail-oauth');

// 存储键
const STORAGE_KEY = 'gmail_access_token';
const STORAGE_EXPIRY_KEY = 'gmail_access_token_expiry';

// Gmail API 权限范围
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
];

// 提前多少毫秒认为令牌"即将过期"，避免边界竞态
const EXPIRY_SLACK_MS = 60 * 1000;

/**
 * 读取 Gmail 缓存的 access token（后台自动检查用，绝不开标签、不弹窗）。
 *
 * @returns {Promise<string|null>} 有效令牌；未授权 / 过期 / 读取失败时返回 null
 */
export async function getCachedGmailToken() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY, STORAGE_EXPIRY_KEY]);
    const token = data[STORAGE_KEY];
    if (!token) {
      logger.debug('无缓存的 Gmail 令牌，需要手动授权');
      return null;
    }
    const expiry = data[STORAGE_EXPIRY_KEY];
    if (expiry && Date.now() >= expiry - EXPIRY_SLACK_MS) {
      logger.debug('缓存的 Gmail 令牌已过期，需要手动重新授权');
      await clearGmailToken();
      return null;
    }
    return token;
  } catch (err) {
    logger.warn(`读取 Gmail 令牌失败: ${err.message}`);
    return null;
  }
}

/**
 * 持久化 Gmail access token（含过期时间）。
 *
 * @param {string} token
 * @param {number} expiresInSec 令牌有效秒数（来自 OAuth 响应 expires_in）
 */
async function persistGmailToken(token, expiresInSec) {
  const expiry = expiresInSec
    ? Date.now() + expiresInSec * 1000
    : Date.now() + 55 * 60 * 1000; // 无 expires_in 时兜底按 55 分钟
  await chrome.storage.local.set({
    [STORAGE_KEY]: token,
    [STORAGE_EXPIRY_KEY]: expiry,
  });
  logger.info(`Gmail 令牌已缓存，有效期至 ${new Date(expiry).toISOString()}`);
}

/**
 * 清除缓存的 Gmail 令牌。
 */
export async function clearGmailToken() {
  try {
    await chrome.storage.local.remove([STORAGE_KEY, STORAGE_EXPIRY_KEY]);
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
 *   ...#error=access_denied
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
 * 用户主动授权的交互式 OAuth 流程（Chrome / Edge 通用）。
 * 通过 chrome.identity.launchWebAuthFlow 弹出 Google 授权页，用户确认后
 * 取得 access token 并持久化。仅可在用户主动点击时调用。
 *
 * @returns {Promise<{success:boolean, token?:string, error?:string, needsManual?:boolean}>}
 */
export async function authorizeGmailInteractive() {
  const cfg = PROVIDER_CONFIG['gmail']?.oauth2;
  const clientId = cfg?.clientId;
  if (!clientId || clientId === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
    return { success: false, error: 'Gmail OAuth Client ID 未配置，请在 constants.js 中填写正确的 clientId' };
  }

  const scopes = (cfg?.scopes?.length ? cfg.scopes : GMAIL_SCOPES).join(' ');
  // Chrome 扩展 OAuth2 约定：redirect_uri 使用 chromiumapp.org 域。
  // Edge 的 launchWebAuthFlow 同样支持该 redirect（需在 Google Cloud 的 OAuth
  // 客户端中同时登记 Chrome 与 Edge 两条 chromiumapp.org 重定向，或使用相同客户端）。
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    '&response_type=token' +
    `&scope=${encodeURIComponent(scopes)}` +
    '&prompt=consent';

  try {
    logger.info('启动 Gmail OAuth2 授权（launchWebAuthFlow）...');
    const redirectUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl, interactive: true },
        (result) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        }
      );
    });

    if (!redirectUrl) {
      return { success: false, error: '授权流程未返回跳转地址，可能被用户取消', needsManual: true };
    }

    const parsed = parseAuthResponse(redirectUrl);
    if (!parsed) {
      return { success: false, error: '无法解析授权回调结果', needsManual: true };
    }
    if (parsed.error) {
      logger.warn(`Gmail 授权被拒绝: ${parsed.error}`);
      return { success: false, error: `Gmail 授权失败：${parsed.error}`, needsManual: true };
    }

    await persistGmailToken(parsed.token, parsed.expiresIn);
    return { success: true, token: parsed.token };
  } catch (err) {
    logger.warn(`Gmail 授权异常: ${err.message}`);
    // Edge/Chrome 对 launchWebAuthFlow 内部错误统一兜底提示
    return { success: false, error: err.message, needsManual: true };
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
