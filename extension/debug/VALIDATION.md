# 混合方案 v0.4.0 — 真实环境验证计划

## 背景：为什么需要混合方案

经真实环境验证发现：
1. **内容脚本可以读取真实未读数**（如 163 邮箱 8 封未读）✅
2. **内容脚本可以从页面 URL 提取 sid**（如 `INdDcKKhuxodUgDvjUZVHhzIloQcYmuA`）✅
3. **163/QQ 的 webmail 是 SPA**，sid 由前端 JS 动态生成，SW 静态 fetch 无法获取

因此设计**混合方案**：
- 内容脚本在页面中提取 sid → 缓存
- SW 用缓存 sid + Cookie 调 API → 实现后台独立检查
- 仅需用户偶尔打开邮箱页同步一次会话

## 验证步骤

### Step 1：加载扩展
1. `edge://extensions/` → 开发者模式
2. 移除旧版扩展 → 重新加载选择 `extension/` 目录
3. 接受新增的 `cookies` / `scripting` / `tabs` 权限

### Step 2：同步会话（获取 sid）
1. 打开 Options 设置页
2. 找到「混合方案 · 会话与探测」卡片
3. 点击 **🔄 同步163会话**
4. 扩展会自动打开 `mail.163.com`（若已登录则直接进入邮箱）
5. 内容脚本在页面加载后自动提取 sid 并缓存

**预期结果**：
- 会话状态卡片显示 **163邮箱 sid ✅**
- 探测结果显示 `sidObtained: true`

### Step 3：验证 SW 独立 API 探测
1. 关闭 163 邮箱标签页（保留浏览器不关闭）
2. 回到 Options 页 → 点击 **测试**（对应账户）
3. 或在 Popup → 运行全量检查

**预期**：
- 若 API 调用成功：能看到 `method: "sw-api"` 和正确的 `unreadCount`
- 若 API 失败但内容脚本能读：会回退到内容脚本模式
- 若两者都失败：提示需要重新同步会话

### Step 4：诊断结果解读

| conclusion | 含义 |
|-----------|------|
| `SW_CAN_ATTACH_COOKIES` | 存在 SameSite=None 的 Cookie → SW 跨源大概率可带 |
| `SW_MAY_ATTACH_COOKIES` | 登录 Cookie 为 SameSite=Lax → MV3 特权上下文可能可带，需实测 |
| `NO_AUTH_COOKIE_VISIBLE` | 未检测到登录 Cookie → 需先在浏览器中登录邮箱 |

## 关键日志观察

打开扩展的 Service Worker 控制台（`edge://extensions/` → 点击「Service Worker」链接）查看：

- `[service-worker] 从内容脚本缓存 netease_163 sid (来自页面 URL)` — sid 已缓存
- `[account:xxx@163.com] SW API 探测成功: unread=8` — API 独立探测成功
- `[account:xxx@163.com] 缓存的 sid 已失效，尝试刷新` — sid 过期回退

## 常见问题

**Q: 为什么我点击同步后 sid 还是显示 ❌？**
A: 可能原因：① 邮箱未登录；② 页面未加载完成内容脚本未执行。请确认已登录邮箱并等待页面加载完成后再试。

**Q: SW API 探测总是失败？**
A: 先确认 Cookie 诊断结论。若 `NO_AUTH_COOKIE_VISIBLE` 说明浏览器未登录；若 `SW_MAY_ATTACH_COOKIES` 需确认 sid 是否有效（可能已过期）。

**Q: 需要经常同步吗？**
A: sid 缓存 30 分钟。如果每次检查间隔都较短且 sid 频繁过期，可能需要更频繁地同步。未来版本将增加自动刷新机制。
