# 方案 C PoC — 真实环境验证计划 v3

> 前 4 轮验证确认：纯 SW 跨源 fetch 无法复用 163/QQ 的 SameSite=Lax 登录 Cookie，
> 导致「在 SW 里通过访问页面提取 sid」路径不可行。
> 故切换为 **方案 C：内容脚本 in-origin 探测** —— 在真实邮箱页面内读取未读数。

## 为什么换方案 C（结论先给）

| 方案 | 会话 Cookie 来源 | 结果 |
|------|------------------|------|
| 方案B(SW跨源fetch) | 第三方上下文，SameSite=Lax 不附带 | ❌ 前4轮均 `No sid`/未登录 |
| **方案C(内容脚本)** | 页面第一方上下文，天然携带 | ✅ 可行 |

内容脚本注入 `mail.163.com`/`mail.qq.com` 后，与页面**同源**：
- fetch/读取不触发 CORS，不丢 Cookie
- 可直接读 DOM 里已渲染的「收件箱(8)」等真实未读数
- 可从页面 iframe/URL/window 取 sid（如需走内部接口）

## 验证步骤

### Step 1：加载扩展
1. `edge://extensions/` → 开发者模式
2. 移除旧版扩展 → 重新 **加载已解压的扩展程序** 选 `extension/`
3. 确认权限弹窗接受（新增了 `cookies`、`scripting` 权限）

### Step 2：打开并登录邮箱页面
- 访问 https://mail.163.com/ 并登录（能看到收件箱，未读约 8 封）
- 访问 https://mail.qq.com/ 并登录（如需验证 QQ）

> ⚠️ 邮箱页面需保持打开，内容脚本才能读到未读数。

### Step 3：运行方案 C 探测
1. 右键扩展图标 → **选项**，找到「**方案C · 内容脚本探测（推荐）**」卡片
2. 点 **📄 内容脚本探测 163**
3. 若没有打开的 163 邮箱标签，扩展会**自动打开**并稍候重试
4. 查看下方 JSON 结果

**预期**：`probe.unreadCount` 能读到真实未读数（如 8），`probe.loggedIn` 为 true。

### Step 4：Cookie 诊断（定位「SW 能否复用登录态」）
在 Options 点 **🍪 诊断会话 Cookie**，查看结论字段：

| conclusion | 含义 | 结论 |
|-----------|------|------|
| `SW_CAN_ATTACH_COOKIES` | 存在 SameSite=None 的登录 Cookie | 方案B理论上可救 |
| `SW_CANNOT_ATTACH_COOKIES` | 登录 Cookie 均为 SameSite=Lax | 方案B基本不可行，坚持方案C ✅ |
| `NO_AUTH_COOKIE_VISIBLE` | 未看到登录 Cookie | 确认浏览器确实未登录，或 Cookie 被主机隔离 |

### Step 5：结果判定

**✅ 方案 C 可行**：`probe.unreadCount` 与网页显示一致 → 说明「读真实登录页」这条路通了。

在此基础上可继续做「保活/自动打开邮箱标签」以达成后台自动提醒：
- 用 `chrome.tabs` 保持一个后台邮箱标签存活（最小化/固定）
- 定时用内容脚本读取未读数 → 桌面通知

## 需要记录的关键信息
| 信息 | 来源 |
|------|------|
| Cookie 诊断 conclusion | Options → 方案C → 🍪 诊断会话 Cookie |
| 内容脚本读取的未读数 | Options → 方案C → 📄 内容脚本探测 |
| 页面 URL / host | 探测结果 detail |
| 浏览器版本 | 浏览器关于页 |
