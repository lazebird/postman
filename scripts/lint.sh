#!/usr/bin/env bash
#
# lint.sh - 静态审查 + 自动格式化
#
# 保证仓库代码符合 ESLint 规则与 Prettier 格式约定。
# 该脚本会：
#   1. 若本仓库根目录无 node_modules 且存在 package.json，则自动安装 devDependencies
#   2. 用 Prettier 自动格式化（--write）
#   3. 用 ESLint 自动修复可安全修复的告警（--fix）
#   4. 再次检查：若仍有 Prettier/ESLint 无法自动修复的问题则以非零退出码结束
#
# 用法：
#   ./scripts/lint.sh           # 检查并自动修复（CI / 本地）
#   ./scripts/lint.sh --check   # 仅检查，不写回（用于只读校验）
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

# 若未安装依赖，自动安装
if [[ ! -d node_modules ]] && [[ -f package.json ]]; then
  echo "[lint] 未发现 node_modules，自动安装依赖..."
  npm install --no-audit --no-fund
fi

PRETTIER_FILES=( "extension/**/*.js" "scripts/**/*.js" "docs/**/*.js" "*.mjs" )

echo "[lint] 运行 Prettier..."
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  npx prettier --check "${PRETTIER_FILES[@]}"
else
  npx prettier --write "${PRETTIER_FILES[@]}"
fi

echo "[lint] 运行 ESLint..."
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  npx eslint .
else
  npx eslint . --fix
fi

# 修复后再做一次只读校验，确保确实全部达标
if [[ "$CHECK_ONLY" -eq 0 ]]; then
  echo "[lint] 修复后复核..."
  npx prettier --check "${PRETTIER_FILES[@]}"
  npx eslint .
fi

echo "[lint] 全部通过 ✔"
