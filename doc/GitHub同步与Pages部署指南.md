# GitHub 同步与 Pages 部署指南

> 面向 **扩展商店上架（隐私政策 URL / 服务条款 URL）** 场景的最小化部署指南。
> 注：v0.11.0 起 Gmail 改走隐藏 Atom feed + 浏览器会话 Cookie，不再使用 Google OAuth，无需 Google Cloud OAuth 品牌验证。
> 核心结论：**不需要把整个项目源码同步到 GitHub**，只需要一个公开可访问的静态站点。

---

## 1. 结论先行：Google 需要什么

Google Cloud Console 的 **OAuth 同意屏幕（OAuth consent screen）** 在「发布 / 验证」阶段需要
（注：当前版本 Gmail 不再使用官方 API，已无需 OAuth 品牌验证；以下仅作历史参考）：

| Google 要求 | 本项目对应的页面 | 是否必需 |
|-------------|------------------|----------|
| **应用主页（Application home page）** | `https://<owner>.github.io/<repo>/` | 是 |
| **隐私政策链接（Privacy policy URL）** | `https://<owner>.github.io/<repo>/privacy/` | **是（强制）** |
| **服务条款链接（Terms of Service URL）** | `https://<owner>.github.io/<repo>/terms/` | 选填（但对品牌验证与商店上架加分） |
| **已授权域名（Authorized domains）** | `github.io`（如用 GitHub Pages） | 是 |
| **应用 Logo / 名称 / 支持邮箱** | 站点首页 Logo + `lazebird@gmail.com` | 是 |

### 关键点

1. **隐私政策是硬性要求**，必须在应用主页**同一域名**下可匿名访问（无需登录、无 JS 阻断）。
2. **授权域名**只需填顶层域名（如 `github.io`），不需要填完整路径。
3. ~~**敏感数据（Gmail 受限 scope）**~~ —— **已废弃，v0.11.0 移除**：Gmail 改走隐藏 Atom feed + 浏览器会话 Cookie，
   不再申请受限 scope，无需 Google 品牌验证 + 数据使用审核。
   （历史要求：审核会检查隐私政策是否声明收集的数据范围与用途、遵循 Google API Services User Data Policy
   （含 Limited Use 限制）、数据不转售 / 不用于广告 / 画像 / AI 训练、数据删除方式与联系方式；
   本项目 `docs/privacy/` 仍按以上要求撰写，见第 5 节。）
4. **站点所有权验证**：建议用 **Google Search Console** 的 HTML 标记方式验证 `github.io` 站点，
   在 `docs/index.html` 中取消 `google-site-verification` meta 标签注释并填入令牌即可。

**所以：只把 `docs/` 站点发布到 GitHub Pages 就足够满足商店所需的页面，无需同步源码。**

---

## 2. 站点结构

`docs/` 目录即站点产物（无构建步骤）：

```
docs/
├── index.html            → /            首页（= mail-notifier/index.html）
├── privacy/index.html    → /privacy/    隐私政策（中英双语）
├── terms/index.html      → /terms/      服务条款（中英双语）
├── mail-notifier/        → /mail-notifier/…  同一份页面的另一套路径（兼容旧链接）
├── .nojekyll             关闭 Jekyll（下划线目录不被忽略）
├── robots.txt
└── sitemap.xml
```

最终地址（owner = `lazebird`，repo = `postman`）：

| 页面 | 地址 |
|------|------|
| 首页 | `https://lazebird.github.io/postman/` |
| 隐私政策 | `https://lazebird.github.io/postman/privacy/` |
| 服务条款 | `https://lazebird.github.io/postman/terms/` |

> **注意**：GitHub Pages 项目页面的路径前缀是**仓库名**，不是 `mail-notifier`。
> 若一定要 `https://<owner>.github.io/mail-notifier/privacy/` 这种地址，
> 需把站点内容放到名为 `mail-notifier` 的 GitHub 仓库中（见第 6 节）。

---

## 3. 部署方式 A：GitHub 侧自动部署（推荐，最简单）

仓库内已内置 `.github/workflows/pages.yml`：

1. 把本仓库（或仅 `docs/` 与 `.github/`）推送到 GitHub；
2. GitHub 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；
3. **Actions → Deploy GitHub Pages → Run workflow** 跑一次；
4. 之后每次 push `docs/**` 会自动重新部署。

推送源码到 GitHub 的方式见第 4 节（CNB 流水线自动同步）或手动 `git push`。

---

## 4. 部署方式 B：CNB → GitHub 自动同步（含令牌配置）

CNB 平台提供 **`tencentcom/git-sync` 插件**，可在流水线中定时/触发式推送代码到 GitHub。
配合 **密钥仓库** 存放 GitHub 令牌，即可实现「改完 CNB 代码 → 自动同步到 GitHub → 自动部署 Pages」。

### 4.1 第一步：获取 GitHub 令牌（PAT）

1. 登录 GitHub → 右上角头像 → **Settings**
2. 左侧最下方 **Developer settings**
3. **Personal access tokens**
   - **推荐：Fine-grained tokens** → *Generate new token*
     - **Repository access**：仅勾选目标仓库（如 `lazebird/postman`），最小权限
     - **Permissions → Repository permissions**：
       - **Contents: Read and write**（推送代码必需）
       - **Metadata: Read-only**（自动附带）
       - 如需工作流自行改动，再加 **Workflows: Read and write**
     - 过期时间建议 90 天（便于轮换）
   - 或 **Tokens (classic)** → *Generate new token (classic)*
     - 勾选 **`repo`**（私有仓库全量）或 **`public_repo`**（仅公开仓库）
4. 生成后**立即复制**令牌（形如 `github_pat_xxx` / `ghp_xxx`），页面刷新后不再显示。

> 安全提醒：令牌等同密码，**不要**写进任何会被提交的文件；本项目通过 CNB 密钥仓库注入。

### 4.2 第二步：在 CNB 创建密钥仓库并存令牌

1. 打开 <https://cnb.cool/new/repos>，仓库类型选择 **密钥仓库**（如命名为 `lazebird/secrets`）
2. 在 Web 界面新建文件 `github-sync.yml`：

```yaml
# GitHub 同步凭据
GIT_USERNAME: lazebird
GIT_ACCESS_TOKEN: github_pat_xxxxxxxxxxxxxxxx

# 允许引用范围（最小权限原则）
allow_slugs: lazebird/postman
allow_events: push, crontab.*
allow_branches: main
```

> `allow_*` 一旦声明，即不再检查触发者角色，完全按规则放行。
> 密钥仓库禁止本地 clone、禁止本地推送，只能 Web 编辑，安全性更高。

### 4.3 第三步：在 `.cnb.yml` 引用密钥并同步

仓库 `.cnb.yml` 已内置定时同步流水线，只需把 `imports` 里的占位地址换成你的密钥仓库文件地址：

```yaml
main:
  "crontab: 0 */6 * * *":          # 每 6 小时同步一次
    - name: sync-docs-to-github
      imports:
        - https://cnb.cool/lazebird/secrets/-/blob/main/github-sync.yml
      stages:
        - name: sync to github
          image: tencentcom/git-sync
          settings:
            target_url: https://github.com/lazebird/postman.git
            auth_type: https
            username: $GIT_USERNAME
            password: $GIT_ACCESS_TOKEN
            branch: main
            sync_mode: push
            force: 'false'
```

也可作为 push 事件流水线（每次提交即同步）：

```yaml
main:
  push:
    - name: sync-to-github
      imports:
        - https://cnb.cool/lazebird/secrets/-/blob/main/github-sync.yml
      stages:
        - name: sync to github
          image: tencentcom/git-sync
          settings:
            target_url: https://github.com/lazebird/postman.git
            auth_type: https
            username: $GIT_USERNAME
            password: $GIT_ACCESS_TOKEN
            force: 'false'
```

### 4.4 `git-sync` 常用参数

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `target_url` | 是 | - | 目标仓库 URL（HTTPS 或 SSH） |
| `auth_type` | 否 | `https` | `https` / `ssh` |
| `username` | HTTPS 必填 | - | GitHub 用户名 |
| `password` | HTTPS 必填 | - | **PAT 令牌** |
| `ssh_key` | SSH 必填 | - | SSH 私钥内容 |
| `branch` | 否 | - | 只推送指定分支；不填则推送所有分支 |
| `force` | 否 | `false` | 强制推送 |
| `push_tags` | 否 | `false` | 是否推送标签 |
| `sync_mode` | 否 | `push` | `push` / `rebase`（保留目标仓库文件）/ `pull` |

> 只做「最小同步」时可加 `ifModify: ["docs/**"]`，仅在站点文件变更时触发。

### 4.5 如果只想同步 `docs/`（不同步源码）

商店上架只需站点页面，可用 **`sync_mode: rebase` + 独立分支** 或 **只保留 docs 的最小仓库**：

- **方案 1（推荐）**：另建一个只放站点内容的 GitHub 仓库（如 `lazebird/mail-notifier`），
  把 `docs/**` 复制过去作为仓库根，`target_url` 指向该仓库。
  这样 GitHub 上**只有页面，没有源码**，隐私政策 URL 也就是
  `https://lazebird.github.io/mail-notifier/privacy/`。
- **方案 2**：GitHub 上只保留 `main` 分支，但通过 `.github/workflows/pages.yml`
  的 `paths: docs/**` 控制，代码仍会被同步（源码暴露）。
  若不想暴露源码，用方案 1。

#### 方案 1 的最小流水线（只推 docs 目录）

```yaml
main:
  push:
    - name: sync-site-only
      imports:
        - https://cnb.cool/lazebird/secrets/-/blob/main/github-sync.yml
      stages:
        - name: 准备纯站点目录
          script: |
            rm -rf /tmp/site && mkdir -p /tmp/site
            cp -r docs/. /tmp/site/
            ls -R /tmp/site | head -30
        - name: 推送到站点仓库
          image: tencentcom/git-sync
          settings:
            target_url: https://github.com/lazebird/mail-notifier.git
            auth_type: https
            username: $GIT_USERNAME
            password: $GIT_ACCESS_TOKEN
            force: 'true'
```

> 注：`git-sync` 默认以当前工作目录为源。若需只推送子目录，
> 可先用 `script` 把 `docs/` 内容复制到工作区临时目录并 `cd` 过去，
> 或直接使用「方案 1 + 手动首次推送」的方式建立站点仓库。

---

## 5. 隐私政策必须覆盖的 Google 条款

`docs/privacy/` 与 `docs/mail-notifier/privacy/` 已包含以下小节，满足 Google API Services User Data Policy：

- **仅用于用户可见功能**：读取未读数用于角标 / 通知；
- **不传输给第三方**：数据仅留在本机 `chrome.storage.local`；
- **不用于广告 / 画像 / 信用评估**；
- **不用于训练 AI 模型**；
- **人类不可读**：除用户主动请求支持、安全调查或法律要求外，无人工读取；
- **数据保留与删除**：可随时在设置页清除，卸载即删除；
- **联系方式**：`lazebird@gmail.com`。

---

## 6. 常见问题

**Q：只做 GitHub Pages，不把源码同步到 GitHub，可以吗？**
A：可以，且这正是推荐做法。商店只校验「页面能公开访问」，不关心源码是否在 GitHub。
最干净的方式是：另建一个只放站点内容的仓库（第 4.5 节方案 1）。

**Q：GitHub 令牌要填到哪儿？会不会泄露？**
A：填入 **CNB 密钥仓库**（第 4.2 节），通过 `imports` 注入为环境变量，
再由 `git-sync` 插件的 `settings` 引用。令牌不会出现在仓库文件、日志或前端代码中。

**Q：`github.io` 需要单独验证域名吗？**
A：~~Google Cloud Console 的「已授权域名」填 `github.io` 即可~~（当前版本已无需 Google OAuth，此项不再适用）；
如需证明站点归属，用 Google Search Console 的 HTML 标记（见第 1 节第 4 点）。

**Q：GitHub Pages 部署后多久生效？**
A：通常 1–2 分钟；首次需在 Settings → Pages 选择 GitHub Actions 源。

**Q：令牌过期了怎么办？**
A：在密钥仓库 Web 界面更新 `github-sync.yml` 的 `GIT_ACCESS_TOKEN` 即可，
所有引用该文件的流水线会自动取到新值，无需改代码。
