# Known Issues & Solutions

> 本文档记录项目已知问题、根因分析及解决方案。
> 最后更新：2026-09-12 ｜ 当前版本：v1.0.1

---

## ✅ 已完成功能（v0.9.5）

### 163 邮箱
- ✅ SW API 探测成功
- ✅ 未读数：与页面一致（parse163Response 已修复嵌套括号解析 Bug）
- ✅ API：`POST https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}`
- ✅ Body：Coremail RPC 格式（无 XML 声明，var=<object>...）
- ✅ Response：JSONP，统计没有 `read:true` 标志的邮件数量
- ⚠️ **v1.0.1 修复**：163 服务端变更，请求 body 中不再接受 `<?xml version="1.0"?>` 声明，移除后恢复正常

### QQ 邮箱
- ✅ SW API 探测成功
- ✅ 未读数：7 封
- ✅ API：`GET https://wx.mail.qq.com/list/maillist?sid={sid}...`
- ✅ Response：JSON，直接返回 `body.unread_num` 字段
- ✅ 确认：QQ 使用 HTTP API（非 WebSocket）

### USTC 邮箱
- ✅ SW API 探测成功
- ✅ 未读数：2 封
- ✅ API：`GET http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}`
- ✅ Response：JSON，包含各文件夹的 `unreadMessageCount` 字段
- ⚠️ 需要用户在浏览器中先登录，然后点击「同步USTC」按钮

### Gmail 邮箱
- ✅ Atom feed + 浏览器 Cookie 直调（v0.11.0 起，零 token、无需 Google Cloud 商业授权）
- ✅ 端点：`GET https://mail.google.com/mail/u/0/feed/atom`（`<fullcount>` 即全邮箱未读数）
- ⚠️ 需要浏览器已登录 Gmail（mail.google.com）；未登录时标记「需手动同步」
- 📌 原 OAuth2 / gmail.googleapis.com REST 路径已彻底移除（2026-09-12）

---


## 🟡 P2：（已随 v0.11.0 OAuth2 移除而失效，历史存档）Gmail API "Failed to fetch" 网络层错误

### 问题描述
后台检查时出现 `Gmail API fetch failed: Failed to fetch`，属于 TypeError（网络层失败），非 HTTP 401/403。中国大陆用户频繁遇到此问题（Great Firewall 阻断 / VPN 不稳定）。

### 处理原则
- **绝不清除 token**：网络故障 ≠ 令牌失效，清除会导致用户每次网络恢复后都需重新授权
- **降级为 DEBUG 日志**：不产生 ERROR 噪音，不影响工具栏图标状态
- **自动恢复**：token 保留在缓存中，网络恢复后下次 alarm 自动重试即可正常读取

### 修复（v1.0.1）
移除 token 长度预检查和不必要的 catch 块 token 清除逻辑，网络错误统一降级为 DEBUG 日志，返回 `tokenInvalid: false` 保持 token 可用。

---

## 🔧 CSP 问题修复（v0.9.4）

### 问题
163 和 USTC 邮箱有严格的 CSP 策略，禁止 inline script，导致内容脚本注入失败。

### 解决方案
1. **分离 API 拦截器** - 将拦截器代码提取到独立文件 `api-interceptor.js`
2. **使用 chrome.scripting API** - 通过 `chrome.scripting.executeScript` 注入，绕过 CSP
3. **添加 probe-fetch-inject.js** - 用于在页面上下文中执行 fetch

### 修改文件
- `extension/content/api-interceptor.js` - 新建，API 拦截器
- `extension/content/probe-fetch-inject.js` - 新建，fetch 注入器
- `extension/content/probe-content.js` - 修改，使用 chrome.scripting 注入
- `extension/manifest.json` - 添加新的 content script 文件

---

## 🟡 P1：163 API body 格式变更——XML 声明被拒绝（v1.0.1 修复）

### 问题描述
自动检查失败，API 返回 `FR_INVALID_REQUEST`。
之前版本（v0.9.6 及更早）使用的 body 模板包含 `<?xml version="1.0"?>` 声明：
```
var=<?xml version="1.0"?>><object>...</object>
```
163 服务端已更新，拒绝包含 XML 声明的请求体，导致所有 POST 请求返回 `FR_INVALID_REQUEST`。

### 根因
163 邮箱服务端在 v0.9.6 之后更新了 RPC 接口解析逻辑，不再接受 body 中的 XML 声明前缀。
这是一个服务端变更，与扩展代码无关，但导致此前工作的 API 探测全部失效。

### 修复（v1.0.1）
移除 body 模板中的 `<?xml version="1.0"?>` 声明：
```
# 修改前
bodyTemplate: 'var=<?xml version="1.0"?>><object>...</object>'

# 修改后
bodyTemplate: 'var=<object>...</object>'
```
同时移除 URL 和 Referer 中的 `df=mail163_letter` 参数（页面已不再使用该参数）。

### 验证结果
- 修复前（带 XML 声明）：`FR_INVALID_REQUEST` ❌
- 修复后（无 XML 声明）：`S_OK`，成功返回邮件列表 ✅
- 未读数解析：正常（统计没有 `read:true` 标志的邮件）
- ⚠️ **body 中 `sentDate=2:` 过滤器会遗漏旧未读邮件**（只查最近 2 天），已移除该过滤器以返回全部未读

### 修改文件
- `extension/shared/constants.js` — 更新 `js6_rpc_list` 端点的 `bodyTemplate`、`url` 和 `Referer`
  - 移除 body 中的 `<?xml version="1.0"?>` 声明（163 服务端拒绝包含 XML 声明的请求）
  - 移除 URL 和 Referer 中的 `df=mail163_letter` 参数（不再使用）
   - 移除 body 中的 `<string name="sentDate">2:</string>` 过滤器（只查最近 2 天会遗漏旧未读邮件，移除后返回全部未读）

---

## 🟡 P1：163 listMessages 响应解析 Bug——嵌套括号导致未读数虚高（v1.0.1 修复）

### 问题描述
163 邮箱 API 返回的未读数始终比页面显示多 1 封，且持续存在。

### 根因
`provider-163.js` 的 `parse163Response` 函数中，解析最后一封邮件的结束位置时使用了：
```javascript
jsonText.indexOf(']', emailMatch.index)
```
这会在 **第一个 `]` 处截断**，但该 `]` 可能位于邮件对象的**嵌套结构内**（如 `flags` 对象后面的数组闭合）。

例如一封已读邮件的完整结构：
```
{'id':'754:...','flags':{'read':true,'hasTag':true},...}
                     ^^^^^^^^^^^^^^^^^^^^
                     此处 ']' 先被 indexOf 命中
                     导致 read:true 未被包含在 emailText 中
```

结果：已读邮件被误判为未读，未读数虚高 1 封。

### 修复（v1.0.1）
改用**括号计数**找到匹配的 `}`，而非 `indexOf(']')`：
```javascript
// 修复前
: jsonText.indexOf(']', emailMatch.index);

// 修复后
let braceCount = 0;
for (let i = emailMatch.index; i < jsonText.length; i++) {
  if (jsonText[i] === '{') braceCount++;
  else if (jsonText[i] === '}') {
    braceCount--;
    if (braceCount === 0) { emailEnd = i + 1; break; }
  }
}
```

### 验证
| 解析方式 | 未读数 |
|---------|--------|
| 修复前（indexOf ']') | 1 ❌ |
| 修复后（括号计数） | 0 ✅ |
| 页面实际未读 | 0 ✅ |

### 修改文件
- `extension/providers/provider-163.js` — 修复 `parse163Response` 中最后一封邮件的边界计算

---

## 🟡 P1：163 SW 后台探测——Cookie 通路通，但 RPC func 名是猜测的

### 问题描述
- Cookie 通道已确认可用：返回 `FR_INVALID_REQUEST: Invalid method getSessionInfo for module global`
- 说明请求已穿过鉴权层，但内置的 `func=mbox:listMessages` 等方法名是猜测的

### 实证事实
- 返回错误：`Invalid method getSessionInfo for module global`（非 `FA_UNAUTHORIZED`）
- 若 Cookie 未带上，应返回 `FA_SECURITY`/`FA_UNAUTHORIZED`
- 结论：**Cookie 能穿透，只是 func 名错误**

### 解决方案
从真实页面抓包获取正确的 `func` 参数和 `var` body 格式，回填到：
```javascript
// extension/shared/constants.js
probeEndpoints: [
  {
    name: 'js6_rpc_list',
    url: 'https://mail.163.com/js6/s?func=真实func名&sid={sid}&df=mail163_letter',
    method: 'POST',
    bodyTemplate: 'var=@{真实body格式}',
    // ...
  },
]
```

---

## 🟡 P2：QQ 接口大概率非 HTTP，HTTP 回放路径基本判死刑

### 问题描述
- 内置端点全部 HTTP 404（已退役）：
  - `wx.mail.qq.com/cgi-bin/readdata` → 404
  - `wx.mail.qq.com/cgi-bin/mail_list` → 404
  - `mail.qq.com/cgi-bin/mail_list` → 登录页
- 新版 SPA 加载 WASM 模块，API 可能通过 WASM 内部实现

### 实证数据
```
[GET] https://res.wx.qq.com/t/webmail/mailcdn/22042502/xmtls/xmtls.wasm => [200]
```
WASM 文件已加载，确认 QQ 新版使用 WebAssembly 技术。

### 解决方案
**将 QQ 在方案 B 上标记为"需内容脚本 DOM 兜底"**：
- 停止 HTTP 路径的额外投入
- 保留内容脚本 DOM 读取（用户开标签时可用）
- 自动检查时标记"需手动同步"

---

## 🟢 P3：内容脚本 DOM 读取稳定可靠（已验证）

### 实证结果
- 163：打开标签后 ~2s 内可读 unread=8 ✅
- QQ：多 frame 可读 unread=7 ✅

### 限制
受 AGENTS.md 规则 1 约束，**只能用于用户已打开标签的复用场景**，不能作为自动后台主路径。

---

## 📋 下一步行动清单

### 近期目标
- [x] **163 SW API 打通**（已验证，unread=11）
- [x] **QQ SW API 打通**（已验证，unread=7）
- [x] **USTC SW API 打通**（已验证，unread=2）
- [x] **Gmail Atom feed 接入**（v0.11.0，Cookie 直调，无需 OAuth 商业授权）
- ~~Gmail REST API 接入（OAuth2）~~（v0.11.0 已移除，由 Atom feed 替代）
- [ ] 接口失效自愈 / 热更规则
- [ ] UI 完善（多账户统一显示、通知策略）

### 中期目标
- [ ] API 模式捕获学习（当邮箱改版时自动学习新接口）
- [ ] 检查频率优化（智能退避、差异检查）
- [ ] 隐私增强（Cookie 清理、会话期限管理）

---

## ✅ USTC 邮箱使用须知

### 登录要求
USTC 邮箱需要使用 **Cookie + sid** 双重认证：
1. 用户必须在浏览器中打开并登录 `http://mail.ustc.edu.cn/`
2. 点击扩展 Popup → 「🔑同步USTC」按钮同步会话
3. 扩展会缓存 sid 供后台 SW API 使用

### 技术细节
- USTC 使用 Coremail 系统，API 端点：`/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}`
- 响应包含各文件夹的 `unreadMessageCount` 字段
- 页面打开时需要 sid 参数，否则返回 500 错误

### 当前状态
- ✅ SW API 探测成功（已验证）
- ✅ 内容脚本支持（需用户先登录）
- ⚠️ 自动打开标签时需要带 sid 参数

---

## 🔧 调试工具与日志

### 关键日志模式
| 日志 | 含义 |
|------|------|
| `[capture:netease_163] 页面累计捕获请求 N 条` | 捕获计数 |
| `[capture:netease_163] 本批捕获端点:` | 捕获到的真实接口清单 |
| `批量保存 netease_163 API 模式 N 条` | 已入库 |
| `[163:captured_N] 接口 captured_N 探测成功: unreadCount=8` | 回放成功（最终判据） |

### 调试入口
1. **Popup → 状态 Tab**：查看 API 模式数量
2. **Popup → 探测 Tab**：手动触发探测
3. **Service Worker 控制台**：`edge://extensions/` → 找扩展 → 点「Service Worker」

---

## 📌 参考文档
- `doc/整体方案与进度.md` — 当前方案与进度快照
- `doc/技术选型文档.md` — 历史选型论证
- `extension/debug/VALIDATION.md` — 验证步骤
- `AGENTS.md` — 项目约束规则（最高优先级）

---

## 🔧 日志自动获取方案

### 问题
Service Worker 日志只能通过 `edge://extensions/` 控制台查看，无法自动获取。

### 解决方案
已在 Popup 页面暴露全局函数 `window.getMailNotifierLogs(limit)`，可通过 Playwright 获取：

```javascript
// 在 Playwright 中
await page.goto('chrome-extension://YOUR_EXTENSION_ID/popup/index.html');
const logs = await page.evaluate(() => window.getMailNotifierLogs(100));
console.log(logs);
```

### 实现位置
- `extension/popup/popup.js` → `window.getMailNotifierLogs`
- `extension/background/service-worker.js` → `getDebugLogs` / `getMemoryLogs` 消息处理

---

## 📋 API 接口格式速查

完整接口规格见 [`extension/doc/api-reference.md`](../extension/doc/api-reference.md)。

| 邮箱 | 方法 | 端点 | 认证方式 | 状态 |
|------|------|------|---------|------|
| 163 | POST | `https://mail.163.com/js6/s?func=mbox:listMessages&sid={sid}` | Cookie + sid | ✅ v1.0.1 修复 |
| QQ | GET | `https://wx.mail.qq.com/list/maillist?sid={sid}...` | Cookie + sid | ✅ |
| USTC | GET | `http://mail.ustc.edu.cn/coremail/XT/jsp/mail.jsp?func=getAllFolders&sid={sid}` | Cookie + sid | ✅ |
| Gmail | GET | `https://mail.google.com/mail/u/0/feed/atom` | session Cookie（零 token） | ✅ v0.11.0 |

---

## 🟢 P1：Gmail Atom feed 网页逆向——绕过 Google API 商业授权（v0.11.0 新增）

### 背景
Gmail 官方 REST API 需 Google Cloud 项目商业授权（Gmail API enablement），审批麻烦。
改用「网页逆向」思路：用户浏览器登录过 Gmail 后，直接调 Google 隐藏 Atom feed，
靠 session Cookie 认证，零 token、零 API key。
**原 OAuth2 / gmail.googleapis.com REST 路径已于 2026-09-12 彻底移除**（新方案实测可用，继续观察）。

### 实证结果（2026-09-12）
- **服务端存活探测**（无 cookie）：`/mail/u/0/feed/atom` 与 `/mail/feed/atom` 均返回
  `HTTP 401 + www-authenticate: BASIC realm="mail.google.com"`（而非 404），
  证明端点路由仍存在于 Google 边缘（GSE），只是要求认证。
- **浏览器登录态探测**（用户 Chrome Console 实测）：
  `fetch('https://mail.google.com/mail/u/0/feed/atom', {credentials:'include'})`
  → `status 200`，响应 `<?xml ...?><feed version="0.3" ...><title>Gmail - Inbox for
  lazebird@gmail.com</title>...<fullcount>0</fullcount>`。
  即 **Atom feed 在 2026 年当前仍可用**，`<fullcount>` 为全邮箱精确未读数。

### 实现
`provider-gmail.js` 仅保留 Atom feed 单路径：
- `probeGmailAtomFeed()` 直接 fetch 隐藏端点，浏览器登录态 Cookie 自动附带
  （credentials:'include'），解析 XML 的 `<fullcount>`。
  端点 URL 由 `PROVIDER_CONFIG.gmail.probeEndpoints` 中 `name='atom_feed'` 的条目驱动
  （配置缺失时回退内置默认 URL）。
- 失败（401/403/网络错误）→ 标记 `needsAuth` + `needsManualAuth`，
  引导用户在浏览器登录 Gmail（不弹授权、不开标签，符合 AGENTS 规则 1/2）。

### 修改文件
- `extension/providers/provider-gmail.js` — 重写为 Atom feed 单路径；
  删除 `fetchGmailUnread` / `classifyGmailApiError` / `fetchGmailMessageDetail` 及 OAuth2 import
- `extension/shared/gmail-oauth.js` — **整个文件删除**
- `extension/shared/constants.js` — 删除 `GMAIL_TOKEN_KEYS` / `GMAIL_RENEWAL_KEYS` /
  `PROVIDER_CONFIG.gmail.oauth2`；`probeEndpoints` 仅 `atom_feed`；
  `DEFAULT_SETTINGS.enabledEndpoints.gmail = ['atom_feed']`；
  `API_PATTERN_KEYS` 新增 `CAPTURED_USTC`/`CAPTURED_GMAIL`（见下条）
- `extension/shared/api-patterns.js` — 存储键从「qq/非qq 二分」改为
  `PROVIDER_PATTERN_KEYS` 显式 provider→key 映射，未映射的 provider 不读不写
- `extension/shared/ui-meta.js` — `ENDPOINT_OPTIONS.gmail` 仅 `atom_feed`
- `extension/background/service-worker.js` — 删除 `gmailAuthorize` 消息分支、
  `gmail-oauth` import、onInstalled 的 token 检测；`hasGmailToken` 判据改为
  gmail 恒 false（授权判据由探测结果 `authVerified` 体现）
- `extension/popup/popup.js` — Gmail「同步/探测/检查」按钮统一走 `testProvider`
  （SW Atom feed 探测），移除所有 `gmailAuthorize` 调用与 Google 授权窗文案
- `extension/manifest.json` — 删除 `oauth2` 块、`identity` 权限、`gmail.googleapis.com`
  host 权限；`host_permissions` 保留 `mail.google.com/*`

### 隔离性（不影响其他邮箱）
- 163/QQ/USTC 的捕获/回放链路零改动：`PROVIDER_PATTERN_KEYS` 显式映射下，
  `netease_163`→`CAPTURED_163`、`qq`→`CAPTURED_QQ` 行为与旧二分一致；
  **USTC 从与 163 共享 `CAPTURED_163` 键改为独立 `CAPTURED_USTC` 键**（修遗留 bug，
  各邮箱捕获模式不再串键，且 USTC 的 Coremail 格式本就独立，行为更正确）
- Gmail 走独立固定端点（atom feed），**不进入捕获/回放链路**，与 sid/Cookie 模型解耦
- `service-worker.js` 的 `runSWApiProbe` switch 未改动，`probeGmail` 内部完成探测

### 风险与降级
- **非官方端点**：Google 随时可能 403/废弃 Atom feed（2026-01 有文章称 2023-12 已弃用
  公共 feed，但 2026-08 实测仍可用，状态有争议）——失效时标记「需手动同步」，
  引导用户登录 Gmail 后可自动恢复
- **风控**：轮询复用现有 alarm 间隔（≥60s），不单独加密；无 token 可被吊销
- **中国大陆网络**：atom feed 同样受 GFW 影响，网络错误下次检查自动重试
- **多账户**：当前固定 `u/0`（主账户），多 Gmail 账户需按 authuser 参数扩展

### 验证
- [x] 服务端端点存活（401 非 404）
- [x] 浏览器登录态 fetch 返回 200 + `<fullcount>`
- [ ] 扩展加载后 SW 侧 atom feed 直调（需在浏览器里跑一次 Gmail 检查确认）
