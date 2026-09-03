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
│   │   ├── provider-163.js      # 163 未读接口探测
│   │   └── provider-qq.js       # QQ 未读接口探测
│   ├── shared/
│   │   ├── constants.js
│   │   ├── debug.js             # 调试日志工具
│   │   └── storage.js
│   ├── popup/                   # Popup UI
│   ├── options/                 # 设置页面
│   └── debug/README.md          # 调试与验证指南
```

## 当前进度

- [x] 技术选型文档（v3.1）
- [x] 方案 B PoC：163/QQ 未读接口探测骨架
- [ ] 方案 B 真实环境验证
- [ ] Gmail REST API 接入
- [ ] 完整 UI 与生产功能

## 快速开始

详见 `extension/debug/README.md` 加载扩展并验证方案 B 可行性。

## 技术文档

详见 [`doc/技术选型文档.md`](doc/技术选型文档.md)
