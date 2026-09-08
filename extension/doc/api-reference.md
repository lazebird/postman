# 邮箱 API 接口参考

> 记录各邮箱提供商的实际可用接口格式，供开发者查阅与后续维护。
> 最后更新：2026-09-05 ｜ 当前版本：v0.9.7

---

## 1. 163 邮箱（netease_163）

### 1.1 主接口（已验证 ✅）

| 属性 | 值 |
|------|-----|
| 方法 | `POST` |
| URL | `https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}` |
| 认证 | Cookie（浏览器自动附带）+ URL 中的 sid |
| Content-Type | `application/x-www-form-urlencoded; charset=UTF-8` |
| 需要 sid | ✅ 是（无 sid 返回 `FA_UNAUTHORIZED`） |

**Headers：**
```
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
Accept: text/javascript
Referer: https://mail.163.com/js6/main.jsp?sid={sid}
Origin: https://mail.163.com
```

**Body（var 参数，需 URL 编码）：**
```
var=<object><object name="filter"></object><string name="order">date</string><boolean name="desc">true</boolean><array name="fids"><int>1</int><int>18</int><int>3685900</int></array><boolean name="skipLockedFolders">true</boolean><int name="limit">200</int><string name="mrcid">@null</string></object>
```

> **注意**：`fids` 包含 3 个文件夹（收件箱 fid=1、订阅邮件 fid=18、自定义文件夹 fid=3685900），确保不遗漏任何文件夹的未读邮件。

编码后（`encodeURIComponent` 仅编码 `=` 右侧的 value 部分）：
```
var=%3Cobject%3E%3Cobject%20name%3D%22filter%22%3E%3C%2Fobject%3E%3Cstring%20name%3D%22order%22%3Edate%3C%2Fstring%3E%3Cboolean%20name%3D%22desc%22%3Etrue%3C%2Fboolean%3E%3Carray%20name%3D%22fids%22%3E%3Cint%3E1%3C%2Fint%3E%3Cint%3E18%3C%2Fint%3E%3Cint%3E3685900%3C%2Fint%3E%3C%2Farray%3E%3Cboolean%20name%3D%22skipLockedFolders%22%3Etrue%3C%2Fboolean%3E%3Cint%20name%3D%22limit%22%3E200%3C%2Fint%3E%3Cstring%20name%3D%22mrcid%22%3E%40null%3C%2Fstring%3E%3C%2Fobject%3E
```

**Response（成功）：**
```json
{
  'code': 'S_OK',
  'var': [
    {
      'id': '720:xtbC0AhqNmqanAjy7gAA38',
      'fid': 18,
      'from': '"发件人" <sender@example.com>',
      'subject': '邮件主题',
      'sentDate': new Date(2026, 8, 4, 18, 19, 38),
      'flags': { 'hasTag': true },
      ...
    }
  ],
  'midoffset': -1
}
```

**未读数解析规则：**
- 遍历 `var` 数组中的每封邮件
- 没有 `flags.read: true` 标志的邮件计为未读
- 即：`!/'read'\s*:\s*true/.test(emailText)` → 未读计数 +1

**认证失败响应示例：**
| 响应码 | 含义 | 处理 |
|--------|------|------|
| `'code':'FA_UNAUTHORIZED'` | 未登录 / 无 sid | 清除 sid 缓存 |
| `'code':'FA_SECURITY'` | 安全拦截（非常用设备/IP） | 清除 sid 缓存 |
| `'code':'FA_SESSION_EXPIRED'` | 会话过期 | 清除 sid 缓存 |
| `'code':'FA_INVALID_SESSION'` | 无效会话 | 清除 sid 缓存 |
| `'code':'FR_INVALID_REQUEST'` | 请求格式错误（如 body 含 XML 声明） | **不清除 sid**，尝试其他端点 |

### 1.2 已废弃的备选接口（v0.9.7 实测）

以下接口在最新 163 版本中已返回 `FR_INVALID_REQUEST`（method 不存在），保留在配置中作为 fallback 但实际不会成功：

| 接口名 | URL | 当前状态 |
|--------|-----|---------|
| `js6_rpc_getfolder` | `...?func=mbox:getFolderCount&sid={sid}&df=mail163_letter` | ❌ `FR_INVALID_REQUEST`（method 不存在） |
| `js6_rpc_getunread` | `...?func=mbox:getUnread&sid={sid}&df=mail163_letter` | ❌ 同左 |
| `js6_sys_getfolder` | `...?func=global:getSessionInfo&sid={sid}&df=mail163_letter` | ❌ 同左 |

> **v0.9.7 变更**：移除了 body 中的 `<string name="sentDate">2:</string>` 过滤器和 URL/Referer 中的 `&df=mail163_letter` 参数。之前 sentDate=2 只查最近 2 天的邮件，会遗漏旧未读邮件；移除后返回全部未读。

### 1.3 会话获取

sid 从登录后的主页面 URL 中提取：
- 入口：`https://mail.163.com/js6/main.jsp`
- URL 格式：`https://mail.163.com/js6/main.jsp?sid={sid}&df=mail163_letter#module=...`
- 提取正则：`/[?&]sid=([a-zA-Z0-9_\-]{20,})/`

---

## 2. QQ 邮箱（qq）

### 2.1 主接口（已验证 ✅）

| 属性 | 值 |
|------|-----|
| 方法 | `GET` |
| URL | `https://wx.mail.qq.com/list/maillist?sid={sid}&dir=1&dirid=1&func=1&sort_type=1&sort_direction=1&page_now=0&page_size=50&enable_topmail=true` |
| 认证 | Cookie（`wx.mail.qq.com` 域）+ URL 中的 sid |
| 需要 sid | ✅ 是 |

**Headers：**
```
Referer: https://wx.mail.qq.com/
Accept: application/json, text/plain, */*
```

**Response（成功）：**
```json
{
  "ret": 0,
  "body": {
    "unread_num": 7,
    ...
  }
}
```

未读数从 `body.unread_num` 字段直接读取。

### 2.2 备选接口（部分已退役）

| 接口名 | URL | 状态 | 说明 |
|--------|-----|------|------|
| `wx_maillist` | `https://wx.mail.qq.com/list/maillist?sid={sid}...` | ✅ 有效 | 主接口 |
| `wx_readindex` | `https://wx.mail.qq.com/cgi-bin/readindex?sid={sid}&t=inbox&r=0` | ⚠️ 可能有效 | 备用 |
| `wx_mail_list` | `https://wx.mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}` | ⚠️ 可能有效 | 备用 |
| `wx_unread` | `https://wx.mail.qq.com/cgi-bin/unread?sid={sid}&t=inbox` | ⚠️ 可能有效 | 备用 |
| `cgi_mail_list` | `https://mail.qq.com/cgi-bin/mail_list?t=inbox&sid={sid}` | ❌ 重定向到登录页 | 旧域，cookie 不匹配 |
| `cgi_fr_show` | `https://mail.qq.com/cgi-bin/fr_show?sid={sid}&t=inbox` | ❌ 重定向到登录页 | 旧域，cookie 不匹配 |

> QQ 新版网页版运行在 `wx.mail.qq.com` 域名，`mail.qq.com` 旧域接口因 cookie 域不匹配会重定向到登录页。

### 2.3 认证失败响应特征

- 重定向到 `ptlogin` / `ssl.ptlogin` / `login.qq.com` / `xui.qq.com` → 未登录
- 响应体包含 `gbIsNoCheck` / `loginFrame` / `qm_login` / `需要登录` → 未登录
- 响应体包含 `cgierrorcode:-2` → 会话失效

### 2.4 响应编码

QQ 部分接口返回 GB18030 编码，需使用 `TextDecoder('gb18030')` 解码。

### 2.5 会话获取

sid 从登录跳转 URL 中提取：
- 入口：`https://wx.mail.qq.com/`（登录后自动跳转）或 `https://mail.qq.com/cgi-bin/login?fun=passport`
- URL 格式：`https://wx.mail.qq.com/?sid={sid}#...`

---

## 3. USTC 邮箱（ustc）

### 3.1 主接口（已验证 ✅）

| 属性 | 值 |
|------|-----|
| 方法 | `GET` |
| URL | `http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}` |
| 认证 | Cookie（`mail.ustc.edu.cn` 域）+ URL 中的 sid |
| 需要 sid | ✅ 是（无 sid 返回 500） |

**Headers：**
```
Accept: text/javascript, application/json
Referer: http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}
```

**Response（成功）：**
```json
{
  "code": "S_OK",
  "var": [
    {
      "name": "收件箱",
      "stats": {
        "totalMessageCount": 100,
        "unreadMessageCount": 5
      }
    },
    {
      "name": "已发送",
      "stats": {
        "totalMessageCount": 50,
        "unreadMessageCount": 0
      }
    }
  ]
}
```

未读数 = 所有文件夹的 `stats.unreadMessageCount` 之和。

### 3.2 备选接口

| 接口名 | URL | 状态 |
|--------|-----|------|
| `ustc_getallfolders` | `http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}` | ✅ 有效 |
| `ustc_getattrs` | `http://mail.ustc.edu.cn/coremail/s/json?sid={sid}&func=user%3AgetAttrs` | ⚠️ POST，body 为空 |

### 3.3 认证失败响应

- 响应体包含 `FA_UNAUTHORIZED` 或 `未登录` → 需重新授权
- USTC 使用 Coremail 系统，与 163 认证机制类似

### 3.4 会话获取

sid 从 URL 参数中提取：`http://mail.ustc.edu.cn/coremail/XT/index.jsp?sid={sid}`

---

## 4. Gmail（gmail）

### 4.1 OAuth2 认证

Gmail 使用 Google 官方 OAuth2 流程，通过 `chrome.identity.launchWebAuthFlow` 实现跨浏览器兼容（Chrome + Edge）。

**OAuth2 配置：**
- Client ID：已配置（`extension/shared/constants.js`）
- Scope：`https://www.googleapis.com/auth/gmail.readonly`
- Redirect URI：`https://{extension-id}.chromiumapp.org/`

**令牌管理：**
- 存储键：`gmail_access_token`（token）、`gmail_access_token_expiry`（过期时间戳）
- TTL：约 55 分钟（Google access token 有效期 ~1 小时）
- 静默续期：`launchWebAuthFlow(interactive=false, prompt=none)`，距上次尝试 ≥ 30 分钟时才允许重试
- 令牌失效时自动清除缓存，引导用户手动重新授权

### 4.2 未读查询接口

| 属性 | 值 |
|------|-----|
| 方法 | `GET` |
| URL | `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5` |
| 认证 | `Authorization: Bearer {token}` |

**Response（成功）：**
```json
{
  "resultSizeEstimate": 11,
  "messages": [
    { "id": "18c...", "threadId": "16e..." },
    ...
  ]
}
```

未读数 = `resultSizeEstimate`（Google 估算值，非精确计数，但对"有新邮件"判断足够）。

**邮件详情接口（获取发件人 + 主题用于通知）：**
```
GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}?format=metadata&metadataName=from&metadataName=subject&metadataName=date
```

### 4.3 错误处理

| HTTP 状态 | 原因 | 处理 |
|-----------|------|------|
| 401 | 令牌失效 / 已撤销 | 清除缓存令牌，引导重新授权 |
| 403 (accessNotConfigured) | Gmail API 未启用 | 提示检查 Google Cloud 控制台配置 |
| 403 (dailyLimitExceeded) | 配额超限 | 等待后重试 |
| 403 (insufficientPermissions) | scope 不足 | 引导重新授权（更广 scope） |
| 400 | 请求参数错误 | 令牌仍有效，不清缓存 |
| 5xx | Google 服务端错误 | 令牌仍有效，不清缓存 |

---

## 5. 认证失败响应码速查

| 系统 | 响应码/特征 | 含义 | 处理方式 |
|------|-----------|------|---------|
| 163 | `FA_UNAUTHORIZED` | 未登录 / 无 sid | 清除 sid |
| 163 | `FA_SECURITY` | 安全拦截（非常用设备） | 清除 sid |
| 163 | `FA_SESSION_EXPIRED` | 会话过期 | 清除 sid |
| 163 | `FA_INVALID_SESSION` | 无效会话 | 清除 sid |
| 163 | `FR_INVALID_REQUEST` | 请求格式错误 | **不清 sid**，尝试其他端点 |
| 163 | `Invalid method X for module Y` | func 名不存在 | 端点已废弃 |
| QQ | 重定向到 ptlogin/login | 未登录 | 不清 sid（旧域接口正常现象） |
| QQ | `gbIsNoCheck` / `需要登录` | 未登录 | 清除 wx 域 sid |
| USTC | `FA_UNAUTHORIZED` / `未登录` | 未登录 | 清除 sid |
| Gmail | 401 / `invalid_grant` | 令牌失效 | 清除 token，引导重授权 |
| Gmail | 403 / `accessNotConfigured` | API 未启用 | 不清 token，提示配置 |

---

## 6. 变更历史

| 版本 | 变更内容 |
|------|---------|
| v0.9.7 | 163 body 移除 `<?xml version="1.0"?>` 声明（服务端拒绝包含 XML 声明的请求） |
| v0.9.7 | 163 body 移除 `<string name="sentDate">2:</string>` 过滤器（遗漏旧未读邮件） |
| v0.9.7 | 163 URL/Referer 移除 `&df=mail163_letter` 参数（页面已不再使用该参数） |
| v0.9.7 | **修复** `parse163Response` 解析 Bug：改用括号计数替代 `indexOf(']')`，避免嵌套结构截断导致已读邮件误判为未读 |
| v0.9.6 | Gmail 迁移到 `launchWebAuthFlow` 替代 `getAuthToken`（Edge 兼容） |
| v0.9.4 | CSP 问题修复，API 拦截器分离到独立文件 |
