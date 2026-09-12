const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');
const OUT = '/workspace/doc/store-assets';
const BLUE = '#1976d2',
  BG = '#eef2f7',
  CARD = '#fff',
  TEXT = '#212529',
  MUTED = '#5f6b77',
  RED = '#e53935',
  GREEN = '#26A65B';
function save(c, n) {
  const b = c.toBuffer('image/png');
  fs.writeFileSync(path.join(OUT, n), b);
  console.log('wrote', n, b.length, 'bytes');
}
function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
function txt(c, x, y, s, font, col, align = 'left') {
  c.font = font;
  c.fillStyle = col;
  c.textAlign = align;
  c.fillText(s, x, y);
  c.textAlign = 'left';
}
function env(c, cx, cy, w, h) {
  c.save();
  const x0 = cx - w / 2,
    y0 = cy - h / 2;
  rr(c, x0, y0, w, h, w * 0.07);
  c.fillStyle = '#fff';
  c.fill();
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(cx, y0 + h * 0.46);
  c.lineTo(x0 + w, y0);
  c.closePath();
  c.fillStyle = '#e3f2fd';
  c.fill();
  c.beginPath();
  c.moveTo(x0, y0 + h);
  c.lineTo(cx, y0 + h * 0.46);
  c.lineTo(x0 + w, y0 + h);
  c.closePath();
  c.fillStyle = '#e8f0fe';
  c.fill();
  c.restore();
}

// Header band + background helper for all screenshots
function base(W, H, title, sub) {
  const c = createCanvas(W, H),
    x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#f4f7fb');
  g.addColorStop(1, '#dfe7f0');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  return { c, x };
}

// ===== Shot 1: Popup overview (full, centered, clear) =====
function drawPopup(x, ox, oy, W, H) {
  // shadow + frame
  x.save();
  x.shadowColor = 'rgba(15,40,70,0.25)';
  x.shadowBlur = 26;
  x.shadowOffsetY = 5;
  rr(x, ox, oy, W, H, 10);
  x.fillStyle = '#fff';
  x.fill();
  x.restore();
  x.save();
  rr(x, ox, oy, W, H, 10);
  x.clip();
  // header
  x.fillStyle = BLUE;
  x.fillRect(ox, oy, W, 46);
  // subtle band
  env(x, ox + 26, oy + 23, 22, 16);
  txt(x, ox + 44, oy + 30, 'Mail Notifier', 'bold 15px "DejaVu Sans"', '#fff');
  let y = oy + 62;
  const rows = [
    { p: '163邮箱', e: 'user@163.com', n: 3, a: '已授权', c: '#1976d2', i: '1', sec: '2 分钟前' },
    { p: 'QQ邮箱', e: 'user@qq.com', n: 7, a: '已授权', c: '#0aa858', i: 'Q', sec: '2 分钟前' },
    {
      p: 'USTC邮箱',
      e: 'user@mail.ustc.edu.cn',
      n: 2,
      a: '已授权',
      c: '#b45309',
      i: 'U',
      sec: '1 分钟前',
    },
    { p: 'Gmail', e: 'user@gmail.com', n: 1, a: '已授权', c: '#e53935', i: 'G', sec: '1 分钟前' },
  ];
  for (const r of rows) {
    rr(x, ox + 12, y, W - 24, 58, 8);
    x.fillStyle = '#f6f8fb';
    x.fill();
    x.beginPath();
    x.arc(ox + 42, y + 29, 17, 0, Math.PI * 2);
    x.fillStyle = r.c;
    x.fill();
    txt(x, ox + 42, y + 34, r.i, 'bold 16px "DejaVu Sans"', '#fff', 'center');
    txt(x, ox + 70, y + 27, r.p, 'bold 13.5px "DejaVu Sans"', TEXT);
    txt(x, ox + 70, y + 45, r.e + '  ·  ' + r.sec, '11px "DejaVu Sans"', MUTED);
    // unread pill
    const pill = r.n > 0 ? r.n + ' 未读' : '无未读';
    x.font = '11px "DejaVu Sans"';
    const pw = x.measureText(pill).width;
    rr(x, ox + W - 40 - pw, y + 19, pw + 16, 20, 10);
    x.fillStyle = r.n > 0 ? '#fdecea' : '#e6f7ec';
    x.fill();
    txt(
      x,
      ox + W - 32 - pw / 2,
      y + 33,
      pill,
      'bold 11px "DejaVu Sans"',
      r.n > 0 ? RED : GREEN,
      'center'
    );
    y += 66;
  }
  // full check button
  rr(x, ox + 12, y, W - 24, 36, 5);
  x.fillStyle = '#ff9800';
  x.fill();
  txt(
    x,
    ox + W / 2,
    y + 23,
    '🚀  Full check (全量检查)',
    'bold 13px "DejaVu Sans"',
    '#fff',
    'center'
  );
  // hint
  txt(
    x,
    ox + W / 2,
    y + 60,
    'Click to check all mailboxes now',
    '11px "DejaVu Sans"',
    MUTED,
    'center'
  );
  x.restore();
}

function shot1() {
  const W = 1280,
    H = 800;
  const { c, x } = base(W, H, '');
  // left info column
  txt(x, 70, 90, 'All your mailboxes, one glance', 'bold 34px "DejaVu Sans"', TEXT);
  txt(x, 70, 130, '163 · QQ · USTC · Gmail in a single popup panel.', '18px "DejaVu Sans"', MUTED);
  txt(
    x,
    70,
    156,
    'See unread counts and open your inbox with one tap.',
    '18px "DejaVu Sans"',
    MUTED
  );
  // mini feature bullets with mini logos
  const bl = [
    ['Toolbar badge + popup overview'],
    ['New-mail desktop notifications'],
    ['Silent background checks — no tabs'],
  ];
  let by = 210;
  bl.forEach((b, i) => {
    env(x, 92, by + 16, 34, 25);
    txt(x, 122, by + 24, b[0], 'bold 17px "DejaVu Sans"', TEXT);
    by += 60;
  });
  // right: the popup drawn large
  drawPopup(x, 720, 120, 470, 580);
  save(c, 'screenshot-1-overview-1280x800.png');
}

// ===== Shot 2: Desktop notification =====
function shot2() {
  const W = 1280,
    H = 800;
  const c = createCanvas(W, H),
    x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1f2a38');
  g.addColorStop(1, '#141b24');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  // faux browser chrome top
  x.fillStyle = '#0d1420';
  x.fillRect(0, 0, W, 52);
  txt(x, 20, 34, 'Mail Notifier', 'bold 14px "DejaVu Sans"', '#cbd6e2');
  // a mock mail list on left
  const rows = [
    'Team · Weekly report sent',
    'Invoice from Acme',
    'Meeting reminder · 15:00',
    'GitHub · Release v1.0',
    'Welcome to Mail Notifier',
  ];
  let ry = 110;
  x.font = '15px "DejaVu Sans"';
  rows.forEach((r, i) => {
    rr(x, 60, ry, W - 560, 58, 8);
    x.fillStyle = i ? '#232e3d' : '#2b3a4d';
    x.fill();
    txt(x, 90, ry + 26, r, '16px "DejaVu Sans"', '#e8eef5');
    txt(
      x,
      90,
      ry + 44,
      i === 0 ? '3 new · today 09:41' : 'today 08:' + (10 + i * 11),
      '12px "DejaVu Sans"',
      '#8aa0b5'
    );
    if (i === 0) {
      // unread dot
      x.beginPath();
      x.arc(W - 640, ry + 16, 7, 0, Math.PI * 2);
      x.fillStyle = RED;
      x.fill();
    }
    ry += 70;
  });
  // desktop notification card (right, large)
  x.save();
  x.shadowColor = 'rgba(0,0,0,0.6)';
  x.shadowBlur = 30;
  x.shadowOffsetY = 6;
  rr(x, 820, 120, 360, 150, 12);
  x.fillStyle = '#fff';
  x.fill();
  x.restore();
  // app chip
  env(x, 850, 150, 40, 30);
  txt(x, 885, 142, 'Mail Notifier', 'bold 16px "DejaVu Sans"', TEXT);
  txt(x, 1140, 142, 'now', '11px "DejaVu Sans"', MUTED);
  txt(x, 850, 185, '3 封新邮件 · user@163.com', 'bold 15px "DejaVu Sans"', TEXT);
  rr(x, 850, 210, 120, 26, 13);
  x.fillStyle = '#e6f2ff';
  x.fill();
  txt(x, 866, 228, 'Open inbox', '12px "DejaVu Sans"', '#0b66c3');
  txt(
    x,
    850,
    290,
    'A quiet, local desktop alert. No tab opened.',
    'italic 13px "DejaVu Sans"',
    MUTED
  );
  // bottom caption
  txt(
    x,
    60,
    H - 40,
    'New-mail desktop notification appears silently in the background — no tabs are ever auto-opened.',
    '17px "DejaVu Sans"',
    '#bcd0e0'
  );
  save(c, 'screenshot-2-notification-1280x800.png');
}

// ===== Shot 3: Settings =====
function settingsPanel(x, ox, oy, W, H) {
  x.save();
  x.shadowColor = 'rgba(15,40,70,0.22)';
  x.shadowBlur = 24;
  x.shadowOffsetY = 5;
  rr(x, ox, oy, W, H, 10);
  x.fillStyle = '#fff';
  x.fill();
  x.restore();
  x.save();
  rr(x, ox, oy, W, H, 10);
  x.clip();
  x.fillStyle = BLUE;
  x.fillRect(ox, oy, W, 46);
  env(x, ox + 24, oy + 23, 20, 15);
  txt(x, ox + 42, oy + 30, 'Mail Notifier', 'bold 14px "DejaVu Sans"', '#fff');
  // tabs
  const tabs = ['状态', '设置', '统计', '日志', '调试'];
  let tx = ox + 16;
  tabs.forEach((t, i) => {
    x.fillStyle = i === 1 ? BLUE : MUTED;
    txt(x, tx, oy + 74, t, '13px "DejaVu Sans"', x.fillStyle);
    if (i === 1) {
      x.fillStyle = BLUE;
      x.fillRect(tx, oy + 80, 32, 3);
    }
    tx += 18 + t.length * 6 + 10;
  });
  let y = oy + 100;
  // add account
  rr(x, ox + 14, y, W - 28, 44, 6);
  x.fillStyle = '#fff';
  x.strokeStyle = '#d5dce4';
  x.lineWidth = 1;
  x.stroke();
  x.fill();
  txt(x, ox + 26, y + 27, 'Add mailbox · e.g. user@gmail.com', '13px "DejaVu Sans"', MUTED);
  rr(x, ox + W - 92, y + 8, 72, 28, 5);
  x.fillStyle = BLUE;
  x.fill();
  txt(x, ox + W - 56, y + 27, 'Add', 'bold 12px "DejaVu Sans"', '#fff', 'center');
  y += 56;
  // account list
  const acc = [
    ['163邮箱', 'user@163.com', '3', '#1976d2', '1'],
    ['QQ邮箱', 'user@qq.com', '7', '#0aa858', 'Q'],
    ['USTC邮箱', 'user@mail.ustc.edu.cn', '2', '#b45309', 'U'],
    ['Gmail', 'user@gmail.com', '1', '#e53935', 'G'],
  ];
  for (const [p, e, n, cc, ini] of acc) {
    rr(x, ox + 14, y, W - 28, 42, 6);
    x.fillStyle = '#f6f8fb';
    x.fill();
    x.beginPath();
    x.arc(ox + 40, y + 21, 13, 0, Math.PI * 2);
    x.fillStyle = cc;
    x.fill();
    txt(x, ox + 40, y + 25, ini, 'bold 12px "DejaVu Sans"', '#fff', 'center');
    txt(x, ox + 62, y + 26, p, '13px "DejaVu Sans"', TEXT);
    txt(x, ox + 150, y + 26, e, '11px "DejaVu Sans"', MUTED);
    txt(x, ox + W - 30, y + 26, n, 'bold 14px "DejaVu Sans"', RED, 'right');
    y += 46;
  }
  y += 8;
  // interval
  txt(x, ox + 16, y + 12, 'Check interval', '12px "DejaVu Sans"', MUTED);
  rr(x, ox + 16, y + 18, W - 32, 32, 5);
  x.fillStyle = '#fff';
  x.strokeStyle = '#d5dce4';
  x.lineWidth = 1;
  x.stroke();
  x.fill();
  txt(x, ox + 28, y + 39, '5 minutes   ▾', '13px "DejaVu Sans"', TEXT);
  y += 60;
  txt(x, ox + 16, y + 12, 'Check mode', '12px "DejaVu Sans"', MUTED);
  rr(x, ox + 16, y + 18, W - 32, 32, 5);
  x.fillStyle = '#fff';
  x.strokeStyle = '#d5dce4';
  x.lineWidth = 1;
  x.stroke();
  x.fill();
  txt(x, ox + 28, y + 39, 'Hybrid (recommended)   ▾', '13px "DejaVu Sans"', TEXT);
  y += 58;
  rr(x, ox + 16, y, W - 32, 34, 5);
  x.fillStyle = GREEN;
  x.fill();
  txt(x, ox + W / 2, y + 23, '💾  Save settings', 'bold 13px "DejaVu Sans"', '#fff', 'center');
  x.restore();
}
function shot3() {
  const W = 1280,
    H = 800;
  const { c, x } = base(W, H, '');
  txt(x, 70, 90, 'Setup your mailboxes in seconds', 'bold 32px "DejaVu Sans"', TEXT);
  const rows = [
    'Add as many 163 / QQ / USTC / Gmail accounts as you like',
    'Choose a check interval from 1 to 30 minutes',
    'Pick Hybrid, Content-script-only or SW-API mode',
    'Fine-tune per-provider probe endpoints',
    'Data never leaves your machine',
  ];
  rows.forEach((r, i) => {
    env(x, 78, 170 + i * 52, 26, 20);
    txt(x, 116, 182 + i * 52, r, '17px "DejaVu Sans"', i === 0 ? TEXT : MUTED);
  });
  settingsPanel(x, 720, 110, 470, 600);
  save(c, 'screenshot-3-settings-1280x800.png');
}

// ===== Shot 4: Toolbar badge & icon states =====
function shot4() {
  const W = 1280,
    H = 800;
  const { c, x } = base(W, H, '');
  // browser toolbar strip
  x.fillStyle = '#fff';
  x.fillRect(0, 0, W, 66);
  x.fillStyle = '#eceff1';
  rr(x, 30, 20, 480, 28, 14);
  x.fill();
  txt(x, 270, 39, 'https://mail.163.com', '13px "DejaVu Sans"', '#5f6368', 'center');
  // icons on toolbar right
  for (let i = 0; i < 5; i++) {
    x.beginPath();
    x.arc(560 + i * 40, 34, 9, 0, Math.PI * 2);
    x.fillStyle = '#cfd8dc';
    x.fill();
  }
  // main mail icon w/ badge
  const mx = 820;
  env(x, mx, 34, 30, 22);
  x.beginPath();
  x.arc(mx + 15, 22, 12, 0, Math.PI * 2);
  x.fillStyle = RED;
  x.fill();
  txt(x, mx + 15, 26, '3', 'bold 12px "DejaVu Sans"', '#fff', 'center');
  // callout to badge
  x.strokeStyle = '#b3392c';
  x.setLineDash([6, 5]);
  x.beginPath();
  x.moveTo(mx + 28, 14);
  x.lineTo(260, 180);
  x.stroke();
  rr(x, 60, 150, 400, 120, 10);
  x.fillStyle = '#fff3e0';
  x.fill();
  txt(x, 80, 180, 'Toolbar badge', 'bold 20px "DejaVu Sans"', '#b3392c');
  txt(x, 80, 205, 'Shows total unread count at a glance.', '15px "DejaVu Sans"', '#5f5a4d');
  txt(x, 80, 228, 'Updates automatically in the background.', '15px "DejaVu Sans"', '#5f5a4d');
  // title
  txt(x, 60, 300, 'Extension icon states', 'bold 30px "DejaVu Sans"', TEXT);
  txt(
    x,
    60,
    334,
    'Grey when idle, green when mail is checked, red when action is needed.',
    '17px "DejaVu Sans"',
    MUTED
  );
  const states = [
    ['Grey', 'Idle — no session / paused', '#95A5A6'],
    ['Green', 'Checked · OK', '#26A65B'],
    ['Red', 'Auth error — please sync', '#E74C3C'],
  ];
  let sx = 110;
  for (const [lab, sub, col] of states) {
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.15)';
    x.shadowBlur = 18;
    x.shadowOffsetY = 4;
    rr(x, sx, 380, 120, 120, 24);
    x.fillStyle = col;
    x.fill();
    x.restore();
    env(x, sx + 60, 440, 66, 49);
    // state dot
    x.beginPath();
    x.arc(sx + 88, 388, 10, 0, Math.PI * 2);
    x.fillStyle = '#fff';
    x.fill();
    txt(x, sx + 60, 540, lab, 'bold 17px "DejaVu Sans"', TEXT, 'center');
    txt(x, sx + 60, 564, sub, '13px "DejaVu Sans"', MUTED, 'center');
    sx += 270;
  }
  txt(
    x,
    60,
    660,
    'Runs silently in the background — scheduled checks never open or keep-alive any mailbox tab.',
    '17px "DejaVu Sans"',
    MUTED
  );
  save(c, 'screenshot-4-badge-1280x800.png');
}
shot1();
shot2();
shot3();
shot4();
console.log('done v2');
