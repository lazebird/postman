#!/usr/bin/env node
/**
 * release-pack.js - 扩展商店发布打包脚本（MV3）
 *
 * 目标平台：Chrome Web Store / Microsoft Edge Add-ons
 * 要求：zip 内 manifest.json 位于根级；排除调试/文档等非发布文件；
 *       版本号与 package.json 一致；产出前做结构与必含文件校验。
 *
 * 纯 Node 实现（仅用内置模块 fs/path/zlib），不依赖系统 zip 二进制，
 * 在 Windows/macOS/Linux 与 CI 上行为一致；使用 deflate 压缩生成标准 ZIP。
 *
 * 用法：
 *   node scripts/release-pack.js            # 校验并打包到 releases/
 *   node scripts/release-pack.js --check    # 仅发布前校验（版本/结构），不产出 zip
 *   node scripts/release-pack.js --verify <zip>  # 校验已有 zip 根级结构与必含文件
 *
 * 产物：releases/mail-notifier-<version>.zip（manifest 位于 zip 根级）
 * 排除：debug/、*.md、*.map、隐藏/临时文件（.DS_Store、Thumbs.db、__MACOSX）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');
const PKG_PATH = path.join(ROOT, 'package.json');
const RELEASE_DIR = path.join(ROOT, 'releases');

const EXCLUDED_NAMES = new Set(['.DS_Store', 'Thumbs.db', '__MACOSX']);
const EXCLUDED_EXT_DIRS = new Set(['debug']);
const EXCLUDED_EXTS = new Set(['.map', '.md']);

const REQUIRED_FILES = [
  'manifest.json',
  'background/service-worker.js',
  'popup/index.html',
  'popup/popup.js',
];
const REQUIRED_ICON_SIZES = [16, 32, 48, 128];

const args = process.argv.slice(2);

function log(...m) {
  console.log('[release]', ...m);
}
function fail(msg) {
  console.error('[release] 错误：' + msg);
  process.exit(1);
}

// ---------- ZIP 写入（deflate，纯 Node 内置模块） ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 递归收集需打包条目 [{ pathInZip, absolute }] */
function collect(dir, skipExcluded) {
  const out = [];
  const walk = (cur, rel) => {
    for (const name of fs.readdirSync(cur)) {
      if (skipExcluded && EXCLUDED_NAMES.has(name)) continue;
      if (skipExcluded && EXCLUDED_EXT_DIRS.has(name)) continue;
      const abs = path.join(cur, name);
      const relPath = rel ? rel + '/' + name : name;
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        walk(abs, relPath);
      } else if (skipExcluded) {
        if (EXCLUDED_EXTS.has(path.extname(name).toLowerCase())) continue;
        out.push({ pathInZip: relPath, absolute: abs });
      } else {
        out.push({ pathInZip: relPath, absolute: abs });
      }
    }
  };
  walk(dir, '');
  return out;
}

/** 将条目列表写成标准 zip 缓冲区 */
function buildZip(entries) {
  // 预计算每个文件的数据与元数据
  const items = entries.map((e) => {
    const data = fs.readFileSync(e.absolute);
    const nameBytes = Buffer.from(e.pathInZip, 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data);
    return { e, data, nameBytes, crc, comp };
  });

  // 拼装 local file headers + 数据
  const localBufs = [];
  let offset = 0;
  for (const it of items) {
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: UTF-8
    lh.writeUInt16LE(8, 8); // method: deflate
    lh.writeUInt32LE(it.crc, 14);
    lh.writeUInt32LE(it.comp.length, 18);
    lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(it.nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    localBufs.push(lh, it.nameBytes, it.comp);
    it.headerOffset = offset;
    offset += lh.length + it.nameBytes.length + it.comp.length;
  }
  const localBuf = Buffer.concat(localBufs);

  // central directory
  const cdBufs = [];
  for (const it of items) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // flags
    ch.writeUInt16LE(8, 10); // method
    ch.writeUInt32LE(it.crc, 16);
    ch.writeUInt32LE(it.comp.length, 20);
    ch.writeUInt32LE(it.data.length, 24);
    ch.writeUInt16LE(it.nameBytes.length, 28);
    ch.writeUInt16LE(0, 30); // external attrs
    ch.writeUInt32LE(it.headerOffset, 42);
    cdBufs.push(ch, it.nameBytes);
  }
  const cdBuf = Buffer.concat(cdBufs);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length > 0xffff ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(entries.length > 0xffff ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, cdBuf, eocd]);
}

// ---------- 发布前校验 ----------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`无法读取 ${p}：${e.message}`);
  }
}

function checkRequiredFiles() {
  const missing = [];
  for (const f of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(EXT_DIR, f))) missing.push(f);
  }
  for (const s of REQUIRED_ICON_SIZES) {
    if (!fs.existsSync(path.join(EXT_DIR, 'icons', `icon-ok-${s}.png`))) {
      missing.push(`icons/icon-ok-${s}.png`);
    }
  }
  if (missing.length) fail(`缺失发布必需文件：${missing.join(', ')}`);
}

function checkVersionConsistency(manifestVersion) {
  const pkg = readJson(PKG_PATH);
  if (pkg.version !== manifestVersion) {
    log(`版本一致性告警：package.json(${pkg.version}) ≠ manifest.json(${manifestVersion})`);
    log('建议先统一版本再打包，避免商店版本错乱。');
    return false;
  }
  log(`版本一致 ✔（manifest / package 均为 v${manifestVersion}）`);
  return true;
}

function checkManifest(manifest) {
  const warnings = [];
  if (manifest.description && manifest.description.length > 132) {
    warnings.push(`manifest.description 长度 ${manifest.description.length} 超 Chrome 上限 132`);
  }
  const perms = manifest.permissions || [];
  const sensitive = ['cookies', 'declarativeNetRequest', 'identity', 'tabs'];
  const hit = sensitive.filter((p) => perms.includes(p));
  if (hit.length) {
    log(`含高敏感权限：${hit.join(', ')}（商店审查重点，请确保已在商店说明声明用途）`);
  }
  if (manifest.host_permissions && manifest.host_permissions.includes('<all_urls>')) {
    warnings.push('host_permissions 包含 <all_urls>，商店审查风险极高，请确认必要');
  }
  return warnings;
}

// ---------- 校验已有 zip ----------

function verifyZip(zipPath) {
  if (!fs.existsSync(zipPath)) fail(`找不到 zip：${zipPath}`);
  const buf = fs.readFileSync(zipPath);
  const eocdIdx = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdIdx < 0) fail('无效 zip（找不到 EOCD 记录）');
  const centralCount = buf.readUInt16LE(eocdIdx + 10);
  const names = [];
  let offset = buf.readUInt32LE(eocdIdx + 16);
  for (let i = 0; i < centralCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) fail('zip central dir 损坏');
    const nameLen = buf.readUInt16LE(offset + 28);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  const fileNames = names.filter((n) => !n.endsWith('/'));
  if (!fileNames.includes('manifest.json')) {
    fail('校验失败：manifest.json 不在 zip 根级');
  }
  const hasIcons = REQUIRED_ICON_SIZES.every((s) => fileNames.includes(`icons/icon-ok-${s}.png`));
  if (!hasIcons) fail('校验失败：zip 缺少 16/32/48/128 图标');
  if (fileNames.some((n) => n.startsWith('debug/'))) {
    log('校验告警：zip 内含 debug/ 目录');
  }
  log(`zip 校验通过 ✔（根级含 manifest.json，含必需图标；共 ${fileNames.length} 个文件）`);
  return fileNames;
}

// ---------- 命令分发 ----------

function runCheck() {
  const manifest = readJson(MANIFEST_PATH);
  log(`校验 manifest 版本 v${manifest.version}`);
  checkRequiredFiles();
  checkManifest(manifest);
  checkVersionConsistency(manifest.version);
  log('发布前校验通过 ✔（版本一致性若有告警请先统一）');
}

function runPack() {
  const manifest = readJson(MANIFEST_PATH);
  const version = manifest.version;
  log(`开始打包 v${version}`);
  checkRequiredFiles();
  const warnings = checkManifest(manifest);

  const entries = collect(EXT_DIR, true);
  const zipBuf = buildZip(entries);

  if (!fs.existsSync(RELEASE_DIR)) fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const zipPath = path.join(RELEASE_DIR, `mail-notifier-${version}.zip`);
  fs.writeFileSync(zipPath, zipBuf);

  log(
    `产物：${path.relative(ROOT, zipPath)}（${entries.length} 个文件, ${(zipBuf.length / 1024).toFixed(1)} KB）`
  );
  log('zip 根级条目预览（前 8）：');
  for (const e of entries.slice(0, 8)) log('  ' + e.pathInZip);
  if (entries.length > 8) log(`  ... 等共 ${entries.length} 个`);
  if (warnings.length) log(`发布告警：\n  - ${warnings.join('\n  - ')}`);

  verifyZip(zipPath);
}

function main() {
  const cmd = args[0] || 'pack';
  if (cmd === '--check') runCheck();
  else if (cmd === '--verify') {
    if (!args[1]) fail('--verify 需要传入 zip 路径');
    verifyZip(path.resolve(ROOT, args[1]));
  } else if (cmd === 'pack' || cmd === '--pack') runPack();
  else fail(`未知参数：${cmd}\n用法：node scripts/release-pack.js [pack|--check|--verify <zip>]`);
}

main();
