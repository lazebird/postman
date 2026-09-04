#!/usr/bin/env node
/**
 * gen-icons.js - 生成按「运行状态」区分颜色的扩展图标 PNG
 *
 * 状态 → 图标名前缀 / 颜色：
 *   ok   正常         绿   #26A65B
 *   err  错误         红   #E74C3C
 *   off  停用/不可用  灰   #95A5A6
 *
 * 生成尺寸：16 / 32 / 48 / 128
 * 输出目录：extension/icons/
 */
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('/tmp/pnglib.js');

const STATES = {
  ok: { label: 'ok', base: [38, 166, 91], dark: [22, 116, 62] }, // 绿 正常
  err: { label: 'err', base: [231, 76, 60], dark: [178, 45, 34] }, // 红 错误
  off: { label: 'off', base: [149, 165, 166], dark: [115, 128, 130] }, // 灰 停用/不可用
};
const SIZES = [16, 32, 48, 128];

// 圆角判定
function inRoundRect(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx,
    dy = y - cy;
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= r * r;
}

// 单点采样颜色：返回 [r,g,b,a] 或 null（透明）
function samplePixel(u, v, cfg) {
  const [br, bg, bb] = cfg.base; // 背景 = 状态色
  const [dr, dg, db] = cfg.dark; // 细节（白上的状态色线）

  // 背景（整块，圆角）——底色即状态色
  const rounded = inRoundRect(u * 16, v * 16, 16, 16, 3.2);
  if (!rounded) return null; // 透明圆角

  // 白色信封主体（居中，约占 62%）
  const mX = 0.24,
    mY = 0.3,
    envW = 1 - 2 * mX,
    envH = 1 - 2 * mY;
  const ex = u,
    ey = v;
  const inEnv =
    ex >= mX &&
    ex <= mX + envW &&
    ey >= mY &&
    ey <= mY + envH &&
    inRoundRect((ex - mX) * 100, (ey - mY) * 100, envW * 100, envH * 100, 6);

  if (!inEnv) {
    // 纯状态色背景（或顶部细反光）
    return [br, bg, bb, 255];
  }

  // 信封内部：默认白色纸面
  let col = [255, 255, 255, 255];
  // 归一化到信封局部坐标
  const lx = (ex - mX) / envW; // 0..1
  const ly = (ey - mY) / envH; // 0..1

  // 1) flap 折角 V：信封上部一个由两上角向下汇聚到约 ly=0.32 的倒三角开口(露出状态色暗调)
  const cxL = 0.5;
  const foldY = 0.3;
  if (ly <= foldY) {
    // 在该三角内：|lx-cxL| <= (cxL) * (1 - ly/foldY) 渐宽到顶
    const half = cxL * (1 - ly / foldY);
    if (Math.abs(lx - cxL) <= half) {
      // flap 区域露状态色（较深），形成信封翻盖视觉效果
      col = [dr, dg, db, 255];
    }
  } else {
    // 2) 下半：左右底部两三角(前盖)也露状态色，使信封有前后盖层次 —— 简化，不加
  }

  // 3) flap 下沿一条水平状态色细线（v形底的封口线），y≈foldY
  if (ly > foldY - 0.028 && ly < foldY + 0.028) {
    const half = 0.5 - 0.1; // flap 底沿宽度比顶部窄一些
    if (Math.abs(lx - cxL) <= half) col = [dr, dg, db, 255];
  }

  // 4) 中下部一条淡淡的收信地址区横线（让白纸不显空洞），仅大尺寸清晰，小尺寸忽略
  if (ly > 0.58 && ly < 0.64) {
    col = [226, 229, 231, 255];
  }

  return col;
}

function drawIcon(size, cfg) {
  const SS = 4; // 超采样
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = samplePixel(u, v, cfg);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += c[3];
            n++;
          }
        }
      }
      const idx = (y * size + x) * 4;
      if (n === 0) {
        px[idx + 3] = 0;
        continue;
      }
      px[idx] = Math.round(r / n);
      px[idx + 1] = Math.round(g / n);
      px[idx + 2] = Math.round(b / n);
      px[idx + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, px);
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const st of Object.values(STATES)) {
  for (const size of SIZES) {
    const png = drawIcon(size, st);
    const file = path.join(outDir, `icon-${st.label}-${size}.png`);
    fs.writeFileSync(file, png);
    console.log('wrote', file, png.length, 'bytes');
  }
}
console.log('done');
