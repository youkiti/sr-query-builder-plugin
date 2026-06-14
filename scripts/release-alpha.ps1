# アルファテスト用リリースを 1 コマンドで:
#   dev ビルド → zip 化（source map 除外）→ Google Drive へ rclone アップロード
#
# 使い方:
#   npm run release:alpha            # ビルド + zip + アップロード
#   npm run release:alpha -- -NoUpload   # zip 化まで（アップロードしない）
#   npm run release:alpha -- -SkipBuild  # 既存 dist をそのまま zip 化
#
# 前提:
#   - rclone がインストール済みで、`gdrive:` リモートが設定済み
#   - .env に GOOGLE_DRIVE=<Drive フォルダの URL または ID> がある
#   - dev ビルドは拡張名に "(dev)" を付与し、固定 key により拡張機能 ID が一定

param(
  [switch]$NoUpload,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# --- バージョンと zip 名 ---
$pkg = Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$version = $pkg.version
$zipName = "sr-query-builder-plugin-dev-v$version.zip"
$zipPath = Join-Path $root $zipName

# --- 1. dev ビルド ---
if (-not $SkipBuild) {
  Write-Host "==> dev ビルド (npm run dev)" -ForegroundColor Cyan
  & npm run dev
  if ($LASTEXITCODE -ne 0) { throw "dev ビルドに失敗しました" }
} else {
  Write-Host "==> ビルドをスキップ（既存 dist を使用）" -ForegroundColor Yellow
}

$dist = Join-Path $root "dist"
if (-not (Test-Path (Join-Path $dist "manifest.json"))) {
  throw "dist/manifest.json が見つかりません。先にビルドしてください。"
}

# --- 2. zip 化（source map を除外したステージングから圧縮）---
Write-Host "==> zip 化: $zipName" -ForegroundColor Cyan
$stage = Join-Path $env:TEMP "srqb-dev-stage"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $dist "*") $stage -Recurse -Force
Get-ChildItem $stage -Recurse -Filter *.map | Remove-Item -Force
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
$sizeKb = "{0:N1}" -f ((Get-Item $zipPath).Length / 1KB)
Write-Host "    -> $zipPath ($sizeKb KB)" -ForegroundColor Green

if ($NoUpload) {
  Write-Host "==> -NoUpload 指定のためアップロードはスキップしました。" -ForegroundColor Yellow
  exit 0
}

# --- 3. Drive へアップロード（rclone）---
# .env から GOOGLE_DRIVE を取得（URL でも ID でも可）
$envLine = Select-String -Path (Join-Path $root ".env") -Pattern '^GOOGLE_DRIVE=' | Select-Object -First 1
if (-not $envLine) { throw ".env に GOOGLE_DRIVE が見つかりません。" }
$driveRef = ($envLine.Line -replace '^GOOGLE_DRIVE=', '').Trim().Trim('"')
if ($driveRef -match 'folders/([A-Za-z0-9_-]+)') { $fid = $Matches[1] } else { $fid = $driveRef }
if ([string]::IsNullOrWhiteSpace($fid)) { throw "GOOGLE_DRIVE のフォルダ ID を解決できませんでした。" }

if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) {
  throw "rclone が PATH にありません。インストールするか、-NoUpload で zip だけ作成してください。"
}

Write-Host "==> Drive へアップロード (rclone gdrive:)" -ForegroundColor Cyan
& rclone copy $zipPath "gdrive:" --drive-root-folder-id $fid -P
if ($LASTEXITCODE -ne 0) { throw "rclone アップロードに失敗しました" }

# 手順書も一緒に更新アップロード（あれば）
$guide = Join-Path $root "docs\alpha-test-guide.md"
if (Test-Path $guide) {
  & rclone copy $guide "gdrive:" --drive-root-folder-id $fid -P
}

Write-Host "==> 完了。Drive フォルダの現在の中身:" -ForegroundColor Green
& rclone lsl "gdrive:" --drive-root-folder-id $fid
Write-Host ""
Write-Host "リマインド: 新しいテスターは OAuth テストユーザー登録が必要 / Drive の共有権限付与を忘れずに。" -ForegroundColor Yellow
