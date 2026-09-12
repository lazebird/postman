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

// sid 缓存有效期：7 天（webmail 会话通常持续数周，持久化后无需频繁重新同步）
// 具体 sid 存储键映射见 shared/session-cache.js 的 sidStorageKey()
export const SID_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// 已捕获 API 模式的存储键
// 各 provider 独立存储，互不串键。CAPTURED_USTC / CAPTURED_GMAIL 为显式对称预留
//（USTC 走 Coremail 捕获回放；Gmail 走 Atom feed 公开端点、不需捕获回放，键仅作完整映射占位）。
export const API_PATTERN_KEYS = {
  CAPTURED_163: 'api_patterns_163',
  CAPTURED_QQ: 'api_patterns_qq',
  CAPTURED_USTC: 'api_patterns_ustc',
  CAPTURED_GMAIL: 'api_patterns_gmail',
  CAPTURED_TIME: 'api_patterns_time',
};

/**
 * ===== 检查触发来源 =====
 *
 * 将「某次检查/同步是由什么触发」显式区分为两类，作为贯穿全链路的标识：
 *
 *   - 手动（manual）：由用户在界面（Popup）点击按钮/控件显式触发。
 *     此类触发**可以**走完整交互流程——自动打开邮箱页、复用/新建标签、
 *     打开邮箱收件箱等（AGENTS 规则 1：用户主动显式操作允许）。
 *
 *   - 自动（auto）：由定时闹钟（chrome.alarms）、onInstalled/onStartup、
 *     内容脚本页面事件等周期/被动事件触发。此类触发**绝不**擅自打开可见标签、
 *     **绝不**自动弹出授权窗，避免在用户无感时打断其操作（AGENTS 规则 1/2）。
 *     若需要用户操作（如 Gmail 令牌缺失）仅标记「需手动同步」，交由用户显式处理。
 *
 * 触发源字符串沿用既有实现值，避免改变持久化结果 / 日志格式等外部行为。
 * @typedef {'manual'|'manual-test'|'alarm'|'content-probe'|'unknown'} TriggerSource
 */
export const TRIGGER_SOURCE = {
  /** 手动：Popup「🚀 全量检查」按钮 → runCheck */
  MANUAL_FULL: 'manual',
  /** 手动：Popup 单账户「检查 / 获取未读数 / 同步」等按钮 → testProvider / 内容脚本探测 */
  MANUAL_SINGLE: 'manual-test',
  /** 自动：chrome.alarms 定时闹钟周期检查 */
  AUTO_ALARM: 'alarm',
  /** 自动：内容脚本在邮箱页面事件驱动上报（sid 捕获 / 页面探测落库） */
  AUTO_CONTENT: 'content-probe',
  /** 未知 / 缺省（按自动保守处理，不允许交互弹窗） */
  UNKNOWN: 'unknown',
};

/** 是否属于「手动」触发来源（允许完整交互：开标签 / 弹授权窗） */
export function isManualSource(source) {
  return source === TRIGGER_SOURCE.MANUAL_FULL || source === TRIGGER_SOURCE.MANUAL_SINGLE;
}

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
    entryPoints: ['https://mail.163.com/js6/main.jsp', 'https://mail.163.com/'],
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
        url: 'https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: 'text/javascript',
          Referer: 'https://mail.163.com/js6/main.jsp?sid={sid}',
          Origin: 'https://mail.163.com',
        },
        requiresSid: true,
        bodyTemplate:
          'var=<object><object name="filter"></object><string name="order">date</string><boolean name="desc">true</boolean><array name="fids"><int>1</int><int>18</int><int>3685900</int></array><boolean name="skipLockedFolders">true</boolean><int name="limit">200</int><string name="mrcid">@null</string></object>',
        isUrlEncoded: true,
        description: 'RPC - 获取未读消息列表（真实格式，body 需 URL 编码）',
      },
      {
        name: 'js6_rpc_getfolder',
        url: 'https://mail.163.com/js6/s?func=mbox:getFolderCount&sid={sid}&df=mail163_letter',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Accept: '*/*',
          Referer: 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          Origin: 'https://mail.163.com',
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
          Accept: '*/*',
          Referer: 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          Origin: 'https://mail.163.com',
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
          Accept: '*/*',
          Referer: 'https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter',
          Origin: 'https://mail.163.com',
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
          Referer: 'https://wx.mail.qq.com/',
          Accept: 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 收件箱列表（真实格式，返回 unread_num）',
      },
      {
        name: 'wx_readindex',
        url: 'https://wx.mail.qq.com/cgi-bin/readindex?sid={sid}&t=inbox&r=0',
        method: 'GET',
        headers: {
          Referer: 'https://wx.mail.qq.com/',
          Accept: 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 读取邮箱索引',
      },
      {
        name: 'wx_mail_list',
        url: 'https://wx.mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}',
        method: 'GET',
        headers: {
          Referer: 'https://wx.mail.qq.com/',
          Accept: 'application/json, text/plain, */*',
        },
        requiresSid: true,
        description: '新网页版 - 收件箱列表',
      },
      {
        name: 'wx_unread',
        url: 'https://wx.mail.qq.com/cgi-bin/unread?sid={sid}&t=inbox',
        method: 'GET',
        headers: {
          Referer: 'https://wx.mail.qq.com/',
          Accept: 'application/json, text/plain, */*',
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
    entryPoints: ['http://mail.ustc.edu.cn/', 'http://mail.ustc.edu.cn/coremail/XT/index.jsp'],
    sessionEndpoints: [],
    // USTC 使用 Coremail 系统，API 格式与 163 类似
    probeEndpoints: [
      {
        name: 'ustc_getallfolders',
        url: 'http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}',
        method: 'GET',
        headers: {
          Accept: 'text/javascript, application/json',
          Referer: 'http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}',
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
          Accept: 'text/javascript, application/json',
          Referer: 'http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}',
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
    // Gmail 未读检查候选接口
    // Atom feed（隐藏端点，session cookie 认证，零 token、无需 OAuth 商业授权）。
    //   端点固定 + Cookie 鉴权，不依赖 {sid} 占位符（requiresSid:false，回放时无 sid 也放行）；
    //   响应为 Atom XML，未读数在 <fullcount> 标签，由 provider-gmail.js 专用解析器处理，
    //   不走通用 JSON 解析。
    // 风控约束：端点由 Google 非官方维护、可能随时 403/废弃，轮询复用现有 alarm 间隔
    //   （≥60s），不单独加密（避免触发 abuse detection）。
    probeEndpoints: [
      {
        name: 'atom_feed',
        url: 'https://mail.google.com/mail/u/0/feed/atom',
        method: 'GET',
        headers: {
          Accept: 'application/atom+xml, application/xml',
        },
        requiresSid: false,
        description: '隐藏 Atom feed - 收件箱未读计数（session cookie，返回 <fullcount>）',
      },
    ],
    contentDomains: ['mail.google.com'],
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
  logLevel: 'WARN',
  // 检查模式: 'hybrid'(优先SW API，回退内容脚本) / 'content-script'(仅内容脚本) / 'sw-api'(仅SW API)
  checkMode: 'hybrid',
  // 每个提供商启用的探测接口名
  enabledEndpoints: {
    netease_163: ['js6_rpc_list'],
    qq: ['wx_maillist'],
    ustc: ['ustc_getallfolders'],
    // atom_feed：Cookie 路径，零 token、无需 OAuth 商业授权
    gmail: ['atom_feed'],
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

// 授权/会话状态监控的持久化存储键（chrome.storage.local）
//  - LAST_OK_BY_EMAIL：每个账号最近一次「成功授权 / 正常读到未读」的时间戳（key=账号 email）。
//    用于区分「授权过期/出错（曾工作过）」与「从未授权（新增账户尚未首次同步）」——
//    只在账号曾工作过后发生授权失效时，才对其弹「授权需处理」的系统提醒，避免对
//    刚新增、尚未首次授权的账号反复打扰。
//  - LAST_AUTH_NOTIFY_BY_EMAIL：每个账号最近一次「授权需处理」提醒通知时间（key=账号 email），
//    用于节流，防止每次 alarm 定时检查失败都弹一次骚扰用户（AGENTS 规则 2）。
export const AUTH_ALERT_KEYS = {
  LAST_OK_BY_EMAIL: 'auth_last_ok_by_email',
  LAST_AUTH_NOTIFY_BY_EMAIL: 'auth_last_notify_by_email',
};

// 「授权需处理」系统提醒的最小间隔：同一账号在距离上次提醒不足该时长时不重复通知。
export const AUTH_ALERT_NOTIFY_THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 小时
