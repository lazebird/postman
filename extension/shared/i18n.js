/**
 * i18n.js - 中英文国际化（含语言设置覆盖）
 *
 * 提供两套能力：
 *   1. resolveLanguage / language 存储：默认随浏览器/系统语言（auto），
 *      也可由用户在「设置」中显式选择中文或 English 覆盖。
 *   2. t(zh, en) 内联翻译：调用处直接把中英文写在一起，切换语言即生效。
 *      —— 适用于 popup.js 等以 JS 动态生成的字符串，改动小、可读性好。
 *   3. DOM 目录翻译：给静态 HTML 元素加 data-i18n="key"，用 applyDomI18n() 统一替换，
 *      key 的中英文文案收敛在本文档的 DOM 目录中（单一事实源）。
 *
 * 设计说明（遵守 AGENTS 规则 4：分层与单一职责）：
 *   - 仅 UI 层（popup 等页面）依赖本模块；background/各 provider 的日志/诊断输出
 *     保持简体中文，不纳入 UI 国际化，避免把非 UI 内容强行耦合进语言切换。
 *   - 语言偏好存入 chrome.storage.local（规则 3：会话/偏好优先持久化）。
 */

// 支持的语言
export const LANGUAGES = { AUTO: 'auto', ZH: 'zh', EN: 'en' };

import { getLanguagePreference, setLanguagePreference } from './storage.js';

let _lang = null; // 当前生效语言：'zh' | 'en'（启动后由 resolveLanguage 初始化）

/** 读取当前生效语言代码（zh/en） */
export function getLang() {
  return _lang === 'en' ? 'en' : 'zh';
}

/** 直接设置生效语言（zh/en），供启动初始化 / 用户切换后调用 */
export function setLang(lang) {
  _lang = lang === 'en' ? 'en' : 'zh';
}

/**
 * 判断浏览器是否偏好中文（用于 auto 缺省）
 * 取 navigator.language / userLanguage，形如 zh / zh-CN / en-US。
 */
export function browserPrefersChinese() {
  const lang = (navigator.language || navigator.userLanguage || '').toLowerCase();
  return lang.startsWith('zh');
}

/**
 * 读取用户存储的语言偏好（auto/zh/en，缺省 auto）
 */
export async function getStoredLanguage() {
  return await getLanguagePreference();
}

/** 持久化语言偏好（经 shared/storage.js 写入，保证存储层隔离） */
export async function setStoredLanguage(lang) {
  await setLanguagePreference(lang);
}

/**
 * 解析并应用生效语言：
 *   偏好为 auto → 跟随浏览器/系统语言；否则用显式选择。
 * 返回 'zh' | 'en'。
 */
export async function applyLanguage() {
  const pref = await getStoredLanguage();
  setLang(pref === LANGUAGES.AUTO ? (browserPrefersChinese() ? 'zh' : 'en') : pref);
  return getLang();
}

/**
 * 内联翻译：t('中文','English')
 * 当前语言为 en 时返回英文，否则返回中文。支持 {n} 占位替换。
 * @param {string} zh
 * @param {string} en
 * @param {Object} [subs] 形如 { key: 值 }，替换字符串中的 {key}
 */
export function t(zh, en, subs) {
  let out = getLang() === 'en' ? en : zh;
  if (subs) {
    for (const [k, v] of Object.entries(subs)) {
      out = out.split(`{${k}}`).join(String(v));
    }
  }
  return out;
}

/* =====================================================================
 * DOM 静态文案目录（data-i18n 的单一事实源）
 * ===================================================================== */
const DOM_MSGS = {
  // 标题 / 标签页
  headerTitle: { zh: '📧 Mail Notifier', en: '📧 Mail Notifier' },
  tabOverview: { zh: '状态', en: 'Status' },
  tabSettings: { zh: '设置', en: 'Settings' },
  tabStats: { zh: '统计', en: 'Stats' },
  tabLogs: { zh: '日志', en: 'Logs' },
  tabDebug: { zh: '调试', en: 'Debug' },

  // 状态页
  loading: { zh: '加载中...', en: 'Loading...' },
  processing: { zh: '处理中...', en: 'Processing...' },
  noAccountTitle: { zh: '未配置邮箱账户', en: 'No mail account configured' },
  noAccountHint: { zh: '请前往 设置 标签添加', en: 'Go to the Settings tab to add one' },
  fullCheck: { zh: '🚀 全量检查', en: '🚀 Full Check' },

  // 调试页
  syncSessionTitle: { zh: '同步会话', en: 'Sync Session' },
  syncHint: {
    zh: '打开邮箱页 → 提取会话令牌(sid) → 缓存供后台检查',
    en: 'Open mailbox → extract session token (sid) → cache for background checks',
  },
  fetchUnreadTitle: { zh: '获取未读数', en: 'Fetch Unread' },
  fetchHint: {
    zh: '若未读为空：请在邮箱中打开「收件箱」后重试',
    en: 'If empty: open the Inbox in the mailbox and retry',
  },
  diagTitle: { zh: '诊断与探测', en: 'Diagnose & Probe' },
  diagCookies: { zh: '🍪 诊断会话 Cookie', en: '🍪 Diagnose Session Cookie' },
  advProbeToggle: { zh: '▸ 高级探测（SW 直调）', en: '▸ Advanced Probe (SW direct)' },
  btnCheckAuth: { zh: '检查认证', en: 'Check Auth' },
  btnRefreshSession: { zh: '🔄刷新会话', en: '🔄 Refresh Session' },
  btnPossibility: { zh: '🧪 全可能性后台测试', en: '🧪 Possibility Backend Test' },
  reportBugTitle: { zh: '反馈问题', en: 'Report an Issue' },
  reportBugHint: {
    zh: '若遇到异常，可一键将诊断信息+日志发送邮件至维护者 lazebird@gmail.com',
    en: 'Encounter an issue? Send diagnostics + logs to the maintainer lazebird@gmail.com in one click.',
  },
  reportBugBtn: { zh: '📧 邮件反馈 Bug（附日志）', en: '📧 Report Bug by Email (with logs)' },

  // 设置页
  addAccountPlaceholder: {
    zh: '输入邮箱地址，如 user@163.com',
    en: 'Enter email address, e.g. user@163.com',
  },
  btnAdd: { zh: '添加', en: 'Add' },
  noAccounts: { zh: '暂无账户', en: 'No accounts yet' },
  noAccountsHint: { zh: '暂无账户，请在上方添加', en: 'No accounts yet, add one above' },
  lblInterval: { zh: '检查间隔', en: 'Check Interval' },
  lblIntervalMin: { zh: '检查间隔(分钟)', en: 'Check interval (min)' },
  lblLogLevel: { zh: '日志级别', en: 'Log Level' },
  lblCheckMode: { zh: '检查模式', en: 'Check Mode' },
  lblLanguage: { zh: '界面语言', en: 'UI Language' },
  langAuto: { zh: '跟随系统语言（自动）', en: 'Follow system language (auto)' },
  langZh: { zh: '简体中文', en: '简体中文 (Chinese)' },
  langEn: { zh: 'English', en: 'English' },
  modeHybrid: { zh: '混合模式', en: 'Hybrid mode' },
  modeContent: { zh: '仅内容脚本', en: 'Content script only' },
  modeSw: { zh: '仅SW API', en: 'SW API only' },
  modeHybridOption: { zh: '混合模式（推荐）', en: 'Hybrid (recommended)' },
  modeContentOption: { zh: '仅内容脚本', en: 'Content script only' },
  modeSwOption: { zh: '仅 SW API', en: 'SW API only' },
  modeHintA: {
    zh: '：SW缓存sid直调，失效回退内容脚本。',
    en: ': SW cached sid direct call, falls back to content script.',
  },
  modeHintB: { zh: '：需常驻邮箱页。', en: ': requires a resident mailbox page.' },
  modeHintC: { zh: '：无需开页，定期同步。', en: ': no page needed, syncs periodically.' },
  modeHint: {
    zh: '混合：SW缓存sid直调，失效回退内容脚本。仅内容脚本：需常驻邮箱页。仅SW API：无需开页，定期同步。',
    en: 'Hybrid: SW cached sid direct call, falls back to content script. Content script only: needs a resident mailbox page. SW API only: no page needed, syncs periodically.',
  },
  endpointToggle: { zh: '▸ 探测接口配置', en: '▸ Probe Endpoint Config' },
  btnSave: { zh: '💾 保存设置', en: '💾 Save Settings' },
  btnReset: { zh: '🔄 重置', en: '🔄 Reset' },

  // 统计页
  sessionStatus: { zh: '会话授权状态', en: 'Session & Auth Status' },
  dataStats: { zh: '数据统计', en: 'Data Stats' },
  recentChecks: { zh: '最近检查', en: 'Recent Checks' },
  noData: { zh: '暂无数据', en: 'No data' },

  // 日志页
  debugLogs: { zh: '调试日志', en: 'Debug Logs' },
  copyLogs: { zh: '📋 复制', en: '📋 Copy' },
  clearLogs: { zh: '🗑 清除', en: '🗑 Clear' },

  // 弹窗确认
  confirmReset: {
    zh: '确定要重置所有设置吗？所有账户和配置将被清除。',
    en: 'Reset all settings? All accounts and configuration will be cleared.',
  },

  // 调试页探测按钮
  btnProbeWord: { zh: '探测', en: 'Probe' },

  // 邮箱域名 datalist 提示
  hintNetease: { zh: '163邮箱', en: '163 Mail' },
  hintQq: { zh: 'QQ邮箱', en: 'QQ Mail' },
  hintUstc: { zh: '中科大邮箱', en: 'USTC Mail' },
};

/**
 * 对 scope（默认 document）内的 [data-i18n] 元素按目录替换文本。
 * 支持子节点混合文本的占位 key（用占位符包裹的纯文本节点会被替换，如 <br> 旁的文字），
 * 但常规用法是给每个含文字的元素单独加 data-i18n。
 */
function domValue(key) {
  const msg = DOM_MSGS[key];
  if (!msg) return null;
  return getLang() === 'en' ? msg.en : msg.zh;
}

/**
 * 对 scope（默认 document）内的国际化占位进行替换：
 *   - [data-i18n]              → 替换元素纯文本
 *   - [data-i18n-placeholder]  → 替换 input 的 placeholder
 *   - [data-i18n-label]        → 替换 option/label 的 label 文案
 *   - [data-i18n-title]        → 替换元素的 title
 * 对于含子元素（如 <b>）的元素用 data-i18n，会破坏结构，请避免，只用于纯文本节点。
 */
export function applyDomI18n(scope = document) {
  scope.querySelectorAll('[data-i18n]').forEach((el) => {
    const value = domValue(el.getAttribute('data-i18n'));
    if (value !== null && el.childElementCount === 0) el.textContent = value;
  });
  scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const value = domValue(el.getAttribute('data-i18n-placeholder'));
    if (value !== null) el.setAttribute('placeholder', value);
  });
  scope.querySelectorAll('[data-i18n-label]').forEach((el) => {
    const value = domValue(el.getAttribute('data-i18n-label'));
    if (value !== null) el.setAttribute('label', value);
  });
  scope.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const value = domValue(el.getAttribute('data-i18n-title'));
    if (value !== null) el.setAttribute('title', value);
  });
}
