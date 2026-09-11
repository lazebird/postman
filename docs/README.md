# GitHub Pages 站点源目录

本目录通过 GitHub Actions（`.github/workflows/pages.yml`）自动发布到 **GitHub Pages**，
作为扩展商店（Chrome Web Store / Microsoft Edge Add-ons）所需的公开站点与隐私政策地址。

## 页面路径

发布后站点为**项目页面**，地址形如 `https://<owner>.github.io/<repo>/`。
`docs/` 即站点根目录，`docs/` 下的子目录直接映射为 URL 路径：

| 路径 | 文件 | 说明 |
|------|------|------|
| `/` | `index.html`（由 `mail-notifier/index.html` 托管） | 首页（产品介绍） |
| `/privacy/` | `mail-notifier/privacy/index.html` | 隐私政策（中英双语） |
| `/terms/` | `mail-notifier/terms/index.html` | 服务条款（中英双语） |

> URL 中**不带仓库名后缀** `mail-notifier`：GitHub Pages 项目页面的 `/mail-notifier/`
> 是站点根路径本身（仓库名恰好为 `mail-notifier` 时才成立）。本仓库名为 `postman`，
> 因此实际地址为：
>
> - 首页：`https://<owner>.github.io/postman/`
> - 隐私政策：`https://<owner>.github.io/postman/privacy/`
> - 服务条款：`https://<owner>.github.io/postman/terms/`
>
> 若希望使用 `https://<owner>.github.io/mail-notifier/privacy/` 这类地址，
> 需把站点源码放到名为 `mail-notifier` 的 GitHub 仓库中。

## 说明

- 纯静态站点，无外部依赖、无构建步骤；`docs/` 目录即产物。
- `docs/.nojekyll` 关闭 Jekyll 处理，确保下划线开头的文件/目录不被忽略。
- 样式与脚本位于 `mail-notifier/assets/`，中英文内容通过 `lang.js` 切换。
- 页面为 `目录/index.html` 结构，因此 URL 末尾不带 `.html`。
- `mail-notifier/` 下的相对链接（`assets/`、`privacy/`、`terms/`）与 `docs/` 根目录的
  站点结构保持一致，因此站点根目录下的 `index.html` 可直接托管 `mail-notifier/index.html` 的内容。

## 站点根 `index.html` 与 `mail-notifier/` 的关系

`docs/` 根目录的 `index.html` 与 `docs/mail-notifier/index.html` 内容一致：
前者用于站点根路径（`/postman/`），后者保留在 `mail-notifier/` 目录下。
`privacy/` 与 `terms/` 亦同时提供于 `docs/` 根目录与 `docs/mail-notifier/` 目录，
使 `/postman/privacy/` 与 `/postman/mail-notifier/privacy/` 两种地址均可访问。
