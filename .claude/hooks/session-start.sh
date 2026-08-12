#!/usr/bin/env bash
# Claude Code の SessionStart フック（クラウドセッション専用）。
#
# 目的: claude.ai/code のクラウドセッションで node_modules を用意し、
#       typecheck / lint / test / dev ビルドがすぐ走る状態にする。
#
# なぜ環境設定の「Setup script」ではなくフックなのか:
#   Setup script は Claude Code の起動前・VM のプロビジョニング段階で走るため、
#   リポジトリのチェックアウトが揃っている保証がない（実際に `npm ci` を
#   Setup script に置いたところ、package-lock.json が見つからず EUSAGE で
#   セッション作成そのものが失敗した）。公式ドキュメントも
#   「Setup script は VM 側のツールチェーン、`npm install` のようなプロジェクト
#   設定は SessionStart フック」と役割を分けている。
#   → Setup script には何も置かず（または apt 等の VM 側の準備のみ）、
#     依存インストールはこのフックで行う。詳細は CLAUDE.md のクラウド節。
#
# 手元（Windows）のセッションでは何もしない。node_modules の管理は各自の環境に任せる。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# $CLAUDE_PROJECT_DIR が無い場合はスクリプト位置（.claude/hooks/）から辿る
repo_root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$repo_root"

# 冪等性: resume / clear でも呼ばれるため、既に揃っていれば何もしない。
# node_modules ディレクトリの有無ではなく、実際に使う実行ファイルの有無で判定する
# （途中で失敗した install を「導入済み」と誤認しないため）。
if [ -x node_modules/.bin/jest ] && [ -x node_modules/.bin/tsc ] && [ -x node_modules/.bin/webpack ]; then
  echo "[session-start] 依存は導入済みのため npm install をスキップしました"
  exit 0
fi

# npm ci ではなく npm install を使う理由:
#   - 既存の node_modules を再利用できる（クラウドの環境キャッシュが効く）
#   - package.json と package-lock.json が一時的に食い違っていても止まらない
#     （npm ci は不一致で即エラーになり、セッションが使えなくなる）
echo "[session-start] npm install を実行します（$repo_root）"
npm install --no-audit --no-fund --loglevel=error

# Playwright の Chromium。E2E（npm run test:e2e）だけが使う。
# クラウドの既定環境ではブラウザ配布 CDN が network allowlist の外にあり取得に
# 失敗しうるので、ここは非致命扱いにする（unit テスト・lint・ビルドは影響を受けない）。
# 取得できなかった場合の回避策（プリインストール済み /opt/pw-browsers の流用）は
# CLAUDE.md の「リモート / web セッションで E2E を回すとき」を参照。
if [ -x node_modules/.bin/playwright ]; then
  if node_modules/.bin/playwright install chromium >/tmp/session-start-playwright.log 2>&1; then
    echo "[session-start] Playwright Chromium を用意しました"
  else
    echo "[session-start] Playwright Chromium の取得に失敗（E2E のみ影響。ログ: /tmp/session-start-playwright.log）" >&2
  fi
fi

echo "[session-start] 完了"
