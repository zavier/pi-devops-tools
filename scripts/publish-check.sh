#!/usr/bin/env bash
# 发布前置检查：main 分支 + 与 origin/main 同步 + 工作区干净 + 全套验证。
# 挂在 preversion / prepublishOnly 钩子上，任何一项不满足都会中止发布。
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "✗ $1" >&2
  echo "  发布被中止。" >&2
  exit 1
}

# 1. 必须在 main 分支
branch="$(git branch --show-current)"
if [ "$branch" != "main" ]; then
  fail "必须在 main 分支上发布（当前分支：$branch）"
fi

# 2. 必须与 origin/main 完全同步（先 fetch 最新，本地领先或落后都拒绝）
git fetch origin
local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse origin/main)"
if [ "$local_head" != "$remote_head" ]; then
  echo "  本地 main: $local_head" >&2
  echo "  origin/main: $remote_head" >&2
  fail "本地 main 与 origin/main 不同步——请先 git pull / git rebase origin/main"
fi

# 3. 工作区必须干净（无未提交改动）
if [ -n "$(git status --porcelain)" ]; then
  fail "工作区有未提交的改动，请先提交或 stash"
fi

# 4. 提交前验证清单（与 AGENTS.md 一致）
npm run check
npm test
npm run lint
npm run fmt:check

echo "✓ 发布前检查全部通过：main 分支、与远程同步、工作区干净、验证清单通过"
