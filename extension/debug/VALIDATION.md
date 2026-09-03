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
2. 版本应为 **0.9.1**

### Step 2：打开邮箱页面 → 确认 API 捕获真正工作（本次最关键）
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
