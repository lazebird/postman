# Known Issues & Solutions

> 本文档记录项目已知问题、根因分析及解决方案。
> 最后更新：2026-09-04 ｜ 当前版本：v0.9.3

---

## 🔴 P0：API 捕获链路产出为零

### 问题描述
- `apiCaptureCount` 恒等于 0
- 内置默认端点数不变，无 `captured_*` 端点产出
- 内容脚本拦截器已覆盖 `document_start` + 全 frame + sendBeacon/EventSource，但仍无法捕获

### 已尝试的修复
| 版本 | 修复内容 | 结果 |
|------|---------|------|
| v0.8.0 → v0.9.1 | 放宽 `isRelevant` 过滤条件 | ❌ 无效 |
| v0.8.0 → v0.9.1 | 覆盖 sendBeacon/EventSource | ❌ 无效 |
| v0.8.0 → v0.9.1 | 所有 frame 独立上报 | ❌ 无效 |
| v0.9.3 | 拦截器提前至 `document_start` | ❌ 无效 |

### 根因分析（推测）
1. **163**：SPA 在 `document_start` 时还未发出业务 API 请求；或请求由已缓存的旧 sid 驱动，拦截时机错过
2. **QQ**：新版 webmail 使用 WASM（`xmtls.wasm` 已加载），API 调用可能通过 WASM 内部实现，不走标准 fetch/XHR

### 验证数据
- 163 登录页：`mail.163.com` → iframe 注入登录表单 → `frameJS6` 预加载
- QQ 登录页：`wx.mail.qq.com` → 加载 `xmtls.wasm` + 登录 JS
- 两者均无业务 API 请求（因未登录）

### 解决方案
**必须通过用户手动抓包获取真实 API 格式**：
1. 用户在已登录浏览器中打开邮箱页面
2. DevTools → Network 面板 → 刷新
3. 找到包含 `func=` 或 `sid=` 的请求
4. 复制 Request URL、Method、Headers、Body（注意 URL 编码）

**代码回填位置**：`extension/shared/constants.js` → `PROVIDER_CONFIG[provider].probeEndpoints`

**关键发现**：
- 163 的 body 需要 URL 编码（`encodeURIComponent`）
- 163 响应中的日期格式为 `new Date(...)` 非标准 JSON，需预处理后解析
- 163 响应使用单引号而非双引号，且布尔值未加引号，JSON.parse 无法直接解析
- **解决方案**：使用正则表达式直接解析响应，统计没有 `read:true` 的邮件数量
- QQ 使用 HTTP API（非 WebSocket），响应直接包含 `body.unread_num` 字段

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

### 立即执行（本周）
- [x] **手动抓包 163 真实 API**
  - 打开已登录 163 邮箱
  - DevTools → Network → 刷新
  - 找到 `func=` 参数和 `var` body 格式
  - 回填到 `constants.js`

- [x] **确认 QQ WebSocket 假设**
  - 在已登录 QQ 邮箱页面
  - DevTools → Network → WS 面板
  - 观察是否有 WebSocket 连接
  - **结论**: QQ 使用 HTTP API（非 WebSocket），`unread_num` 字段直接返回未读数

### 中期（方案 B 定性后）
- [ ] Gmail REST API 接入（OAuth2 + `gmail.readonly` scope）
- [ ] USTC 适配（需 Native Messaging 兜底）
- [ ] 接口失效自愈 / 热更规则

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
