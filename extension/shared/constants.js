/**
 * constants.js - 共享常量
 *
 * v0.8.0 全面优化：
 *   1. 新增 QQ wx.mail.qq.com API 端点（新网页版）
 *   2. 新增 163 多格式探测端点
 *   3. 支持 API pattern 捕获/回放机制
 */

// 支持的邮箱提供商
export const PROVIDERS = {
  NETEASE_163: 'netease_163',
  QQ: 'qq',
  USTC: 'ustc',
  GMAIL: 'gmail',
};

// 会话密钥（存储于 chrome.storage.local，持久化跨浏览器重启保留）
export const SESSION_KEYS = {
  SID_163: 'sid_163',
  SID_QQ: 'sid_qq',
  SESSION_EXPIRY: 'session_expiry',
};

// sid 缓存有效期：7 天（webmail 会话通常持续数周，持久化后无需频繁重新同步）
export const SID_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Gmail OAuth2 token 缓存键（chrome.storage.local 持久化，浏览器重启保留）
// 符合 AGENTS 规则 3：会话令牌优先持久化存储，后台直调时从缓存读取，
// 避免每次后台检查都依赖 chrome.identity（在 Microsoft Edge 上不受支持）。
export const GMAIL_TOKEN_KEYS = {
  TOKEN: 'gmail_token',
  EXPIRY: 'gmail_token_expiry',
};

// 已捕获 API 模式的存储键
export const API_PATTERN_KEYS = {
  CAPTURED_163: 'api_patterns_163',
  CAPTURED_QQ: 'api_patterns_qq',
  CAPTURED_TIME: 'api_patterns_time',
};

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
    contentDomains: ['mail.163.com', '*.mail.163.com', 'js6.mail.163.com'],
    // 163 登录后首页入口
    entryPoints: [
      'https://mail.163.com/js6/main.jsp',
      'https://mail.163.com/',
    ],
    sessionEndpoints: [
      {
        name: 'js6_main',
        url: 'https://mail.163.com/js6/main.jsp',
        method: 'GET',
        description: '登录后的主邮箱页面，URL或内容中包含 sid',
      },
    ],
    // 163 的未读检查候选接口 - v0.8.0 扩展多格式探测
    // 多个候选以覆盖不同版本的接口格式
    probeEndpoints: [
      {
        name: 'js6_rpc_list',
        url: 'https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'text/javascript',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        requiresSid: true,
        bodyTemplate: 'var=<?xml version="1.0"?>><object><object name="filter"><string name="sentDate">2:</string></object><string name="order">date</string><boolean name="desc">true</boolean><array name="fids"><int>1</int><int>18</int><int>3685900</int></array><boolean name="skipLockedFolders">true</boolean><int name="limit">200</int><string name="mrcid">{mrcid}</string></object>',
        isUrlEncoded: true,
        description: 'RPC - 获取未读消息列表（真实格式，body 需 URL 编码）',
      },
      {
        name: 'js6_rpc_getfolder',
        url: 'https://mail.163.com/js6/s?func=mbox:getFolderCount&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        requiresSid: true,
        bodyTemplate: 'var=@null',
        description: 'RPC - 获取文件夹未读计数',
      },
      {
        name: 'js6_rpc_getunread',
        url: 'https://mail.163.com/js6/s?func=mbox:getUnread&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        requiresSid: true,
        bodyTemplate: 'var=@null',
        description: 'RPC - 获取未读计数',
      },
      {
        name: 'js6_sys_getfolder',
        url: 'https://mail.163.com/js6/s?func=global:getSessionInfo&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': '*/*',
          'Referer': 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          'Origin': 'https://mail.163.com',
        },
        requiresSid: true,
        bodyTemplate: 'var=@null',
        description: 'RPC - 获取会话与文件夹信息',
      },
    ],
  },
  [PROVIDERS.QQ]: {
    name: 'QQ邮箱',
    domain: 'mail.qq.com',
    homepage: 'https://mail.qq.com/',
    // QQ 新网页版实际运行于 wx.mail.qq.com
    contentDomains: ['mail.qq.com', '*.mail.qq.com', 'wx.mail.qq.com'],
    entryPoints: [
      'https://mail.qq.com/cgi-bin/login?fun=passport',
      'https://mail.qq.com/cgi-bin/login',
      'https://mail.qq.com/',
      'https://wx.mail.qq.com/',
    ],
    sessionEndpoints: [
      {
        name: 'passport_entry',
        url: 'https://mail.qq.com/cgi-bin/login?fun=passport',
        method: 'GET',
        description: '登录后的跳转入口，URL 中包含 sid',
      },
      {
        name: 'wx_entry',
        url: 'https://wx.mail.qq.com/',
        method: 'GET',
        description: 'QQ 新网页版入口（登录后自动跳转到含 sid 的页面）',
      },
    ],
    // QQ 邮箱未读接口候选 - v0.8.0 同时支持 mail.qq.com 旧接口和 wx.mail.qq.com 新接口
    // 优先探测 wx.mail.qq.com（QQ 新版实际运行域名），因为 sid/cookie 是从该域获取的，
    // mail.qq.com 旧版接口可能因缺少对应域的 cookie 而无法认证。
    probeEndpoints: [
      // ===== wx.mail.qq.com 新版 SPA 接口（优先）=====
      {
        name: 'wx_maillist',
        url: 'https://wx.mail.qq.com/list/maillist?sid={sid}&dir=1&dirid=1&func=1&sort_type=1&sort_direction=1&page_now=0&page_size=50&enable_topmail=true',
        method: 'GET',
        headers: {
          'Referer': 'https://wx.mail.qq.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 收件箱列表（真实格式，返回 unread_num）',
      },
      {
        name: 'wx_readindex',
        url: 'https://wx.mail.qq.com/cgi-bin/readindex?sid={sid}&t=inbox&r=0',
        method: 'GET',
        headers: {
          'Referer': 'https://wx.mail.qq.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 读取邮箱索引',
      },
      {
        name: 'wx_mail_list',
        url: 'https://wx.mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}',
        method: 'GET',
        headers: {
          'Referer': 'https://wx.mail.qq.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 收件箱列表',
      },
      {
        name: 'wx_unread',
        url: 'https://wx.mail.qq.com/cgi-bin/unread?sid={sid}&t=inbox',
        method: 'GET',
        headers: {
          'Referer': 'https://wx.mail.qq.com/',
          'Accept': 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 未读计数',
      },
      // ===== mail.qq.com 传统接口（fallback）=====
      {
        name: 'cgi_mail_list',
        url: 'https://mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}',
        method: 'GET',
        requiresSid: true,
        description: '收件箱列表页面（旧版接口）',
      },
      {
        name: 'cgi_fr_show',
        url: 'https://mail.qq.com/cgi-bin/fr_show?sid={sid}&t=inbox',
        method: 'GET',
        requiresSid: true,
        description: '轻量级收件箱未读数（旧版接口）',
      },
    ],
  },
  [PROVIDERS.USTC]: {
    name: '中科大邮箱',
    domain: 'mail.ustc.edu.cn',
    homepage: 'http://mail.ustc.edu.cn/',
    entryPoints: [
      'http://mail.ustc.edu.cn/',
      'http://mail.ustc.edu.cn/coremail/XT/index.jsp',
    ],
    sessionEndpoints: [],
    // USTC 使用 Coremail 系统，API 格式与 163 类似
    probeEndpoints: [
      {
        name: 'ustc_getallfolders',
        url: 'http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}',
        method: 'GET',
        headers: {
          'Accept': 'text/javascript, application/json',
          'Referer': 'http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}',
        },
        requiresSid: true,
        description: '获取所有文件夹及未读数（返回 unreadMessageCount）',
      },
      {
        name: 'ustc_getattrs',
        url: 'http://mail.ustc.edu.cn/coremail/s/json?sid={sid}&func=user%3AgetAttrs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'text/javascript, application/json',
          'Referer': 'http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}',
        },
        requiresSid: true,
        bodyTemplate: '',
        description: '获取用户属性（可能包含未读数）',
      },
    ],
    contentDomains: ['mail.ustc.edu.cn'],
  },
  [PROVIDERS.GMAIL]: {
    name: 'Gmail',
    domain: 'mail.google.com',
    homepage: 'https://mail.google.com/',
    entryPoints: [],
    sessionEndpoints: [],
    probeEndpoints: [],
    contentDomains: ['mail.google.com'],
    // Gmail OAuth2 配置
    oauth2: {
      clientId: '428257971477-hgals4i0e445jdl1ame35i8ir3nll9ua.apps.googleusercontent.com',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
      ],
    },
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
     netease_163: ['js6_rpc_list'],
     qq: ['wx_maillist'],
     ustc: ['ustc_getallfolders'],
     gmail: ['gmail_api'],
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
  maxResponsePreviewBytes: 4096,
  verboseFetchErrors: true,
};
