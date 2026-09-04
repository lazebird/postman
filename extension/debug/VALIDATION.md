# v0.9.1 — 真实环境验证计划（聚焦：修复 API 捕获断链）

## 背景

SW 后台纯 API 探测已确证能带上会话 Cookie（163 的 `A1 include` 已穿过安全层到达 RPC
分发层，仅因内置 `func` 方法名是「凭空猜测」才报 `Invalid method`）。真正卡点收敛为：
**内容脚本始终没捕获到邮箱页面的真实 API 请求**（上一轮 `endpointCount` 与内置默认
端点数完全一致、没有任何 `captured_*` 端点）。

v0.9.1 针对该断链做了修复，让捕获真正工作，从而把「真实接口格式」补齐，再去验证
纯 SW 后台读取的可行性。

## v0.9.1 捕获修复内容

| 项 | 修复前 | 修复后 |
|----|--------|--------|
| 捕获过滤 `isRelevant` | 极窄：要求命中 `mail.163.com\|mail.qq.com\|wx.mail.qq.com\|js6\|s?func` | 放宽：只要命中 `163.com` / `qq.com` 域名且非静态资源即捕获 |
| 捕获通道 | 仅 `fetch` + `XHR` | 额外覆盖 `sendBeacon` / `EventSource` |
| 上报 frame | 仅顶层 frame 上报，iframe 内 API 全被丢弃 | 所有 frame 独立捕获、独立上报（`fromFrame: top/sub`） |
| 捕获数量 | 上限 30、过滤易漏 | 上限 200，更完整 |
| 结果反馈 | 无捕获计数 | 每 5s 上报 `[capture:provider] 页面累计捕获请求 N 条` |
| 每批端点 | 不打印 | 打印 `[capture:provider] 本批捕获端点:\n<每个 method+url>` |

## 验证步骤

### Step 1：加载扩展
1. `edge://extensions/` → 开发者模式 → 移除旧版 → 重新加载选择 `extension/` 目录
2. 版本应为 **0.9.4**（新增 USTC 支持 + API 拦截器分离）

### Step 2：测试 163 邮箱
1. 打开已登录的 163 邮箱页面
2. 观察 Service Worker 日志应出现：
   - `[capture:netease_163] 页面累计捕获请求 N 条`
   - `批量保存 netease_163 API 模式 N 条`
1. 打开并登录 **163邮箱**（`https://mail.163.com/`），等页面完全加载、左侧显示未读数
2. 打开 **QQ邮箱**（`https://mail.qq.com/`，会自动到 `wx.mail.qq.com`），同样等加载完成
3. 扩展 Service Worker 控制台应出现捕获证据：
   - `[capture:netease_163] 页面累计捕获请求 N 条 @ mail.163.com`
   - `[capture:qq] 页面累计捕获请求 N 条 @ wx.mail.qq.com`
   - 批量保存日志 `批量保存 netease_163 API 模式 N 条`
   - `[capture:netease_163] 本批捕获端点:` 后列出真实请求（method + url + body）
4. Popup → 统计标签页应显示 **163 API 模式 / QQ API 模式 > 0 条**

> ⚠️ 判断本次修复是否生效：**只要统计页 API 模式 > 0、或日志出现 `本批捕获端点`，
> 就说明捕获链路打通了**。若为 0，则需把「页面累计捕获请求」行和本批端点日志发我，
> 判定是注入失败还是真实接口不在 `163.com/qq.com` 域（可能需要继续放宽或改用 content
> script 同源主动探测方式）。

### Step 3（捕获成功后）验证纯 SW 后台读取
1. 确认统计页 163/QQ API 模式都 > 0 后，**关闭全部邮箱标签**
2. Popup → 手动探测 → 运行全量检查（alarm 路径亦可）
3. 预期：不打开任何标签，SW 用捕获的真实 API 模式 + 缓存 sid 回放 → 读出未读数
   - 日志：`[163:captured_1] 接口 captured_1 探测成功: unreadCount=8`
   - 日志：`[qq:captured_3] 接口 captured_3 探测成功: unreadCount=7`

## 关键日志（反馈时请复制）
- `[capture:netease_163] 页面累计捕获请求 N 条` — 捕获计数
- `[capture:netease_163] 本批捕获端点:\n...` — 捕获到的真实接口清单
- `批量保存 netease_163 API 模式 N 条` — 已入库
- `[163:captured_N] ... unreadCount=8` — 回放成功（可行性的最终判据）

## 判定标准
| 结果 | 结论 |
|------|------|
| 捕获 > 0 + 关闭标签后回放成功 | ✅ 纯 SW 后台读取可行 |
| 捕获 > 0 但回放失败 | 回放请求的 Cookie/格式仍有差异，据本批端点日志继续精修 |
| 捕获仍 = 0 | 捕获链路仍未通，据日志继续定位（扩大匹配 / 换同源探测） |

---

# v0.9.2 — 深入测试：邮箱页「多级跳转 → 最终呈现邮件内容」

## 背景

上一轮 v0.9.1 已修复 API 捕获断链。实测中确认一个现象：**进入邮箱页面后会经历多次跳转，
最终才呈现邮件内容**。例如：
- QQ：`mail.qq.com` → (已登录) `wx.mail.qq.com` 网页版 → SPA 加载后才出现收件箱未读
- 163：`mail.163.com` → `js6/main.jsp` → 收件箱内容
- 未登录时还会先跳转到登录页（`ptlogin2`/`login` 等）

内容脚本/捕获在跳转链路的**任意一段**都可能被注入，因此需要在日志中看清
「当前到底落在跳转链的哪一段」，才能判断：
- 是还没跳到内容页（需继续等待 / 导航）？
- 还是已到内容页但没读到未读数（解析/注入问题）？
- 还是根本没登录（被重定向到登录域）？

## v0.9.2 新增

### 1. 内容脚本导航阶段识别 (`probe-content.js`)
内容脚本每次上报都会携带当前页面的「导航阶段」：
- 综合当前 URL、`document.referrer`(上一跳来源)、`readyState`、是否拿到 sid / 未读
- 输出字段：`stage`(`entry`/`login-redirect`/`webmail-app`/`unknown`)、`frameRole`(`top`/`sub`)、
  `contentReached`(是否已到内容页)、`referrer`
- 日志样例：
  - `内容脚本上报: qq 未读=3 @ ... | url=https://wx.mail.qq.com/... | stage=webmail-app (top)`
  - `页面落点: qq @ https://mail.qq.com/... | stage=entry (top) | 尚未到内容页`

### 2. Service Worker 跳转链路观测 (`probeWithRetry`)
每次开/导航邮箱标签后轮询时，记录标签先后经历的不同 URL，并在结束时汇总整条链路：
- `[redirect-trace:qq] tabId=123 跳转落点 #1: https://mail.qq.com/...`
- `[redirect-trace:163] tabId=124 跳转链路共 2 段:\nhttps://mail.163.com/\n→ https://mail.163.com/js6/main.jsp`
- 若只 1 段：`无二次跳转，最终停留: <url>`

### 3. `contentPageReady` 落点日志
内容脚本就绪即打印页面落点（含 stage/referrer/frameRole），用于观察每级跳转注入情况。

## 验证步骤

### Step 1：加载 v0.9.2
`edge://extensions/` → 开发者模式 → 移除旧版 → 重新加载 `extension/`（版本 **0.9.2**）

### Step 2：打开邮箱 → 观察「跳转链路」日志
1. **163**：打开 `https://mail.163.com/`（或通过 Popup「打开邮箱」），等收件箱出现未读
2. **QQ**：打开 `https://mail.qq.com/`，观察是否跳到 `wx.mail.qq.com`
3. Service Worker 控制台应出现：
   - `[redirect-trace:...] 跳转落点 #N: <url>`（每级跳转一条）
   - `页面落点: ... | stage=webmail-app (top)`（已到网页版）
   - `内容脚本上报: ... 未读=N @ ... | url=<wx.mail.qq.com/...>`
4. 重点确认：**最终停留的 URL 是内容页**（stage=`webmail-app` / 读到未读）。

### Step 3：API 捕获是否继续工作
1. 打开并保持邮箱页加载完毕
2. 日志应出现 `[capture:...] 本批捕获端点:`、`批量保存 ... API 模式 N 条`
3. Popup → 统计页确认 163/QQ API 模式 > 0

### Step 4（可选）未登录场景
清 cookie 后打开邮箱，确认日志能定位到 `stage=login-redirect` / `登录跳转`，
而非误判为「已到内容页但读不到未读」。

## 反馈时请复制这些日志
- `[redirect-trace:<provider>] ... 跳转落点 #N: <url>` — 跳转链每一跳
- `[redirect-trace:<provider>] ... 跳转链路共 N 段` — 完整链路
- `页面落点: <provider> @ <url> | stage=... (top/sub)` — 当前导航阶段
- `内容脚本上报: <provider> 未读=N @ ...` — 已读到内容
- `批量保存 <provider> API 模式 N 条` / `[capture:...] 本批捕获端点` — 捕获是否工作

## 判定标准
| 现象 | 结论 |
|------|------|
| 跳转链路日志完整、最终 stage=`webmail-app` 且读到未读 | ✅ 内容页呈现确认 |
| 只看到 `entry`/`login-redirect`，无 `webmail-app` | 尚未跳到内容页或未登录，据 URL 判断 |
| 无任何 `[redirect-trace]` 日志 | 页面未走轮询/导航路径，据 `页面落点` 日志定位 |
