# store-asset-gen — 商店图文素材生成器

生成 Chrome Web Store 商品素材（扩展徽标 / 磁贴 / 截图）到 `doc/store-assets/`。

## 依赖（非项目内置）

需要 `@napi-rs/canvas`（本地临时安装，不写入 package.json）：

```bash
npm install @napi-rs/canvas --no-save
```

## 用法

```bash
# 1) 基础素材：徽标 + 小磁贴 + 大磁贴（需要先在 doc/store-assets 已生成，脚本内部 mkdir）
node scripts/store-asset-gen/gen-base-assets.js
# 2) 截图：4 张 1280×800 说明图
node scripts/store-asset-gen/gen-screenshots.js
```

> 两脚本各自声明独立函数，分别独立可运行；输出均落在 `doc/store-assets/`。
> 重新生成前建议先清空该目录再运行，避免残留。
