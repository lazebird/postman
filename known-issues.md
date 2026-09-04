# Known Issues & Solutions

> 本文档记录项目已知问题、根因分析及解决方案。
> 最后更新：2026-09-04 ｜ 当前版本：v0.9.4

---

## ✅ 已完成功能（v0.9.4）

### 163 邮箱
- ✅ SW API 探测成功
- ✅ 未读数：11 封
- ✅ API：`POST https://mail.163.com/js6/s?func=mbox:listMessages`
- ✅ Body：XML 编码的 var 参数（需 URL 编码）
- ✅ Response：JSONP，统计 `flags.read=false` 的邮件数量

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
- [ ] Gmail REST API 接入（OAuth2 + `gmail.readonly` scope）
- [ ] 接口失效自愈 / 热更规则
- [ ] UI 完善（多账户统一显示、通知策略）

### 中期目标
- [ ] API 模式捕获学习（当邮箱改版时自动学习新接口）
- [ ] 检查频率优化（智能退避、差异检查）
- [ ] 隐私增强（Cookie 清理、会话期限管理）

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

## ✅ 已获取的真实 API 格式（2026-09-04）

### 163 邮箱
- **Sid**: `yMiYNuMVIdrFuhKUNueYdgXyypJsSdVZ`
- **未读数**: 10 封
- **API 端点**: `POST https://mail.163.com/js6/s`
- **Func 参数**: `mbox:listMessages`
- **Request Body**:
  ```
  var=%3C%3Fxml%20version%3D%221.0%22%3F%3E%3Cobject%3E%3Cobject%20name%3D%22filter%22%3E%3Cstring%20name%3D%22sentDate%22%3E2%3A%3C%2Fstring%3E%3C%2Fobject%3E%3Cstring%20name%3D%22order%22%3Edate%3C%2Fstring%3E%3Cboolean%20name%3D%22desc%22%3Etrue%3C%2Fboolean%3E%3Carray%20name%3D%22fids%22%3E%3Cint%3E1%3C%2Fint%3E%3Cint%3E18%3C%2Fint%3E%3Cint%3E3685900%3C%2Fint%3E%3C%2Farray%3E%3Cboolean%20name%3D%22skipLockedFolders%22%3Etrue%3C%2Fboolean%3E%3Cint%20name%3D%22limit%22%3E200%3C%2Fint%3E%3Cstring%20name%3D%22mrcid%22%3E7097b0f0d99a7b25206f1101c79a1bb8_v1%3C%2Fstring%3E%3C%2Fobject%3E
  ```
- **Response**: JSONP 格式，包含邮件列表和未读数

### QQ 邮箱
- **Sid**: `zYhHToy0VDguOmNMABJTbgAA`
- **未读数**: 7 封
- **API 端点**: `GET https://wx.mail.qq.com/list/maillist`
- **Query 参数**: `sid={sid}&dir=1&dirid=1&func=1&sort_type=1&sort_direction=1&page_now=0&page_size=50&enable_topmail=true`
- **Response**: JSON 格式，包含 `unread_num: 7`
