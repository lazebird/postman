/**
 * constants.js - 共享常量
 */

// 支持的邮箱提供商
export const PROVIDERS = {
  NETEASE_163: 'netease_163',
  QQ: 'qq',
  USTC: 'ustc',
  GMAIL: 'gmail',
};

// 提供商配置
export const PROVIDER_CONFIG = {
  [PROVIDERS.NETEASE_163]: {
    name: '163邮箱',
    domain: 'mail.163.com',
    homepage: 'https://mail.163.com/',
    // 163 的未读检查候选接口（基于前期探测）
    probeEndpoints: [
      {
        name: 'js6_rpc',
        url: 'https://mail.163.com/js6/s?func=mbox:listMessages',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
      {
        name: 'js6_rpc2',
        url: 'https://mail.163.com/js6/s?func=mbox:getUnread',
        method: 'GET',
      },
    ],
  },
  [PROVIDERS.QQ]: {
    name: 'QQ邮箱',
    domain: 'mail.qq.com',
    homepage: 'https://mail.qq.com/',
    // QQ 邮箱未读接口候选（基于前期探测）
    probeEndpoints: [
      {
        name: 'cgi_mail_list',
        url: 'https://mail.qq.com/cgi-bin/mail_list?t=inbox',
        method: 'GET',
      },
      {
        name: 'cgi_readdata',
        url: 'https://mail.qq.com/cgi-bin/readdata',
        method: 'GET',
      },
    ],
  },
  [PROVIDERS.USTC]: {
    name: '中科大邮箱',
    domain: 'mail.ustc.edu.cn',
    homepage: 'https://mail.ustc.edu.cn/',
    probeEndpoints: [],
  },
  [PROVIDERS.GMAIL]: {
    name: 'Gmail',
    domain: 'mail.google.com',
    homepage: 'https://mail.google.com/',
    probeEndpoints: [],
  },
};

// 检查间隔选项（分钟）
export const CHECK_INTERVALS = [
  { label: '1分钟', value: 1 },
  { label: '5分钟', value: 5 },
  { label: '10分钟', value: 10 },
  { label: '15分钟', value: 15 },
  { label: '30分钟', value: 30 },
];

// 默认设置
export const DEFAULT_SETTINGS = {
  checkIntervalMinutes: 5,
  logLevel: 'DEBUG',
  // 每个提供商启用的探测接口名
  enabledEndpoints: {
    netease_163: ['js6_rpc'],
    qq: ['cgi_mail_list'],
  },
};

// 存储键
export const STORAGE_KEYS = {
  ACCOUNTS: 'accounts',
  SETTINGS: 'settings',
  DEBUG_LOGS: 'debugLogs',
  LAST_CHECK: 'lastCheck',
  CHECK_RESULTS: 'checkResults',
};

// 调试字段选项（保留以供扩展使用）
export const DEBUG_FEATURE = {
  captureResponseHeaders: true,
  captureRequestHeaders: false, // 默认不记录请求头（可能包含敏感信息）
  maxResponsePreviewBytes: 2048,
  verboseFetchErrors: true,
};
