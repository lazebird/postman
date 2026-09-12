# 浏览器邮箱插件（Edge Mail Notifier）

- Microsoft Edge 浏览器插件（MV3）
- 支持 163 / QQ / USTC / Gmail 等邮箱
- 支持邮件检查、未读计数、桌面通知、快速跳转邮件
- 混合方案：API 模式捕获学习 + SW 后台独立检查 + 内容脚本提取会话

## 目录结构

```
├── AGENTS.md                    # ⚠️ 项目约束规则（最高优先级，禁止违反）

├── .github/workflows/pages.yml  # GitHub Pages 自动部署（发布 docs/）
├── docs/                        # GitHub Pages 站点源码（首页/隐私政策/服务条款）
├── doc/
│   ├── 整体方案与进度.md        # 当前方案与进度快照
│   └── 技术选型文档.md          # 技术选型与方案设计
├── extension/                   # MV3 扩展
│   ├── manifest.json
│   ├── background/
│   │   ├── service-worker.js    # 定时任务 + 混合检查调度 + Cookie 诊断
│   │   └── possibility-tests.js # 全可能性 Cookie 测试
│   ├── content/
│   │   ├── probe-content.js     # 内容脚本：提取 sid + in-origin 未读探测
│   │   ├── api-interceptor.js   # API 拦截器（独立文件，绕过 CSP）
│   │   └── probe-fetch-inject.js # Fetch 注入器（绕过 CSP）
│   ├── providers/
│   │   ├── provider-163.js      # 163 SW 接口探测（使用缓存 sid）
│   │   ├── provider-qq.js       # QQ SW 接口探测（使用缓存 sid）
│   │   └── provider-ustc.js     # USTC SW 接口探测（使用缓存 sid）
│   ├── shared/
│   │   ├── constants.js         # 提供商配置/接口端点/检查模式
│   │   ├── debug.js             # 调试日志工具
│   │   ├── session.js           # sid 工具函数（URL/DOM 解析等）
│   │   ├── session-cache.js     # sid 会话缓存统一封装（存储键映射 + TTL 读写清除）
│   │   ├── session-diagnose.js  # Cookie 会话诊断
│   │   ├── storage.js           # chrome.storage 分层封装
│   │   └── api-patterns.js      # API 模式捕获与回放
│   ├── popup/                   # Popup UI
│   └── debug/                   # 调试与验证指南
```

## 核心架构：混合检查模式

本项目采用「混合检查模式」：以 **API 模式捕获学习 + SW 后台独立检查** 为核心方案。
当用户偶尔打开邮箱页面时，内容脚本自动学习页面真实 API 请求格式并存储。
后台定时检查使用学习到的真实 API 格式 + 持久化 sid + Cookie 进行独立探测。
**后台定时检查绝不自动打开任何可见/后台标签**。

```
┌─────────────────────────────────────────────────────────────────────┐
│                      v0.8.0 混合模式检查流程                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SW 定时触发（每 N 分钟）                                            │
│       │                                                             │
│       ▼                                                             │
│  ① SW API 直调（带持久化缓存 sid + Cookie）                          │
│       ├── ✅ 读到未读数 → 更新 badge + 通知                           │
│       └── ❌ 无有效 sid 或 API 失败                                    │
│             │                                                       │
│             ▼                                                       │
│  ② 查已打开的邮箱标签 → 有则用内容脚本读未读（不新开标签）              │
│       ├── ✅ 读到未读数 → 更新 badge + 通知                           │
│       └── ❌ 无标签且非用户主动操作                                     │
│             │                                                       │
│             ▼                                                       │
│  ③ 自动检查失败 → 标记「需手动同步」→ 不打开标签                       │
│      手动检查（Popup/Options 点击）→ 打开邮箱标签同步 sid → 自动关闭    │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

> 说明：后台定时检查**绝不自动打开可见标签**（避免每次检查都弹出标签页，严重影响使用体验）。
> sid 持久化存储于 `chrome.storage.local`（7 天 TTL），只要用户偶尔打开过一次邮箱，
> 后续多天内均可纯后台 API 检查，无需可见标签页。
> 当 sid 过期且用户未打开邮箱时，自动检查会标记「需手动同步」，不会打扰用户。

### 为什么需要「混合」而不是纯内容脚本？

| 方案 | 需常驻邮箱页 | 定时后台检查 | 可见标签干扰 | 可靠度 | 说明 |
|------|------------|------------|------------|--------|------|
| **混合模式（当前 v0.7.0）** | ❌ 不需要（sid持久化7天） | ✅ | ❌ 不打开 | ⭐⭐⭐⭐ | SW API为主 + 内容脚本补充，仅在用户主动操作时开标签 |
| 纯内容脚本 | ✅ 需要 | 仅页面存活时 | 无 | ⭐⭐⭐⭐ | DOM 读取最可靠，但需常驻页面 |
| 纯 SW API | ❌ | ✅ | 无 | ⭐⭐ | 依赖 sid 有效性，sid 过期即失效 |

### 关键流程（授权 → 获取未读数）

1. **授权（一次）**：浏览器打开并登录 `mail.163.com` / `mail.qq.com`
2. **同步会话**：Options → 点「🔑 授权·同步会话」→ 扩展后台打开邮箱页提取 sid → 缓存至本地 → 关闭标签
3. **日常使用**：SW 每 N 分钟检查 → SW API + 缓存 sid → badge + 通知（全程无可见标签打开）
4. **sid 过期后**：自动检查标记「需手动同步」，用户打开邮箱或点击同步按钮后恢复正常
5. **手动检查**：Popup → 「🚀 运行全量检查」→ 仅在无有效 sid 时打开邮箱标签同步（用户主动触发）

> **说明**：自动后台检查**不会**打开任何可见标签。当用户已在浏览器打开邮箱页面时，
> 内容脚本会自动读取未读数并刷新 sid，无需额外操作。

## 当前进度

- [x] 技术选型文档
- [x] 方案 B PoC：SW 跨源 fetch 未读接口探测
- [x] 真实环境验证（多轮）：修正 cookie 分析结论，确认 MV3 特权上下文可附带 Cookie
- [x] 方案 C：内容脚本 in-origin 探测
- [x] **混合方案 v0.4.0：内容脚本提取 sid + SW 独立 API 检查**
- [x] **v0.5.0：修复无标签页时 163/QQ 检查失败（Cookie 直调 API + 自动恢复会话）**
- [x] **v0.6.0：修复标签页关闭后全量/自动检查均失败**
- [x] **v0.7.0：后台自动检查不打开可见标签**（仅用户主动触发才开标签，sid 持久化 7 天）
- [x] **v0.8.0：API 模式捕获与回放**（页面打开时学习真实 API，后台无页面时精确复现）
- [x] **v0.9.0–0.9.2：『全可能性』后台无标签测试**（穷举 Cookie 附加策略，修正 Cookie 通道结论）
- [x] **v0.9.3：拦截器提前至 document_start 打通 API 捕获链路**
- [x] **v0.9.4：添加 USTC 邮箱支持 + API 拦截器分离**（解决 CSP 限制）
- [x] **163 SW API 打通**（实测 unread=11）
- [x] **QQ SW API 打通**（实测 unread=7）
- [x] **USTC SW API 打通**（实测 unread=2）
- [x] **Gmail Atom feed 接入**（v1.0.2，浏览器 Cookie 直调隐藏 Atom feed，零 token、无需 Google Cloud 商业授权；原 OAuth2 路径已彻底移除）
- [x] **新邮件通知系统**（检测变化并发送桌面通知）
- [ ] 完整 UI 与生产功能
- [ ] 多邮箱统一通知

## 数据持久化与存储分层

| 存储区 | 存放的数据 | 插件更新时 |
|--------|-----------|-----------|
| `chrome.storage.local`（持久化） | 账号配置、用户设置、检查历史、sid（7天TTL） | ✅ **保留** |
| `chrome.storage.session`（会话级） | 调试日志 | ⚠️ 清空 |

## 快速开始

详见 [`extension/debug/VALIDATION.md`](extension/debug/VALIDATION.md)。

## 技术文档

> 📋 **当前整体方案与进度**见 [`doc/整体方案与进度.md`](doc/整体方案与进度.md)；
> 📜 历史选型论证与逐版本演进见 [`doc/技术选型文档.md`](doc/技术选型文档.md)


## GitHub Pages 站点与商城隐私政策

项目内置一个纯静态站点，用于扩展商店（Chrome Web Store / Microsoft Edge Add-ons）所需的
**隐私政策 URL** 与产品落地页，源文件位于仓库 `docs/` 目录，由 GitHub Actions 自动发布。

| 页面 | 路径 | 源文件 |
|------|------|--------|
| 首页 | `/`、`/mail-notifier/` | `docs/index.html`、`docs/mail-notifier/index.html` |
| 隐私政策 | `/privacy/`、`/mail-notifier/privacy/` | `docs/privacy/index.html`、`docs/mail-notifier/privacy/index.html` |
| 服务条款 | `/terms/`、`/mail-notifier/terms/` | `docs/terms/index.html`、`docs/mail-notifier/terms/index.html` |

- 发布工作流：`.github/workflows/pages.yml`（push `docs/**` 或手动 `workflow_dispatch` 触发）；
- 站点为纯静态站点，无构建步骤、无外部依赖，支持深色模式与**全站中英双语切换**
  （首次按浏览器语言自动选择，切换结果记忆在 `localStorage`，无 JS 时默认渲染中文）；
- 页面文案通过 `data-zh` / `data-en` 属性声明，隐私政策与服务条款为两套完整正文
  （`#doc-zh` / `#doc-en`），统一由 `docs/assets/lang.js` 切换，写法见 [`docs/README.md`](docs/README.md)；
- 首次使用需在 GitHub 仓库 **Settings → Pages → Source 选择「GitHub Actions」**，随后运行一次工作流；
- 站点为 GitHub 项目页面，路径前缀是**仓库名**，即
  `https://<owner>.github.io/postman/`、`https://<owner>.github.io/postman/privacy/`；
- **不需要把项目源码同步到 GitHub**：只发布 `docs/` 即可满足扩展商店的页面要求；
- 详细说明见 [`docs/README.md`](docs/README.md) 与
  [`doc/GitHub同步与Pages部署指南.md`](doc/GitHub同步与Pages部署指南.md)。

## 代码规范与静态检查

项目引入 ESLint + Prettier，统一代码风格并做静态审查，CI 每次构建都会自动执行并自动修复。

- 根目录新增 `scripts/lint.sh`：先 Prettier 自动格式化，再 ESLint `--fix` 自动修复，
  随后做只读复核，确保代码符合规范（修复后仍有无法自动处理的问题会以非零退出码告警）。
  - 本地执行：`./scripts/lint.sh`
  - 只读检查：`./scripts/lint.sh --check`
  - 亦可通过 `npm run lint` / `npm run format` 分别调用。
- ESLint 配置 `eslint.config.mjs`：`no-undef` 保持 `error`（可捕获「漏导入即调用」类缺陷），
  对遗留代码常见且语义无害的空 `catch` 降级为 `warn`，并关闭 `no-useless-escape` 以免误改工作正常的正则；
  `no-unused-vars` 忽略 catch 捕获参数，消除空 `catch(e)` 的噪音告警。
- **规则与工具版本固定**，避免不同开发环境因版本/配置差异导致规范不一致、出现大面积 lint 问题：
  - `devDependencies` 中的 `eslint`、`prettier` 使用**精确版本**（无 `^`），并提交 `package-lock.json`，
    保证 `npm ci` / `npm install` 在任何机器上解析到完全一致的版本。
  - `.nvmrc` 固定 Node 20，`package.json` 声明 `engines.node` 与 CI（`node:20`）保持一致。
  - `.editorconfig` 统一所有编辑器的缩进/换行；`.gitattributes` 强制文本文件使用 LF，规避 Windows 换行差异。
  - `.vscode/settings.json` 开启保存自动格式化（Prettier + ESLint），并推荐对应扩展（`.vscode/extensions.json`）。
- 代码结构原则（数据逻辑分离 / 子模块隔离）：
  - **sid 会话缓存**统一收敛到 `extension/shared/session-cache.js`，`service-worker` 与各 provider 不再各自硬编码存储键与过期逻辑。
  - 其余通用工具按职责拆分在 `extension/shared/`，各 provider 仅依赖共享接口，降低耦合。
- CI（`.cnb.yml`）：`main` 分支 push 与 PR 触发 lint，安装依赖后执行 `./scripts/lint.sh`。
