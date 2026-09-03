# 浏览器邮箱插件（Edge Mail Notifier）

- Microsoft Edge 浏览器插件（MV3）
- 支持 163 / Gmail / USTC / QQ 等邮箱
- 支持邮件检查、未读计数、桌面通知、快速跳转邮件
- 低消耗、及时通知、通用/适配/兼容
- 部署简单：不需要额外部署服务器
- 使用简单：不用保持网页打开等状态

## 目录结构

```
├── doc/
│   └── 技术选型文档.md          # 技术选型与方案设计
├── extension/                   # MV3 扩展（方案 B PoC）
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js    # 定时任务 + 未读接口探测
│   ├── providers/
│   │   ├── provider-163.js      # 163 未读接口探测（含 sid 会话获取）
│   │   └── provider-qq.js       # QQ 未读接口探测（含 sid 会话获取）
│   ├── shared/
│   │   ├── constants.js         # 提供商配置/接口端点
│   │   ├── debug.js             # 调试日志工具
│   │   ├── session.js           # 会话 sid 获取与缓存管理
│   │   └── storage.js           # chrome.storage 封装
│   ├── popup/                   # Popup UI
│   ├── options/                 # 设置页面
│   └── debug/                   # 调试与验证指南
```

## 当前进度

- [x] 技术选型文档（v3.1）
- [x] 方案 B PoC：163/QQ 未读接口探测骨架
- [x] 修复：163/QQ 会话 sid 获取与使用（v0.2.0）
- [ ] 方案 B 真实环境验证
- [ ] Gmail REST API 接入
- [ ] 完整 UI 与生产功能

## 核心修复（v0.2.0）

### 问题定位

163 探测失败返回 `No sid parameter!` 的根因：163 的 `js6/s` RPC 网关需要 `sid` 会话令牌，而原代码直接调用业务接口，未先获取 sid。

### 修复方案

1. **新增 `shared/session.js` 会话管理模块**
   - 从 163/QQ 登录后的邮箱入口页提取 sid
   - 会话 sid 缓存至 `chrome.storage.session`（30 分钟有效）
   - 支持强制刷新、自动过期清理

2. **163 provider 重构**
   - 探测前先获取 sid，再带 sid 调用业务接口
   - POST 请求正确携带 body
   - 改进响应解析（XML / JSON / 自定义格式）

3. **QQ provider 重构**
   - 使用 sid 构造接口 URL
   - 正确处理 GB18030 编码
   - 登录状态准确识别

4. **其他优化**
   - 修复 response headers 序列化（Headers → Object）
   - 日志系统健壮性提升
   - UI 增加会话状态展示与刷新功能

## 快速开始

详见 `extension/debug/README.md` 加载扩展并验证方案 B 可行性。

## 技术文档

详见 [`doc/技术选型文档.md`](doc/技术选型文档.md)
