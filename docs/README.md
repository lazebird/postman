# GitHub Pages 站点源目录

本目录通过 GitHub Actions（`.github/workflows/pages.yml`）自动发布到 **GitHub Pages**，
作为扩展商店（Chrome Web Store / Microsoft Edge Add-ons）所需的公开站点与隐私政策地址。

## 页面路径

发布后站点为**项目页面**，地址形如 `https://<owner>.github.io/<repo>/`。
`docs/` 即站点根目录，`docs/` 下的子目录直接映射为 URL 路径：

| 路径 | 文件 | 说明 |
|------|------|------|
| `/` | `index.html` | 首页（产品介绍，中英双语） |
| `/privacy/` | `privacy/index.html` | 隐私政策（中英双语） |
| `/terms/` | `terms/index.html` | 服务条款（中英双语） |

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
- 样式与脚本位于 `assets/`（`mail-notifier/assets/` 保留一份完全相同的副本，兼容旧地址）。
- 中英文内容通过 `assets/lang.js` 切换，详见下方「多语言（i18n）」。
- 页面为 `目录/index.html` 结构，因此 URL 末尾不带 `.html`。
- `mail-notifier/` 下的相对链接（`assets/`、`privacy/`、`terms/`）与 `docs/` 根目录的
  站点结构保持一致，因此站点根目录下的 `index.html` 可直接托管 `mail-notifier/index.html` 的内容。

## 站点根 `index.html` 与 `mail-notifier/` 的关系

`docs/` 根目录的 `index.html` 与 `docs/mail-notifier/index.html` 内容一致：
前者用于站点根路径（`/postman/`），后者保留在 `mail-notifier/` 目录下。
`privacy/` 与 `terms/` 亦同时提供于 `docs/` 根目录与 `docs/mail-notifier/` 目录，
使 `/postman/privacy/` 与 `/postman/mail-notifier/privacy/` 两种地址均可访问。

## 多语言（i18n）

站点所有页面均支持**中英文切换**，切换结果记忆在 `localStorage`（键 `mn-lang`），
刷新与站内跳转后保持；首次访问按浏览器语言自动选择（`zh*` → 中文，其余 → 英文）。
无 JavaScript 时默认渲染中文，页面仍可正常阅读。

### 约定

| 机制 | 写法 | 说明 |
|------|------|------|
| 页面标题 | `<html data-title-zh data-title-en>` | `lang.js` 切换 `document.title` |
| 页面描述 | `<meta name="description" data-desc-en>` | `content` 为中文，另持英文 |
| 社交卡片 | `og:title` / `og:description` 加 `data-og-*-en` | 同上 |
| 简单文案 | `data-zh="…" data-en="…"` | 元素文本按语言替换 |
| 属性文案 | `data-aria-label-zh` / `data-aria-label-en` | 通用形式：`data-<属性名>-zh/-en` |
| 整块内容 | `#doc-zh` / `#doc-en` | 隐私政策、服务条款两套正文，`hidden` 切换 |
| 切换按钮 | `#btn-zh` / `#btn-en` | 位于页头，双按钮 `aria-pressed` 表示当前语言 |
| 语言标记 | `<html lang data-lang>` | `lang` 为 `zh-CN` / `en`，`data-lang` 为 `zh` / `en` |

> 新增页面时：复制现有页面的 `<html>` 头部属性与页头语言切换块，给需要翻译的文案加
> `data-zh` / `data-en`，并在页尾引入 `lang.js` 即可。

两套资源目录（`assets/` 与 `mail-notifier/assets/`）内容需保持一致，改动时请同步复制。
