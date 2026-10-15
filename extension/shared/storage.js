/**
 * storage.js - chrome.storage 封装（存储分层）
 *
 * 存储分层约定（关系到"扩展更新时数据是否丢失"）：
 *
 *  ┌──────────────────────────────┬─────────────────────────────────────────┬──────────────────────┐
 *  │ 数据                          │ 存储区                                  │ 扩展更新 / 浏览器重启 │
 *  ├──────────────────────────────┼─────────────────────────────────────────┼──────────────────────┤
 *  │ 账号配置 accounts            │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ 用户设置 settings            │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ 检查历史 checkResults        │ chrome.storage.local（持久化）          │ ✅ 保留              │
 *  │ sid 会话令牌                 │ chrome.storage.local（持久化）         │ ✅ 保留              │
 *  │ 调试日志 debugLogs           │ chrome.storage.session（会话级）        │ ⚠️ 清空              │
 *  └──────────────────────────────┴─────────────────────────────────────────┴──────────────────────┘
 *
 * 关键结论：
 *  - 账号配置、用户设置、检查历史等【用户数据】一律写入 chrome.storage.local，
 *    该存储区在扩展更新（update）时不丢失，卸载前始终保留 —— 避免"每次插件更新后
 *    账号配置丢失、需重新添加"的体验问题。
 *  - sid 会话令牌持久化到 chrome.storage.local（7 天 TTL），浏览器重启不清空，
 *    减少因 sid 丢失导致的后台检查失败与频繁自动打开标签。
 *  - MV3 Service Worker 上下文【没有】页面级 localStorage，跨上下文共享用户数据
 *    只能使用 chrome.storage.local（等价于持久化的 localStorage 语义）。
 *
 * 优化历史：
 * 1. 添加 chrome.storage.session 权限检查的降级处理
 * 2. 添加 getDebugLogs 导出
 * 3. 更健壮的错误处理
 * 4. 明确持久化/会话两级存储分层，账号配置等用户数据统一落 chrome.storage.local
 */

import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  AUTH_ALERT_KEYS,
  NOTIFY_BASELINE_KEYS,
} from './constants.js';

/* ============================================================
 * 持久级用户数据（chrome.storage.local）
 * —— 扩展更新/浏览器重启均保留，卸载扩展前不丢失
 * ============================================================ */

/**
 * 读取全部账户配置
 * @returns {Promise<Array>}
 */
export async function getAccounts() {
  try {
    const { [STORAGE_KEYS.ACCOUNTS]: accounts = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.ACCOUNTS
    );
    return Array.isArray(accounts) ? accounts : [];
  } catch (e) {
    console.error('[storage] getAccounts failed:', e.message);
    return [];
  }
}

/**
 * 保存账户配置（持久化，扩展更新不丢失）
 * @param {Array} accounts
 */
export async function setAccounts(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNTS]: accounts });
}

/**
 * 读取设置（持久化）
 * @returns {Promise<Object>}
 */
export async function getSettings() {
  try {
    const { [STORAGE_KEYS.SETTINGS]: settings = {} } = await chrome.storage.local.get(
      STORAGE_KEYS.SETTINGS
    );
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    // 关键：始终合并所有默认启用的端点，确保升级后新端点可用。
    // 注意：必须逐端点合并（union），不能直接 {...defaults, ...user} 整体覆盖，
    // 因为如果用户设置里 qq 只有 ['cgi_mail_list']，直接覆盖会把 wx.* 新端点丢掉。
    // 修复：将每个 provider 的用户选择与默认列表做并集。
    const defaultEndpoints = DEFAULT_SETTINGS.enabledEndpoints || {};
    const userEndpoints = settings?.enabledEndpoints || {};
    const allProviders = new Set([...Object.keys(defaultEndpoints), ...Object.keys(userEndpoints)]);
    const mergedEndpoints = {};
    for (const provider of allProviders) {
      const defaults = defaultEndpoints[provider] || [];
      const userList = userEndpoints[provider] || [];
      // 并集去重：如果用户完全没配置（空数组/未定义），用默认；否则默认 ∪ 用户
      mergedEndpoints[provider] = [...new Set([...defaults, ...userList])];
    }
    if (Object.keys(userEndpoints).length > 0 || Object.keys(defaultEndpoints).length > 0) {
      merged.enabledEndpoints = mergedEndpoints;
    }
    return merged;
  } catch (e) {
    console.error('[storage] getSettings failed:', e.message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存设置（持久化，扩展更新不丢失）
 * @param {Object} settings
 */
export async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

/**
 * 保存一次检查结果（持久化，保留最近 100 条）
 * @param {Object} result - { provider, timestamp, success, unreadCount, detail, endpoints }
 */
export async function saveCheckResult(result) {
  try {
    const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.CHECK_RESULTS
    );
    // 避免无限增长：最多保留 100 条
    const newResults = [result, ...(Array.isArray(results) ? results : [])].slice(0, 100);
    await chrome.storage.local.set({ [STORAGE_KEYS.CHECK_RESULTS]: newResults });
  } catch (e) {
    console.error('[storage] saveCheckResult failed:', e.message);
  }
}

/**
 * 读取最近的检查结果
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function getCheckResults(limit = 20) {
  try {
    const { [STORAGE_KEYS.CHECK_RESULTS]: results = [] } = await chrome.storage.local.get(
      STORAGE_KEYS.CHECK_RESULTS
    );
    return (Array.isArray(results) ? results : []).slice(0, limit);
  } catch (e) {
    console.error('[storage] getCheckResults failed:', e.message);
    return [];
  }
}

/* ============================================================
 * 界面语言偏好（chrome.storage.local，持久化）
 * —— 语言选择属 UI 偏好，经本模块读写以保证存储层隔离
 * ============================================================ */

/**
 * 读取界面语言偏好（auto/zh/en，缺省 auto）
 * @returns {Promise<string>}
 */
export async function getLanguagePreference() {
  try {
    const { language } = await chrome.storage.local.get('language');
    return language === 'zh' || language === 'en' || language === 'auto' ? language : 'auto';
  } catch (e) {
    console.error('[storage] getLanguagePreference failed:', e.message);
    return 'auto';
  }
}

/**
 * 保存界面语言偏好（auto/zh/en）
 * @param {string} lang
 */
export async function setLanguagePreference(lang) {
  const v = lang === 'zh' || lang === 'en' || lang === 'auto' ? lang : 'auto';
  await chrome.storage.local.set({ language: v });
}

/* ============================================================
 * 会话级数据（chrome.storage.session）
 * —— 浏览器重启/扩展更新会清空；属临时数据，丢失不影响功能
 * ============================================================ */

/**
 * 读取调试日志（会话级）
 * @param {number} limit
 */
export async function getDebugLogs(limit = 100) {
  try {
    const { debugLogs = [] } = await chrome.storage.session.get('debugLogs');
    return (Array.isArray(debugLogs) ? debugLogs : []).slice(0, limit);
  } catch (e) {
    console.error('[storage] getDebugLogs failed:', e.message);
    return [];
  }
}

/**
 * 读取调试日志（内存缓冲区，实时数据）
 * @param {number} limit
 */
export async function getMemoryLogs(limit = 100) {
  try {
    const { getMemoryLogs: getMem } = await import('./debug.js');
    return typeof getMem === 'function' ? getMem(limit) : [];
  } catch {
    return [];
  }
}

/* ============================================================
 * 授权/会话告警监控数据（chrome.storage.local，持久化）
 * —— 用于在账号授权过期/出错时向用户弹提醒并置红工具栏图标
 * ============================================================ */

/**
 * 读取某账号「最近一次成功授权 / 正常读到未读」的时间戳。
 * @param {string} email
 * @returns {Promise<number>} 无记录时返回 0
 */
export async function getLastAuthOk(email) {
  try {
    const data = await chrome.storage.local.get(AUTH_ALERT_KEYS.LAST_OK_BY_EMAIL);
    const map = data[AUTH_ALERT_KEYS.LAST_OK_BY_EMAIL] || {};
    return typeof map[email] === 'number' ? map[email] : 0;
  } catch (e) {
    console.error('[storage] getLastAuthOk failed:', e.message);
    return 0;
  }
}

/**
 * 记录某账号最近一次成功授权 / 正常读到未读的时间戳。
 * @param {string} email
 */
export async function setLastAuthOk(email) {
  try {
    const data = await chrome.storage.local.get(AUTH_ALERT_KEYS.LAST_OK_BY_EMAIL);
    const map = data[AUTH_ALERT_KEYS.LAST_OK_BY_EMAIL] || {};
    map[email] = Date.now();
    await chrome.storage.local.set({ [AUTH_ALERT_KEYS.LAST_OK_BY_EMAIL]: map });
  } catch (e) {
    console.error('[storage] setLastAuthOk failed:', e.message);
  }
}

/**
 * 读取某账号最近一次「授权需处理」提醒通知时间。
 * @param {string} email
 * @returns {Promise<number>} 无记录时返回 0
 */
export async function getLastAuthNotify(email) {
  try {
    const data = await chrome.storage.local.get(AUTH_ALERT_KEYS.LAST_AUTH_NOTIFY_BY_EMAIL);
    const map = data[AUTH_ALERT_KEYS.LAST_AUTH_NOTIFY_BY_EMAIL] || {};
    return typeof map[email] === 'number' ? map[email] : 0;
  } catch (e) {
    console.error('[storage] getLastAuthNotify failed:', e.message);
    return 0;
  }
}

/**
 * 记录某账号本次「授权需处理」提醒已发送的时间。
 * @param {string} email
 */
export async function setLastAuthNotify(email) {
  try {
    const data = await chrome.storage.local.get(AUTH_ALERT_KEYS.LAST_AUTH_NOTIFY_BY_EMAIL);
    const map = data[AUTH_ALERT_KEYS.LAST_AUTH_NOTIFY_BY_EMAIL] || {};
    map[email] = Date.now();
    await chrome.storage.local.set({ [AUTH_ALERT_KEYS.LAST_AUTH_NOTIFY_BY_EMAIL]: map });
  } catch (e) {
    console.error('[storage] setLastAuthNotify failed:', e.message);
  }
}

/* ============================================================
 * 新邮件提醒基线（chrome.storage.local，持久化）
 * —— 每个账号独立记住「最近一次被认账的未读数」，用于判断本次是否有新邮件到达。
 *    与 checkResults（检查历史，会被各种条目挤占）分离，避免基线查找失效导致
 *    静默漏报（ISSUE #56）。所有读写收敛在本模块，业务层不直接接触存储键。
 * ============================================================ */

/**
 * 读取全部账号的未读基线。
 * @returns {Promise<Object>} { [email]: { count: number, at: number } }
 */
export async function getUnreadBaselines() {
  try {
    const data = await chrome.storage.local.get(NOTIFY_BASELINE_KEYS.UNREAD_BASELINE_BY_EMAIL);
    const map = data[NOTIFY_BASELINE_KEYS.UNREAD_BASELINE_BY_EMAIL];
    return map && typeof map === 'object' ? map : {};
  } catch (e) {
    console.error('[storage] getUnreadBaselines failed:', e.message);
    return {};
  }
}

/**
 * 读取单个账号的未读基线。
 * @param {string} email
 * @returns {Promise<{count:number, at:number}|null>} 无记录返回 null
 */
export async function getUnreadBaseline(email) {
  if (!email) return null;
  const map = await getUnreadBaselines();
  const entry = map[email];
  if (!entry || typeof entry.count !== 'number') return null;
  return { count: entry.count, at: typeof entry.at === 'number' ? entry.at : 0 };
}

/**
 * 写入单个账号的未读基线（不改动其它账号）。
 * @param {string} email
 * @param {number} count
 */
export async function setUnreadBaseline(email, count) {
  if (!email || typeof count !== 'number') return;
  try {
    const map = await getUnreadBaselines();
    map[email] = { count, at: Date.now() };
    await chrome.storage.local.set({ [NOTIFY_BASELINE_KEYS.UNREAD_BASELINE_BY_EMAIL]: map });
  } catch (e) {
    console.error('[storage] setUnreadBaseline failed:', e.message);
  }
}

/**
 * 一致性清理：删除已不在账号列表中的基线记录，避免存储无限增长。
 * @param {string[]} emails 现存账号邮箱列表
 */
export async function pruneUnreadBaselines(emails) {
  const keep = new Set(Array.isArray(emails) ? emails : []);
  try {
    const map = await getUnreadBaselines();
    let changed = false;
    for (const key of Object.keys(map)) {
      if (!keep.has(key)) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.local.set({ [NOTIFY_BASELINE_KEYS.UNREAD_BASELINE_BY_EMAIL]: map });
    }
  } catch (e) {
    console.error('[storage] pruneUnreadBaselines failed:', e.message);
  }
}

/**
 * 读取某账号最近一次「新邮件提醒」发送时间（用于节流），无记录返回 0。
 * 复用授权告警同一张通知时间表：一个账号同一时刻只需一条提醒，避免两类
 * 通知互相不知情地在数秒内各弹一次。
 * @param {string} email
 */
export async function getLastMailNotify(email) {
  return getLastAuthNotify(email);
}

/**
 * 记录某账号本次「新邮件提醒」已发送时间。
 * @param {string} email
 */
export async function setLastMailNotify(email) {
  return setLastAuthNotify(email);
}
