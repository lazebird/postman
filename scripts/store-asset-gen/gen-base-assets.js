// Store asset generator using @napi-rs/canvas
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const OUT = '/workspace/doc/store-assets';
fs.mkdirSync(OUT, { recursive: true });

function save(canvas, name) {
  const buf = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log('wrote', name, buf.length, 'bytes');
}

// Colors from popup (theme #1976d2 primary)
const BLUE = '#1976d2';
const BLUE_DARK = '#1565c0';
const BG = '#f8f9fa';
const TEXT = '#212529';
const MUTED = '#6c757d';
const CARD = '#ffffff';
const GREEN = '#26A65B';
const RED = '#dc3545';
const GRAY = '#95A5A6';

// rounded rect path helper
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ====== logo 128x128 (colored rounded square + white envelope + green status dot) ======
function drawEnvelope(ctx, cx, cy, w, h) {
  // white envelope on status-color bg
  const x0 = cx - w / 2, y0 = cy - h / 2;
  ctx.save();
  roundRect(ctx, x0, y0, w, h, w * 0.08);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  // flap V (top)
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(cx, y0 + h * 0.46);
  ctx.lineTo(x0 + w, y0);
  ctx.closePath();
  ctx.fillStyle = '#e3f2fd'; // light blue flap
  ctx.fill();
  // bottom triangle opening
  ctx.beginPath();
  ctx.moveTo(x0, y0 + h);
  ctx.lineTo(cx, y0 + h * 0.46);
  ctx.lineTo(x0 + w, y0 + h);
  ctx.closePath();
  ctx.fillStyle = '#e8f0fe';
  ctx.fill();
  ctx.restore();
}

function drawLogo(size, color, stateColor, outName, dotColor) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  // bg rounded square
  roundRect(ctx, 0, 0, size, size, size * 0.22);
  ctx.fillStyle = color;
  ctx.fill();
  // subtle top highlight
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  roundRect(ctx, 0, 0, size, size, size * 0.22);
  ctx.fillStyle = g;
  ctx.fill();
  // envelope
  drawEnvelope(ctx, size / 2, size * 0.5, size * 0.6, size * 0.44);
  save(canvas, outName);
}

// main logo 128
drawLogo(128, BLUE, BLUE, 'extension-logo-128.png');
// save a 512 upscale for potential use (store may want)
drawLogo(512, BLUE, BLUE, 'extension-logo-512.png');

// ====== Small promo tile 440x280 ======
function drawSmallPromoTile() {
  const W = 440, H = 280;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  // bg gradient
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1a4c8f');
  g.addColorStop(1, '#1976d2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // decorative mail icons row
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#fff';
  for (let i = 0; i < 5; i++) {
    const sx = 18 + i * 92, sy = 34, sw = 26, sh = 19;
    roundRect(ctx, sx, sy, sw, sh, 3);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // big logo
  ctx.save();
  roundRect(ctx, 22, 96, 88, 88, 18);
  ctx.fillStyle = '#fff';
  ctx.fill();
  drawEnvelope(ctx, 66, 140, 50, 37);
  ctx.restore();
  // text
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 30px "DejaVu Sans"';
  ctx.fillText('Mail Notifier', 126, 128);
  ctx.font = '17px "DejaVu Sans"';
  ctx.fillStyle = '#cfe4ff';
  ctx.fillText('Unread mail badge & silent', 126, 158);
  ctx.fillText('desktop alerts for your inboxes', 126, 180);
  // bottom pill - supported
  const providers = ['163', 'QQ', 'USTC', 'Gmail'];
  let px = 24;
  ctx.font = '13px "DejaVu Sans"';
  for (const p of providers) {
    const tw = ctx.measureText(p).width;
    roundRect(ctx, px, 226, tw + 22, 26, 13);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText(p, px + 11, 244);
    px += tw + 22 + 10;
  }
  save(canvas, 'small-promo-tile-440x280.png');
}
drawSmallPromoTile();

// ====== Large promo tile (Marquee) 1400x560 ======
function drawLargePromoTile() {
  const W = 1400, H = 560;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0d2f5c');
  g.addColorStop(0.5, '#12539b');
  g.addColorStop(1, '#1976d2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // subtle grid/decoration
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // left: logo + headline + features
  ctx.save();
  roundRect(ctx, 90, 130, 220, 220, 44);
  ctx.fillStyle = '#fff';
  ctx.fill();
  drawEnvelope(ctx, 200, 240, 130, 96);
  ctx.restore();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 64px "DejaVu Sans"';
  ctx.fillText('Mail Notifier', 360, 210);
  ctx.font = '26px "DejaVu Sans"';
  ctx.fillStyle = '#bcd9ff';
  ctx.fillText('Multi-mailbox unread checker · silent background alerts', 360, 252);

  const feats = [
    ['163 · QQ · USTC · Gmail', '#7ec7ff'],
    ['Toolbar badge shows total unread count', '#ffffff'],
    ['Desktop notifications for new mail', '#ffffff'],
    ['Truly silent — never auto-opens tabs', '#ffffff'],
    ['Private · all processing stays on your machine', '#7ec7ff'],
  ];
  ctx.font = '22px "DejaVu Sans"';
  feats.forEach((f, i) => {
    ctx.fillStyle = f[1];
    ctx.fillText('✓  ' + f[0], 362, 300 + i * 44);
  });

  // right: mail account chips / cards demo
  const cards = [
    { name: '163', unread: '3', c: '#26A65B' },
    { name: 'QQ', unread: '7', c: '#26A65B' },
    { name: 'USTC', unread: '2', c: '#26A65B' },
    { name: 'Gmail', unread: '1', c: '#26A65B' },
  ];
  let cy = 190;
  for (const card of cards) {
    ctx.save();
    roundRect(ctx, 1000, cy, 320, 72, 14);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fill();
    // mini logo square
    roundRect(ctx, 1018, cy + 14, 44, 44, 9);
    ctx.fillStyle = BLUE;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px "DejaVu Sans"';
    ctx.fillText(card.name, 1028, cy + 42);
    // name
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 22px "DejaVu Sans"';
    ctx.fillText(card.name, 1080, cy + 42);
    // unread circle
    const cx = 1282, cyy = cy + 36;
    ctx.beginPath();
    ctx.arc(cx, cyy, 17, 0, Math.PI * 2);
    ctx.fillStyle = RED;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px "DejaVu Sans"';
    ctx.textAlign = 'center';
    ctx.fillText(card.unread, cx, cyy + 6);
    ctx.textAlign = 'left';
    ctx.restore();
    cy += 82;
  }
  // bottom provider pill
  ctx.font = '18px "DejaVu Sans"';
  ctx.fillStyle = '#7ec7ff';
  ctx.fillText('Available on Chrome Web Store', 90, 520);
  save(canvas, 'large-promo-tile-1400x560.png');
}
drawLargePromoTile();

console.log('DONE base assets');
