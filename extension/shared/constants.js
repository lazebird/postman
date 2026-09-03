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

// 会话密钥（存储于 chrome.storage.session，浏览器重启即清空）
export const SESSION_KEYS = {
  SID_163: 'sid_163',
  SID_QQ: 'sid_qq',
  SESSION_EXPIRY: 'session_expiry',
};

// sid 缓存有效期：12 小时（原 30 分钟过短，导致无标签时后台检查频繁失效）
export const SID_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * 提供商配置
 *
 * 每个提供商配置包含：
 * - name / domain / homepage：基本信息
 * - entryPoint：会话初始化入口（登录态下访问会返回 sid 或跳转到含 sid 的 URL）
 * - sessionEndpoints：用于获取会话令牌的候选接口
 * - probeEndpoints：未读检查候选接口（URL 中可用 {sid} 占位符）
 * - loginPagePattern：登录页 HTML 特征，用于识别未认证
 */
export const PROVIDER_CONFIG = {
  [PROVIDERS.NETEASE_163]: {
    name: '163邮箱',
    domain: 'mail.163.com',
    homepage: 'https://mail.163.com/',
    // 163 登录后首页入口，通常包含或重定向到含 sid 的 URL
    entryPoints: [
      'https://mail.163.com/js6/main.jsp',
      'https://mail.163.com/',
    ],
    // 候选会话获取接口（通过访问得到 sid 或确认已登录）
    sessionEndpoints: [
      {
        name: 'js6_main',
        url: 'https://mail.163.com/js6/main.jsp',
        method: 'GET',
        description: '登录后的主邮箱页面，URL或内容中包含 sid',
      },
      {
        name: 'root_entry',
        url: 'https://mail.163.com/',
        method: 'GET',
        description: '163 邮箱根入口（登录后自动跳转到含 sid 的页面）',
      },
    ],
    // 163 的未读检查候选接口（URL 支持 {sid} 占位符）
    // v0.5.0: 163 API 鉴权核心为 Cookie，sid 为可选增强。
    //   无 sid 时可通过 Cookie 直接探测（URL 中移除 sid 参数）。
    probeEndpoints: [
      {
        name: 'js6_rpc',
        url: 'https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        requiresSid: false, // v0.5.0: 不强制要求 sid
        bodyTemplate: 'var=@{type:"listMessages",ver:0,pageSize:1,start:0,folderId:"1",mailto:"",readFlag:"2"}',
        description: '邮箱 RPC 网关 - 获取未读消息列表（Cookie 鉴权为主）',
      },
    ],
  },
  [PROVIDERS.QQ]: {
    name: 'QQ邮箱',
    domain: 'mail.qq.com',
    homepage: 'https://mail.qq.com/',
    // QQ 邮箱登录后入口
    entryPoints: [
      'https://mail.qq.com/cgi-bin/login?fun=passport',
      'https://mail.qq.com/cgi-bin/login',
      'https://mail.qq.com/',
    ],
    sessionEndpoints: [
      {
        name: 'passport_entry',
        url: 'https://mail.qq.com/cgi-bin/login?fun=passport',
        method: 'GET',
        description: '登录后的跳转入口，URL 中包含 sid',
      },
      {
        name: 'homepage_entry',
        url: 'https://mail.qq.com/cgi-bin/login',
        method: 'GET',
        description: 'QQ 邮箱首页入口（已登录时自动跳转）',
      },
      {
        name: 'root_entry',
        url: 'https://mail.qq.com/',
        method: 'GET',
        description: 'QQ 邮箱根入口',
      },
    ],
    // QQ 邮箱未读接口候选（URL 支持 {sid} 占位符）
    // v0.5.0: 即使无 sid 缓存也尝试 API 探测。
    //   部分 QQ 接口可能依赖 Cookie（qm_sk 等），sid 为双轨鉴权的一环。
    probeEndpoints: [
      {
        name: 'cgi_mail_list',
        url: 'https://mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}',
        method: 'GET',
        requiresSid: true,
        description: '收件箱列表页面（QQ 旧版接口）',
      },
      {
        name: 'cgi_fr_show',
        url: 'https://mail.qq.com/cgi-bin/fr_show?sid={sid}&t=inbox',
        method: 'GET',
        requiresSid: true,
        description: '轻量级收件箱未读数（QQ 旧版接口）',
      },
    ],
  },
  [PROVIDERS.USTC]: {
    name: '中科大邮箱',
    domain: 'mail.ustc.edu.cn',
    homepage: 'https://mail.ustc.edu.cn/',
    entryPoints: [],
    sessionEndpoints: [],
    probeEndpoints: [],
  },
  [PROVIDERS.GMAIL]: {
    name: 'Gmail',
    domain: 'mail.google.com',
    homepage: 'https://mail.google.com/',
    entryPoints: [],
    sessionEndpoints: [],
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
  // 检查模式: 'hybrid'(优先SW API，回退内容脚本) / 'content-script'(仅内容脚本) / 'sw-api'(仅SW API)
  checkMode: 'hybrid',
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

// 调试字段选项
export const DEBUG_FEATURE = {
  captureResponseHeaders: true,
  captureRequestHeaders: false, // 默认不记录请求头（可能包含敏感信息）
  maxResponsePreviewBytes: 2048,
  verboseFetchErrors: true,
};
