/**
 * ui-meta.js - Popup/UI 展示元数据（单一事实源）
 *
 * 集中维护 UI 层用到的提供商显示名与「探测接口勾选项」，
 * 供 popup 等 UI 页面 import 复用，避免多份拷贝漂移。
 * （原 popup.js / options.js 各自维护一份，已收敛于此）
 */

export const PROVIDER_LABELS = {
  netease_163: '163邮箱',
  qq: 'QQ邮箱',
  ustc: '中科大',
  gmail: 'Gmail',
};

// 各提供商可选的探测接口（UI 展示 label 对应 shared/constants.js 的 probeEndpoints name）
export const ENDPOINT_OPTIONS = {
  netease_163: [
    { name: 'js6_rpc_list', label: 'RPC · 收件箱列表' },
    { name: 'js6_rpc_getfolder', label: 'RPC · 文件夹计数' },
    { name: 'js6_rpc_getunread', label: 'RPC · 未读计数' },
    { name: 'js6_sys_getfolder', label: 'RPC · 会话信息' },
  ],
  qq: [
    { name: 'wx_readdata', label: '新网页版 · 读取收件箱' },
    { name: 'wx_readindex', label: '新网页版 · 读取邮箱索引' },
    { name: 'wx_mail_list', label: '新网页版 · 收件箱列表' },
    { name: 'wx_unread', label: '新网页版 · 未读计数' },
    { name: 'cgi_mail_list', label: '旧版 · 收件箱列表' },
    { name: 'cgi_fr_show', label: '旧版 · 轻量未读' },
  ],
  ustc: [
    { name: 'ustc_getallfolders', label: '获取所有文件夹' },
    { name: 'ustc_getattrs', label: '获取用户属性' },
  ],
  gmail: [{ name: 'gmail_api', label: 'Gmail REST API' }],
};
