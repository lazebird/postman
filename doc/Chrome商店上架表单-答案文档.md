# Google Chrome Web Store 上架表单 · 填写答案文档（中英对照）

> 为提交 **Google Chrome Web Store** 的扩展商店（Chromium Web Store 开发者控制台）
> 商品详情表单提供逐字段的填写答案与**可直接上传的资源文件**。
> 语言环境选用 **英语(美国) English (United States)**。本文件同时给出中文与英文两个版本，
> 方便你在控制台里切换语言或为多语言铺货复用。资源文件统一生成于同目录 `store-assets/`。
> 对照：Edge 商店的隐私审核表单答案见 `doc/Edge商店提交表单-答案文档.md`，
> 商店发布全流程与打包脚本见 `doc/扩展商店发布指南.md`。

---

## 填写前须知

- **扩展名 / 描述** 在开发者控制台里与 `extension/manifest.json` 的 `name` / `description` 一致；
  本表单的商品"描述(description)"是**营销文案**，可写得比 manifest 更易读、更详细（下面提供）。
- Chrome Web Store 的商品描述**每种语言只有一份**（非中英两份并存），
  此处给出两种语言文本供你复制粘贴到对应语言的 listing 中。
- 图片规格需严格满足（像素、纵横比），生成好的资源文件直接上传即可。
- 本扩展涉及 `cookies` / `declarativeNetRequest` / `identity` 等敏感权限且涉及读取邮箱数据，
  提交前务必先填好**隐私政策**（见 `doc/PRIVACY.md`），否则版本会被驳回。

---

## 一、语言 (Language)

| 字段 | 值 |
|------|-----|
| **语言 Language** | English (United States) 英语（美国） |

> 建议以英语(美国)为**主 listing 语言**；中文（简体）文本也已备好，便于后续新增 `zh-CN` 语言铺货。

---

## 二、扩展名 (Extension name)

### 中文版

**Mail Notifier**

### 英文版

**Mail Notifier**

> 说明：扩展名取自程序包清单 manifest 的 `name`（≤ 75 字符）。如需在控制台改动，应同步回改
> `extension/manifest.json` 的 `name` 字段，重新打包再上传。
> 同时标题可直接复用此名：`Mail Notifier`（多邮箱未读邮件提醒）。

---

## 三、描述 (Description)

> 商店允许使用纯文本，不建议堆砌关键词堆砌。下面文案明确列出**支持的邮箱**、**核心功能**、
> **隐私/静默承诺**（不含任何邮件正文的上传），与 `doc/PRIVACY.md` 完全一致。

### 中文版描述

```
Mail Notifier —— 多邮箱未读邮件提醒扩展（Chrome MV3）

在您的浏览器工具栏集中显示 163 / QQ / USTC 邮箱 / Gmail 等多邮箱的未读邮件数量，
并第一时间在桌面弹出"新邮件"通知。全程在本机完成，不向任何第三方服务器上传邮件数据。

核心特性
· 多邮箱统一面板：一处查看 163、QQ、中科大(USTC)、Gmail 的未读数与最新状态
· 工具栏角标：各邮箱未读数一目了然，新邮件即时点亮
· 桌面通知：有新邮件时静默弹出本地通知，不打扰您当前工作
· 完全静默后台检查：定时在后台运行，绝不自动打开或常驻任何邮箱标签页
· 智能会话学习：偶尔打开一次邮箱即可学习真实接口格式并缓存会话，
  之后无需开着邮箱页面也能纯后台读取未读数（会话缓存 7 天）
· 隐私优先：全部数据仅保存在本机浏览器(chrome.storage.local)，
  无服务器、无账号、不上传邮件内容；支持 Gmail 官方 OAuth2 只读授权(gmail.readonly)

检查间隔(1–30 分钟)与模式(混合/仅内容脚本/仅 SW API)均可自定义，适配不同习惯。
邮箱未读提醒，就该这么安静、干净、省心。
```

### 英文版描述 (English)

```
Mail Notifier — Multi-mailbox unread-email notifier (Chrome MV3)

See unread counts from 163, QQ, USTC and Gmail mailboxes in one place right from
your browser toolbar, and get instant desktop notifications for new mail.
Everything is processed locally on your machine — your email data is never sent
to any third-party server.

Key features
· Unified multi-mailbox panel: monitor unread count & status for 163, QQ,
  USTC (University of Science and Technology of China) and Gmail at a glance
· Toolbar badge: total unread count visible on the toolbar icon; lights up on new mail
· Desktop notifications: silent local notifications when new mail arrives —
  no interruption to what you are doing
· Truly silent background checking: scheduled checks run quietly in the background
  and never auto-open or keep-alive any mailbox tab
· Smart session learning: open your mailbox once and the extension learns the real
  API format and caches the session, so it can read unread counts later without any
  open mailbox page (session cached for 7 days)
· Privacy-first: all data stays in your local browser storage (chrome.storage.local) —
  no servers, no account, no uploading of your email content; supports official
  Gmail OAuth2 read-only access (gmail.readonly)

Check interval (1–30 min) and checking modes (Hybrid / Content-script-only /
SW-API-only) are fully customizable to fit your habits.
Unread-email alerts should be this quiet, clean and worry-free.
```

---

## 四、类别 (Category)

| 字段 | 值（英文） | 值（中文） |
|------|-----------|-----------|
| **类别 Category** | Productivity | 效率/生产力 |

---

## 五、扩展徽标 (Extension logo)

> 规格：**300×300 或 128×128**（建议 128×128，可 2x 高质量输出），纵横比 **1:1**，建议 ≤ 128KB，PNG。

**资源文件**（已生成，直接上传）：
- `doc/store-assets/extension-logo-128.png`（128×128）
- `doc/store-assets/extension-logo-512.png`（512×512，高质量备用）

设计说明：蓝底圆角方块 + 白色信封 + 状态色细节，与扩展工具栏图标视觉一致，延续既有 `icons/` 的品牌。

---

## 六、小促销磁贴 (Small promo tile)

> 规格：**440×280 像素**（纵横比约 1.57），PNG，建议不透明背景。

**资源文件**：
- `doc/store-assets/small-promo-tile-440x280.png`（440×280）

文案（内含）：`Mail Notifier — Unread mail badge & silent desktop alerts` + 四家邮箱徽标 `163 · QQ · USTC · Gmail`。

---

## 七、屏幕截图 (Screenshots)

> 规格：**1280×800 或 640×400 像素**，PNG 或 JPEG，最多 6 张。展示扩展实际工作方式。
> 下面已生成 4 张 1280×800 示意图，可直接上传；如需凑满 6 张可再补录真实运行界面。

**资源文件**（均 1280×800）：
1. `doc/store-assets/screenshot-1-overview-1280x800.png`
   多邮箱未读总览面板（工具栏 Popup 概览，含 163/QQ/USTC/Gmail 未读数与「全量检查」按钮）。
2. `doc/store-assets/screenshot-2-notification-1280x800.png`
   新邮件桌面通知（后台静默弹出本地通知，不新开标签）。
3. `doc/store-assets/screenshot-3-settings-1280x800.png`
   设置页：添加邮箱账户、检查间隔、检查模式（混合/仅内容脚本/仅 SW API）。
4. `doc/store-assets/screenshot-4-badge-1280x800.png`
   工具栏角标与图标三态（正常/有未读/需授权）。

> 若商店要求截图须为"真实界面录屏/截图"，建议后续用装有本扩展的 Chrome 实际打开 Popup、
> 触发通知后各截 1~2 张替换上面的示意图（尺寸保持 1280×800）。

---

## 八、大型促销磁贴 (Large promo tile / Marquee)

> 规格：**1400×560 像素**，PNG/JPEG，纵横比 2.5:1，不透明背景，用于商店首页展示。

**资源文件**：
- `doc/store-assets/large-promo-tile-1400x560.png`（1400×560）

文案（内含）：`Mail Notifier — Multi-mailbox unread checker · silent background alerts` +
特性勾选项 + 四家邮箱未读卡片演示 + `Available on Chrome Web Store`。

---

## 九、YouTube 视频 URL（可选）

| 字段 | 值 |
|------|-----|
| **YouTube 视频 URL** | 留空 / 不填写（本项目暂未制作演示视频）。如需提供可另附一个 ≤60 秒的使用演示视频链接。 |

---

## 十、搜索词 (Search terms)

> 最多 **7 个词**，每个词 **≤ 30 字符**，且每个词所含独立词数 **≤ 21 个**。
> 搜索词不得与"扩展名"重复；需能帮助用户找到本扩展。**注意**：Chrome Web Store 主要用英文检索，
> 中文搜索词仅在你启用了对应语言铺货时才有帮助。此处提供英文为主、兼顾中文的推荐。

### 英文版推荐（7 个，每个均 ≤ 30 字符）

```
mail notifier
unread email count
email desktop notification
163 mail checker
qq mail checker
gmail unread
multi-account inbox badge
```

### 中文版参考（如新增 zh-CN 语言铺货时使用）

```
邮箱未读提醒
邮件桌面通知
163邮箱检测
QQ邮箱检测
多邮箱角标
Gmail未读
邮件免打扰提醒
```

> 供复制粘贴：`mail notifier, unread email count, email desktop notification, 163 mail checker, qq mail checker, gmail unread, multi-account inbox badge`

---

## 十一、页面使用 (Content usage / 使用情况)

若控制台询问本扩展的用途，选：
- **让用户为您的邮件/消息保持最新** 或等效"效率 / 通知"类描述均可。

---

## 十二、提交前自查清单

- [ ] 语言选择为 **English (United States)**；
- [ ] 扩展名 `Mail Notifier` 与 manifest `name` 一致；
- [ ] 描述为纯文本营销文案（已含邮箱支持清单 / 功能 / 隐私声明），与 `PRIVACY.md` 一致；
- [ ] 已上传 `store-assets/extension-logo-128.png`（或 512）；
- [ ] 已上传 `store-assets/small-promo-tile-440x280.png`；
- [ ] 已上传 1~6 张 `store-assets/screenshot-*.png`（1280×800）；
- [ ] 已上传 `store-assets/large-promo-tile-1400x560.png`；
- [ ] 搜索词 ≤ 7 个、每个 ≤ 30 字符、独立词 ≤ 21 个；
- [ ] 已在 "Privacy practices" 栏声明使用权限并附公开**隐私政策 URL**（见 `doc/PRIVACY.md`）；
- [ ] 产物由 `./scripts/release.sh pack` 打包且通过校验（manifest 根级、版本递增）。

---

## 十三、关于表单里的按钮控件（保存草稿 / 关闭）

你在详情页底部看到的 **「保存草稿」(Save draft)** 与 **「关闭」(Close)** 是商店表单的**操作按钮**，
无需填写内容：

| 控件 | 说明 |
|------|------|
| **保存草稿 Save draft** | 点击后将当前填写的 listing 内容存为草稿（未发布），可稍后继续编辑。填写完本文件各字段后建议先点它保存草稿。 |
| **关闭 Close** | 关闭当前编辑页。若尚未保存，改动会丢失，提交前务必先「保存草稿」。 |

> 提示：Chrome Web Store 的 listing 分**语言标签页**管理——你切换 / 新增一种语言（如 English(US)）后，
> 需在该语言下分别填写并保存以上"名称 / 描述 / 图像"等字段。发布审核是基于**已保存并可公开**的版本，
> 全部填写完成并「保存草稿 / 提交审查」后再关闭页面。

---

## 附：资源文件清单（doc/store-assets/）

```
store-assets/
├── extension-logo-128.png            扩展徽标 128×128（1:1）
├── extension-logo-512.png            扩展徽标 512×512（高质量备用）
├── small-promo-tile-440x280.png      小促销磁贴 440×280
├── large-promo-tile-1400x560.png     大型促销磁贴 1400×560
├── screenshot-1-overview-1280x800.png   截图① 多邮箱未读总览
├── screenshot-2-notification-1280x800.png 截图② 新邮件桌面通知
├── screenshot-3-settings-1280x800.png    截图③ 设置页（账户/间隔/模式）
└── screenshot-4-badge-1280x800.png       截图④ 工具栏角标与图标三态
```

> 全部为 PNG、不透明背景（徽标圆角处透明）。若商店要求必须是**真实运行界面截图**，
> 建议后续用装有本扩展的 Chrome 打开 Popup / 触发通知后补拍，仍保持 1280×800。

> **再生成方式**：素材由 `scripts/store-asset-gen/` 下脚本生成（依赖 `@napi-rs/canvas`），
> 使用方式见 `scripts/store-asset-gen/README.md`。调整配色/文案后重跑即可刷新图像。
