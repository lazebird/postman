# GitHub Pages 站点源目录

本目录通过 GitHub Actions（`.github/workflows/pages.yml`）自动发布到 **GitHub Pages**，
作为扩展商店（Chrome Web Store / Microsoft Edge Add-ons）所需的公开站点与隐私政策地址。

## 页面路径

发布后站点为**项目页面**，地址形如 `https://<owner>.github.io/<repo>/`。
本项目仓库名为 `postman`，但站点内容位于 `docs/mail-notifier/`，因此路径为：

| 路径 | 文件 | 说明 |
|------|------|------|
| `/mail-notifier/` | `mail-notifier/index.html` | 首页（产品介绍） |
| `/mail-notifier/privacy/` | `mail-notifier/privacy/index.html` | 隐私政策（中英双语） |
| `/mail-notifier/terms/` | `mail-notifier/terms/index.html` | 服务条款（中英双语） |

> 隐私政策 URL 可直接填入商店后台：
> `https://<owner>.github.io/mail-notifier/privacy/`

## 说明

- 纯静态站点，无外部依赖、无构建步骤；`docs/` 目录即产物。
- `docs/.nojekyll` 关闭 Jekyll 处理，确保下划线开头的文件/目录不被忽略。
- 样式与脚本位于 `mail-notifier/assets/`，中英文内容通过 `lang.js` 切换。
- 页面为 `目录/index.html` 结构，因此 URL 末尾不带 `.html`。
