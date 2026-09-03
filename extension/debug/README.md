# 方案 C PoC — 调试指南

本指南说明如何在本机真实环境中验证**方案 C（内容脚本 in-origin 探测）**的可行性。

## 背景结论（为什么不是方案 B）

经多轮真实环境验证，**方案 B（SW 跨源 fetch 逆向 webmail）不可行**：

> MV3 Service Worker 的跨源 fetch 是第三方上下文，163/QQ 的登录 Cookie 多为
> `SameSite=Lax`，不会被附带 → SW 永远拿不到登录态与 sid。

方案 C 用**内容脚本**在邮箱页面内（同源上下文）运行，天然带第一方 Cookie、无 CORS
限制，可读到页面真实未读数。这是绕开死结的有效路径。

## 调试入口

1. **Options → 方案C · 内容脚本探测（推荐）**
   - 📄 内容脚本探测 163 / QQ：向已打开（或自动打开）的邮箱标签发探测指令
   - 🍪 诊断会话 Cookie：读取目标站登录 Cookie 的 SameSite 标志，用数据证明结论

2. **Popup → 探测 标签页**
   - 内容脚本探测 163 / QQ / 诊断会话 Cookie

3. **内容脚本控制台**：在邮箱页面按 F12 → Console，可看 `[probe-content]` 输出

## 判定

- 内容脚本 `unreadCount` 与网页显示一致 → 方案 C 可行 ✅
- Cookie 诊断 `SW_CANNOT_ATTACH_COOKIES` → 佐证方案 B 不可行，坚持方案 C

## 让后台自动提醒

方案 C 需邮箱页面存活，V1 建议用 `chrome.tabs` 保活一个后台邮箱标签（固定/最小化），
再由内容脚本定时读取未读数触发通知。
