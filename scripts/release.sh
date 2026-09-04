#!/usr/bin/env bash
#
# release.sh - 扩展商店发布一键打包脚本（MV3，bash 版）
#
# 目标平台：Chrome Web Store / Microsoft Edge Add-ons
# 要求：zip 内 manifest.json 位于根级；排除调试/文档等非发布文件；
#       版本号与 package.json 一致；产出前做结构与必含文件校验。
#
# 用法：
#   ./scripts/release.sh            # 校验并打包到 releases/
#   ./scripts/release.sh --check    # 仅发布前校验（版本/结构），不产出 zip
#   ./scripts/release.sh --verify <zip>  # 校验已有 zip 根级结构与必含文件
#   ./scripts/release.sh --version  # 打印 manifest 版本
#
# 产物：releases/mail-notifier-<version>.zip（manifest 位于 zip 根级）
# 排除：debug/、*.md、*.map、隐藏/临时文件（.DS_Store、Thumbs.db、__MACOSX）
#
# 依赖：bash(>=3.2) + zip 命令（打包时）。--check / --verify 无需 zip。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXT_DIR="extension"
MANIFEST="$EXT_DIR/manifest.json"
PKG="package.json"
RELEASE_DIR="releases"

# 必含文件（相对 EXT_DIR）
REQUIRED_FILES=( "manifest.json" "background/service-worker.js" "popup/index.html" "popup/popup.js" )
REQUIRED_ICON_SIZES=( 16 32 48 128 )
EXCLUDED_DIRS=( debug )
EXCLUDED_EXTS=( .map .md )

# ---------- 日志 ----------
log()  { printf '[release] %s\n' "$*"; }
fail() { printf '[release] 错误：%s\n' "$*" >&2; exit 1; }
warn() { printf '[release] 告警：%s\n' "$*" >&2; }

# ---------- JSON 取值：读取 manifest 顶层 string 字段 ----------
json_str() {
  # $1=file  $2=key；返回对应 "value"（含引号）
  sed -n 's/^[[:space:]]*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n1
}

# ---------- 发布前校验 ----------
check_required_files() {
  local missing=() f s
  for f in "${REQUIRED_FILES[@]}"; do
    [[ -f "$EXT_DIR/$f" ]] || missing+=("$f")
  done
  for s in "${REQUIRED_ICON_SIZES[@]}"; do
    [[ -f "$EXT_DIR/icons/icon-ok-$s.png" ]] || missing+=("icons/icon-ok-$s.png")
  done
  if (( ${#missing[@]} > 0 )); then
    fail "缺失发布必需文件：$(IFS=,; echo "${missing[*]}")"
  fi
}

check_version_consistency() {
  local manifest_version="$1"
  local pkg_version
  pkg_version="$(json_str "$PKG" version)" || true
  if [[ -n "$pkg_version" && "$pkg_version" != "$manifest_version" ]]; then
    warn "版本一致性告警：package.json($pkg_version) ≠ manifest.json($manifest_version)"
    warn "建议先统一版本再打包，避免商店版本错乱。"
    return 1
  fi
  log "版本一致 ✔（manifest / package 均为 v$manifest_version）"
  return 0
}

check_manifest_warnings() {
  local desc perms hosts hit w
  desc="$(json_str "$MANIFEST" description)" || true
  if [[ "${#desc}" -gt 132 ]]; then
    warn "manifest.description 长度 ${#desc} 超 Chrome 上限 132"
  fi
  perms="$(sed -n '/"permissions"[[:space:]]*:/,/]/p' "$MANIFEST" | tr -d ' ",\n[]')" || true
  for w in cookies declarativeNetRequest identity tabs; do
    if [[ "$perms" == *"$w"* ]]; then
      warn "含高敏感权限：$w（商店审查重点，请确保已在商店说明声明用途）"
    fi
  done
  hosts="$(sed -n '/"host_permissions"[[:space:]]*:/,/]/p' "$MANIFEST" | tr -d ' ",\n[]')" || true
  if [[ "$hosts" == *"<all_urls>"* ]]; then
    warn 'host_permissions 包含 <all_urls>，商店审查风险极高，请确认必要'
  fi
}

# ---------- 校验已有 zip 的根级结构 ----------
verify_zip() {
  local zip_path="$1"
  [[ -f "$zip_path" ]] || fail "找不到 zip：$zip_path"
  local tool=""
  if command -v unzip >/dev/null 2>&1; then tool="unzip"; fi
  if [[ -z "$tool" ]] && command -v python3 >/dev/null 2>&1; then tool="python3"; fi
  [[ -z "$tool" ]] && fail "需要 unzip 或 python3 以校验 zip 结构"

  local files
  if [[ "$tool" == "unzip" ]]; then
    files="$(unzip -Z1 "$zip_path" 2>/dev/null | grep -v '/$' || true)"
  else
    files="$(python3 -c 'import sys,zipfile;print("\n".join(n for n in zipfile.ZipFile(sys.argv[1]).namelist() if not n.endswith("/")))' "$zip_path" 2>/dev/null || true)"
  fi

  [[ -z "$files" ]] && fail "无法读取 zip 内容，zip 可能损坏"

  local has_root_manifest=0 has_icons=1 i
  echo "$files" | grep -qx 'manifest.json' && has_root_manifest=1
  for i in "${REQUIRED_ICON_SIZES[@]}"; do
    if ! echo "$files" | grep -qx "icons/icon-ok-$i.png"; then has_icons=0; fi
  done
  (( has_root_manifest )) || fail "校验失败：manifest.json 不在 zip 根级"
  (( has_icons )) || fail "校验失败：zip 缺少 16/32/48/128 图标"
  if echo "$files" | grep -q '^debug/'; then warn "zip 内含 debug/ 目录"; fi
  log "zip 校验通过 ✔（根级含 manifest.json，含必需图标；共 $(echo "$files" | wc -l | tr -d ' ') 个文件）"
}

# ---------- 打包 ----------
do_pack() {
  local manifest_version
  manifest_version="$(json_str "$MANIFEST" version)" || true
  [[ -z "$manifest_version" ]] && fail "无法从 manifest.json 读取 version"
  log "开始打包 v$manifest_version"
  check_required_files
  check_manifest_warnings

  command -v zip >/dev/null 2>&1 || fail "打包需要 zip 命令，请先安装（macOS: brew install zip / Linux: apt install zip）"

  mkdir -p "$RELEASE_DIR"
  local zip_path="$ROOT_DIR/$RELEASE_DIR/mail-notifier-$manifest_version.zip"
  rm -f "$zip_path"

  local excludes=()
  for d in "${EXCLUDED_DIRS[@]}"; do excludes+=("-x" "$d/*"); done
  for e in "${EXCLUDED_EXTS[@]}"; do excludes+=("-x" "*$e"); done
  # 隐藏 / 临时文件
  excludes+=("-x" "*.DS_Store" "-x" "Thumbs.db" "-x" "__MACOSX/*" "-x" "*/.*")

  (
    cd "$EXT_DIR"
    # shellcheck disable=SC2068
    zip -q -r "$zip_path" . ${excludes[@]+"${excludes[@]}"}
  )

  log "产物：$zip_path"
  log "zip 根级条目预览（前 8）："
  unzip -Z1 "$zip_path" 2>/dev/null | grep -v '/$' | head -n8 | sed 's/^/  /' || true

  verify_zip "$zip_path"
}

# ---------- 命令分发 ----------
cmd="${1:-pack}"
case "$cmd" in
  --check)
    mv="$(json_str "$MANIFEST" version)" || true
    [[ -z "$mv" ]] && fail "无法从 manifest.json 读取 version"
    log "校验 manifest 版本 v$mv"
    check_required_files
    check_manifest_warnings
    check_version_consistency "$mv"
    log "发布前校验通过 ✔（版本一致性若有告警请先统一）"
    ;;
  pack|--pack)
    do_pack
    ;;
  --verify)
    [[ -n "${2:-}" ]] || fail "--verify 需要传入 zip 路径"
    verify_zip "$2"
    ;;
  --version)
    mv="$(json_str "$MANIFEST" version)" || true
    echo "${mv:-unknown}"
    ;;
  *)
    fail "未知参数：$cmd
用法：./scripts/release.sh [pack|--check|--verify <zip>|--version]"
    ;;
esac
