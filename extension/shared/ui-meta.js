/**
 * ui-meta.js - Popup/UI 展示元数据（单一事实源）
 *
 * 集中维护 UI 层用到的提供商显示名与「探测接口勾选项」，
 * 供 popup 等 UI 页面 import 复用，避免多份拷贝漂移。
 * （原 popup.js / options.js 各自维护一份，已收敛于此）
 *
 * 提供商/端点显示名做了中英文国际化：label 用中/英双语存储，
 * 通过 Proxy 按当前生效语言（shared/i18n.getLang）返回对应文案，
 * 让 popup 等页面直接用 `PROVIDER_LABELS[provider]` 即得当前语言结果。
 */

import { getLang } from './i18n.js';

const PROVIDER_ZH = {
  netease_163: '163邮箱',
  qq: 'QQ邮箱',
  ustc: '中科大邮箱',
  gmail: 'Gmail',
};
const PROVIDER_EN = {
  netease_163: '163 Mail',
  qq: 'QQ Mail',
  ustc: 'USTC Mail',
  gmail: 'Gmail',
};

/** 按当前语言返回提供商显示名 */
export function providerName(provider) {
  const lang = getLang();
  const map = lang === 'en' ? PROVIDER_EN : PROVIDER_ZH;
  return map[provider] || provider;
}

/** 兼容既有 `PROVIDER_LABELS[provider]` 取用法的自动本地化 Proxy */
export const PROVIDER_LABELS = new Proxy(PROVIDER_ZH, {
  get(target, prop) {
    if (typeof prop === 'string') return providerName(prop);
    return target[prop];
  },
});

/** 各提供商可选的探测接口（UI 展示 label 对应 shared/constants.js 的 probeEndpoints name） */
export const ENDPOINT_OPTIONS = {
  netease_163: [
    { name: 'js6_rpc_list', zh: 'RPC · 收件箱列表', en: 'RPC · Inbox list' },
    { name: 'js6_rpc_getfolder', zh: 'RPC · 文件夹计数', en: 'RPC · Folder count' },
    { name: 'js6_rpc_getunread', zh: 'RPC · 未读计数', en: 'RPC · Unread count' },
    { name: 'js6_sys_getfolder', zh: 'RPC · 会话信息', en: 'RPC · Session info' },
  ],
  qq: [
    { name: 'wx_readdata', zh: '新网页版 · 读取收件箱', en: 'New web · Read inbox' },
    { name: 'wx_readindex', zh: '新网页版 · 读取邮箱索引', en: 'New web · Read index' },
    { name: 'wx_mail_list', zh: '新网页版 · 收件箱列表', en: 'New web · Inbox list' },
    { name: 'wx_unread', zh: '新网页版 · 未读计数', en: 'New web · Unread count' },
    { name: 'cgi_mail_list', zh: '旧版 · 收件箱列表', en: 'Legacy · Inbox list' },
    { name: 'cgi_fr_show', zh: '旧版 · 轻量未读', en: 'Legacy · Lightweight unread' },
  ],
  ustc: [
    { name: 'ustc_getallfolders', zh: '获取所有文件夹', en: 'Get all folders' },
    { name: 'ustc_getattrs', zh: '获取用户属性', en: 'Get user attributes' },
  ],
  gmail: [{ name: 'gmail_api', zh: 'Gmail REST API', en: 'Gmail REST API' }],
};

/** 端点 label 本地化：兼容旧 `ep.label` 用法 */
export function endpointLabel(ep) {
  if (ep.en) return getLang() === 'en' ? ep.en : ep.zh;
  return ep.label || ep.zh || ep.name;
}

/** 端点对象：把 {zh,en} 展开出可用的 label（popup 用） */
export function localizedEndpoints(provider) {
  return (ENDPOINT_OPTIONS[provider] || []).map((ep) => ({
    name: ep.name,
    label: endpointLabel(ep),
  }));
}
