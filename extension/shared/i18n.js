/**
 * i18n.js - 中英文国际化（含语言设置覆盖）
 *
 * 文案单一事实源放在标准 Chrome/Edge 国际化目录 `extension/_locales/<locale>/messages.json`
 * （`en` 与 `zh_CN` 两个子目录），这样商店审查可识别扩展的多语言支持，且各文案集中管理。
 *
 * 提供两套能力：
 *   1. resolveLanguage / language 存储：默认随浏览器/系统语言（auto），
 *      也可由用户在「设置」中显式选择中文或 English 覆盖。
 *   2. 运行时从 `_locales/<locale>/messages.json` 拉取所选语言的文案目录（fetch 缓存），
 *      供 `applyDomI18n()` 替换静态 `data-i18n` 文案。
 *      由于 `chrome.i18n.getMessage` 的语言在安装时由浏览器决定、无法在运行时切换，
 *      因此这里通过 `fetch(chrome.runtime.getURL(...))` 读取对应 locale 的 messages.json，
 *      以保留「设置页语言下拉即时切换」的能力（PR #77 需求）。
 *   3. `t(zh, en)` 内联翻译：调用处直接把中英文写在一起，切换语言即生效。
 *      —— 适用于 popup.js 等以 JS 动态生成的短文案，改动小、可读性好。
 *
 * 设计说明（遵守 AGENTS 规则 4：分层与单一职责）：
 *   - 仅 UI 层（popup 等页面）依赖本模块；background/各 provider 的日志/诊断输出
 *     保持简体中文，不纳入 UI 国际化，避免把非 UI 内容强行耦合进语言切换。
 *   - 语言偏好存入 chrome.storage.local（规则 3：会话/偏好优先持久化）。
 *   - 静态 UI 文案与商店上架展示文案统一维护在 `_locales/_locale_/messages.json`；
 *     本模块不再内置一份重复的文案字典，避免多处漂移。
 */

// 支持的语言
export const LANGUAGES = { AUTO: 'auto', ZH: 'zh', EN: 'en' };

// 生效语言代码 → _locales 子目录名
const LANG_TO_LOCALE = { en: 'en', zh: 'zh_CN' };

import { getLanguagePreference, setLanguagePreference } from './storage.js';

let _lang = null; // 当前生效语言：'zh' | 'en'（启动后由 resolveLanguage 初始化）
let _catalog = null; // 当前语言的 _locales/<locale>/messages.json 文案目录缓存

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
 * 从 _locales/<locale>/messages.json 拉取文案目录并缓存。
 * 返回 message 字段展开后的扁平 map；失败返回 null（调用方按空目录降级）。
 */
async function loadCatalog(locale) {
  try {
    const url = chrome.runtime.getURL(`_locales/${locale}/messages.json`);
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.json();
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.message === 'string') map[k] = v.message;
    }
    return map;
  } catch (err) {
    console.warn('[i18n] 加载文案目录失败:', err);
    return null;
  }
}

/**
 * 解析并应用生效语言，并加载对应 locale 的文案目录。
 *   偏好为 auto → 跟随浏览器/系统语言；否则用显式选择。
 * 返回 'zh' | 'en'。
 */
export async function applyLanguage() {
  const pref = await getStoredLanguage();
  const lang = pref === LANGUAGES.AUTO ? (browserPrefersChinese() ? 'zh' : 'en') : pref;
  // 先同步确定生效语言，确保 t()/getLang 立即可用（即使目录尚未拉回）
  setLang(lang);
  // 同步更新 <html lang>（可访问性/语言标注）
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = LANG_TO_LOCALE[lang] || 'en';
  }
  _catalog = await loadCatalog(LANG_TO_LOCALE[lang] || 'en');
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

/** 读取当前语言目录中的某个 key 的文案；不存在则返回 null */
function domValue(key) {
  if (!_catalog) return null;
  const v = _catalog[key];
  return typeof v === 'string' ? v : null;
}

/**
 * 对 scope（默认 document）内的国际化占位进行替换：
 *   - [data-i18n]              → 替换元素纯文本
 *   - [data-i18n-placeholder]  → 替换 input 的 placeholder
 *   - [data-i18n-label]        → 替换 option/label 的 label 文案
 *   - [data-i18n-title]        → 替换元素的 title
 * 对于含子元素（如 <b>）的元素用 data-i18n，会破坏结构，请避免，只用于纯文本节点。
 * 文案取自 _locales/<locale>/messages.json（与 applyLanguage() 一起在初始化时加载）。
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
