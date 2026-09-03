# 浏览器邮箱插件（Edge Mail Notifier）

- Microsoft Edge 浏览器插件（MV3）
- 支持 163 / Gmail / USTC / QQ 等邮箱
- 支持邮件检查、未读计数、桌面通知、快速跳转邮件
- 低消耗、及时通知、通用/适配/兼容
- 部署简单：不需要额外部署服务器

## 目录结构

```
├── doc/
│   └── 技术选型文档.md          # 技术选型与方案设计
├── extension/                   # MV3 扩展（方案 C PoC）
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js    # 定时任务 + 内容脚本调度 + Cookie 诊断
│   ├── content/
│   │   └── probe-content.js     # 内容脚本：in-origin 未读探测（方案 C 核心）
│   ├── providers/
│   │   ├── provider-163.js      # 163 SW 接口探测（保留，仅诊断对比）
│   │   └── provider-qq.js       # QQ SW 接口探测（保留，仅诊断对比）
│   ├── shared/
│   │   ├── constants.js         # 提供商配置/接口端点
│   │   ├── debug.js             # 调试日志工具
│   │   ├── session.js           # 会话 sid 获取与缓存（旧）
│   │   ├── session-diagnose.js  # Cookie 会话诊断（判定 SW 可复用性）
│   │   └── storage.js           # chrome.storage 封装
│   ├── popup/                   # Popup UI
│   ├── options/                 # 设置页面
│   └── debug/                   # 调试与验证指南
```

## 当前进度与结论

- [x] 技术选型文档
- [x] 方案 B PoC：SW 跨源 fetch 未读接口探测
- [x] 真实环境验证（多轮）：**结论 = SW 跨源无法复用 SameSite=Lax 登录 Cookie，方案 B 不可行**
- [x] 转向 **方案 C：内容脚本 in-origin 探测**（在真实邮箱页面内读未读数）
- [ ] 方案 C 真实环境验证
- [ ] Gmail REST API 接入
- [ ] 完整 UI 与生产功能

## 核心结论（为什么换方案 C）

前 4 轮在 SW 里始终拿不到 163 登录态（`No sid` / 未登录），根因不是代码缺陷，而是**架构边界**：

> MV3 Service Worker 的跨源 fetch 属于第三方上下文，163/QQ 的登录 Cookie 多为
> `SameSite=Lax`，浏览器不会把它们随 SW 的跨站后台请求发送。

内容脚本注入邮箱页面后与页面**同源**，天然携带第一方 Cookie、无 CORS 限制，
可直接读取页面已渲染的真实未读数。这是绕开上述死结的有效路径。

新增 **🍪 诊断会话 Cookie** 功能，用 `chrome.cookies` 输出目标站登录 Cookie 的
SameSite/Secure 标志，用数据证明上述结论并指导后续走向。

## 快速开始

详见 [`extension/debug/VALIDATION.md`](extension/debug/VALIDATION.md) 进行方案 C 真实环境验证。

## 技术文档

详见 [`doc/技术选型文档.md`](doc/技术选型文档.md)
